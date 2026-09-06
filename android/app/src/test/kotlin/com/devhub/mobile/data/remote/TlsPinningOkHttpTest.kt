package com.devhub.mobile.data.remote

import com.devhub.mobile.core.TlsPinningConfig
import java.io.IOException
import java.net.InetAddress
import java.security.KeyStore
import java.security.cert.CertificateException
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLException
import javax.net.ssl.SSLServerSocket
import javax.net.ssl.SSLSocket
import javax.net.ssl.TrustManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * M3-C6a：`RelayTlsTrust` pin-only 信任锚 JVM 单测（docs/19 §10.2 信任模型落地）。
 *
 * C2b 四步实验闭环的根因：旧 `DelegatingTrustManager` 无状态放行 + `getAcceptedIssuers()`
 * 空数组 → OkHttp CertificateChainCleaner 无信任锚 → 正确指纹也握手失败。修复后
 * `checkServerTrusted` 按**叶证书 SPKI ∈ 配置指纹**就地裁决（任一匹配即信任、不匹配
 * 结构化拒绝），CertificatePinner 保留作强制层，HostnameVerifier 默认不变。
 *
 * 测试证书在代码内生成（[TestCertificates]，test 源集受控夹具；§10.5 CA 绝不入 App）。
 *
 * 面界定（实证，C6a 批探针结论）：OkHttp 链清洗在 **JVM** = BasicCertificateChainCleaner
 * （acceptedIssuers 索引驱动，clean() 全程 **零** checkServerTrusted 调用）→ CA-free 的
 * pin-only 模型在 JVM OkHttp 客户端层结构性不可过（须装根 CA = 违反 §10.5，被裁决否决）；
 * **Android**（App 唯一运行时）CertificateChainCleaner 经 X509TrustManagerExtensions 委托
 * 同一 checkServerTrusted（信任判定单点，本批修复点）。故本套件在 JVM 验证两件真实面：
 * TrustManager 的 pin-only 裁决语义 + 裸 SSLSocket 全握手（SSL 引擎在一切平台都调用
 * checkServerTrusted）；OkHttp 客户端层端到端属 Android 设备面，不在 JVM 假装配线。
 */
class TlsPinningOkHttpTest {

    // ------------------------------------------------------------------
    // checkServerTrusted：pin-only 信任裁决单点
    // ------------------------------------------------------------------

    @Test
    fun `checkServerTrusted accepts leaf-only chain when leaf SPKI matches the configured pin`() {
        val cert = TestCertificates.selfSigned("relay-accept")
        val pinning = TlsPinningConfig(listOf("sha256/${cert.spkiSha256Hex}"))
        val trustManager = RelayTlsTrust.sslSocketFactory(pinning).second
        // 叶-only 链（caddy 443 实测 chainLen=1）：信任判定只看叶 SPKI
        trustManager.checkServerTrusted(arrayOf(cert.certificate), "ECDHE_ECDSA")
    }

    @Test
    fun `checkServerTrusted honors rotation window - any of old plus new pins matches`() {
        val leaf = TestCertificates.selfSigned("relay-rotation-new")
        val other = TestCertificates.selfSigned("relay-rotation-old")
        // 双指纹轮换窗口（docs/19 §10.4）：配置旧+新，叶匹配其中任一即信任（形态大小写不敏感）
        val pinning = TlsPinningConfig(
            listOf("sha256/${other.spkiSha256Hex}", "sha256/${leaf.spkiSha256Hex.uppercase()}"),
        )
        val trustManager = RelayTlsTrust.sslSocketFactory(pinning).second
        trustManager.checkServerTrusted(arrayOf(leaf.certificate), "ECDHE_ECDSA")
    }

