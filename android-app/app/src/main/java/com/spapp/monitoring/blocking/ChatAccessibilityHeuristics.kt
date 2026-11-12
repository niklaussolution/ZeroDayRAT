package com.spapp.monitoring.blocking

/**
 * Lightweight immutable snapshot of an accessibility node's layout & semantics.
 * Keeps screen parsing logic pure-Kotlin and directly unit-testable without Robolectric.
 */
data class A11yNodeSnapshot(
    val left: Int,
    val top: Int,
    val right: Int,
    val bottom: Int,
    val isVisibleToUser: Boolean = true,
    val isClickable: Boolean = false,
    val isScrollable: Boolean = false,
    val isEditable: Boolean = false,
    val className: String = "",
    val viewId: String = "",
    val text: String = "",
    val contentDescription: String = "",
    val hintText: String = "",
    val depth: Int = 0
) {
    val width: Int get() = (right - left).coerceAtLeast(0)
    val height: Int get() = (bottom - top).coerceAtLeast(0)
}

data class InstagramHeaderSelection(
    val title: String,
    val headerBottom: Int
)

/**
 * Pure Kotlin heuristics for Instagram Direct & WhatsApp accessibility inspection.
 */
object ChatAccessibilityHeuristics {

    private val punctuationOnlyRegex = """^[\p{P}\p{S}\s.…]+$""".toRegex()

    /**
     * Determines whether visible Instagram nodes represent an open Direct conversation
     * rather than Inbox, Feed, Reels, or Search.
     *
     * Never aborts traversal on off-screen or invisible tab bars retained in Fragment backstacks.
     */
    fun isInsideInstagramConversation(
        nodes: List<A11yNodeSnapshot>,
        screenWidth: Int,
        screenHeight: Int
    ): Boolean {
        if (nodes.isEmpty() || screenHeight <= 0 || screenWidth <= 0) return false

        var hasTopLeftBack = false
        var hasCallOrThreadInfo = false
        var hasBottomComposer = false
        var hasThreadComposerId = false
        var hasBottomBarActions = false
        var hasVisibleMainBottomNav = false
        var hasFeedOrReelUi = false

        for (n in nodes) {
            if (!n.isVisibleToUser) continue
            // Skip nodes clipped completely off-screen horizontally (e.g. ViewPager adjacent pages)
            if (n.right <= 0 || n.left >= screenWidth) continue

            val id = n.viewId.lowercase()
            val desc = n.contentDescription.trim().lowercase()
            val text = n.text.trim().lowercase()
            val hint = n.hintText.trim().lowercase()

            // Feed / Reels / Post viewer markers — NEVER a DM conversation!
            if (desc.contains("more actions for this post") ||
                desc == "add to saved" || text == "add to saved" ||
                desc.startsWith("send post") ||
                desc == "about this reel" || text == "about this reel" ||
                text.startsWith("liked by ") || desc.startsWith("liked by ") ||
                desc.contains("liked this reel") || text.contains("liked this reel") ||
                desc.contains("double tap to like") ||
                hint.contains("add a comment") || text.startsWith("add a comment") ||
                (text.startsWith("view all ") && text.contains("comment"))
            ) {
                hasFeedOrReelUi = true
            }

            // Main Instagram bottom navigation bar (only if visibly on-screen at bottom)
            if (n.bottom > screenHeight * 0.88f && n.top > screenHeight * 0.80f &&
                n.width > 10 && n.height > 10
            ) {
                if (desc == "home" || desc == "search and explore" || desc == "reels" ||
                    desc == "profile" || desc == "profile tab" ||
                    id.endsWith(":id/tab_bar") || id.endsWith(":id/bottom_navigation_bar")
                ) {
                    hasVisibleMainBottomNav = true
                }
            }

            // Back / Navigate up in top-left header
            if (n.top in 0..(screenHeight * 0.18f).toInt() && n.left < screenWidth * 0.30f) {
                val isExplicitBack = id.contains("back") || desc == "back" ||
                    desc.startsWith("back") || desc.contains("go back") ||
                    desc.contains("navigate up")
                if (isExplicitBack) {
                    hasTopLeftBack = true
                }
            }

            // Call / Video chat / Thread details in top header (DM thread only)
            if (n.top in 0..(screenHeight * 0.18f).toInt()) {
                if (desc.contains("audio call") || desc.contains("video call") ||
                    desc.contains("voice call") || desc.contains("video chat") ||
                    desc.contains("voice chat") || desc.contains("start video") ||
                    desc.contains("start audio") || desc.contains("conversation info") ||
                    desc.contains("thread details") || desc.contains("chat details") ||
                    desc.contains("chat controls") || desc == "call" || desc == "video" ||
                    id.contains("action_bar_call") || id.contains("thread_details") ||
                    id.contains("direct_thread") || id.contains("row_thread_header")
                ) {
                    hasCallOrThreadInfo = true
                }
            }

            // Bottom composer bar (supports EditText, focused input, and Compose TextView "Message...")
            val isLowerScreen = n.bottom > screenHeight * 0.45f
            if (isLowerScreen) {
                val isComposerId = id.contains("composer_edittext") ||
                    id.contains("row_thread_composer") ||
                    id.contains("direct_composer")
                if (isComposerId && !id.contains("search") && !id.contains("comment")) {
                    hasThreadComposerId = true
                }
                val isComposerText = text == "message..." || text == "message…" ||
                    hint == "message..." || hint == "message…" ||
                    text.startsWith("message ") || hint.startsWith("message ") ||
                    desc.contains("message...") || desc.contains("send message")
                val isEditText = n.isEditable || n.className.contains("EditText", ignoreCase = true)

                if ((isComposerId && !id.contains("search") && !id.contains("comment")) ||
                    (isComposerText && !id.contains("search") && !hint.contains("comment") && !id.contains("comment")) ||
                    (isEditText && !id.contains("search") && !desc.contains("search") &&
                        !hint.contains("search") && !hint.contains("comment") &&
                        !id.contains("comment") && !hint.contains("ask meta ai"))
                ) {
                    hasBottomComposer = true
                }

                if (n.bottom > screenHeight * 0.72f && (
                        desc.contains("voice message") || desc.contains("record voice") ||
                            desc.contains("send message") || text == "send" ||
                            id.contains("composer_send") || id.contains("composer_camera")
                        )
                ) {
                    hasBottomBarActions = true
                }
            }
        }

        if (hasFeedOrReelUi) return false
        if (hasThreadComposerId) return true
        if (hasVisibleMainBottomNav) return false
        if (hasBottomComposer) return true
        return hasTopLeftBack && (hasCallOrThreadInfo || hasBottomBarActions)
    }

