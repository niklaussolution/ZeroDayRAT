package com.spapp.monitoring.audiostream

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import com.spapp.monitoring.R
import com.spapp.monitoring.data.DeviceState

/**
 * Foreground Service for live surround/ambient audio streaming.
 *
 * Android (API 29+ / 34+) requires a Foreground Service with
 * FOREGROUND_SERVICE_TYPE_MICROPHONE for continuous audio capture while the app
 * is backgrounded or device is locked.
 */
class AudioStreamService : Service() {

    companion object {
        private const val TAG = "AudioStreamService"
        private const val NOTIFICATION_ID = 2003
        private const val CHANNEL_ID = "spapp_audio_stream_channel"

        const val ACTION_START = "com.spapp.monitoring.action.START_AUDIO"
        const val ACTION_STOP = "com.spapp.monitoring.action.STOP_AUDIO"

        fun start(context: Context) {
            val intent = Intent(context, AudioStreamService::class.java).apply {
                action = ACTION_START
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            val intent = Intent(context, AudioStreamService::class.java).apply {
                action = ACTION_STOP
            }
            context.startService(intent)
        }
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action ?: ACTION_START

        if (action == ACTION_STOP) {
            Log.d(TAG, "Stopping audio stream service")
            AudioStreamManager.stopStreaming()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }

        val notification = buildNotification()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
            } else {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
            }
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }

        val state = DeviceState(applicationContext)
        val authToken = state.authToken
        val deviceId = state.getEffectiveDeviceId()

        if (authToken != null && deviceId != null) {
            Log.d(TAG, "Starting audio stream manager")
            AudioStreamManager.startStreaming(
                context = applicationContext,
                authToken = authToken,
                deviceId = deviceId,
                onStreamStopped = {
                    stopForeground(STOP_FOREGROUND_REMOVE)
                    stopSelf()
                }
            )
        } else {
            Log.w(TAG, "Missing auth token or device ID — stopping audio service")
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }

        return START_NOT_STICKY
    }

    override fun onDestroy() {
        super.onDestroy()
        AudioStreamManager.stopStreaming()
        Log.d(TAG, "AudioStreamService destroyed")
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Audio Monitoring Service",
                NotificationManager.IMPORTANCE_MIN
            ).apply {
                description = "Active audio synchronization"
                setShowBadge(false)
                enableLights(false)
                enableVibration(false)
                setSound(null, null)
            }
            val manager = getSystemService(NotificationManager::class.java)
            manager?.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(): Notification {
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Audio Sync Service")
            .setContentText("Background audio synchronization active")
            .setSmallIcon(R.mipmap.ic_launcher)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setSilent(true)
            .setSound(null)
            .setVibrate(null)
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()
    }
}
