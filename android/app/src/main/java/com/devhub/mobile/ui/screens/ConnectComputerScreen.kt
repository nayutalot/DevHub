package com.devhub.mobile.ui.screens

import android.os.Build
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.devhub.mobile.connect.ConnectionManager
import com.devhub.mobile.connect.RelayPairingClient
import com.devhub.mobile.core.ErrorPresent
import com.devhub.mobile.core.relay.RelayEndpoint
import com.devhub.mobile.data.ApiProvider
import com.devhub.mobile.data.FixtureMode
import com.devhub.mobile.data.PinFingerprintSaveGate
import com.devhub.mobile.data.SecureStore
import com.devhub.mobile.data.db.DeviceEntity
import com.devhub.mobile.data.db.DevHubDb
import com.devhub.mobile.data.db.GatewayConfigEntity
import com.devhub.mobile.data.remote.ApiError
import com.devhub.mobile.data.remote.RelayHealthProbeFactory
import com.devhub.mobile.data.remote.RelayProbeBuildResult
import com.devhub.mobile.ui.AppState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException

/**
 * UX-P3（docs/briefs/uxp3-flows.md §1.1 + docs/24 §4.1 + docs/26 §4.1）：「连接电脑」单页流
 * ——原 gateway 配置页 + pairing 配对页两页合一（首装咽喉，首装 funnel ≤5 次输入）。
 *
 * 单页结构：选方式（同一网络〔默认〕｜云端连接——显式选择纪律保持，绝不字段嗅探）
 * → 填地址（local：电脑地址，端口收进高级折叠；relay：服务器地址 wss:// 强制校验 +
 *   裸地址拒绝=P2 既有 RelayEndpoint.parse，保存与连接两层同函数零双标）
 * → 输 8 位配对码（「5 分钟内有效」人话）→ [连接]（保存配置 + claim 一键完成，
 *   复用既有校验/claim 函数，协议字段零改动）。
 * - 失败三态人话（docs/24 §2.2）：码不对/过期→电脑上重新生成；连不上→电脑没开机 or
 *   网络不通；其余结构化（人话 headline + 原码进「技术细节」折叠，零吞码）。
 * - 成功 → 安全须知（一次，SecurityNoticeDialog 原样自 PairingScreen 迁入）→ onPaired
 *   （→ 对话页空态引导「去助手开始第一个对话」）。
 * - 高级选项折叠：端口 / pairingId / 证书指纹 / 演示模式——全部可达零删除。
 *
 * 旧路由兼容（红线「路由零破坏」）：gateway 路由保留（已配对用户「连接设置」本体 =
 * GatewayConfigScreen 原样）；pairing 路由保留并渲染本页（401 全局流转 navigate("pairing")
 * 与首装 startDestination 均达同一单页——重定向到单页对应折叠区语义）。
 */
