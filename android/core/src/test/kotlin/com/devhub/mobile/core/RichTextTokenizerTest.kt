package com.devhub.mobile.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** R8 迷你渲染分词：代码等宽 / 链接只显 label / plugin·skill·mcp chip / 转义符清理 / 内容零丢失。 */
class RichTextTokenizerTest {

    @Test
    fun `plain text stays plain`() {
        assertEquals(
            listOf<RichTextTokenizer.RichToken>(RichTextTokenizer.RichToken.Plain("普通消息")),
            RichTextTokenizer.tokenize("普通消息"),
        )
    }

    @Test
    fun `inline code span detected`() {
        val out = RichTextTokenizer.tokenize("运行 `npm test` 看结果")
        assertEquals(3, out.size)
        assertEquals(RichTextTokenizer.RichToken.Plain("运行 "), out[0])
        assertEquals(RichTextTokenizer.RichToken.CodeSpan("npm test"), out[1])
        assertEquals(RichTextTokenizer.RichToken.Plain(" 看结果"), out[2])
    }

    @Test
    fun `fenced code block keeps content verbatim`() {
        val src = "如下：\n```kotlin\nval a = 1\n```\n完"
        val out = RichTextTokenizer.tokenize(src)
        assertEquals(3, out.size)
        assertEquals(RichTextTokenizer.RichToken.CodeBlock("val a = 1\n"), out[1])
    }

    @Test
    fun `unclosed fence does not lose content`() {
        val src = "前文\n```python\nprint(1)"
        val out = RichTextTokenizer.tokenize(src)
        val joined = out.joinToString("") {
            when (it) {
                is RichTextTokenizer.RichToken.Plain -> it.text
                is RichTextTokenizer.RichToken.CodeBlock -> it.code
                is RichTextTokenizer.RichToken.CodeSpan -> it.code
                is RichTextTokenizer.RichToken.Link -> it.label
                is RichTextTokenizer.RichToken.ReferenceChip -> it.display
            }
        }
        // 全部内容仍在（不含围栏记号本身）
        assertTrue(joined.contains("前文"))
        assertTrue(joined.contains("print(1)"))
    }

    @Test
    fun `markdown link renders label only`() {
        val out = RichTextTokenizer.tokenize("见 [文档](https://example.com/a) 即可")
        assertEquals(3, out.size)
        val link = out[1] as RichTextTokenizer.RichToken.Link
        assertEquals("文档", link.label)
        assertEquals("https://example.com/a", link.url)
    }

    @Test
    fun `escaped markdown link with plugin uri renders as chip`() {
        // R8 用户实例：\[Android 模拟器]\(plugin://Android-Emulator)（原文两处均带反斜杠）
        val out = RichTextTokenizer.tokenize("打开 \\[Android 模拟器\\]\\(plugin://Android-Emulator\\) 面板")
        val chip = out.filterIsInstance<RichTextTokenizer.RichToken.ReferenceChip>().single()
        assertEquals("插件", chip.kindLabel)
        assertEquals("Android 模拟器", chip.name)
        assertEquals("[插件] Android 模拟器", chip.display)
        // 转义符已清理：任何 token 都不含反斜杠残留
        assertTrue(out.none {
            it is RichTextTokenizer.RichToken.Plain && it.text.contains("\\")
        })
    }

    @Test
    fun `bare plugin uri renders as chip with tail name`() {
        val out = RichTextTokenizer.tokenize("调用 plugin://ZCode-Subagent 完成")
        val chip = out.filterIsInstance<RichTextTokenizer.RichToken.ReferenceChip>().single()
        assertEquals("插件", chip.kindLabel)
        assertEquals("ZCode-Subagent", chip.name)
    }

    @Test
    fun `skill and mcp schemes map to kind labels`() {
        val skill = RichTextTokenizer.tokenize("用 skill://pdf-export 导出")
            .filterIsInstance<RichTextTokenizer.RichToken.ReferenceChip>().single()
        assertEquals("技能", skill.kindLabel)
        val mcp = RichTextTokenizer.tokenize("[MCP 工具](mcp://fs/read_file) 读取")
            .filterIsInstance<RichTextTokenizer.RichToken.ReferenceChip>().single()
        assertEquals("MCP", mcp.kindLabel)
        assertEquals("MCP 工具", mcp.name)
    }

    @Test
    fun `plain https link inside text does not become chip`() {
        val out = RichTextTokenizer.tokenize("[官网](https://example.com)")
        assertTrue(out[0] is RichTextTokenizer.RichToken.Link)
    }

    @Test
    fun `escaped punctuation cleaned`() {
        val out = RichTextTokenizer.tokenize("标点 \\[x\\] 与 \\*y\\* 和 \\\\z")
        val joined = out.filterIsInstance<RichTextTokenizer.RichToken.Plain>().joinToString("") { it.text }
        assertTrue(joined.contains("[x]"))
        assertTrue(joined.contains("*y*"))
        assertTrue(joined.contains("\\z"))
    }

    @Test
    fun `empty and odd inputs never throw`() {
        assertEquals(0, RichTextTokenizer.tokenize("").size)
        RichTextTokenizer.tokenize("`` ` `` [ ] ( ) \\ plugin:// [[]](()) ``")
    }

    @Test
    fun `mixed content preserves order`() {
        val out = RichTextTokenizer.tokenize("A `code` B [L](https://e.com) C plugin://p1 D")
        assertTrue(out[0] is RichTextTokenizer.RichToken.Plain)
        assertTrue(out.any { it is RichTextTokenizer.RichToken.CodeSpan })
        assertTrue(out.any { it is RichTextTokenizer.RichToken.Link })
        assertTrue(out.any { it is RichTextTokenizer.RichToken.ReferenceChip })
        assertEquals("D", (out.last() as RichTextTokenizer.RichToken.Plain).text.trim())
    }
}
