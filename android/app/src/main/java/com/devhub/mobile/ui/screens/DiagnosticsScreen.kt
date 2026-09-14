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
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.devhub.mobile.connect.ConnectionManager
import com.devhub.mobile.data.ApiProvider
import com.devhub.mobile.data.remote.ApiError
import com.devhub.mobile.data.remote.DiagnosticsDto
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import java.io.IOException

/**
 * 页面 8：连接诊断页（GET /v1/diagnostics 投影 + 本机连接状态）。
 * 本机块：WS 状态 / 最近错误 / 退避状态 / 最近事件时间（ConnectionManager 真值）。
 */
@Composable
fun DiagnosticsScreen() {
    val context = LocalContext.current
    var diag by remember { mutableStateOf<DiagnosticsDto?>(null) }
    // U2-M5（AUDIT P3#2）：provider 数字 id → catalog displayName/health 映射
    //（数据驱动 = GET /v1/agents 名录，与桌面 AGENT_PROVIDER_CATALOG 行同源；取不到回退 provider #id 如实）
    var agentsById by remember { mutableStateOf<Map<Long, com.devhub.mobile.data.remote.AgentDto>>(emptyMap()) }
    var error by remember { mutableStateOf<com.devhub.mobile.core.ErrorPresent.Presentable?>(null) }

    // R5.3：本页属「连接健康」面 → REST 探测保留 120s 低频节奏（WS 状态/最近事件/错误
    // 已由 ConnectionManager StateFlow 实时驱动，本 effect 只补桌面诊断投影）。
    LaunchedEffect(Unit) {
        while (isActive) {
            try {
                diag = withContext(Dispatchers.IO) { ApiProvider.rest(context).diagnostics() }
                error = null
            } catch (err: ApiError) {
                // U1-M3：错误统一呈现（人话+技术细节折叠），不再直出原码
                error = com.devhub.mobile.core.ErrorPresent.api(err.code, err.message)
            } catch (err: IOException) {
                error = com.devhub.mobile.core.ErrorPresent.io(err)
            } catch (err: Exception) {
                // P0 热修：未预期异常绝不容 UI 协程崩进程（通用人话+technical 保留）
                error = com.devhub.mobile.core.ErrorPresent.io(err)
            }
            runCatching { withContext(Dispatchers.IO) { ApiProvider.projection(context).agents() } }
                .onSuccess { list -> agentsById = list.associateBy { it.id } }
            delay(ConnectionManager.FALLBACK_POLL_MS)
        }
    }

    val connState by ConnectionManager.state.collectAsState()
    val lastEventAt by ConnectionManager.lastEventAtMs.collectAsState()
    val lastWsError by ConnectionManager.lastWsError.collectAsState()
    // M2-R3：模式与 relay 降级信标投影（docs/19 §7.3 容错降级纪律：绝不显示为正常态）
    val activeMode by ConnectionManager.activeMode.collectAsState()
    val upstreamBeacon by ConnectionManager.upstreamBeacon.collectAsState()

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Spacer(Modifier.height(8.dp))
        Text("连接帮助", style = MaterialTheme.typography.titleLarge) // UX-P1 Dg1

        // —— 本机连接状态（WS）——
        Column(
            Modifier
                .fillMaxWidth()
                .padding(vertical = 4.dp),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            // UX-P1（Dg2-Dg4，Top9）：常态面 = 人话一行（零协议词零数值）；
            // 心跳/seq/upstream/beacon 原词/最近错误等原值收「技术详情」折叠（诚实折叠零吞码）。
            Text("手机这头", fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
            Text(
                "连接方式：" + when (activeMode) {
                    "relay" -> "云端连接"
                    "local" -> "同一网络"
                    else -> "未连接"
                },
                fontSize = 12.sp,
            )
            Text(
                "电脑端：" + when {
                    activeMode == "relay" -> if (upstreamBeacon == "disconnected") "不在线" else "在线"
                    activeMode == "local" && connState is com.devhub.mobile.connect.ConnState.Connected -> "在线"
                    else -> "未连接"
                },
                fontSize = 12.sp,
            )
            Text("状态：${ConnectionManager.notificationText()}", fontSize = 12.sp)
            Text(
                "最近事件：" + if (lastEventAt > 0) java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US).format(java.util.Date(lastEventAt)) else "（尚未收到事件）",
                fontSize = 12.sp,
            )
            com.devhub.mobile.ui.components.TechnicalDetailsFold(
                ConnectionManager.diagnosticsSnapshot() + "\n最近错误：${lastWsError ?: "无"}",
                label = "技术详情",
            )
        }

        // —— 桌面诊断投影 ——
        Text("电脑那头", fontWeight = FontWeight.SemiBold, fontSize = 14.sp) // UX-P1 Dg5
        val d = diag
        when {
            d == null && error == null -> CircularProgressIndicator()
            d == null -> com.devhub.mobile.ui.components.ErrorPresentation(
                presentable = error!!,
                headlinePrefix = "加载失败：",
            )
            else -> {
                for (p in d.providers) {
                    Column(Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
                        // U2-M5（AUDIT P3#2）：数字 id → catalog displayName + 健康色徽章
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            val agent = p.id.toLongOrNull()?.let { agentsById[it] }
                            Text(
                                agent?.displayName ?: "助手 #${p.id}",
                                fontWeight = FontWeight.Medium,
                                fontSize = 13.sp,
                                modifier = Modifier.weight(1f),
                            )
                            com.devhub.mobile.ui.components.HealthBadge(agent?.health ?: "unknown")
                        }
                        // UX-P1 Dg6（Top9）：key=value 直出退役 → 逐行人话；原始串（含
                        // dataSource kind/controlNote）进「技术详情」折叠
                        Column(Modifier.padding(top = 2.dp)) {
                            Text(
                                "已安装：" + if (p.installed) "是" else "否",
                                fontSize = 12.sp,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            p.version?.let {
                                Text("版本：$it", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            Text(
                                "程序文件：" + if (p.exeFound) "已找到" else "未找到",
                                fontSize = 12.sp,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            p.dataSourceReadable?.let {
                                Text(
                                    "数据源：" + if (it) "可读取" else "不可读取",
                                    fontSize = 12.sp,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            com.devhub.mobile.ui.components.TechnicalDetailsFold(
                                "installed=${p.installed}" + (p.version?.let { " version=$it" } ?: "") +
                                    " exeFound=${p.exeFound}" +
                                    (p.dataSourceKind?.let { " dataSource=$it" } ?: "") +
                                    (p.dataSourceReadable?.let { " readable=$it" } ?: "") +
                                    (p.controlNote?.let { " control=$it" } ?: ""),
                                label = "技术详情",
                            )
                        }
                    }
                }
                d.gateway?.let { gateway ->
                    // UX-P1 Dg7：key=value 直出退役 → 人话行；lastError 原文进折叠
                    Column(Modifier.padding(top = 2.dp)) {
                        Text(
                            "电脑端服务：" + (if (gateway.enabled) "已开启" else "未开启") +
                                " · " + (if (gateway.running) "运行中" else "未运行"),
                            fontSize = 12.sp,
                        )
                        Text(
                            "端口：${gateway.actualPort ?: gateway.port} · 已连接设备：${gateway.activeDevices} 台",
                            fontSize = 12.sp,
                        )
                        com.devhub.mobile.ui.components.TechnicalDetailsFold(
                            "gateway: enabled=${gateway.enabled} running=${gateway.running} " +
                                "port=${gateway.actualPort ?: gateway.port} activeDevices=${gateway.activeDevices}" +
                                (gateway.lastError?.let { " lastError=$it" } ?: ""),
                            label = if (gateway.lastError != null) "最近错误（技术详情）" else "技术详情",
                        )
                    }
                }
            }
        }
        Spacer(Modifier.height(16.dp))
    }
}
