package com.devhub.mobile.ui.components

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.TextUnit
import com.devhub.mobile.core.RichTextTokenizer

/**
 * R8 迷你渲染器（纯 Compose AnnotatedString；**禁止 WebView/HTML**）：
 * - 行内/块级代码：等宽字体 + 底色；
 * - markdown 链接：只显示 label（主色下划线）；
 * - plugin/skill/mcp 引用：chip 样式短标签（底色 + 强调字重）；
 * - 转义符已被 tokenizer 清理；tokenize 失败回退纯文本（内容零丢失）。
 *
 * 配色由调用方按气泡底色传入（user 主色气泡内用半透明浅色 / assistant 用 surface 系）。
 */
@Composable
fun RichMarkdownText(
    text: String,
    modifier: Modifier = Modifier,
    fontSize: TextUnit = TextUnit.Unspecified,
    baseColor: Color = Color.Unspecified,
    codeBackground: Color = MaterialTheme.colorScheme.surfaceVariant,
    codeForeground: Color = MaterialTheme.colorScheme.onSurface,
    chipBackground: Color = MaterialTheme.colorScheme.secondaryContainer,
    chipForeground: Color = MaterialTheme.colorScheme.onSecondaryContainer,
    linkColor: Color = MaterialTheme.colorScheme.primary,
    onTextLayout: (TextLayoutResult) -> Unit = {},
) {
    val tokens = remember(text) { runCatching { RichTextTokenizer.tokenize(text) }.getOrNull() }
    if (tokens == null) {
        // 渲染失败回退纯文本（红线：失败回退，内容不丢）
        Text(text = text, modifier = modifier, fontSize = fontSize, color = baseColor, onTextLayout = onTextLayout)
        return
    }
    val annotated: AnnotatedString = remember(
        text, codeBackground, codeForeground, chipBackground, chipForeground, linkColor,
    ) {
        buildAnnotatedString {
            for (t in tokens) {
                when (t) {
                    is RichTextTokenizer.RichToken.Plain -> append(t.text)

                    is RichTextTokenizer.RichToken.CodeSpan -> withStyle(
                        SpanStyle(fontFamily = FontFamily.Monospace, background = codeBackground, color = codeForeground),
                    ) { append(t.code) }

                    is RichTextTokenizer.RichToken.CodeBlock -> {
                        append("\n")
                        withStyle(
                            SpanStyle(fontFamily = FontFamily.Monospace, background = codeBackground, color = codeForeground),
                        ) { append(t.code.trimEnd('\n')) }
                        append("\n")
                    }

                    is RichTextTokenizer.RichToken.Link -> withStyle(
                        SpanStyle(color = linkColor, textDecoration = TextDecoration.Underline),
                    ) { append(t.label) }

                    is RichTextTokenizer.RichToken.ReferenceChip -> {
                        append(" ")
                        withStyle(
                            SpanStyle(
                                background = chipBackground,
                                color = chipForeground,
                                fontWeight = FontWeight.SemiBold,
                            ),
                        ) { append(t.display) }
                        append(" ")
                    }
                }
            }
        }
    }
    Text(
        text = annotated,
        modifier = modifier,
        fontSize = fontSize,
        color = baseColor,
        style = TextStyle.Default,
        onTextLayout = onTextLayout,
    )
}
