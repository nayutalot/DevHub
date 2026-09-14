package com.devhub.mobile.core

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * UX-P2（docs/24 §2.1/§3.2 + docs/26 §3.2）：provider 卡 capabilities 二态主显示纯判定锁。
 * 红线（docs/24 §1 #3）：「可以对话/仅查看」两态人话必须与 capabilities.mode 真值一一对应，
 * 绝不把不可用画成可用——managed→可以对话；attached 按 granted 投影归类；
 * observed/空/未知/granted 空→仅查看。
 */
class CapabilityDualityTest {

    @Test
    fun `managed maps to can talk`() {
        assertEquals(
            InteractionHonesty.CapabilityDuality.CAN_TALK,
            InteractionHonesty.capabilityDuality("managed", emptyList()),
        )
        assertEquals(
            InteractionHonesty.CapabilityDuality.CAN_TALK,
            InteractionHonesty.capabilityDuality("managed", listOf("reply", "pause")),
        )
    }

    @Test
    fun `attached with control grant maps to can talk`() {
        // attached 按 granted 投影归类（docs/24 §2.1）：有控制令牌 → 可以对话侧
        assertEquals(
            InteractionHonesty.CapabilityDuality.CAN_TALK,
            InteractionHonesty.capabilityDuality("attached", listOf("reply")),
        )
        assertEquals(
            InteractionHonesty.CapabilityDuality.CAN_TALK,
            InteractionHonesty.capabilityDuality("attached", listOf("approve", "interrupt")),
        )
    }

    @Test
    fun `attached without grant maps to view only`() {
        assertEquals(
            InteractionHonesty.CapabilityDuality.VIEW_ONLY,
            InteractionHonesty.capabilityDuality("attached", emptyList()),
        )
    }

    @Test
    fun `observed maps to view only`() {
        assertEquals(
            InteractionHonesty.CapabilityDuality.VIEW_ONLY,
            InteractionHonesty.capabilityDuality("observed", listOf("reply")),
        )
    }

    @Test
    fun `unknown and missing modes never fake availability`() {
        // 未知/缺省绝不冒充可以对话（诚实纪律）
        assertEquals(
            InteractionHonesty.CapabilityDuality.VIEW_ONLY,
            InteractionHonesty.capabilityDuality(null, listOf("reply")),
        )
        assertEquals(
            InteractionHonesty.CapabilityDuality.VIEW_ONLY,
            InteractionHonesty.capabilityDuality("", emptyList()),
        )
        assertEquals(
            InteractionHonesty.CapabilityDuality.VIEW_ONLY,
            InteractionHonesty.capabilityDuality("weird_mode", listOf("reply")),
        )
    }

    @Test
    fun `duality labels match glossary`() {
        // 词表终稿（docs/24 §2.1）；attached 译名「电脑上接入」只进 ⓘ 弹层（ModeBadge/详情），不在二态主显示
        assertEquals("可以对话", InteractionHonesty.DUALITY_CAN_TALK_LABEL)
        assertEquals("仅查看", InteractionHonesty.DUALITY_VIEW_ONLY_LABEL)
    }
}
