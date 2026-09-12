package com.devhub.mobile.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.devhub.mobile.core.BubbleSides
import com.devhub.mobile.core.DateGrouping
import com.devhub.mobile.core.MessageSegments
import com.devhub.mobile.core.ProviderPalette
import com.devhub.mobile.data.db.MessageCacheEntity

/** 分段 JSON → core 归一化分段模型（:core MessageSegments；null = 回退整段纯文本）。 */
fun parseSegments(json: String?): List<MessageSegments.Segment>? {
    if (json.isNullOrBlank()) return null
    val raw = runCatching {
        val arr = org.json.JSONArray(json)
        (0 until arr.length()).map {
            val o = arr.getJSONObject(it)
            MessageSegments.RawSegment(
                kind = o.optString("kind"),
                label = o.optString("label").takeIf { l -> l.isNotEmpty() },
                content = o.optString("content"),
            )
        }
    }.getOrNull() ?: return null
    return runCatching { MessageSegments.normalize(raw) }.getOrNull()
}

/** user 侧头像固定色（与 App 主题主色一致的深绿；头像文案固定"我"）。 */
private const val USER_AVATAR_ARGB = 0xFF1B6B3A

/**
 * R11 气泡对话流（微信式）+ R1 思维链折叠 + R8 迷你渲染 + U3 块级 markdown：
 * - role=user → 右侧主色气泡右对齐，头像固定"我"；
 * - role=assistant → 左侧 surfaceVariant 气泡，头像 = R4 色板 provider 首字母（与列表同色）；
 * - system/tool/事件/未识别 role → 居中灰 chip；
 * - 跨天日期分隔线（core.DateGrouping）；时间戳入气泡尾注；
 * - kind='thinking' 默认收起（「💭 思维链 · N 字 ▸」点按展开）；无 segments 回退整段纯文本不回归；
 * - U3（AUDIT P3#1）：文本路径统一走 MarkdownBubbleText——非平凡（标题/表格/列表/代码块）
 *   走 MarkdownOps 块级渲染器，平凡走既有 RichMarkdownText 原路径；解析按消息记忆化。
 */
