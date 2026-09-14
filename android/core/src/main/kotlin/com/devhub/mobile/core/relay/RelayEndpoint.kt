package com.devhub.mobile.core.relay

/**
 * relay endpoint 解析与 wss 强制（docs/19 §11 / docs/18 §2）。
 *
 * 铁律：relay 模式客户端代码层**必须拒绝**非 `wss://` endpoint（G2/G7/D7，docs/21 §1）——
 * `ws://` 明文仅限本地模式（docs/14 路径）与 M3 联调时间盒（docs/19 §11 精确过期条件），
 * 时间盒属部署期例外，代码层拒绝规则不变。保存与连接两层同用本函数，绝不双标。
 *
 * 路径铁律（KC 批，RD 批 404 陷阱定位）：endpoint 只收**裸地址** `wss://host[:port][/`。
 * 设备腿路径 `/relay/device` 由 [deviceWsUrl] 统一拼接——带路径输入（如用户照抄
 * `wss://host/relay/device`）若被静默接受会拼出 `/relay/device/relay/device` 404，
 * 故 parse 层 fail-fast 拒绝（与 wss 强制同款「绝不静默降级」纪律），文案人话全中文。
 */
data class RelayEndpoint(
    val url: String,
    val host: String,
    val port: Int,
) {
    /** WS 设备腿路径（docs/18 §2：wss://<relay>/relay/device）。 */
    val deviceWsUrl: String get() = url.trimEnd('/') + "/relay/device"

    /** REST 面 base（ECS 终结，docs/18 §7.1）：同 host 同端口换 https scheme。 */
    val restBaseUrl: String get() = "https://$host:$port"

    companion object {
        const val WSS_PREFIX = "wss://"
        const val DEFAULT_PORT = 443

        /**
         * 文案（保存层 UI 与连接层异常共用）：只讲规则本身，不引内部文档编号
         * （U2-M3，AUDIT P2#6）。UX-P1 G19 人话化：规则句保留，工程尾注移除
         * （wss 强制与双层面同函数校验语义零改动）。
         */
        const val REJECT_REASON =
            "服务器地址必须以 wss:// 开头（加密连接）"

        /**
         * 路径拒绝文案（KC 批）：与 wss 文案同款纪律——只讲规则本身。UX-P1 G20 人话化。
         */
        const val REJECT_REASON_PATH =
            "只填地址即可，不要带路径——App 会自动补全"

        /**
         * 解析并强制 wss + 裸地址；非法形态抛 IllegalArgumentException（fail-fast，
         * 绝不静默降级）。接受 `wss://host[:port]`（可选裸尾斜杠，归一剥除）；
         * 带路径输入一律拒绝（404 陷阱，见类注）。
         */
        fun parse(raw: String): RelayEndpoint {
            val trimmed = raw.trim()
            require(trimmed.startsWith(WSS_PREFIX)) { REJECT_REASON }
            val afterScheme = trimmed.removePrefix(WSS_PREFIX)
            val pathPart = afterScheme.substringAfter('/', missingDelimiterValue = "")
            require(pathPart.isEmpty()) { REJECT_REASON_PATH }
            val pathless = afterScheme.substringBefore('/')
            require(pathless.isNotEmpty()) { "服务器地址缺少主机名：$trimmed" }
            val hostPart = pathless.substringBeforeLast(':')
            val portPart = pathless.substringAfterLast(':', missingDelimiterValue = "")
            require(hostPart.isNotEmpty()) { "服务器地址缺少主机名：$trimmed" }
            val port = if (portPart.isEmpty()) DEFAULT_PORT else portPart.toIntOrNull()
                ?: throw IllegalArgumentException("服务器地址端口非法：$trimmed")
            require(port in 1..65535) { "服务器地址端口越界（需 1–65535）：$trimmed" }
            return RelayEndpoint(url = trimmed.trimEnd('/'), host = hostPart, port = port)
        }
    }
}