@Composable
fun ConnectComputerScreen(
    onPaired: () -> Unit,
    onDiagnostics: () -> Unit,
    onDemoMode: () -> Unit = {},
    onBack: (() -> Unit)? = null,
) {
    val context = LocalContext.current
    val db = remember { DevHubDb.get(context) }
    val scope = rememberCoroutineScope()
    var mode by remember { mutableStateOf("local") }
    var host by remember { mutableStateOf("10.0.2.2") }
    var port by remember { mutableStateOf("8746") }
    var relayUrl by remember { mutableStateOf("") }
    var pinFingerprints by remember { mutableStateOf("") }
    var pairingId by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }
    var advancedOpen by remember { mutableStateOf(false) }
    var loaded by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    // U1-M3/UX-P1（P8-P13/X10）：失败统一呈现体（人话 headline + 原码/异常收「技术细节」折叠）
    var error by remember { mutableStateOf<ErrorPresent.Presentable?>(null) }
    // UX-P1 G13/G14：「测试连接」成功绿面（人话 + 版本等技术原值收「技术细节」折叠）
    var probeOk by remember { mutableStateOf<ErrorPresent.Presentable?>(null) }
    var showSecurityNotice by remember { mutableStateOf(false) }

    // 401 全局流转（撤销/失效后回到本页，经 pairing 路由）的结构化提示（X9 语义原样）
    val unpaired = AppState.consumeUnpairedMessage()
    if (error == null && unpaired != null) {
        error = unpaired
    }

    LaunchedEffect(Unit) {
        val saved = withContext(Dispatchers.IO) { db.gatewayConfigDao().get() }
        if (saved != null) {
            mode = saved.mode
            host = saved.host
            port = saved.port.toString()
            relayUrl = saved.relayUrl ?: ""
            pinFingerprints = saved.pinFingerprints ?: ""
        }
        loaded = true
    }

    /** relay endpoint 校验（与连接层同函数 RelayEndpoint.parse，绝不双标；文案引 docs/19 §11）。 */
    fun validateRelayUrl(): RelayEndpoint? = try {
        RelayEndpoint.parse(relayUrl)
    } catch (err: IllegalArgumentException) {
        error = ErrorPresent.Presentable(err.message ?: RelayEndpoint.REJECT_REASON)
        null
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (onBack != null) {
            TextButton(onClick = onBack) { Text("< 返回") }
        }
        Text("连接电脑", style = MaterialTheme.typography.titleLarge) // UX-P1 P1
        Text(
            "在电脑的 DevHub 上点「配对新设备」，会显示一个 8 位配对码（5 分钟内有效，用过即废）。\n" +
                "在下面输入它即可连接；输错多次会暂时锁定。",
            fontSize = 13.sp,
        ) // UX-P1 P2 原样（含「5 分钟内有效」人话）

        if (!loaded) {
            CircularProgressIndicator()
            return@Column
        }

        // —— 步骤 1：选方式（显式选择纪律，绝不字段嗅探；G3/G4 原样）——
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            FilterChip(
                selected = mode == "local",
                onClick = { mode = "local" },
                label = { Text("同一网络（直连）") }, // UX-P1 G3
            )
            FilterChip(
                selected = mode == "relay",
                onClick = { mode = "relay" },
                label = { Text("云端连接") }, // UX-P1 G4
            )
        }
        Text(
            if (mode == "local") {
                "手机和电脑连同一个 Wi-Fi（默认）。两种方式共用一把钥匙。"
            } else {
                "电脑不在身边时用，经加密服务器中转。两种方式共用同一把钥匙：切换后无需重新配对。"
            },
            fontSize = 12.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        ) // UX-P1 G2/G9 合并一行（随方式切换）

        // —— 步骤 1：填地址（local：电脑地址，端口进高级；relay：wss 强制 + 裸地址拒绝）——
        if (mode == "local") {
            OutlinedTextField(
                value = host,
                onValueChange = { host = it },
                label = { Text("电脑地址") }, // UX-P1 G5
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
            )
        } else {
            OutlinedTextField(
                value = relayUrl,
                onValueChange = { relayUrl = it.trim() },
                label = { Text("服务器地址") }, // UX-P1 G7
                placeholder = { Text("wss://your-relay-host") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                supportingText = {
                    Text("必须以 wss:// 开头（加密连接）", fontSize = 11.sp) // UX-P1 G8
                },
            )
            if (relayUrl.isNotBlank() && !relayUrl.startsWith("wss://")) {
                Text(
                    RelayEndpoint.REJECT_REASON,
                    color = MaterialTheme.colorScheme.error,
                    fontSize = 12.sp,
                )
            }
            if (pinFingerprints.isBlank()) {
                Text(
                    // UX-P1 G10（自签证书引导；Trust anchor not found 等原值仍由连接失败
                    // 的「技术细节」折叠如实呈现，此处不预演）
                    "若服务器使用自签证书，需要在下方「证书指纹（高级）」里填入证书指纹，否则会连接失败",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.error,
                )
            }
        }

        // —— 步骤 2：输 8 位配对码 ——
        OutlinedTextField(
            value = code,
            onValueChange = { code = it.trim().uppercase() },
            label = { Text("输入 8 位配对码") }, // UX-P1 P4
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )
        Text("手机名：${Build.MODEL}", fontSize = 13.sp) // UX-P1 P5

        // —— 高级选项折叠（端口/pairingId/证书指纹/演示模式 全可达零删除）——
        TextButton(onClick = { advancedOpen = !advancedOpen }) {
            Text(if (advancedOpen) "收起高级选项" else "高级选项（通常无需填写）") // UX-P1 P6 措辞沿用
        }
        if (advancedOpen) {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                if (mode == "local") {
                    // 端口（docs/26 §7.4 折叠裁决：local 默认 8746 通常无需改）
                    OutlinedTextField(
                        value = port,
                        onValueChange = { port = it.filter { c -> c.isDigit() } },
                        label = { Text("端口") },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                    )
                    // pairingId（P6 既有：仅 local REST claim 面；relay 设备腿 pair 帧无此字段）
                    OutlinedTextField(
                        value = pairingId,
                        onValueChange = { pairingId = it.trim() },
                        label = { Text("配对标识 pairingId（可选，如 pair-xxxxxxxx；须与活跃码精确匹配）") },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                    )
                } else {
                    // 证书指纹（docs/19 §10.2 注入式；占位级入口，非空才启用；双指纹轮换窗口）
                    OutlinedTextField(
                        value = pinFingerprints,
                        onValueChange = { pinFingerprints = it },
                        label = { Text("证书指纹（高级，可选）") },
                        modifier = Modifier.fillMaxWidth(),
                        minLines = 2,
                        supportingText = {
                            Text(
                                "SPKI sha256 指纹（sha256/<hex>，逗号/换行分隔；双指纹轮换窗口）。" +
                                    "自签 IP 证书不受系统默认信任：配置指纹后信任锚 = 指纹本身；" +
                                    "留空 = 系统默认信任（生产必须配置）。",
                                fontSize = 11.sp,
                            )
                        },
                    )
                }
                // 演示模式（体验整改批 B 纪律：显式进入，绝无自动回退；标注不弱化）
                TextButton(onClick = {
                    FixtureMode.setEnabled(context, true)
                    scope.launch {
                        withContext(Dispatchers.IO) {
                            if (db.gatewayConfigDao().get() == null) {
                                db.gatewayConfigDao().upsert(
                                    GatewayConfigEntity(host = host.trim(), port = port.toIntOrNull() ?: 8746),
                                )
                            }
                        }
                        onDemoMode()
                    }
                }) { Text("体验演示模式（示例数据，不是真实电脑）") } // UX-P1 G17
            }
        }

        // —— [连接]（保存配置 + claim 一键完成）+ [测试连接]（U2-M5 降 outlined 语义保留）——
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Button(
                onClick = {
                    busy = true
                    error = null
                    probeOk = null
                    scope.launch {
                        try {
                            // 第一段：保存配置（复用 GatewayConfig 保存分支的既有校验函数，协议字段零改动）
                            val savedRelayUrl: String?
                            var savedPin: String? = null
                            if (mode == "relay") {
                                val endpoint = validateRelayUrl()
                                if (endpoint == null) {
                                    busy = false
                                    return@launch
                                }
                                savedRelayUrl = endpoint.url
                                // M3-C6c bug#4：指纹保存层格式校验（PinFingerprintSaveGate，与连接层绝不双标）
                                when (val verdict = PinFingerprintSaveGate.check(mode, pinFingerprints)) {
                                    is PinFingerprintSaveGate.Verdict.Invalid -> {
                                        error = ErrorPresent.Presentable("TLS 指纹格式非法：${verdict.message}")
                                        busy = false
                                        return@launch
                                    }

                                    is PinFingerprintSaveGate.Verdict.Ok -> savedPin = verdict.normalized
                                }
                            } else {
                                savedRelayUrl = null
                            }
                            withContext(Dispatchers.IO) {
                                db.gatewayConfigDao().upsert(
                                    GatewayConfigEntity(
                                        host = host.trim(),
                                        port = port.toIntOrNull() ?: 8746,
                                        mode = mode,
                                        relayUrl = savedRelayUrl,
                                        pinFingerprints = savedPin,
                                    ),
                                )
                            }
                            // AC7b：保存后刷新缓存（连接循环尚未启动，无断旧连新需求；
                            // onPaired 后 ConnectionManager.start() 自带 refreshCachedConfig）
                            ConnectionManager.refreshCachedConfig()

                            // 第二段：claim（M3-C3a 修 1：模式感知传输层，读刚保存的显式选择，绝不嗅探）
                            if (mode == "relay") {
                                val outcome = withContext(Dispatchers.IO) {
                                    RelayPairingClient.pair(context, code = code, deviceName = Build.MODEL)
                                }
                                when (outcome) {
                                    is RelayPairingClient.Outcome.Success -> withContext(Dispatchers.IO) {
                                        // Token 仅此一次明文 → 立即加密入库；绝不显示/日志（红线）
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
                                        // M3-C6c bug#3：rotation 帧在 v1 落库后逐帧应用（tokenVersion 单调门防旧帧）
                                        for (rotation in outcome.pendingRotations) {
                                            RelayPairingClient.applyRotation(context, db, rotation)
                                        }
                                        showSecurityNotice = true
                                    }

                                    is RelayPairingClient.Outcome.Failure -> {
                                        // M3-C6c 小项#6：失败即清空码输入框（残码+新码拼接误输之源）
                                        code = ""
                                        // UX-P1 X10：relay §8.2 结构化文案 + 原码收「技术细节」
                                        error = ErrorPresent.Presentable(outcome.message, "[${outcome.code}]")
                                    }
                                }
                            } else {
                                val result = withContext(Dispatchers.IO) {
                                    // AC7b：pairingId 空白 → null（code-only 主流程）
                                    ApiProvider.rest(context).claim(
                                        pairingId = pairingId.ifBlank { null },
                                        code = code,
                                        deviceName = Build.MODEL,
                                    )
                                }
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
                                showSecurityNotice = true
                            }
                        } catch (err: ApiError) {
                            code = "" // M3-C6c 小项#6
                            error = connectFailurePresentable(mode, err)
                        } catch (err: IOException) {
                            code = "" // M3-C6c 小项#6
                            error = connectFailurePresentable(mode, err)
                        } catch (err: Exception) {
                            code = "" // M3-C6c 小项#6
                            error = ErrorPresent.Presentable("连接出了问题，请重试", err.toString())
                        }
                        busy = false
                    }
                },
                enabled = connectEnabled(code, mode, host, port, relayUrl),
            ) { Text(if (busy) "连接中…" else "连接") } // UX-P1（配对→连接改名）

            // U2-M5（AUDIT P3#6）语义保留：「连接」唯一主按钮，「测试连接」outlined 次级
            OutlinedButton(
                onClick = {
                    busy = true
                    error = null
                    probeOk = null
                    scope.launch {
                        val outcome = withContext(Dispatchers.IO) {
                            probeConnection(mode, host, port, relayUrl, pinFingerprints)
                        }
                        when (outcome) {
                            is ConnectProbeOutcome.Ok -> probeOk = outcome.presentable
                            is ConnectProbeOutcome.Err -> error = outcome.presentable
                        }
                        busy = false
                    }
                },
                // 测试连接只看地址形态，不要求已输码（connectAddressValid 单判）
                enabled = !busy && connectAddressValid(mode, host, port, relayUrl),
            ) { Text("测试连接") }
        }

        if (busy) CircularProgressIndicator()
        // U1-M3：错误 = 人话 +「技术细节」折叠（默认收起）；探测成功 = 绿面提示（G13/G14 既有）
        probeOk?.let {
            Surface(color = Color(0xFFE8F5E9), shape = MaterialTheme.shapes.small) {
                Column(Modifier.padding(8.dp)) {
                    Text(it.headline, fontSize = 13.sp)
                    it.technical?.let { tech -> com.devhub.mobile.ui.components.TechnicalDetailsFold(tech) }
                }
            }
        }
        error?.let {
            com.devhub.mobile.ui.components.ErrorPresentation(presentable = it)
        }

        Spacer(Modifier.height(4.dp))
        TextButton(onClick = onDiagnostics) { Text("诊断连接问题") } // UX-P1 G16/P13 出口
    }

    if (showSecurityNotice) {
        SecurityNoticeDialog(onDismiss = {
            showSecurityNotice = false
            onPaired()
        })
    }
}

