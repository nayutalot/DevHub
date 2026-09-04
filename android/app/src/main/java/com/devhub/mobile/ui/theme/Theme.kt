package com.devhub.mobile.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/**
 * 视觉打磨批 D：钉死深色 Material 主题（唯一 scheme，不随系统切换）。
 *
 * 背景：此前跟随系统浅色主题时，状态栏浅色图标在浅背景不可见，且与设计（深色 Material）
 * 不符。钉深色后：深色背景 + 浅色图标对比成立；状态栏图标明暗由 MainActivity 显式设
 * isAppearanceLightStatusBars = false（浅色图标于深色背景）。
 */
private val DarkColors = darkColorScheme(
    primary = Color(0xFF7BD8A4),
    onPrimary = Color(0xFF003818),
    primaryContainer = Color(0xFF005D2B),
    onPrimaryContainer = Color(0xFF98F7BC),
    secondary = Color(0xFF8FBCDB),
    onSecondary = Color(0xFF0A3D57),
    secondaryContainer = Color(0xFF29556F),
    onSecondaryContainer = Color(0xFFC2E8FF),
    background = Color(0xFF121417),
    onBackground = Color(0xFFE2E3E5),
    surface = Color(0xFF121417),
    onSurface = Color(0xFFE2E3E5),
    surfaceVariant = Color(0xFF23272C),
    onSurfaceVariant = Color(0xFFC3C7CD),
    surfaceContainer = Color(0xFF1B1F23),
    surfaceContainerHigh = Color(0xFF252A2F),
    outline = Color(0xFF8D9199),
    error = Color(0xFFFFB4AB),
)

@Composable
fun DevHubTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = DarkColors,
        content = content,
    )
}
