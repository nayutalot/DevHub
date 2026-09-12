package com.devhub.mobile.connect

import com.devhub.mobile.core.InteractionHonesty
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * U5 批（Z3 结论 B 方案①）：T1 遥控卡「连接模式 → 呈现策略」纯判定单测
 * （docs/briefs/u5-local-honest.md §1 #1 三分口径）。
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

    // ---- local → NotAvailableInLocal 诚实态 ----

    @Test
    fun `local mode resolves to not-available-in-local`() {
        assertEquals(
            WorkspaceLinkModePolicy.Presentation.NotAvailableInLocal,
            WorkspaceLinkModePolicy.presentation(connectionMode = "local", fixtureMode = false),
        )
    }

    // ---- 模式字面量冻结（GatewayConfigEntity.mode 值域锚点，防误改判定键）----

    @Test
    fun `mode literals stay frozen to the config value domain`() {
        assertEquals("relay", WorkspaceLinkModePolicy.MODE_RELAY)
        assertEquals("local", WorkspaceLinkModePolicy.MODE_LOCAL)
    }

    // ---- 诚实文案：三入口统一、不提供+出路双要素、绝不伪装等待/失败 ----

    @Test
    fun `honest copy states non-provision with the relay way out`() {
        val copy = InteractionHonesty.ZCODE_REMOTE_LOCAL_UNAVAILABLE
        assertEquals(WorkspaceLinkModePolicy.LOCAL_UNAVAILABLE_COPY, copy)
        // 不提供
        assertTrue(copy.contains("本地模式不提供"))
        assertTrue(copy.contains("ZCode 遥控取链"))
        // 出路（Relay 接入）
        assertTrue(copy.contains("Relay"))
        // 绝不渲染成假等待/假失败语义
        assertTrue(!copy.contains("排队") && !copy.contains("重试") && !copy.contains("失败"))
    }
}
