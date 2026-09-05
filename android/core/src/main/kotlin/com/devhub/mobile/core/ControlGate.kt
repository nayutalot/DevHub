package com.devhub.mobile.core

/**
 * 会话控制按钮 UI 门（docs/14 §B.1 能力门 / docs/12 §5 授权矩阵）。
 *
 * 显示条件（两条件同时满足，缺一不可）：
 * 1. 服务端 CapabilitySet.mode ≠ observed（且 SessionView.sessionMode ≠ observed 双保险）；
 * 2. 对应 action ∈ CapabilitySet.granted（granted 只含服务端此刻真实验证存在的能力）。
 *
 * 这是第一道门（UI 门）；服务端 L3 能力门/授权矩阵还有二次校验
 * （observed → COMMAND_NOT_EXECUTABLE；能力未验证 → AGENT_CAPABILITY_MISSING），
 * 客户端绝不仅凭按钮可见性假设能力存在。
 */
object ControlGate {
    const val MODE_OBSERVED = "observed"
    const val ACTION_REPLY = "reply"
    const val ACTION_PAUSE = "pause"
    const val ACTION_RESUME = "resume"
    // M2-R3（docs/18 §5.1 / docs/19 §7.3）：approve/interrupt 门控路径——判定源与执行通道
    // 双双真实验证通过前，granted 恒不含二者（默认不授予）→ 按钮恒不显示。UI 门只是第一道，
    // 服务端 L3 能力门二次校验才是合同；客户端绝不仅凭按钮可见性假设能力存在。
    const val ACTION_APPROVE = "approve"
    const val ACTION_INTERRUPT = "interrupt"

    data class CapabilitySnapshot(
        val mode: String,
        val granted: Set<String>,
    )

    data class VisibleControls(
        val reply: Boolean,
        val pause: Boolean,
        val resume: Boolean,
        // R3 门控路径（能力恒空 → 恒 false → 按钮恒不显示；仅数据驱动，绝不硬编码放开）
        val approve: Boolean = false,
        val interrupt: Boolean = false,
    )

    fun visibleControls(caps: CapabilitySnapshot?, sessionMode: String?): VisibleControls {
        if (caps == null) return VisibleControls(reply = false, pause = false, resume = false)
        val modeAllows = caps.mode != MODE_OBSERVED && sessionMode != MODE_OBSERVED
        return VisibleControls(
            reply = modeAllows && ACTION_REPLY in caps.granted,
            pause = modeAllows && ACTION_PAUSE in caps.granted,
            resume = modeAllows && ACTION_RESUME in caps.granted,
            approve = modeAllows && ACTION_APPROVE in caps.granted,
            interrupt = modeAllows && ACTION_INTERRUPT in caps.granted,
        )
    }
}
