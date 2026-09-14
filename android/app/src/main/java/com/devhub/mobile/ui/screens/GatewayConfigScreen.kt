package com.devhub.mobile.ui.screens

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
import com.devhub.mobile.core.relay.RelayEndpoint
import com.devhub.mobile.data.FixtureMode
import com.devhub.mobile.data.PinFingerprintSaveGate
import com.devhub.mobile.data.db.DevHubDb
import com.devhub.mobile.data.db.GatewayConfigEntity
import com.devhub.mobile.data.remote.ApiError
import com.devhub.mobile.data.remote.GatewayApi
import com.devhub.mobile.data.remote.RelayHealthProbeFactory
import com.devhub.mobile.data.remote.RelayProbeBuildResult
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException

/**
 * 页面 1：Gateway 配置页（docs/11 §7 + M2-R3 双模式 docs/19 §7.1）。
 * - 模式选择（显式选择，绝不字段嗅探）：local = host:port 表单（现状）；
 *   relay = wss endpoint 输入（IP 形态，U1 无域名裁决 docs/21 §1）+「同一设备 Token」说明；
 * - **wss 强制**：relay endpoint 非 `wss://` 拒绝保存（保存与连接两层同用 RelayEndpoint.parse，
 *   绝不双标；文案引 docs/19 §11）；
 * - 指纹高级项（docs/19 §10.2）：SPKI sha256 指纹列表（逗号/换行分隔），占位级入口——
 *   非空才启用 pinning（信任锚 = 指纹，docs/19 §10.5 自签不受系统信任属预期）；
 * - 保存后 refreshCachedConfig + reconnectNow（断旧连新，单连接互斥 W-R6）。
 * 演示模式入口（体验整改批 B）：夹具数据联调用，显式开关、全界面显著标注"演示数据"。
 */
