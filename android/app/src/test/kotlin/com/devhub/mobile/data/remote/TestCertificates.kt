package com.devhub.mobile.data.remote

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.math.BigInteger
import java.net.InetAddress
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.Signature
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.spec.ECGenParameterSpec
import java.util.Date
import java.util.SimpleTimeZone
import java.text.SimpleDateFormat

/**
 * JVM 单测专用自签证书工厂（零第三方依赖，最小手写 DER/ASN.1）。
 *
 * 生成 EC P-256 密钥对 + 自签 v3 证书（subject==issuer，SHA256withECDSA，可选 IPv4
 * SAN），解析回 [X509Certificate] 并给出 SPKI sha256 指纹（小写 hex——与 :core
 * `TlsPinningConfig` 消费的 `sha256/{hex}` 形态一致）。
 *
 * 仅存在于 test 源集：测试自造信任物料是受控夹具，**绝不**改变生产信任模型
 * （docs/19 §10.2 pin-only；§10.5 自签 CA 绝不入 App——本文件不是 CA 分发）。
 */
internal object TestCertificates {

    data class SelfSigned(
        val certificate: X509Certificate,
        val keyPair: KeyPair,
        /** SPKI（SubjectPublicKeyInfo DER）sha256，64 位小写 hex（不带 `sha256/` 前缀）。 */
        val spkiSha256Hex: String,
    )

    /**
     * 自签 v3 证书。ipSans 需要时生成 GeneralName [7] iPAddress（IPv4）——仅
     * HostnameVerifier 默认面的测试需要；纯 TrustManager/裸套接字测试可不传。
     */
    fun selfSigned(commonName: String, ipSans: List<String> = emptyList()): SelfSigned {
        val keyPair = KeyPairGenerator.getInstance("EC").apply {
            initialize(ECGenParameterSpec("secp256r1"))
        }.generateKeyPair()

        val notBefore = Date(System.currentTimeMillis() - 3_600_000L)
        val notAfter = Date(System.currentTimeMillis() + 365L * 24 * 3_600_000L)

        val signatureAlgId = der(0x30, oid("1.2.840.10045.4.3.2")) // ecdsa-with-SHA256（无参数）
        val name = sequenceOfNames(commonName)
        val validity = der(0x30, utcTime(notBefore) + utcTime(notAfter))
        val spki = keyPair.public.encoded // 标准 SubjectPublicKeyInfo DER，直接拼装

        val tbsParts = mutableListOf(
            der(0xA0, intBytes(byteArrayOf(0x02))), // [0] EXPLICIT version = v3 (INTEGER 2)
            intBytes(BigInteger(64, SecureRandom()).or(BigInteger.ONE).toByteArray()),
            signatureAlgId,
            name,
            validity,
            name,
            spki,
        )
        if (ipSans.isNotEmpty()) {
            val generalNames = ipSans.map { der(0x87, InetAddress.getByName(it).address) }
                .reduce { acc, bytes -> acc + bytes }
            val subjectAltName = der(0x30, oid("2.5.29.17") + der(0x04, der(0x30, generalNames)))
            tbsParts.add(der(0xA3, der(0x30, subjectAltName))) // [3] EXPLICIT extensions
        }
        val tbs = der(0x30, tbsParts.reduce { acc, bytes -> acc + bytes })

        val signature = Signature.getInstance("SHA256withECDSA").apply {
            initSign(keyPair.private)
            update(tbs)
        }.sign() // 已是 DER ECDSA-Sig-Value（SEQUENCE { r INTEGER, s INTEGER }）

        val certificateDer = der(0x30, tbs + signatureAlgId + der(0x03, byteArrayOf(0) + signature))
        val certificate = CertificateFactory.getInstance("X.509")
            .generateCertificate(ByteArrayInputStream(certificateDer)) as X509Certificate

        val spkiSha256Hex = MessageDigest.getInstance("SHA-256").digest(keyPair.public.encoded)
            .joinToString("") { "%02x".format(it) }
        return SelfSigned(certificate, keyPair, spkiSha256Hex)
    }

    /** CN 单值 Name：SEQUENCE { SET { SEQUENCE { OID 2.5.4.3, UTF8String } } }。 */
    private fun sequenceOfNames(commonName: String): ByteArray =
        der(0x30, der(0x31, der(0x30, oid("2.5.4.3") + der(0x0C, commonName.toByteArray(Charsets.UTF_8)))))

    private fun der(tag: Int, content: ByteArray): ByteArray {
        val out = ByteArrayOutputStream()
        out.write(tag)
        if (content.size < 0x80) {
            out.write(content.size)
        } else {
            val lengthBytes = mutableListOf<Byte>()
            var remaining = content.size
            while (remaining > 0) {
                lengthBytes.add((remaining and 0xff).toByte())
                remaining = remaining ushr 8
            }
            out.write(0x80 or lengthBytes.size)
            for (i in lengthBytes.indices.reversed()) out.write(lengthBytes[i].toInt() and 0xff)
        }
        out.write(content)
        return out.toByteArray()
    }

    private fun intBytes(valueBytes: ByteArray): ByteArray = der(0x02, valueBytes)

    /** ObjectIdentifier：base-128 编码（首子标识 = first*40 + second）。 */
    private fun oid(dotted: String): ByteArray {
        val parts = dotted.split('.').map { it.toLong() }
        val body = ByteArrayOutputStream()
        body.write((parts[0] * 40 + parts[1]).toInt())
        for (part in parts.drop(2)) {
            val bytes = mutableListOf<Byte>()
            bytes.add((part and 0x7f).toByte())
            var remaining = part ushr 7
            while (remaining > 0) {
                bytes.add(((remaining and 0x7f) or 0x80L).toByte())
                remaining = remaining ushr 7
            }
            for (i in bytes.indices.reversed()) body.write(bytes[i].toInt() and 0xff)
        }
        return der(0x06, body.toByteArray())
    }

    private fun utcTime(date: Date): ByteArray {
        val format = SimpleDateFormat("yyMMddHHmmss'Z'")
        format.timeZone = SimpleTimeZone(0, "UTC")
        return der(0x17, format.format(date).toByteArray(Charsets.US_ASCII))
    }
}
