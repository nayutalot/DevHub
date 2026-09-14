package com.devhub.mobile.core

/**
 * 会话列表操作纯逻辑（R3 归档/删除 + R4 provider 过滤 + R2 子会话排序 + 查询参数契约）。
 *
 * 端点契约（任务书 §2，批次 A 同名实现）：
 * - GET /v1/sessions 默认过滤 archived；includeArchived=1 时归档可见；
 * - GET /v1/sessions?parentId= 过滤子会话；
 * - POST /v1/sessions/{id}/archive、POST /v1/sessions/{id}/unarchive、DELETE /v1/sessions/{id}。
 * 红线：删除/归档只动 DevHub 本地投影，绝不触碰源文件（UI 文案必须写明"仅移除 DevHub 记录"）。
 */
object SessionListOps {

    /** 列表可见性：默认隐藏归档；开关打开时全部可见。 */
    fun isVisible(archived: Boolean, includeArchived: Boolean): Boolean = includeArchived || !archived

    /** provider 过滤：null = 全部；否则只留该 provider 的会话（按 providerId 归属）。 */
    fun matchesProvider(providerId: Long, selectedProviderId: Long?): Boolean =
        selectedProviderId == null || providerId == selectedProviderId

    data class RowActions(val archive: Boolean, val unarchive: Boolean, val delete: Boolean)

    /** 长按菜单动作集：未归档行 → 归档/删除；已归档行 → 取消归档/删除。删除永远可点（带二次确认）。 */
    fun rowActions(archived: Boolean): RowActions =
        if (archived) RowActions(archive = false, unarchive = true, delete = true)
        else RowActions(archive = true, unarchive = false, delete = true)

    /**
     * 删除二次确认文案（红线：写明仅移除本机投影、绝不触碰源文件）。
     * UX-P1 S10 微调：「DevHub 记录」→「手机里的记录」（语义不变）。
     */
    fun deleteConfirmText(title: String?): String =
        "「${title ?: "该对话"}」将从 DevHub 中删除：仅移除手机里的记录，不会改动你电脑上的任何源文件。此操作不可撤销。"

    /** GET /v1/sessions 查询串（契约参数名：limit / includeArchived / parentId）。 */
    fun sessionsQuery(limit: Int, includeArchived: Boolean, parentId: Long?): String = buildString {
        append("/v1/sessions?limit=")
        append(limit)
        if (includeArchived) append("&includeArchived=1")
        if (parentId != null) append("&parentId=").append(parentId)
    }

    /**
     * 子会话排序（R2 子会话列表页）：运行中 > 等待 > 其他活跃态 > 已结束；
     * 同组按 lastActivity 降序。返回排序后的升序下标序列。
     * U2-M4（AUDIT P2#8）：分组判定同经 SessionStatusCore.normalize 归一——
     * 与徽章同一状态机投影，杜绝第三处映射分叉。
     */
    fun <T> sortChildren(
        children: List<T>,
        statusOf: (T) -> String,
        lastActivityOf: (T) -> Long?,
    ): List<Int> {
        data class Key(val group: Int, val activity: Long, val index: Int)

        fun groupOf(status: String): Int = when (SessionStatusCore.normalize(status)) {
            "waiting_input", "approval_required" -> 0
            "running" -> 1
            "paused" -> 2
            else -> 3 // completed / failed / stopped / unknown / connection_lost
        }
        return children
            .mapIndexed { i, c -> Key(groupOf(statusOf(c)), lastActivityOf(c) ?: 0L, i) }
            .sortedWith(compareBy({ it.group }, { -it.activity }))
            .map { it.index }
    }

    /** 子会话行层级标注：level 从 1 开始（UX-P1 C3：「L{n} 子会话」→「第 {n} 层」）。 */
    fun childLevelLabel(level: Int): String = "第 $level 层"

    /** 列表行最近消息预览截断上限（微信形态一行省略；渲染层另叠 maxLines=1 兜底）。 */
    const val ROW_PREVIEW_MAX_CHARS = 60

    /**
     * UX-P2（docs/24 §3 对话列表行 / docs/26 §3.1）：最近消息预览纯函数。
     * 取消息缓存尾条 contentRedacted → 清 ** 显示记号（RichTextTokenizer 同源，
     * 打磨批 D 纪律：显示层清理不改数据）→ 压缩空白 → 截断加省略号。
     * 空串/空白 → null（调用方回退模式副文案）。
     */
    fun rowPreview(lastMessageContent: String?): String? {
        val cleaned = (RichTextTokenizer.stripDisplayMarkers(lastMessageContent) ?: "")
            .replace(Regex("\\s+"), " ")
            .trim()
        if (cleaned.isEmpty()) return null
        return if (cleaned.length > ROW_PREVIEW_MAX_CHARS) {
            cleaned.take(ROW_PREVIEW_MAX_CHARS) + "…"
        } else {
            cleaned
        }
    }
}