@Composable
fun GatewayConfigScreen(
    onConfigured: () -> Unit,
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
    var pinAdvancedOpen by remember { mutableStateOf(false) }
    var loaded by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    // U1-M3（AUDIT P1#3）+ UX-P1（G13/G14）：成功/提示面亦统一 Presentable
    // （人话 headline；版本/运行时长等技术原值收「技术细节」折叠，零吞码）
    var message by remember { mutableStateOf<com.devhub.mobile.core.ErrorPresent.Presentable?>(null) }
    var errorResult by remember { mutableStateOf<com.devhub.mobile.core.ErrorPresent.Presentable?>(null) }

    /** 错误呈现统一入口：写 errorResult、清成功消息。 */
    fun presentError(p: com.devhub.mobile.core.ErrorPresent.Presentable) {
        message = null
        errorResult = p
    }

    /** 表单校验类错误（无技术细节可折叠；文案本身即人话）。 */
    fun presentFormError(text: String) = presentError(com.devhub.mobile.core.ErrorPresent.Presentable(text))

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

    /** relay endpoint 保存前校验（与连接层同函数，绝不双标；错误文案引 docs/19 §11）。 */
    fun validateRelayUrl(): RelayEndpoint? = try {
        RelayEndpoint.parse(relayUrl)
    } catch (err: IllegalArgumentException) {
        presentFormError(err.message ?: RelayEndpoint.REJECT_REASON)
        null
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        // U1-M6/P2#9（AUDIT，18 号截图）：本页属堆叠推送时补「< 返回」
        // （与其他堆叠页 03/12/15 一致）；首装冷启动直达（返回栈空）不显示
        if (onBack != null) {
            TextButton(onClick = onBack) { Text("< 返回") }
        }
        Text("连接设置", style = MaterialTheme.typography.titleLarge) // UX-P1 G1
        Text(
            "选择怎么连电脑：\n" +
                "· 同一网络：手机和电脑连同一个 Wi-Fi（默认）。\n" +
                "· 云端连接：电脑不在身边时用，经加密服务器中转。\n" +
                "两种方式共用一把钥匙。",
            fontSize = 13.sp,
        ) // UX-P1 G2（云端连接定名，主控裁决）

        if (!loaded) {
            CircularProgressIndicator()
            return@Column
        }

        // —— 模式选择（显式；切换只改表单，保存时生效）——
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

        if (mode == "local") {
            OutlinedTextField(
                value = host,
                onValueChange = { host = it },
                label = { Text("电脑地址") }, // UX-P1 G5
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
            )
            OutlinedTextField(
                value = port,
                onValueChange = { port = it.filter { c -> c.isDigit() } },
                label = { Text("端口") },
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
                    Text(
                        "必须以 wss:// 开头（加密连接）", // UX-P1 G8
                        fontSize = 11.sp,
                    )
                },
            )
            if (relayUrl.isNotBlank() && !relayUrl.startsWith("wss://")) {
                Text(
                    RelayEndpoint.REJECT_REASON,
                    color = MaterialTheme.colorScheme.error,
                    fontSize = 12.sp,
                )
            }
            Text(
                "两种方式共用同一把钥匙：切换后无需重新配对", // UX-P1 G9
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            // M3-C6c bug#4：空指纹引导文案（不硬阻断——留空保存合法，连接层走系统默认信任；
            // C2c 实录：自签 IP 证书场景该形态直到连接层才 fail-closed「Trust anchor not
            // found」，引导前置到配置页）
            if (pinFingerprints.isBlank()) {
                Text(
                    // UX-P1 G10：自签证书引导人话化（Trust anchor not found 等原值在连接失败
                    // 的「技术细节」折叠如实呈现，此处不再预演）
                    "若服务器使用自签证书，需要在下方「证书指纹（高级）」里填入证书指纹，否则会连接失败",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.error,
                )
            }

            // 指纹高级项（docs/19 §10.2 注入式；占位级入口，非空才启用）
            TextButton(onClick = { pinAdvancedOpen = !pinAdvancedOpen }) {
                Text(if (pinAdvancedOpen) "收起证书指纹（高级）" else "证书指纹（高级，可选）")
            }
            if (pinAdvancedOpen) {
                OutlinedTextField(
                    value = pinFingerprints,
                    onValueChange = { pinFingerprints = it },
                    label = { Text("SPKI sha256 指纹（sha256/<hex>，逗号/换行分隔；双指纹轮换窗口）") },
                    modifier = Modifier.fillMaxWidth(),
                    minLines = 2,
                    supportingText = {
                        Text(
                            "自签 IP 证书不受系统默认信任：配置指纹后信任锚 = 指纹本身；" +
                                "留空 = 系统默认信任（生产必须配置）。",
                            fontSize = 11.sp,
                        )
                    },
                )
            }
        }

        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Button(
                onClick = {
                    busy = true
                    message = null
                    errorResult = null
                    scope.launch {
                        try {
                            val savedRelayUrl: String?
                            var savedPin: String? = null
                            if (mode == "relay") {
                                val endpoint = validateRelayUrl()
                                if (endpoint == null) {
                                    busy = false
                                    return@launch
                                }
                                savedRelayUrl = endpoint.url
                                // M3-C6c bug#4：指纹保存层格式校验（复用 :core TlsPinningConfig
                                // fail-fast，与连接层绝不双标）——残行（丢前缀/长度错/非 hex）保存
                                // 即拒，不再后移到 pair 时才 BAD_CONFIG。
                                when (val verdict = PinFingerprintSaveGate.check(mode, pinFingerprints)) {
                                    is PinFingerprintSaveGate.Verdict.Invalid -> {
                                        presentFormError("TLS 指纹格式非法：${verdict.message}")
                                        busy = false
                                        return@launch
                                    }

                                    is PinFingerprintSaveGate.Verdict.Ok -> savedPin = verdict.normalized
                                }
                            } else {
                                savedRelayUrl = null
                            }
                            val portNum = port.toIntOrNull() ?: 8746
                            withContext(Dispatchers.IO) {
                                db.gatewayConfigDao().upsert(
                                    GatewayConfigEntity(
                                        host = host.trim(),
                                        port = portNum,
                                        mode = mode,
                                        relayUrl = savedRelayUrl,
                                        pinFingerprints = savedPin,
                                    ),
                                )
                            }
                            // AC7b：保存后刷新缓存；R3：断旧连新（单连接互斥，切模式即刻生效）
                            ConnectionManager.refreshCachedConfig()
                            ConnectionManager.reconnectNow()
                            message = com.devhub.mobile.core.ErrorPresent.Presentable("已保存") // UX-P1 G13
                            busy = false
                            onConfigured()
                        } catch (err: Exception) {
presentError(com.devhub.mobile.core.ErrorPresent.Presentable("保存失败：请重试", err.toString()))
                            busy = false
                        }
                    }
                },
                enabled = when {
                    busy -> false
                    mode == "local" -> host.isNotBlank() && (port.toIntOrNull() ?: 0) in 1..65535
                    else -> relayUrl.startsWith("wss://")
                },
            ) { Text("保存并继续") }

            // U2-M5（AUDIT P3#6）：「测试连接」降 outlined——「保存并继续」唯一主按钮
            OutlinedButton(
                onClick = {
                    busy = true
                    message = null
                    errorResult = null
                    scope.launch {
                        val outcome = withContext(Dispatchers.IO) {
                            if (mode == "relay") {
                                // relay 探测 = https /v1/health（ECS 终结，docs/18 §7.1）；
                                // 配了指纹 → 指纹即信任锚（RelayTlsTrust）
                                val endpoint = try {
                                    RelayEndpoint.parse(relayUrl)
                                } catch (err: IllegalArgumentException) {
                                    return@withContext ProbeOutcome.Err(
                                        com.devhub.mobile.core.ErrorPresent.Presentable(
                                            err.message ?: RelayEndpoint.REJECT_REASON,
                                        ),
                                    )
                                }
                                // M3-C7b 修 4（App 崩溃修）：pinning/GatewayApi 构造入 try——
                                // TlsPinningConfig 构造期归一化对非法指纹体（输入框残留拼接）
                                // 抛 IllegalArgumentException，此前在 try 外直接杀进程；
                                // 现折结构化错误提示（保存门 PinFingerprintSaveGate 不受影响）
                                val probe = when (val built = RelayHealthProbeFactory.buildRelay(endpoint, pinFingerprints)) {
                                    is RelayProbeBuildResult.Invalid -> return@withContext ProbeOutcome.Err(
                                        com.devhub.mobile.core.ErrorPresent.Presentable(built.message),
                                    )
                                    is RelayProbeBuildResult.Ok -> built.api
                                }
                                try {
                                    val health = probe.health()
                                    // UX-P1 G14：版本/运行时长收「技术细节」折叠
                                    ProbeOutcome.Ok(
                                        com.devhub.mobile.core.ErrorPresent.Presentable(
                                            "连接成功！对方 DevHub 运行正常",
                                            "name=${health.name} · version=${health.version} · uptime=${health.uptimeSec}s",
                                        ),
                                    )
                                } catch (err: ApiError) {
                                    // U1-M3：人话映射 + 原码收「技术细节」（不再直出异常串）
                                    ProbeOutcome.Err(
                                        com.devhub.mobile.core.ErrorPresent.api(
                                            err.code, err.message,
                                            com.devhub.mobile.core.ErrorPresent.Surface.RELAY_PROBE,
                                        ),
                                    )
                                } catch (err: IOException) {
                                    ProbeOutcome.Err(
                                        com.devhub.mobile.core.ErrorPresent.io(err),
                                    )
                                } catch (err: Exception) {
                                    ProbeOutcome.Err(
                                        com.devhub.mobile.core.ErrorPresent.Presentable("探测失败：请重试", err.toString()),
                                    )
                                }
                            } else {
                                val portNum = port.toIntOrNull()
                                    ?: return@withContext ProbeOutcome.Err(
                                        com.devhub.mobile.core.ErrorPresent.Presentable("端口号不对：请填 1–65535 的数字"), // UX-P1 G15
                                    )
                                // 探测使用当前输入（未保存也允许先测）
                                val probe = GatewayApi(
                                    baseUrlProvider = { "http://${host.trim()}:$portNum" },
                                    tokenProvider = { null },
                                )
                                try {
                                    val health = probe.health()
                                    ProbeOutcome.Ok(
                                        com.devhub.mobile.core.ErrorPresent.Presentable(
                                            "连接成功！对方 DevHub 运行正常",
                                            "name=${health.name} · version=${health.version} · uptime=${health.uptimeSec}s",
                                        ),
                                    )
                                } catch (err: ApiError) {
                                    ProbeOutcome.Err(
                                        com.devhub.mobile.core.ErrorPresent.api(
                                            err.code, err.message,
                                            com.devhub.mobile.core.ErrorPresent.Surface.GATEWAY_PROBE,
                                        ),
                                    )
                                } catch (err: IOException) {
                                    ProbeOutcome.Err(
                                        com.devhub.mobile.core.ErrorPresent.io(err),
                                    )
                                } catch (err: Exception) {
                                    ProbeOutcome.Err(
                                        com.devhub.mobile.core.ErrorPresent.Presentable("探测失败：请重试", err.toString()),
                                    )
                                }
                            }
                        }
                        when (outcome) {
                            is ProbeOutcome.Ok -> {
                                message = outcome.presentable
                                errorResult = null
                            }

                            is ProbeOutcome.Err -> presentError(outcome.presentable)
                        }
                        busy = false
                    }
                },
                enabled = when {
                    busy -> false
                    mode == "local" -> host.isNotBlank() && (port.toIntOrNull() ?: 0) in 1..65535
                    else -> relayUrl.startsWith("wss://")
                },
            ) { Text("测试连接") }
        }

        if (busy) CircularProgressIndicator()
        // U1-M3：错误 = 人话 +「技术细节」折叠（默认收起）；成功 = 绿面提示（既有）
        errorResult?.let { err ->
            com.devhub.mobile.ui.components.ErrorPresentation(presentable = err)
        }
        message?.let {
            Surface(
                color = Color(0xFFE8F5E9),
                shape = MaterialTheme.shapes.small,
            ) {
                Column(Modifier.padding(8.dp)) {
                    Text(it.headline, fontSize = 13.sp)
                    it.technical?.let { tech ->
                        com.devhub.mobile.ui.components.TechnicalDetailsFold(tech)
                    }
                }
            }
        }

        Spacer(Modifier.height(4.dp))
        TextButton(onClick = onDiagnostics) { Text("诊断连接问题") } // UX-P1 G16
        // 体验整改批 B：夹具联调入口（显式进入，绝无自动回退；所有界面标注"演示数据"）
        TextButton(onClick = {
            FixtureMode.setEnabled(context, true)
            scope.launch {
                withContext(Dispatchers.IO) {
                    if (db.gatewayConfigDao().get() == null) {
                        db.gatewayConfigDao().upsert(GatewayConfigEntity(host = host.trim(), port = port.toIntOrNull() ?: 8746))
                    }
                }
                onDemoMode()
            }
        }) { Text("体验演示模式（示例数据，不是真实电脑）") } // UX-P1 G17

        // —— U1-M5（AUDIT P1#5）：通知权限入口（拒绝过 → 冷启动不再自动弹，
        // 主动开启面 + 价值说明移到本页；用户主动点击不属自动弹，不受限）——
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            var notifGranted by remember { mutableStateOf(checkNotifGranted(context)) }
            // 从系统设置返回（ON_RESUME）即刷新授权状态
            androidx.lifecycle.compose.LifecycleEventEffect(androidx.lifecycle.Lifecycle.Event.ON_RESUME) {
                notifGranted = checkNotifGranted(context)
            }
            Text("通知权限", style = MaterialTheme.typography.titleMedium)
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

/** 「测试连接」探测结果：成功/失败均统一呈现体（UX-P1 G14：人话 + 技术细节折叠）。 */
private sealed interface ProbeOutcome {
    data class Ok(val presentable: com.devhub.mobile.core.ErrorPresent.Presentable) : ProbeOutcome

    data class Err(val presentable: com.devhub.mobile.core.ErrorPresent.Presentable) : ProbeOutcome
}

/** U1-M5：POST_NOTIFICATIONS 当前授权状态（API 33+ 调用；系统回调/设置页共用判定）。 */
internal fun checkNotifGranted(context: android.content.Context): Boolean =
    androidx.core.content.ContextCompat.checkSelfPermission(
        context, android.Manifest.permission.POST_NOTIFICATIONS,
    ) == android.content.pm.PackageManager.PERMISSION_GRANTED
