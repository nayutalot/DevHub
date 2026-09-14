package com.devhub.mobile.ui.components

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.devhub.mobile.core.ErrorPresent

/**
 * U1-M3（AUDIT P1#3）：统一错误呈现组件——用户面一句人话 +「技术细节」可折叠区
 * （默认收起）。原始异常/错误码不再直出用户面（20-relay-test-error.png 缺陷：
 * 异常类名+内网 IP+端口直出），但绝不丢弃——折叠区内原样保留（诚实纪律：翻译不删除）。
 */
@Composable
fun ErrorPresentation(
    presentable: ErrorPresent.Presentable,
    modifier: Modifier = Modifier,
    headlinePrefix: String? = null,
) {
    Column(modifier) {
        Text(
            text = if (headlinePrefix != null) headlinePrefix + presentable.headline else presentable.headline,
            color = MaterialTheme.colorScheme.error,
            fontSize = 13.sp,
        )
        presentable.technical?.let { technical ->
            var open by remember { mutableStateOf(false) } // 默认收起
            TextButton(
                onClick = { open = !open },
                contentPadding = PaddingValues(horizontal = 0.dp),
            ) {
                Text(
                    if (open) "收起技术细节" else "技术细节",
                    fontSize = 11.sp,
                )
            }
            if (open) {
                Text(
                    technical,
                    fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(bottom = 4.dp),
                )
            }
        }
    }
}

/**
 * UX-P1（docs/24 §4.3 诚实折叠）：中性「技术细节」可折叠区（默认收起）。
 * 承载非错误语义面的技术原值（指令回执 commandId、诊断 key=value、探测版本/时长等）——
 * 翻译不删除、零吞码；与 [ErrorPresentation]（错误语义、error 配色）区分。
 */
@Composable
fun TechnicalDetailsFold(
    technical: String,
    modifier: Modifier = Modifier,
    label: String = "技术细节",
) {
    var open by remember { mutableStateOf(false) } // 默认收起
    Column(modifier) {
        TextButton(
            onClick = { open = !open },
            contentPadding = PaddingValues(horizontal = 0.dp),
        ) {
            Text(if (open) "收起技术细节" else label, fontSize = 11.sp)
        }
        if (open) {
            Text(
                technical,
                fontSize = 11.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
