package com.devhub.mobile.data.remote

import com.devhub.mobile.core.TlsPinningConfig
import okhttp3.CertificatePinner
import okio.ByteString.Companion.decodeHex

/**
 * :core `TlsPinningConfig` → OkHttp `CertificatePinner` 转换（app 层注入缝）。
 *
 * U1 已裁决（2026-09-05，docs/21 §1.1）：无域名 IP TLS——Android 侧信任 = OkHttp
 * CertificatePinner 对服务端证书 SPKI sha256 的指纹锁定（docs/19 §10.2）。
 * - :core 模型归一化产物为 `sha256/{hex}`；OkHttp pin 只接受 `sha256/{base64}`，
 *   此处做唯一一处形态转换（hex → base64）；
 * - pin pattern 用 `*`：CertificatePinner 只作用于 TLS 连接（https/wss），local 模式
 *   ws:// 明文路径不受影响（零回归）；
 * - 双指纹轮换窗口语义（旧+新任一匹配即信任）由 :core `TlsPinningConfig` 的指纹列表
 *   原样映射为多条 pin（docs/19 §10.4）；
 * - **注入式**：relay 模式构造 OkHttpClient 时传入 `TlsPinningConfig`；传 null/不传 =
 *   现行为不变（无 pinning）。relay 模式接线属 R3 批（docs/20 §2.3），本批只铺缝。
 */
fun TlsPinningConfig.toCertificatePinner(): CertificatePinner {
    val builder = CertificatePinner.Builder()
    for (fingerprint in fingerprints) {
        // fingerprint 形态 = "sha256/<64 位小写 hex>"（:core 构造时已校验，此处安全）
        builder.add("*", "sha256/" + fingerprint.removePrefix("sha256/").decodeHex().base64())
    }
    return builder.build()
}
