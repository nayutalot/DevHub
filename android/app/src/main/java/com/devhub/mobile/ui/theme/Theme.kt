package com.devhub.mobile.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val LightColors = lightColorScheme(
    primary = Color(0xFF1B6B3A),
    secondary = Color(0xFF3B6B8F),
)

private val DarkColors = darkColorScheme(
    primary = Color(0xFF7BD8A4),
    secondary = Color(0xFF8FBCDB),
)

@Composable
fun DevHubTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (isSystemInDarkTheme()) DarkColors else LightColors,
        content = content,
    )
}
