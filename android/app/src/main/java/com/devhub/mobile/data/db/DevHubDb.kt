package com.devhub.mobile.data.db

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.Update
import kotlinx.coroutines.flow.Flow

// ---------------------------------------------------------------------------
// Entities（AC7 数据层：GatewayConfig / DeviceInfo / SessionCache / MessageCache /
// PendingCommand / EventAckState；Token 明文绝不入库——见 SecureStore）
// ---------------------------------------------------------------------------

/**
 * Gateway 配置（单行 id=1；默认 10.0.2.2:8746 = 模拟器回环映射）。
 * R3 双模式扩展（docs/19 §7.1）：`{ mode: 'local' | 'relay', host?, port?, relayUrl?, deviceName }`
 * —— mode 默认 local（旧行破坏性迁移后语义不变）；relayUrl 仅 relay 模式使用；
 * pinFingerprints = 注入式 SPKI 指纹（docs/19 §10.2，非机密物料，逗号/换行分隔）。
 */
@Entity(tableName = "gateway_config")
data class GatewayConfigEntity(
    @PrimaryKey val id: Int = 1,
    val host: String,
    val port: Int,
    /** local | relay（docs/19 §7.1 双模式；绝不字段嗅探，模式显式选择）。 */
    val mode: String = "local",
    /** relay 模式 endpoint，强制 wss://（docs/19 §11 / docs/18 §2；ws:// 在保存与连接两层都被拒绝）。 */
    val relayUrl: String? = null,
    /** 注入式指纹高级项（docs/19 §10.2）：`sha256/{hex}` 列表；null/空白 = 不启用 pinning。 */
    val pinFingerprints: String? = null,
)

/** 本设备配对元数据（单行 id=1）。Token 经 Keystore 加密后存 SecureStore（绝不入 Room/日志）。 */
@Entity(tableName = "device_info")
data class DeviceEntity(
    @PrimaryKey val id: Int = 1,
    val deviceId: Long,
    val deviceName: String,
    val tokenVersion: Int,
    val gatewayName: String,
    val pairedAtSec: Long,
)

/** 服务端会话投影缓存（SessionView，docs/14 §B.1；9 值 status 原样存储）。 */
@Entity(tableName = "session_cache")
data class SessionCacheEntity(
    @PrimaryKey val sessionId: Long,
    val providerId: Long,
    val nativeId: String,
    val sessionMode: String,
    val title: String?,
    val status: String,
    val statusDetail: String?,
    val startedAtSec: Long?,
    val lastActivityAtSec: Long?,
    val endedAtSec: Long?,
    val stale: Boolean,
    val cachedAtSec: Long,
    // —— 体验整改批附加列（可选；旧端点缺失 → null/false，UI 回退不回归）——
    val providerKey: String? = null,
    val providerLabel: String? = null,
    val archived: Boolean = false,
    val parentSessionId: Long? = null,
)

/** 消息投影缓存（脱敏 contentRedacted；按会话分区，游标 after = 消息 id）。 */
@Entity(tableName = "message_cache", primaryKeys = ["sessionId", "messageId"])
data class MessageCacheEntity(
    val sessionId: Long,
    val messageId: Long,
    val role: String,
    val contentRedacted: String,
    val occurredAtSec: Long?,
    /** R1 分段 JSON（可空；null = 回退整段 contentRedacted 纯文本）。 */
    val segmentsJson: String? = null,
)

/** 离线命令队列：断网/断连期间用户提交的 reply/actions（docs/14 §B.5 幂等补发）。 */
@Entity(tableName = "pending_command")
data class PendingCommandEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val sessionId: Long,
    /** reply | pause | resume */
    val kind: String,
    val text: String?,
    /** UNIQUE：重试全程复用同 key（服务端同 key 返回原结果，绝不重复执行） */
    val idempotencyKey: String,
    /** pending | failed（结构化拒绝后落败保留，供 UI 展示错误码） */
    val status: String,
    val createdAtMs: Long,
    val lastError: String?,
)

/** WS 事件 ack 游标（单行 id=1）：App 重启后 sync after=lastAckedSeq 补齐遗漏事件。 */
@Entity(tableName = "event_ack_state")
data class EventAckStateEntity(
    @PrimaryKey val id: Int = 1,
    val lastAckedSeq: Long,
)

// ---------------------------------------------------------------------------
// DAOs
// ---------------------------------------------------------------------------

@Dao
interface GatewayConfigDao {
    @Query("SELECT * FROM gateway_config WHERE id = 1")
    fun observe(): Flow<GatewayConfigEntity?>

    @Query("SELECT * FROM gateway_config WHERE id = 1")
    fun get(): GatewayConfigEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun upsert(config: GatewayConfigEntity)
}

@Dao
interface DeviceDao {
    @Query("SELECT * FROM device_info WHERE id = 1")
    fun observe(): Flow<DeviceEntity?>

    @Query("SELECT * FROM device_info WHERE id = 1")
    fun get(): DeviceEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun upsert(device: DeviceEntity)

