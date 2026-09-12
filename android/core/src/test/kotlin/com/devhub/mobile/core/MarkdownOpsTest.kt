package com.devhub.mobile.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * U3 批（AUDIT P3#1）MarkdownOps 单测：
 * 块级子集（标题/段落/列表/表格/代码围栏）+ 行内子集（加粗/行内 code/斜体）+
 * 审计语料形态 + 畸形输入族（残缺/未闭合/超长/空）+ 回退断言（子集外纯文本、内容零丢失、绝不抛）。
 */
class MarkdownOpsTest {

    // ---- 块级：标题 ----

    @Test
    fun `atx heading levels 1 to 6 detected with text`() {
        for (level in 1..6) {
            val marks = "#".repeat(level)
            val out = MarkdownOps.parse("$marks 标题$level")
            assertEquals(1, out.size)
            assertEquals(MarkdownOps.Block.Heading(level, "标题$level"), out[0])
        }
    }

    @Test
    fun `heading without text after marks keeps empty heading`() {
        val out = MarkdownOps.parse("##")
        assertEquals(listOf(MarkdownOps.Block.Heading(2, "")), out)
    }

    @Test
    fun `seven hashes is not a heading falls back to paragraph`() {
        val out = MarkdownOps.parse("####### 七个井号")
        assertEquals(listOf(MarkdownOps.Block.Paragraph("####### 七个井号")), out)
    }

    @Test
    fun `hash without space is not a heading`() {
        val out = MarkdownOps.parse("#tag 与 #space")
        assertEquals(listOf(MarkdownOps.Block.Paragraph("#tag 与 #space")), out)
    }

    // ---- 块级：段落 ----

    @Test
    fun `plain text is single paragraph`() {
        val out = MarkdownOps.parse("纯文本消息")
        assertEquals(listOf(MarkdownOps.Block.Paragraph("纯文本消息")), out)
    }

    @Test
    fun `blank line splits paragraphs and multi-line paragraph keeps newlines`() {
        val out = MarkdownOps.parse("第一段第一行\n第一段第二行\n\n第二段")
        assertEquals(2, out.size)
        assertEquals(MarkdownOps.Block.Paragraph("第一段第一行\n第一段第二行"), out[0])
        assertEquals(MarkdownOps.Block.Paragraph("第二段"), out[1])
    }

    @Test
    fun `empty and blank only inputs yield empty block list`() {
        assertEquals(emptyList<MarkdownOps.Block>(), MarkdownOps.parse(""))
        assertEquals(emptyList<MarkdownOps.Block>(), MarkdownOps.parse("\n \n\t\n"))
    }

    // ---- 块级：列表 ----

    @Test
    fun `unordered list markers dash plus star detected`() {
        val out = MarkdownOps.parse("- 甲\n+ 乙\n* 丙")
        assertEquals(
            listOf(
                MarkdownOps.Block.ListItem(false, null, "甲"),
                MarkdownOps.Block.ListItem(false, null, "乙"),
                MarkdownOps.Block.ListItem(false, null, "丙"),
            ),
            out,
        )
    }

    @Test
    fun `ordered list dot and paren with number extracted`() {
        val out = MarkdownOps.parse("1. 第一\n2) 第二\n10. 第十")
        assertEquals(
            listOf(
                MarkdownOps.Block.ListItem(true, 1, "第一"),
                MarkdownOps.Block.ListItem(true, 2, "第二"),
                MarkdownOps.Block.ListItem(true, 10, "第十"),
            ),
            out,
        )
    }

    @Test
    fun `marker without space is paragraph not list`() {
        // `-x` 与 `**bold**` 行首星号不误判为列表
        assertEquals(
            listOf(MarkdownOps.Block.Paragraph("-x 不是列表")),
            MarkdownOps.parse("-x 不是列表"),
        )
        assertEquals(
            listOf(MarkdownOps.Block.Paragraph("**加粗** 开头不是列表")),
            MarkdownOps.parse("**加粗** 开头不是列表"),
        )
    }

    @Test
    fun `bare marker is empty list item not dropped`() {
        assertEquals(
            listOf(MarkdownOps.Block.ListItem(false, null, "")),
            MarkdownOps.parse("-"),
        )
    }

    // ---- 块级：表格 ----

    @Test
    fun `table with header delimiter and rows parsed`() {
        val out = MarkdownOps.parse("| 收敛点 | 结果 |\n| --- | --- |\n| P4 表 11 | 已统一 |\n| P6 \"2/3\" | 已修 |")
        assertEquals(
            listOf(
                MarkdownOps.Block.Table(
                    header = listOf("收敛点", "结果"),
                    rows = listOf(listOf("P4 表 11", "已统一"), listOf("P6 \"2/3\"", "已修")),
                ),
            ),
            out,
        )
    }

