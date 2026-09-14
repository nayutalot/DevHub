package com.devhub.mobile.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * UX-P2（docs/24 §3 对话列表行 / docs/26 §3.1）：最近消息预览纯函数锁——
 * 清 ** 显示记号（不改数据）+ 压缩空白 + 60 字截断加省略号；空 → null（回退模式副文案）。
 */
class SessionListRowPreviewTest {

    @Test
    fun `plain content passes through`() {
        assertEquals("你好，帮我看看构建日志", SessionListOps.rowPreview("你好，帮我看看构建日志"))
    }

    @Test
    fun `display markers stripped without touching data`() {
        // ** 为 RichTextTokenizer 显示记号（打磨批 D 纪律：显示层清理，数据层原样）
        assertEquals("任务 abc 完成", SessionListOps.rowPreview("**任务 abc** 完成"))
    }

    @Test
    fun `whitespace collapsed to single spaces`() {
        assertEquals("a b c", SessionListOps.rowPreview("a\n  b\t c"))
    }

    @Test
    fun `long content truncated with ellipsis`() {
        val long = "字".repeat(SessionListOps.ROW_PREVIEW_MAX_CHARS + 10)
        val out = SessionListOps.rowPreview(long)!!
        assertEquals(SessionListOps.ROW_PREVIEW_MAX_CHARS + 1, out.length)
        assertEquals("…", out.last().toString())
    }

    @Test
    fun `exact limit not truncated`() {
        val exact = "字".repeat(SessionListOps.ROW_PREVIEW_MAX_CHARS)
        assertEquals(exact, SessionListOps.rowPreview(exact))
    }

    @Test
    fun `null and blank map to null`() {
        assertNull(SessionListOps.rowPreview(null))
        assertNull(SessionListOps.rowPreview(""))
        assertNull(SessionListOps.rowPreview("   \n\t"))
    }
}
