package com.devhub.mobile.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import com.devhub.mobile.data.ApiProvider
import com.devhub.mobile.data.db.DevHubDb
import com.devhub.mobile.data.db.SessionCacheEntity
import com.devhub.mobile.data.remote.ApiError
import com.devhub.mobile.ui.components.ModeBadge
import com.devhub.mobile.ui.components.StatusBadge
import com.devhub.mobile.ui.components.StatusColors
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import java.io.IOException

/**
 * 页面 4：会话列表（GET /v1/sessions，docs/14 §B.1）。
 * - 9 值状态徽章（用户锁定 7 态 + stopped/unknown 透明展示）；
 * - waiting_input / approval_required 高亮；
 * - stale 数据过期标注（绝不猜实时态）；observed 会话整行标注（只读）；
 * - 数据落 Room 缓存（SessionCache），WS 事件可推进缓存行状态。
 */
@Composable
fun SessionsScreen(onOpenSession: (Long) -> Unit) {
    val context = LocalContext.current
    val db = remember { DevHubDb.get(context) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }

    // 轮询（2s，与桌面 Agents 视图同节奏）→ Room 缓存
    LaunchedEffect(Unit) {
        while (isActive) {
            try {
                val sessions = withContext(Dispatchers.IO) { ApiProvider.rest(context).sessions(limit = 200) }
                val rows = sessions.map { s ->
                    SessionCacheEntity(
                        sessionId = s.id,
                        providerId = s.providerId,
                        nativeId = s.nativeId,
                        sessionMode = s.sessionMode,
                        title = s.title,
                        status = s.status,
                        statusDetail = s.statusDetail,
                        startedAtSec = s.startedAtSec,
                        lastActivityAtSec = s.lastActivityAtSec,
                        endedAtSec = s.endedAtSec,
                        stale = s.stale,
                        cachedAtSec = System.currentTimeMillis() / 1000,
                    )
                }
                withContext(Dispatchers.IO) { db.sessionCacheDao().upsertAll(rows) }
                error = null
            } catch (err: ApiError) {
                error = "[${err.code}] ${err.message}"
            } catch (err: IOException) {
                error = "网络不可达（离线显示缓存）"
            }
            loading = false
            delay(2000)
        }
    }

    val sessions by db.sessionCacheDao().observeAll().collectAsState(initial = emptyList())

    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        Spacer(Modifier.height(8.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("会话", style = MaterialTheme.typography.titleLarge)
            Spacer(Modifier.width(8.dp))
            Text("${sessions.size}", fontSize = 13.sp)
        }
        Spacer(Modifier.height(4.dp))
        when {
            loading -> Column(Modifier.padding(24.dp)) { CircularProgressIndicator() }
            error != null && sessions.isEmpty() ->
                Text("加载失败：$error", color = MaterialTheme.colorScheme.error, fontSize = 13.sp)

            sessions.isEmpty() -> Text("暂无会话（监控管线未产生会话或 Gateway 未连接）", fontSize = 13.sp)
            else -> LazyColumn {
                items(sessions, key = { it.sessionId }) { session ->
                    SessionRow(session, onOpenSession)
                }
            }
        }
    }
}

@Composable
private fun SessionRow(session: SessionCacheEntity, onOpenSession: (Long) -> Unit) {
    val highlight = StatusColors.highlight(session.status)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp)
            .background(
                if (highlight) Color(0xFFFFF8E1) else Color.Transparent,
            )
            .border(
                width = if (highlight) 1.dp else 0.dp,
                color = if (highlight) Color(0xFFFFB300) else Color.Transparent,
            )
            .clickable { onOpenSession(session.sessionId) }
            .padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                session.title ?: "会话 #${session.sessionId}",
                fontWeight = FontWeight.SemiBold,
                fontSize = 14.sp,
                modifier = Modifier.weight(1f),
                maxLines = 1,
            )
            StatusBadge(session.status)
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            ModeBadge(session.sessionMode) // observed 整行标注（徽章 + 尾注）
            if (session.stale) {
                Text("数据过期（stale）", fontSize = 11.sp, color = Color(0xFF8D6E00))
            }
            Text("provider #${session.providerId}", fontSize = 11.sp, color = Color(0xFF757575))
            Spacer(Modifier.weight(1f))
            if (session.sessionMode == "observed") {
                Text("observed 只读", fontSize = 11.sp, color = Color(0xFF7A4F00), fontWeight = FontWeight.Medium)
            }
        }
    }
}
