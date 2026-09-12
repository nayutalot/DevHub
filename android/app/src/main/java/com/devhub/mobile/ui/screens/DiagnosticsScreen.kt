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
        Text("连接诊断", style = MaterialTheme.typography.titleLarge)

        // —— 本机连接状态（WS）——
        Column(
            Modifier
                .fillMaxWidth()
                .padding(vertical = 4.dp),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text("本机连接状态（WebSocket）", fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
            Text(
                "连接面：" + when (activeMode) {
                    "relay" -> "Relay（${ConnectionManager.connectionDisplay()}）" +
                        (upstreamBeacon?.let { " · 电脑端 $it" } ?: "")

                    "local" -> "本地（${ConnectionManager.connectionDisplay()}）"
                    else -> "未连接"
                },
                fontSize = 12.sp,
            )
            Text("状态：${ConnectionManager.diagnosticsSnapshot()}", fontSize = 12.sp)
            Text(
                "最近事件：" + if (lastEventAt > 0) java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US).format(java.util.Date(lastEventAt)) else "（尚未收到事件）",
                fontSize = 12.sp,
            )
            Text("最近错误：${lastWsError ?: "无"}", fontSize = 12.sp)
        }

        // —— 桌面诊断投影 ——
        Text("桌面端诊断（/v1/diagnostics）", fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
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
                                agent?.displayName ?: "provider #${p.id}",
                                fontWeight = FontWeight.Medium,
                                fontSize = 13.sp,
                                modifier = Modifier.weight(1f),
                            )
                            com.devhub.mobile.ui.components.HealthBadge(agent?.health ?: "unknown")
                        }
                        Text(
                            "installed=${p.installed}" + (p.version?.let { " version=$it" } ?: "") +
                                " exeFound=${p.exeFound}" +
                                (p.dataSourceKind?.let { " dataSource=$it" } ?: "") +
                                (p.dataSourceReadable?.let { " readable=$it" } ?: "") +
                                (p.controlNote?.let { " control=$it" } ?: ""),
                            fontSize = 11.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant, // 打磨批 D：深色主题次级色
                        )
                    }
                }
                d.gateway?.let { gateway ->
                    Text(
                        "gateway: enabled=${gateway.enabled} running=${gateway.running} " +
                            "port=${gateway.actualPort ?: gateway.port} activeDevices=${gateway.activeDevices}" +
                            (gateway.lastError?.let { " lastError=$it" } ?: ""),
                        fontSize = 12.sp,
                    )
                }
            }
        }
        Spacer(Modifier.height(16.dp))
    }
}
