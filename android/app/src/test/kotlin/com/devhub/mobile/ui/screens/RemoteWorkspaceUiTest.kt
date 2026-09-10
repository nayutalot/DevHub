package com.devhub.mobile.ui.screens

import com.devhub.mobile.data.db.RemoteWorkspaceEntryEntity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Q 批「远程工作区」列表派生状态单测（任务书 §2.2：条目排序/空态）。
 * 排序单一真相在 RemoteWorkspaceUi.sort 纯函数（DAO 无 ORDER BY），本测直锁；
 * 空态/内容态二态 + Flow initial=null 加载态构成三态强制（约束 #24）。
 */
class RemoteWorkspaceUiTest {

    private fun entry(
        id: Long,
        createdAtMs: Long,
        lastOpenedAtMs: Long? = null,
        title: String = "t$id",
        url: String = "https://example.com/$id",
    ) = RemoteWorkspaceEntryEntity(
        id = id,
        title = title,
        url = url,
        createdAtMs = createdAtMs,
        lastOpenedAtMs = lastOpenedAtMs,
    )

    @Test
    fun `sort puts recently opened first then never opened by creation desc`() {
        val a = entry(1, createdAtMs = 1000, lastOpenedAtMs = 9000) // 最近打开 → 第 1
        val b = entry(2, createdAtMs = 2000, lastOpenedAtMs = 5000) // 较早打开 → 第 2
        val c = entry(3, createdAtMs = 8000) // 从未打开，创建较新 → 第 3
        val d = entry(4, createdAtMs = 3000) // 从未打开，创建较旧 → 第 4
        val sorted = RemoteWorkspaceUi.sort(listOf(d, c, b, a))
        assertEquals(listOf(1L, 2L, 3L, 4L), sorted.map { it.id })
    }

    @Test
    fun `sort keeps stable order for equal opened timestamps`() {
        val x = entry(1, createdAtMs = 1000, lastOpenedAtMs = 7000)
        val y = entry(2, createdAtMs = 1000, lastOpenedAtMs = 7000)
        assertEquals(listOf(2L, 1L), RemoteWorkspaceUi.sort(listOf(x, y)).map { it.id })
        // 单元素/空列表不抛出
        assertEquals(1, RemoteWorkspaceUi.sort(listOf(x)).size)
        assertEquals(0, RemoteWorkspaceUi.sort(emptyList()).size)
    }

    @Test
    fun `state derivation empty guides and content carries sorted entries`() {
        // 空列表 → Empty（空态引导）
        assertTrue(RemoteWorkspaceUi.from(emptyList()) is RemoteWorkspaceUi.State.Empty)
        // 非空 → Content 且已排序（最近打开在前）
        val state = RemoteWorkspaceUi.from(
            listOf(
                entry(1, createdAtMs = 1000),
                entry(2, createdAtMs = 2000, lastOpenedAtMs = 100),
            ),
        )
        assertTrue(state is RemoteWorkspaceUi.State.Content)
        val content = state as RemoteWorkspaceUi.State.Content
        assertEquals(listOf(2L, 1L), content.entries.map { it.id })
    }
}
