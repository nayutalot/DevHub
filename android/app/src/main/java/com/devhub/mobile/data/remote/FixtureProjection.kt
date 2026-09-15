package com.devhub.mobile.data.remote

import com.devhub.mobile.core.MessageSegments

/**
 * 夹具数据源（体验整改批 B 联调专用，**演示数据，非真实 Gateway**）。
 *
 * - 覆盖 R1/R2/R3/R4/R8/R9/R10/R11 各验收样例：跨天消息、超长思维链、代码块、
 *   转义 plugin 引用、五家 provider、归档会话、子会话（运行中/已结束）、>200 条大窗口；
 * - capabilities 一律 mode=observed（夹具绝不伪造控制通道；observed 零控件红线不破坏）；
 * - archive/unarchive/delete 只改本对象内存态，等价真实端点的"仅动本地投影"语义；
 * - 批次 A 端点合并后：关闭夹具开关即回到真实 GatewayApi，本文件不参与生产路径。
 */
class FixtureProjection private constructor() : ProjectionApi {

    companion object {
        /** 夹具会话 id 段（880xxx），避免与真实会话 id 混淆；UI 显示时本就带夹具标注。 */
        const val BASE_SESSION_ID = 880_000L

        @Volatile
        private var instance: FixtureProjection? = null

        fun get(): FixtureProjection = instance ?: synchronized(this) {
            instance ?: FixtureProjection().also { instance = it }
        }
    }

    // —— 内存投影态 ——

    private data class FixtureMessage(
        val id: Long,
        val role: String,
        val content: String,
        val occurredAtSec: Long,
        val segments: List<SegmentDto>?,
    )

    private val nowSec: Long = System.currentTimeMillis() / 1000
    private val daySec = 24 * 60 * 60L

    private val agents: List<AgentDto> = listOf(
        agent(1, "Codex"),
        agent(2, "Claude Code"),
        // 打磨批 D：chip 命名对齐真实 provider 名录（Kimi → Kimi Code）；五家集合与真实一致
        agent(3, "Kimi Code"),
        agent(4, "ZCode"),
        agent(5, "DeepSeek"),
    )

    private val sessions = LinkedHashMap<Long, SessionDto>()
    private val messages = HashMap<Long, MutableList<FixtureMessage>>()

    init {
        seed()
    }

    private fun agent(id: Long, displayName: String) = AgentDto(
        id = id,
        displayName = displayName,
        health = "ok",
        capabilities = CapabilitiesDto(
            mode = "observed",
            granted = emptyList(),
            verifiedAtSec = nowSec,
            evidence = "fixture 演示数据（非真实能力）",
        ),
    )

    private fun session(
        id: Long,
        providerId: Long,
        key: String,
        label: String,
        title: String,
        status: String,
        mode: String = "observed",
        archived: Boolean = false,
        parent: Long? = null,
        startedDaysAgo: Int = 2,
        lastActivitySec: Long,
        // UX-Z2 结构层（docs/28 §4）：夹具演示工作区（纯只读演示数据，绝不伪造
        // 控制通道；「工作区」分段在演示模式下同构可走查）。
        workdir: String? = null,
    ) = SessionDto(
        id = id,
        providerId = providerId,
        nativeId = "fixture-$id",
        sessionMode = mode,
        title = title,
        status = status,
        statusDetail = "演示模式数据",
        startedAtSec = nowSec - startedDaysAgo * daySec,
        lastActivityAtSec = lastActivitySec,
        endedAtSec = if (status in setOf("completed", "failed", "stopped")) lastActivitySec else null,
        stale = false,
        providerKey = key,
        providerLabel = label,
        archived = archived,
        parentSessionId = parent,
        workdir = workdir,
    )

    private fun addSession(s: SessionDto) {
        sessions[s.id] = s
        messages[s.id] = mutableListOf()
    }

    private fun msg(sessionId: Long, id: Long, role: String, content: String, atSec: Long, segments: List<SegmentDto>? = null) {
        messages[sessionId]?.add(FixtureMessage(id, role, content, atSec, segments))
    }

    private fun seg(kind: String, content: String, label: String? = null) = SegmentDto(kind = kind, label = label, content = content)