    @Test
    fun `checkServerTrusted rejects non-pinned leaf with structured refusal`() {
        val leaf = TestCertificates.selfSigned("relay-reject")
        val unrelated = TestCertificates.selfSigned("relay-unrelated")
        val pinning = TlsPinningConfig(listOf("sha256/${unrelated.spkiSha256Hex}"))
        val trustManager = RelayTlsTrust.sslSocketFactory(pinning).second
        try {
            trustManager.checkServerTrusted(arrayOf(leaf.certificate), "ECDHE_ECDSA")
            fail("non-pinned leaf must be refused")
        } catch (err: CertificateException) {
            // 结构化拒绝面（R-B9）：拒绝消息携带叶指纹与配置 pin 列表，可诊断、零凭据
            assertTrue(
                "refusal must carry the computed leaf fingerprint, got: ${err.message}",
                err.message!!.contains("sha256/${leaf.spkiSha256Hex}"),
            )
            assertTrue(
                "refusal must name the configured pin set, got: ${err.message}",
                err.message!!.contains("sha256/${unrelated.spkiSha256Hex}"),
            )
            assertTrue(
                "refusal must cite the pin-only design authority, got: ${err.message}",
                err.message!!.contains("docs/19 §10.2"),
            )
        }
    }

    @Test
    fun `checkServerTrusted rejects empty chain structurally`() {
        val cert = TestCertificates.selfSigned("relay-empty-chain")
        val pinning = TlsPinningConfig(listOf("sha256/${cert.spkiSha256Hex}"))
        val trustManager = RelayTlsTrust.sslSocketFactory(pinning).second
        try {
            trustManager.checkServerTrusted(emptyArray(), "ECDHE_ECDSA")
            fail("empty chain must be refused")
        } catch (err: CertificateException) {
            assertTrue(err.message!!.contains("empty server chain"))
        }
    }

    @Test
    fun `spki fingerprint matches core model - same digest over SubjectPublicKeyInfo`() {
        val cert = TestCertificates.selfSigned("relay-fp-shape")
        val fingerprint = RelayTlsTrust.spkiSha256Fingerprint(cert.certificate)
        assertEquals("sha256/${cert.spkiSha256Hex}", fingerprint)
        // :core 模型归一化等价：matches 语义一致且形态（大小写）不敏感
        assertTrue(TlsPinningConfig(listOf(fingerprint)).matches("sha256/${cert.spkiSha256Hex.uppercase()}"))
    }

    // ------------------------------------------------------------------
    // fail-fast 面（既有行为不回退）：pin 面为空绝不降级为「不校验」
    // ------------------------------------------------------------------

    @Test
    fun `empty pin list fails fast at core model - never degrades to trust-all`() {
        try {
            TlsPinningConfig(emptyList())
            fail("empty fingerprints must fail fast")
        } catch (err: IllegalArgumentException) {
            assertTrue(err.message!!.contains("must not be empty"))
        }
    }

    // ------------------------------------------------------------------
    // CertificatePinner 保留作强制层：hex → base64 转换端到端仍正确
    // ------------------------------------------------------------------

    @Test
    fun `certificate pinner keeps enforcing - matching pin passes, foreign cert fails`() {
        val leaf = TestCertificates.selfSigned("relay-pinner")
        val foreign = TestCertificates.selfSigned("relay-foreign")
        val host = "127.0.0.1"
        val pinning = TlsPinningConfig(listOf("sha256/${leaf.spkiSha256Hex}"))
        val pinner = pinning.toCertificatePinner(TlsPinningConfig.pinPatternFor(host)!!)
        pinner.check(host, listOf(leaf.certificate)) // 匹配 → 通过（不抛）
        try {
            pinner.check(host, listOf(foreign.certificate))
            fail("foreign SPKI must fail the pinner")
        } catch (err: javax.net.ssl.SSLPeerUnverifiedException) {
            assertTrue(err.message!!.contains("Certificate pinning failure"))
        }
    }

    // ------------------------------------------------------------------
    // 真实 TLS 握手（裸 SSLSocket ↔ SSLServerSocket，叶-only 链）
    // ------------------------------------------------------------------

