package com.devhub.mobile.ui.screens

import com.devhub.mobile.core.InteractionHonesty
import com.devhub.mobile.data.remote.AgentDto
import com.devhub.mobile.data.remote.CapabilitiesDto
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * UX-P3（docs/briefs/uxp3-flows.md §1.2 funnel）：对话页空态 CTA「去助手开始第一个对话」
 * 一步带入——自动展开面板目标的纯判定锁。
 * - 首个可对话（managed 且非演示）助手即目标；
 * - 无可对话助手 → null（绝不伪造入口，A4 教训）；
 * - 演示模式一律 null（夹具绝不伪造控制通道，红线）。
 */
class AgentsAutoSpawnTargetTest {

    private fun agent(id: Long, mode: String) = AgentDto(
        id = id,
        displayName = "assistant #$id",
        health = "ok",
        capabilities = CapabilitiesDto(mode = mode, granted = emptyList(), verifiedAtSec = 0, evidence = ""),
    )

    @Test
    fun `first managed agent is the target`() {
        val agents = listOf(agent(1, "observed"), agent(2, "managed"), agent(3, "managed"))
        assertEquals(2L, autoSpawnTargetId(agents, fixtureOn = false))
    }

    @Test
    fun `no managed agent returns null`() {
        assertNull(autoSpawnTargetId(listOf(agent(1, "observed"), agent(2, "attached")), fixtureOn = false))
        assertNull(autoSpawnTargetId(emptyList(), fixtureOn = false))
    }

    @Test
    fun `fixture demo mode never targets`() {
        // 演示模式绝不伪造控制通道（红线）；即使投影 managed 也不自动展开
        assertNull(autoSpawnTargetId(listOf(agent(1, "managed")), fixtureOn = true))
    }

    @Test
    fun `spawn button gate stays honest`() {
        // 门语义与 autoSpawnTargetId 同源（canSpawnManagedSession），双锁防漂移
        assertEquals(
            InteractionHonesty.canSpawnManagedSession("managed", false),
            autoSpawnTargetId(listOf(agent(9, "managed")), fixtureOn = false) == 9L,
        )
    }
}
