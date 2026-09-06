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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.devhub.mobile.connect.RelayPairingClient
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
 * 主流程 code-only：输入 8 位配对码 → 按已存 Gateway 模式选传输层（M3-C3a 修 1，docs/19 §7.1
 * 「UI 复用现 Pairing 页，仅传输层换」——配对码 UI 零改）：
 * - local  = REST POST /v1/pairing/claim {code, deviceName=Build.MODEL, platform:'android'}
 *   （pairingId 不发送；服务端按「同时仅 1 活跃码」唯一定位；pairingId 折叠为高级选项）；
 * - relay  = WS 裸连接 pair（docs/18 §2/§3.2/§3.3）：wss://<relay>/relay/device 无 Bearer 裸连
 *   → hello → pair 帧（复用 RelayFrame.Pair codec）→ pair_accepted → SecureStore 落凭据
 *   → ConnectionManager 以新 token 重连正式连接（onPaired 回调拉起）。10s 阶段超时 +
 *   §8.2 失败码结构化文案（RelayPairingClient / :core RelayPairingMachine）。
 *   relay 设备腿 pair 帧无 pairingId 字段（属 E→H 中继变体，docs/18 §3.2）→ 高级选项隐藏。
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

    // M3-C3a 修 1：模式感知传输层（显式读取已保存配置，绝不字段嗅探；null = 载入中按 local 处理）
    var gatewayMode by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) {
        gatewayMode = withContext(Dispatchers.IO) { db.gatewayConfigDao().get()?.mode } ?: "local"
    }
    val relayMode = gatewayMode == "relay"

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
        Text(
            if (relayMode) "当前模式：Relay（配对经 wss 裸连接 pair 帧，docs/18 §3.2）"
            else "当前模式：本地（REST claim → 桌面 Gateway）",
            fontSize = 12.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        OutlinedTextField(
            value = code,
            onValueChange = { code = it.trim().uppercase() },
            label = { Text("8 位配对码（Crockford Base32）") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )
        Text("设备名：${Build.MODEL}（platform: android）", fontSize = 13.sp)

        // 高级选项（pairingId）：仅 local REST claim 面（relay 设备腿 pair 帧无此字段）
        if (!relayMode) {
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
        }

        Button(
            onClick = {
                busy = true
                error = null
                scope.launch {
                    try {
                        if (relayMode) {
                            // —— relay：WS 裸连接 pair（docs/18 §3.2/§3.3；状态机在 :core）——
                            val outcome = withContext(Dispatchers.IO) {
                                RelayPairingClient.pair(context, code = code, deviceName = Build.MODEL)
                            }
                            when (outcome) {
                                is RelayPairingClient.Outcome.Success -> {
                                    // Token 仅此一次明文 → 立即加密入库（Keystore AES-GCM）；绝不显示/日志
                                    withContext(Dispatchers.IO) {
                                        SecureStore.savePairing(context, outcome.deviceId, outcome.token)
                                        db.deviceDao().upsert(
                                            DeviceEntity(
                                                deviceId = outcome.deviceId,
                                                deviceName = Build.MODEL,
                                                tokenVersion = outcome.tokenVersion,
                                                gatewayName = "relay:${outcome.relayHost}",
                                                pairedAtSec = System.currentTimeMillis() / 1000,
                                            ),
                                        )
                                        // M3-C6c bug#3：pair 腿捕获的 token_rotation 在 v1 落库**之后**
                                        // 逐帧应用（保序；tokenVersion 单调门防旧帧）——消 ≤300s grace
                                        // 到期自毁竞态（C2c #38/39/40）。newToken 明文零日志红线适用。
                                        for (rotation in outcome.pendingRotations) {
                                            RelayPairingClient.applyRotation(context, db, rotation)
                                        }
                                    }
                                    showSecurityNotice = true // 首配对后一次性安全提示
                                }

                                is RelayPairingClient.Outcome.Failure -> {
                                    // M3-C6c 小项#6：失败即清空码输入框（16 位拼接误输之源：
                                    // 残码 + 新码拼接必败，清空强制整码重输）
                                    code = ""
                                    error = outcome.message
                                }
                            }
                        } else {
                            // —— local：现 REST claim（docs/14 §B.3 原样，零回归）——
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
                        }
                    } catch (err: ApiError) {
                        code = "" // M3-C6c 小项#6：失败即清空码输入框（16 位拼接误输之源）
                        error = when (err.code) {
                            "AUTH_INVALID_TOKEN" -> "配对失败：码无效/已过期/已被使用（一次性）[${err.code}]"
                            "AUTH_RATE_LIMITED" ->
                                "尝试过于频繁（5 次/5 分钟），请 ${err.retryAfterSec ?: 60}s 后重试 [${err.code}]"

                            "GATEWAY_DISABLED" -> "桌面 Gateway 未启用（gateway_enabled=0）[${err.code}]"
                            else -> "配对失败：[${err.code}] ${err.message}"
                        }
                    } catch (err: IOException) {
                        code = "" // M3-C6c 小项#6：同上
                        error = "无法连接 Gateway：请先在「Gateway 配置」页测试连接"
                    } catch (err: Exception) {
                        code = "" // M3-C6c 小项#6：同上
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
