package com.devhub.mobile.core.relay

/**
 * token_rotation 原子换发纯逻辑（docs/18 §3.14 / docs/19 §7.3，M2-R3 Block 6 模型面）。
 *
 * 原子性合同：
 * - 决策先行：tokenVersion 单调，incoming ≤ current → Stale（重复帧/旧帧零写入）；
 * - 写入失败（Keystore 加密失败/读回校验不等）→ 实现必须保留旧值（回退路径 = 按旧值继续
 *   重连，docs/18 §3.14）；本模型把「写失败 → 旧值仍在」作为 [TokenStore.write] 的合同；
 * - 确认信道：下一帧 heartbeat 携带新 tokenVersion（发送侧每次现读 store，不做内存缓存）。
 *
 * TokenStore 实现侧责任（App 层 = SecureStore.rotateToken）：
 * 单条目单事务写入 + 写后读回校验 + 校验失败回滚旧密文；本文件只做决策与失败分类。
 */
data class StoredToken(
    val token: String,
    val tokenVersion: Int,
    val deviceId: Long? = null,
)

/** 抽象凭据面（App = Keystore+Room 适配；测试 = InMemoryTokenStore 注入失败）。 */
interface TokenStore {
    fun read(): StoredToken?

    /**
     * 原子写入：必须整体成功或整体失败（旧值原样保留）。
     * @return true = 写入成功且读回校验一致；false = 失败（store 状态 = 写前旧值）。
     */
    fun write(token: String, tokenVersion: Int, deviceId: Long?): Boolean
}

sealed class RotationOutcome {
    /** 已换发：下一帧 heartbeat 携带新 tokenVersion 即为确认（docs/18 §3.14）。 */
    data class Accepted(val written: StoredToken) : RotationOutcome()

    /** 旧帧/重复帧（tokenVersion ≤ 现值）：零写入、零副作用。 */
    data object Stale : RotationOutcome()

    /** 未配对（无现存 Token）：rotation 无意义，忽略并保持未配对态。 */
    data object NoCurrentToken : RotationOutcome()

    /** 写入失败：store 已保证旧值保留（App 按「失败回退旧值 + 重连」继续）。 */
    data class FailedPreservedOld(val preserved: StoredToken?) : RotationOutcome()
}

object RelayTokenRotation {
    fun apply(
        store: TokenStore,
        newToken: String,
        newVersion: Int,
        newDeviceId: Long? = null,
    ): RotationOutcome {
        val current = store.read() ?: return RotationOutcome.NoCurrentToken
        if (newVersion <= current.tokenVersion) return RotationOutcome.Stale
        val ok = store.write(newToken, newVersion, newDeviceId ?: current.deviceId)
        return if (ok) {
            RotationOutcome.Accepted(StoredToken(newToken, newVersion, newDeviceId ?: current.deviceId))
        } else {
            RotationOutcome.FailedPreservedOld(current)
        }
    }
}

/** 测试/纯逻辑用途的内存 TokenStore（可注入写失败）。 */
class InMemoryTokenStore(initial: StoredToken?) : TokenStore {
    var current: StoredToken? = initial
    var failNextWrite: Boolean = false
    var writeCount: Int = 0
        private set

    override fun read(): StoredToken? = current

    override fun write(token: String, tokenVersion: Int, deviceId: Long?): Boolean {
        writeCount++
        if (failNextWrite) {
            failNextWrite = false // 单次失败注入（合同：失败 = 状态零变化，旧值仍在）
            return false
        }
        current = StoredToken(token, tokenVersion, deviceId)
        return true
    }
}