    /**
     * Picks the best visible Instagram DM conversation header title + header bottom Y coordinate
     * so message bubbles below don't accidentally capture the @username subtitle.
     */
    fun pickInstagramHeaderTitle(
        nodes: List<A11yNodeSnapshot>,
        screenWidth: Int,
        screenHeight: Int,
        isReserved: (String?) -> Boolean,
        extractFromDesc: (String?) -> String?
    ): InstagramHeaderSelection? {
        if (nodes.isEmpty() || screenHeight <= 0 || screenWidth <= 0) return null
        val maxHeaderY = (screenHeight * 0.17f).toInt()

        val priorityIdSuffixes = listOf(
            ":id/row_thread_header_name",
            ":id/row_thread_header_title",
            ":id/action_bar_title",
            ":id/action_bar_textview_title",
            ":id/action_bar_large_title_auto_size",
            ":id/thread_title",
            ":id/header_title",
            ":id/user_name",
            ":id/username",
            ":id/title"
        )

        val visibleHeaderNodes = nodes.filter { n ->
            n.isVisibleToUser &&
                n.top >= 0 &&
                n.top < maxHeaderY &&
                n.bottom > 10 &&
                n.bottom <= (screenHeight * 0.21f).toInt() &&
                n.height in 10..260 &&
                n.right > (screenWidth * 0.05f).toInt() &&
                n.left < (screenWidth * 0.90f).toInt() &&
                n.width > 5
        }

        // 1. Check known thread header view IDs in priority order
        for (suffix in priorityIdSuffixes) {
            val matching = visibleHeaderNodes
                .filter { it.viewId.lowercase().endsWith(suffix) }
                .sortedBy { it.top }
            for (n in matching) {
                val raw = n.text.trim().ifBlank { n.contentDescription.trim() }
                if (raw.isNotBlank() && !isReserved(raw)) {
                    val clean = raw.replace("\\s+".toRegex(), " ").trim()
                    if (clean.length in 1..60 && !punctuationOnlyRegex.matches(clean)) {
                        return InstagramHeaderSelection(clean, n.bottom)
                    }
                }
                val cdName = extractFromDesc(n.contentDescription)
                if (!cdName.isNullOrBlank() && !isReserved(cdName)) {
                    return InstagramHeaderSelection(cdName, n.bottom)
                }
            }
        }

        // 2. Structural fallback in header bar (between Back button and Call icons)
        val titleSlotTexts = mutableListOf<Pair<String, Int>>()
        val profileNames = mutableListOf<Pair<String, Int>>()
        val fallbackCdTexts = mutableListOf<Pair<String, Int>>()

        for (n in visibleHeaderNodes) {
            val inTitleHorizontalSlot = n.left >= (screenWidth * 0.08f).toInt() &&
                n.right <= (screenWidth * 0.85f).toInt()

            val t = n.text.trim()
            if (t.isNotBlank() && t.length in 2..60 &&
                !isReserved(t) && !punctuationOnlyRegex.matches(t)
            ) {
                if (inTitleHorizontalSlot) {
                    titleSlotTexts.add(t to n.bottom)
                }
            }

            val cd = n.contentDescription.trim()
            val cdName = extractFromDesc(cd)
            if (!cdName.isNullOrBlank() && !isReserved(cdName) && !punctuationOnlyRegex.matches(cdName)) {
                profileNames.add(cdName to n.bottom)
            } else if (inTitleHorizontalSlot && cd.isNotBlank() && cd.length in 2..60 &&
                !isReserved(cd) && !punctuationOnlyRegex.matches(cd)
            ) {
                fallbackCdTexts.add(cd to n.bottom)
            }
        }

        val chosen = titleSlotTexts.minByOrNull { it.second }
            ?: profileNames.minByOrNull { it.second }
            ?: fallbackCdTexts.minByOrNull { it.second }
            ?: return null

        val cleanTitle = chosen.first.replace("\\s+".toRegex(), " ").trim()
        return InstagramHeaderSelection(cleanTitle, chosen.second)
    }

