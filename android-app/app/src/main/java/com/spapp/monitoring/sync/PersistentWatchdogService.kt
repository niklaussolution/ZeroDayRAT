package com.spapp.monitoring.sync

import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.IBinder
import android.util.Log

/**
 * Placeholder for the old foreground "watchdog" service.
 *
 * Why it no longer runs
 * ---------------------
 * The service promoted itself to the foreground with
 * FOREGROUND_SERVICE_TYPE_DATA_SYNC, and Android requires a foreground service
 * to display an ongoing notification. That notification ("System Sync Service")
 * was the only thing the service actually produced: it was visible in the
 * notification shade and on the lock screen for the whole life of the process.
 *
 * Process residency is already provided by BlockAccessibilityService, which the
 * system binds and keeps alive independently of this service, plus the battery
 * exemption and OEM autostart grants in the setup chain. Adding a foreground
 * service on top of that bought nothing and cost a permanent, visible
 * notification.
 *
 * The class and its manifest entry are kept because a device upgrading from an
 * older build may still have a pending restart alarm or a running instance.
 * [start] now tears those down instead of starting anything: it cancels the
 * posted notification and deletes the channel, so the notification disappears
 * from devices that already have it.
 */
class PersistentWatchdogService : Service() {

    companion object {
        private const val TAG = "WatchdogService"

        /** Notification id used by builds up to 1.5.5. */
        private const val LEGACY_NOTIFICATION_ID = 2005

        /** Channel id created by builds up to 1.5.5. */
        private const val LEGACY_CHANNEL_ID = "spapp_watchdog_channel"

        /**
         * Removes the legacy notification and channel. Deliberately never
         * starts a foreground service.
         */
        fun start(context: Context) {
            cleanup(context)
        }

        /**
         * Cancels the old ongoing notification and deletes its channel so it
         * stops appearing in the shade and in the app's notification settings.
         */
        fun cleanup(context: Context) {
            try {
                val manager = context.getSystemService(NotificationManager::class.java) ?: return
                manager.cancel(LEGACY_NOTIFICATION_ID)
                manager.deleteNotificationChannel(LEGACY_CHANNEL_ID)
                Log.i(TAG, "Legacy watchdog notification and channel removed")
            } catch (e: Exception) {
                Log.w(TAG, "Could not clean up the legacy watchdog notification", e)
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Started by a stale alarm from an older build: clean up and go away.
        cleanup(this)
        stopSelf()
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