    @Test
    fun `table alignment colons tolerated`() {
        val out = MarkdownOps.parse("左 | 右\n:--- | ---:")
        assertEquals(listOf(MarkdownOps.Block.Table(listOf("左", "右"), emptyList())), out)
    }

    @Test
    fun `table ragged body rows padded never truncated`() {
        val out = MarkdownOps.parse("a | b | c\n1 | 2\nx | y | z | w") // 首行成表头？无分隔行 → 段落
        // 此用例首行后无分隔行：整体回退段落（内容零丢失由 contains 断言）
        assertTrue(out.all { it is MarkdownOps.Block.Paragraph })
        val joined = out.joinToString("\n") { (it as MarkdownOps.Block.Paragraph).text }
        assertTrue(joined.contains("w"))
    }

    @Test
    fun `table short body cells padded to column count`() {
        // 表体行 "only1 |" 仅 1 格 → 补空串至 3 列（绝不截断）
        val out = MarkdownOps.parse("h1 | h2 | h3\n--- | --- | ---\nonly1 |")
        val table = out[0] as MarkdownOps.Block.Table
        assertEquals(listOf("only1", "", ""), table.rows[0])
        assertEquals(3, table.header.size)
    }

    @Test
    fun `table body extra cells extend columns`() {
        val out = MarkdownOps.parse("h1 | h2\n--- | ---\na | b | c")
        val table = out[0] as MarkdownOps.Block.Table
        assertEquals(listOf("h1", "h2", ""), table.header)
        assertEquals(listOf("a", "b", "c"), table.rows[0])
    }

    @Test
    fun `header delimiter cell count mismatch falls back to plain`() {
        // 表头 2 格、分隔行 1 格 → 不识别为表格（内容原样回退）
        val out = MarkdownOps.parse("a | b\n---")
        assertTrue(out.all { it is MarkdownOps.Block.Paragraph })
    }

    @Test
    fun `pipe line without delimiter row is paragraph`() {
        // 审计截图 06 形态：转录窗口截断后的残表碎片（无 --- 分隔行）→ 纯文本回退，竖线原样
        val src = "给出算式 (1 - 25.3/149.1) |\n| P4 表 11 vs 表 4 | 已统一 | 同一次运行 |"
        val out = MarkdownOps.parse(src)
        assertEquals(
            listOf(MarkdownOps.Block.Paragraph(src)),
            out,
        )
    }

    @Test
    fun `setext style underline not mistaken for table`() {
        // 相邻非空行合为一段（setext 下划线不触发表格，记号原样保留）
        assertEquals(
            listOf(MarkdownOps.Block.Paragraph("abc\n---")),
            MarkdownOps.parse("abc\n---"),
        )
    }

    // ---- 块级：代码围栏 ----

    @Test
    fun `code fence with language keeps content verbatim and drops info line`() {
        val out = MarkdownOps.parse("前文\n```kotlin\nval a = 1\nval b = 2\n```\n后文")
        assertEquals(3, out.size)
        assertEquals(MarkdownOps.Block.Paragraph("前文"), out[0])
        assertEquals(MarkdownOps.Block.CodeBlock("val a = 1\nval b = 2", "kotlin"), out[1])
        assertEquals(MarkdownOps.Block.Paragraph("后文"), out[2])
    }

    @Test
    fun `code fence without language and empty body`() {
        val out = MarkdownOps.parse("```\n```\n尾")
        assertEquals(
            listOf(
                MarkdownOps.Block.CodeBlock("", null),
                MarkdownOps.Block.Paragraph("尾"),
            ),
            out,
        )
    }

    @Test
    fun `unclosed fence falls back to plain with fence marks visible`() {
        val src = "前文\n```python\nprint(1)\n没有闭合"
        val out = MarkdownOps.parse(src)
        assertTrue(out.all { it is MarkdownOps.Block.Paragraph })
        val joined = out.joinToString("\n") { (it as MarkdownOps.Block.Paragraph).text }
        // 内容零丢失（含围栏记号本身）
        assertEquals(src, joined)
    }

    @Test
    fun `indented code is outside subset stays paragraph`() {
        val src = "普通行\n   缩进四格代码"
        val out = MarkdownOps.parse(src)
        assertEquals(listOf(MarkdownOps.Block.Paragraph("普通行\n   缩进四格代码")), out)
    }

    // ---- 块级：子集外回退 ----

    @Test
    fun `blockquote and html stay literal plain text`() {
        val out = MarkdownOps.parse("> 引用\n<div>html</div>")
        assertEquals(
            listOf(MarkdownOps.Block.Paragraph("> 引用\n<div>html</div>")),
            out,
        )
    }

    // ---- 行内 ----

