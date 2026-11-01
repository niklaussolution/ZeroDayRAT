package com.spapp.monitoring.sync

import android.content.Context
import android.util.Log
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.util.concurrent.TimeUnit

/**
 * Schedules background sync as a self-chaining OneTimeWorkRequest instead of
 * a PeriodicWorkRequest. PeriodicWorkRequest has a hard 15-minute floor
 * (MIN_PERIODIC_INTERVAL_MILLIS, enforced by WorkManager itself, not just a
 * recommendation — passing a lower value gets silently coerced back up to
 * 15 minutes). A chain of OneTimeWorkRequests, where each run schedules the
 * next one before finishing, has no such floor — this is what lets the
 * worst-case fallback interval be 5 minutes instead of 15, without a
 * foreground service or persistent notification. FCM remains the primary,
 * near-instant path; this chain is only the backstop for when a push
 * doesn't get through.
 */
object SyncScheduler {
    private const val TAG = "SyncScheduler"
    private const val CHAIN_WORK_NAME = "spapp_sync_chain"
    private val CHAIN_INTERVAL = 5L to TimeUnit.MINUTES

    /** Starts the chain if it isn't already running — call on activation, app open, and boot. */
    fun schedule(context: Context) {
        val request = OneTimeWorkRequestBuilder<SyncWorker>()
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        // KEEP: don't restart (and so don't delay) a chain already in flight.
        WorkManager.getInstance(context).enqueueUniqueWork(CHAIN_WORK_NAME, ExistingWorkPolicy.KEEP, request)
    }

    /** Called by SyncWorker itself at the end of every run to re-arm the next link. */
    fun scheduleNextChainLink(context: Context) {
        val request = OneTimeWorkRequestBuilder<SyncWorker>()
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setInitialDelay(CHAIN_INTERVAL.first, CHAIN_INTERVAL.second)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(CHAIN_WORK_NAME, ExistingWorkPolicy.REPLACE, request)
    }

    /**
     * Runs one sync pass immediately:
     * 1. Launches SyncRunner directly on Dispatchers.IO coroutine with 0ms delay so server
     *    receives initial permission status and logs instantaneously.
     * 2. Also enqueues WorkManager as persistent OS fallback.
     */
    fun runOnce(context: Context) {
        val appContext = context.applicationContext

        // Instant in-memory execution (0ms delay) so server gets response immediately
        CoroutineScope(Dispatchers.IO).launch {
            try {
                SyncRunner(appContext).runOnce()
            } catch (e: Exception) {
                Log.e(TAG, "Direct sync execution error", e)
            }
        }

        // Also enqueue WorkManager request as guaranteed OS-managed fallback
        val request = OneTimeWorkRequestBuilder<SyncWorker>()
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        WorkManager.getInstance(appContext).enqueue(request)
    }

    fun cancel(context: Context) {
        WorkManager.getInstance(context).cancelUniqueWork(CHAIN_WORK_NAME)
    }
}
