package com.devhub.mobile.core

/**
 * UX-Z2 结构层（任务书 §2.4 杂项）：statusDetail 工程串人话化收口（词表漏网）。
 *
 * 背景（docs/28 附录 A 02 图走查）：App 会话详情 statusDetail 直出工程串
 * 「turn/end (seq 806)」（deepseek observed wire-scan 沿 `${type} (seq ${n})`）
 * 与 managed 面「turn ended (reason: …)」。本函数 = 显示层纯查表翻译：
 * - 命中词表 → 人话；
 * - 未命中 → 原样返回（**零吞码**，绝不猜未知工程串的语义）；
 * - null/空白 → null（无 detail 不显示，调用方既有判空不变）。
 *
 * 纯 Kotlin 零 Android 依赖（:core 纪律），:app 单测直锁。
 */
object StatusDetailHumanize {

    /**
     * deepseek observed wire-scan 沿的 `<type> (seq <n>)` 形态 → 事件类型词表。
     * 词表只收状态机真实会沿出现的事件型（evalDeepseekEventStatus 映射集）；
     * 表外事件型原样透出。
     */
    private val seqEventLabels: Map<String, String> = mapOf(
        "turn/start" to "新一轮任务开始",
        "turn/end" to "本轮已结束",
        "approval/asked" to "等待工具批准",
        "approval/decided" to "工具批准已处理",
        "session/status" to "会话状态更新",
    )

    /** deepseek managed 面描述串（describeDshTurnEnd reason 六值）→ 人话。 */
    private val turnEndReasonLabels: Map<String, String> = mapOf(
        "completed" to "本轮已完成",
        "max-tokens" to "本轮结束：输出达到长度上限（内容可能不完整）",
        "aborted" to "本轮已中止",
        "interrupted" to "本轮已中断",
        "blocked" to "本轮被阻止",
        "error" to "本轮出错结束",
    )

    /**
     * UX-Z3 运行态层（任务书 #4 收尾人话）：终态族补全——zcode managed 面
     * （zcodeProvider.handleManagedEvent 实产两形态）：
     * ① 「turn completed (resultType: <rt>)」（evalZcodeEventStatus resultType 实产七值）；
     * ② 「zcode event: <type>」（非 turn.completed 事件沿）。
     * 词表只收 zcodeProtocol 实产取值；表外原样透出（零吞码纪律不变）。
     */
    private val zcodeResultTypeLabels: Map<String, String> = mapOf(
        "success" to "本轮已完成",
        "cancelled" to "本轮已取消",
        "error_max_turns" to "本轮出错结束：达到轮次上限",
        "error_max_budget" to "本轮出错结束：达到预算上限",
        "error_during_execution" to "本轮执行中出错",
        "error_max_tool_calls" to "本轮出错结束：达到工具调用次数上限",
    )

    private val zcodeEventLabels: Map<String, String> = mapOf(
        "turn.started" to "新一轮任务开始",
        "turn.completed" to "本轮已结束",
        "turn.failed" to "本轮出错结束",
        "permission.requested" to "等待工具批准",
        "userInput.requested" to "等待你的输入",
        "session.closed" to "会话已关闭",
    )

    fun display(detail: String?): String? {
        if (detail.isNullOrBlank()) return null
        val trimmed = detail.trim()
        // ① 「<type> (seq <n>)」形态（deepseek observed wire-scan 沿）
        seqShape.find(trimmed)?.let { m ->
            return seqEventLabels[m.groupValues[1]]?.let { label -> "$label（第 ${m.groupValues[2]} 条事件）" } ?: trimmed
        }
        // ② 「turn ended (reason: <reason>…)」形态（deepseek managed 面 describeDshTurnEnd）
        turnEndShape.find(trimmed)?.let { m ->
            val reason = m.groupValues[1].trim()
            return turnEndReasonLabels[reason]
                ?: turnEndReasonLabels[reason.substringBefore(';')]
                ?: "本轮已结束" // 未知 reason：人话兜底不猜因（原串可进技术细节面）
        }
        // ③ 「dsh event: <type>」形态（managed 沿非 turn/end 事件）
        dshEventShape.find(trimmed)?.let { m ->
            return seqEventLabels[m.groupValues[1]]?.let { "$it" } ?: trimmed
        }
        // ④ 「turn completed (resultType: <rt>)」形态（zcode managed 终态族；
        // 未登录取值 → 人话兜底不猜因）
        zcodeTurnCompletedShape.find(trimmed)?.let { m ->
            val rt = m.groupValues[1].trim()
            return zcodeResultTypeLabels[rt] ?: "本轮已结束"
        }
        // ⑤ 「zcode event: <type>」形态（zcode managed 非 turn.completed 事件沿）
        zcodeEventShape.find(trimmed)?.let { m ->
            return zcodeEventLabels[m.groupValues[1]]?.let { "$it" } ?: trimmed
        }
        return trimmed
    }

    private val seqShape = Regex("^([A-Za-z][A-Za-z0-9_./]*) \\(seq (\\d+)\\)$")
    private val turnEndShape = Regex("^turn ended \\(reason:\\s*([^)]+)\\)$")
    private val dshEventShape = Regex("^dsh event:\\s*([A-Za-z][A-Za-z0-9_./]*)$")
    private val zcodeTurnCompletedShape = Regex("^turn completed \\(resultType:\\s*([A-Za-z0-9_-]+)\\)$")
    private val zcodeEventShape = Regex("^zcode event:\\s*([A-Za-z][A-Za-z0-9_.]*)$")
}
