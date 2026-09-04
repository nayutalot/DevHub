package com.devhub.mobile.core

/**
 * R8 迷你富文本分词器（纯逻辑；App 侧再映射为 AnnotatedString，禁 WebView/HTML）。
 *
 * 支持（只做有明确语法的最小集合，绝不猜）：
 * - 行内代码 `` `code` `` 与围栏代码块 ``` ``` ```（内容原样保留）；
 * - `**加粗**`（打磨批 D：真实 Claude/子代理长消息大量使用；渲染为粗体，记号不再原样露出）；
 * - markdown 链接 `[label](url)` 与被转义形态 `\[label\]\(url\)`（R8 用户实例）——只渲染 label；
 * - `plugin://` / `skill://` / `mcp://` 引用 → 渲染为「[插件] 名称」式 chip（服务端 segments 路径之外的第二道防线）；
 * - 清理转义符（``\[ \] \( \) \* \_ \- \`` `` 与 `\\`）。
 *
 * 任何输入都不抛异常（调用方无须再包 try/catch 也不会丢内容）；无法识别的部分原样保留为 Plain。
 */
object RichTextTokenizer {

    sealed class RichToken {
        data class Plain(val text: String) : RichToken()
        data class CodeSpan(val code: String) : RichToken()
        data class CodeBlock(val code: String) : RichToken()

        /** `**加粗**`（打磨批 D）：渲染粗体，记号不显示。 */
        data class Bold(val text: String) : RichToken()

        /** markdown 链接：渲染只显示 label（url 仅供参考，不出网）。 */
        data class Link(val label: String, val url: String) : RichToken()

        /** 插件/技能/MCP 引用 chip：display = "[插件] 名称" 式短标签。 */
        data class ReferenceChip(val kindLabel: String, val name: String) : RichToken() {
            val display: String get() = "[$kindLabel] $name"
        }
    }

    const val KIND_PLUGIN = "插件"
    const val KIND_SKILL = "技能"
    const val KIND_MCP = "MCP"

    // 转义占位（私有区字符，避免与正文冲突）：先摘出被转义字符，防止误开代码/链接语法
    private const val P_LB = '\uE000' // \[
    private const val P_RB = '\uE001' // \]
    private const val P_LP = '\uE002' // \(
    private const val P_RP = '\uE003' // \)
    private const val P_BT = '\uE004' // \`
    private const val P_BS = '\uE005' // \\
    private const val P_PL = '\uE006' // \*
    private const val P_US = '\uE007' // \_
    private const val P_DASH = '\uE008' // \-

    private val ESCAPE_MAP: Map<Char, Char> = mapOf(
        '[' to P_LB, ']' to P_RB, '(' to P_LP, ')' to P_RP,
        '`' to P_BT, '\\' to P_BS, '*' to P_PL, '_' to P_US, '-' to P_DASH,
    )

    private val RESTORE_MAP: Map<Char, String> = mapOf(
        P_LB to "[", P_RB to "]", P_LP to "(", P_RP to ")",
        P_BT to "`", P_BS to "\\", P_PL to "*", P_US to "_", P_DASH to "-",
    )

    private val escapedLinkRegex = Regex("${'\uE000'}([^${'\uE001'}\\n]*)${'\uE001'}${'\uE002'}([^${'\uE003'}\\n]*)${'\uE003'}")
    private val plainLinkRegex = Regex("\\[([^\\]\\n]*)\\]\\(([^)\\n]*)\\)")
    private val bareRefRegex = Regex("\\b(plugin|skill|mcp)://[^\\s)\\]}>\uE002\uE003]+")
    private val codeSpanRegex = Regex("`([^`\\n]+)`")
    // **加粗**：非贪婪、不跨行（Java regex 默认 . 不匹配换行）；
    // 在行内代码之后匹配（代码片段区间内的 ** 保持字面量，由重叠保护处理）
    private val boldRegex = Regex("\\*\\*(.+?)\\*\\*")

    fun tokenize(text: String): List<RichToken> {
        if (text.isEmpty()) return emptyList()
        val out = ArrayList<RichToken>()
        var rest = text
        while (true) {
            val fence = findFence(rest) ?: break
            if (fence.before.isNotEmpty()) parseInline(fence.before, out)
            out.add(RichToken.CodeBlock(fence.content))
            rest = fence.after
        }
        if (rest.isNotEmpty()) parseInline(rest, out)
        return if (out.isEmpty()) listOf(RichToken.Plain(text)) else out
    }

    private data class Fence(val before: String, val content: String, val after: String)

    /** 围栏代码块：```（可带语言行）…```；无闭合围栏的尾部按普通文本处理（内容绝不丢弃）。 */
    private fun findFence(text: String): Fence? {
        val open = text.indexOf("```")
        if (open < 0) return null
        val close = text.indexOf("```", open + 3)
        if (close < 0) return null
        var content = text.substring(open + 3, close)
        // 去掉紧随的语言标注行（正文内容原样保留，含结尾换行）
        val nl = content.indexOf('\n')
        val head = if (nl >= 0) content.substring(0, nl) else content
        if (nl in 0..24 && head.matches(Regex("[ \\t]*[A-Za-z0-9+#_.-]*[ \\t]*\\r?"))) {
            content = content.substring(nl + 1)
        }
        return Fence(before = text.substring(0, open), content = content, after = text.substring(close + 3))
    }

