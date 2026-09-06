package com.devhub.mobile.data.remote

import com.devhub.mobile.core.TlsPinningConfig
import java.security.KeyStore
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager
import okhttp3.CertificatePinner
import okio.ByteString.Companion.decodeHex

/**
 * :core `TlsPinningConfig` → OkHttp `CertificatePinner` 转换（app 层注入缝）。
 *
 * U1 已裁决（2026-09-05，docs/21 §1.1）：无域名 IP TLS——Android 侧信任 = OkHttp
 * CertificatePinner 对服务端证书 SPKI sha256 的指纹锁定（docs/19 §10.2）。
 * - :core 模型归一化产物为 `sha256/{hex}`；OkHttp pin 只接受 `sha256/{base64}`，
 *   此处做唯一一处形态转换（hex → base64）；
 * - pin pattern 用**具体 host**（M3-C3a 修 2，C2 #3 崩溃修复）：从 relayUrl 解析出的
 *   host（IP 字面量直接作 pattern——OkHttp 支持 IP pattern；域名原样小写）经
 *   :core `TlsPinningConfig.pinPatternFor` 校验；曾用 `'*'` 通配符会让 OkHttp 抛
 *   IllegalArgumentException 且 app 进程在重连协程反复构建 → 死循环（M3-C2 实录）；
 * - 空/非法 host → fail-fast **不注入**：调用方必须跳过 CertificatePinner（本扩展
 *   抛 IllegalArgumentException 表达拒绝，绝不静默产出坏 pinner）；
 * - 双指纹轮换窗口语义（旧+新任一匹配即信任）由 :core `TlsPinningConfig` 的指纹列表
 *   原样映射为多条 pin（docs/19 §10.4）；
 * - **注入式**：relay 模式构造 OkHttpClient 时传入 `TlsPinningConfig`；传 null/不传 =
 *   现行为不变（无 pinning）。relay 模式接线属 R3 批（docs/20 §2.3），本批只铺缝。
 */
/**
 * :core `TlsPinningConfig` → OkHttp `CertificatePinner` 转换（app 层注入缝）。
 *
 * @param hostPattern 具体 pin pattern（**必须**先经 :core `pinPatternFor` 解析；
 *   IP 字面量或域名 host）。空/通配符/含端口等非法形态 → IllegalArgumentException
 *   （fail-fast 不注入；调用方先判空跳过，绝不回退 `'*'`——C2 #3 崩溃根因）。
 */
fun TlsPinningConfig.toCertificatePinner(hostPattern: String): CertificatePinner {
    require(hostPattern.isNotBlank()) {
        "relay TLS: pin pattern host 为空（fail-fast 不注入；绝不用 '*' 通配符——OkHttp 直接抛 IllegalArgumentException）"
    }
    require(!hostPattern.any { it == '*' || it == ':' || it == '/' }) {
        "relay TLS: pin pattern 非纯 hostname/IP（got pattern 含通配符/端口/路径）"
    }
    val builder = CertificatePinner.Builder()
    for (fingerprint in fingerprints) {
        // fingerprint 形态 = "sha256/<64 位小写 hex>"（:core 构造时已校验，此处安全）
        builder.add(hostPattern, "sha256/" + fingerprint.removePrefix("sha256/").decodeHex().base64())
    }
    return builder.build()
}

/**
 * R3 接缝（docs/19 §10.2 信任模型落地）：自签 IP 证书**不受系统默认信任**（§10.5 属预期），
 * relay 模式配置指纹后，信任锚 = 指纹本身——TrustManager 侧放行链（信任裁决移交
 * CertificatePinner），OkHttp 在握手上对 SPKI 指纹强制 pin 比对，任何指纹不匹配
 * → 握手失败（R-B9 三拒语义：错误证书/错误指纹/过期证书的 SPKI 都不匹配 → 全被拒）。
 *
 * 红线：本 TrustManager **只**用于 relay 模式 OkHttp 客户端构造（指纹已配置时），
 * 绝不触碰 local 模式明文路径与系统默认信任的其他通道；pin 面为空时绝不使用本构造。
 */
object RelayTlsTrust {

    /** 指纹已配置时的 relay 专用 SSL 套件：信任委托给 CertificatePinner（指纹即信任锚）。 */
    fun sslSocketFactory(pinning: TlsPinningConfig): Pair<SSLSocketFactory, X509TrustManager> {
        require(pinning.fingerprints.isNotEmpty()) { "relay TLS: fingerprints must not be empty" }
        val context = SSLContext.getInstance("TLS")
        context.init(null, arrayOf(DelegatingTrustManager), null)
        return context.socketFactory to DelegatingTrustManager
    }

    /** 链校验委托给指纹 pin（握手后 OkHttp CertificatePinner 强制比对 SPKI）。 */
    private object DelegatingTrustManager : X509TrustManager {
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
            // 信任裁决移交 CertificatePinner：SPKI 指纹 ∈ 配置列表才可能通过（pin 在
            // 握手完成时强制执行；链非法到无法取证书的形态由抛错兜底）。
            if (chain.isEmpty()) throw CertificateException("relay TLS: empty server chain")
        }

        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }
}
