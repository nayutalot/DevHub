package com.devhub.mobile.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * UX-Z2 结构层（docs/28 §4）：对话 tab「工作区」分段客户端纯分组函数锁——
 * workdir 归一（大小写/尾斜杠/反斜杠）、未分组兜底且恒排尾部、组内/组间排序、
 * 显示名尾段兜底、绝不丢行。
 */
class WorkspaceGroupingTest {

    private fun s(id: Long, workdir: String?, last: Long?, title: String = "t$id") =
        WorkspaceGrouping.SessionRef(sessionId = id, workdir = workdir, lastActivityAtSec = last, title = title, status = "completed")

    @Test
    fun `normalizeWorkdirKey unifies separators case and trailing slash`() {
        assertEquals("c:/ws/devhub", WorkspaceGrouping.normalizeWorkdirKey("C:\\Ws\\DevHub\\"))
        assertEquals("c:/ws/devhub", WorkspaceGrouping.normalizeWorkdirKey("c:/ws/devhub"))
        assertEquals("c:/ws/devhub", WorkspaceGrouping.normalizeWorkdirKey("C:/WS/DevHub"))
        assertNull(WorkspaceGrouping.normalizeWorkdirKey(null))
        assertNull(WorkspaceGrouping.normalizeWorkdirKey("   "))
        assertEquals("/", WorkspaceGrouping.normalizeWorkdirKey("/"))
    }

    @Test
    fun `tailSegment picks last non-empty segment`() {
        assertEquals("DevHub", WorkspaceGrouping.tailSegment("C:/code/DevHub"))
        assertEquals("DevHub", WorkspaceGrouping.tailSegment("/home/u/DevHub/"))
        assertEquals("DevHub", WorkspaceGrouping.tailSegment("D:\\code\\DevHub"))
        assertNull(WorkspaceGrouping.tailSegment("///"))
    }

    @Test
    fun `case and slash variants merge into one group`() {
        val groups = WorkspaceGrouping.group(
            listOf(
                s(1, "C:/ws/devhub", 100),
                s(2, "C:\\WS\\DEVHUB", 90),
                s(3, "C:/ws/devhub/", 80),
            ),
        )
        assertEquals(1, groups.size)
        assertEquals("c:/ws/devhub", groups[0].key)
        assertEquals(3, groups[0].sessions.size)
        assertEquals(100L, groups[0].lastActivityAtSec)
    }

    @Test
    fun `ungrouped group goes last and never drops sessions`() {
        val groups = WorkspaceGrouping.group(
            listOf(
                s(1, null, 10),
                s(2, "C:/ws/old", 20),
                s(3, "C:/ws/new", 30),
                s(4, "", 40),
            ),
        )
        assertEquals(3, groups.size)
        assertEquals("c:/ws/new", groups[0].key)
        assertEquals("c:/ws/old", groups[1].key)
        assertNull(groups[2].key)
        val total = groups.sumOf { it.sessions.size }
        assertEquals(4, total)
        // 组内同样按 lastActivity 降序：40 > 10
        assertEquals(listOf(4L, 1L), groups[2].sessions.map { it.sessionId })
    }

    @Test
    fun `within group sessions sort by lastActivity desc`() {
        val groups = WorkspaceGrouping.group(
            listOf(s(1, "C:/w", 5), s(2, "C:/w", 50), s(3, "C:/w", 15)),
        )
        assertEquals(listOf(2L, 3L, 1L), groups[0].sessions.map { it.sessionId })
    }

    @Test
    fun `groups sort by max activity desc`() {
        val groups = WorkspaceGrouping.group(
            listOf(
                s(1, "C:/a", 10),
                s(2, "C:/b", 20),
                s(3, "C:/a", 99),
            ),
        )
        assertEquals(listOf("c:/a", "c:/b"), groups.map { it.key })
    }

    @Test
    fun `display name is path tail of first path`() {
        val groups = WorkspaceGrouping.group(listOf(s(1, "C:/code/DevHub", 1)))
        assertEquals("DevHub", groups[0].name)
        assertEquals("C:/code/DevHub", groups[0].path)
        assertNull(WorkspaceGrouping.group(listOf(s(1, null, 1)))[0].name)
    }

    @Test
    fun `empty input yields empty groups`() {
        assertTrue(WorkspaceGrouping.group(emptyList()).isEmpty())
    }
}
