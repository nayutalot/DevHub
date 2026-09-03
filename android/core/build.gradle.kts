// :core —— 纯 Kotlin/JVM 模块（零 Android 依赖）。
// 承载全部可纯逻辑测试的部分：退避计算器 / 幂等 key / 事件→通知映射 /
// 控制按钮门 / 离线队列补发状态机 / 脱敏渲染。JUnit4 单测位于 src/test/kotlin。
// 因为不应用 Android 插件，本模块的 `gradle :core:test` 在没有 Android SDK 的
// 机器上同样可执行（AC7 交付时本机即处于该状态，测试结果真实可复现）。
plugins {
    alias(libs.plugins.kotlin.jvm)
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    testImplementation(libs.junit)
}
