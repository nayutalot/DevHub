package com.devhub.mobile.core

/**
 * U3 批（AUDIT P3#1）会话气泡 markdown 子集解析器：纯函数、零第三方依赖、
 * 容忍任意畸形输入（绝不抛异常），同风格 ErrorPresent / SessionTitleOps。
 *
 * 块级子集：
 * - ATX 标题 `#`~`######`（记号后须空格/制表/行尾；7 个以上 `#` 不是标题）；
 * - 段落（连续非结构行，按原文保留换行拼合）；
 * - 无序列表项 `- ` `+ ` `* `、有序列表项 `1.` `2)`（记号后须空格/行尾；单层，不做嵌套缩进）；
 * - 表格（GFM 简化：表头行含 `|` + 紧随分隔行所有单元格为 `:?-+:?`，分隔行须含 `|`
 *   以排除 setext 下划线误判；表体 = 连续含 `|` 非空行；缺格补空、多格扩列，内容零丢失；
 *   对齐冒号只容忍不投影）；
 * - 围栏代码块 ```（信息行识别但不渲染，内容逐行原样保留；无闭合围栏 → 整体回退纯文本，
 *   与 RichTextTokenizer 同纪律）。
 *
 * 行内子集（MarkdownOps.parseInline）：
 * - `**加粗**`（内部可含 `` `行内 code` `` 一层，加粗内 code 即止，不再更深）；
 * - `` `行内 code` ``（不跨行，内容原样）；
 * - `*斜体*`（可选做，保守匹配：开记号须在行首/空白之后，内容不含空白边界与 `*`，
 *   `2*3*4` 等算式不误判）；
 * - 纯文本。
 *
 * 子集外（链接/图片/引用块/任务列表/脚注/HTML 透传/缩进代码/嵌套列表…）→ 该行或块
 * 整体按纯文本保留（记号原样可见），渲染层不改内容、绝不空白。
 *
 * 纪律（红线）：
 * - 解析器只识别结构不改写内容；任何输入都不抛异常，调用方无须 try/catch 也不丢内容；
 * - 确定性：同输入必同输出（无随机/无时间/无环境依赖）；
 * - 扫描全用 indexOf/游标（无正则回溯），超长行/星号超长游程线性有界。
 * 纯 Kotlin 零 Android 依赖，JUnit4 直接可测。
 */
object MarkdownOps {

    // ---- 模型 ----

    /** 块级结构。Paragraph = 纯文本块（含仅行内记号的平凡块）。 */
    sealed class Block {
        data class Heading(val level: Int, val text: String) : Block()
        data class Paragraph(val text: String) : Block()

        /** 列表项：ordered=false 时 number 为 null；text 为记号后的内容（可为空串）。 */
        data class ListItem(val ordered: Boolean, val number: Int?, val text: String) : Block()

        /** 表格：header/rows 每行等长（不足补空串，绝不截断丢内容）。 */
        data class Table(val header: List<String>, val rows: List<List<String>>) : Block()

        /** 围栏代码块：code 逐行原样（行间 \n 拼合，无首尾换行）；info 为 ``` 后语言标注（不渲染）。 */
        data class CodeBlock(val code: String, val info: String?) : Block()
    }

    /** 行内 span。Bold 内只含 Text/Code（嵌套一层即止）；Italic 为纯文本。 */
    sealed class Span {
        data class Text(val text: String) : Span()
        data class Bold(val spans: List<Span>) : Span()
        data class Code(val code: String) : Span()
        data class Italic(val text: String) : Span()
    }

    // ---- 块级解析 ----

    /**
     * 块级解析：标题/列表项/表格/代码围栏/段落。空输入 → 空列表。
     * 缩进 4 空格起不识别块结构（缩进代码属子集外）→ 按段落原文保留。
     */
    fun parse(text: String): List<Block> {
        if (text.isEmpty()) return emptyList()
        val lines = text.split('\n').map { it.trimEnd('\r') } // CRLF 容忍
        val out = ArrayList<Block>()
        var para = ArrayList<String>()
        var noFenceCloseFrom = Int.MAX_VALUE // 记忆化：此后再无闭合围栏行（防超长输入平方扫描）

        fun flushPara() {
            if (para.isNotEmpty()) {
                out.add(Block.Paragraph(para.joinToString("\n")))
                para = ArrayList()
            }
        }

        var i = 0
        val n = lines.size
        while (i < n) {
            val line = lines[i]
            if (line.isBlank()) {
                flushPara()
                i++
                continue
            }
            val indent = line.indexOfFirst { it != ' ' } // isBlank 已排除，indent 必 >= 0
            val body = line.substring(indent)
            if (indent < 4) {
                if (body.startsWith("```")) {
                    if (i + 1 >= noFenceCloseFrom) {
                        // 已知后方无闭合围栏 → 整体按纯文本（同 RichTextTokenizer 纪律）
                        para.add(line)
                        i++
                        continue
                    }
                    val close = findFenceClose(lines, i + 1)
                    if (close >= 0) {
                        flushPara()
                        val info = body.dropWhile { it == '`' }.trim().ifEmpty { null }
                        val code = if (close > i + 1) lines.subList(i + 1, close).joinToString("\n") else ""
                        out.add(Block.CodeBlock(code = code, info = info))
                        i = close + 1
                        continue
                    }
                    noFenceCloseFrom = i + 1
                    para.add(line)
                    i++
                    continue
                }
                val heading = headingOf(body)
                if (heading != null) {
                    flushPara()
                    out.add(heading)
                    i++
                    continue
                }
                val item = listItemOf(body)
                if (item != null) {
                    flushPara()
                    out.add(item)
                    i++
                    continue
                }
                val table = tableAt(lines, i)
                if (table != null) {
                    flushPara()
                    out.add(table.first)
                    i = table.second
                    continue
                }
            }
            para.add(line)
            i++
        }
        flushPara()
        return out
    }