    /**
     * Checks whether a parent node is a scrollable list container that we must NEVER climb into
     * when isolating a single clicked chat row.
     */
    fun isScrollableListContainer(node: A11yNodeSnapshot, screenHeight: Int): Boolean {
        if (node.isScrollable) return true
        val cls = node.className.lowercase()
        if (cls.contains("recyclerview") || cls.contains("listview") || cls.contains("scrollview")) {
            return true
        }
        return screenHeight > 0 && node.height > (screenHeight * 0.35f).toInt()
    }

    /**
     * Extracts the chat title from nodes strictly inside a single clicked Inbox row.
     */
    fun pickClickedInboxTitle(
        rowNodes: List<A11yNodeSnapshot>,
        isReserved: (String?) -> Boolean,
        extractFromDesc: (String?) -> String?
    ): String? {
        if (rowNodes.isEmpty()) return null

        val visibleNodes = rowNodes.filter { it.isVisibleToUser }
        val searchList = visibleNodes.ifEmpty { rowNodes }

        // 1. Prefer explicit row username / title IDs
        val idCandidates = listOf(":id/row_inbox_username", ":id/username", ":id/title", ":id/name")
        for (suffix in idCandidates) {
            val match = searchList.firstOrNull { n ->
                n.viewId.lowercase().endsWith(suffix) &&
                    n.text.trim().length in 2..50 &&
                    !isReserved(n.text.trim()) &&
                    !punctuationOnlyRegex.matches(n.text.trim())
            }
            if (match != null) return match.text.trim()
        }

        // 2. Profile photo contentDescription inside the clicked row
        for (n in searchList) {
            val extT = extractFromDesc(n.text)
            if (!extT.isNullOrBlank() && !isReserved(extT)) return extT
            val extCd = extractFromDesc(n.contentDescription)
            if (!extCd.isNullOrBlank() && !isReserved(extCd)) return extCd
        }

        // 3. Topmost valid non-time text inside the clicked row
        val sortedByTop = searchList.sortedBy { it.top }
        for (n in sortedByTop) {
            val t = n.text.trim()
            if (t.length in 2..50 &&
                !t.contains(":\\d{2}".toRegex()) &&
                !isReserved(t) &&
                !punctuationOnlyRegex.matches(t)
            ) {
                return t
            }
        }
        return null
    }

    /**
     * Detects WhatsApp Updates/Status tab leaks (e.g. "...", "1 unread status", "0 new updates").
     */
    fun isWhatsAppStatusOrOverflowText(text: String?): Boolean {
        if (text.isNullOrBlank()) return true
        val trimmed = text.trim()
        val lower = trimmed.lowercase()
        if (punctuationOnlyRegex.matches(trimmed)) return true
        return lower == "..." ||
            lower == "…" ||
            lower.contains("unread status") ||
            lower.contains("new updates") ||
            lower.contains("tap to add new status") ||
            lower.contains("'s status.") ||
            lower.contains("’s status.") ||
            lower == "my status" ||
            lower == "add status" ||
            lower.endsWith(" profile picture") ||
            lower.endsWith(" picture")
    }
}