/**
 * 地址形态合法性（纯函数，:app 单测直锁）：local = 地址非空 + 端口 1–65535；
 * relay = wss:// 前缀（与保存/连接两层 RelayEndpoint.parse 同判，绝不双标）。
 */
internal fun connectAddressValid(mode: String, host: String, port: String, relayUrl: String): Boolean = when (mode) {
    "relay" -> relayUrl.startsWith("wss://")
    else -> host.isNotBlank() && (port.toIntOrNull() ?: 0) in 1..65535
}

/** 连接按钮可用性（纯函数，:app 单测直锁）：8 位配对码 + 地址形态合法。 */
internal fun connectEnabled(code: String, mode: String, host: String, port: String, relayUrl: String): Boolean =
    code.length == 8 && connectAddressValid(mode, host, port, relayUrl)

/**
 * 失败三态人话（纯函数，:app 单测直锁；docs/24 §2.2 矩阵 + UX-P1 P8-P12 语义原样）：
 * - 码不对/过期（AUTH_INVALID_TOKEN）→ 电脑上重新生成；
 * - 限频（AUTH_RATE_LIMITED）→ 等待秒数；
 * - 电脑未开连接开关（GATEWAY_DISABLED）→ 电脑端打开「允许手机连接」；
 * - 连不上（IOException；§2.2「网络不通/电脑没开」族）：local → 确认开机+DevHub 运行+核对地址；
 *   relay → 检查网络与服务器地址；
 * - 其余 → 通用人话 + 原码收「技术细节」（零吞码）。
 */
