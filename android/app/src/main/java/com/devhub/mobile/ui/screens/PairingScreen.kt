package com.devhub.mobile.ui.screens

import android.os.Build
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.devhub.mobile.data.ApiProvider
import com.devhub.mobile.data.SecureStore
import com.devhub.mobile.data.db.DeviceEntity
import com.devhub.mobile.data.db.DevHubDb
import com.devhub.mobile.data.remote.ApiError
import com.devhub.mobile.ui.AppState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException

/**
 * 页面 2：配对页（docs/14 §B.3 时序；§B.1 claim 行 AC7b 实现注记）。
 * 主流程 code-only：输入 8 位配对码 → POST /v1/pairing/claim
 * {code, deviceName=Build.MODEL, platform:'android'}（pairingId 不发送）→
 * {deviceId, token}；服务端按「同时仅 1 活跃码」唯一定位。pairingId 折叠为
 * 高级选项（可选提供，提供时服务端要求与活跃码精确匹配）。
 * 成功后 Token 存 Android Keystore（AES-GCM 加密落 SharedPreferences，见 SecureStore）
 * → 进入 Agent 列表。配对失败（过期/已用/限流/禁用）结构化展示。
 * Token 明文绝不在任何成功页显示（红线）。
 */
@Composable
fun PairingScreen(onPaired: () -> Unit) {
    val context = LocalContext.current
    val db = remember { DevHubDb.get(context) }
    val scope = rememberCoroutineScope()
    var pairingId by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }
    var advancedOpen by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var showSecurityNotice by remember { mutableStateOf(false) }

    // 401 全局流转（撤销/失效后回到本页）的结构化提示
    val unpaired = AppState.consumeUnpairedMessage()
    if (error == null && unpaired != null) {
        error = unpaired
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("配对设备", style = MaterialTheme.typography.titleLarge)
        Text(
            "桌面 DevHub → Agents 视图 →「配对新设备」会签发 8 位一次性配对码（TTL 300s）。\n" +
                "输入码即可配对（码即唯一定位）；码即用即废；claim 限流：同源 5 次 / 5 分钟。",
            fontSize = 13.sp,
        )

        OutlinedTextField(
            value = code,
            onValueChange = { code = it.trim().uppercase() },
            label = { Text("8 位配对码（Crockford Base32）") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )
        Text("设备名：${Build.MODEL}（platform: android）", fontSize = 13.sp)

        // AC7b：pairingId 折叠为高级选项（默认收起；code-only 为主流程）
        TextButton(onClick = { advancedOpen = !advancedOpen }) {
            Text(if (advancedOpen) "收起高级选项" else "高级选项（pairingId，通常无需填写）")
        }
        if (advancedOpen) {
            OutlinedTextField(
                value = pairingId,
                onValueChange = { pairingId = it.trim() },
                label = { Text("配对标识 pairingId（可选，如 pair-xxxxxxxx；须与活跃码精确匹配）") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
            )
        }

        Button(
            onClick = {
                busy = true
                error = null
                scope.launch {
                    try {
                        val result = withContext(Dispatchers.IO) {
                            // AC7b：pairingId 空白 → null（请求体不含该字段，code-only 主流程）
                            ApiProvider.rest(context).claim(
                                pairingId = pairingId.ifBlank { null },
                                code = code,
                                deviceName = Build.MODEL,
                            )
                        }
                        // Token 仅此一次明文 → 立即加密入库（Keystore AES-GCM）；绝不显示/日志
                        withContext(Dispatchers.IO) {
                            SecureStore.savePairing(context, result.deviceId, result.token)
                            db.deviceDao().upsert(
                                DeviceEntity(
                                    deviceId = result.deviceId,
                                    deviceName = Build.MODEL,
                                    tokenVersion = result.tokenVersion,
                                    gatewayName = result.gatewayName,
                                    pairedAtSec = System.currentTimeMillis() / 1000,
                                ),
                            )
                        }
                        showSecurityNotice = true // 首配对后一次性安全提示
                    } catch (err: ApiError) {
                        error = when (err.code) {
                            "AUTH_INVALID_TOKEN" -> "配对失败：码无效/已过期/已被使用（一次性）[${err.code}]"
                            "AUTH_RATE_LIMITED" ->
                                "尝试过于频繁（5 次/5 分钟），请 ${err.retryAfterSec ?: 60}s 后重试 [${err.code}]"

                            "GATEWAY_DISABLED" -> "桌面 Gateway 未启用（gateway_enabled=0）[${err.code}]"
                            else -> "配对失败：[${err.code}] ${err.message}"
                        }
                    } catch (err: IOException) {
                        error = "无法连接 Gateway：请先在「Gateway 配置」页测试连接"
                    } catch (err: Exception) {
                        error = "配对异常：${err.message}"
                    }
                    busy = false
                }
            },
            enabled = code.length == 8 && !busy, // AC7b：code-only 主流程，pairingId 不再必填
        ) { Text(if (busy) "配对中…" else "配对") }

        if (busy) CircularProgressIndicator()
        error?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 13.sp) }
    }

    if (showSecurityNotice) {
        SecurityNoticeDialog(onDismiss = {
            showSecurityNotice = false
            onPaired()
        })
    }
}

/** 安全提示（首配对后一次性展示；SharedPreferences 记忆，非凭据类标记）。 */
@Composable
fun SecurityNoticeDialog(onDismiss: () -> Unit) {
    val context = LocalContext.current
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("安全须知") },
        text = {
            Text(
                "1. 设备 Token 仅存本机 Android Keystore（AES-GCM 加密），桌面端只存哈希，任何界面不再显示明文。\n" +
                    "2. 通知仅展示脱敏摘要；完整上下文需点进会话详情才加载。\n" +
                    "3. App 被强停期间 WS 断开，无实时通知保证；重连后按 sequence 补齐。\n" +
                    "4. 远程控制仅 reply / pause / resume 三种会话动作，无 shell/文件通道。",
                fontSize = 13.sp,
            )
        },
        confirmButton = {
            TextButton(onClick = {
                context.getSharedPreferences("devhub_ui_flags", 0)
                    .edit().putBoolean("security_notice_shown", true).apply()
                onDismiss()
            }) { Text("我知道了") }
        },
    )
}
