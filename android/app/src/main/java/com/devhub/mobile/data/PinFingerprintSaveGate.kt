package com.devhub.mobile.data

import com.devhub.mobile.core.TlsPinningConfig

/**
 * 指纹保存层校验门（M3-C6c bug#4，C2c 实录 fail-open 闭环）：
 * - 指纹残行（如丢 `sha256/` 前缀 / 长度错 / 非 hex）曾保存零校验 → pair 时才 BAD_CONFIG
 *   （错误暴露点后移到连接期，用户在配置页得不到反馈）——现保存即拒；
 * - 空/空白指纹在 relay 模式曾静默放行 → 连接层才 fail-closed（"Trust anchor not found"，
 *   自签 IP 证书不受系统信任属预期 docs/19 §10.5）——现保存放行不变（不硬阻断），但
 *   GatewayConfigScreen 对该形态展示引导文案（提示必须配置指纹的原因与入口）。
 *
 * 校验复用 :core [TlsPinningConfig] 构造期 fail-fast（同一语义，绝不双标——与连接层
 * `ConnectionManager.parsePinning` 同拆分规则：逗号/换行/分号分隔）。纯 JVM（零 Android
 * 依赖），GatewayConfigScreen 保存前调用；单测直测本门。
 */
object PinFingerprintSaveGate {

    sealed class Verdict {
        /**
         * 通过。normalized = 归一化后待持久化文本（`sha256/<小写hex>` 逗号连接，顺序保持）；
         * null = 空/空白输入（不启用 pinning，属合法配置——连接层系统默认信任）。
         */
        data class Ok(val normalized: String?) : Verdict()

        /** 格式非法：message 为 :core fail-fast 原文（可诊断），保存阻断。 */
        data class Invalid(val message: String) : Verdict()
    }

    /**
     * @param mode 已选连接模式（local | relay）；仅 relay 模式校验指纹（local 恒 [Verdict.Ok]，
     *   指纹字段在 local 表单不存在）。
     * @param raw 指纹输入原文（逗号/换行/分号分隔，可空/空白）。
     */
    fun check(mode: String, raw: String?): Verdict {
        val entries = raw
            ?.split(',', '\n', ';')
            ?.map { it.trim() }
            ?.filter { it.isNotEmpty() }
            ?: emptyList()
        if (mode != "relay" || entries.isEmpty()) return Verdict.Ok(null)
        return try {
            // fail-fast 上移：构造即逐条校验（前缀/长度/字符/解码 32 字节），任一非法即拒
            val config = TlsPinningConfig(entries)
            Verdict.Ok(config.fingerprints.joinToString(","))
        } catch (err: IllegalArgumentException) {
            Verdict.Invalid(err.message ?: "指纹格式非法")
        }
    }
}