    @Test
    fun `plain inline text single span`() {
        assertEquals(
            listOf<MarkdownOps.Span>(MarkdownOps.Span.Text("普通文本")),
            MarkdownOps.parseInline("普通文本"),
        )
    }

    @Test
    fun `bold detected and markers dropped in model`() {
        val out = MarkdownOps.parseInline("**任务** — 做小车")
        assertEquals(2, out.size)
        assertEquals(MarkdownOps.Span.Bold(listOf<MarkdownOps.Span>(MarkdownOps.Span.Text("任务"))), out[0])
        assertEquals(MarkdownOps.Span.Text(" — 做小车"), out[1])
    }

    @Test
    fun `unclosed bold stays literal`() {
        val out = MarkdownOps.parseInline("a ** b c")
        assertEquals(listOf<MarkdownOps.Span>(MarkdownOps.Span.Text("a ** b c")), out)
    }

    @Test
    fun `bold with inner code one level nesting`() {
        val out = MarkdownOps.parseInline("**运行 `npm test` 验证**")
        assertEquals(
            listOf(
                MarkdownOps.Span.Bold(
                    listOf(
                        MarkdownOps.Span.Text("运行 "),
                        MarkdownOps.Span.Code("npm test"),
                        MarkdownOps.Span.Text(" 验证"),
                    ),
                ),
            ),
            out,
        )
    }

    @Test
    fun `code span beats bold when overlapping`() {
        // 行内 code 优先：`` `**x**` `` → code 内容原样含星号
        val out = MarkdownOps.parseInline("`**x**`")
        assertEquals(listOf<MarkdownOps.Span>(MarkdownOps.Span.Code("**x**")), out)
    }

    @Test
    fun `unclosed backtick stays literal`() {
        val out = MarkdownOps.parseInline("运行 `npm test 看结果")
        assertEquals(listOf<MarkdownOps.Span>(MarkdownOps.Span.Text("运行 `npm test 看结果")), out)
    }

    @Test
    fun `italic detected conservatively`() {
        val out = MarkdownOps.parseInline("前 *强调* 后")
        assertEquals(3, out.size)
        assertEquals(MarkdownOps.Span.Italic("强调"), out[1])
    }

    @Test
    fun `arithmetic star run not italic`() {
        // `2*3*4` 开记号前非空白 → 不判斜体（算式不误渲染）
        val out = MarkdownOps.parseInline("2*3*4")
        assertEquals(listOf<MarkdownOps.Span>(MarkdownOps.Span.Text("2*3*4")), out)
    }

    @Test
    fun `italic with space padded content stays literal`() {
        val out = MarkdownOps.parseInline("a * b * c")
        assertEquals(listOf<MarkdownOps.Span>(MarkdownOps.Span.Text("a * b * c")), out)
    }

    @Test
    fun `link syntax stays literal outside subset`() {
        val src = "见 [文档](https://example.com/a) 即可"
        val out = MarkdownOps.parseInline(src)
        val joined = out.joinToString("") {
            when (it) {
                is MarkdownOps.Span.Text -> it.text
                is MarkdownOps.Span.Code -> it.code
                is MarkdownOps.Span.Italic -> it.text
                is MarkdownOps.Span.Bold -> it.spans.joinToString("") { s ->
                    when (s) {
                        is MarkdownOps.Span.Text -> s.text
                        is MarkdownOps.Span.Code -> s.code
                        else -> ""
                    }
                }
            }
        }
        assertEquals(src, joined)
    }

    @Test
    fun `bold padded content trimmed like existing tokenizer`() {
        val out = MarkdownOps.parseInline("** 空白加粗 **")
        assertEquals(
            listOf<MarkdownOps.Span>(MarkdownOps.Span.Bold(listOf<MarkdownOps.Span>(MarkdownOps.Span.Text("空白加粗")))),
            out,
        )
    }

    // ---- 审计语料综合 ----

    @Test
    fun `audit corpus shape yields table heading and code chips`() {
        // 审计 06 号截图语料形态：残表碎片 + ## 标题 + 行内 code（截图中已有芯片样式）
        val src = "给出算式 (1 - 25.3/149.1) |\n" +
            "| P4 表 11 vs 表 4 | 已统一 |\n" +
            "\n" +
            "## 漏网的一处（我已修）\n" +
            "\n" +
            "代码附录 `secB_代码附录tex` 里 `run_q1py` 的 verbatim 抄录还是旧索引"
        val blocks = MarkdownOps.parse(src)
        assertEquals(3, blocks.size)
        assertTrue(blocks[0] is MarkdownOps.Block.Paragraph)
        assertEquals(MarkdownOps.Block.Heading(2, "漏网的一处（我已修）"), blocks[1])
        assertTrue(blocks[2] is MarkdownOps.Block.Paragraph)
        assertFalse(MarkdownOps.isTrivial(blocks))
        val spans = MarkdownOps.parseInline((blocks[2] as MarkdownOps.Block.Paragraph).text)
        val codes = spans.filterIsInstance<MarkdownOps.Span.Code>()
        assertEquals(listOf("secB_代码附录tex", "run_q1py"), codes.map { it.code })
    }

