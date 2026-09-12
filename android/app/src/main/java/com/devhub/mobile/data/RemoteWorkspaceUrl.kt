package com.devhub.mobile.data

/**
 * 远程工作区 URL 纯函数面（Q 批「远程工作区」屏）：校验白名单 / 剪贴板检出 /
 * 缺省标题 / 敏感 URL 中段省略。全部纯函数零 Android 依赖，:app 单测直锁
 * （任务书 §2.2：校验拒绝面/剪贴板 http 检出/标题缺省 host）。
 *
 * 安全口径（任务书 §1.4）：URL 校验 `https?://` 之外一律拒绝（BAD_PAYLOAD 风格
 * 结构化提示）；URL 可能内嵌动态会话令牌——按敏感对待，零入日志、零外发，
 * UI 展示一律走 [elideMiddle] 中段省略。
 */
object RemoteWorkspaceUrl {

    /**
     * 结构化拒绝提示（UI 与测试共用同一文案常量，绝不双标）。
     * U2-M3（AUDIT P3#5）：用户面 headline 只讲规则，不再直出 BAD_PAYLOAD 码
     * （码语义归网关结构化错误面 ErrorPresent 承载；本地表单拒绝无需前置曝码）。
     */
    const val REJECT_REASON: String = "URL 校验失败：仅接受 http(s):// 链接，其余一律拒绝"

    /** 结构化校验结果：Ok(规范化 url) / Rejected(理由)。 */
    sealed interface Verdict {
        data class Ok(val url: String) : Verdict
        data class Rejected(val reason: String) : Verdict
    }

    private const val MAX_LENGTH = 2048

    /**
     * 严格校验：trim 后必须 `http://` 或 `https://` 开头（大小写不敏感），
     * host 非空；含空白/控制字符、超长（>2048）一律拒绝。
     * 返回 Ok 时 url = trim 后原样（不改写 query——动态令牌页改写即失效）。
     */
    fun parse(raw: String?): Verdict {
        val trimmed = raw?.trim().orEmpty()
        if (trimmed.isEmpty() || trimmed.length > MAX_LENGTH) return Verdict.Rejected(REJECT_REASON)
        if (trimmed.any { it.isWhitespace() || it.isISOControl() }) return Verdict.Rejected(REJECT_REASON)
        val scheme = trimmed.substringBefore("://", missingDelimiterValue = "").lowercase()
        if (scheme != "http" && scheme != "https") return Verdict.Rejected(REJECT_REASON)
        val authority = trimmed.substringAfter("://")
            .substringBefore('/')
            .substringBefore('?')
            .substringBefore('#')
        val host = authority.substringBeforeLast(':') // 去 port（含 IPv6 尾段粗剥，host 空判足够）
        if (host.isBlank()) return Verdict.Rejected(REJECT_REASON)
        return Verdict.Ok(trimmed)
    }

    /** 分享文本里链接尾部常见的标点（截除，不损伤常规 URL 主体）。 */
    private val TRAILING_NOISE = charArrayOf(
        ')', '>', ']', '}', '.', ',', ';', ':', '!', '?', '"', '\'', '’', '”',
        '，', '。', '；', '！', '？', '）', '》', '」', '』', '、',
    )

    private val URL_IN_TEXT = Regex("https?://\\S+", RegexOption.IGNORE_CASE)

    /**
     * 剪贴板 http(s) 检出：从任意文本提取第一个 http(s) 链接（截除尾部标点），
     * 再过 [parse] 同一校验面（绝不双标）；无合法链接返回 null——
     * 「从剪贴板填入」按钮仅在此非 null 时亮（任务书 §1.2）。
     */
    fun extractFromClipboard(text: String?): String? {
        if (text.isNullOrBlank()) return null
        val match = URL_IN_TEXT.find(text) ?: return null
        var candidate = match.value
        while (candidate.isNotEmpty() && candidate.last() in TRAILING_NOISE) {
            candidate = candidate.dropLast(1)
        }
        return when (val verdict = parse(candidate)) {
            is Verdict.Ok -> verdict.url
            is Verdict.Rejected -> null
        }
    }

    /** 缺省标题取 URL host（去端口）；解析不出 host 时回退「未命名页面」。 */
    fun defaultTitle(url: String): String {
        val host = try {
            java.net.URI(url).host
        } catch (_: Exception) {
            null
        }
        return host?.takeIf { it.isNotBlank() } ?: "未命名页面"
    }

    /**
     * 敏感 URL 展示：中段省略（first head 字符 … last tail 字符）——
     * query 里的会话令牌通常落在中段，展示面不可见；短于阈值原样返回。
     */
    fun elideMiddle(url: String, head: Int = 28, tail: Int = 6): String =
        if (url.length <= head + tail + 1) url
        else url.take(head) + "…" + url.takeLast(tail)
}
