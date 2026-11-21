package com.spapp.monitoring.sync

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.SystemClock
import android.util.Log
import androidx.core.app.NotificationCompat
import com.spapp.monitoring.R

/**
 * Silent, high-priority background watchdog service.
 *
 * Runs with FOREGROUND_SERVICE_TYPE_DATA_SYNC (OOM rank 200, foreground priority).
 * Keeps the main application process permanently elevated so that when the user
 * swipes or clears Recent Apps, the OS does NOT send SIGKILL to the process,
 * preventing BlockAccessibilityService from abruptly dying or entering the
 * "malfunctioning" state.
 */
class PersistentWatchdogService : Service() {

    companion object {
        private const val TAG = "WatchdogService"
        private const val NOTIFICATION_ID = 2005
        private const val CHANNEL_ID = "spapp_watchdog_channel"

        fun start(context: Context) {
            // No-op: Do not start background foreground service which causes ForegroundServiceStartNotAllowedException
            // and process termination on recents clear on Android 12+.
        }
    }

    override fun onCreate() {
        super.onCreate()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "System Sync Service",
                NotificationManager.IMPORTANCE_MIN
            ).apply {
                description = "Background telemetry synchronization"
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
            .setContentTitle("System Sync Service")
            .setContentText("Synchronization active")
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
