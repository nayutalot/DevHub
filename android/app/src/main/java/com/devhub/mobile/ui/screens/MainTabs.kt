package com.devhub.mobile.ui.screens

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
// AC7b 编译修复：移除 internal 符号 import（RowColumnParentData.weight）；
// Modifier.weight 为 RowScope/ColumnScope 成员扩展，无需 import。
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.List
import androidx.compose.material.icons.filled.Place
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.devhub.mobile.connect.ConnectionManager
import com.devhub.mobile.connect.ConnState

/**
 * 主框架：底部四标签（会话 / Agents / 诊断 / 设备）+ 顶部连接状态条。
 */
@Composable
fun MainTabs(
    initialTab: String,
    onOpenSession: (Long) -> Unit,
    onGatewayConfig: () -> Unit,
) {
    var selected by remember { mutableStateOf(initialTab) }

    Scaffold(
        bottomBar = {
            NavigationBar {
                NavigationBarItem(
                    selected = selected == "sessions",
                    onClick = { selected = "sessions" },
                    icon = { Icon(Icons.Filled.List, contentDescription = "会话") },
                    label = { Text("会话") },
                )
                NavigationBarItem(
                    selected = selected == "agents",
                    onClick = { selected = "agents" },
                    icon = { Icon(Icons.Filled.Star, contentDescription = "Agents") },
                    label = { Text("Agents") },
                )
                NavigationBarItem(
                    selected = selected == "diagnostics",
                    onClick = { selected = "diagnostics" },
                    icon = { Icon(Icons.Filled.Info, contentDescription = "诊断") },
                    label = { Text("诊断") },
                )
                NavigationBarItem(
                    selected = selected == "device",
                    onClick = { selected = "device" },
                    icon = { Icon(Icons.Filled.Place, contentDescription = "设备") },
                    label = { Text("设备") },
                )
            }
        },
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            ConnectionStatusBar(onGatewayConfig = onGatewayConfig)
            when (selected) {
                "agents" -> AgentsScreen()
                "diagnostics" -> DiagnosticsScreen()
                "device" -> DeviceScreen()
                else -> SessionsScreen(onOpenSession = onOpenSession)
            }
        }
    }
}

/** 顶部连接状态条：WS 状态（已连接 / 连接中 / 退避 / 未启动）一目了然。 */
@Composable
private fun ConnectionStatusBar(onGatewayConfig: () -> Unit) {
    val state by ConnectionManager.state.collectAsState()
    val (bg, label) = when (val s = state) {
        is ConnState.Connected -> Color(0xFFDDEBDD) to "已连接 · 心跳 ${s.heartbeatSec}s"
        is ConnState.Connecting -> Color(0xFFFFECB3) to "连接中…"
        is ConnState.Backing -> Color(0xFFFFAB91) to "退避重连（第 ${s.attempt} 次，${s.nextDelayMs / 1000}s 后）"
        is ConnState.Unpaired -> Color(0xFFFFCDD2) to "未配对"
        ConnState.Idle -> Color(0xFFE0E0E0) to "未启动"
    }
    Surface(color = bg, modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(label, fontSize = 12.sp, fontWeight = FontWeight.Medium)
            Spacer(Modifier.weight(1f))
            TextButton(onClick = onGatewayConfig) { Text("网关配置", fontSize = 12.sp) }
        }
    }
}
