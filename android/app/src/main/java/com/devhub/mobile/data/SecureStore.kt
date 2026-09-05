package com.devhub.mobile.data

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * SecureStore —— 设备 Token 的本机加密存储（docs/15 §3：Token 明文仅 claim 响应一次性出现）。
 *
 * 方案（环境事实注记）：androidx.security:security-crypto（EncryptedSharedPreferences）
 * 自 2024 年起已废弃；本实现直接使用 AndroidKeyystore AES-256-GCM：
 * - 密钥生成于 AndroidKeyStore（不可导出，TINYKEBAB 硬件级保护视设备而定）；
 * - 每次加密随机 12B IV + 128-bit GCM tag，密文 Base64 后落 SharedPreferences；
 * - 解密失败（换机恢复/密钥失效）→ 视为未配对（返回 null 并清除残留密文）。
 * 红线：任何日志调用前都不得拼入 Token；本类 zero-log。
 */
object SecureStore {
    private const val PREFS = "devhub_secure_prefs"
    private const val KEY_ALIAS = "devhub_token_key"
    private const val KEY_DEVICE_ID = "device_id"
    private const val KEY_TOKEN = "token_enc"
    private const val ANDROID_KEYSTORE = "AndroidKeyStore"
    private const val GCM_TAG_BITS = 128
    private const val IV_BYTES = 12

    private fun prefs(context: Context): SharedPreferences =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun obtainKey(): SecretKey {
        val ks = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (ks.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance("AES", ANDROID_KEYSTORE)
        generator.init(
            android.security.keystore.KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                android.security.keystore.KeyProperties.PURPOSE_ENCRYPT or android.security.keystore.KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(android.security.keystore.KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(android.security.keystore.KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    private fun encryptToBase64(plain: ByteArray): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, obtainKey(), SecureRandom())
        val iv = cipher.iv
        require(iv.size == IV_BYTES) { "unexpected GCM IV length ${iv.size}" }
        val sealed = cipher.doFinal(plain)
        return android.util.Base64.encodeToString(iv + sealed, android.util.Base64.NO_WRAP)
    }

    private fun decryptFromBase64(encoded: String): ByteArray? =
        try {
            val blob = android.util.Base64.decode(encoded, android.util.Base64.NO_WRAP)
            val iv = blob.copyOfRange(0, IV_BYTES)
            val sealed = blob.copyOfRange(IV_BYTES, blob.size)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, obtainKey(), GCMParameterSpec(GCM_TAG_BITS, iv))
            cipher.doFinal(sealed)
        } catch (err: Exception) {
            Log.w("SecureStore", "token decrypt failed (keystore key lost?) → treat as unpaired")
            null
        }

    /** 配对成功：deviceId 明文（非机密）+ Token 密文落库。 */
    fun savePairing(context: Context, deviceId: Long, token: String) {
        val enc = encryptToBase64(token.toByteArray(Charsets.UTF_8))
        prefs(context).edit()
            .putLong(KEY_DEVICE_ID, deviceId)
            .putString(KEY_TOKEN, enc)
            .apply()
    }

    /**
     * M2-R3（docs/18 §3.14 / docs/19 §7.3）：token_rotation 的 TokenStore 原子写入合同：
     * 单条目单事务写入 + 写后读回校验 + 校验失败回滚旧密文（失败 = 旧值原样保留，
     * 调用方按「回退旧值 + 重连」继续，docs/18 §3.14）。零日志红线对 Token 恒成立。
     * @return true = 写入成功且读回一致；false = 失败（旧值仍在）。
     */
    fun rotateToken(context: Context, newToken: String): Boolean {
        val prefs = prefs(context)
        val oldEnc = prefs.getString(KEY_TOKEN, null)
        val newEnc = try {
            encryptToBase64(newToken.toByteArray(Charsets.UTF_8))
        } catch (err: Exception) {
            return false
        }
        prefs.edit().putString(KEY_TOKEN, newEnc).apply()
        // 写后读回校验（合同：不等即回滚）
        if (loadToken(context) == newToken) return true
        if (oldEnc != null) prefs.edit().putString(KEY_TOKEN, oldEnc).apply()
        return false
    }

    fun loadToken(context: Context): String? {
        val enc = prefs(context).getString(KEY_TOKEN, null) ?: return null
        return decryptFromBase64(enc)?.toString(Charsets.UTF_8)
    }

    fun loadDeviceId(context: Context): Long? {
        val raw = prefs(context).getLong(KEY_DEVICE_ID, -1L)
        return if (raw > 0) raw else null
    }

    /** 撤销/失效：清凭据（App 回配对页）。 */
    fun clear(context: Context) {
        prefs(context).edit().clear().apply()
    }
}
