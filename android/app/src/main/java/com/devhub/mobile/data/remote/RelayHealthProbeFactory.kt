package com.devhub.mobile.data.remote

import com.devhub.mobile.core.TlsPinningConfig
import com.devhub.mobile.core.relay.RelayEndpoint

/**
 * 「测试连接」探测构造结果（M3-C7b 修 ④：构造入 try 的可测试封装）。
 *
 * 崩溃向量（C2d 实证）：GatewayConfigScreen 原 relay 分支的 TlsPinningConfig /
 * GatewayApi 构造在 try 外——TlsPinningConfig 构造期归一化（TlsPinning.normalize
 * → normalizeBody）对非法指纹体（输入框残留拼接，如 `sha256/` 空体、64 位非 hex、
 * base64 解码非 32 字节）抛 IllegalArgumentException，直接出协程杀进程。
 * 本工厂把「解析指纹 → 构造 pinning → 构造 GatewayApi」整体收进 try，失败折
 * [RelayProbeBuildResult.Invalid] 结构化错误提示（零堆栈零凭据），绝不向调用方
 * 抛异常。保存门的指纹校验（PinFingerprintSaveGate）是独立防线，本修不触碰。
 */
internal sealed interface RelayProbeBuildResult {
    /** 构造成功（未发起任何网络请求；health() 调用归调用方既有 try 面）。 */
    data class Ok(val api: GatewayApi) : RelayProbeBuildResult

    /** 构造失败 = 非法指纹体（IllegalArgumentException 折结构化提示）。 */
    data class Invalid(val message: String) : RelayProbeBuildResult
}

internal object RelayHealthProbeFactory {
    /**
     * relay 探测客户端构造（https /v1/health 面，docs/18 §7.1）：指纹解析规则与
     * 原屏幕内联逻辑逐字一致（逗号/换行/分号分隔，trim，空段丢弃，全空 = 不启用
     * pinning）；pin pattern = 具体 host（IP 字面量直接用，绝不通配符——M3-C3a 修 2）。
     */
    fun buildRelay(endpoint: RelayEndpoint, rawFingerprints: String): RelayProbeBuildResult {
        return try {
            val pinning = rawFingerprints.split(',', '\n', ';')
                .map { it.trim() }
                .filter { it.isNotEmpty() }
                .takeIf { it.isNotEmpty() }
                ?.let { TlsPinningConfig(it) }
            RelayProbeBuildResult.Ok(
                GatewayApi(
                    baseUrlProvider = { "https://${endpoint.host}:${endpoint.port}" },
                    tokenProvider = { null },
                    tlsPinning = pinning,
                    pinHost = endpoint.host,
                ),
            )
        } catch (err: IllegalArgumentException) {
            RelayProbeBuildResult.Invalid(
                "TLS 指纹格式非法（docs/19 §10.2）：${err.message ?: "须为 sha256/ + 64 位 hex，或可解码为 32 字节的 base64"}",
            )
        }
    }
}
