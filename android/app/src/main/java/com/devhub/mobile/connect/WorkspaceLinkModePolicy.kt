package com.devhub.mobile.connect

/**
 * U5 批（Z3 结论 B 主控裁决方案①；docs/briefs/u5-local-honest.md §1 #1）：
 * T1「ZCode 工作区」遥控卡「连接模式 → 呈现策略」纯判定（:app 单测直锁）。
 *
 * 事实基线（Z3 侦察 REPORT.md 项2）：本地模式结构性永远 Queued——App 本地帧解析器
 * 无 command 结算概念（ConnectionManager.kt :486/:531/:584、WsFrames.kt:35-58）+
 * 本地网关 ws.ts 对 workspace_link 帧静默忽略，取链帧永无 command_ack/command_result
 * 回程 → 10s 超时 → 幂等键入队 → 恒 Queued。闭环需双端成对改 + docs/14 协议扩展，
 * 为纯开发场景（本地模式=模拟器/同机专用，真机物理不可达 127.0.0.1）不值当。
 * 裁决 = App 侧诚实文案：本地模式不发起取链、卡显「本地模式不提供 ZCode 遥控取链」。
 *
 * **relay 模式逐字节不变**：FullFlow 分支 = 现状全流转（自动取链/Queued→Ready 流转/
 * U1-M4 分层文案/U2-M2 重试全保持，既有单测锁定处逐一核对）；fixture 演示模式同样
 * 走现状（任务书 §1 #1 三分口径）。未知/未配置（null，含启动瞬窗）→ 现状（默认开门），
 * 绝不因模式未知而改变既有 relay 行为。
 */
object WorkspaceLinkModePolicy {

    /** 连接模式字面量（GatewayConfigEntity.mode 值域：local（默认）/ relay）。 */
    const val MODE_RELAY = "relay"
    const val MODE_LOCAL = "local"

    /** 三入口统一诚实文案（:core InteractionHonesty 文案族同源，此处别名引用）。 */
    val LOCAL_UNAVAILABLE_COPY: String = com.devhub.mobile.core.InteractionHonesty.ZCODE_REMOTE_LOCAL_UNAVAILABLE

    /** T1 卡呈现策略（二值：现状全流转 / 本地诚实态）。 */
    sealed interface Presentation {
        /** relay / fixture 演示 / 未配置 → 现状全流转（取链、Queued→Ready、重试全保持）。 */
        data object FullFlow : Presentation

        /** local → NotAvailableInLocal 态（不自动取链、点击不发起请求、不渲染排队/重试）。 */
        data object NotAvailableInLocal : Presentation
    }

    /**
     * 模式判定（纯函数）：fixture 演示优先（现状，任务书三分口径第三支）；
     * local → NotAvailableInLocal；relay/null/未知 → 现状全流转。
     */
    fun presentation(connectionMode: String?, fixtureMode: Boolean): Presentation = when {
        fixtureMode -> Presentation.FullFlow
        connectionMode == MODE_LOCAL -> Presentation.NotAvailableInLocal
        else -> Presentation.FullFlow
    }
}
