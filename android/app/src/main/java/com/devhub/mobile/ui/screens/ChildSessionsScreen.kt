package com.devhub.mobile.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.devhub.mobile.connect.ConnectionManager
import com.devhub.mobile.core.ProviderPalette
import com.devhub.mobile.core.SessionListOps
import com.devhub.mobile.data.ApiProvider
import com.devhub.mobile.data.FixtureMode
import com.devhub.mobile.data.remote.ApiError
import com.devhub.mobile.data.remote.SessionDto
import com.devhub.mobile.ui.components.ModeBadge
import com.devhub.mobile.ui.components.ProviderAvatarFor
import com.devhub.mobile.ui.components.StatusBadge
import com.devhub.mobile.ui.components.TimeFmt
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import java.io.IOException

/**
 * R2 子智能体会话列表页：从父会话一步进入；行上标注层级（L1/L2）与状态；
 * 已结束的照常可点入回看；可继续下钻（子会话详情页同样展示其子会话入口）。
 * 数据 = GET /v1/sessions/{id} 的 childSessions（旧端点无该字段 → 空态提示）。
 */
@Composable
fun ChildSessionsScreen(
    parentSessionId: Long,
    parentTitle: String?,
    onBack: () -> Unit,
    onOpenSession: (Long) -> Unit,
) {
    val context = LocalContext.current
    val fixtureOn = remember { FixtureMode.enabled(context) }
    var children by remember { mutableStateOf<List<SessionDto>?>(null) }
    // U1-M3：错误统一呈现体（人话+技术细节折叠），不再直出原码
    var error by remember { mutableStateOf<com.devhub.mobile.core.ErrorPresent.Presentable?>(null) }

    // R5.3：事件驱动为主 + 120s 低频兜底（原 3s 轮询退役）
    val refreshSignal by ConnectionManager.refreshSignal.collectAsState()
    LaunchedEffect(parentSessionId, refreshSignal) {
        while (isActive) {
            try {
                val detail = withContext(Dispatchers.IO) {
                    ApiProvider.projection(context).sessionDetail(parentSessionId)
                }
                children = detail.childSessions
                error = null
            } catch (err: ApiError) {
                error = com.devhub.mobile.core.ErrorPresent.api(
                    err.code, err.message,
                    com.devhub.mobile.core.ErrorPresent.Surface.SESSION_MESSAGES,
                )
            } catch (err: IOException) {
                error = com.devhub.mobile.core.ErrorPresent.io(err)
            } catch (err: Exception) {
                // P0 热修：未预期异常绝不容 UI 协程崩进程（通用人话+technical 保留）
                error = com.devhub.mobile.core.ErrorPresent.io(err)
            }
            delay(ConnectionManager.FALLBACK_POLL_MS)
        }
    }

    val list = children
    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        Spacer(Modifier.height(8.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onBack) { Text("< 返回") }
            Column(Modifier.weight(1f)) {
                Text("🤖 子智能体会话", fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
                Text(
                    // 打磨批 D：显示层清理 ** 记号（不改数据）
                    com.devhub.mobile.core.RichTextTokenizer.stripDisplayMarkers(parentTitle)
                        ?: "#$parentSessionId",
                    fontSize = 11.sp,
                    color = Color(0xFF757575),
                    maxLines = 1,
                    overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                )
            }
        }
        if (fixtureOn) {
            Text(
                "演示数据（夹具）· 非真实 Gateway — 端到端验收归批次 C",
                fontSize = 10.sp,
                color = Color(0xFF7A4F00),
                modifier = Modifier
                    .fillMaxWidth()
                    .background(Color(0xFFFFF8E1))
                    .padding(horizontal = 4.dp, vertical = 2.dp),
            )
        }
        Spacer(Modifier.height(6.dp))
        when {
            list == null && error == null -> Column(Modifier.padding(24.dp)) { CircularProgressIndicator() }
            list == null -> com.devhub.mobile.ui.components.ErrorPresentation(
                presentable = error ?: com.devhub.mobile.core.ErrorPresent.Presentable("加载失败"),
                headlinePrefix = "加载失败：",
            )
            list.isEmpty() -> Text("该会话没有子智能体会话", fontSize = 13.sp)
            else -> {
                // R2 排序：活跃在前、已结束在后（core.SessionListOps 纯逻辑）
                val ordered = SessionListOps.sortChildren(
                    list,
                    statusOf = { it.status },
                    lastActivityOf = { it.lastActivityAtSec },
                ).map { list[it] }
                LazyColumn {
                    items(ordered, key = { it.id }) { child ->
                        val level = 1 // 父会话直系子 = L1；更深层级随下钻在各自页面标注
                        Column(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(vertical = 4.dp)
                                // 打磨批 D：钉深色主题后行底改用主题容器色（原浅灰 F7F7F7 与
                                // 主题默认浅色文字对比失效）
                                .background(MaterialTheme.colorScheme.surfaceContainerHigh)
                                .clickable { onOpenSession(child.id) } // 已结束也可点入回看
                                .padding(10.dp),
                            verticalArrangement = Arrangement.spacedBy(4.dp),
                        ) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                val spec = ProviderPalette.resolve(child.providerKey, child.providerLabel)
                                ProviderAvatarFor(providerKey = child.providerKey, providerLabel = child.providerLabel, size = 26.dp, fontSize = 11)
                                Spacer(Modifier.width(8.dp))
                                Text(
                                    // U2-M4（AUDIT P3#3）：子会话标题 = 任务语义提取
                                    //（core.SessionTitleOps 纯函数：去系统提示词形态首行，
                                    // 取首个非系统句；提不出 → null 如实回退原截断显示）
                                    com.devhub.mobile.core.SessionTitleOps.extractTitle(child.title)
                                        ?: com.devhub.mobile.core.RichTextTokenizer.stripDisplayMarkers(child.title)
                                        ?: "会话 #${child.id}",
                                    fontWeight = FontWeight.SemiBold,
                                    fontSize = 13.sp,
                                    modifier = Modifier.weight(1f),
                                    maxLines = 1,
                                    overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                                )
                                StatusBadge(child.status)
                            }
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                Text(SessionListOps.childLevelLabel(level), fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                ModeBadge(child.sessionMode)
                                child.lastActivityAtSec?.let {
                                    Text(TimeFmt.mdHm(it), fontSize = 11.sp, color = Color(0xFF757575))
                                }
                                Spacer(Modifier.weight(1f))
                                Text("点入回看 ▸", fontSize = 11.sp, color = Color(0xFF757575))
                            }
                        }
                    }
                }
            }
        }
    }
}
