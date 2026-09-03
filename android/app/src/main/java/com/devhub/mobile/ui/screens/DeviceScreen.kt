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
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
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
    var error by remember { mutableStateOf<String?>(null) }
    var confirmingRevoke by remember { mutableStateOf(false) }
    var revoking by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        own = withContext(Dispatchers.IO) { db.deviceDao().get() }
        val ownId = own?.deviceId ?: SecureStore.loadDeviceId(context)
        while (ownId != null && isActive) {
            try {
                serverRow = withContext(Dispatchers.IO) {
                    ApiProvider.rest(context).devices().firstOrNull { it.id == ownId }
                }
                error = null
            } catch (err: ApiError) {
                error = "[${err.code}] ${err.message}"
            } catch (err: IOException) {
                error = "网络不可达（显示本地身份）"
            }
            delay(3000)
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
            Text("deviceId：${o.deviceId}", fontSize = 13.sp)
            Text("设备名：${o.deviceName}", fontSize = 13.sp)
            Text("platform：android", fontSize = 13.sp)
            Text("配对时间：" + formatSec(o.pairedAtSec), fontSize = 13.sp)
            Text("gateway：${o.gatewayName}", fontSize = 13.sp)
        }

        serverRow?.let { row ->
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text("服务端状态", fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                Text("status：${row.status}", fontSize = 13.sp)
                Text("lastSeen：" + (row.lastSeenAtSec?.let { formatSec(it) } ?: "（从未）"), fontSize = 13.sp)
                Text("tokenVersion：${row.tokenVersion}", fontSize = 13.sp)
            }
        }
        error?.let { Text(it, fontSize = 12.sp, color = MaterialTheme.colorScheme.error) }

        Spacer(Modifier.height(8.dp))
        Button(onClick = { confirmingRevoke = true }, enabled = !revoking) {
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
                        try {
                            withContext(Dispatchers.IO) { ApiProvider.rest(context).revokeSelf(ownId) }
                        } catch (err: ApiError) {
                            // 401 DEVICE_REVOKED 也属成功语义（已撤销）
                            if (err.code != "DEVICE_REVOKED" && err.httpCode != 401) {
                                error = "[${err.code}] ${err.message}"
                                revoking = false
                                return@launch
                            }
                        } catch (err: IOException) {
                            error = "网络不可达：撤销未执行"
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
