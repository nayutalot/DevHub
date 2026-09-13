package com.devhub.mobile.ui.screens

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
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.devhub.mobile.connect.ConnectionManager
import com.devhub.mobile.connect.GatewayConnectionService
import com.devhub.mobile.connect.SelfRevokeSubmit
import com.devhub.mobile.data.ApiProvider
import com.devhub.mobile.data.SecureStore
import com.devhub.mobile.data.db.DeviceEntity
import com.devhub.mobile.data.db.DevHubDb
import com.devhub.mobile.data.remote.ApiError
import com.devhub.mobile.data.remote.DeviceDto
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 页面 9：设备管理页（docs/11 §7）。
 * 显示本设备（deviceId / 设备名 / 配对时间 / 最近在线 / tokenVersion）
 * + 撤销自己（DELETE /v1/devices/{id}，docs/14 §B.1 仅自撤销）→ 清 Token 回配对页。
 */
@Composable
fun DeviceScreen() {
    val context = LocalContext.current
    val db = remember { DevHubDb.get(context) }
    val scope = rememberCoroutineScope()
    var own by remember { mutableStateOf<DeviceEntity?>(null) }
    var serverRow by remember { mutableStateOf<DeviceDto?>(null) }
    // U1-M3（AUDIT P1#3/P2#10）：错误统一呈现体——relay 模式 /v1/devices NOT_FOUND
    // → 人话「当前接入点不提供设备列表」；原码收「技术细节」折叠
    var error by remember { mutableStateOf<com.devhub.mobile.core.ErrorPresent.Presentable?>(null) }
    var confirmingRevoke by remember { mutableStateOf(false) }
    var revoking by remember { mutableStateOf(false) }

    // R5.3：事件驱动为主（refreshSignal 变化即立即拉取服务端状态）+ 120s 低频兜底（原 3s 退役）
    val refreshSignal by ConnectionManager.refreshSignal.collectAsState()
    LaunchedEffect(refreshSignal) {
        own = withContext(Dispatchers.IO) { db.deviceDao().get() }
        val ownId = own?.deviceId ?: SecureStore.loadDeviceId(context)
        while (ownId != null && isActive) {
            try {
                serverRow = withContext(Dispatchers.IO) {
                    ApiProvider.rest(context).devices().firstOrNull { it.id == ownId }
                }
                error = null
            } catch (err: ApiError) {
                error = com.devhub.mobile.core.ErrorPresent.api(
                    err.code, err.message,
                    com.devhub.mobile.core.ErrorPresent.Surface.DEVICE_LIST,
                )
            } catch (err: IOException) {
                error = com.devhub.mobile.core.ErrorPresent.io(err)
            } catch (err: Exception) {
                // P0 热修：未预期异常绝不容 UI 协程崩进程（通用人话+technical 保留）
                error = com.devhub.mobile.core.ErrorPresent.io(err)
            }
            delay(ConnectionManager.FALLBACK_POLL_MS)
        }
    }

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("设备管理", style = MaterialTheme.typography.titleLarge)
        val o = own
        if (o == null) {
            Text("本机尚未配对", fontSize = 13.sp)
            return@Column
        }

        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text("本设备", fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
            // U1-M6/P2#4（AUDIT，17/21 号截图）：原始 JSON key 不再直出，标签统一中文
            //（deviceId/platform/gateway 为产品术语，术语词保留英文形态）
            Text("设备 ID：${o.deviceId}", fontSize = 13.sp)
            Text("设备名：${o.deviceName}", fontSize = 13.sp)
            Text("平台：Android", fontSize = 13.sp)
            Text("配对时间：" + formatSec(o.pairedAtSec), fontSize = 13.sp)
            Text("网关：${o.gatewayName}", fontSize = 13.sp)
        }

        serverRow?.let { row ->
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text("服务端状态", fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                Text("状态：${row.status}", fontSize = 13.sp)
                Text("最近在线：" + (row.lastSeenAtSec?.let { formatSec(it) } ?: "（从未）"), fontSize = 13.sp)
                Text("令牌版本：${row.tokenVersion}", fontSize = 13.sp)
            }
        }
        error?.let {
            com.devhub.mobile.ui.components.ErrorPresentation(presentable = it)
        }

        Spacer(Modifier.height(8.dp))
        // U1-M6/P2#5（AUDIT，17 号截图）：撤销=不可恢复的破坏性操作，
        // 弃用绿色主按钮样式，改 error 色系（警示语义）；确认对话框既有保留
        Button(
            onClick = { confirmingRevoke = true },
            enabled = !revoking,
            colors = ButtonDefaults.buttonColors(
                containerColor = MaterialTheme.colorScheme.error,
                contentColor = MaterialTheme.colorScheme.onError,
            ),
        ) {
            Text(if (revoking) "撤销中…" else "撤销本设备")
        }
        Text(
            "撤销后：本机 Token 即被拒绝、WS 立即断开、凭据清除并回到配对页（桌面端可随时重新配对）。",
            fontSize = 12.sp,
        )
    }

    if (confirmingRevoke) {
        AlertDialog(
            onDismissRequest = { confirmingRevoke = false },
            title = { Text("撤销本设备？") },
            text = { Text("撤销即刻生效且不可恢复：设备 Token 永久拒绝（需重新配对才能继续远程控制）。") },
            confirmButton = {
                TextButton(onClick = {
                    confirmingRevoke = false
                    val ownId = own?.deviceId ?: return@TextButton
                    revoking = true
                    scope.launch {
                        if (ConnectionManager.configuredMode() == "relay") {
                            // M3-E1（docs/18 §5.3/§10 通道迁移）：relay 模式自撤销走 WS command
                            // revoke_device——成功收口 = disconnect(revoked) 到达（onAuthFatal 清
                            // 凭据 + 停重连，UI 经 Unpaired 状态回配对页）；绝不自动重连（§3.15）。
                            when (val r = ConnectionManager.submitSelfRevokeRelay()) {
                                is SelfRevokeSubmit.Revoked -> Unit // 收口完成：状态机已接管 UI 导航

                                is SelfRevokeSubmit.Queued -> {
                                    error = com.devhub.mobile.core.ErrorPresent.Presentable(
                                        "撤销已排队（电脑离线）：连接恢复后自动执行",
                                    )
                                    revoking = false
                                }

                                is SelfRevokeSubmit.Rejected -> {
                                    error = com.devhub.mobile.core.ErrorPresent.api(
                                        r.code, r.message,
                                        com.devhub.mobile.core.ErrorPresent.Surface.COMMAND,
                                    )
                                    revoking = false
                                }
                            }
                            return@launch
                        }
                        try {
                            withContext(Dispatchers.IO) { ApiProvider.rest(context).revokeSelf(ownId) }
                        } catch (err: ApiError) {
                            // M3-C6c bug#2 波及面修正：仅服务端明确回 DEVICE_REVOKED 才算「已撤销」
                            // 成功语义；其余 401（如 AUTH_INVALID_TOKEN——撤销未在事实源发生：
                            // relay 模式打错面/Token 已失效等）绝不伪报成功（旧判断把 httpCode==401
                            // 一律短路成撤销成功而 ECS 侧零撤销，本机凭据被误清）。
                            if (err.code != "DEVICE_REVOKED") {
                                error = com.devhub.mobile.core.ErrorPresent.api(
                                    err.code, err.message,
                                    com.devhub.mobile.core.ErrorPresent.Surface.COMMAND,
                                )
                                revoking = false
                                return@launch
                            }
                        } catch (err: IOException) {
                            error = com.devhub.mobile.core.ErrorPresent.Presentable(
                                "网络不可达：撤销未执行",
                                err.toString(),
                            )
                            revoking = false
                            return@launch
                        }
                        withContext(Dispatchers.IO) {
                            SecureStore.clear(context)
                            db.deviceDao().clear()
                        }
                        ConnectionManager.stop()
                        GatewayConnectionService.stop(context)
                        revoking = false
                    }
                }) { Text("确认撤销") }
            },
            dismissButton = { TextButton(onClick = { confirmingRevoke = false }) { Text("取消") } },
        )
    }
}

private fun formatSec(sec: Long): String =
    SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(Date(sec * 1000))
