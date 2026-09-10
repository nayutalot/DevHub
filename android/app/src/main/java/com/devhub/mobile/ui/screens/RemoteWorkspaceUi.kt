package com.devhub.mobile.ui.screens

import com.devhub.mobile.data.db.RemoteWorkspaceEntryEntity

/**
 * 远程工作区条目列表派生状态（Q 批）：最近使用排序 + 空态/内容态二态
 * （加载态由 Flow initial=null 承担——加载/空/内容三态强制，约束 #24 口径）。
 * 排序为纯函数（无 SQL ORDER BY 单一真相在代码侧），:app 单测直锁。
 */
object RemoteWorkspaceUi {

    /** 条目列表状态：Empty（空态引导）/ Content（排序后条目）。 */
    sealed interface State {
        data object Empty : State
        data class Content(val entries: List<RemoteWorkspaceEntryEntity>) : State
    }

    /**
     * 最近使用排序：已打开条目按 lastOpenedAtMs 新→旧在前；
     * 从未打开（null）条目垫底，按创建时间新→旧（同刻按 id 新→旧稳定序）。
     */
    fun sort(entries: List<RemoteWorkspaceEntryEntity>): List<RemoteWorkspaceEntryEntity> =
        entries.sortedWith(
            compareByDescending<RemoteWorkspaceEntryEntity> { it.lastOpenedAtMs ?: Long.MIN_VALUE }
                .thenByDescending { it.createdAtMs }
                .thenByDescending { it.id },
        )

    /** 列表派生：空 → Empty 引导；非空 → Content（已排序）。 */
    fun from(entries: List<RemoteWorkspaceEntryEntity>): State {
        val sorted = sort(entries)
        return if (sorted.isEmpty()) State.Empty else State.Content(sorted)
    }
}