    @Test
    fun `proper table makes message non trivial`() {
        val blocks = MarkdownOps.parse("| a | b |\n| --- | --- |\n| 1 | 2 |")
        assertTrue(blocks[0] is MarkdownOps.Block.Table)
        assertFalse(MarkdownOps.isTrivial(blocks))
    }

    // ---- 平凡判定（原路径零回退） ----

    @Test
    fun `isTrivial true for plain and inline-only messages`() {
        assertTrue(MarkdownOps.isTrivial(MarkdownOps.parse("纯文本")))
        assertTrue(MarkdownOps.isTrivial(MarkdownOps.parse("**加粗** 与 `code` 行内记号")))
        assertTrue(MarkdownOps.isTrivial(emptyList()))
    }

    @Test
    fun `isTrivial false for each structural block`() {
        assertFalse(MarkdownOps.isTrivial(MarkdownOps.parse("# 标题")))
        assertFalse(MarkdownOps.isTrivial(MarkdownOps.parse("- 列表")))
        assertFalse(MarkdownOps.isTrivial(MarkdownOps.parse("| a |\n| - |")))
        assertFalse(MarkdownOps.isTrivial(MarkdownOps.parse("```\ncode\n```")))
    }

    // ---- 畸形输入族：绝不抛、确定性、内容零丢失 ----

    @Test
    fun `malformed family never throws and is deterministic`() {
        val nasty = listOf(
            "",
            "\n",
            "**",
            "****",
            "``",
            "```",
            "```a",
            "```a\nb",
            "**a",
            "*a",
            "a*b*`c",
            "|\n|-|\n",
            "||\n|-|",
            "| a |",
            "| a |\n| --", // 分隔行被截断
            "1.",
            "1.",
            "#######",
            ">",
            "***a**",
            "**a*",
            "`a``b`",
            "*`a`*",
            "**`a`**",
            "## ",
            "#\n#\n#",
            "- \n- ",
            "0. x",
            "999999999. x",
            "1234567890. 超长序号",
        )
        for (src in nasty) {
            val a = MarkdownOps.parse(src)
            val b = MarkdownOps.parse(src)
            assertEquals(a, b) // 确定性
            val ia = MarkdownOps.parseInline(src)
            assertEquals(ia, MarkdownOps.parseInline(src))
            // 绝不空白：空输入外必有块（红线：失败回退绝不空白）
            if (src.isNotBlank()) assertTrue("输入「$src」解析后不得为空", a.isNotEmpty())
        }
    }

    @Test
    fun `super long line and star run bounded no hang`() {
        val longLine = "x".repeat(200_000)
        MarkdownOps.parse(longLine)
        MarkdownOps.parseInline(longLine)
        val starRun = "*".repeat(100_000)
        MarkdownOps.parseInline(starRun)
        val boldNoClose = "**" + "a".repeat(100_000)
        val out = MarkdownOps.parseInline(boldNoClose)
        // 内容零丢失：拼接后等于原文
        val joined = out.joinToString("") { (it as MarkdownOps.Span.Text).text }
        assertEquals(boldNoClose, joined)
        val mixed = ("| a | 表格头 |\n---\n" + "长`混`排".repeat(10_000))
        MarkdownOps.parse(mixed)
    }

    @Test
    fun `crlf input tolerated`() {
        val out = MarkdownOps.parse("# 标题\r\n## 二级\r\n正文行\r\n")
        assertEquals(
            listOf(
                MarkdownOps.Block.Heading(1, "标题"),
                MarkdownOps.Block.Heading(2, "二级"),
                MarkdownOps.Block.Paragraph("正文行"),
            ),
            out,
        )
    }

    @Test
    fun `mixed blocks preserve order and content`() {
        val src = "# 标题\n\n导语 **加粗**。\n\n- 要点一\n- 要点二\n\n```\n代码\n```\n\n尾段"
        val blocks = MarkdownOps.parse(src)
        assertEquals(6, blocks.size)
        assertTrue(blocks[0] is MarkdownOps.Block.Heading)
        assertTrue(blocks[1] is MarkdownOps.Block.Paragraph)
        assertEquals(2, blocks.count { it is MarkdownOps.Block.ListItem })
        assertTrue(blocks[4] is MarkdownOps.Block.CodeBlock)
        assertEquals(MarkdownOps.Block.Paragraph("尾段"), blocks[5])
    }
}
