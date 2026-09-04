package com.devhub.mobile.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** R1 分段解析模型：无结构回退整段 text（绝不猜）、未知 kind 保留内容、thinking 字数。 */
class MessageSegmentsTest {

    private fun raw(kind: String?, label: String? = null, content: String? = null) =
        MessageSegments.RawSegment(kind = kind, label = label, content = content)

    @Test
    fun `null segments returns null so caller falls back to plain text`() {
        assertNull(MessageSegments.normalize(null))
        assertNull(MessageSegments.normalize(emptyList()))
    }

    @Test
    fun `missing kind treated as text`() {
        val out = MessageSegments.normalize(listOf(raw(null, content = "纯文本消息")))!!
        assertEquals(1, out.size)
        assertEquals(MessageSegments.Segment.Text("纯文本消息"), out[0])
    }

    @Test
    fun `unknown kind keeps content as text and never drops it`() {
        val out = MessageSegments.normalize(listOf(raw("exotic_future_kind", content = "未知结构内容")))!!
        assertEquals(listOf<MessageSegments.Segment>(MessageSegments.Segment.Text("未知结构内容")), out)
    }

    @Test
    fun `thinking and tool segments normalize in order`() {
        val out = MessageSegments.normalize(
            listOf(
                raw("text", content = "先看这个"),
                raw("thinking", content = "推理过程……"),
                raw("toolInvocation", label = "Bash", content = "ls -la"),
                raw("text", content = "结论"),
            ),
        )!!
        assertEquals(4, out.size)
        assertTrue(out[0] is MessageSegments.Segment.Text)
        assertTrue(out[1] is MessageSegments.Segment.Thinking)
        assertEquals("推理过程……", (out[1] as MessageSegments.Segment.Thinking).content)
        val tool = out[2] as MessageSegments.Segment.ToolInvocation
        assertEquals("Bash", tool.label)
        assertEquals("ls -la", tool.content)
        assertTrue(out[3] is MessageSegments.Segment.Text)
    }

    @Test
    fun `blank text segments dropped but not whole message`() {
        val out = MessageSegments.normalize(
            listOf(raw("text", content = "  "), raw("text", content = "有效")),
        )!!
        assertEquals(listOf<MessageSegments.Segment>(MessageSegments.Segment.Text("有效")), out)
    }

    @Test
    fun `all-blank segments normalize to null fallback`() {
        assertNull(MessageSegments.normalize(listOf(raw("text", content = "   "))))
    }

    @Test
    fun `thinking char count uses code points`() {
        assertEquals(5, MessageSegments.thinkingCharCount("abc😀d"))
        assertEquals("💭 思维链 · 5 字", MessageSegments.thinkingFoldLabel("abc😀d"))
    }

    @Test
    fun `tool segment with empty content but label kept`() {
        val out = MessageSegments.normalize(listOf(raw("toolInvocation", label = "Read", content = "")))!!
        assertEquals(1, out.size)
        assertEquals("Read", (out[0] as MessageSegments.Segment.ToolInvocation).label)
    }
}
