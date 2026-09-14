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

    /** R6.1：managed provider 卡文案（能力是会话级的，展示必须如实说；UX-P1 H1 人话化）。 */
    const val MANAGED_PROVIDER_NOTE = "你发起的对话可以回复/暂停/恢复；电脑上自己开的对话只能看"

    /** R6.2：启动对话按钮/输入区文案（UX-P1 H2-H5）。 */
    const val SPAWN_BUTTON_LABEL = "开始对话"
    const val SPAWN_CONFIRM_LABEL = "开始"
    const val SPAWN_CANCEL_LABEL = "取消"
    const val SPAWN_TASK_LABEL = "想让它先做什么？（会作为第一条消息发出）"
    const val SPAWN_BUSY_LABEL = "正在创建…"

    /**
     * UX-P3（docs/briefs/uxp3-flows.md §1.2「开始对话一键化」）：第一条消息输入框
     * placeholder——点 [开始对话] 即展开内联输入框并聚焦（键盘弹起），引导直接说事。
     */
    const val SPAWN_TASK_PLACEHOLDER = "想让它先做什么？"

    /** observed 会话通用兜底文案（provider 未知时；per-provider 原因卡优先；UX-P1 H6）。 */
    const val GENERIC_OBSERVED_NOTE = "这个对话只能查看：手机端不能操作，请在电脑上操作"

    /** granted 非空且非 managed/observed 的既有形态（attached 等）沿用明细展示（UX-P1 H7）。 */
    const val EMPTY_GRANTED_NOTE = "仅查看"

    // —— U1-M2（AUDIT P1#2）：observed 会话「等待输入」假可供性修复 ——
    // 列表/详情的 waiting_input 徽章在 observed 会话上加锁定语义：
    // 详情页零控件（无 composer/无按钮），「等待输入」召唤的输入动作本端不可达
    // = 假可供性。徽章改「等待输入 · 只读」+ 详情页解释行，与 InteractionHonesty
    // 同一纪律：绝不显示本端不具备的交互。
    const val MODE_OBSERVED = "observed"
    const val STATUS_WAITING_INPUT = "waiting_input"

    /** observed 会话 waiting_input 徽章替换文案（锁定语义；UX-P1 H8 只换说法不换判定）。 */
    const val WAITING_INPUT_OBSERVED_LABEL = "等电脑回复 · 本机只读"

    /**
     * 详情页零控件处解释行（observed + waiting_input 同屏时补一行「为什么不能输入」；
     * 语义复用既有「转录只读」文案族——ZCODE_REMOTE_DETAIL_NOTE 同源，不杜撰能力；UX-P1 H9）。
     */
    const val OBSERVED_WAITING_NOTE =
        "「等待输入」是说电脑那头在等人输入；这台手机只能看，请在电脑上回复"

    /**
     * U1-M2 纯判定：observed 会话 waiting_input 徽章应替换的锁定文案；
     * 非 observed 或非 waiting_input → null（调用方沿用 StatusColors 原文案）。
     * sessionMode / capsMode 任一为 observed 即命中（与 SessionDetail 的 observed
     * 原因卡触发同口径，绝不把 managed/attached 误标只读）。
     */
    fun waitingInputBadge(status: String, sessionMode: String?, capsMode: String?): String? =
        if (status == STATUS_WAITING_INPUT &&
            (sessionMode == MODE_OBSERVED || capsMode == MODE_OBSERVED)
        ) {
            WAITING_INPUT_OBSERVED_LABEL
        } else {
            null
        }

    // —— T1 批：ZCode 展示入口文案（UX-P1 H10-H14 人话化；诚实纪律不变：转录仍只读，
    // 控制走 ZCode 自家认证页，绝不显示为 DevHub 可控/managed）——
    const val ZCODE_REMOTE_SESSION_BUTTON = "在电脑上打开 ZCode 页面"
    const val ZCODE_REMOTE_AGENTS_BUTTON = "打开电脑页面"
    const val ZCODE_REMOTE_DETAIL_NOTE = "这里只能看内容 · 操作要去 ZCode 页面"
    const val ZCODE_REMOTE_AGENTS_NOTE = "操作会跳到 ZCode 自己的登录页"
    const val ZCODE_REMOTE_FETCHING = "正在获取电脑页面…"

    // U5 批的 ZCODE_REMOTE_LOCAL_UNAVAILABLE（「本地模式不提供 ZCode 遥控取链 ·
    // 请使用 Relay 接入」）随 X-L 反转（docs/18 §5.3.2，2026-09-14）退役：本地网关
    // 命令面就位后 local 模式同样取链（失败经 Unavailable 结构化文案如实投影，
    // 不再使用「不提供」类否定文案）。

    /** R6 判定：服务端 CapabilitySet.mode == managed（数据驱动，绝不硬编码 provider 名）。 */
    const val MODE_MANAGED = "managed"

    // —— UX-P2（docs/24 §2.1/§3.2 + docs/26 §3.2）：provider 卡二态主显示 ——
    // 「● 可以对话 / ○ 仅查看」与 capabilities 真值一一对应（红线 docs/24 §1 #3：
    // managed/attached（有授权）→ 可对话侧；observed/未授权/未知 → 仅查看，
    // 绝不把不可用画成可用）。attached 按 granted 投影归类，细节进 ⓘ 弹层。

    /** 二态主显示：provider 卡能力态（UX-P2 A1 二态化）。 */
    enum class CapabilityDuality { CAN_TALK, VIEW_ONLY }

    /** 二态主显示文案（X3 同源词表；attached 的第三译名「电脑上接入」只进 ⓘ 弹层）。 */
    const val DUALITY_CAN_TALK_LABEL = "可以对话"
    const val DUALITY_VIEW_ONLY_LABEL = "仅查看"

    /**
     * UX-P2 纯判定：provider capabilities → 二态主显示。
     * - managed → 可以对话（会话级能力如实注解由 MANAGED_PROVIDER_NOTE 承载）；
     * - attached → granted 含任一控制令牌（reply/pause/resume/approve/interrupt）→
     *   可以对话，否则仅查看（docs/24 §2.1「attached 按 granted 投影归类」）；
     * - observed / 空串 / 未知值 / granted 空 → 仅查看（未知绝不冒充可用，诚实纪律）。
     */
    fun capabilityDuality(capabilityMode: String?, granted: List<String>): CapabilityDuality =
        when (capabilityMode) {
            MODE_MANAGED -> CapabilityDuality.CAN_TALK
            "attached" ->
                if (granted.any { it in CONTROL_GRANT_TOKENS }) CapabilityDuality.CAN_TALK
                else CapabilityDuality.VIEW_ONLY

            else -> CapabilityDuality.VIEW_ONLY
        }

    /** AgentCapability 五值令牌（CapabilitesExplain.grantedTokenLabel 同源集合）。 */
    private val CONTROL_GRANT_TOKENS = setOf("reply", "pause", "resume", "approve", "interrupt")

    /**
     * R6.2/R7.2：「启动托管会话」按钮可见性。
     * 门 = 服务端投影 capabilities.mode == managed（服务端另有 L3 二次校验：
     * 非 managed provider → 403 COMMAND_NOT_EXECUTABLE，UI 绝不给假入口）；
     * 夹具演示模式一律 false（夹具绝不伪造控制通道，红线）。
     */
    fun canSpawnManagedSession(capabilityMode: String?, fixtureMode: Boolean): Boolean =
        !fixtureMode && capabilityMode == MODE_MANAGED

    /**
     * R7.1：per-provider observed 原因卡文案（docs/known-limitations.md §1 事实；
     * UX-P1 H15-H18 人话化：措辞变化不改变「不可用不显示为可用」判定，docs/24 §8）。
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
                "ZCode：官方还没有开放手机控制，只能查看"

            haystacks.any { it.contains("claude") } ->
                "Claude Code：暂无可靠的手机回复通道，只能查看"

            haystacks.any { it.contains("kimi") } ->
                "Kimi：手机控制功能已开发但尚未开通，暂时只能查看"

            haystacks.any { it.contains("deepseek") } ->
                "DeepSeek：还没接入手机端"

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
     * UX-P1（docs/25 H19/A19）：headline = 人话（原码退出用户面）；technical = 原码+原样
     * raw（「技术细节」折叠承载，绝不吞码、绝不伪造成功）。分叉：
     * - SPAWN_REJECTED（新码，WS 专属）：spawn 特有拒绝（provider 无托管通道/并发上限）；
     * - COMMAND_NOT_EXECUTABLE：授权矩阵不允许（provider 非 managed）；
     * - AGENT_CAPABILITY_MISSING：能力未验证/过期；
     * - 其余（NOT_FOUND/BAD_PAYLOAD/COMMAND_EXPIRED/…）：通用人话头 + 原码进折叠。
     */
    fun spawnRejection(errorCode: String?, raw: String?): ErrorPresent.Presentable {
        val tech = buildString {
            append('[')
            append(errorCode ?: "UNKNOWN")
            append(']')
            if (!raw.isNullOrBlank()) {
                append(' ')
                append(raw)
            }
        }
        return when (errorCode) {
            "SPAWN_REJECTED" ->
                ErrorPresent.Presentable("创建失败：这个助手的对话通道不可用或数量已达上限", tech)

            "COMMAND_NOT_EXECUTABLE" ->
                ErrorPresent.Presentable("创建失败：该助手暂不支持在手机上开始对话", tech)

            "AGENT_CAPABILITY_MISSING" ->
                ErrorPresent.Presentable("创建失败：助手状态未验证，请先在电脑端刷新", tech)

            else ->
                ErrorPresent.Presentable("创建失败：请稍后重试", tech)
        }
    }

    /** 与 ProviderPalette 同法归一化：小写 + 仅字母数字。 */
    private fun normalize(raw: String?): String? {
        val s = (raw ?: "").lowercase().filter { it in 'a'..'z' || it in '0'..'9' }
        return s.ifBlank { null }
    }
}
