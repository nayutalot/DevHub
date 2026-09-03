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
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
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
import com.devhub.mobile.data.remote.AgentDto
import com.devhub.mobile.data.remote.ApiError
import com.devhub.mobile.ui.components.HealthBadge
import com.devhub.mobile.ui.components.ModeBadge
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import java.io.IOException

/**
 * 页面 3：Agent 列表（GET /v1/agents，docs/14 §B.1）。
 * 行卡：displayName + health 徽章（ok/degraded/unavailable/unknown）+
 * capabilities 徽章（mode + granted[]）。
 */
@Composable
fun AgentsScreen() {
    val context = LocalContext.current
    var agents by remember { mutableStateOf<List<AgentDto>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        while (isActive) {
            try {
                agents = withContext(Dispatchers.IO) { ApiProvider.rest(context).agents() }
                error = null
            } catch (err: ApiError) {
                error = "[${err.code}] ${err.message}"
            } catch (err: IOException) {
                error = "网络不可达"
            }
            delay(2000)
        }
    }

    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        Spacer(Modifier.height(8.dp))
        Text("Agents", style = MaterialTheme.typography.titleLarge)
        Spacer(Modifier.height(4.dp))
        val list = agents
        when {
            list == null && error == null -> Column(Modifier.padding(24.dp)) { CircularProgressIndicator() }
            list == null -> Text("加载失败：$error", color = MaterialTheme.colorScheme.error, fontSize = 13.sp)
            list.isEmpty() -> Text("暂无 provider 投影", fontSize = 13.sp)
            else -> LazyColumn {
                items(list, key = { it.id }) { agent ->
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .padding(vertical = 6.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(agent.displayName, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                            Spacer(Modifier.width(8.dp))
                            HealthBadge(agent.health)
                        }
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            ModeBadge(agent.capabilities.mode)
                            Text(
                                if (agent.capabilities.granted.isEmpty()) "无控制能力" else "granted: ${agent.capabilities.granted.joinToString(" / ")}",
                                fontSize = 11.sp,
                                color = Color(0xFF555555),
                            )
                        }
                    }
                }
            }
        }
    }
}

