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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.devhub.mobile.connect.ConnectionManager
import com.devhub.mobile.connect.SubmitResult
import com.devhub.mobile.data.ApiProvider
import com.devhub.mobile.data.db.DevHubDb
import com.devhub.mobile.data.db.MessageCacheEntity
import com.devhub.mobile.data.remote.ApiError
import com.devhub.mobile.data.remote.SessionDetailDto
import com.devhub.mobile.ui.components.ModeBadge
import com.devhub.mobile.ui.components.StatusBadge
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 页面 5：会话详情（GET /v1/sessions/{id} + 消息 after 游标分页，docs/14 §B.1）。
 * - 显示 capabilities（mode + granted + evidence，未验证能力绝不显示为可用）；
 * - 控制按钮（回复输入框 / pause / resume）仅当服务端 CapabilitySet.granted 包含对应能力
 *   且 mode ≠ observed 才显示（UI 第一道门，ControlGate 纯逻辑；服务端 L3 二次校验）；
 * - 回复 POST reply {text, idempotencyKey=UUID}；断网自动入离线队列（结构化提示）；
 * - observed 会话：整页标注只读、零控制按钮。
 */
@Composable
fun SessionDetailScreen(sessionId: Long, onBack: () -> Unit) {
    val context = LocalContext.current
    val db = remember { DevHubDb.get(context) }
    val scope = rememberCoroutineScope()
    val listState = rememberLazyListState()

    var detail by remember { mutableStateOf<SessionDetailDto?>(null) }
    var detailError by remember { mutableStateOf<String?>(null) }
    var nextAfter by remember { mutableStateOf<Long?>(null) }
    var loadingMessages by remember { mutableStateOf(false) }
    var replyText by remember { mutableStateOf("") }
    var submitStatus by remember { mutableStateOf<String?>(null) }

    // 详情轮询（3s）：status / capabilities 真值
    LaunchedEffect(sessionId) {
        while (isActive) {
            try {
                detail = withContext(Dispatchers.IO) { ApiProvider.rest(context).sessionDetail(sessionId) }
                detailError = null
            } catch (err: ApiError) {
                detailError = "[${err.code}] ${err.message}"
            } catch (err: IOException) {
                detailError = "网络不可达"
            }
            delay(3000)
        }
    }

    // 消息缓存流（脱敏投影；分页加载入库后 UI 自动更新）
    val messages by db.messageCacheDao().observeMessages(sessionId).collectAsState(initial = emptyList())

    // 首屏消息加载
    LaunchedEffect(sessionId) {
        loadMessages(context, sessionId, after = null) { next -> nextAfter = next }
    }

    val d = detail
    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        Spacer(Modifier.height(8.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onBack) { Text("< 返回") }
            Text(
                d?.session?.title ?: "会话 #$sessionId",
                fontWeight = FontWeight.SemiBold,
                fontSize = 15.sp,
                modifier = Modifier.weight(1f),
                maxLines = 1,
            )
        }

        if (d == null && detailError == null) {
            Column(Modifier.padding(24.dp)) { CircularProgressIndicator() }
            return@Column
        }
        if (d == null) {
            Text("加载失败：$detailError", color = MaterialTheme.colorScheme.error, fontSize = 13.sp)
            return@Column
        }

        // —— 元数据行 ——
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            StatusBadge(d.session.status)
            ModeBadge(d.session.sessionMode)
            if (d.session.stale) Text("数据过期（stale）", fontSize = 11.sp, color = Color(0xFF8D6E00))
        }
        d.session.statusDetail?.let { Text(it, fontSize = 12.sp) }
        Text(
            "capabilities：mode=${d.capabilities.mode} granted=[${d.capabilities.granted.joinToString(", ")}] evidence=${d.capabilities.evidence}",
            fontSize = 11.sp,
            color = Color(0xFF555555),
        )

        // —— 控制区（UI 门：ControlGate）——
        val controls = ConnectionManager.visibleControls(
            capsMode = d.capabilities.mode,
            sessionMode = d.session.sessionMode,
            granted = d.capabilities.granted,
        )
        if (d.session.sessionMode == "observed" || d.capabilities.mode == "observed") {
            Text(
                "observed 会话：纯观察模式，不提供任何远程控制（服务端亦全禁）。",
                fontSize = 12.sp,
                color = Color(0xFF7A4F00),
                modifier = Modifier.padding(vertical = 4.dp),
            )
        }
        if (controls.reply) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = replyText,
                    onValueChange = { replyText = it.take(4000) },
                    label = { Text("回复（≤4000 字符）") },
                    modifier = Modifier.weight(1f),
                )
                Button(
                    onClick = {
                        val text = replyText.trim()
                        if (text.isEmpty()) return@Button
                        scope.launch {
                            submitStatus = when (val r = ConnectionManager.submitReply(sessionId, text)) {
                                is SubmitResult.Accepted -> "已接受（commandId=${r.commandId}）"
                                SubmitResult.QueuedOffline -> "当前离线：已入离线队列，重连后自动补发（幂等）"
                                is SubmitResult.Rejected -> "被拒绝：[${r.code}] ${r.message}"
                            }
                            replyText = ""
                        }
                    },
                    enabled = replyText.isNotBlank(),
                ) { Text("发送") }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(vertical = 4.dp)) {
            if (controls.pause) {
                OutlinedButton(onClick = {
                    scope.launch {
                        submitStatus = when (val r = ConnectionManager.submitAction(sessionId, "pause")) {
                            is SubmitResult.Accepted -> "pause 已接受（commandId=${r.commandId}）"
                            SubmitResult.QueuedOffline -> "当前离线：pause 已入离线队列"
                            is SubmitResult.Rejected -> "pause 被拒绝：[${r.code}] ${r.message}"
                        }
                    }
                }) { Text("暂停") }
            }
            if (controls.resume) {
                OutlinedButton(onClick = {
                    scope.launch {
                        submitStatus = when (val r = ConnectionManager.submitAction(sessionId, "resume")) {
                            is SubmitResult.Accepted -> "resume 已接受（commandId=${r.commandId}）"
                            SubmitResult.QueuedOffline -> "当前离线：resume 已入离线队列"
                            is SubmitResult.Rejected -> "resume 被拒绝：[${r.code}] ${r.message}"
                        }
                    }
                }) { Text("恢复") }
            }
        }
        submitStatus?.let { Text(it, fontSize = 12.sp) }

        // —— 消息（脱敏投影，after 游标分页）——
        Text("消息（脱敏投影）", fontWeight = FontWeight.SemiBold, fontSize = 13.sp, modifier = Modifier.padding(top = 6.dp))
        LazyColumn(state = listState, modifier = Modifier.weight(1f)) {
            items(messages, key = { it.messageId }) { message ->
                Column(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                    Text(
                        "${message.role}  " + (message.occurredAtSec?.let { formatTime(it) } ?: ""),
                        fontSize = 11.sp,
                        fontWeight = FontWeight.Medium,
                        color = Color(0xFF757575),
                    )
                    Text(message.contentRedacted, fontSize = 13.sp)
                }
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (nextAfter != null) {
                Button(
                    onClick = {
                        scope.launch {
                            val after = nextAfter
                            loadingMessages = true
                            nextAfter = loadMessages(context, sessionId, after)
                            loadingMessages = false
                        }
                    },
                    enabled = !loadingMessages,
                ) { Text(if (loadingMessages) "加载中…" else "加载更多") }
            } else {
                Text("（已加载全部消息）", fontSize = 11.sp, color = Color(0xFF757575))
            }
        }
    }
}

/** 消息分页：after=服务端游标；入 Room 缓存；返回 nextAfter（null = 无更多）。 */
private suspend fun loadMessages(
    context: android.content.Context,
    sessionId: Long,
    after: Long?,
    onFirstPage: (Long?) -> Unit = {},
): Long? = withContext(Dispatchers.IO) {
    try {
        val page = ApiProvider.rest(context).messages(sessionId, after = after, limit = 200)
        val db = com.devhub.mobile.data.db.DevHubDb.get(context)
        if (page.items.isNotEmpty()) {
            db.messageCacheDao().insertAll(
                page.items.map { m ->
                    MessageCacheEntity(
                        sessionId = sessionId,
                        messageId = m.id,
                        role = m.role,
                        contentRedacted = m.contentRedacted,
                        occurredAtSec = m.occurredAtSec,
                    )
                },
            )
        }
        page.nextAfter
    } catch (err: Exception) {
        after // 失败保持游标不动（下次重试）
    }
}

private fun formatTime(sec: Long): String =
    SimpleDateFormat("MM-dd HH:mm:ss", Locale.US).format(Date(sec * 1000))
