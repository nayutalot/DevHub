package com.devhub.mobile.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** R3 归档过滤 / 长按动作集 / 查询参数契约 + R2 子会话排序与层级标注 + R4 provider 过滤。 */
class SessionListOpsTest {

    // --- R3 归档过滤 -------------------------------------------------------

    @Test
    fun `archived hidden by default visible with switch`() {
        assertFalse(SessionListOps.isVisible(archived = true, includeArchived = false))
        assertTrue(SessionListOps.isVisible(archived = true, includeArchived = true))
        assertTrue(SessionListOps.isVisible(archived = false, includeArchived = false))
    }

    @Test
    fun `row actions depend on archived state`() {
        val active = SessionListOps.rowActions(archived = false)
        assertTrue(active.archive)
        assertFalse(active.unarchive)
        assertTrue(active.delete)
        val archived = SessionListOps.rowActions(archived = true)
        assertFalse(archived.archive)
        assertTrue(archived.unarchive)
        assertTrue(archived.delete)
    }

    @Test
    fun `delete confirm text states local-projection-only`() {
        val text = SessionListOps.deleteConfirmText("UX 重构会话")
        assertTrue(text.contains("仅移除手机里的记录"))
        assertTrue(text.contains("源文件"))
        assertTrue(text.contains("UX 重构会话"))
        assertTrue(SessionListOps.deleteConfirmText(null).contains("该对话"))
    }

    @Test
    fun `sessions query follows contract param names`() {
        assertEquals(
            "/v1/sessions?limit=200",
            SessionListOps.sessionsQuery(limit = 200, includeArchived = false, parentId = null),
        )
        assertEquals(
            "/v1/sessions?limit=200&includeArchived=1",
            SessionListOps.sessionsQuery(limit = 200, includeArchived = true, parentId = null),
        )
        assertEquals(
            "/v1/sessions?limit=50&includeArchived=1&parentId=42",
            SessionListOps.sessionsQuery(limit = 50, includeArchived = true, parentId = 42),
        )
    }

    // --- R4 provider 过滤 --------------------------------------------------

    @Test
    fun `provider filter null means all`() {
        assertTrue(SessionListOps.matchesProvider(providerId = 1, selectedProviderId = null))
        assertTrue(SessionListOps.matchesProvider(providerId = 3, selectedProviderId = 3))
        assertFalse(SessionListOps.matchesProvider(providerId = 3, selectedProviderId = 2))
    }

    // --- R2 子会话 ---------------------------------------------------------

    private data class Child(val name: String, val status: String, val activity: Long?)

    @Test
    fun `children sorted active-first then by activity desc`() {
        val children = listOf(
            Child("ended-old", "completed", 100L),
            Child("running-new", "running", 900L),
            Child("ended-new", "failed", 500L),
            Child("waiting", "waiting_input", 700L),
            Child("running-old", "running", 800L),
        )
        val order = SessionListOps.sortChildren(children, statusOf = { it.status }, lastActivityOf = { it.activity })
        val names = order.map { children[it].name }
        assertEquals(listOf("waiting", "running-new", "running-old", "ended-new", "ended-old"), names)
    }

    @Test
    fun `children with null activity sort last within group`() {
        val children = listOf(
            Child("no-time", "running", null),
            Child("with-time", "running", 10L),
        )
        val order = SessionListOps.sortChildren(children, statusOf = { it.status }, lastActivityOf = { it.activity })
        assertEquals(listOf("with-time", "no-time"), order.map { children[it].name })
    }

    @Test
    fun `child level label`() {
        assertEquals("第 1 层", SessionListOps.childLevelLabel(1))
        assertEquals("第 2 层", SessionListOps.childLevelLabel(2))
    }
}
