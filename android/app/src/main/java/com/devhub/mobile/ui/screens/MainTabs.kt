package com.devhub.mobile.ui.screens

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
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
        // 视觉打磨批 D：顶部 inset 单计——外层 DevHubRoot Scaffold 已把状态栏 inset
        // 作为 padding 应用到 NavHost；本层 Scaffold 默认 contentWindowInsets 会再次
        // 加一次状态栏高度（出现"状态栏与连接条之间一整行空白带"）。置零交由外层单计。
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
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
                // 批次 C R6.2：Agents 页「启动托管会话」→ 202 后跳入新会话详情
                "agents" -> AgentsScreen(onOpenSession = onOpenSession)
                "diagnostics" -> DiagnosticsScreen()
                "device" -> DeviceScreen()
                else -> SessionsScreen(onOpenSession = onOpenSession)
            }
        }
    }
}

/** 顶部连接状态条：WS 状态（已连接 / 连接中 / 退避 / 未启动）一目了然；relay 模式区分降级信标。 */
@Composable
private fun ConnectionStatusBar(onGatewayConfig: () -> Unit) {
    val state by ConnectionManager.state.collectAsState()
    val activeMode by ConnectionManager.activeMode.collectAsState()
    val upstreamBeacon by ConnectionManager.upstreamBeacon.collectAsState()
    // 打磨批 D：钉深色主题后默认文字为主题浅色，与浅色状态底对比失效 →
    // 各状态显式配对 fg 色（取色与 StatusBadge 同源语义）。
    // M2-R3（docs/19 §7.3）：relay 降级态（upstream disconnected）=「Relay 已连接，电脑离线
    // （命令将排队）」结构化文案，琥珀底高亮，绝不显示为正常态——容错降级纪律。
    val (bg, fg, label) = when (val s = state) {
        is ConnState.Connected -> when {
            activeMode == "relay" && upstreamBeacon == "disconnected" ->
                Triple(Color(0xFFFFECB3), Color(0xFF7A4F00), "Relay 已连接，电脑离线（命令将排队）")

            activeMode == "relay" ->
                Triple(Color(0xFFDDEBDD), Color(0xFF1B5E20), "Relay 已连接 · 心跳 ${s.heartbeatSec}s")

            else -> Triple(Color(0xFFDDEBDD), Color(0xFF1B5E20), "已连接 · 心跳 ${s.heartbeatSec}s")
        }

        is ConnState.Connecting -> Triple(Color(0xFFFFECB3), Color(0xFF7A4F00), "连接中…")
        is ConnState.Backing ->
            Triple(Color(0xFFFFAB91), Color(0xFF7A2400), "退避重连（第 ${s.attempt} 次，${s.nextDelayMs / 1000}s 后）")
        is ConnState.Unpaired -> Triple(Color(0xFFFFCDD2), Color(0xFFB71C1C), "未配对")
        ConnState.Idle -> Triple(Color(0xFFE0E0E0), Color(0xFF37474F), "未启动")
    }
    Surface(color = bg, modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(label, fontSize = 12.sp, fontWeight = FontWeight.Medium, color = fg)
            Spacer(Modifier.weight(1f))
            TextButton(onClick = onGatewayConfig) {
                Text("网关配置", fontSize = 12.sp, color = fg)
            }
        }
    }
}
