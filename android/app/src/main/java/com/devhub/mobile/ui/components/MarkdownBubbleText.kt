package com.devhub.mobile.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.devhub.mobile.core.MarkdownOps

/**
 * U3 批（AUDIT P3#1）气泡 markdown 块级渲染入口：
 * - 解析结果非平凡（含标题/表格/列表/代码块任一）→ 本渲染器逐块渲染；
 *   平凡纯文本（仅段落）→ 走既有 [RichMarkdownText] 原路径（行内链接/chip 能力不变，性能零回退）；
 * - 标题 = 既有排版缩阶（16/15/14/13sp SemiBold，随级别递减）；
 *   加粗/斜体 = AnnotatedString span；行内 code = 与 RichMarkdownText 同款等宽底色芯片样式；
 *   表格 = 列宽按内容自适应（[markdownTableColumnUnits] 启发式）、横向可滚动、行分隔线；
 *   代码块 = 等宽字体整块背景（内容逐字符原样，不改内容）；
 * - 解析按单条消息记忆化：remember(messageId, content)，重组合/滚动不重解析；LazyColumn 结构零动；
 * - 红线：渲染不改内容；解析异常/空结果一律回退 [RichMarkdownText] 原文渲染，绝不空白。
 */
@Composable
fun MarkdownBubbleText(
    memoKey: Any?,
    text: String,
    modifier: Modifier = Modifier,
    fontSize: TextUnit = TextUnit.Unspecified,
    baseColor: Color = Color.Unspecified,
    codeBackground: Color = MaterialTheme.colorScheme.surfaceVariant,
    codeForeground: Color = MaterialTheme.colorScheme.onSurface,
    chipBackground: Color = MaterialTheme.colorScheme.secondaryContainer,
    chipForeground: Color = MaterialTheme.colorScheme.onSecondaryContainer,
    linkColor: Color = MaterialTheme.colorScheme.primary,
) {
    val blocks = remember(memoKey, text) { runCatching { MarkdownOps.parse(text) }.getOrNull() }
    if (blocks == null || blocks.isEmpty() || MarkdownOps.isTrivial(blocks)) {
        // 平凡/失败回退：既有原路径（tokenize 失败再回退纯 Text，双保险内容零丢失）
        RichMarkdownText(
            text = text,
            modifier = modifier,
            fontSize = fontSize,
            baseColor = baseColor,
            codeBackground = codeBackground,
            codeForeground = codeForeground,
            chipBackground = chipBackground,
            chipForeground = chipForeground,
            linkColor = linkColor,
        )
        return
    }
    Column(modifier) {
        blocks.forEachIndexed { idx, block ->
            Box(Modifier.padding(top = if (idx > 0) 5.dp else 0.dp)) {
                MarkdownBlockView(
                    block = block,
                    fontSize = fontSize,
                    baseColor = baseColor,
                    codeBackground = codeBackground,
                    codeForeground = codeForeground,
                )
            }
        }
    }
}

@Composable
private fun MarkdownBlockView(
    block: MarkdownOps.Block,
    fontSize: TextUnit,
    baseColor: Color,
    codeBackground: Color,
    codeForeground: Color,
) {
    when (block) {
        is MarkdownOps.Block.Heading -> Text(
            text = markdownAnnotated(block.text, codeBackground, codeForeground),
            fontSize = headingFontSize(block.level),
            fontWeight = FontWeight.SemiBold,
            color = baseColor,
            style = TextStyle.Default,
        )

        is MarkdownOps.Block.Paragraph -> Text(
            text = markdownAnnotated(block.text, codeBackground, codeForeground),
            fontSize = fontSize,
            color = baseColor,
            style = TextStyle.Default,
        )

        is MarkdownOps.Block.ListItem -> Row(verticalAlignment = Alignment.Top) {
            Text(
                text = if (block.ordered) "${block.number ?: ""}. " else "• ",
                fontSize = fontSize,
                color = baseColor,
                style = TextStyle.Default,
            )
            Text(
                text = markdownAnnotated(block.text, codeBackground, codeForeground),
                fontSize = fontSize,
                color = baseColor,
                style = TextStyle.Default,
            )
        }

        is MarkdownOps.Block.Table -> MarkdownTableView(block, baseColor, codeBackground, codeForeground)

        is MarkdownOps.Block.CodeBlock -> Text(
            text = block.code,
            fontFamily = FontFamily.Monospace,
            fontSize = 11.sp,
            color = codeForeground,
            modifier = Modifier
                .fillMaxWidth()
                .background(codeBackground, RoundedCornerShape(8.dp))
                .padding(horizontal = 8.dp, vertical = 6.dp),
        )
    }
}

