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
import com.devhub.mobile.core.ErrorPresent
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
    // UX-P1（P8-P13/X9）：连接失败统一呈现体（人话 headline + 原码/异常收「技术细节」折叠）
    var error by remember { mutableStateOf<ErrorPresent.Presentable?>(null) }
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
        Text("连接电脑", style = MaterialTheme.typography.titleLarge) // UX-P1 P1
        Text(
            "在电脑的 DevHub 上点「配对新设备」，会显示一个 8 位配对码（5 分钟内有效，用过即废）。\n" +
                "在下面输入它即可连接；输错多次会暂时锁定。",
            fontSize = 13.sp,
        ) // UX-P1 P2
        Text(
            if (relayMode) "连接方式：云端连接（电脑不在身边也能用）"
            else "连接方式：同一网络直连（手机和电脑连同一个 Wi-Fi）",
            fontSize = 12.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        ) // UX-P1 P3（云端连接定名，主控裁决）

        OutlinedTextField(
            value = code,
            onValueChange = { code = it.trim().uppercase() },
            label = { Text("输入 8 位配对码") }, // UX-P1 P4
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )
        Text("手机名：${Build.MODEL}", fontSize = 13.sp) // UX-P1 P5

        // 高级选项（pairingId）：仅 local REST claim 面（relay 设备腿 pair 帧无此字段）
        if (!relayMode) {
            TextButton(onClick = { advancedOpen = !advancedOpen }) {
                Text(if (advancedOpen) "收起高级选项" else "高级选项（通常无需填写）") // UX-P1 P6
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
                                    // UX-P1 X10：人话头 + 原码收「技术细节」折叠
                                    error = ErrorPresent.Presentable(
                                        outcome.message,
                                        "[${outcome.code}]",
                                    )
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
                        // UX-P1 P8-P12：人话 headline + 原码收「技术细节」折叠
                        error = when (err.code) {
                            "AUTH_INVALID_TOKEN" -> ErrorPresent.Presentable(
                                "连接失败：码不对、已过期或已被使用——请在电脑上重新生成",
                                "[${err.code}] ${err.message}",
                            )

                            "AUTH_RATE_LIMITED" -> ErrorPresent.Presentable(
                                "尝试太频繁：请 ${err.retryAfterSec ?: 60} 秒后再试",
                                "[${err.code}] ${err.message}",
                            )

                            "GATEWAY_DISABLED" -> ErrorPresent.Presentable(
                                "电脑上的 DevHub 没有打开「允许手机连接」开关，请到电脑端设置打开后重试",
                                "[${err.code}] ${err.message}",
                            )

                            else -> ErrorPresent.Presentable(
                                "连接出了问题，请重试",
                                "[${err.code}] ${err.message}",
                            )
                        }
                    } catch (err: IOException) {
                        code = "" // M3-C6c 小项#6：同上
                        error = ErrorPresent.Presentable("连不上电脑：请先在「连接设置」里测试连接", err.toString())
                    } catch (err: Exception) {
                        code = "" // M3-C6c 小项#6：同上
                        error = ErrorPresent.Presentable("连接出了问题，请重试", err.toString())
                    }
                    busy = false
                }
            },
            enabled = code.length == 8 && !busy, // AC7b：code-only 主流程，pairingId 不再必填
        ) { Text(if (busy) "连接中…" else "连接") } // UX-P1（配对→连接改名）

        if (busy) CircularProgressIndicator()
        error?.let {
            com.devhub.mobile.ui.components.ErrorPresentation(presentable = it)
        }
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
            // UX-P1 P13：四事实全保留（钥匙只存本机/摘要通知/强停补齐/仅回复暂停恢复），工程词人话化
            Text(
                "1. 钥匙（设备凭据）只存这台手机的加密存储里，电脑端也不留底，任何界面都不再显示。\n" +
                    "2. 提醒通知只显示摘要；完整内容要点进对话详情才会加载。\n" +
                    "3. App 被强制关闭时可能收不到实时提醒，重新连上后会自动补齐。\n" +
                    "4. 手机端只能「回复/暂停/恢复」对话，不能执行命令或传文件。",
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
