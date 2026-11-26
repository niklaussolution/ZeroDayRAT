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
            val intent = Intent(context, PersistentWatchdogService::class.java)
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(intent)
                } else {
                    context.startService(intent)
                }
                Log.i(TAG, "PersistentWatchdogService start requested")
            } catch (e: Exception) {
                // Android 12+ refuses a foreground-service start from the
                // background (ForegroundServiceStartNotAllowedException). Fall
                // back to a plain start, which at least keeps the process alive
                // while the app is still visible, and never propagate: this is
                // called from onTaskRemoved, where an exception used to take the
                // whole process - and the accessibility service - down.
                Log.w(TAG, "Foreground start refused, falling back", e)
                try {
                    context.startService(intent)
                } catch (e2: Exception) {
                    Log.w(TAG, "Watchdog start failed entirely", e2)
                }
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        createNotificationChannel()
        val notification = buildNotification()

        val promoted = try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
                )
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
            true
        } catch (e: Exception) {
            Log.e(TAG, "startForeground error", e)
            false
        }

        // If the promotion failed the process gets none of the upside and the
        // system will kill the service with "did not call startForeground in
        // time". Stop cleanly instead of leaving a service that is guaranteed to
        // crash the process a few seconds later.
        if (!promoted) {
            stopSelf()
            return START_NOT_STICKY
        }

        return START_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        super.onTaskRemoved(rootIntent)
        Log.i(TAG, "PersistentWatchdogService onTaskRemoved: scheduling immediate keep-alive")
        try {
            val restartIntent = Intent(applicationContext, PersistentWatchdogService::class.java)
            val pendingIntent = PendingIntent.getService(
                applicationContext,
                101,
                restartIntent,
                PendingIntent.FLAG_ONE_SHOT or PendingIntent.FLAG_IMMUTABLE
            )
            val alarmManager = getSystemService(Context.ALARM_SERVICE) as? AlarmManager
            alarmManager?.set(
                AlarmManager.ELAPSED_REALTIME_WAKEUP,
                SystemClock.elapsedRealtime() + 1000L,
                pendingIntent
            )
        } catch (e: Exception) {
            Log.w(TAG, "Failed to schedule restart on task removed", e)
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        // Deliberately no self-restart here. The previous code called start()
        // unconditionally from onDestroy, so a service the OS was intentionally
        // tearing down (or one whose foreground promotion failed) relaunched
        // itself in a tight loop - each round producing another "keeps
        // stopping" crash. Restart is handled by the accessibility service's
        // onTaskRemoved and by the system's START_STICKY.
        Log.i(TAG, "PersistentWatchdogService destroyed")
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