/** 标题缩阶：气泡 13sp 正文基准下按级别 16/15/14/13sp 递减（既有排版体系内取档）。 */
private fun headingFontSize(level: Int): TextUnit = when (level) {
    1 -> 16.sp
    2 -> 15.sp
    3 -> 14.sp
    else -> 13.sp
}

/** 行内 span → AnnotatedString：加粗/斜体为 span，行内 code 与 RichMarkdownText 芯片同款样式。 */
@Composable
private fun markdownAnnotated(text: String, codeBackground: Color, codeForeground: Color): AnnotatedString {
    val codeStyle = SpanStyle(fontFamily = FontFamily.Monospace, background = codeBackground, color = codeForeground)
    return remember(text, codeStyle) {
        buildAnnotatedString {
            val spans = runCatching { MarkdownOps.parseInline(text) }.getOrNull()
            if (spans == null) {
                append(text) // 兜底：解析异常 → 原文（绝不空白）
            } else {
                appendSpans(spans, codeStyle)
            }
        }
    }
}

private fun AnnotatedString.Builder.appendSpans(spans: List<MarkdownOps.Span>, codeStyle: SpanStyle) {
    for (s in spans) {
        when (s) {
            is MarkdownOps.Span.Text -> append(s.text)
            is MarkdownOps.Span.Bold -> {
                pushStyle(SpanStyle(fontWeight = FontWeight.Bold))
                appendSpans(s.spans, codeStyle)
                pop()
            }
            is MarkdownOps.Span.Code -> {
                pushStyle(codeStyle)
                append(s.code)
                pop()
            }
            is MarkdownOps.Span.Italic -> {
                pushStyle(SpanStyle(fontStyle = FontStyle.Italic))
                append(s.text)
                pop()
            }
        }
    }
}

/** 表格：横向滚动 + 等列宽行列表 + 行分隔线；单元格行内记号照常渲染。 */
@Composable
private fun MarkdownTableView(
    table: MarkdownOps.Block.Table,
    baseColor: Color,
    codeBackground: Color,
    codeForeground: Color,
) {
    val colWidths = remember(table) {
        markdownTableColumnUnits(table.header, table.rows).map { (it * 5 + 10).dp } // 内容自适应 + 单元格左右留白
    }
    val totalWidth = colWidths.fold(0.dp) { acc, w -> acc + w }
    Box(Modifier.horizontalScroll(rememberScrollState())) {
        Column(Modifier.width(totalWidth)) {
            Row(Modifier.fillMaxWidth()) {
                table.header.forEachIndexed { c, cell ->
                    Text(
                        text = markdownAnnotated(cell, codeBackground, codeForeground),
                        fontSize = 11.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = baseColor,
                        style = TextStyle.Default,
                        modifier = Modifier.width(colWidths[c]).padding(4.dp),
                    )
                }
            }
            HorizontalDivider(color = baseColor.copy(alpha = 0.35f))
            table.rows.forEachIndexed { r, row ->
                Row(Modifier.fillMaxWidth()) {
                    row.forEachIndexed { c, cell ->
                        Text(
                            text = markdownAnnotated(cell, codeBackground, codeForeground),
                            fontSize = 11.sp,
                            color = baseColor,
                            style = TextStyle.Default,
                            modifier = Modifier.width(colWidths[c]).padding(4.dp),
                        )
                    }
                }
                if (r < table.rows.lastIndex) {
                    HorizontalDivider(color = baseColor.copy(alpha = 0.15f))
                }
            }
        }
    }
}

/**
 * 表格列宽启发式（纯函数，可单测）：按单元格显示宽度单位取列最大值。
 * CJK/全角（> U+2E7F）记 2 单位、其余记 1；夹在 [4, 32] 单位（约 30~170dp），
 * 超宽列横向滚动兜底。绝不依赖渲染环境，确定性输出。
 */
internal fun markdownTableColumnUnits(header: List<String>, rows: List<List<String>>): List<Int> =
    (0 until header.size).map { c ->
        var maxUnits = 4
        header.getOrElse(c) { "" }.let { maxUnits = maxOf(maxUnits, markdownCellUnits(it)) }
        for (row in rows) {
            row.getOrElse(c) { "" }.let { maxUnits = maxOf(maxUnits, markdownCellUnits(it)) }
        }
        maxUnits.coerceAtMost(32)
    }

private fun markdownCellUnits(cell: String): Int =
    cell.sumOf { ch -> if (ch.code > 0x2E7F) 2 else 1 }.coerceAtMost(80)
