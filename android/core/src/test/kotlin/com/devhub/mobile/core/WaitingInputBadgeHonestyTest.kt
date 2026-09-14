package com.devhub.mobile.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * U1-M2（AUDIT P1#2）：observed 会话「等待输入」假可供性修复——徽章锁定语义纯判定直锁。
 * 证据：05-sessions-list.png（#766 黄框高亮+等待输入）vs 06-session-detail-top.png
 * （详情零控件）——列表召唤输入、详情无输入途径。
 */
class WaitingInputBadgeHonestyTest {

    @Test
    fun `observed waiting_input is relabeled with read-only lock semantics`() {
        assertEquals(
            "等电脑回复 · 本机只读",
            InteractionHonesty.waitingInputBadge(
                status = "waiting_input",
                sessionMode = "observed",
                capsMode = "observed",
            ),
        )
    }

    @Test
    fun `session mode observed alone is sufficient`() {
        assertEquals(
            "等电脑回复 · 本机只读",
            InteractionHonesty.waitingInputBadge(
                status = "waiting_input",
                sessionMode = "observed",
                capsMode = null,
            ),
        )
        // caps 单门命中（与 SessionDetail observed 原因卡同口径）
        assertEquals(
            "等电脑回复 · 本机只读",
            InteractionHonesty.waitingInputBadge(
                status = "waiting_input",
                sessionMode = "attached",
                capsMode = "observed",
            ),
        )
    }

    @Test
    fun `managed and attached keep the plain waiting label`() {
        // 绝不把可交互面误标只读（诚实纪律：只收紧，绝不误伤）
        assertNull(
            InteractionHonesty.waitingInputBadge("waiting_input", "managed", "managed"),
        )
        assertNull(
            InteractionHonesty.waitingInputBadge("waiting_input", "attached", null),
        )
        assertNull(
            InteractionHonesty.waitingInputBadge("waiting_input", null, null),
        )
    }

    @Test
    fun `non waiting statuses are never relabeled`() {
        for (status in listOf("running", "completed", "failed", "approval_required", "paused", "unknown")) {
            assertNull(
                "status=$status 不应被改写",
                InteractionHonesty.waitingInputBadge(status, "observed", "observed"),
            )
        }
    }
}
