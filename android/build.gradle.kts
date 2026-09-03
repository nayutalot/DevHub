// DevHub Android 根构建（AC7，docs/11 §7 / docs/16 AC7 行）。
// 双模块：:core = 纯 Kotlin/JVM 纯逻辑 + JUnit4 单测（无 Android 插件，
// 无 Android SDK 的环境也可执行 `gradle :core:test`）；:app = Android
// （Kotlin + Compose + Room + OkHttp + Android Keystore，工程约束用户锁定）。
//
// 版本矩阵注记（AC7 交付时本机无 Android SDK，:app 未能试编译；以下为一致性良好
// 组合，首次真实构建若个别版本不存在/不匹配，只需在 gradle/libs.versions.toml 一处调整）：
//   Gradle 9.1+（wrapper distributionUrl；可运行于 JDK 17-25，覆盖本机 JetBrains
//   Runtime 25 与 Android Studio 内置 JDK 21 两种场景）、AGP 8.13.0（Gradle 8.13+）、
//   Kotlin 2.2.0、KSP 2.2.0-2.0.2、Room 2.7.1、Compose BOM 2025.06.00。
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.ksp) apply false
}
