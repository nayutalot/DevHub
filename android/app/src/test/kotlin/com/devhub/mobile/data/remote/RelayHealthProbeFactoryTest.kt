package com.devhub.mobile.data.remote

import com.devhub.mobile.core.TlsPinningConfig
import com.devhub.mobile.core.relay.RelayEndpoint
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

/**
 * M3-C7b 修 4 单测：「测试连接」探测构造崩溃包裹（C2d 实证崩溃向量闭环）——
 * - 非法指纹体（输入框残留拼接：`sha256/` 空体 / 64 位非 hex / base64 解码非 32
 *   字节）→ 构造折 [RelayProbeBuildResult.Invalid] 结构化错误（非空、零堆栈面），
 *   **绝不向调用方抛异常**（原实现直接杀进程）；
 * - 合法指纹（64 位 hex 大小写不敏感 / 等价 base64，多条混合分隔）→ Ok；
 * - 空指纹串 → Ok（不启用 pinning 属合法探测面，与保存门 Ok(null) 同语义）；
 * - 底层向量直证：TlsPinningConfig 对非法体确实抛 IllegalArgumentException
 *   （证明包裹点是真实崩溃位，测试防回归锚）。
 */
class RelayHealthProbeFactoryTest {

    private fun endpoint(): RelayEndpoint = RelayEndpoint.parse("wss://59.110.149.11")

    private fun hex64(seed: Int): String = List(32) { String.format("%02x", (seed + it) and 0xFF) }.joinToString("")

    @Test
    fun `empty body residue sha256 prefix folds to structured Invalid instead of crashing`() {
        val result = RelayHealthProbeFactory.buildRelay(endpoint(), "sha256/")
        assertTrue("expected Invalid, got $result", result is RelayProbeBuildResult.Invalid)
        val invalid = result as RelayProbeBuildResult.Invalid
        assertTrue("structured message must be non-blank", invalid.message.isNotBlank())
        // U2-M3（AUDIT P2#6）：用户面文案不再引用内部文档编号（原锁「message must cite
        // the doc anchor docs/19」随批退役）——规则本身语义保留，人话可读
        assertTrue("message must state the rule in human language", invalid.message.contains("TLS 指纹格式非法"))
        assertTrue("message must not leak internal doc anchors", !invalid.message.contains("docs/19"))
    }

    @Test
    fun `64-char non-hex body folds to structured Invalid instead of crashing`() {
        val result = RelayHealthProbeFactory.buildRelay(endpoint(), "sha256/" + "z".repeat(64))
        assertTrue(result is RelayProbeBuildResult.Invalid)
    }

    @Test
    fun `base64 decoding to wrong byte length folds to structured Invalid instead of crashing`() {
        val short = Base64.getEncoder().encodeToString(ByteArray(16))
        val result = RelayHealthProbeFactory.buildRelay(endpoint(), "sha256/$short")
        assertTrue(result is RelayProbeBuildResult.Invalid)
    }

    @Test
    fun `residue concatenation across separators folds to Invalid`() {
        // C2d 复现向量形态：输入框残留拼接（合法段 + 非法段混合分隔）
        val raw = "sha256/${hex64(1)},\n  sha256/   ;sha256/zz"
        val result = RelayHealthProbeFactory.buildRelay(endpoint(), raw)
        assertTrue(result is RelayProbeBuildResult.Invalid)
    }

    @Test
    fun `valid mixed hex and base64 fingerprints build Ok`() {
        val b64 = Base64.getEncoder().encodeToString(ByteArray(32) { it.toByte() })
        val raw = "sha256/${hex64(2).uppercase()}, sha256/$b64"
        val result = RelayHealthProbeFactory.buildRelay(endpoint(), raw)
        assertTrue("expected Ok, got $result", result is RelayProbeBuildResult.Ok)
    }

    @Test
    fun `blank fingerprint input builds Ok without pinning`() {
        val result = RelayHealthProbeFactory.buildRelay(endpoint(), "  ,  \n ")
        assertTrue(result is RelayProbeBuildResult.Ok)
    }

    @Test
    fun `underlying crash vector is real - TlsPinningConfig rejects illegal body`() {
        // 防回归锚：包裹点（构造期归一化）确实会抛——若 :core 行为改变使本测试失败，
        // 说明崩溃向量消失，屏幕包裹退化为纯防御（可留）。
        var thrown: IllegalArgumentException? = null
        try {
            TlsPinningConfig(listOf("sha256/"))
        } catch (err: IllegalArgumentException) {
            thrown = err
        }
        assertTrue("expected IllegalArgumentException from the construction seam", thrown !== null)
    }
}
