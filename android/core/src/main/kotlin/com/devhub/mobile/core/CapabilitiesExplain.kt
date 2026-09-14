package com.devhub.mobile.core

/**
 * U2-M1（AUDIT P2#1 + P3#7）：capabilities 卡人话译码（纯函数，:core 单测直锁）。
 *
 * 缺陷实证（06/08/24 号截图）：详情页 capabilities 行直出
 * `mode=observed granted=[] evidence=managed face unconfigured: settings key
 * zcode_managed_model is empty…(caps stay observed)`——settings key、缩写、英文原句漏到用户面，
 * 且固定占屏压缩转录可视区。
 *
 * 纪律：
 * - 译码表 = 桌面 provider 投影现有 evidence/reason 形态的**穷举映射**（逐条对应
 *   src/main/services/agentControl/providers/ 各 provider 与 agentControlService 缺省投影 + App 夹具投影，
 *   清单随批汇报供主控复核覆盖率）；未知形态绝不猜 → 兜底「详见技术信息」；
 * - 零吞码：原始 mode/granted/evidence 原值由调用方收入 ⓘ 弹层「技术信息」折叠区，
 *   本模块只产用户面文案，不承载数据删除语义。
 */
object CapabilitiesExplain {

    /** 译码结果：mode/granted/reason 三维用户语言 + reason 是否命中已知形态。 */
    data class Explain(
        val modeLabel: String,
        val grantedLabel: String,
        val reasonLabel: String,

        /** false = evidence 为未知形态（reasonLabel 是兜底文案；技术原值必须可达）。 */
        val reasonKnown: Boolean,
    )

    /**
     * mode 译码（服务端 SessionMode 全集 = managed | attached | observed；
     * UX-P1 D22：主显示二态化「可以对话/仅查看」，attached 译名「电脑上接入」进 ⓘ 弹层
     * （docs/24 §2.1 capabilities 映射；判定真值零改动，只换说法）；
     * CP5 缺省投影 = 空串 → 「能力未探测」；其他未知值 → 未知，绝不猜）。
     */
    fun modeLabel(mode: String): String = when (mode) {
        "managed" -> "可以对话"
        "attached" -> "电脑上接入"
        "observed" -> "仅查看"
        "" -> "能力未探测"
        else -> "能力状态未知"
    }

    /** granted 单能力译码（AgentCapability 五值；未知令牌原样保留，绝不吞）。 */
    private fun grantedTokenLabel(token: String): String = when (token) {
        "reply" -> "回复"
        "pause" -> "暂停"
        "resume" -> "恢复"
        "approve" -> "批准"
        "interrupt" -> "中断"
        else -> token
    }

    /** granted 列表 → 人话（空 = 无控制能力；未知令牌保留原值同显）。 */
    fun grantedLabel(granted: List<String>): String = if (granted.isEmpty()) {
        "无控制能力"
    } else {
        "可执行：" + granted.joinToString("、") { grantedTokenLabel(it) }
    }

    /**
     * evidence 译码表（穷举桌面投影现有形态；匹配顺序 = 前缀族先于精确值无冲突，
     * 同前缀多形态按内层 reason 细分）。返回 (人话, 是否已知形态)。
     */
    fun reasonLabel(evidence: String): Pair<String, Boolean> {
        val e = evidence.trim()
        if (e.isEmpty()) return "无能力说明（未探测）" to true

        // —— zcodeProvider（3 形态）——
        if (e.startsWith("managed face unconfigured: ") && e.endsWith("(caps stay observed)")) {
            val reason = e.removePrefix("managed face unconfigured: ")
                .removeSuffix("(caps stay observed)").trim()
            val detail = when {
                reason.contains("settings key zcode_managed_model is empty") ->
                    "尚未在桌面端设置 ZCode 托管模型"
                else -> "桌面端 ZCode 托管配置未就绪"
            }
            return "ZCode 托管未启用：$detail" to true
        }
        if (e.startsWith("managed face configured but zcode doctor probe failed:")) {
            return "ZCode 托管配置已填写，但桌面端探测未通过" to true
        }
        if (e.startsWith("zcode managed probe ok:")) {
            return "ZCode 托管通道就绪（桌面端探测通过）" to true
        }

        // —— codexProvider（2 形态）——
        if (e.startsWith("app-server handshake ok")) {
            return "Codex 托管通道就绪（app-server 握手成功）" to true
        }
        if (e.startsWith("app-server handshake failed:")) {
            return "Codex 托管握手失败（当前只读）" to true
        }

        // —— claudeProvider（2 形态）——
        if (e.startsWith("hooks registered (")) {
            return "已注册 DevHub hooks（回复注入未验证，当前只读）" to true
        }
        if (e == "read-only transcript source (no DevHub hooks registered)") {
            return "只读转录源（未注册 DevHub hooks）" to true
        }

        // —— kimiProvider（7 形态）——
        if (e.startsWith("read-only session files; ")) {
            return "Kimi 会话文件只读（托管通道未验证）" to true
        }
        if (e == "managed probe skipped: managedProbeSessionDir not configured") {
            return "Kimi 托管探测未配置（跳过）" to true
        }
        if (e == "managed probe failed: spawn error") {
            return "Kimi 托管探测失败（进程启动失败）" to true
        }
        if (e.startsWith("managed probe failed: stdin write (")) {
            return "Kimi 托管探测失败（标准输入写入失败）" to true
        }
        if (e == "managed probe failed: process exited without session-file terminal state") {
            return "Kimi 托管探测失败（进程提前退出）" to true
        }
        if (e == "managed probe timed out without session-file terminal state") {
            return "Kimi 托管探测超时" to true
        }
        if (e == "managed probe ok: stdin probe confirmed by session-file terminal state") {
            return "Kimi 托管通道就绪（探测通过）" to true
        }

        // —— deepseekProvider（1 形态）——
        if (e.startsWith("not integrated:")) {
            return "DeepSeek 未接入（无已验证的会话/控制接口）" to true
        }

        // —— agentControlService 缺省投影（1 形态）——
        if (e == "not probed (no capability verification yet)") {
            return "能力尚未探测" to true
        }

        // —— App 夹具投影（1 形态；本身即中文，原样透出）——
        if (e == "fixture 演示数据（非真实能力）") {
            return e to true
        }

        // —— 未知形态：绝不猜，兜底指路技术信息（调用方必须保留技术原值可达）——
        return "能力状态说明详见技术信息" to false
    }

    /** 三维合流（UI ⓘ 弹层用）。 */
    fun explain(mode: String, granted: List<String>, evidence: String): Explain {
        val (reason, known) = reasonLabel(evidence)
        return Explain(
            modeLabel = modeLabel(mode),
            grantedLabel = grantedLabel(granted),
            reasonLabel = reason,
            reasonKnown = known,
        )
    }

    /**
     * 头部一行摘要（常态占屏 = 一行）：mode + reason 已知形态短句；
     * reason 未知形态只显 mode（说明进 ⓘ 弹层，避免半截英文回漏用户面）。
     */
    fun summaryLine(mode: String, evidence: String): String {
        val (reason, known) = reasonLabel(evidence)
        return if (known) "${modeLabel(mode)} · $reason" else modeLabel(mode)
    }
}
