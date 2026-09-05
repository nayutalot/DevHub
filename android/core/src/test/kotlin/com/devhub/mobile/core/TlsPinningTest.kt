package com.devhub.mobile.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * TlsPinningConfig 单测：无域名 IP TLS 注入式指纹模型（U1 已裁决，docs/21 §1.1 / docs/19 §10）。
 * 覆盖：合法指纹匹配 / 不匹配拒绝 / 旧+新双指纹轮换窗口 / 格式错误 fail-fast / 形态归一化。
 * 指纹值全部为测试用固定向量（32 字节全零 / 递增序列的 hex/base64 形态），非真实部署指纹。
 */
class TlsPinningTest {

    // 32 字节全零的 hex 与 base64 形态（同一指纹的两种合法编码）
    private val zeroHex = "sha256/" + "00".repeat(32)
    private val zeroB64 = "sha256/" + java.util.Base64.getEncoder().encodeToString(ByteArray(32))

    // 32 字节递增序列（0x00..0x1f）——用作「新指纹」
    private val seqBytes = ByteArray(32) { it.toByte() }
    private val seqHex = "sha256/" + seqBytes.joinToString("") { "%02x".format(it) }
    private val seqB64 = "sha256/" + java.util.Base64.getEncoder().encodeToString(seqBytes)

    @Test
    fun `valid hex fingerprint matches itself`() {
        val config = TlsPinningConfig(listOf(zeroHex))
        assertTrue(config.matches(zeroHex))
        assertTrue(config.matches(zeroB64)) // 同一指纹的 base64 形态必须等价匹配
    }

    @Test
    fun `uppercase hex is normalized and matches`() {
        val upper = "SHA256/" + seqHex.removePrefix("sha256/").uppercase()
        val config = TlsPinningConfig(listOf(upper))
        assertTrue(config.matches(seqHex))
        assertEquals(seqHex, config.fingerprints.single())
    }

    @Test
    fun `base64 and hex encodings of the same key are equivalent`() {
        val fromHex = TlsPinningConfig(listOf(seqHex))
        val fromB64 = TlsPinningConfig(listOf(seqB64))
        assertEquals(fromHex.fingerprints, fromB64.fingerprints)
        assertTrue(fromB64.matches(seqHex))
        assertTrue(fromHex.matches(seqB64))
    }

    @Test
    fun `mismatched fingerprint is rejected`() {
        val config = TlsPinningConfig(listOf(zeroHex))
        assertFalse(config.matches(seqHex))
        assertFalse(config.matches("sha256/" + "ff".repeat(32)))
    }

    @Test
    fun `dual fingerprint window - old and new both trusted, third rejected`() {
        // 证书轮换窗口：旧（全零）+ 新（递增序列）同时配置，任一匹配即信任（docs/19 §10.4）
        val window = TlsPinningConfig(listOf(zeroHex, seqHex))
        assertTrue(window.matches(zeroB64)) // 旧证书（服务端未升级侧）
        assertTrue(window.matches(seqHex)) // 新证书（服务端已升级侧）
        assertFalse(window.matches("sha256/" + "ab".repeat(32))) // 窗口外第三枚绝不信任
    }

    @Test
    fun `duplicate fingerprints are deduped preserving semantics`() {
        val config = TlsPinningConfig(listOf(zeroHex, zeroB64, zeroHex))
        assertEquals(1, config.fingerprints.size)
        assertTrue(config.matches(zeroHex))
    }

    @Test
    fun `fail-fast - empty list rejected`() {
        try {
            TlsPinningConfig(emptyList())
            throw AssertionError("empty fingerprints must fail fast")
        } catch (_: IllegalArgumentException) {
            // 预期：空列表 = 配置了 pinning 却什么都不信，绝不静默放行
        }
    }

    @Test
    fun `fail-fast - missing sha256 prefix rejected`() {
        val bare = "00".repeat(32)
        for (bad in listOf(bare, "sha1/$bare", "md5/AAAA")) {
            try {
                TlsPinningConfig(listOf(bad))
                throw AssertionError("'$bad' must fail fast")
            } catch (_: IllegalArgumentException) {
                // 预期
            }
        }
    }

    @Test
    fun `fail-fast - wrong hex length rejected`() {
        for (bad in listOf("sha256/00", "sha256/" + "00".repeat(31), "sha256/" + "00".repeat(33))) {
            try {
                TlsPinningConfig(listOf(bad))
                throw AssertionError("'$bad' must fail fast")
            } catch (_: IllegalArgumentException) {
                // 预期
            }
        }
    }

    @Test
    fun `fail-fast - non-hex 64-char body rejected`() {
        // 64 字符但含非 hex 字符（'g'）
        try {
            TlsPinningConfig(listOf("sha256/" + "g".repeat(64)))
            throw AssertionError("non-hex body must fail fast")
        } catch (_: IllegalArgumentException) {
            // 预期
        }
    }

    @Test
    fun `fail-fast - base64 decoding to wrong byte length rejected`() {
        // 31 字节（非 32）：base64 形态合法但长度错
        val b31 = java.util.Base64.getEncoder().encodeToString(ByteArray(31))
        try {
            TlsPinningConfig(listOf("sha256/$b31"))
            throw AssertionError("31-byte base64 must fail fast")
        } catch (_: IllegalArgumentException) {
            // 预期
        }
        // 33 字节同理
        val b33 = java.util.Base64.getEncoder().encodeToString(ByteArray(33))
        try {
            TlsPinningConfig(listOf("sha256/$b33"))
            throw AssertionError("33-byte base64 must fail fast")
        } catch (_: IllegalArgumentException) {
            // 预期
        }
    }

    @Test
    fun `url-safe base64 without padding is accepted`() {
        val standard = java.util.Base64.getEncoder().encodeToString(seqBytes) // 带 padding
        val urlSafe = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(seqBytes)
        assertNotEquals(standard, urlSafe) // 形态确实不同
        assertTrue(TlsPinningConfig(listOf("sha256/$urlSafe")).matches(seqHex))
    }

    @Test
    fun `matches on malformed candidate fails fast rather than returning false`() {
        val config = TlsPinningConfig(listOf(zeroHex))
        try {
            config.matches("not-a-fingerprint")
            throw AssertionError("malformed candidate must fail fast")
        } catch (_: IllegalArgumentException) {
            // 预期：候选来自受控解码路径，格式异常应立即暴露
        }
    }
}
