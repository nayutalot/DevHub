package com.devhub.mobile.core

/**
 * UX-Z2 结构层（docs/28 §4）：对话 tab「工作区」分段的客户端纯分组函数。
 *
 * 分组口径（与桌面 agents:sessionWorkspaces 聚合同一语义）：
 * - 分组键 = workdir 归一串（反斜杠→斜杠、小写化、去尾斜杠；Windows 路径
 *   大小写/分隔符变体同组）；
 * - workdir 缺失/空白的会话归键 null 的「未分组」组，**绝不丢弃**，组恒排尾部；
 * - 组内会话按 lastActivityAtSec 降序（缺时间垫底）；
 * - 组间按组内最近活动 MAX 降序（未分组组恒尾）；
 * - 显示名 = 路径尾段兜底（App 只持有 SessionView.workdir；projects 匹配在
 *   桌面聚合投影完成，此处纯函数只做尾段，绝不造名）。
 *
 * 纯 Kotlin 零 Android 依赖（:core 纪律），:app 单测直锁。
 */
object WorkspaceGrouping {

    /** 最小输入行（:app SessionCacheEntity 投影；:core 不依赖 Android 实体）。 */
    data class SessionRef(
        val sessionId: Long,
        val workdir: String?,
        val lastActivityAtSec: Long?,
        val title: String?,
        val status: String,
    )

    /** 工作区组（orderedSessions 已按组内排序规则排好）。 */
    data class Group(
        val key: String?,
        val name: String?,
        val path: String?,
        val sessions: List<SessionRef>,
    ) {
        val lastActivityAtSec: Long?
            get() = sessions.mapNotNull { it.lastActivityAtSec }.maxOrNull()
    }

    /**
     * workdir 归一串（分组键）：反斜杠→斜杠统一、小写化（Windows 大小写不敏感）、
     * 去尾斜杠（根除外）。null/空白 → null（缺失归「未分组」，绝不造空键）。
     */
    fun normalizeWorkdirKey(workdir: String?): String? {
        if (workdir.isNullOrBlank()) return null
        var key = workdir.trim().replace('\\', '/').lowercase()
        while (key.length > 1 && key.endsWith("/")) key = key.dropLast(1)
        return key.ifEmpty { null }
    }

    /** 路径尾段（显示名兜底）：按 / 与 \ 切分取最后非空段；全空 → null。 */
    fun tailSegment(path: String): String? =
        path.split('/', '\\').filter { it.isNotBlank() }.lastOrNull()

    /**
     * 分组主入口：输入会话行 → 工作区组列表（组内/组间排序都已排好；
     * 未分组组（key=null）恒在列表尾部）。绝不丢行：输出组会话总数 == 输入行数。
     */
    fun group(sessions: List<SessionRef>): List<Group> {
        val byKey = LinkedHashMap<String, MutableList<SessionRef>>()
        for (s in sessions) {
            val key = normalizeWorkdirKey(s.workdir)
            byKey.getOrPut(key ?: UNGROUPED_KEY) { mutableListOf() }.add(s)
        }
        val groups = byKey.map { (mapKey, members) ->
            val sorted = members.sortedWith(
                compareByDescending<SessionRef> { it.lastActivityAtSec ?: Long.MIN_VALUE }
                    .thenByDescending { it.sessionId },
            )
            val realKey = if (mapKey == UNGROUPED_KEY) null else mapKey
            val path = sorted.firstNotNullOfOrNull { s -> s.workdir?.takeIf { it.isNotBlank() } }
            Group(
                key = realKey,
                name = path?.let { tailSegment(it) },
                path = path,
                sessions = sorted,
            )
        }
        val named = groups.filter { it.key != null }.sortedWith(
            compareByDescending<Group> { it.lastActivityAtSec ?: Long.MIN_VALUE }
                .thenBy { it.key ?: "" },
        )
        val ungrouped = groups.filter { it.key == null }
        return named + ungrouped
    }

    private const val UNGROUPED_KEY = "\u0000ungrouped"
}