    /**
     * 本地 TLS 服务端（内存 PKCS12 KeyManager，自签叶-only 链；构造即绑定监听口）。
     * serveHttp = true 时完成一次极小 HTTP 应答（OkHttp 端到端用）；false 只到握手。
     */
    private class LocalTlsServer(cert: TestCertificates.SelfSigned, private val serveHttp: Boolean) : Thread() {
        val serverSocket: SSLServerSocket = newServerSocket(cert)
        @Volatile var handshakeError: IOException? = null

        private fun newServerSocket(cert: TestCertificates.SelfSigned): SSLServerSocket {
            val keyStore = KeyStore.getInstance("PKCS12").apply { load(null, null) }
            keyStore.setKeyEntry("relay-test", cert.keyPair.private, CharArray(0), arrayOf(cert.certificate))
            val keyManagers = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply {
                init(keyStore, CharArray(0))
            }.keyManagers
            val context = SSLContext.getInstance("TLS")
            context.init(keyManagers, null as Array<TrustManager>?, null)
            return context.serverSocketFactory
                .createServerSocket(0, 1, InetAddress.getByName("127.0.0.1")) as SSLServerSocket
        }

        override fun run() {
            try {
                serverSocket.soTimeout = 5000
                // SSLServerSocket.accept() 静态类型是 Socket（无协变覆写）→ 显式下转
                (serverSocket.accept() as SSLSocket).use { socket ->
                    socket.startHandshake()
                    if (serveHttp) {
                        socket.getInputStream().read(ByteArray(4096)) // 请求头（内容不关注）
                        socket.getOutputStream().write(
                            "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray(),
                        )
                        socket.getOutputStream().flush()
                    }
                }
            } catch (err: IOException) {
                handshakeError = err
            }
        }
    }

    private fun handshakeWith(serverLeaf: TestCertificates.SelfSigned, pinning: TlsPinningConfig): IOException? {
        val server = LocalTlsServer(serverLeaf, serveHttp = false).apply { isDaemon = true; start() }
        try {
            val (socketFactory, _) = RelayTlsTrust.sslSocketFactory(pinning)
            socketFactory.createSocket("127.0.0.1", server.serverSocket.localPort).use { socket ->
                socket as SSLSocket
                socket.soTimeout = 5000
                socket.startHandshake()
            }
            return null
        } catch (err: IOException) {
            return err
        } finally {
            server.join(5000)
            server.serverSocket.close()
        }
    }

    @Test
    fun `tls handshake succeeds over real sockets with correct pin against leaf-only chain`() {
        val leaf = TestCertificates.selfSigned("relay-handshake-ok")
        val pinning = TlsPinningConfig(listOf("sha256/${leaf.spkiSha256Hex}"))
        // 服务端叶-only 自签链 + 正确指纹：TrustManager 就地裁决 → 握手必须过
        // （C2b 根因回归面：旧实现的链清洗死锁让正确指纹也握手失败）
        val error = handshakeWith(leaf, pinning)
        assertEquals(null, error)
    }

    @Test
    fun `tls handshake fails structurally when server leaf is not pinned`() {
        val leaf = TestCertificates.selfSigned("relay-handshake-bad")
        val unrelated = TestCertificates.selfSigned("relay-unrelated-2")
        val pinning = TlsPinningConfig(listOf("sha256/${unrelated.spkiSha256Hex}"))
        val error = handshakeWith(leaf, pinning) ?: fail("non-pinned server must not complete handshake")
        assertTrue("expected SSLException, got $error", error is SSLException)
        // 结构化拒绝面沿异常链可见：拒绝理由 = 叶 SPKI ∉ pins（绝不静默、绝不 trust-all）
        val messages = generateSequence(error as Throwable) { it.cause }.map { it.message ?: "" }.toList()
        assertTrue(
            "structured pin refusal must surface along the exception chain, got: $messages",
            messages.any { it.contains("not in configured pins") },
        )
    }
}
