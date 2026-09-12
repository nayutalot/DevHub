package com.devhub.mobile.core

/**
 * U2-M4（AUDIT P2#8）：会话状态归一——单一状态机投影（纯函数，:core 单测直锁）。
 *
 * 缺陷实证（23 vs 05 号截图）：子会话列表状态徽章全为「未知」，父列表同批会话
 * 却显示「已完成」——两表面各自映射，无单一投影源（App 侧另有排序 groupOf 第三处
 * 判定）。本归一函数为唯一状态机入口：
 * - 服务端 9 值全集（docs/12 §4 / agentControlService.AGENT_SESSION_STATUSES 同源）
 *   原样通过（大小写/首尾空白归一为同 token，属同一事实的不同写法，非猜测）；
 * - 集合外值（含 null/空/异体词）一律 → "unknown"——「未知」仅作真无法判定时的
 *   兜底并如实显示，绝不猜成任何具体态（诚实纪律同 asSessionStatus 服务端口径）。
 * 全部表面（列表徽章/子会话徽章/排序分组）经此函数投影，结构上杜绝两套映射分叉。
 *
 * 数据面注记（投影源查明结论，随批汇报）：桌面 DB 子会话行 status 真值为
 * 'unknown'（zcode 监控对子会话无任务终态证据，338/341 行实查），「未知」徽章
 * 即该事实的如实投影——本批归一消除的是「映射分叉风险」与「集外原词直出」，
 * 不虚构子会话状态；终态证据缺失属桌面监控面，桌面零触碰。
 */
object SessionStatusCore {

    /** 会话状态 9 值全集（docs/12 §4；对外展示 7 态 + stopped/unknown 辅助态）。 */
    val CANONICAL: Set<String> = setOf(
        "running",
        "completed",
        "failed",
        "waiting_input",
        "approval_required",
        "paused",
        "connection_lost",
        "stopped",
        "unknown",
    )

    const val UNKNOWN = "unknown"

    /** 归一投影：集合内原样（大小写/空白归一）；集合外/空/null → unknown（如实兜底）。 */
    fun normalize(raw: String?): String {
        val v = raw?.trim()?.lowercase().orEmpty()
        return if (v in CANONICAL) v else UNKNOWN
    }
}
