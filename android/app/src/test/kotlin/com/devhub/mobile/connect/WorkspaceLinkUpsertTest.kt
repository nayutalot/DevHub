package com.devhub.mobile.connect

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * T1 批：智能条目 find-or-create 纯决策单测（任务书 §1.6）——
 * 固定保留标题「ZCode 工作区」零重复行契约（有行只更新 / 无行才插入）。
 * 执行面（Room DAO IO 在 WorkspaceLinkController.upsertEntry）不在此测。
 */
class WorkspaceLinkUpsertTest {

    @Test
    fun `reserved entry title stays stable as the smart entry key`() {
        // 定位键冻结：改名会碎掉 find（旧行永久孤儿 + 每次请求堆新行）
        assertEquals("ZCode 工作区", WorkspaceLinkCard.ENTRY_TITLE)
    }

    @Test
    fun `existing row plans an update keeping its id`() {
        val plan = WorkspaceLinkCard.planUpsert(existingId = 42, url = "https://zcode.example/remote/v4?t=next", nowMs = 1000)
        assertEquals(WorkspaceLinkCard.EntryUpsertPlan.UpdateExisting(42), plan)
    }

    @Test
    fun `missing row plans an insert with the reserved title`() {
        val plan = WorkspaceLinkCard.planUpsert(existingId = null, url = "https://zcode.example/remote/v4?t=fresh", nowMs = 2000)
        assertEquals(
            WorkspaceLinkCard.EntryUpsertPlan.InsertNew(
                title = WorkspaceLinkCard.ENTRY_TITLE,
                url = "https://zcode.example/remote/v4?t=fresh",
                createdAtMs = 2000,
            ),
            plan,
        )
    }

    @Test
    fun `zero id counts as missing and plans an insert`() {
        // DAO getByTitle 未命中返回 null；id=0 非法形态同样走插入兜底（绝不 update(id=0)）
        val plan = WorkspaceLinkCard.planUpsert(existingId = 0, url = "https://zcode.example/r", nowMs = 1)
        assertTrue(plan is WorkspaceLinkCard.EntryUpsertPlan.InsertNew)
    }
}