    private fun seed() {
        // —— 主会话 1：ZCode 跨三天 260 条（R10 大窗口 / R11 日期边界 / R1 思维链 / R8 引用）——
        addSession(
            session(
                id = 880_001, providerId = 4, key = "zcode", label = "ZCode",
                title = "DevHub App 阅读体验重构（演示长对话）", status = "running",
                lastActivitySec = nowSec - 5 * 60, workdir = "C:/code/devhub",
            ),
        )
        // 2 天前 60 条；昨天 80 条；今天 120 条 → 跨两个日界；id 1..260 升序
        var id = 1L
        fun dayStart(daysAgo: Int): Long = nowSec - daysAgo * daySec - 6 * 3600 // 每日约 06:00 起
        var t = dayStart(2)
        for (i in 1..260) {
            val daysAgo = when {
                i <= 60 -> 2
                i <= 140 -> 1
                else -> 0
            }
            if (i == 1) t = dayStart(2)
            if (i == 61) t = dayStart(1)
            if (i == 141) t = dayStart(0)
            t += 60 + (i % 7) * 20L
            val role = if (i % 3 == 1) "user" else "assistant"
            val content: String
            var segments: List<SegmentDto>? = null
            when {
                // 每 10 条左右一条带长思维链（R1 默认收起；含 1 条超长 2600 字）
                role == "assistant" && i % 12 == 2 -> {
                    val thinkingLen = if (i % 36 == 2) 2600 else 400 + (i % 9) * 120
                    val thinking = buildString {
                        append("分析当前实现：消息投影为单字符串，需要引入分段模型。")
                        repeat(thinkingLen / 40) { append("逐步核对转录源消息类型映射，确认仅在结构明确时输出 thinking 段；") }
                    }
                    content = "已按要求处理第 $i 步：定位到根因并完成修改。"
                    segments = listOf(
                        seg(MessageSegments.KIND_THINKING, thinking),
                        seg(MessageSegments.KIND_TEXT, content),
                    )
                }
                // 工具调用段（R1 toolInvocation chip）
                role == "assistant" && i % 12 == 5 -> {
                    content = "工具执行完成。"
                    segments = listOf(
                        seg(MessageSegments.KIND_TOOL, "android/app/src/main/java/.../SessionDetailScreen.kt", label = "Read"),
                        seg(MessageSegments.KIND_TEXT, content),
                    )
                }
                // R8：转义 plugin 引用（用户实例原文）+ markdown 链接 + 代码块
                role == "assistant" && i % 12 == 8 -> {
                    content = "打开 \\[Android 模拟器\\]\\(plugin://Android-Emulator\\) 面板，参考 [任务书](https://example.com/ux-task)。\n" +
                        "```kotlin\nfun bubble(role: String) = when (role) {\n    \"user\" -> Side.RIGHT\n    else -> Side.LEFT\n}\n```\n" +
                        "配置项用 `last=200` 尾部取数。"
                    segments = listOf(seg(MessageSegments.KIND_TEXT, content))
                }
                // R8：裸 plugin:// 引用
                role == "assistant" && i % 12 == 11 -> {
                    content = "已调用 plugin://ZCode-Subagent 生成子会话并等待回流。"
                    segments = listOf(seg(MessageSegments.KIND_TEXT, content))
                }
                role == "user" -> content = if (i % 6 == 1) {
                    "这条用户消息比较长，用于观察气泡换行与右侧对齐表现：请把对话详情改成气泡式对话流，" +
                        "思维链默认收起，消息默认展示最新一轮，并支持拖动定位与归档删除。"
                } else "继续，第 $i 步保持这个方向。"
                else -> content = "收到，第 $i 步已完成（短回复样例）。"
            }
            msg(880_001, id, role, content, t, segments)
            id += 1
        }

        // —— 主会话 2：Codex 短会话（昨天，R11 短消息样例）——
        addSession(
            session(
                id = 880_002, providerId = 1, key = "codex", label = "Codex",
                title = "Codex 短对话样例", status = "completed",
                lastActivitySec = nowSec - daySec - 3600, workdir = "C:/code/devhub",
            ),
        )
        msg(880_002, 1, "user", "跑一下单元测试。", nowSec - daySec - 3600)
        msg(880_002, 2, "assistant", "`:core:test` 全部通过（37/37）。", nowSec - daySec - 3540)

        // —— 主会话 3：Claude Code 长文本 + 代码块（R8/R11 长消息样例）——
        addSession(
            session(
                id = 880_003, providerId = 2, key = "claude", label = "Claude Code",
                title = "Claude 长文本与代码块样例", status = "waiting_input",
                lastActivitySec = nowSec - 3 * 3600, workdir = "C:/code/contestpin",
            ),
        )
        msg(880_003, 1, "user", "给出迷你渲染器的实现要点。", nowSec - 3 * 3600 - 120)
        msg(
            880_003, 2, "assistant",
            "要点如下：行内代码用 SpanStyle 背景色 + 等宽字体；块级代码整体等宽底色；" +
                "markdown 链接只显示 label；plugin/skill/mcp 引用渲染为 chip；渲染失败回退纯文本。\n" +
                "```text\nPlain -> CodeSpan / CodeBlock / Link / ReferenceChip -> AnnotatedString\n```\n" +
                "禁止 WebView/HTML。对齐 AnnotatedString 的 SpanStyle 即可，无需额外依赖。",
            nowSec - 3 * 3600, // 无 segments：演示"回退整段纯文本 + R8 迷你渲染"路径
        )
        // 打磨批 D：`**` 加粗真实形态样例（真实 Claude 长消息大量使用；此前记号原样露出）
        msg(
            880_003, 3, "assistant",
            "**任务** — 做一辆循线小车,车上装平衡滚球控制装置。\n\n" +
                "**关键约束**:\n- 车身 ≤35cm×25cm,轮式驱动\n- 循迹只能用红外光电模块\n\n" +
                "需要注意的是,这道题的两大难点在于**循线运动控制**(要快又要停得准)和**摆杆滚球平衡控制**。",
            nowSec - 2 * 3600, // 无 segments：走 contentRedacted 回退路径 + R8 渲染器（含 Bold）
        )

        // —— 主会话 4：Kimi Code 今日活跃 ——
        addSession(
            session(
                id = 880_004, providerId = 3, key = "kimi", label = "Kimi Code",
                title = "Kimi Code observed 只读样例", status = "running",
                startedDaysAgo = 0, workdir = "C:/code/contestpin",
                lastActivitySec = nowSec - 15 * 60,
            ),
        )
        msg(880_004, 1, "user", "今天进展如何？", nowSec - 30 * 60)
        msg(880_004, 2, "assistant", "观察正常，本对话只能查看。", nowSec - 15 * 60)

        // —— 主会话 5：DeepSeek 已归档（R3）——
        addSession(
            session(
                id = 880_005, providerId = 5, key = "deepseek", label = "DeepSeek",
                title = "DeepSeek 历史对话（已归档样例）", status = "completed", // UX-Z2：无 workdir →「未分组」组样例
                archived = true,
                startedDaysAgo = 3,
                lastActivitySec = nowSec - 2 * daySec - 7200,
            ),
        )
        msg(880_005, 1, "user", "旧任务收尾。", nowSec - 3 * daySec)
        msg(880_005, 2, "assistant", "已归档的对话默认不在列表显示。", nowSec - 2 * daySec - 7200)

        // —— 打磨批 D：长标题（** 记号 + 单行省略号截断样例）——
        addSession(
            session(
                id = 880_006, providerId = 4, key = "zcode", label = "ZCode",
                title = "你是 DevHub App 体验整改批的**批次 D**打磨验收：这条标题故意写得很长很长，" +
                    "用于验证列表行单行截断省略号与标题 ** 记号的显示层清理样例",
                status = "completed",
                startedDaysAgo = 0,
                lastActivitySec = nowSec - 3 * 60, workdir = "D:/ws/blog",
            ),
        )
        msg(880_006, 1, "assistant", "**任务**：验证标题清理与省略号。**六项要求**：全部满足即过。", nowSec - 3 * 60)

        // —— R2：880001 的两个子会话（一个运行中、一个已结束，均可点入回看）——
        addSession(
            session(
                id = 880_101, providerId = 4, key = "zcode", label = "ZCode",
                title = "子代理：气泡组件实现", status = "running", parent = 880_001,
                startedDaysAgo = 0, workdir = "C:/code/devhub",
                lastActivitySec = nowSec - 8 * 60,
            ),
        )
        msg(880_101, 1, "user", "实现 MessageBubble 组件。", nowSec - 20 * 60)
        msg(880_101, 2, "assistant", "MessageBubble 已完成：分侧规则接入 BubbleSides。", nowSec - 8 * 60)
        addSession(
            session(
                id = 880_102, providerId = 4, key = "zcode", label = "ZCode",
                title = "子代理：scrubber 数学", status = "completed", parent = 880_001,
                startedDaysAgo = 0, workdir = "C:/code/devhub",
                lastActivitySec = nowSec - 45 * 60,
            ),
        )
        msg(880_102, 1, "user", "scrubber 索引映射放 core。", nowSec - 50 * 60)
        msg(880_102, 2, "assistant", "ScrubberMath 已进 :core 并配单测。", nowSec - 45 * 60)
    }

