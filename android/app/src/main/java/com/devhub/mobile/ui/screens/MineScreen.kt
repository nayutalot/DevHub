package com.devhub.mobile.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.List
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.devhub.mobile.connect.ConnectionManager
import com.devhub.mobile.connect.ConnState
import com.devhub.mobile.connect.WorkspaceLinkCard
import com.devhub.mobile.connect.WorkspaceLinkController
import com.devhub.mobile.data.FixtureMode
import com.devhub.mobile.data.db.DevHubDb
import com.devhub.mobile.ui.components.WakeHostCard
import com.devhub.mobile.ui.components.wakeCardNeeded
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** UX-P2：「我的」页电脑在线三态（纯判定，:app 单测直锁）。 */
internal enum class ComputerOnlineState { ONLINE, OFFLINE, UNCONNECTED }

/**
 * UX-P2 纯判定：电脑连接状态卡的在线三态（docs/24 §3「我的」电脑卡 + docs/26 §3.3）。
 * 真值映射与诊断页「电脑端」行同源（P1 语义原样）：relay→beacon disconnected=不在线；
 * local+WS Connected=在线；其余（含 relay 未连上云端）=未连接——绝不把未知画成在线。
 */
internal fun computerOnlineState(activeMode: String?, connected: Boolean, upstreamBeacon: String?): ComputerOnlineState =
    when {
        activeMode == "relay" && !connected -> ComputerOnlineState.UNCONNECTED
        activeMode == "relay" ->
            if (upstreamBeacon == "disconnected") ComputerOnlineState.OFFLINE else ComputerOnlineState.ONLINE

        activeMode == "local" && connected -> ComputerOnlineState.ONLINE
        else -> ComputerOnlineState.UNCONNECTED
    }

/**
 * UX-P2（docs/24 §3 + docs/26 §3.3）：「我的」页——微信「我」页范式，
 * 一切低频/配置/状态类收容于此：
 * - 电脑连接状态卡（设备名+在线态，点击=「电脑连接状态」页=现诊断页人话化；动作：连接设置/诊断连接问题/唤醒电脑）；
 * - 入口：连接设置 / 诊断连接问题 / 这台手机 / 消息提醒（通知权限 U1-M5 迁挂）/ 电脑页面管理 / 演示模式；
 * - 开发者选项折叠：设备 ID/令牌版本/心跳与 seq/指纹/诊断原文（P1 内容原样迁入，零吞码）。
 * 诊断（DiagnosticsScreen）与设备（DeviceScreen）屏本体保留，仅挂载点自底栏移入本页（deep link 零破坏）。
 */
