package com.devhub.mobile.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.devhub.mobile.core.ProviderPalette

/**
 * R4 provider 徽标：固定色板 + 首字母圆形徽标。
 * 全 App 统一：会话列表行 / 顶部过滤 chips / R11 气泡头像同色同字母（色板唯一来源 = core.ProviderPalette）。
 */
@Composable
fun ProviderAvatar(
    argb: Long,
    initial: String,
    modifier: Modifier = Modifier,
    size: Dp = 30.dp,
    fontSize: Int = 13,
) {
    Box(
        modifier = modifier
            .size(size)
            .background(Color(argb), CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = initial,
            color = Color.White,
            fontSize = fontSize.sp,
            fontWeight = FontWeight.Bold,
        )
    }
}

/** 便捷封装：按 providerKey/Label 解析色板后绘制（R4）。 */
@Composable
fun ProviderAvatarFor(
    providerKey: String?,
    providerLabel: String?,
    modifier: Modifier = Modifier,
    size: Dp = 30.dp,
    fontSize: Int = 13,
) {
    val spec = ProviderPalette.resolve(providerKey, providerLabel)
    ProviderAvatar(argb = spec.argb, initial = spec.initial, modifier = modifier, size = size, fontSize = fontSize)
}
