package com.devhub.mobile.core.relay

/**
 * relay endpoint 解析与 wss 强制（docs/19 §11 / docs/18 §2）。
 *
 * 铁律：relay 模式客户端代码层**必须拒绝**非 `wss://` endpoint（G2/G7/D7，docs/21 §1）——
 * `ws://` 明文仅限本地模式（docs/14 路径）与 M3 联调时间盒（docs/19 §11 精确过期条件），
 * 时间盒属部署期例外，代码层拒绝规则不变。保存与连接两层同用本函数，绝不双标。
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
         * （U2-M3，AUDIT P2#6；原「docs/19 §11」引用移除，语义不变）。
         */
        const val REJECT_REASON =
            "relay endpoint 必须为 wss://（ws:// 为明文，不承载真实配对；App 在保存与连接两层一律拒绝）"

        /**
         * 解析并强制 wss；非法形态抛 IllegalArgumentException（fail-fast，绝不静默降级）。
         * 接受 `wss://host[:port][/path…]`；port 缺省 443。
         */
        fun parse(raw: String): RelayEndpoint {
            val trimmed = raw.trim()
            require(trimmed.startsWith(WSS_PREFIX)) { REJECT_REASON }
            val pathless = trimmed.removePrefix(WSS_PREFIX).substringBefore('/')
            require(pathless.isNotEmpty()) { "relay endpoint 缺少 host：$trimmed" }
            val hostPart = pathless.substringBeforeLast(':')
            val portPart = pathless.substringAfterLast(':', missingDelimiterValue = "")
            require(hostPart.isNotEmpty()) { "relay endpoint 缺少 host：$trimmed" }
            val port = if (portPart.isEmpty()) DEFAULT_PORT else portPart.toIntOrNull()
                ?: throw IllegalArgumentException("relay endpoint 端口非法：$trimmed")
            require(port in 1..65535) { "relay endpoint 端口越界：$trimmed" }
            return RelayEndpoint(url = trimmed.trimEnd('/'), host = hostPart, port = port)
        }
    }
}
