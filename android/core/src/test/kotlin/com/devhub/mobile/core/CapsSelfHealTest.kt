package com.devhub.mobile.core

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * DM2 批（docs/briefs/dm2-capsws.md §1）：caps 过期自愈纯逻辑直锁。
 *
 * 锁两面（任务书红线）：
 * 1. 触发码族——仅 caps 过期族（AGENT_CAPABILITY_MISSING）触发自愈；非 caps 过期族
 *    拒绝（指令族/过期族/鉴权族/负载族等）绝不触发；
 * 2. 一次性语义——自愈重探+重发至多一次（one-shot），绝不循环风暴；非 caps 族拒绝
 *    不消费一次性机会。
 * 另锁新鲜度门（绝不伪造能力：verifiedAt 缺失/时钟倒挂/超窗一律不重发）。
 */
class CapsSelfHealTest {

    // —— 触发码族 ——

    @Test
    fun `caps expiry family code triggers self heal`() {
        assertTrue(CapsSelfHeal.isCapsExpiryRejection("AGENT_CAPABILITY_MISSING"))
    }

    @Test
    fun `non caps rejection codes never trigger self heal`() {
        // ErrorPresent/桌面能力门的既有拒绝码族逐一反锁（run6 缺陷面之外零扩散）
        for (code in listOf(
            "COMMAND_NOT_EXECUTABLE",
            "COMMAND_EXPIRED",
            "COMMAND_REJECTED",
            "NOT_FOUND",
            "BAD_PAYLOAD",
            "AUTH_INVALID_TOKEN",
            "DEVICE_REVOKED",
            "GATEWAY_NOT_READY",
            "ZCODE_LINK_UNAVAILABLE",
            "AGENT_PROVIDER_UNAVAILABLE",
            "",
        )) {
            assertFalse("code=$code must not trigger self heal", CapsSelfHeal.isCapsExpiryRejection(code))
        }
    }

    // —— 一次性语义 ——

    @Test
    fun `one shot fires exactly once for caps expiry rejection`() {
        val heal = CapsSelfHeal.OneShot()
        assertTrue(heal.shouldRetry("AGENT_CAPABILITY_MISSING"))
        // 消费后：重试仍拒（同码）→ 绝不二次自愈（one-shot，绝不循环风暴）
        assertFalse(heal.shouldRetry("AGENT_CAPABILITY_MISSING"))
        assertFalse(heal.shouldRetry("AGENT_CAPABILITY_MISSING"))
    }

    @Test
    fun `non caps rejection neither triggers nor consumes the one shot`() {
        val heal = CapsSelfHeal.OneShot()
        assertFalse(heal.shouldRetry("COMMAND_NOT_EXECUTABLE"))
        assertFalse(heal.shouldRetry("COMMAND_EXPIRED"))
        // 非 caps 族拒绝未消费机会：后续真实 caps 过期仍可自愈一次
        assertTrue(heal.shouldRetry("AGENT_CAPABILITY_MISSING"))
        // 自愈后重试再拒（无论何码）→ 恒不再自愈
        assertFalse(heal.shouldRetry("AGENT_CAPABILITY_MISSING"))
        assertFalse(heal.shouldRetry("COMMAND_NOT_EXECUTABLE"))
    }

    // —— 新鲜度门（重发前置；以桌面真实探测结果为准，绝不伪造） ——

    @Test
    fun `fresh verifiedAt within window allows resend`() {
        val now = 1_800_000_000L
        assertTrue(CapsSelfHeal.capsFreshNow(now - 10, now))
        assertTrue(CapsSelfHeal.capsFreshNow(now, now)) // 边界：刚验证完
        assertTrue(CapsSelfHeal.capsFreshNow(now - CapsSelfHeal.CAPS_FRESH_TTL_SEC, now)) // 边界：恰满窗
    }

    @Test
    fun `missing stale or clock skewed verifiedAt never allows resend`() {
        val now = 1_800_000_000L
        assertFalse(CapsSelfHeal.capsFreshNow(0, now)) // 未验证过（绝不伪造能力）
        assertFalse(CapsSelfHeal.capsFreshNow(now - CapsSelfHeal.CAPS_FRESH_TTL_SEC - 1, now)) // 超窗（>300s）
        assertFalse(CapsSelfHeal.capsFreshNow(now + 1, now)) // 时钟倒挂（未来 verifiedAt）→ 不新鲜
        assertFalse(CapsSelfHeal.capsFreshNow(-5, now)) // 异常负值
    }
}
