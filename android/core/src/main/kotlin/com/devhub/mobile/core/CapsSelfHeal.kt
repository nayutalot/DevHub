package com.devhub.mobile.core

/**
 * DM2 批（docs/briefs/dm2-capsws.md §1）：relay 态 caps 过期自愈纯逻辑（:core 单测直锁）。
 *
 * 缺陷实证（run6，acceptance/mobile-chat-relay-e2e/run6/ 07/08 号截图 + relay 审计
 * 12:46:20 rejected 行）：桌面能力门（L3 resolveCommandGate 二次校验）在 caps
 * verifiedAt > 300s 后 send 一律拒（AGENT_CAPABILITY_MISSING——「能力未验证或已过期」），
 * 而 caps 探针此前仅助手页打开触发（agents 列表 → probeWiredProviders → caps 过期重验）——
 * 纯手机长间隔对话（>5min）被拒后无任何自愈路径，用户只能人肉切到助手页再切回。
 *
 * 修法（App 侧一次性自愈 = 主修面）：managed 会话详情发送被拒且拒绝码 = caps 过期族时，
 * App 经既有探针通道（agents 列表拉取；local = GET /v1/agents，relay = agent_list 帧，
 * 零新端点零桌面改动）发起一次真实能力重探；探针成功（返回 caps 的 verifiedAt 落入
 * 新鲜窗口——以桌面真实验证结果为准，绝不伪造能力）后自动重发原消息一次。重试仍拒 →
 * 既有错误呈现；一次性语义由 [OneShot] 锁定，绝不循环重试风暴。
 *
 * 触发面时序保证（为什么「拉一次 agents 列表」必然完成重验）：桌面 caps 重验阈值
 * 240s（CAPABILITY_REVERIFY_MIN_SEC）< 拒绝阈值 300s（CAPABILITY_TTL_SEC）——若
 * verifiedAt 已 >300s，则 240s 之后至今没有任何探测跑过（否则 verifiedAt 已刷新），
 * 故 60s 全局探测节流（PROBE_MIN_INTERVAL_SEC）此刻必已过期，本次 agents 列表必触发
 * 完整 probeHealth + caps 重验。
 *
 * 兜底面取舍（brief §1 两案，按改动面最小落地）：选中 **App 侧**「managed 会话详情
 * 打开期间 ≥120s 低频 caps 重探」（SessionDetailScreen 详情轮询循环 piggyback 一次
 * agents 列表拉取，零桌面改动）——被否案 = 桌面侧 detail 打开期间探针（需同时改
 * gateway REST 与 relay host-leg 两条 detail 读路径，且打破「只读投影零副作用」豁免
 * 纪律，改动面约三倍）。两案取舍注记即本头注释。兜底探针置于轮询 delay 之后（打开满
 * 120s 才首探）：0~120s 窗口由本一次性自愈主修面承担，两机制窗口互补。
 */
object CapsSelfHeal {

    /**
     * caps 过期族拒绝码（App 侧呈现为「能力未验证或已过期」族）。桌面 L3 能力门
     * （resolveCommandGate）对「未验证/过期」与「未授予」同码 AGENT_CAPABILITY_MISSING
     * ——同族触发自愈是安全的：未授予场景重探成功后重试仍拒 → 既有错误呈现，一次性
     * 语义保证不循环（ErrorPresent.api 对该码的人话文案即本族呈现面）。
     */
    val CAPS_EXPIRY_CODES: Set<String> = setOf("AGENT_CAPABILITY_MISSING")

    /** caps 新鲜窗口（与桌面 agentControlService CAPABILITY_TTL_SEC = 300 同源）。 */
    const val CAPS_FRESH_TTL_SEC = 300

    /** 拒绝码是否属 caps 过期族（自愈触发面；非 caps 族拒绝绝不走自愈）。 */
    fun isCapsExpiryRejection(code: String): Boolean = code in CAPS_EXPIRY_CODES

    /**
     * 重探返回的能力集是否「真实验证且新鲜」（自动重发的前置门；以桌面真实探测结果
     * 为准——verifiedAt 缺失/时钟倒挂/超窗一律按不新鲜处理，绝不伪造能力、绝不盲重发）。
     */
    fun capsFreshNow(verifiedAtSec: Long, nowSec: Long): Boolean =
        verifiedAtSec > 0 && nowSec >= verifiedAtSec && nowSec - verifiedAtSec <= CAPS_FRESH_TTL_SEC

    /**
     * 一次性自愈状态机（每会话详情页一个实例）：[shouldRetry] = 本次拒绝是否应
     * 「重探+重发原消息一次」。
     * - 仅 caps 过期族**首次**命中返回 true（同时消费一次性机会）；
     * - 非 caps 族拒绝恒 false 且**不消费**机会（后续真实 caps 过期仍可自愈一次）；
     * - 消费后无论重试成败恒 false（one-shot，绝不循环风暴）。
     */
    class OneShot {
        private var consumed = false

        fun shouldRetry(rejectionCode: String): Boolean {
            if (consumed) return false
            if (!isCapsExpiryRejection(rejectionCode)) return false
            consumed = true
            return true
        }
    }
}
