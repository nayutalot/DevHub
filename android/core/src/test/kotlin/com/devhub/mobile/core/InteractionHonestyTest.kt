package com.devhub.mobile.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** R6/R7 交互诚实化纯逻辑：spawn 按钮门 + per-provider 原因卡（文案与 known-limitations §1 一致）。 */
class InteractionHonestyTest {

    // —— R6.2/R7.2：启动托管会话按钮可见性 ——

    @Test
    fun `spawn button shows only for managed capability on real gateway`() {
        assertTrue(InteractionHonesty.canSpawnManagedSession(capabilityMode = "managed", fixtureMode = false))
    }

    @Test
    fun `spawn button hidden for observed providers`() {
        assertFalse(InteractionHonesty.canSpawnManagedSession(capabilityMode = "observed", fixtureMode = false))
    }

    @Test
    fun `spawn button hidden when capability mode missing`() {
        assertFalse(InteractionHonesty.canSpawnManagedSession(capabilityMode = null, fixtureMode = false))
        assertFalse(InteractionHonesty.canSpawnManagedSession(capabilityMode = "", fixtureMode = false))
    }

    @Test
    fun `spawn button always hidden in fixture demo mode`() {
        // 夹具模式绝不伪造控制通道（红线）：即使投影 managed 也 false
        assertFalse(InteractionHonesty.canSpawnManagedSession(capabilityMode = "managed", fixtureMode = true))
    }

    @Test
    fun `managed mode constant matches server CapabilitySet value`() {
        assertEquals("managed", InteractionHonesty.MODE_MANAGED)
    }

    // —— R7.1：per-provider 原因卡（providerKey 路径，SessionDetail 用） ——

    @Test
    fun `zcode reason mentions no official control channel`() {
        val r = InteractionHonesty.observedReason("zcode")
        assertTrue(r!!.contains("ZCode"))
        assertTrue(r.contains("控制"))
        assertTrue(r.contains("只能查看"))
    }

    @Test
    fun `claude reason mentions no reliable reply channel`() {
        val r = InteractionHonesty.observedReason("claude-code")
        assertTrue(r!!.contains("Claude"))
        assertTrue(r.contains("回复"))
        assertTrue(r.contains("只能查看"))
    }

    @Test
    fun `kimi reason mentions control capability not yet enabled`() {
        val r = InteractionHonesty.observedReason("kimi")
        assertTrue(r!!.contains("Kimi"))
        assertTrue(r.contains("尚未开通"))
        assertTrue(r.contains("只能查看"))
    }

    @Test
    fun `deepseek reason mentions not integrated`() {
        val r = InteractionHonesty.observedReason("deepseek")
        assertTrue(r!!.contains("DeepSeek"))
        assertTrue(r.contains("还没接入"))
    }

    // —— R7.1：displayName 兜底路径（/v1/agents 投影无 providerKey，Agents 卡用） ——

    @Test
    fun `reason resolves from display names projected by real gateway`() {
        // 真库 display_name 实测值（2026-09-04 快照）：Codex / Claude Code / Kimi Code / ZCode / DeepSeek Harness
        assertEquals(
            InteractionHonesty.observedReason("zcode"),
            InteractionHonesty.observedReason(null, "ZCode"),
        )
        assertEquals(
            InteractionHonesty.observedReason("claude-code"),
            InteractionHonesty.observedReason(null, "Claude Code"),
        )
        assertEquals(
            InteractionHonesty.observedReason("kimi"),
            InteractionHonesty.observedReason(null, "Kimi Code"),
        )
        assertEquals(
            InteractionHonesty.observedReason("deepseek"),
            InteractionHonesty.observedReason(null, "DeepSeek Harness"),
        )
    }

    @Test
    fun `unknown provider returns null so caller falls back to generic note`() {
        assertNull(InteractionHonesty.observedReason(null))
        assertNull(InteractionHonesty.observedReason(null, "Codex")) // codex 是 managed，无 observed 原因卡
        assertNull(InteractionHonesty.observedReason("mystery-agent", "Mystery"))
        assertNull(InteractionHonesty.observedReason("", ""))
    }

    @Test
    fun `provider key match is case and separator insensitive`() {
        assertEquals(InteractionHonesty.observedReason("zcode"), InteractionHonesty.observedReason("ZCode"))
        assertEquals(InteractionHonesty.observedReason("claude-code"), InteractionHonesty.observedReason("ClaudeCode"))
    }

    // —— T1 批：zcode 遥控展示入口可见性（isZcodeDisplayEntry；仅展示入口层，
    // 不碰能力门/服务端语义） ——

    @Test
    fun `zcode display entry matches provider key case insensitively`() {
        assertTrue(InteractionHonesty.isZcodeDisplayEntry("zcode"))
        assertTrue(InteractionHonesty.isZcodeDisplayEntry("ZCode"))
        assertTrue(InteractionHonesty.isZcodeDisplayEntry("ZCODE"))
    }

    @Test
    fun `zcode display entry matches display name for agents projection`() {
        // /v1/agents 投影无 providerKey——真库 display_name 实测值「ZCode」必须命中
        assertTrue(InteractionHonesty.isZcodeDisplayEntry(null, "ZCode"))
        assertTrue(InteractionHonesty.isZcodeDisplayEntry(null, "ZCode CLI"))
        // 双输入任一命中即可
        assertTrue(InteractionHonesty.isZcodeDisplayEntry("zcode", "Something Else"))
    }

    @Test
    fun `zcode display entry rejected for other providers and blanks`() {
        assertFalse(InteractionHonesty.isZcodeDisplayEntry(null))
        assertFalse(InteractionHonesty.isZcodeDisplayEntry(null, "Codex"))
        assertFalse(InteractionHonesty.isZcodeDisplayEntry("claude-code", "Claude Code"))
        assertFalse(InteractionHonesty.isZcodeDisplayEntry("kimi", "Kimi Code"))
        assertFalse(InteractionHonesty.isZcodeDisplayEntry("deepseek", "DeepSeek"))
        assertFalse(InteractionHonesty.isZcodeDisplayEntry("", ""))
    }

    @Test
    fun `zcode display entry copy stays honest about read-only transcript`() {
        // 入口文案诚实纪律（UX-P1 H10-H14 人话化）：仍如实说明「只能看内容」、
        // 操作在 ZCode 侧页面（自家登录页），绝不显示为 DevHub 可控
        assertTrue(InteractionHonesty.ZCODE_REMOTE_DETAIL_NOTE.contains("只能看"))
        assertTrue(InteractionHonesty.ZCODE_REMOTE_DETAIL_NOTE.contains("ZCode"))
        assertTrue(InteractionHonesty.ZCODE_REMOTE_SESSION_BUTTON.contains("ZCode"))
        assertTrue(InteractionHonesty.ZCODE_REMOTE_AGENTS_BUTTON.contains("电脑页面"))
        assertTrue(InteractionHonesty.ZCODE_REMOTE_AGENTS_NOTE.contains("ZCode"))
    }
}
