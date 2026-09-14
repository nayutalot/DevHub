package com.devhub.mobile.core

/**
 * R1 消息分段模型（任务书 §2 R1 契约：segments = [{kind:'text'|'thinking'|'toolInvocation', label?, content}]）。
 *
 * 纪律（红线 1）：
 * - segments 字段缺失/为空 → normalize 返回 null，调用方回退整段纯文本（contentRedacted），绝不启发式切分；
 * - kind 未识别 → 该段按 text 处理（保留内容可见，不猜语义）；
 * - thinking 段默认收起，行头显示「💭 思维链 · N 字」（N = content.codePointCount，按用户可感知字数）。
 */
object MessageSegments {
    const val KIND_TEXT = "text"
    const val KIND_THINKING = "thinking"
    const val KIND_TOOL = "toolInvocation"

    /** 服务端原始段（App 侧从 JSON opt 容忍解析而来；:core 不依赖 org.json）。 */
    data class RawSegment(val kind: String?, val label: String?, val content: String?)

    sealed class Segment {
        data class Text(val content: String) : Segment()
        data class Thinking(val content: String) : Segment()
        data class ToolInvocation(val label: String?, val content: String) : Segment()
    }

    /**
     * 归一化：null/空白列表 → null（调用方回退纯文本）；未知 kind → text；
     * 纯空白 text 段丢弃（渲染噪声），其余内容原样保留顺序。
     */
    fun normalize(raw: List<RawSegment>?): List<Segment>? {
        if (raw == null || raw.isEmpty()) return null
        val out = ArrayList<Segment>(raw.size)
        for (r in raw) {
            val content = r.content ?: ""
            when (r.kind) {
                KIND_THINKING ->
                    if (content.isNotEmpty()) out.add(Segment.Thinking(content))
                KIND_TOOL ->
                    if (content.isNotEmpty() || !r.label.isNullOrBlank()) {
                        out.add(Segment.ToolInvocation(label = r.label?.takeIf { it.isNotBlank() }, content = content))
                    }
                KIND_TEXT, null, "" ->
                    if (content.isNotBlank()) out.add(Segment.Text(content))
                // 未识别 kind：内容按 text 保留（不猜语义，不丢内容）
                else -> if (content.isNotBlank()) out.add(Segment.Text(content))
            }
        }
        return out.ifEmpty { null }
    }

    /** 折叠行字数（按 code point 计数，emoji/增补平面按 1 计）。 */
    fun thinkingCharCount(content: String): Int = content.codePointCount(0, content.length)

    /** 折叠行文案（UX-P1 X4：「思维链」→「思考过程」）：「💭 思考过程 · N 字」。 */
    fun thinkingFoldLabel(content: String): String = "💭 思考过程 · ${thinkingCharCount(content)} 字"
}
