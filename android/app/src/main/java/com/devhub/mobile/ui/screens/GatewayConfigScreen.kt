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
import com.devhub.mobile.connect.ConnectionManager
import com.devhub.mobile.data.db.DevHubDb
import com.devhub.mobile.data.db.GatewayConfigEntity
import com.devhub.mobile.data.remote.ApiError
import com.devhub.mobile.data.remote.GatewayApi
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException

/**
 * 页面 1：Gateway 配置页（docs/11 §7）。
 * host:port 输入（默认 10.0.2.2:8746 = 模拟器回环映射）+ 连接测试（GET /v1/health）+ 诊断入口。
 */
@Composable
fun GatewayConfigScreen(
    onConfigured: () -> Unit,
    onDiagnostics: () -> Unit,
) {
    val context = LocalContext.current
    val db = remember { DevHubDb.get(context) }
    val scope = rememberCoroutineScope()
    var host by remember { mutableStateOf("10.0.2.2") }
    var port by remember { mutableStateOf("8746") }
    var loaded by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        val saved = withContext(Dispatchers.IO) { db.gatewayConfigDao().get() }
        if (saved != null) {
            host = saved.host
            port = saved.port.toString()
        }
        loaded = true
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
            "DevHub 桌面端需开启 gateway_enabled（默认 127.0.0.1:8746）。\n" +
                "Android 模拟器经 10.0.2.2 访问宿主机回环。",
            fontSize = 13.sp,
        )

        if (!loaded) {
            CircularProgressIndicator()
            return@Column
        }

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

        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Button(
                onClick = {
                    val portNum = port.toIntOrNull() ?: return@Button
                    busy = true
                    message = null
                    scope.launch {
                        try {
                            withContext(Dispatchers.IO) {
                                db.gatewayConfigDao().upsert(GatewayConfigEntity(host = host.trim(), port = portNum))
                            }
                            // AC7b：保存后刷新 ConnectionManager 的 base-url 内存缓存（DB 读已在本 IO 域完成）
                            ConnectionManager.refreshCachedConfig()
                            message = "已保存。"
                            busy = false
                            onConfigured()
                        } catch (err: Exception) {
                            message = "保存失败：${err.message}"
                            busy = false
                        }
                    }
                },
                enabled = host.isNotBlank() && (port.toIntOrNull() ?: 0) in 1..65535 && !busy,
            ) { Text("保存并继续") }

            Button(
                onClick = {
                    val portNum = port.toIntOrNull() ?: return@Button
                    busy = true
                    message = null
                    scope.launch {
                        val result = withContext(Dispatchers.IO) {
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
                        message = result
                        busy = false
                    }
                },
                enabled = host.isNotBlank() && (port.toIntOrNull() ?: 0) in 1..65535 && !busy,
            ) { Text("测试连接") }
        }

        if (busy) CircularProgressIndicator()
        message?.let { Text(it, fontSize = 13.sp) }

        Spacer(Modifier.height(4.dp))
        TextButton(onClick = onDiagnostics) { Text("打开连接诊断") }
    }
}