    // —— ProjectionApi ——

    override fun agents(): List<AgentDto> = agents

    override fun sessions(limit: Int, includeArchived: Boolean, parentId: Long?): List<SessionDto> {
        val filtered = sessions.values
            .filter { parentId != null || it.parentSessionId == null } // 子会话不出现在默认列表（R2 保留 8442e9d 意图）
            .filter { it.parentSessionId == parentId }
            .filter { includeArchived || !it.archived } // R3 默认过滤归档
            .sortedByDescending { it.lastActivityAtSec ?: it.startedAtSec ?: 0 }
        return filtered.take(limit)
    }

    override fun sessionDetail(sessionId: Long): SessionDetailDto {
        val s = sessions[sessionId] ?: throw ApiError(
            code = "SESSION_NOT_FOUND",
            message = "演示数据中不存在该对话",
            httpCode = 404,
        )
        return SessionDetailDto(
            session = s,
            capabilities = agent(s.providerId, s.providerLabel ?: "").capabilities,
            childSessions = sessions.values.filter { it.parentSessionId == sessionId },
        )
    }

    override fun messages(sessionId: Long, after: Long?, last: Int?, before: Long?, limit: Int): MessagesPage {
        val all = messages[sessionId].orEmpty().sortedBy { it.id }
        val page: List<FixtureMessage> = when {
            last != null -> all.takeLast(last) // R10 尾部取数
            before != null -> all.filter { it.id < before }.takeLast(limit) // R10 向旧翻页
            after != null -> all.filter { it.id > after }.take(limit)
            else -> all.take(limit)
        }
        val nextAfter: Long? = if (after != null && page.isNotEmpty()) {
            val newer = all.filter { it.id > after }
            if (newer.size > page.size) page.last().id else null
        } else {
            null
        }
        val prevAfter: Long? = when {
            last != null && all.size > page.size -> page.first().id - 1
            before != null && page.isNotEmpty() -> {
                val older = all.filter { it.id < before }
                if (older.size > page.size) page.first().id - 1 else null
            }
            else -> null
        }
        return MessagesPage(
            items = page.map { m ->
                MessageDto(
                    id = m.id,
                    role = m.role,
                    contentRedacted = m.content,
                    occurredAtSec = m.occurredAtSec,
                    segments = m.segments,
                )
            },
            nextAfter = nextAfter,
            prevAfter = prevAfter,
        )
    }

    override fun archive(sessionId: Long) {
        sessions[sessionId]?.let { sessions[sessionId] = it.copy(archived = true) }
    }

    override fun unarchive(sessionId: Long) {
        sessions[sessionId]?.let { sessions[sessionId] = it.copy(archived = false) }
    }

    /** 夹具删除：会话 + 其子会话 + 消息一并移除（等价"仅动本地投影"语义）。 */
    override fun deleteSession(sessionId: Long) {
        val doomed = sessions.keys.filter { it == sessionId || sessions[it]?.parentSessionId == sessionId }
        doomed.forEach {
            sessions.remove(it)
            messages.remove(it)
        }
    }
}
