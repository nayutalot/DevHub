package com.devhub.mobile.core

/**
 * R4 provider 固定色板 + 首字母徽标（全 App 统一：会话列表行 / 过滤 chips / R11 气泡头像同色）。
 *
 * 五家 provider 各一固定色（已知 providerKey 精确/包含匹配，归一化为小写字母数字）；
 * 未知 provider 用稳定 hash 从扩展色板取色（同 key 永远同色，绝不随机）。
 * 颜色以 ARGB Long 承载（:core 零 Android 依赖；App 侧 Color(argb) 换算）。
 */
object ProviderPalette {

    /** user 侧固定头像文案（R11：user 头像固定"我"，不随 provider 变化）。 */
    const val USER_AVATAR_TEXT = "我"

    data class Spec(val argb: Long, val initial: String)

    /** 已知五家：key 归一化后精确或包含匹配（如 "claudecode" 含 "claude"）。 */
    private val known: Map<String, Long> = mapOf(
        "codex" to 0xFF2E7D32,      // 绿
        "claude" to 0xFFE64A19,     // 橙
        "kimi" to 0xFF1565C0,       // 蓝
        "zcode" to 0xFF6A1B9A,      // 紫
        "deepseek" to 0xFFAD1457,   // 品红
    )

    /** 未知 provider 的扩展色板（与五家主色可区分；按稳定 hash 取用）。 */
    private val fallbackColors: List<Long> = listOf(
        0xFF455A64, 0xFF5D4037, 0xFF37474F, 0xFF827717, 0xFF00695C,
        0xFF4E342E, 0xFF33691E, 0xFF283593,
    )

    /** 测试可见的扩展色板规模。 */
    fun fallbackColorCount(): Int = fallbackColors.size

    /** providerKey/providerLabel → 归一化 key；两者皆空返回 null。 */
    fun normalizeKey(providerKey: String?, providerLabel: String?): String? {
        val raw = (providerKey ?: providerLabel ?: "").ifBlank { providerLabel ?: "" }
        val normalized = raw.lowercase().filter { it in 'a'.. 'z' || it in '0'..'9' }
        return normalized.ifBlank { null }
    }

    private fun matchKnown(normalized: String): Long? =
        known[normalized] ?: known.entries.firstOrNull { normalized.contains(it.key) }?.value

    private fun stableHash(s: String): Int {
        var h = 7
        for (c in s) h = h * 31 + c.code
        return h
    }

    /** 首字母徽标：label 首个字母/数字大写；无可用字符回退 "?"。 */
    fun initialOf(providerKey: String?, providerLabel: String?): String {
        val source = providerLabel ?: providerKey ?: ""
        val c = source.firstOrNull { it.isLetterOrDigit() } ?: return "?"
        return c.uppercaseChar().toString()
    }

    fun resolve(providerKey: String?, providerLabel: String?): Spec {
        val normalized = normalizeKey(providerKey, providerLabel)
        val argb = normalized?.let { matchKnown(it) }
            ?: fallbackColors[stableHash(normalized ?: "unknown").let { if (it < 0) -it else it } % fallbackColors.size]
        return Spec(argb = argb, initial = initialOf(providerKey, providerLabel))
    }
}
