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
import androidx.compose.runtime.saveable.rememberSaveable
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
 * T1 批：独立「远程工作区」tab 撤销——ZCode 遥控入口并入会话/Agent 流
 * （会话页顶部智能卡 + zcode 会话详情按钮 + zcode Agent 卡按钮），
 * 条目管理屏（RemoteWorkspaceScreen）改为可路由目的地（remote-manage），
 * 从智能卡管理入口可达。
 */
@Composable
fun MainTabs(
    initialTab: String,
    onOpenSession: (Long) -> Unit,
    onGatewayConfig: () -> Unit,
    onOpenRemoteEntry: (Long) -> Unit = {},
    onManageRemote: () -> Unit = {},
) {
    // Q 批：rememberSaveable——跳「远程工作区」全屏 WebView 后返回，选中 tab 不再
    // 丢失回默认会话（main 条目在返回栈上，状态随 SavedStateRegistry 存续）。
    var selected by rememberSaveable { mutableStateOf(initialTab) }

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
                    icon = { Icon(Icons.Filled.List, contentDescription = "对话") },
                    label = { Text("对话") },
                )
                NavigationBarItem(
                    selected = selected == "agents",
                    onClick = { selected = "agents" },
                    icon = { Icon(Icons.Filled.Star, contentDescription = "助手") },
                    label = { Text("助手") },
                )
                // T1 批：独立「远程工作区」tab 撤销（用户裁决）——遥控入口并入会话/Agent 流
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
                // T1 批：zcode provider 卡加「打开遥控」→ remote/{entryId}
                "agents" -> AgentsScreen(
                    onOpenSession = onOpenSession,
                    onOpenRemoteEntry = onOpenRemoteEntry,
                )
                // T1 批：会话页顶部「ZCode 工作区」智能卡（点击开遥控 / 管理入口进条目管理屏）
                "diagnostics" -> DiagnosticsScreen()
                // UX-P1 De2：「去连接」动作出口复用既有连接设置路由（零结构改动）
                "device" -> DeviceScreen(onGoConnect = onGatewayConfig)
                else -> SessionsScreen(
                    onOpenSession = onOpenSession,
                    onOpenRemoteEntry = onOpenRemoteEntry,
                    onManageRemote = onManageRemote,
                )
            }
        }
    }
}

/** 顶部连接状态条：三态可判断性（docs/24 §2.2 矩阵逐格）——还没连接电脑 / 连不上 / 电脑不在线互斥文案；
 * 心跳等数值全部移出常态面（技术原值在连接帮助「技术详情」折叠，docs/25 M5-M12 人话化）。 */
@Composable
private fun ConnectionStatusBar(onGatewayConfig: () -> Unit) {
    val state by ConnectionManager.state.collectAsState()
    val activeMode by ConnectionManager.activeMode.collectAsState()
    val upstreamBeacon by ConnectionManager.upstreamBeacon.collectAsState()
    // 打磨批 D：钉深色主题后默认文字为主题浅色，与浅色状态底对比失效 →
    // 各状态显式配对 fg 色（取色与 StatusBadge 同源语义）。
    // M2-R3（docs/19 §7.3）：relay 降级态（upstream disconnected）=「云端连接已连上，但电脑
    // 不在线」结构化文案，琥珀底高亮，绝不显示为正常态——容错降级纪律（不伪造状态红线）。
    val (bg, fg, label) = when (val s = state) {
        is ConnState.Connected -> when {
            activeMode == "relay" && upstreamBeacon == "disconnected" ->
                Triple(
                    Color(0xFFFFECB3),
                    Color(0xFF7A4F00),
                    "云端连接已连上，但电脑不在线——消息会在电脑上线后自动送达",
                )

            activeMode == "relay" ->
                Triple(Color(0xFFDDEBDD), Color(0xFF1B5E20), "已连接（云端连接）")

            else -> Triple(Color(0xFFDDEBDD), Color(0xFF1B5E20), "已连接")
        }

        is ConnState.Connecting -> Triple(Color(0xFFFFECB3), Color(0xFF7A4F00), "连接中…")
        is ConnState.Backing ->
            Triple(
                Color(0xFFFFAB91),
                Color(0xFF7A2400),
                "连不上：请检查手机网络或电脑是否开机（第 ${s.attempt} 次重试，约 ${s.nextDelayMs / 1000} 秒后）",
            )
        is ConnState.Unpaired -> Triple(Color(0xFFFFCDD2), Color(0xFFB71C1C), "还没连接电脑：先在电脑上生成配对码")
        ConnState.Idle -> Triple(Color(0xFFE0E0E0), Color(0xFF37474F), "未连接")
    }
    // 三态动作出口（docs/24 §2.2）：还没连接电脑/未连接 → 「去连接」直达连接流程入口
    // （连接设置 → 连接电脑）；其余状态保持「连接设置」。「诊断连接问题」出口在
    // 诊断 tab 与连接设置页（G16）——状态条直连诊断的接线归 P2 IA。
    val actionLabel = if (state is ConnState.Unpaired || state == ConnState.Idle) "去连接" else "连接设置"
    Surface(color = bg, modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(label, fontSize = 12.sp, fontWeight = FontWeight.Medium, color = fg)
            Spacer(Modifier.weight(1f))
            TextButton(onClick = onGatewayConfig) {
                Text(actionLabel, fontSize = 12.sp, color = fg)
            }
        }
    }
}
