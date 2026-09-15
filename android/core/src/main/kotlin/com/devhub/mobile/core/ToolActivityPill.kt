package com.devhub.mobile.core

/**
 * UX-Z3 运行态层（docs/28 §6.2 E19a 收紧版 / docs/briefs/uxz3-runtime.md #2）：工具活动 pill 聚合纯函数。
 *
 * 白名单口径（真实事件样本实测后定——8601 行 approval_status 教训：先测后定）：
 * - 样本一：zcode 真库 tool_usage 37,273 行 / 52 个 tool_name 全集（2026-09-15 实查
 *   ~/.zcode/cli/db/db.sqlite）：Bash 19125 / Read 6667 / Edit 6009 / Write 1818 /
 *   TodoWrite 1389 / Agent 402 / TaskOutput 326 / mcp__* / WebSearch / WebFetch /
 *   SendMessage / Skill / AskUserQuestion / ExitPlanMode / PowerShell / Glob / Cron* 等；
 *   App 投影面 agent_messages 中 toolInvocation 段 16,874 段全数挂在 role='assistant' 行
 *   （zcode 消息面 role 无 'tool' 值，桌面 DB 实查 0 行）；
 * - 样本二：deepseek managed firehose 真机 e2e（acceptance/deepseek-managed-e2e
 *   t2-messages.json）：一次 bash 调用双行投影 = assistant 折叠行（[tool_call bash] +
 *   toolInvocation 段）+ role='tool' 的 tool/call 行（toolInvocation 段）各一；
 *   tool/result 行无 segments。按 assistant+tool 全数计数会把 1 次调用记成 2 次。
 * - 样本三：deepseek observed wire-scan / claude-code observed：role='tool' 行全为
 *   [tool_result] 无 segments，toolInvocation 零投影 → 不可得，不画数字（无据不画）。
 *
 * 载体裁定（消除 deepseek 双写重复计数，两 provider 同一面）：
 * - 会话窗口内存在 role='tool' 且带 toolInvocation 段的行（deepseek managed 形态）
 *   → 只按 role='tool' 行计数（docs/28 §6.2 逐字口径）；
 * - 否则按 role='assistant' 行计数（zcode managed/observed 同库转录面，工具名投影一致）；
 * - user/system 行永不计数。
 *
 * 文件类白名单（精确匹配，大小写/首尾空白归一）：Read/Edit/Write/MultiEdit/
 * NotebookEdit/apply_patch——读改写均属「文件操作」；Bash/PowerShell 可能触文件但
 * 判定不了 → 不入白名单（绝不猜）；未知工具名（mcp__ 前缀/未来新工具）→ 计入通用
 * 步数，不入文件数。非文件不去重、按调用行如实计数（arguments 脱敏后路径不可解析，
 * 不按路径去重）。
 *
 * 纯 Kotlin 零 Android 依赖（:core 纪律），单测以上述真实样本形态直锁。
 */
object ToolActivityPill {

    /** 文件类工具名白名单（归一为小写比对）。 */
    val FILE_TOOLS: Set<String> = setOf("read", "edit", "write", "multiedit", "notebookedit", "apply_patch")

    const val KIND_TOOL = "toolInvocation"

    /** 聚合输入行（App 侧由消息行投影：role + 该行 toolInvocation 段的 label 列表）。 */
    data class Row(val role: String, val toolLabels: List<String>)

    /** 聚合结果：invocations = 工具调用总步数；fileOps = 文件类白名单命中数。 */
    data class Counts(val invocations: Int, val fileOps: Int)

    /**
     * 窗口内行聚合（窗口归属=调用方按 turn 锚点过滤；本函数只管口径）。
     * @return null = 窗口内无任何 toolInvocation 段（不可得 → 调用方不画 pill）。
     */
    fun counts(rows: List<Row>): Counts? {
        val toolRows = rows.filter { it.role == "tool" && it.toolLabels.isNotEmpty() }
        val carrier = if (toolRows.isNotEmpty()) {
            toolRows
        } else {
            rows.filter { it.role == "assistant" && it.toolLabels.isNotEmpty() }
        }
        if (carrier.isEmpty()) return null
        var invocations = 0
        var fileOps = 0
        for (row in carrier) {
            for (label in row.toolLabels) {
                invocations += 1
                if (label.trim().lowercase() in FILE_TOOLS) fileOps += 1
            }
        }
        return Counts(invocations = invocations, fileOps = fileOps)
    }

    /** running 期 pill 文案：文件命中 → 「已进行 N 次文件操作」；否则通用「运行中 · 第 N 步」。 */
    fun runningText(c: Counts): String =
        if (c.fileOps > 0) "已进行 ${c.fileOps} 次文件操作" else "运行中 · 第 ${c.invocations} 步"

    /** 停沿后完成转场文案（waiting_input/completed；docs/28 §6.2 逐字）。 */
    fun doneText(c: Counts): String = "本轮完成 · ${c.invocations} 次操作"

    /** 停沿为 failed 的失败转场文案（人话；失败详情由 statusDetail 人话面承载）。 */
    const val FAILED_TEXT = "本轮出错结束"

    /** 停沿为 paused 的取消转场文案（zcode cancelled→paused 同义，任务书终态族「取消」）。 */
    const val CANCELLED_TEXT = "本轮已取消"

    /** 停沿为 connection_lost 的降级转场文案（本轮结果未知，如实）。 */
    const val LOST_TEXT = "本轮已结束"

    /** 停沿状态 → 转场文案（counts=null 时调用方不画；文档 §6.2 转场条款全族）。 */
    fun stopText(status: String, c: Counts): String = when (SessionStatusCore.normalize(status)) {
        "failed" -> FAILED_TEXT
        "paused" -> CANCELLED_TEXT
        "connection_lost" -> LOST_TEXT
        else -> doneText(c)
    }
}
