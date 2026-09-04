package com.devhub.mobile.core

/**
 * R11 气泡分侧规则（微信式对话流）：
 * - role=user → 右侧主色气泡右对齐（头像固定"我"）；
 * - role=assistant → 左侧 surfaceVariant 气泡（头像 = R4 色板 provider 首字母）；
 * - system / tool / event / 未识别 role → 居中灰 chip（不猜语义，保守居中）。
 */
object BubbleSides {

    enum class Placement {
        /** 右侧主色气泡。 */
        RIGHT_PRIMARY,

        /** 左侧 surfaceVariant 气泡。 */
        LEFT_VARIANT,

        /** 居中灰 chip（system/tool/事件类）。 */
        CENTER_CHIP,
    }

    fun placementFor(role: String): Placement = when (role) {
        "user" -> Placement.RIGHT_PRIMARY
        "assistant" -> Placement.LEFT_VARIANT
        else -> Placement.CENTER_CHIP
    }

    /** 头像文案：user 固定"我"；其余用 provider 色板首字母。 */
    fun avatarText(role: String, providerKey: String?, providerLabel: String?): String =
        if (role == "user") ProviderPalette.USER_AVATAR_TEXT
        else ProviderPalette.resolve(providerKey, providerLabel).initial
}
