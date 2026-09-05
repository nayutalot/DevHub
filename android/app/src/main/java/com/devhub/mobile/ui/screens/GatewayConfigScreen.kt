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
import com.devhub.mobile.data.db.DevHubDb
import com.devhub.mobile.data.db.GatewayConfigEntity
import com.devhub.mobile.data.remote.ApiError
import com.devhub.mobile.data.remote.GatewayApi
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
    var message by remember { mutableStateOf<String?>(null) }
    var messageIsError by remember { mutableStateOf(false) }

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
        message = err.message ?: RelayEndpoint.REJECT_REASON
        messageIsError = true
        null
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Remote Gateway 配置", style = MaterialTheme.typography.titleLarge)
        Text(
            "连接模式（显式选择，同一设备 Token 两模式通用）：\n" +
                "· 本地模式：桌面 DevHub 开启 gateway_enabled（默认 127.0.0.1:8746），模拟器经 10.0.2.2 访问。\n" +
                "· Relay 模式：经 ECS 中继（wss://，强制 TLS）——电脑不在同一内网时使用。",
            fontSize = 13.sp,
        )

        if (!loaded) {
            CircularProgressIndicator()
            return@Column
        }

        // —— 模式选择（显式；切换只改表单，保存时生效）——
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            FilterChip(
                selected = mode == "local",
                onClick = { mode = "local" },
                label = { Text("本地模式") },
            )
            FilterChip(
                selected = mode == "relay",
                onClick = { mode = "relay" },
                label = { Text("Relay 模式") },
            )
        }

        if (mode == "local") {
            OutlinedTextField(
                value = host,
                onValueChange = { host = it },
                label = { Text("主机") },
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
                label = { Text("Relay endpoint（wss://IP[:端口]，如 wss://59.110.149.11）") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                supportingText = {
                    Text(
                        "仅接受 wss://（docs/19 §11：ws:// 明文禁作正式方案，代码层拒绝保存与连接）",
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
                "使用与本地模式相同的设备 Token（docs/19 §7.1：凭据共用，无需重新配对）。",
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

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
                            "自签 IP 证书不受系统默认信任（docs/19 §10.5 属预期）：配置指纹后信任锚 = 指纹本身；" +
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
                    messageIsError = false
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
                                savedPin = pinFingerprints.trim().takeIf { it.isNotEmpty() }
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
                            message = if (mode == "relay") "已保存（Relay 模式）。" else "已保存。"
                            busy = false
                            onConfigured()
                        } catch (err: Exception) {
                            message = "保存失败：${err.message}"
                            messageIsError = true
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

            Button(
                onClick = {
                    busy = true
                    message = null
                    messageIsError = false
                    scope.launch {
                        val result = withContext(Dispatchers.IO) {
                            if (mode == "relay") {
                                // relay 探测 = https /v1/health（ECS 终结，docs/18 §7.1）；
                                // 配了指纹 → 指纹即信任锚（RelayTlsTrust）
                                val endpoint = try {
                                    RelayEndpoint.parse(relayUrl)
                                } catch (err: IllegalArgumentException) {
                                    return@withContext err.message ?: RelayEndpoint.REJECT_REASON
                                }
                                val pinning = pinFingerprints.split(',', '\n', ';')
                                    .map { it.trim() }
                                    .filter { it.isNotEmpty() }
                                    .takeIf { it.isNotEmpty() }
                                    ?.let { com.devhub.mobile.core.TlsPinningConfig(it) }
                                val probe = GatewayApi(
                                    baseUrlProvider = { "https://${endpoint.host}:${endpoint.port}" },
                                    tokenProvider = { null },
                                    tlsPinning = pinning,
                                )
                                try {
                                    val health = probe.health()
                                    "连接成功：${health.name} v${health.version}（运行 ${health.uptimeSec}s）"
                                } catch (err: ApiError) {
                                    "Relay 结构化错误：[${err.code}] ${err.message}"
                                } catch (err: IOException) {
                                    "无法连接 Relay（TLS/网络层）：$err"
                                } catch (err: Exception) {
                                    "探测失败：${err.message}"
                                }
                            } else {
                                val portNum = port.toIntOrNull() ?: return@withContext "端口非法"
                                // 探测使用当前输入（未保存也允许先测）
                                val probe = GatewayApi(
                                    baseUrlProvider = { "http://${host.trim()}:$portNum" },
                                    tokenProvider = { null },
                                )
                                try {
                                    val health = probe.health()
                                    "连接成功：${health.name} v${health.version}（运行 ${health.uptimeSec}s）"
                                } catch (err: ApiError) {
                                    "网关结构化错误：[${err.code}] ${err.message}"
                                } catch (err: IOException) {
                                    "无法连接：确认桌面已启用 Gateway 且端口正确（$err）"
                                } catch (err: Exception) {
                                    "探测失败：${err.message}"
                                }
                            }
                        }
                        message = result
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
        message?.let {
            Surface(
                color = if (messageIsError) Color(0xFFFFEBEE) else Color(0xFFE8F5E9),
                shape = MaterialTheme.shapes.small,
            ) {
                Text(it, fontSize = 13.sp, modifier = Modifier.padding(8.dp))
            }
        }

        Spacer(Modifier.height(4.dp))
        TextButton(onClick = onDiagnostics) { Text("打开连接诊断") }
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
        }) { Text("进入演示模式（夹具数据 · 非真实 Gateway）") }
    }
}
