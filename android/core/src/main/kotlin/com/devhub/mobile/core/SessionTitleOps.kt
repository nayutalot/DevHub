package com.devhub.mobile.core

/**
 * U2-M4（AUDIT P3#3）：子会话标题任务语义提取（纯函数，:core 单测直锁）。
 *
 * 缺陷实证（23 号截图）：子会话标题 = 系统提示词首行截断（「你是 DevHub 项目…」），
 * 噪声大——桌面投影的 title 取自会话首行原文（桌面零触碰），App 侧在显示层做
 * 任务语义提取。
 *
 * 规则（保守，绝不编造）：
 * 1. 显示记号清理（RichTextTokenizer.stripDisplayMarkers，与展示层同函数）；
 * 2. 按换行与中英句读切句（。！？!?:：后断；保留冒号以便任务式标题完整）——
 *    实际切分：以换行/句号为硬边界，冒号不断（「对 X 做视觉验收：要求…」语义完整）；
 * 3. 逐句过滤系统提示词形态句（「你是…」角色指派句）与工作区上下文句
 *    （「工作树 = …」「主仓 = …」路径/分支交代句）；
 * 4. 首个幸存句即标题（trim；≥2 字符；封顶 80 字符安全截断）；
 * 5. 无幸存句 → null（调用方如实回退原截断显示，绝不硬造标题）。
 */
object SessionTitleOps {

    private const val MAX_TITLE_CHARS = 80

    /** 角色指派/系统提示词形态句前缀（小写比对；「你是/你有/作为」族 + 英文同形）。 */
    private val SYSTEM_SENTENCE_PREFIXES = listOf(
        "你是", "你有", "你将", "你要", "你需要", "你负责", "你现在", "你会", "你可", "你具备",
        "作为", "假设", "假定", "扮演",
        "you are", "your ", "you'll", "you will", "you must", "act as",
    )

    /** 工作区上下文句前缀（须后随「= / ： / :」才算路径交代句，保守防误伤任务句）。 */
    private val CONTEXT_SENTENCE_PREFIXES = listOf(
        "工作树", "主仓", "项目根", "项目主仓", "工作目录", "仓库根", "repo", "cwd",
    )

    /** 提取任务语义标题；提不出 → null（调用方回退原截断，绝不编造）。 */
    fun extractTitle(raw: String?): String? {
        val cleaned = RichTextTokenizer.stripDisplayMarkers(raw)?.trim().orEmpty()
        if (cleaned.isEmpty()) return null
        // 硬边界切句：换行 / 中英句号 / 叹号问号（英文句点须后随空白才断——v1.2 类
        // 版本号不碎）；分号与冒号不断——任务句常带冒号补语
        val sentences = cleaned.split(Regex("\n+|。+|！+|？+|!+|\\?+|\\.(?=\\s+)"))
        for (sentence in sentences) {
            val s = sentence.trim().trimStart('，', ',', '；', ';', '、')
                .trimEnd('，', ',', '；', ';', '、', '.', '。')
            if (s.length < 2) continue
            if (isSystemSentence(s) || isContextSentence(s)) continue
            return if (s.length > MAX_TITLE_CHARS) s.take(MAX_TITLE_CHARS) else s
        }
        return null
    }

    private fun isSystemSentence(s: String): Boolean {
        val lower = s.lowercase()
        return SYSTEM_SENTENCE_PREFIXES.any { lower.startsWith(it) }
    }

    private fun isContextSentence(s: String): Boolean {
        val lower = s.lowercase()
        return CONTEXT_SENTENCE_PREFIXES.any { prefix ->
            lower.startsWith(prefix) &&
                s.drop(prefix.length).trimStart().firstOrNull() in setOf('=', '：', ':')
        }
    }
}
