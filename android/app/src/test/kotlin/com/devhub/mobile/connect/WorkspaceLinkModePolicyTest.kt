package com.devhub.mobile.connect

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * U5 批（Z3 结论 B 方案①）→ **X-L 批反转**（方案②落地，docs/18 §5.3.2）：
 * T1 遥控卡「连接模式 → 呈现策略」纯判定单测。语义反转有据——本地网关 `command`
 * 帧路由（桌面 ws.ts/localCommand.ts）+ App 本地帧结算（WsFrames/ConnectionManager）
 * 传输面就位后，local 否定门反转为「经本地网关取链」（LocalGatewayFlow 全流转）。
 * 断言只对纯决策，不触网络/DB/连接面。relay 行为逐字节不变的锚点：
 * 非 local 输入（含 null/未知）一律 FullFlow（现状），绝不误伤。
 */
class WorkspaceLinkModePolicyTest {

    // ---- relay / 未知 / 未配置 → 现状全流转（FullFlow）----

    @Test
    fun `relay mode keeps the full existing flow`() {
        assertEquals(
            WorkspaceLinkModePolicy.Presentation.FullFlow,
            WorkspaceLinkModePolicy.presentation(connectionMode = "relay", fixtureMode = false),
        )
    }

    @Test
    fun `unconfigured mode defaults to full flow`() {
        // null = 配置未加载/启动瞬窗：默认开门（现状），绝不因模式未知改变既有行为
        assertEquals(
            WorkspaceLinkModePolicy.Presentation.FullFlow,
            WorkspaceLinkModePolicy.presentation(connectionMode = null, fixtureMode = false),
        )
    }

    @Test
    fun `unknown mode string defaults to full flow`() {
        for (mode in listOf("", "observed", "RELAY", " local", "local2")) {
            assertEquals(
                WorkspaceLinkModePolicy.Presentation.FullFlow,
                WorkspaceLinkModePolicy.presentation(connectionMode = mode, fixtureMode = false),
            )
        }
    }

    // ---- fixture 演示模式 → 现状（任务书三分口径第三支；含 fixture+local 组合）----

    @Test
    fun `fixture demo mode keeps the full flow even on a local config`() {
        assertEquals(
            WorkspaceLinkModePolicy.Presentation.FullFlow,
            WorkspaceLinkModePolicy.presentation(connectionMode = "local", fixtureMode = true),
        )
        assertEquals(
            WorkspaceLinkModePolicy.Presentation.FullFlow,
            WorkspaceLinkModePolicy.presentation(connectionMode = "relay", fixtureMode = true),
        )
        assertEquals(
            WorkspaceLinkModePolicy.Presentation.FullFlow,
            WorkspaceLinkModePolicy.presentation(connectionMode = null, fixtureMode = true),
        )
    }

    // ---- local → LocalGatewayFlow（X-L 反转：经本地网关取链，docs/18 §5.3.2）----

    @Test
    fun `local mode resolves to the local gateway flow (X-L reversal)`() {
        // 反转锚点：U5 时代的 NotAvailableInLocal 否定门随传输面就位退役，
        // local（非 fixture）= 经本地网关命令面取链全流转
        assertEquals(
            WorkspaceLinkModePolicy.Presentation.LocalGatewayFlow,
            WorkspaceLinkModePolicy.presentation(connectionMode = "local", fixtureMode = false),
        )
    }

    // ---- 传输面判定（ConnectionManager.submitWorkspaceLink 单一决策点）----

    @Test
    fun `uses local gateway is true only for unfictured local mode`() {
        assertTrue(WorkspaceLinkModePolicy.usesLocalGateway("local", fixtureMode = false))
        // relay 面 / fixture / 未知模式一律走 relay 现状（relay 路径零变化锁）
        assertFalse(WorkspaceLinkModePolicy.usesLocalGateway("relay", fixtureMode = false))
        assertFalse(WorkspaceLinkModePolicy.usesLocalGateway("local", fixtureMode = true))
        assertFalse(WorkspaceLinkModePolicy.usesLocalGateway(null, fixtureMode = false))
        assertFalse(WorkspaceLinkModePolicy.usesLocalGateway("", fixtureMode = false))
        assertFalse(WorkspaceLinkModePolicy.usesLocalGateway("LOC AL", fixtureMode = false))
    }

    // ---- 模式字面量冻结（GatewayConfigEntity.mode 值域锚点，防误改判定键）----

    @Test
    fun `mode literals stay frozen to the config value domain`() {
        assertEquals("relay", WorkspaceLinkModePolicy.MODE_RELAY)
        assertEquals("local", WorkspaceLinkModePolicy.MODE_LOCAL)
    }

    // ---- 反转记录：U5 否定文案退役（三入口不再出现「本地模式不提供」否定语义）----

    @Test
    fun `u5 negative gate stays retired after the X-L reversal`() {
        // 反转有据（docs/18 §5.3.2）：local 呈现 = 取链流转，与 relay 呈现同为
        // 「取链」语义面——两者差异只在传输面（本地网关 vs relay WS），
        // 任何模式都不再落入「不提供取链」的否定呈现。
        val localPresentation = WorkspaceLinkModePolicy.presentation("local", fixtureMode = false)
        val relayPresentation = WorkspaceLinkModePolicy.presentation("relay", fixtureMode = false)
        assertTrue(localPresentation is WorkspaceLinkModePolicy.Presentation.LocalGatewayFlow)
        assertTrue(relayPresentation is WorkspaceLinkModePolicy.Presentation.FullFlow)
        // 二值呈现均为流转态：呈现层没有（也不该再有）不可用否定分支
        assertTrue(
            localPresentation == WorkspaceLinkModePolicy.Presentation.LocalGatewayFlow ||
                localPresentation == WorkspaceLinkModePolicy.Presentation.FullFlow,
        )
    }

    // ---- 呈现域封闭（旧 NotAvailableInLocal 分支退役回归锁）----

    @Test
    fun `presentation domain is the closed two-value reversal set`() {
        val domain = setOf(
            WorkspaceLinkModePolicy.presentation("relay", fixtureMode = false),
            WorkspaceLinkModePolicy.presentation("local", fixtureMode = false),
            WorkspaceLinkModePolicy.presentation(null, fixtureMode = true),
        )
        assertEquals(2, domain.size)
        assertTrue(domain.contains(WorkspaceLinkModePolicy.Presentation.FullFlow))
        assertTrue(domain.contains(WorkspaceLinkModePolicy.Presentation.LocalGatewayFlow))
    }
}
