package com.devhub.mobile.ui.screens

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * UX-P2（docs/24 §3 导航 IA）：main?tab= 旧值兼容映射纯函数锁。
 * 底栏四→三后，旧 tab 值 diagnostics/device（挂载点移入「我的」）必须继续可达
 * （deep link 零破坏红线）；未知值回退 sessions（原 else 分支语义）。
 */
class MainTabsTabPolicyTest {

    @Test
    fun `three tabs map to themselves`() {
        assertEquals("sessions", normalizeTab("sessions"))
        assertEquals("agents", normalizeTab("agents"))
        assertEquals("mine", normalizeTab("mine"))
    }

    @Test
    fun `legacy diagnostics tab maps to mine`() {
        // 状态 chip/诊断页挂载点迁「我的」后，main?tab=diagnostics 旧导航不破
        assertEquals("mine", normalizeTab("diagnostics"))
    }

    @Test
    fun `legacy device tab maps to mine`() {
        // 设备屏挂载点迁「我的」后，main?tab=device 旧导航不破
        assertEquals("mine", normalizeTab("device"))
    }

    @Test
    fun `unknown and null fall back to sessions`() {
        assertEquals("sessions", normalizeTab("remote"))
        assertEquals("sessions", normalizeTab(""))
        assertEquals("sessions", normalizeTab(null))
    }
}