    /** 平凡判定：全部为段落块（仅行内记号）→ 调用方走既有 RichMarkdownText 原路径，性能零回退。 */
    fun isTrivial(blocks: List<Block>): Boolean = blocks.all { it is Block.Paragraph }

    /** 闭合围栏行：缩进 <4、``` 起且除反引号外全空白。 */
    private fun findFenceClose(lines: List<String>, from: Int): Int {
        for (idx in from until lines.size) {
            val l = lines[idx]
            var sp = 0
            while (sp < l.length && l[sp] == ' ') sp++
            if (sp >= 4) continue
            var k = sp
            while (k < l.length && l[k] == '`') k++
            if (k - sp >= 3 && l.substring(k).isBlank()) return idx
        }
        return -1
    }

    /** ATX 标题：1~6 个 `#` 后跟空格/制表/行尾。7+ 个 `#` 或紧跟非空白 → null（按段落）。 */
    private fun headingOf(body: String): Block.Heading? {
        var c = 0
        while (c < body.length && body[c] == '#') c++
        if (c !in 1..6) return null
        if (c < body.length && body[c] != ' ' && body[c] != '\t') return null
        val text = if (c >= body.length) "" else body.substring(c).trim(' ', '\t')
        return Block.Heading(level = c, text = text)
    }

    /** 列表项：`-`/`+`/`*` 或 数字 + `.`/`)` ，记号后须空格/制表/行尾；单层无嵌套。 */
    private fun listItemOf(body: String): Block.ListItem? {
        val c0 = body[0]
        if (c0 == '-' || c0 == '+' || c0 == '*') {
            if (body.length == 1 || body[1] == ' ' || body[1] == '\t') {
                val text = if (body.length == 1) "" else body.substring(1).trim(' ', '\t')
                return Block.ListItem(ordered = false, number = null, text = text)
            }
            return null
        }
        if (c0.isDigit()) {
            var d = 0
            while (d < body.length && body[d].isDigit() && d < 9) d++
            if (d in 1..9 && d < body.length && (body[d] == '.' || body[d] == ')')) {
                if (d + 1 == body.length || body[d + 1] == ' ' || body[d + 1] == '\t') {
                    val num = body.substring(0, d).toIntOrNull() ?: return null
                    val text = if (d + 1 >= body.length) "" else body.substring(d + 1).trim(' ', '\t')
                    return Block.ListItem(ordered = true, number = num, text = text)
                }
            }
        }
        return null
    }

    /**
     * 表格识别（GFM 简化）：lines[i] 为表头（须含 `|` 且至少一个非空单元格），
     * lines[i+1] 为分隔行（须含 `|` 与 `-`，所有单元格匹配 `:?-+:?`——含 `|` 要求以排除
     * setext 下划线 `---` 误判）。返回 表格块 + 表体结束后下一行下标；不匹配 → null。
     */
    private fun tableAt(lines: List<String>, i: Int): Pair<Block.Table, Int>? {
        if (i + 1 >= lines.size) return null
        val headerLine = lines[i]
        if (!headerLine.contains('|')) return null
        if (!isDelimiterRow(lines[i + 1])) return null
        val header = splitRow(headerLine)
        if (header.none { it.isNotBlank() }) return null
        var j = i + 2
        val rows = ArrayList<List<String>>()
        while (j < lines.size) {
            val l = lines[j]
            if (l.isBlank() || !l.contains('|')) break
            rows.add(splitRow(l))
            j++
        }
        val cols = maxOf(header.size, rows.maxOfOrNull { it.size } ?: 0)
        return Block.Table(
            header = header.padTo(cols),
            rows = rows.map { it.padTo(cols) },
        ) to j
    }

    private fun isDelimiterRow(line: String): Boolean {
        if (!line.contains('|') || !line.contains('-')) return false
        val cells = splitRow(line)
        if (cells.isEmpty()) return false
        return cells.all { cell ->
            val c = cell.trim(' ', '\t')
            c.length >= 1 && (c[0] == ':' || c[0] == '-') && c.all { it == ':' || it == '-' }
        }
    }

