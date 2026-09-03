package com.devhub.mobile.core

/**
 * 脱敏渲染（docs/15 §6）：
 * - 通知/消息/摘要：服务端已是脱敏投影（summary / contentRedacted，密钥类尾 4 位 + 长度），
 *   客户端**直显**，绝不二次加工、绝不在客户端拼接任何未脱敏上下文；
 * - 日志红线：设备 Token（256-bit base64url，43 字符级）绝不落日志——
 *   [LogRedactor.scrub] 作为客户端侧最后一道护栏替换长随机串。
 */
object SummaryRender {
    /** summary 直显（null → 空串；内容原样，不截断不加工）。 */
    fun render(summary: String?): String = summary ?: ""
}

object LogRedactor {
    /** token 形态：≥32 连续 base64url 字符（256-bit base64url 为 43 字符）。 */
    private val tokenLike = Regex("[A-Za-z0-9_-]{32,}")

    fun scrub(message: String): String =
        tokenLike.replace(message) { match -> "<redacted:${match.value.length}>" }

    /** 断言辅助：消息中是否残留疑似 Token 的长随机串。 */
    fun leaksTokenLike(message: String): Boolean = tokenLike.containsMatchIn(message)
}
