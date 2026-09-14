package com.devhub.mobile.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
// AC7b 编译修复：移除 internal 符号 import（RowColumnParentData.weight）；
// Modifier.weight 为 RowScope/ColumnScope 成员扩展，无需 import。
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.List
import androidx.compose.material.icons.filled.Person
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
 * 主框架：底部三标签（对话 / 助手 / 我的）+ 顶部状态 chip（UX-P2 导航 IA 重排，docs/24 §3）。
 * - 四→三：原「诊断」「设备」tab 挂载点移入「我的」（屏本体保留，路由 connection-status/device）；
 * - 顶部连接状态条降级为状态 chip（五态；点开=「电脑连接状态」页）——P1 三态可判断性
 *   文案语义原样迁入（docs/24 §2.2），relay 降级态保持琥珀显性异常（不伪造状态红线）；
 * - 旧 tab 值（diagnostics/device）经 [normalizeTab] 兼容映射进「我的」，main?tab= 深链零破坏。
 * T1 批沿革：独立「远程工作区」tab 撤销——ZCode 遥控入口并入会话/Agent 流。
 */
@Composable
fun MainTabs(
    initialTab: String,
    onOpenSession: (Long) -> Unit,
    onGatewayConfig: () -> Unit,
    onOpenRemoteEntry: (Long) -> Unit = {},
    onManageRemote: () -> Unit = {},
    onOpenConnectionStatus: () -> Unit = {},
    onOpenDevice: () -> Unit = {},
) {
    // Q 批：rememberSaveable——跳「远程工作区」全屏 WebView 后返回，选中 tab 不再
    // 丢失回默认会话（main 条目在返回栈上，状态随 SavedStateRegistry 存续）。
    var selected by rememberSaveable { mutableStateOf(normalizeTab(initialTab)) }
    // UX-P3 一键化 funnel：对话页空态 CTA「去助手开始第一个对话」→ 切助手 tab 并让
    // 首个可对话助手自动展开内联输入框（一次性语义：名单就绪即消费）
    var pendingAutoSpawn by rememberSaveable { mutableStateOf(false) }

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
                NavigationBarItem(
                    selected = selected == "mine",
                    onClick = { selected = "mine" },
                    icon = { Icon(Icons.Filled.Person, contentDescription = "我的") },
                    label = { Text("我的") },
                )
            }
        },
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            // UX-P2：状态 chip（五态；点开=「电脑连接状态」页；异常态带一步动作出口）
            ConnectionStatusChip(
                onOpenConnectionStatus = onOpenConnectionStatus,
                onGoConnect = onGatewayConfig,
            )
            when (selected) {
                // 批次 C R6.2：Agents 页「启动托管会话」→ 202 后跳入新会话详情
                // T1 批：zcode provider 卡加「打开遥控」→ remote/{entryId}
                // UX-P3：空态 CTA「诊断连接问题」出口 + CTA 带入的自动展开消费
                "agents" -> AgentsScreen(
                    onOpenSession = onOpenSession,
                    onOpenRemoteEntry = onOpenRemoteEntry,
                    onOpenConnectionStatus = onOpenConnectionStatus,
                    autoOpenSpawn = pendingAutoSpawn,
                    onAutoSpawnConsumed = { pendingAutoSpawn = false },
                )
                // UX-P2：「我的」页（诊断/设备挂载点移入；电脑连接状态卡+入口列表+开发者折叠）
                "mine" -> MineScreen(
                    onOpenConnectionStatus = onOpenConnectionStatus,
                    onGatewayConfig = onGatewayConfig,
                    onOpenDevice = onOpenDevice,
                    onManageRemote = onManageRemote,
                )
                // T1 批：会话页顶部「ZCode 工作区」智能卡（点击开遥控 / 管理入口进条目管理屏）
                // UX-P3：空态 CTA「去助手开始第一个对话」→ 切助手 tab + 自动展开输入框
                else -> SessionsScreen(
                    onOpenSession = onOpenSession,
                    onOpenRemoteEntry = onOpenRemoteEntry,
                    onManageRemote = onManageRemote,
                    onGoAgentsStart = {
                        selected = "agents"
                        pendingAutoSpawn = true
                    },
                )
            }
        }
    }
}