@Composable
fun MineScreen(
    onOpenConnectionStatus: () -> Unit = {},
    onGatewayConfig: () -> Unit = {},
    onOpenDevice: () -> Unit = {},
    onManageRemote: () -> Unit = {},
) {
    val context = LocalContext.current
    val db = remember { DevHubDb.get(context) }
    val scope = rememberCoroutineScope()

    val connState by ConnectionManager.state.collectAsState()
    val activeMode by ConnectionManager.activeMode.collectAsState()
    val beacon by ConnectionManager.upstreamBeacon.collectAsState()
    val connected = connState is ConnState.Connected

    val device by db.deviceDao().observe().collectAsState(initial = null)
    val config by db.gatewayConfigDao().observe().collectAsState(initial = null)
    val lastWsError by ConnectionManager.lastWsError.collectAsState()
    val linkState by WorkspaceLinkController.state.collectAsState()

    var fixtureOn by remember { mutableStateOf(FixtureMode.enabled(context)) }
    // Q 批先例：折叠面用 rememberSaveable——跳全屏目的地返回后展开态不丢（tab 切换重建同理）
    var devFoldOpen by rememberSaveable { mutableStateOf(false) } // 开发者选项默认收起（渐进披露）

    // 电脑名（docs/24 §3：取 deviceName，无则「我的电脑」）——桌面投影 Ready.deviceName
    val computerName = (linkState as? WorkspaceLinkCard.State.Ready)?.deviceName
        ?.takeIf { it.isNotBlank() } ?: "我的电脑"
    val online = computerOnlineState(activeMode, connected, beacon)

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp),
    ) {
        Spacer(Modifier.height(8.dp))
        Text("我的", style = MaterialTheme.typography.titleLarge)
        Spacer(Modifier.height(8.dp))

        // —— 电脑连接状态卡（点击=「电脑连接状态」页；relay 降级态琥珀标注，绝不显示为正常态）——
        Surface(
            color = MaterialTheme.colorScheme.surfaceVariant,
            shape = MaterialTheme.shapes.medium,
            modifier = Modifier
                .fillMaxWidth()
                .clickable { onOpenConnectionStatus() },
        ) {
            Column(Modifier.padding(horizontal = 14.dp, vertical = 12.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(
                        Icons.Filled.Home,
                        contentDescription = "电脑",
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(computerName, fontWeight = FontWeight.SemiBold, fontSize = 15.sp, modifier = Modifier.weight(1f))
                    when (online) {
                        ComputerOnlineState.ONLINE -> OnlineChip("● 在线", Color(0xFF1B5E20), Color(0xFFDDEBDD))
                        ComputerOnlineState.OFFLINE -> OnlineChip("○ 不在线", Color(0xFF7A4F00), Color(0xFFFFECB3))
                        ComputerOnlineState.UNCONNECTED -> OnlineChip("未连接", Color(0xFF757575), Color(0xFFE0E0E0))
                    }
                }
                Spacer(Modifier.height(4.dp))
                Text(
                    when {
                        online == ComputerOnlineState.OFFLINE ->
                            "云端连接 · 消息会在电脑上线后自动送达" // P1 M5 语义原样（琥珀态在 chip 承载）
                        activeMode == "relay" -> "云端连接"
                        activeMode == "local" -> "同一网络"
                        connState is ConnState.Unpaired -> "还没连接电脑：先在电脑上生成配对码" // P1 M10/M11
                        else -> "未连接"
                    },
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    TextButton(onClick = onGatewayConfig) { Text("连接设置", fontSize = 13.sp) }
                    TextButton(onClick = onOpenConnectionStatus) { Text("诊断连接问题", fontSize = 13.sp) } // P1 G16
                }
            }
        }

        // 唤醒电脑（relay 原生能力；电脑未确认在线时出现——六态人话原样，UX-P1 A5-A14 不回退）
        if (wakeCardNeeded(activeMode, connected, beacon)) {
            WakeHostCard()
        }

        Spacer(Modifier.height(8.dp))

        // —— 入口列表（微信「我」页渐进披露）——
        EntryRow(Icons.Filled.Settings, "连接设置", onClick = onGatewayConfig)
        EntryRow(Icons.Filled.Build, "诊断连接问题", onClick = onOpenConnectionStatus)
        EntryRow(Icons.Filled.Phone, "这台手机", onClick = onOpenDevice)

        // 消息提醒（通知权限；U1-M5 产物自 GatewayConfig 迁挂：文案原样、价值说明保留）
        NotificationEntry()

        EntryRow(Icons.Filled.List, "电脑页面管理", onClick = onManageRemote)

        // 演示模式（显式开关；夹具纪律标注不弱化——S2/S3 原样迁入）
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .padding(vertical = 6.dp),
        ) {
            Icon(Icons.Filled.PlayArrow, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.width(12.dp))
            Text("演示模式", fontSize = 14.sp, modifier = Modifier.weight(1f))
            Text(
                if (fixtureOn) "开" else "关", // UX-P1 S2
                fontSize = 12.sp,
                color = if (fixtureOn) Color(0xFF7A4F00) else Color(0xFF757575),
            )
            Spacer(Modifier.width(8.dp))
            Switch(
                checked = fixtureOn,
                onCheckedChange = { next ->
                    FixtureMode.setEnabled(context, next)
                    // 切换数据源：清空缓存，防真实/夹具数据混排（原会话页开关语义原样迁入）
                    scope.launch {
                        withContext(Dispatchers.IO) {
                            db.sessionCacheDao().clear()
                            db.messageCacheDao().clear()
                        }
                    }
                    fixtureOn = next
                },
            )
        }
        if (fixtureOn) {
            // UX-P1 S3：演示模式标注不弱化（琥珀底保留）
            Text(
                "演示模式：显示的是示例数据，不是你的电脑",
                fontSize = 11.sp,
                color = Color(0xFF7A4F00),
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = 2.dp)
                    .background(Color(0xFFFFF8E1), RoundedCornerShape(6.dp))
                    .padding(horizontal = 8.dp, vertical = 6.dp),
            )
        }

        // —— 开发者选项（默认收起的三级折叠：设备 ID/令牌版本/心跳与 seq/指纹/诊断原文；
        // P1 已人话化的内容原样迁入，技术原值零吞码）——
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .clickable { devFoldOpen = !devFoldOpen }
                .padding(vertical = 12.dp),
        ) {
            Icon(Icons.Filled.Info, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.width(12.dp))
            Text("开发者选项", fontSize = 14.sp, modifier = Modifier.weight(1f))
            Icon(
                if (devFoldOpen) Icons.Filled.KeyboardArrowUp else Icons.Filled.KeyboardArrowDown,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (devFoldOpen) {
            val d = device
            Column(
                Modifier
                    .fillMaxWidth()
                    .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(8.dp))
                    .padding(10.dp),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                Text("设备 ID：${d?.deviceId ?: "（未连接）"}", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text("令牌版本：${d?.tokenVersion ?: "—"}", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                d?.gatewayName?.let {
                    Text("连接原串：gateway=$it", fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Text(
                    ConnectionManager.diagnosticsSnapshot(), // 心跳与 seq（P1 折叠区原文，docs/25 M5-M12）
                    fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    "证书指纹：${config?.pinFingerprints?.takeIf { it.isNotBlank() } ?: "未启用"}",
                    fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    "最近错误：${lastWsError ?: "无"}",
                    fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        Spacer(Modifier.height(16.dp))
    }
}

@Composable
private fun OnlineChip(label: String, fg: Color, bg: Color) {
    Text(
        label,
        fontSize = 12.sp,
        color = fg,
        fontWeight = FontWeight.Medium,
        modifier = Modifier
            .background(bg, RoundedCornerShape(6.dp))
            .padding(horizontal = 8.dp, vertical = 3.dp),
    )
}

@Composable
private fun EntryRow(
    icon: ImageVector,
    label: String,
    onClick: () -> Unit,
    trailing: (@Composable () -> Unit)? = null,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(vertical = 12.dp),
    ) {
        Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.width(12.dp))
        Text(label, fontSize = 14.sp, modifier = Modifier.weight(1f))
        if (trailing != null) {
            trailing()
        } else {
            Icon(Icons.Filled.KeyboardArrowRight, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/**
 * 消息提醒（通知权限）入口：U1-M5（AUDIT P1#5）产物自 GatewayConfigScreen 迁挂「我的」
 * （docs/24 §3「我的」清单；docs/26 §3.3）——P1 文案原样迁入：价值说明、拒绝过不再自动弹
 * 的说明、系统设置跳转按钮全部保留；授权状态 ON_RESUME 刷新语义不变。
 */
@Composable
private fun NotificationEntry() {
    if (android.os.Build.VERSION.SDK_INT < 33) return
    val context = LocalContext.current
    var expanded by rememberSaveable { mutableStateOf(false) }
    var notifGranted by remember { mutableStateOf(checkNotifGranted(context)) }
    // 从系统设置返回（ON_RESUME）即刷新授权状态（U1-M5 语义原样）
    androidx.lifecycle.compose.LifecycleEventEffect(androidx.lifecycle.Lifecycle.Event.ON_RESUME) {
        notifGranted = checkNotifGranted(context)
    }
    EntryRow(
        Icons.Filled.Notifications,
        "消息提醒",
        onClick = { expanded = !expanded },
        trailing = {
            Text(
                if (notifGranted) "已开启" else "未开启",
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        },
    )
    if (expanded) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(start = 36.dp, bottom = 8.dp),
        ) {
            Text(
                if (notifGranted) {
                    "已授权：对话事件（等待输入、新对话等）将按系统通知提醒。"
                } else {
                    "用于对话事件提醒（等待输入、新对话等）。此前拒绝过将不再自动弹出，可随时在此开启。"
                },
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (!notifGranted) {
                TextButton(onClick = {
                    context.startActivity(
                        android.content.Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                            .putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, context.packageName),
                    )
                }) { Text("开启通知权限") }
            }
        }
    }
}