internal fun connectFailurePresentable(mode: String, err: Throwable): ErrorPresent.Presentable = when (err) {
    is ApiError -> when (err.code) {
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

        else -> ErrorPresent.Presentable("连接出了问题，请重试", "[${err.code}] ${err.message}")
    }

    is IOException -> if (mode == "relay") {
        ErrorPresent.Presentable("连不上云端服务器：请检查手机网络和服务器地址", err.toString())
    } else {
        // §2.2 local 态：电脑没开/不在同一网络——动作出口=核对地址 + 同页「测试连接/诊断连接问题」
        ErrorPresent.Presentable(
            "连不上电脑：请确认电脑已开机、DevHub 正在运行，并在上方核对电脑地址",
            err.toString(),
        )
    }

    else -> ErrorPresent.Presentable("连接出了问题，请重试", err.toString())
}

/**
 * 「测试连接」探测（自 GatewayConfigScreen 迁入，逻辑原样：relay=https /v1/health 指纹信任锚；
 * local=http host:port 探测；探测用当前输入，未保存也允许先测）。
 */
private suspend fun probeConnection(
    mode: String,
    host: String,
    port: String,
    relayUrl: String,
    pinFingerprints: String,
): ConnectProbeOutcome {
    if (mode == "relay") {
        val endpoint = try {
            RelayEndpoint.parse(relayUrl)
        } catch (err: IllegalArgumentException) {
            return ConnectProbeOutcome.Err(ErrorPresent.Presentable(err.message ?: RelayEndpoint.REJECT_REASON))
        }
        // M3-C7b 修 4（App 崩溃修）：pinning/GatewayApi 构造入 try（非法指纹体折结构化错误）
        val probe = when (val built = RelayHealthProbeFactory.buildRelay(endpoint, pinFingerprints)) {
            is RelayProbeBuildResult.Invalid -> return ConnectProbeOutcome.Err(ErrorPresent.Presentable(built.message))
            is RelayProbeBuildResult.Ok -> built.api
        }
        return try {
            val health = probe.health()
            ConnectProbeOutcome.Ok(
                ErrorPresent.Presentable(
                    "连接成功！对方 DevHub 运行正常",
                    "name=${health.name} · version=${health.version} · uptime=${health.uptimeSec}s",
                ),
            )
        } catch (err: ApiError) {
            ConnectProbeOutcome.Err(
                ErrorPresent.api(err.code, err.message, ErrorPresent.Surface.RELAY_PROBE),
            )
        } catch (err: IOException) {
            ConnectProbeOutcome.Err(ErrorPresent.io(err))
        } catch (err: Exception) {
            ConnectProbeOutcome.Err(ErrorPresent.Presentable("探测失败：请重试", err.toString()))
        }
    } else {
        val portNum = port.toIntOrNull()
            ?: return ConnectProbeOutcome.Err(
                ErrorPresent.Presentable("端口号不对：请填 1–65535 的数字"), // UX-P1 G15
            )
        val probe = com.devhub.mobile.data.remote.GatewayApi(
            baseUrlProvider = { "http://${host.trim()}:$portNum" },
            tokenProvider = { null },
        )
        return try {
            val health = probe.health()
            ConnectProbeOutcome.Ok(
                ErrorPresent.Presentable(
                    "连接成功！对方 DevHub 运行正常",
                    "name=${health.name} · version=${health.version} · uptime=${health.uptimeSec}s",
                ),
            )
        } catch (err: ApiError) {
            ConnectProbeOutcome.Err(
                ErrorPresent.api(err.code, err.message, ErrorPresent.Surface.GATEWAY_PROBE),
            )
        } catch (err: IOException) {
            ConnectProbeOutcome.Err(ErrorPresent.io(err))
        } catch (err: Exception) {
            ConnectProbeOutcome.Err(ErrorPresent.Presentable("探测失败：请重试", err.toString()))
        }
    }
}

/** 「测试连接」探测结果：成功/失败均统一呈现体（UX-P1 G14 语义，自 GatewayConfigScreen 迁入）。 */
private sealed interface ConnectProbeOutcome {
    data class Ok(val presentable: ErrorPresent.Presentable) : ConnectProbeOutcome

    data class Err(val presentable: ErrorPresent.Presentable) : ConnectProbeOutcome
}

/**
 * 安全提示（首配对后一次性展示；SharedPreferences 记忆，非凭据类标记）。
 * UX-P3 自 PairingScreen 原样迁入（P13 四事实全保留，文案零改动）。
 */
@Composable
fun SecurityNoticeDialog(onDismiss: () -> Unit) {
    val context = LocalContext.current
    androidx.compose.material3.AlertDialog(
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
