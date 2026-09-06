package com.devhub.mobile.data.remote

import com.devhub.mobile.core.TlsPinningConfig
import java.security.KeyStore
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManager
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

/**
 * R3 接缝（docs/19 §10.2 信任模型落地）：自签 IP 证书**不受系统默认信任**（§10.5 属预期），
 * relay 模式配置指纹后，**信任锚 = 配置指纹本身**——[PinTrustManager.checkServerTrusted]
 * 按叶证书 SPKI sha256 ∈ 配置指纹列表裁决信任（任一匹配即信任；不匹配 = 结构化拒绝）。
 * M3-C6a（C2b 四步实验闭环）：旧实现把信任裁决整体移交 OkHttp CertificatePinner、
 * `getAcceptedIssuers()` 返回空数组 → CertificateChainCleaner 无信任锚 → `clean([leaf])`
 * 抛 "Failed to find a trusted cert"，正确指纹也握手失败。现改为 TrustManager 侧就地
 * 完成 pin-only 信任裁决（Android 侧 CertificateChainCleaner 经 X509TrustManagerExtensions
 * 委托同一 checkServerTrusted——信任判定单点）。M3-C6c bug#1（docs/19 §10.2 实现层勘误）：
 * **CertificatePinner 不再并装**——Android 对非 Conscrypt 自定义 TM 的链清洗 fallback
 * 通过后返回空链，pinner 只对清洁链配 pin → 空链即拒（空洞拒连）；HostnameVerifier 保持
 * 默认（IP SAN 校验 = docs/19 §10.1）作第二保险。**§10.5 红线：自签 CA 绝不
 * 入 App**——信任锚是配置指纹列表，绝非任何 CA 证书。
 *
 * 红线：本 TrustManager **只**用于 relay 模式 OkHttp 客户端构造（指纹已配置时），
 * 绝不触碰 local 模式明文路径与系统默认信任的其他通道；pin 面为空时绝不使用本构造。
 * 保持既有面：错误指纹 → 握手拒 + 错误结构化可诊断 + 进程不崩（R-B9 三拒语义）；
 * 指纹格式 fail-fast 不变；local 模式 null 配置零回归（docs/19 §10.2 / D7）。
 */
object RelayTlsTrust {

    /** 指纹已配置时的 relay 专用 SSL 套件：信任锚 = 配置指纹（[PinTrustManager] 就地裁决）。 */
    fun sslSocketFactory(pinning: TlsPinningConfig): Pair<SSLSocketFactory, X509TrustManager> {
        require(pinning.fingerprints.isNotEmpty()) { "relay TLS: fingerprints must not be empty" }
        val trustManager = PinTrustManager(pinning)
        val context = SSLContext.getInstance("TLS")
        context.init(null, arrayOf<TrustManager>(trustManager), null)
        return context.socketFactory to trustManager
    }

    /**
     * pin-only 信任裁决（docs/19 §10.2）：checkServerTrusted 按**叶证书** SPKI sha256
     * ∈ 配置指纹列表放行/拒绝。双指纹轮换窗口（旧+新任一匹配即信任）由 :core
     * `TlsPinningConfig.matches` 原样承载（docs/19 §10.4）。
     *
     * internal（原 private）：M3-C6d 单测注入缝——GatewayApiTlsTest 断言 client 装的
     * 自定义 TM 就是本类（`is` 判定）；同模块（app）test 源集可见，生产面不受影响。
     */
    internal class PinTrustManager(private val pinning: TlsPinningConfig) : X509TrustManager {
        private val systemFallback: X509TrustManager by lazy {
            TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply {
                init(null as KeyStore?)
            }.trustManagers.filterIsInstance<X509TrustManager>().first()
        }

        override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {
            // 本 App 绝不做 TLS 服务端（mTLS client 面）；防御性走系统校验。
            systemFallback.checkClientTrusted(chain, authType)
        }

        override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
            // 信任锚 = 配置指纹本身：叶 SPKI ∈ pins 才信任；不匹配 → 结构化拒绝
            // （指纹形态可诊断；零码/零凭据面——SPKI 哈希非秘密）。链深度不做要求：
            // 服务端可发叶-only（caddy 443 实测 chainLen=1），信任判定只看叶 SPKI。
            if (chain.isEmpty()) throw CertificateException("relay TLS: empty server chain")
            val fingerprint = spkiSha256Fingerprint(chain[0])
            if (pinning.matches(fingerprint)) return
            throw CertificateException(
                "relay TLS: server SPKI $fingerprint not in configured pins " +
                    "${pinning.fingerprints} (docs/19 §10.2 pin-only; verify relay fingerprint provisioning / rotation window)",
            )
        }

        /**
         * 信任锚 = 配置指纹列表，**不是**任何 issuer DN 证书集（§10.5：自签 CA 绝不
         * 入 App）。Android 侧 CertificateChainCleaner 经 X509TrustManagerExtensions
         * 委托 [checkServerTrusted]（信任判定单点），不消费本列表。
         */
        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }

    /** 证书 SPKI（SubjectPublicKeyInfo DER）sha256 → `sha256/` + 小写 hex（:core 同形态）。 */
    internal fun spkiSha256Fingerprint(cert: X509Certificate): String =
        "sha256/" + MessageDigest.getInstance("SHA-256").digest(cert.publicKey.encoded)
            .joinToString("") { "%02x".format(it) }
}
