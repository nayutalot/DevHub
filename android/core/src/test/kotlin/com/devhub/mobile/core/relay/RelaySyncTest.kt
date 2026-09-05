package com.devhub.mobile.core.relay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** 累计游标 + 有界去重（docs/18 §3.11/§6.2/§6.3 + §3.10 双通道去重）。 */
class RelaySyncTest {

    // ---- CumulativeAckCursor ----

    @Test
    fun `cursor advances contiguously`() {
        val c = CumulativeAckCursor(initial = 14800)
        assertTrue(c.observe(14801))
        assertTrue(c.observe(14802))
        assertEquals(14802, c.value)
    }

    @Test
    fun `cursor never regresses on duplicates or old sequences`() {
        val c = CumulativeAckCursor(initial = 14800)
        assertFalse(c.observe(14800))
        assertFalse(c.observe(14799))
        assertFalse(c.observe(14800))
        assertEquals(14800, c.value)
    }

    @Test
    fun `cursor holds back across holes until gap filled`() {
        val c = CumulativeAckCursor(initial = 14800)
        // 14801 缺失（ECS 缓存洞，hasGaps 场景）：后位事件不得计入 after
        assertFalse(c.observe(14803))
        assertEquals(14800, c.value)
        assertFalse(c.observe(14802))
        assertEquals(14800, c.value)
        assertEquals(2, c.heldCount())
        // 缺口事件补到 → 挂起链一次解挂
        assertTrue(c.observe(14801))
        assertEquals(14803, c.value)
        assertEquals(0, c.heldCount())
    }

    @Test
    fun `gapFill advances explicitly after REST authoritative refresh`() {
        val c = CumulativeAckCursor(initial = 14800)
        assertFalse(c.observe(14871))
        assertTrue(c.gapFill(14871))
        assertEquals(14871, c.value)
        assertFalse(c.gapFill(14860)) // 只前进
        assertFalse(c.observe(14871)) // 之后补发的重复帧不再前进
    }

    @Test
    fun `cursor from restored persisted state keeps ack-only-forward`() {
        // App 重启：lastAckedSeq 从 Room 恢复（EventAckState）——重连 sync 后重复事件零推进
        val c = CumulativeAckCursor(initial = 14871)
        assertFalse(c.observe(14861))
        assertTrue(c.observe(14872))
        assertEquals(14872, c.value)
    }

    // ---- BoundedSeenSet ----

    @Test
    fun `dedup drops second sight of same key`() {
        val s = BoundedSeenSet()
        assertFalse(s.seenAndRecord("codex:s:evt:1"))
        assertTrue(s.seenAndRecord("codex:s:evt:1"))
        assertFalse(s.seenAndRecord("codex:s:evt:2"))
        assertEquals(2, s.size())
    }

    @Test
    fun `dedup evicts oldest beyond capacity`() {
        val s = BoundedSeenSet(capacity = 2)
        assertFalse(s.seenAndRecord("a"))
        assertFalse(s.seenAndRecord("b"))
        assertFalse(s.seenAndRecord("c")) // a 被淘汰
        assertEquals(2, s.size())
        assertFalse(s.seenAndRecord("a")) // 重新可见（容量语义，供重放窗口外事件）
        assertTrue(s.seenAndRecord("c"))
        assertFalse(s.seenAndRecord("b")) // b 已被 a 挤出
    }

    @Test
    fun `command_result dedup keeps first arrival per commandId`() {
        // docs/18 §3.10：Android 以 commandId 为键保留先到者，后到者仅刷新时间戳
        val seen = BoundedSeenSet()
        val firstArrival = !seen.seenAndRecord("cmd-6a1b")
        val duplicateArrival = seen.seenAndRecord("cmd-6a1b")
        assertTrue(firstArrival)
        assertTrue(duplicateArrival)
    }
}
