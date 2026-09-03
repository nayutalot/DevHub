package com.devhub.mobile.core

import java.util.UUID

/**
 * 幂等 key（docs/14 §B.5）：UUID；离线队列重试必须**复用**同 key——
 * 服务端 remote_commands.idempotency_key UNIQUE，同 key 重试返回原 commandId
 * 原结果（不重复执行）；同 key 异 payload 服务端 409 COMMAND_KEY_CONFLICT。
 */
object IdempotencyKeys {

    /** 新指令首次提交：生成新 UUID。 */
    fun newKey(): String = UUID.randomUUID().toString()

    /**
     * 第 n 次尝试的 key：previousKey 为空（首次）→ 新 key；
     * 重试 → **原样复用**（绝不在重试路径生成新 key，否则幂等失效可能重复执行）。
     */
    fun keyForAttempt(previousKey: String?): String =
        if (previousKey.isNullOrBlank()) newKey() else previousKey
}
