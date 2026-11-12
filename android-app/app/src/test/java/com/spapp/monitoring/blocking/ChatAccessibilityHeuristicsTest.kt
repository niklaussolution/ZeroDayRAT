package com.spapp.monitoring.blocking

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatAccessibilityHeuristicsTest {

    private val screenW = 1080
    private val screenH = 2400

    private val igReserved = setOf(
        "instagram", "direct", "messages", "search", "back", "navigate up",
        "audio call", "video call", "video chat", "details", "active now",
        "message...", "voice message", "gallery", "home", "reels", "profile"
    )

    private fun isIgReserved(t: String?): Boolean {
        if (t.isNullOrBlank()) return true
        val l = t.trim().lowercase()
        return l in igReserved || l.startsWith("active ") || l == "..." || l == "…"
    }

    private fun extractIgDescName(desc: String?): String? {
        if (desc.isNullOrBlank()) return null
        val prefix = "Profile photo of "
        if (desc.startsWith(prefix, ignoreCase = true)) {
            val candidate = desc.substring(prefix.length).trim()
            return candidate.takeIf { !isIgReserved(it) }
        }
        return null
    }

    @Test
    fun `isInsideInstagramConversation ignores hidden background tab_bar from backstack`() {
        val nodes = listOf(
            // Retained invisible or offscreen bottom nav from main feed fragment
            A11yNodeSnapshot(
                left = 0, top = 2200, right = 1080, bottom = 2400,
                isVisibleToUser = false,
                viewId = "com.instagram.android:id/tab_bar",
                contentDescription = "Home"
            ),
            // Deep Compose/TextView composer in active DM conversation
            A11yNodeSnapshot(
                left = 140, top = 2180, right = 780, bottom = 2320,
                isVisibleToUser = true,
                text = "Message...",
                depth = 48
            ),
            A11yNodeSnapshot(
                left = 20, top = 110, right = 120, bottom = 210,
                isVisibleToUser = true,
                contentDescription = "Back",
                isClickable = true
            )
        )
        assertTrue(ChatAccessibilityHeuristics.isInsideInstagramConversation(nodes, screenW, screenH))
    }

    @Test
    fun `isInsideInstagramConversation returns false when actually on DM Inbox`() {
        val nodes = listOf(
            A11yNodeSnapshot(
                left = 0, top = 2200, right = 1080, bottom = 2400,
                isVisibleToUser = true,
                viewId = "com.instagram.android:id/tab_bar"
            ),
            A11yNodeSnapshot(
                left = 100, top = 240, right = 980, bottom = 340,
                isVisibleToUser = true,
                viewId = "com.instagram.android:id/search_edit_text",
                hintText = "Search",
                isEditable = true
            )
        )
        assertFalse(ChatAccessibilityHeuristics.isInsideInstagramConversation(nodes, screenW, screenH))
    }

    @Test
    fun `pickInstagramHeaderTitle skips offscreen previous chat and picks visible 3rd chat`() {
        val nodes = listOf(
            // Old chat clipped off-screen / invisible in ViewPager
            A11yNodeSnapshot(
                left = -1080, top = 120, right = 0, bottom = 200,
                isVisibleToUser = true,
                viewId = "com.instagram.android:id/action_bar_title",
                text = "Moulidhar"
            ),
            A11yNodeSnapshot(
                left = 200, top = 120, right = 600, bottom = 200,
                isVisibleToUser = false,
                viewId = "com.instagram.android:id/header_title",
                text = "V ᴀ s ᴀ ɴ ᴛ ʜ ❣️"
            ),
            // Visible 3rd chat header in top bar (y ~ 10%) and deep depth 45
            A11yNodeSnapshot(
                left = 210, top = 240, right = 680, bottom = 310,
                isVisibleToUser = true,
                text = "Karthik IT KSR",
                depth = 45
            ),
            A11yNodeSnapshot(
                left = 210, top = 315, right = 540, bottom = 350,
                isVisibleToUser = true,
                text = "karthik_ksr_07",
                depth = 45
            )
        )

        val selected = ChatAccessibilityHeuristics.pickInstagramHeaderTitle(
            nodes = nodes,
            screenWidth = screenW,
            screenHeight = screenH,
            isReserved = ::isIgReserved,
            extractFromDesc = ::extractIgDescName
        )

        assertNotNull(selected)
        assertEquals("Karthik IT KSR", selected?.title)
        assertEquals(310, selected?.headerBottom)
    }

    @Test
    fun `pickClickedInboxTitle picks 3rd clicked row and refuses scrollable list container`() {
        val recycler = A11yNodeSnapshot(
            left = 0, top = 350, right = 1080, bottom = 2200,
            isScrollable = true,
            className = "androidx.recyclerview.widget.RecyclerView"
        )
        assertTrue(ChatAccessibilityHeuristics.isScrollableListContainer(recycler, screenH))

        // Only nodes strictly inside 3rd row are collected
        val thirdRowNodes = listOf(
            A11yNodeSnapshot(
                left = 30, top = 920, right = 180, bottom = 1070,
                contentDescription = "Profile photo of Saran Dev"
            ),
            A11yNodeSnapshot(
                left = 210, top = 930, right = 700, bottom = 985,
                viewId = "com.instagram.android:id/row_inbox_username",
                text = "Saran Dev"
            ),
            A11yNodeSnapshot(
                left = 210, top = 995, right = 820, bottom = 1045,
                text = "Bro meeting tomorrow"
            )
        )

        val picked = ChatAccessibilityHeuristics.pickClickedInboxTitle(
            rowNodes = thirdRowNodes,
            isReserved = ::isIgReserved,
            extractFromDesc = ::extractIgDescName
        )
        assertEquals("Saran Dev", picked)
    }

    @Test
    fun `isWhatsAppStatusOrOverflowText filters ellipsis and Updates tab status leaks`() {
        assertTrue(ChatAccessibilityHeuristics.isWhatsAppStatusOrOverflowText("..."))
        assertTrue(ChatAccessibilityHeuristics.isWhatsAppStatusOrOverflowText("…"))
        assertTrue(ChatAccessibilityHeuristics.isWhatsAppStatusOrOverflowText("Nikash IT KSR, 1 unread status"))
        assertTrue(ChatAccessibilityHeuristics.isWhatsAppStatusOrOverflowText("My status, tap to add new status"))
        assertTrue(ChatAccessibilityHeuristics.isWhatsAppStatusOrOverflowText("Dhanush IT Jr KSR's status. 0 new updates"))
        assertFalse(ChatAccessibilityHeuristics.isWhatsAppStatusOrOverflowText("Pannu"))
        assertFalse(ChatAccessibilityHeuristics.isWhatsAppStatusOrOverflowText("Dev Vasanth Niklaus"))
    }

    @Test
    fun `isInsideInstagramConversation rejects Reels and Feed screens with Send post or Add to Saved`() {
        val reelNodes = listOf(
            A11yNodeSnapshot(left = 20, top = 110, right = 120, bottom = 210, contentDescription = "Back"),
            A11yNodeSnapshot(left = 200, top = 120, right = 500, bottom = 190, text = "Friends"),
            A11yNodeSnapshot(
                left = 880, top = 1850, right = 1040, bottom = 1960,
                contentDescription = "Send post. 124 shares. Button. Double tap to choose who to send this post to."
            ),
            A11yNodeSnapshot(left = 880, top = 1980, right = 1040, bottom = 2060, contentDescription = "Add to Saved"),
            A11yNodeSnapshot(left = 880, top = 2100, right = 1040, bottom = 2180, text = "Repost"),
            A11yNodeSnapshot(left = 40, top = 2000, right = 700, bottom = 2060, text = "Liked by amir_x_xr and others"),
            A11yNodeSnapshot(left = 880, top = 2180, right = 1040, bottom = 2260, contentDescription = "More actions for this post")
        )
        assertFalse(ChatAccessibilityHeuristics.isInsideInstagramConversation(reelNodes, screenW, screenH))
    }

    @Test
    fun `pickInstagramHeaderTitle ignores scrolled chat message below 17 percent top band`() {
        val nodes = listOf(
            // Actual header at top ~8%
            A11yNodeSnapshot(left = 200, top = 150, right = 600, bottom = 230, text = "Moulidhar"),
            // Scrolled DM message bubble around ~20%
            A11yNodeSnapshot(left = 120, top = 450, right = 560, bottom = 530, text = "Erode la polama")
        )
        val picked = ChatAccessibilityHeuristics.pickInstagramHeaderTitle(
            nodes = nodes,
            screenWidth = screenW,
            screenHeight = screenH,
            isReserved = ::isIgReserved,
            extractFromDesc = ::extractIgDescName
        )
        assertNotNull(picked)
        assertEquals("Moulidhar", picked?.title)

        // When header hasn't rendered yet, a scrolled message bubble at y=450 must NOT become chat title
        val onlyScrolledMsg = listOf(
            A11yNodeSnapshot(left = 120, top = 450, right = 560, bottom = 530, text = "Erode la polama")
        )
        assertNull(
            ChatAccessibilityHeuristics.pickInstagramHeaderTitle(
                nodes = onlyScrolledMsg,
                screenWidth = screenW,
                screenHeight = screenH,
                isReserved = ::isIgReserved,
                extractFromDesc = ::extractIgDescName
            )
        )
    }
}
