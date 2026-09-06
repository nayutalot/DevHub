package com.devhub.mobile.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

/**
 * M3-C6c bug#4 单测：指纹保存层校验门（C2c 实录 fail-open 闭环）——
 * - 残行（丢 `sha256/` 前缀 / 长度错 / 非 hex / 解码非 32 字节）保存即拒
 *   （曾保存放行、pair 时才 BAD_CONFIG）；
 * - 合法形态（64 位 hex 大小写不敏感 / 等价 base64）通过并归一化（复用 :core
 *   TlsPinningConfig 构造期 fail-fast，与连接层绝不双标）；
 * - 空/空白 → Ok(null)（不启用 pinning 属合法保存；引导文案在 GatewayConfigScreen 展示）；
 * - local 模式不校验（表单无此字段，恒 Ok(null)）。
 */
class PinFingerprintSaveGateTest {

    private fun hex64(byte: Int): String = List(32) { String.format("%02x", byte) }.joinToString("")

    @Test
    fun `valid hex fingerprint passes and normalizes to lowercase sha256 form`() {
        val verdict = PinFingerprintSaveGate.check("relay", "sha256/" + hex64(0xAB))
        assertTrue("expected Ok, got $verdict", verdict is PinFingerprintSaveGate.Verdict.Ok)
        assertEquals("sha256/" + hex64(0xAB), (verdict as PinFingerprintSaveGate.Verdict.Ok).normalized)
    }

    @Test
    fun `uppercase hex input is accepted and normalized`() {
        val verdict = PinFingerprintSaveGate.check("relay", "SHA256/" + hex64(0xCD).uppercase())
        assertTrue(verdict is PinFingerprintSaveGate.Verdict.Ok)
        assertEquals("sha256/" + hex64(0xCD), (verdict as PinFingerprintSaveGate.Verdict.Ok).normalized)
    }

    @Test
    fun `equivalent base64 form passes`() {
        val bytes = ByteArray(32) { it.toByte() }
        val b64 = Base64.getEncoder().encodeToString(bytes)
        val verdict = PinFingerprintSaveGate.check("relay", "sha256/$b64")
        assertTrue("base64 form (32-byte body) must pass, got $verdict", verdict is PinFingerprintSaveGate.Verdict.Ok)
    }

    @Test
    fun `prefix-less residue is rejected at save time`() {
        // C2c 实录形态：丢 sha256/ 前缀的 64 hex 残行曾保存放行
        val verdict = PinFingerprintSaveGate.check("relay", hex64(0xAB))
        assertTrue("prefix-less residue must be rejected, got $verdict", verdict is PinFingerprintSaveGate.Verdict.Invalid)
        assertTrue(
            "refusal must be diagnosable, got: ${(verdict as PinFingerprintSaveGate.Verdict.Invalid).message}",
            verdict.message.contains("sha256/"),
        )
    }

    @Test
    fun `wrong length is rejected`() {
        assertTrue(PinFingerprintSaveGate.check("relay", "sha256/abcd") is PinFingerprintSaveGate.Verdict.Invalid)
        assertTrue(
            PinFingerprintSaveGate.check("relay", "sha256/" + hex64(0xAB).dropLast(1))
                is PinFingerprintSaveGate.Verdict.Invalid,
        )
    }

    @Test
    fun `non-hex 64 chars are rejected`() {
        val notHex = "z".repeat(64)
        assertTrue(PinFingerprintSaveGate.check("relay", "sha256/$notHex") is PinFingerprintSaveGate.Verdict.Invalid)
    }

    @Test
    fun `rotation window two entries pass joined normalized in order`() {
        val verdict = PinFingerprintSaveGate.check("relay", "sha256/${hex64(0x01)},\nsha256/${hex64(0x02)}")
        assertTrue(verdict is PinFingerprintSaveGate.Verdict.Ok)
        assertEquals(
            "sha256/${hex64(0x01)},sha256/${hex64(0x02)}",
            (verdict as PinFingerprintSaveGate.Verdict.Ok).normalized,
        )
    }

    @Test
    fun `blank input in relay mode passes as empty - pinning disabled is a legal save`() {
        val verdict = PinFingerprintSaveGate.check("relay", "   ")
        assertTrue(verdict is PinFingerprintSaveGate.Verdict.Ok)
        assertNull((verdict as PinFingerprintSaveGate.Verdict.Ok).normalized)
        assertNull(PinFingerprintSaveGate.check("relay", null).let { (it as PinFingerprintSaveGate.Verdict.Ok).normalized })
    }

    @Test
    fun `local mode never validates fingerprint input`() {
        val verdict = PinFingerprintSaveGate.check("local", "garbage-no-prefix")
        assertTrue(verdict is PinFingerprintSaveGate.Verdict.Ok)
        assertNull((verdict as PinFingerprintSaveGate.Verdict.Ok).normalized)
    }
}