    /** 行拆单元格：去首尾围栏 `|` 后按 `|` 切分并去单元格首尾空白（`\|` 转义属子集外，如实切分）。 */
    private fun splitRow(line: String): List<String> {
        var s = line.trim(' ', '\t')
        if (s.startsWith("|")) s = s.substring(1)
        if (s.endsWith("|")) s = s.substring(0, s.length - 1)
        return s.split('|').map { it.trim(' ', '\t') }
    }

    private fun List<String>.padTo(size: Int): List<String> =
        if (this.size >= size) this else this + List(size - this.size) { "" }

    // ---- 行内解析 ----

    /**
     * 行内解析：`**加粗**`（内可含 `` `code` `` 一层）、`` `code` ``、`*斜体*`（保守）、纯文本。
     * 记号不跨行；未闭合/歧义 → 字面量保留。相邻 Text 合并。空输入 → 空列表。
     */
    fun parseInline(text: String): List<Span> {
        if (text.isEmpty()) return emptyList()
        val out = ArrayList<Span>()
        val sb = StringBuilder()
        var i = 0
        val n = text.length
        var noMoreDoubleStar = Int.MAX_VALUE
        var noMoreStar = Int.MAX_VALUE
        var noMoreBacktick = Int.MAX_VALUE

        fun flushText() {
            if (sb.isNotEmpty()) {
                out.add(Span.Text(sb.toString()))
                sb.setLength(0)
            }
        }

        while (i < n) {
            val c = text[i]
            when {
                c == '`' -> {
                    val close = if (i >= noMoreBacktick) -1 else text.indexOf('`', i + 1)
                    val nl = text.indexOf('\n', i + 1)
                    if (close > i + 1 && (nl < 0 || close < nl)) {
                        flushText()
                        out.add(Span.Code(text.substring(i + 1, close)))
                        i = close + 1
                    } else {
                        if (close < 0) noMoreBacktick = i + 1
                        sb.append(c)
                        i++
                    }
                }

                c == '*' && i + 1 < n && text[i + 1] == '*' -> {
                    val close = if (i + 2 >= noMoreDoubleStar) -1 else text.indexOf("**", i + 2)
                    val nl = text.indexOf('\n', i + 1)
                    if (close > i + 2 && (nl < 0 || close < nl)) {
                        val inner = boldInner(text.substring(i + 2, close))
                        if (inner != null) {
                            flushText()
                            out.add(Span.Bold(inner))
                            i = close + 2
                        } else {
                            sb.append(c)
                            i++
                        }
                    } else {
                        if (close < 0) noMoreDoubleStar = i + 2
                        sb.append(c)
                        i++
                    }
                }

                c == '*' -> {
                    // 斜体保守匹配：开记号须行首/空白之后；内容不含空白边界与 `*`；不跨行
                    val prevOk = i == 0 || text[i - 1] == ' ' || text[i - 1] == '\t' || text[i - 1] == '\n'
                    val close = if (i >= noMoreStar) -1 else text.indexOf('*', i + 1)
                    val nl = text.indexOf('\n', i + 1)
                    if (prevOk && close > i + 1 && (nl < 0 || close < nl)) {
                        val inner = text.substring(i + 1, close)
                        if (inner.first() != ' ' && inner.first() != '\t' &&
                            inner.last() != ' ' && inner.last() != '\t' && !inner.contains('*')
                        ) {
                            flushText()
                            out.add(Span.Italic(inner))
                            i = close + 1
                        } else {
                            sb.append(c)
                            i++
                        }
                    } else {
                        if (close < 0) noMoreStar = i + 1
                        sb.append(c)
                        i++
                    }
                }

                else -> {
                    sb.append(c)
                    i++
                }
            }
        }
        flushText()
        return out
    }

    /**
     * 加粗内部：只识别 `` `code` ``（嵌套一层即止），其余（含 `*`）字面量。
     * 去首尾空白（与既有 RichTextTokenizer `** a **` → Bold("a") 行为一致）；空白 → null 回字面量。
     */
    private fun boldInner(raw: String): List<Span>? {
        val s = raw.trim(' ', '\t')
        if (s.isEmpty()) return null
        val out = ArrayList<Span>()
        val sb = StringBuilder()
        var i = 0
        val n = s.length

        fun flushText() {
            if (sb.isNotEmpty()) {
                out.add(Span.Text(sb.toString()))
                sb.setLength(0)
            }
        }

        while (i < n) {
            val c = s[i]
            if (c == '`') {
                val close = s.indexOf('`', i + 1)
                if (close > i + 1) {
                    flushText()
                    out.add(Span.Code(s.substring(i + 1, close)))
                    i = close + 1
                    continue
                }
            }
            sb.append(c)
            i++
        }
        flushText()
        return out
    }
}