    private fun escapePlaceholders(s: String): String {
        if (!s.contains('\\')) return s
        val sb = StringBuilder(s.length)
        var i = 0
        while (i < s.length) {
            val c = s[i]
            if (c == '\\' && i + 1 < s.length) {
                val mapped = ESCAPE_MAP[s[i + 1]]
                if (mapped != null) {
                    sb.append(mapped)
                    i += 2
                    continue
                }
            }
            sb.append(c)
            i += 1
        }
        return sb.toString()
    }

    private fun restore(s: String): String =
        if (s.none { it in '\uE000'..'\uE008' }) s
        else buildString(s.length) {
            for (c in s) append(RESTORE_MAP[c] ?: c.toString())
        }

    private fun schemeKind(url: String): String? {
        val lower = url.lowercase()
        return when {
            lower.startsWith("plugin://") -> KIND_PLUGIN
            lower.startsWith("skill://") -> KIND_SKILL
            lower.startsWith("mcp://") -> KIND_MCP
            else -> null
        }
    }

    /** plugin://a/b/name → "name"（引用 URI 的尾部段作为 chip 名称兜底）。 */
    private fun uriTail(url: String): String {
        val body = url.substringAfter("://")
        return body.substringAfterLast('/').ifBlank { body }
    }

    private class Hit(val start: Int, val end: Int, val token: RichToken)

    private fun parseInline(raw: String, out: MutableList<RichToken>) {
        val work = escapePlaceholders(raw)
        val hits = ArrayList<Hit>()
        val taken = ArrayList<IntRange>()

        fun overlaps(r: IntRange): Boolean = taken.any { it.first <= r.last && r.first <= it.last }

        // 1) 链接（转义形态优先，防止普通链接正则命中同一区间）
        for (m in escapedLinkRegex.findAll(work)) {
            if (!overlaps(m.range)) {
                taken.add(m.range)
                hits.add(Hit(m.range.first, m.range.last + 1, linkToken(m.groupValues[1], m.groupValues[2])))
            }
        }
        for (m in plainLinkRegex.findAll(work)) {
            if (!overlaps(m.range)) {
                taken.add(m.range)
                hits.add(Hit(m.range.first, m.range.last + 1, linkToken(m.groupValues[1], m.groupValues[2])))
            }
        }
        // 2) 裸引用 URI
        for (m in bareRefRegex.findAll(work)) {
            if (!overlaps(m.range)) {
                taken.add(m.range)
                hits.add(Hit(m.range.first, m.range.last + 1, RichToken.ReferenceChip(schemeKind(m.value) ?: KIND_PLUGIN, uriTail(m.value))))
            }
        }
        // 3) 行内代码
        for (m in codeSpanRegex.findAll(work)) {
            if (!overlaps(m.range)) {
                taken.add(m.range)
                hits.add(Hit(m.range.first, m.range.last + 1, RichToken.CodeSpan(restore(m.groupValues[1]))))
            }
        }
        // 4) **加粗**（最后匹配：代码片段/链接区间内的 ** 不开粗体；重叠保护兜底）
        for (m in boldRegex.findAll(work)) {
            if (!overlaps(m.range)) {
                taken.add(m.range)
                hits.add(Hit(m.range.first, m.range.last + 1, RichToken.Bold(restore(m.groupValues[1]).trim('*', ' '))))
            }
        }
        hits.sortBy { it.start }

        var cursor = 0
        for (h in hits) {
            if (h.start < cursor) continue // 区间重叠保护
            val before = restore(work.substring(cursor, h.start))
            if (before.isNotEmpty()) out.add(RichToken.Plain(before))
            out.add(h.token)
            cursor = h.end
        }
        val tail = restore(work.substring(cursor))
        if (tail.isNotEmpty()) out.add(RichToken.Plain(tail))
    }

    /** 链接 token（label/url 已在占位形态）：引用协议 → chip；否则 Link 只显 label。 */
    private fun linkToken(labelRaw: String, urlRaw: String): RichToken {
        val scheme = schemeKind(urlRaw)
        return if (scheme != null) {
            val name = restore(labelRaw).trim().ifBlank { uriTail(urlRaw) }
            RichToken.ReferenceChip(scheme, name)
        } else {
            val label = restore(labelRaw).trim().ifBlank { restore(urlRaw) }
            RichToken.Link(label = label, url = restore(urlRaw))
        }
    }

    /**
     * 标题等短文本的显示层清理（打磨批 D）：去掉 `**` 加粗记号，只在显示层生效
     * （不改缓存/投影数据）。标题单行展示不走富文本渲染，`**` 记号原样露出即噪声。
     * 只清理有明确记号的最小集合（`**`），绝不猜其余语义；清理结果为空白时回退原文。
     */
    fun stripDisplayMarkers(raw: String?): String? {
        if (raw == null) return null
        if (!raw.contains("**")) return raw
        val stripped = raw.replace("**", "").replace(Regex(" {2,}"), " ").trim()
        return stripped.ifBlank { raw }
    }
}
