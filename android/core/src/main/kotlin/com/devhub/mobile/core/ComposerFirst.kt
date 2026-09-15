package com.devhub.mobile.core

/**
 * UX-Z2 结构层（docs/28 §5）：composer-first 新建流的纯文案表与三态判定。
 *
 * - 问候语：时段→人话文案（docs/28 §5.2 词表）；**无用户称呼数据 → 固定文案池
 *   不伪造称呼**（A4 教训同源纪律）。
 * - 快捷 chips：预设表常量（docs/28 §5.3，DevHub 语境重写四枚）；点击仅填入
 *   输入框（不自动发送，UI 层纪律，:core 只供文案）。
 * - 模型弹层诚实三态（docs/28 §5.4）：可选面（managed_model 设置值展示，展示
 *   不承诺切换）/托管停用态/observed 无 managed → 不画入口（null，假可供性红线）。
 *
 * 纯 Kotlin 零 Android 依赖（:core 纪律），:app 单测直锁。
 */
object ComposerFirst {

    // ------------------------------------------------------------------
    // 问候语（docs/28 §5.2 时段映射；边界左闭右开）
    // ------------------------------------------------------------------

    /** 时段人话（hour ∈ [0,24)）；越界输入回退「你好」（绝不抛）。 */
    fun greetingForHour(hour: Int): String = when (hour) {
        in 5..10 -> "早上好"
        in 11..12 -> "中午好"
        in 13..17 -> "下午好"
        in 18..22 -> "晚上好呀，今天辛苦啦"
        else -> "夜深了，注意休息" // 23,0,1,2,3,4
    }

    // ------------------------------------------------------------------
    // 快捷 chips 预设表（docs/28 §5.3；点击=填入不发送）
    // ------------------------------------------------------------------

    data class ChipPreset(val label: String, val fillText: String)

    /** 四枚预设（DevHub 语境；不照抄 v4 办公语境）。 */
    val CHIP_PRESETS: List<ChipPreset> = listOf(
        ChipPreset("报错修复", "帮我看看电脑上报错的日志并修复"),
        ChipPreset("代码解读", "给我讲讲这个项目的结构"),
        ChipPreset("写个脚本", "帮我写一个脚本："),
        ChipPreset("继续上次", "继续电脑上最近一个未完成的对话"),
    )

    // ------------------------------------------------------------------
    // 模型弹层诚实三态（docs/28 §5.4）
    // ------------------------------------------------------------------

    /** 最小输入行（:app AgentDto 投影；:core 不依赖 Android 数据类）。 */
    data class ManagedProviderRef(
        val displayName: String,
        /** capabilities.mode == 'managed' 才算托管面（与 canSpawnManagedSession 同源）。 */
        val isManaged: Boolean,
        /** settings managed_model 设置值（null/空 = 托管面停用）。 */
        val managedModel: String?,
    )

    /** 可选面中的一行（当前模型只读展示；绝无可点切换）。 */
    data class ModelRow(val providerName: String, val model: String)

    sealed interface ModelSheetState {
        /**
         * 可选面：≥1 个 managed provider 且其 managed_model 非空 → 当前模型勾选态
         * 只读展示 + 候选预设灰显（可看不可选）。
         */
        data class Available(val rows: List<ModelRow>, val candidates: List<String>) : ModelSheetState

        /**
         * 托管停用：managed provider 在但 managed_model 缺行（settingsService 既有
         * 语义）→「模型在电脑上配置后可用」+ provider 行；**绝不画可选勾**。
         */
        data class ManagedDisabled(val providerNames: List<String>) : ModelSheetState
    }

    /**
     * 三态解析：返回 null = 无 managed provider → **模型入口不画**（假可供性红线，
     * composer 提交路径同门收敛）。
     */
    fun modelSheetState(providers: List<ManagedProviderRef>): ModelSheetState? {
        val managed = providers.filter { it.isManaged }
        if (managed.isEmpty()) return null
        val configured = managed.filter { !it.managedModel.isNullOrEmpty() }
        if (configured.isEmpty()) {
            return ModelSheetState.ManagedDisabled(providerNames = managed.map { it.displayName })
        }
        val rows = configured.map { ModelRow(it.displayName, it.managedModel!!) }
        // 候选预设（灰显）：按在册 managed provider 家族过滤（kimi 无模型概念 → 不出）
        val candidates = mutableListOf<String>()
        if (configured.any { it.displayName.contains("ZCode", ignoreCase = true) }) candidates.add("GLM 系列模型")
        if (configured.any { it.displayName.contains("DeepSeek", ignoreCase = true) }) candidates.add("DeepSeek 系列模型")
        return ModelSheetState.Available(rows = rows, candidates = candidates)
    }
}
