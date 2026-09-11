package com.devhub.mobile.core

import java.io.IOException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.net.ssl.SSLException

/**
 * U1-M3（AUDIT P1#3 + P2#10）：统一错误呈现层（纯函数，:core 单测直锁）。
 *
 * 纪律（承接 20-relay-test-error.png 实证缺陷）：
 * - 用户面 = 一句人话 + 建议动作；绝不直出异常类名/内网 IP/端口/原始错误码；
 * - 绝不吞码：technical 恒携带原始异常/错误码，UI 以「技术细节」折叠区承载
 *   （默认收起）——诚实纪律：翻译不删除；
 * - 已知异常族（SocketTimeout/Connect/UnknownHost/SSL/IOException）逐一映射；
 * - 已知 ApiError 码（NOT_FOUND 按调用面语境化、鉴权族、BAD_PAYLOAD、指令族）
 *   逐一映射；未知码回退通用人话，原码仍收进 technical。
 */
object ErrorPresent {

    /** 呈现体：headline = 用户面人话；technical = 原始异常/错误码（可折叠，null = 无）。 */
    data class Presentable(val headline: String, val technical: String? = null)

    /** 语境化文案的调用面（同一错误码在不同请求面的人话不同）。 */
    enum class Surface {
        /** 通用（无特定语境）。 */
        GENERIC,

        /** GET /v1/devices（设备页）——P2#10 relay NOT_FOUND 语境。 */
        DEVICE_LIST,

        /** relay 探测（配置页「测试连接」relay 分支）。 */
        RELAY_PROBE,

        /** 本地网关探测（配置页「测试连接」local 分支）。 */
        GATEWAY_PROBE,

        /** 会话消息/详情拉取。 */
        SESSION_MESSAGES,

        /** 控制指令提交（reply/pause/resume/approve/interrupt/撤销）。 */
        COMMAND,
    }

    /**
     * IOException 族 → 人话分类。匹配顺序敏感：SocketTimeout（超时）/
     * SSL（证书）→ UnknownHost（解析）→ Connect（拒绝）→ 其他 IOException。
     * 非 IO 异常（不应到达此处，防御兜底）→ 通用人话；technical 原样保留。
     */
    fun io(err: Throwable): Presentable = when (err) {
        is SocketTimeoutException -> Presentable(
            "连接超时：请检查网络或网关地址后重试",
            err.toString(),
        )

        is SSLException -> Presentable(
            "TLS/证书校验失败：自签证书需在「证书指纹（高级，可选）」配置 SPKI sha256 指纹",
            err.toString(),
        )

        is UnknownHostException -> Presentable(
            "主机名无法解析：请检查地址拼写",
            err.toString(),
        )

        is ConnectException -> Presentable(
            "无法建立连接：请确认桌面 Gateway 已启用、地址与端口正确",
            err.toString(),
        )

        is IOException -> Presentable(
            "网络不可达：请检查设备网络后重试",
            err.toString(),
        )

        else -> Presentable(
            "发生未知错误：请重试",
            err.toString(),
        )
    }

    /**
     * 网关/中继结构化错误（ApiError 的 code/message 投影）→ 人话。
     * NOT_FOUND 在 DEVICE_LIST 面 = P2#10：relay 接入点不路由 /v1/devices
     * （ECS 终结 REST），不是设备被删——人话点名，勿改桌面服务端。
     */
    fun api(code: String, message: String, surface: Surface = Surface.GENERIC): Presentable {
        val technical = "[$code] $message"
        val headline = when {
            code == "NOT_FOUND" -> when (surface) {
                Surface.DEVICE_LIST -> "当前接入点不提供设备列表；设备信息请切换本地模式查看"
                Surface.SESSION_MESSAGES -> "会话不存在或已被删除"
                else -> "请求的资源不存在"
            }

            code in AUTH_CODES -> "登录已失效：请重新配对"

            code == "BAD_PAYLOAD" -> "请求被网关拒绝：App 与网关版本可能不匹配"

            code == "COMMAND_NOT_EXECUTABLE" -> "当前会话未授予该操作能力"

            code == "AGENT_CAPABILITY_MISSING" -> "能力未验证或已过期：请先在桌面端重新探测"

            code == "COMMAND_EXPIRED" -> "指令已过期：请重试"

            code == "ZCODE_LINK_UNAVAILABLE" -> "桌面暂无法获取 ZCode 工作区链接（ZCode 未运行或凭据不可读）"

            else -> when (surface) {
                Surface.COMMAND -> "指令被网关拒绝"
                Surface.RELAY_PROBE -> "Relay 可达但返回错误"
                Surface.GATEWAY_PROBE -> "网关可达但返回错误"
                else -> "请求未成功，请稍后重试"
            }
        }
        return Presentable(headline, technical)
    }

    private val AUTH_CODES = setOf("AUTH_INVALID_TOKEN", "DEVICE_REVOKED", "DEVICE_NOT_PAIRED")
}
