package com.devhub.mobile.core

/**
 * R6/R7 交互诚实化（体验整改批 C）：provider 级能力展示的纯逻辑与文案常量。
 *
 * 红线（docs/17 §3 #2）：不可用能力绝不显示为可用；绝不伪造交互；
 * observed 会话零控件（ControlGate 会话级门现状保持，本模块只管 provider 卡展示）。
 *
 * 事实基线（docs/known-limitations.md §1，文案从该处摘取，不得杜撰）：
 * - Codex = managed（仅 DevHub 托管启动的会话可 reply/pause/resume；
 *   用户外部自启的会话 = observed 只读）→ R6.1 文案「托管会话可交互；外部会话只读」；
 * - ZCode：官方未提供控制通道，只能观察（§1.1）；
 * - Claude Code：hooks 无输入注入 API，reply 无可验证执行路径（§1.4）；
 * - Kimi：托管通道已实现但真机授权验证留用户裁决（§1.5）；
 * - DeepSeek：未接入（无可验证会话/控制接口）（§1.2）。
 */
object InteractionHonesty {

    /** R6.1：managed provider 卡文案（能力是会话级的，展示必须如实说）。 */
    const val MANAGED_PROVIDER_NOTE = "托管会话可交互；外部会话只读"

    /** R6.2：启动托管会话按钮/输入区文案。 */
    const val SPAWN_BUTTON_LABEL = "启动托管会话"
    const val SPAWN_CONFIRM_LABEL = "确认启动"
    const val SPAWN_CANCEL_LABEL = "取消"
    const val SPAWN_TASK_LABEL = "托管任务（将作为首条消息发给 Agent）"
    const val SPAWN_BUSY_LABEL = "启动中…"

    /** observed 会话通用兜底文案（provider 未知时；per-provider 原因卡优先）。 */
    const val GENERIC_OBSERVED_NOTE = "observed 会话：纯观察模式，不提供任何远程控制（服务端亦全禁）。"

    /** granted 非空且非 managed/observed 的既有形态（attached 等）沿用明细展示。 */
    const val EMPTY_GRANTED_NOTE = "无控制能力"

    // —— T1 批：ZCode 遥控展示入口文案（诚实纪律：转录仍只读，控制走 ZCode 自家认证页，
    // 绝不显示为 DevHub 可控/managed）——
    const val ZCODE_REMOTE_SESSION_BUTTON = "打开 ZCode 遥控"
    const val ZCODE_REMOTE_AGENTS_BUTTON = "打开遥控"
    const val ZCODE_REMOTE_DETAIL_NOTE = "转录只读 · 控制经 ZCode 遥控页"
    const val ZCODE_REMOTE_AGENTS_NOTE = "控制经 ZCode 遥控页（ZCode 自家认证）"
    const val ZCODE_REMOTE_FETCHING = "正在获取 ZCode 遥控链接…"

    /** R6 判定：服务端 CapabilitySet.mode == managed（数据驱动，绝不硬编码 provider 名）。 */
    const val MODE_MANAGED = "managed"

    /**
     * R6.2/R7.2：「启动托管会话」按钮可见性。
     * 门 = 服务端投影 capabilities.mode == managed（服务端另有 L3 二次校验：
     * 非 managed provider → 403 COMMAND_NOT_EXECUTABLE，UI 绝不给假入口）；
     * 夹具演示模式一律 false（夹具绝不伪造控制通道，红线）。
     */
    fun canSpawnManagedSession(capabilityMode: String?, fixtureMode: Boolean): Boolean =
        !fixtureMode && capabilityMode == MODE_MANAGED

    /**
     * R7.1：per-provider observed 原因卡文案（docs/known-limitations.md §1 摘取）。
     * providerKey 精确/归一化包含匹配优先；displayName 令牌匹配兜底（/v1/agents
     * 投影无 providerKey 字段，displayName 为服务端真实投影）；未知 → null
     * （调用方回退 GENERIC_OBSERVED_NOTE，绝不猜）。
     */
    fun observedReason(providerKey: String?, displayName: String? = null): String? {
        val normalizedKey = normalize(providerKey)
        val normalizedLabel = normalize(displayName)
        // 归一化 key 精确 → 包含；两输入合并判定（同一 provider 的稳定令牌）
        val haystacks = listOfNotNull(normalizedKey, normalizedLabel)
        if (haystacks.isEmpty()) return null
        return when {
            haystacks.any { it == "zcode" || it.contains("zcode") } ->
                "ZCode：官方未提供控制通道，DevHub 只能观察，回复/暂停/恢复不可用。"

            haystacks.any { it.contains("claude") } ->
                "Claude Code：hooks 无输入注入 API，回复（reply）无可验证执行路径，当前只读观察。"

            haystacks.any { it.contains("kimi") } ->
                "Kimi：托管通道已实现但真机授权验证留待用户裁决，当前只读观察。"

            haystacks.any { it.contains("deepseek") } ->
                "DeepSeek Harness：未接入（无可验证会话/控制接口），无会话数据源。"

            else -> null
        }
    }

    /**
     * T1 批：zcode provider 的「打开 ZCode 遥控」展示入口可见性判定（纯函数）。
     * 与 observedReason 同归一化匹配模式（providerKey / providerLabel / displayName
     * 任一含 zcode 令牌即命中；/v1/agents 投影无 providerKey，Agents 卡用 displayName）。
     * 红线对齐：本判定**只**决定展示入口（按钮/智能卡）是否出现，绝不改写会话能力门
     * 与服务端语义——zcode 会话本体仍是 observed 只读投影（徽章诚实原则不变）。
     */
    fun isZcodeDisplayEntry(providerKey: String?, displayName: String? = null): Boolean {
        val haystacks = listOfNotNull(normalize(providerKey), normalize(displayName))
        return haystacks.any { it == "zcode" || it.contains("zcode") }
    }

    /**
     * M3-E1（docs/18 §5.3/§8.2）：relay 模式 spawn_session 拒绝文案分叉（纯函数）。
     * 按 command_ack rejected 的 errorCode 结构化分叉（绝不吞码、绝不伪造成功）：
     * - SPAWN_REJECTED（新码，WS 专属）：spawn 特有拒绝（provider 无托管通道/并发上限）；
     * - COMMAND_NOT_EXECUTABLE：授权矩阵不允许（provider 非 managed）；
     * - AGENT_CAPABILITY_MISSING：能力未验证/过期；
     * - 其余（NOT_FOUND/BAD_PAYLOAD/COMMAND_EXPIRED/…）：原码透传展示。
     */
    fun spawnRejectionText(errorCode: String?, raw: String?): String = when (errorCode) {
        "SPAWN_REJECTED" ->
            "启动被拒绝：该 provider 无托管通道或并发已达上限（SPAWN_REJECTED）"

        "COMMAND_NOT_EXECUTABLE" ->
            "启动被拒绝：该 provider 未授予 managed 能力（COMMAND_NOT_EXECUTABLE）"

        "AGENT_CAPABILITY_MISSING" ->
            "启动被拒绝：provider 能力未验证或已过期，请先在桌面端重新探测（AGENT_CAPABILITY_MISSING）"

        else ->
            if (!raw.isNullOrBlank()) "启动被拒绝 [$errorCode] $raw" else "启动被拒绝 [$errorCode]"
    }

    /** 与 ProviderPalette 同法归一化：小写 + 仅字母数字。 */
    private fun normalize(raw: String?): String? {
        val s = (raw ?: "").lowercase().filter { it in 'a'..'z' || it in '0'..'9' }
        return s.ifBlank { null }
    }
}
