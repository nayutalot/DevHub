package com.devhub.mobile.connect

/**
 * U5 批（Z3 结论 B 方案①）→ **X-L 批反转**（方案②落地，docs/18 §5.3.2；docs/briefs/
 * xl-local-cmd.md）：T1「ZCode 工作区」遥控卡「连接模式 → 呈现策略」纯判定（:app 单测直锁）。
 *
 * 反转依据（docs/18 §5.3.2 传输面就位）：本地网关 ws.ts 已路由 `command` 帧（U4 实证的
 * 静默忽略消除）→ App 本地帧解析器结算 command_ack/command_result → 本地模式经本地网关
 * 取链全流转。原「本地模式不提供 ZCode 遥控取链」否定门随真实传输面就位而**反转**：
 * local → LocalGatewayFlow（经本地网关取链；失败结构化如实投影，本地零排队面）。
 *
 * **relay 模式逐字节不变**：FullFlow 分支 = 现状全流转（自动取链/Queued→Ready 流转/
 * U1-M4 分层文案/U2-M2 重试全保持，既有单测锁定处逐一核对）；fixture 演示模式同样
 * 走现状（任务书三分口径；fixture 恒 FullFlow——演示数据语义保持）。未知/未配置
 * （null，含启动瞬窗）→ 现状（默认开门），绝不因模式未知而改变既有 relay 行为。
 */
object WorkspaceLinkModePolicy {

    /** 连接模式字面量（GatewayConfigEntity.mode 值域：local（默认）/ relay）。 */
    const val MODE_RELAY = "relay"
    const val MODE_LOCAL = "local"

    /** T1 卡呈现策略（二值：现状全流转 / 本地网关全流转——X-L 反转后均为「取链」）。 */
    sealed interface Presentation {
        /** relay / fixture 演示 / 未配置 → 现状全流转（relay WS 命令面，逐字节不变）。 */
        data object FullFlow : Presentation

        /**
         * local → 经本地网关取链（X-L 反转，docs/18 §5.3.2）：本地 WS command 命令面
         * 全流转；失败 = 结构化如实投影（TIMEOUT/NOT_CONNECTED/ZCODE_LINK_UNAVAILABLE），
         * 本地零排队面——绝不渲染排队/等待承诺。
         */
        data object LocalGatewayFlow : Presentation
    }

    /**
     * 模式判定（纯函数）：fixture 演示优先（现状，任务书三分口径第三支）；
     * local → LocalGatewayFlow（X-L 反转）；relay/null/未知 → 现状全流转。
     */
    fun presentation(connectionMode: String?, fixtureMode: Boolean): Presentation = when {
        fixtureMode -> Presentation.FullFlow
        connectionMode == MODE_LOCAL -> Presentation.LocalGatewayFlow
        else -> Presentation.FullFlow
    }

    /**
     * 传输面判定（纯函数；ConnectionManager.submitWorkspaceLink 的单一决策点）：
     * 仅「非 fixture 演示的 local」走本地网关命令面；其余一律 relay 面现状（逐字节不变）。
     */
    fun usesLocalGateway(connectionMode: String?, fixtureMode: Boolean): Boolean =
        presentation(connectionMode, fixtureMode) is Presentation.LocalGatewayFlow
}
