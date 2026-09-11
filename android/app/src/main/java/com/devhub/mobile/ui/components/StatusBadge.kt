package com.devhub.mobile.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * 会话 9 值状态徽章（docs/12 §4：对外展示用户锁定 7 态 + stopped/unknown 辅助态透明展示）。
 * waiting_input（等文本输入）与 approval_required（等工具批准）高亮区分（docs/11 D3）。
 */
object StatusColors {
    private data class Spec(val label: String, val bg: Color, val fg: Color, val highlight: Boolean = false)

    private val specs = mapOf(
        "running" to Spec("运行中", Color(0xFFDDEBDD), Color(0xFF1B5E20)),
        "completed" to Spec("已完成", Color(0xFFE0E0E0), Color(0xFF37474F)),
        "failed" to Spec("已失败", Color(0xFFFFCDD2), Color(0xFFB71C1C)),
        "waiting_input" to Spec("等待输入", Color(0xFFFFE082), Color(0xFF7A4F00), highlight = true),
        "approval_required" to Spec("等待批准", Color(0xFFFFAB91), Color(0xFF7A2400), highlight = true),
        "paused" to Spec("已暂停", Color(0xFFE1BEE7), Color(0xFF4A148C)),
        "connection_lost" to Spec("连接丢失", Color(0xFFFFCDD2), Color(0xFF8B0000)),
        "stopped" to Spec("已停止", Color(0xFFECEFF1), Color(0xFF455A64)),
        "unknown" to Spec("未知", Color(0xFFF5F5F5), Color(0xFF757575)),
    )

    fun label(status: String): String = (specs[status] ?: Spec(status, Color(0xFFF5F5F5), Color(0xFF757575))).label

    fun highlight(status: String): Boolean = specs[status]?.highlight == true

    fun background(status: String): Color = (specs[status] ?: specs["unknown"]!!).bg

    fun foreground(status: String): Color = (specs[status] ?: specs["unknown"]!!).fg
}

/**
 * 会话 9 值状态徽章（docs/12 §4：对外展示用户锁定 7 态 + stopped/unknown 辅助态透明展示）。
 * waiting_input（等文本输入）与 approval_required（等工具批准）高亮区分（docs/11 D3）。
 *
 * U1-M2（AUDIT P1#2）：observed 会话的 waiting_input 徽章加锁定语义
 * （「等待输入 · 只读」）——observed 详情页零控件，原徽章 = 假可供性；
 * sessionMode/capsMode 传入时经 InteractionHonesty.waitingInputBadge 纯判定替换。
 */
@Composable
fun StatusBadge(
    status: String,
    modifier: Modifier = Modifier,
    sessionMode: String? = null,
    capsMode: String? = null,
) {
    val honestLabel = com.devhub.mobile.core.InteractionHonesty
        .waitingInputBadge(status, sessionMode, capsMode)
    Text(
        text = honestLabel ?: StatusColors.label(status),
        color = StatusColors.foreground(status),
        fontSize = 12.sp,
        fontWeight = if (StatusColors.highlight(status)) FontWeight.Bold else FontWeight.Medium,
        modifier = modifier
            .background(StatusColors.background(status), RoundedCornerShape(6.dp))
            .padding(horizontal = 8.dp, vertical = 3.dp),
    )
}

/** provider 健康四态徽章（ok / degraded / unavailable / unknown）。 */
@Composable
fun HealthBadge(health: String, modifier: Modifier = Modifier) {
    val (bg, fg, label) = when (health) {
        "ok" -> Triple(Color(0xFFDDEBDD), Color(0xFF1B5E20), "健康")
        "degraded" -> Triple(Color(0xFFFFECB3), Color(0xFF8D6E00), "降级")
        "unavailable" -> Triple(Color(0xFFFFCDD2), Color(0xFFB71C1C), "不可用")
        else -> Triple(Color(0xFFF5F5F5), Color(0xFF757575), "未知")
    }
    Text(
        text = label,
        color = fg,
        fontSize = 12.sp,
        modifier = modifier.background(bg, RoundedCornerShape(6.dp)).padding(horizontal = 8.dp, vertical = 3.dp),
    )
}

/** 接入深度徽章（managed / attached / observed；observed = 纯观察全禁控制）。 */
@Composable
fun ModeBadge(mode: String, modifier: Modifier = Modifier) {
    val (bg, fg, label) = when (mode) {
        "managed" -> Triple(Color(0xFFC8E6C9), Color(0xFF1B5E20), "managed")
        "attached" -> Triple(Color(0xFFBBDEFB), Color(0xFF0D47A1), "attached")
        else -> Triple(Color(0xFFFFF3E0), Color(0xFF7A4F00), "observed 只读")
    }
    Text(
        text = label,
        color = fg,
        fontSize = 12.sp,
        modifier = modifier.background(bg, RoundedCornerShape(6.dp)).padding(horizontal = 8.dp, vertical = 3.dp),
    )
}