/**
 * UX-P2：main?tab= 旧值兼容映射（纯函数，:app 单测直锁）。
 * 三标签取值 = sessions | agents | mine；P2 前的旧 tab 值 diagnostics/device
 * （挂载点已移入「我的」）映射到 mine——外部导航（gateway 页「诊断连接问题」等）
 * 与任何历史 main?tab= 深链零破坏；未知值回退 sessions（原 else 分支语义）。
 */
internal fun normalizeTab(tab: String?): String = when (tab) {
    "agents" -> "agents"
    "mine", "diagnostics", "device" -> "mine"
    else -> "sessions"
}

/**
 * UX-P2：顶部状态 chip——五态（docs/24 §3）：●已连接 / ◌连接中 / ↻重试中(第n次) /
 * ✕未连接 / ⚠云端连接已连上，电脑不在线。P1 三态可判断性文案语义原样迁入
 * （docs/24 §2.2：还没连接电脑 / 连不上 / 电脑不在线互斥），心跳等数值移出常态面；
 * chip 点开=「电脑连接状态」页；还没连接/未连接附「去连接」、连不上附「诊断连接问题」
 * 一步动作出口（M10/M11/G16 出口不回退）。relay 降级态保持琥珀底显性异常（红线 #1）。
 */
@Composable
private fun ConnectionStatusChip(
    onOpenConnectionStatus: () -> Unit,
    onGoConnect: () -> Unit,
) {
    val state by ConnectionManager.state.collectAsState()
    val activeMode by ConnectionManager.activeMode.collectAsState()
    val upstreamBeacon by ConnectionManager.upstreamBeacon.collectAsState()

    data class ChipSpec(val bg: Color, val fg: Color, val label: String, val action: String?, val actionIsGoConnect: Boolean)

    val spec = when (val s = state) {
        is ConnState.Connected -> when {
            // M2-R3（docs/19 §7.3）：relay 降级态=「云端连接已连上，但电脑不在线」
            // 琥珀 chip 显性异常，绝不显示为正常态——容错降级纪律（不伪造状态红线）。
            activeMode == "relay" && upstreamBeacon == "disconnected" ->
                ChipSpec(Color(0xFFFFECB3), Color(0xFF7A4F00), "⚠ 云端连接已连上，电脑不在线", "查看", false)

            activeMode == "relay" ->
                ChipSpec(Color(0xFFDDEBDD), Color(0xFF1B5E20), "● 已连接（云端连接）", null, false)

            else -> ChipSpec(Color(0xFFDDEBDD), Color(0xFF1B5E20), "● 已连接", null, false)
        }

        is ConnState.Connecting -> ChipSpec(Color(0xFFFFECB3), Color(0xFF7A4F00), "◌ 连接中", null, false)
        is ConnState.Backing ->
            ChipSpec(
                Color(0xFFFFAB91), Color(0xFF7A2400),
                "↻ 连不上：重试中（第 ${s.attempt} 次）", "诊断连接问题", false,
            )
        is ConnState.Unpaired ->
            ChipSpec(Color(0xFFFFCDD2), Color(0xFFB71C1C), "✕ 还没连接电脑", "去连接", true)
        ConnState.Idle -> ChipSpec(Color(0xFFE0E0E0), Color(0xFF37474F), "✕ 未连接", "去连接", true)
    }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Surface(
            color = spec.bg,
            shape = RoundedCornerShape(10.dp),
            modifier = Modifier.clickable { onOpenConnectionStatus() },
        ) {
            Text(
                spec.label,
                fontSize = 12.sp,
                fontWeight = FontWeight.Medium,
                color = spec.fg,
                modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
            )
        }
        Spacer(Modifier.weight(1f))
        spec.action?.let { action ->
            TextButton(onClick = if (spec.actionIsGoConnect) onGoConnect else onOpenConnectionStatus) {
                Text(action, fontSize = 12.sp, color = spec.fg)
            }
        }
    }
}
