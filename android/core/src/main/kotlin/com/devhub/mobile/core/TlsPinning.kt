package com.devhub.mobile.core

import java.util.Base64

/**
 * 无域名 IP TLS 注入式指纹配置模型（U1 已裁决 2026-09-05：永久不购域名，docs/21 §1.1；
 * 信任模型架构权威 = docs/19 §10）。
 *
 * 语义：
 * - 指纹形态：`sha256/{hex}`（64 位十六进制，hex 与 `sha256/` 前缀均大小写不敏感）或等价
 *   `sha256/{base64}`（解码后必须恰为 32 字节；standard/URL-safe 字母表、有无 padding 均接受）
 *   ——内部统一归一化为 `sha256/` + 小写 hex；
 * - **fail-fast**：构造即校验，任何一条格式非法（缺前缀/长度错/字符错/解码非 32 字节）或
 *   列表为空 → [IllegalArgumentException]，绝不静默降级为「不校验」；
 * - **双指纹轮换窗口**（docs/19 §10.4）：证书轮换期同时配置旧+新两枚 SPKI 指纹，
 *   [matches] 为「任一匹配即信任」语义，两端任一侧先后升级都不断链。
 *
 * 校验对象说明：OkHttp `CertificatePinner` 与 Node `tls.checkServerIdentity` 比对的均是证书
 * **SPKI（SubjectPublicKeyInfo）的 SHA-256**——生产指纹以 `gen-ip-cert.sh` 输出的
 * `spki-sha256.txt` 为准（证书整体指纹仅人工核对用，勿混入此模型）。
 *
 * 纯逻辑落 :core（零 OkHttp/Android 依赖）；OkHttp 侧转换在 app 模块注入缝完成
 * （`TlsPinningConfig?` 可选参数，null = 现行为不变——local 模式明文/无 pinning 零回归）。
 */
class TlsPinningConfig(fingerprints: List<String>) {

    /** 归一化后的指纹列表（`sha256/` + 小写 hex，去重保序）。 */
    val fingerprints: List<String> = fingerprints.map(::normalize).distinct()

    init {
        // fail-fast：空列表 = 意味着「配置了 pinning 却什么也不信」，必须显式拒绝而非静默放行
        require(fingerprints.isNotEmpty()) {
            "TlsPinningConfig: fingerprints must not be empty (at least 1 SPKI sha256 fingerprint)"
        }
    }

    /**
     * 双指纹轮换窗口语义：候选 SPKI 指纹与配置列表**任一**匹配即信任。
     * 候选形态与构造参数一致（`sha256/{hex|base64}`）；非法形态同样 fail-fast——
     * 候选指纹来自握手对端（受控解码路径），格式异常应立即暴露而非判为不匹配。
     */
    fun matches(fingerprint: String): Boolean = normalize(fingerprint) in fingerprints

    companion object {
        private const val PREFIX = "sha256/"
        private const val SHA256_HEX_LENGTH = 64
        private const val SHA256_BYTES = 32

        /** 归一化任意形态指纹到 `sha256/` + 小写 hex；前缀大小写不敏感；非法输入抛 [IllegalArgumentException]。 */
        fun normalize(raw: String): String {
            val trimmed = raw.trim()
            require(trimmed.length > PREFIX.length && trimmed.lowercase().startsWith(PREFIX)) {
                "TlsPinning fingerprint must start with '$PREFIX' (got: prefix-less value)"
            }
            val body = trimmed.substring(PREFIX.length)
            return "$PREFIX${normalizeBody(body)}"
        }

        private fun normalizeBody(body: String): String {
            require(body.isNotEmpty()) { "TlsPinning fingerprint body is empty" }
            // 形态一：64 位十六进制（大小写不敏感）
            if (body.length == SHA256_HEX_LENGTH) {
                return body.lowercase().also { hex ->
                    require(hex.all { it in '0'..'9' || it in 'a'..'f' }) {
                        "TlsPinning fingerprint is 64 chars but contains non-hex characters"
                    }
                }
            }
            // 形态二：base64（standard / URL-safe，padding 可选），解码后必须恰为 32 字节
            val bytes = runCatching { decodeBase64Lenient(body) }
                .getOrElse { throw IllegalArgumentException("TlsPinning fingerprint is neither 64-char hex nor valid base64") }
            require(bytes.size == SHA256_BYTES) {
                "TlsPinning fingerprint base64 must decode to exactly $SHA256_BYTES bytes (got ${bytes.size})"
            }
            return bytes.joinToString("") { "%02x".format(it.toInt() and 0xff) }
        }

        private fun decodeBase64Lenient(value: String): ByteArray {
            val normalized = value.replace('-', '+').replace('_', '/')
            val padded = normalized.padEnd((normalized.length + 3) / 4 * 4, '=')
            return Base64.getDecoder().decode(padded)
        }
    }
}