@Composable
fun MessageBubble(
    message: MessageCacheEntity,
    providerKey: String?,
    providerLabel: String?,
    prevOccurredAtSec: Long?,
    nowSec: Long,
    modifier: Modifier = Modifier,
) {
    val placement = BubbleSides.placementFor(message.role)
    val marker = DateGrouping.markerFor(prevSec = prevOccurredAtSec, curSec = message.occurredAtSec, nowSec = nowSec)
    val separatorLabel = marker.label
    val segments = remember(message.messageId, message.segmentsJson) { parseSegments(message.segmentsJson) }

    Column(modifier = modifier.fillMaxWidth()) {
        if (marker.show && separatorLabel != null) {
            // R11 跨天日期分隔线
            Text(
                text = separatorLabel,
                fontSize = 11.sp,
                fontWeight = FontWeight.Medium,
                color = MaterialTheme.colorScheme.outline,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = 8.dp),
            )
        }

        when (placement) {
            BubbleSides.Placement.RIGHT_PRIMARY -> {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 3.dp),
                    horizontalArrangement = Arrangement.End,
                    verticalAlignment = Alignment.Bottom,
                ) {
                    BubbleBody(
                        message = message,
                        segments = segments,
                        placement = placement,
                        modifier = Modifier.widthIn(max = (LocalConfiguration.current.screenWidthDp * 0.76f).dp),
                    )
                    Spacer(Modifier.width(6.dp))
                    ProviderAvatar(
                        argb = USER_AVATAR_ARGB,
                        initial = ProviderPalette.USER_AVATAR_TEXT,
                        size = 28.dp,
                        fontSize = 12,
                    )
                }
            }

            BubbleSides.Placement.LEFT_VARIANT -> {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 3.dp),
                    verticalAlignment = Alignment.Bottom,
                ) {
                    val spec = ProviderPalette.resolve(providerKey, providerLabel)
                    ProviderAvatar(argb = spec.argb, initial = spec.initial, size = 28.dp, fontSize = 12)
                    Spacer(Modifier.width(6.dp))
                    BubbleBody(
                        message = message,
                        segments = segments,
                        placement = placement,
                        modifier = Modifier.widthIn(max = (LocalConfiguration.current.screenWidthDp * 0.76f).dp),
                    )
                }
            }

            BubbleSides.Placement.CENTER_CHIP -> {
                // system/tool/事件类：居中灰 chip（无头像，不猜语义）
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 4.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Surface(
                        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f),
                        shape = RoundedCornerShape(10.dp),
                        modifier = Modifier.widthIn(max = (LocalConfiguration.current.screenWidthDp * 0.86f).dp),
                    ) {
                        Column(Modifier.padding(horizontal = 10.dp, vertical = 6.dp)) {
                            // 打磨批 D：所有文本展示路径统一过 R8 渲染器（tokenizer）——
                            // system/tool 事件 chip 此前走纯 Text，真实消息里的 `**` 等记号原样露出。
                            // U3（AUDIT P3#1）：升级为块级入口——非平凡（标题/表格/列表/代码块）走
                            // MarkdownOps 渲染器，平凡走既有 RichMarkdownText 原路径零回退。
                            MarkdownBubbleText(
                                memoKey = message.messageId,
                                text = message.contentRedacted,
                                fontSize = 11.sp,
                                baseColor = MaterialTheme.colorScheme.onSurfaceVariant,
                                codeBackground = MaterialTheme.colorScheme.surface,
                                chipBackground = MaterialTheme.colorScheme.secondaryContainer,
                                chipForeground = MaterialTheme.colorScheme.onSecondaryContainer,
                            )
                            message.occurredAtSec?.let {
                                Text(
                                    // 打磨批 D：同屏时间戳统一 "MM-dd HH:mm"（非当日也带日期前缀）
                                    TimeFmt.mdHm(it),
                                    fontSize = 9.sp,
                                    color = MaterialTheme.colorScheme.outline,
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun BubbleBody(
    message: MessageCacheEntity,
    segments: List<MessageSegments.Segment>?,
    placement: BubbleSides.Placement,
    modifier: Modifier = Modifier,
) {
    val isUser = placement == BubbleSides.Placement.RIGHT_PRIMARY
    val bubbleColor = if (isUser) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant
    val contentColor = if (isUser) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant
    // R8 配色：气泡内代码/链接/chip 需与气泡底色可区分
    val codeBg = if (isUser) Color(0x33FFFFFF) else MaterialTheme.colorScheme.surface
    val codeFg = contentColor
    val chipBg = if (isUser) Color(0x26FFFFFF) else MaterialTheme.colorScheme.secondaryContainer
    val chipFg = if (isUser) contentColor else MaterialTheme.colorScheme.onSecondaryContainer
    val linkColor = if (isUser) contentColor else MaterialTheme.colorScheme.primary

    val shape = if (isUser) {
        RoundedCornerShape(topStart = 14.dp, bottomStart = 14.dp, topEnd = 4.dp, bottomEnd = 14.dp)
    } else {
        RoundedCornerShape(topStart = 4.dp, bottomStart = 14.dp, topEnd = 14.dp, bottomEnd = 14.dp)
    }
    Surface(color = bubbleColor, shape = shape, modifier = modifier) {
        Column(Modifier.padding(horizontal = 10.dp, vertical = 7.dp)) {
            if (segments == null) {
                // R1 回退：无 segments → 整段纯文本（R8 mini 渲染仍生效；U3 起含块级渲染）
                MarkdownBubbleText(
                    memoKey = message.messageId,
                    text = message.contentRedacted,
                    fontSize = 13.sp,
                    baseColor = contentColor,
                    codeBackground = codeBg,
                    codeForeground = codeFg,
                    chipBackground = chipBg,
                    chipForeground = chipFg,
                    linkColor = linkColor,
                )
            } else {
                segments.forEachIndexed { idx, segment ->
                    when (segment) {
                        is MessageSegments.Segment.Text -> MarkdownBubbleText(
                            memoKey = message.messageId,
                            text = segment.content,
                            fontSize = 13.sp,
                            baseColor = contentColor,
                            codeBackground = codeBg,
                            codeForeground = codeFg,
                            chipBackground = chipBg,
                            chipForeground = chipFg,
                            linkColor = linkColor,
                            modifier = Modifier.padding(top = if (idx > 0) 4.dp else 0.dp),
                        )

                        is MessageSegments.Segment.Thinking -> ThinkingFold(
                            keyId = message.messageId,
                            content = segment.content,
                            contentColor = contentColor,
                            codeBg = codeBg,
                            codeFg = codeFg,
                        )

                        is MessageSegments.Segment.ToolInvocation -> Column(
                            Modifier
                                .padding(top = if (idx > 0) 4.dp else 0.dp)
                                .background(chipBg, RoundedCornerShape(8.dp))
                                .padding(horizontal = 8.dp, vertical = 5.dp),
                        ) {
                            Text(
                                "🔧 ${segment.label ?: "工具调用"}",
                                fontSize = 11.sp,
                                fontWeight = FontWeight.SemiBold,
                                color = chipFg,
                            )
                            if (segment.content.isNotBlank()) {
                                Text(
                                    segment.content,
                                    fontSize = 10.sp,
                                    fontFamily = FontFamily.Monospace,
                                    color = chipFg,
                                    maxLines = 8,
                                )
                            }
                        }
                    }
                }
            }
            // R11 时间戳入气泡尾注
            message.occurredAtSec?.let {
                Text(
                    TimeFmt.mdHm(it),
                    fontSize = 9.sp,
                    color = contentColor.copy(alpha = 0.65f),
                    modifier = Modifier
                        .align(Alignment.End)
                        .padding(top = 3.dp),
                )
            }
        }
    }
}

/** R1 思维链折叠行：默认收起，点按展开/收起（key 按消息 id，滚出视口后状态保留）。 */
@Composable
private fun ThinkingFold(
    keyId: Long,
    content: String,
    contentColor: Color,
    codeBg: Color,
    codeFg: Color,
) {
    var expanded by rememberSaveable(key = "thinking-fold-$keyId") { mutableStateOf(false) }
    Column(Modifier.padding(top = 3.dp, bottom = 3.dp)) {
        Text(
            text = MessageSegments.thinkingFoldLabel(content) + if (expanded) " ▾" else " ▸",
            fontSize = 12.sp,
            fontWeight = FontWeight.Medium,
            color = contentColor.copy(alpha = 0.9f),
            modifier = Modifier
                .background(codeBg, RoundedCornerShape(8.dp))
                .clickable { expanded = !expanded }
                .padding(horizontal = 8.dp, vertical = 4.dp),
        )
        if (expanded) {
            // 打磨批 D：展开后的思维链原文同样过渲染器（记号不原样露出；失败回退纯文本由渲染器兜底）
            // U3：块级入口 + 按消息记忆化（keyId 即 messageId）
            MarkdownBubbleText(
                memoKey = keyId,
                text = content,
                fontSize = 11.sp,
                baseColor = codeFg.copy(alpha = 0.92f),
                codeBackground = codeBg,
                chipBackground = codeBg,
                chipForeground = codeFg,
                modifier = Modifier
                    .padding(top = 3.dp)
                    .background(codeBg, RoundedCornerShape(8.dp))
                    .padding(8.dp),
            )
        }
    }
}