    @Query("DELETE FROM device_info")
    fun clear()
}

@Dao
interface SessionCacheDao {
    @Query("SELECT * FROM session_cache ORDER BY COALESCE(lastActivityAtSec, startedAtSec, 0) DESC")
    fun observeAll(): Flow<List<SessionCacheEntity>>

    @Query("SELECT * FROM session_cache WHERE sessionId = :sessionId")
    fun get(sessionId: Long): SessionCacheEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun upsertAll(sessions: List<SessionCacheEntity>)

    /** R3 删除同步：轮询响应中已消失的会话行（含被删除/过滤的）从缓存移除；空列表请走 clear()。 */
    @Query("DELETE FROM session_cache WHERE sessionId NOT IN (:ids)")
    fun deleteExcept(ids: List<Long>)

    @Query("DELETE FROM session_cache")
    fun clear()
}

@Dao
interface MessageCacheDao {
    @Query("SELECT * FROM message_cache WHERE sessionId = :sessionId ORDER BY messageId ASC")
    fun observeMessages(sessionId: Long): Flow<List<MessageCacheEntity>>

    @Query("SELECT MAX(messageId) FROM message_cache WHERE sessionId = :sessionId")
    fun maxMessageId(sessionId: Long): Long?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun insertAll(messages: List<MessageCacheEntity>)

    @Query("DELETE FROM message_cache")
    fun clear()
}

@Dao
interface PendingCommandDao {
    @Query("SELECT * FROM pending_command WHERE status = 'pending' ORDER BY createdAtMs ASC, id ASC")
    fun observePending(): Flow<List<PendingCommandEntity>>

    @Query("SELECT * FROM pending_command ORDER BY createdAtMs ASC, id ASC")
    fun observeAll(): Flow<List<PendingCommandEntity>>

    @Query("SELECT * FROM pending_command WHERE status = 'pending' ORDER BY createdAtMs ASC, id ASC")
    fun listPending(): List<PendingCommandEntity>

    @Insert
    fun insert(command: PendingCommandEntity): Long

    /** 补发成功：出队。 */
    @Query("DELETE FROM pending_command WHERE id = :id")
    fun delete(id: Long)

    /** 幂等 key 查询（relay queued 挂起重试路径：同 key 复用行，绝不重复入队）。 */
    @Query("SELECT * FROM pending_command WHERE idempotencyKey = :key LIMIT 1")
    fun getByKey(key: String): PendingCommandEntity?

    /** 结构化拒绝：落败保留 + 记录错误码（UI 展示）。 */
    @Update
    fun update(command: PendingCommandEntity)

    @Query("SELECT COUNT(*) FROM pending_command WHERE status = 'pending'")
    fun countPending(): Int
}

@Dao
interface EventAckStateDao {
    /** local 模式游标（docs/14 {type:'ack',seqs} 逐条空间），固定 id=1。 */
    @Query("SELECT * FROM event_ack_state WHERE id = 1")
    fun get(): EventAckStateEntity?

    /**
     * relay 模式累计游标（docs/18 §3.11/§6.2 `after = max(连续已处理)`），固定 id=2。
     * 两模式 sequence 空间互不相同，分行存储防模式切换串扰（R3 双连接互斥红线配套）。
     */
    @Query("SELECT * FROM event_ack_state WHERE id = 2")
    fun getRelay(): EventAckStateEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun upsert(state: EventAckStateEntity)
}

// ---------------------------------------------------------------------------
// Database（单例）
// ---------------------------------------------------------------------------

@Database(
    entities = [
        GatewayConfigEntity::class,
        DeviceEntity::class,
        SessionCacheEntity::class,
        MessageCacheEntity::class,
        PendingCommandEntity::class,
        EventAckStateEntity::class,
    ],
    // v2（体验整改批 B）：session_cache + providerKey/providerLabel/archived/parentSessionId；
    // message_cache + segmentsJson。纯缓存库，破坏性迁移可接受（fallbackToDestructiveMigration）。
    // v3（M2-R3 双模式批，docs/19 §7.1）：gateway_config + mode/relayUrl/pinFingerprints。
    version = 3,
    exportSchema = false,
)
abstract class DevHubDb : RoomDatabase() {
    abstract fun gatewayConfigDao(): GatewayConfigDao
    abstract fun deviceDao(): DeviceDao
    abstract fun sessionCacheDao(): SessionCacheDao
    abstract fun messageCacheDao(): MessageCacheDao
    abstract fun pendingCommandDao(): PendingCommandDao
    abstract fun eventAckStateDao(): EventAckStateDao

    companion object {
        @Volatile
        private var instance: DevHubDb? = null

        fun get(context: Context): DevHubDb =
            instance ?: synchronized(this) {
                instance ?: Room.databaseBuilder(
                    context.applicationContext,
                    DevHubDb::class.java,
                    "devhub-mobile.db",
                ).fallbackToDestructiveMigration().build().also { instance = it }
            }
    }
}
