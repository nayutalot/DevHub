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
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase
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
    // UX-Z2 结构层（docs/28 §3.1 E2a）：会话工作目录（SessionView 只读追加；
    // 旧端点/旧数据缺失 → null，「工作区」分段归「未分组」组）。
    val workdir: String? = null,
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
    /** reply | pause | resume | approve | interrupt | spawn_session | revoke_device（M3-E1） */
    val kind: String,
    val text: String?,
    /** UNIQUE：重试全程复用同 key（服务端同 key 返回原结果，绝不重复执行） */
    val idempotencyKey: String,
    /** pending | failed（结构化拒绝后落败保留，供 UI 展示错误码） */
    val status: String,
    val createdAtMs: Long,
    val lastError: String?,
    /**
     * M3-E1（docs/18 §5.3）：spawn_session 队列行的 providerId 载体（数字 id 串；
     * 补发重建 payload {providerId, task} 用）。其余 kind 恒 null。
     */
    val providerId: String? = null,
)

/** WS 事件 ack 游标（单行 id=1）：App 重启后 sync after=lastAckedSeq 补齐遗漏事件。 */
@Entity(tableName = "event_ack_state")
data class EventAckStateEntity(
    @PrimaryKey val id: Int = 1,
    val lastAckedSeq: Long,
)

/**
 * 远程工作区 URL 条目（Q 批「远程工作区」屏）：条目 = 可配置 WebView 页面
 * （ZCode 移动遥控页 / 任何网页终端或控制面板）。
 * **URL 按敏感对待**（可能内嵌动态会话令牌，等同临时凭据）：本机私有 Room 明文存储可接受
 * （App 本地库，非凭据通道），但绝不入日志/绝不外发；UI 展示一律走中段省略
 * （[com.devhub.mobile.data.RemoteWorkspaceUrl.elideMiddle]）。
 */
@Entity(tableName = "remote_workspace_entries")
data class RemoteWorkspaceEntryEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    /** 用户起名标题；缺省取 URL host（RemoteWorkspaceUrl.defaultTitle）。 */
    val title: String,
    /** 入库前经 http(s) 白名单严格校验（RemoteWorkspaceUrl.parse，BAD_PAYLOAD 风格拒绝面）。 */
    val url: String,
    val createdAtMs: Long,
    /** 最近打开时间；null = 从未打开（排序垫底，按创建时间新→旧）。 */
    val lastOpenedAtMs: Long? = null,
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

    /**
     * UX-P2（docs/26 §3.1/§6-P2：列表行最近消息预览）——逐会话尾条一次查齐
     * （GROUP BY 预聚合，避免 LazyColumn 每行子查询；数据面零新接口，仅查询面）。
     */
    @Query(
        "SELECT m.* FROM message_cache m INNER JOIN " +
            "(SELECT sessionId, MAX(messageId) AS maxId FROM message_cache GROUP BY sessionId) t " +
            "ON m.sessionId = t.sessionId AND m.messageId = t.maxId",
    )
    fun observeLastMessages(): Flow<List<MessageCacheEntity>>

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

@Dao
interface RemoteWorkspaceEntryDao {
    /** 全量行（无 ORDER BY——最近使用排序统一走 RemoteWorkspaceUi.sort 纯函数，单测可锁）。 */
    @Query("SELECT * FROM remote_workspace_entries")
    fun observeAll(): Flow<List<RemoteWorkspaceEntryEntity>>

    @Query("SELECT * FROM remote_workspace_entries WHERE id = :id")
    fun get(id: Long): RemoteWorkspaceEntryEntity?

    /** S 批智能条目定位（固定保留标题「ZCode 工作区」；零 schema 变更——纯查询面）。 */
    @Query("SELECT * FROM remote_workspace_entries WHERE title = :title LIMIT 1")
    fun getByTitle(title: String): RemoteWorkspaceEntryEntity?

    @Insert
    fun insert(entry: RemoteWorkspaceEntryEntity): Long

    /** S 批智能条目更新（拉取模型：每次查询刷新 URL 与时间戳，绝不堆积重复行）。 */
    @Query("UPDATE remote_workspace_entries SET url = :url, createdAtMs = :updatedAtMs WHERE id = :id")
    fun updateUrl(id: Long, url: String, updatedAtMs: Long)

    /** 打开条目即触（最近使用排序依据）。 */
    @Query("UPDATE remote_workspace_entries SET lastOpenedAtMs = :openedAtMs WHERE id = :id")
    fun touchOpened(id: Long, openedAtMs: Long)

    @Query("DELETE FROM remote_workspace_entries WHERE id = :id")
    fun delete(id: Long)
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
        RemoteWorkspaceEntryEntity::class,
    ],
    // v2（体验整改批 B）：session_cache + providerKey/providerLabel/archived/parentSessionId；
    // message_cache + segmentsJson。纯缓存库，破坏性迁移可接受（fallbackToDestructiveMigration）。
    // v3（M2-R3 双模式批，docs/19 §7.1）：gateway_config + mode/relayUrl/pinFingerprints。
    // v4（M3-E1，docs/18 §5.3）：pending_command + providerId（spawn_session 队列行补发载体）。
    // v5（Q 批「远程工作区」）：新表 remote_workspace_entries——加表 = 安全 migrate，
    // 走 MIGRATION_4_5 增量路径（既有数据保留，不走破坏性重建）。
    // v6（UX-Z2 结构层，docs/28 §4）：session_cache + workdir——加列 = 安全 migrate，
    // 走 MIGRATION_5_6 增量路径（缓存库 ALTER TABLE ADD COLUMN，既有数据保留）。
    version = 6,
    exportSchema = false,
)
abstract class DevHubDb : RoomDatabase() {
    abstract fun gatewayConfigDao(): GatewayConfigDao
    abstract fun deviceDao(): DeviceDao
    abstract fun sessionCacheDao(): SessionCacheDao
    abstract fun messageCacheDao(): MessageCacheDao
    abstract fun pendingCommandDao(): PendingCommandDao
    abstract fun eventAckStateDao(): EventAckStateDao
    abstract fun remoteWorkspaceEntryDao(): RemoteWorkspaceEntryDao

    companion object {
        @Volatile
        private var instance: DevHubDb? = null

        /**
         * v4→v5（Q 批）：`CREATE TABLE remote_workspace_entries`——列定义与
         * [RemoteWorkspaceEntryEntity] 逐列一致（Room 迁移后 schema 校验严格，
         * NOT NULL/自增主键均须精确匹配）。
         */
        private val MIGRATION_4_5 = object : Migration(4, 5) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS `remote_workspace_entries` (" +
                        "`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, " +
                        "`title` TEXT NOT NULL, " +
                        "`url` TEXT NOT NULL, " +
                        "`createdAtMs` INTEGER NOT NULL, " +
                        "`lastOpenedAtMs` INTEGER)",
                )
            }
        }

        /**
         * v5→v6（UX-Z2 结构层，docs/28 §4）：session_cache 加 `workdir` 可空列
         * （SessionView 只读追加）——ALTER TABLE ADD COLUMN 与 Room 生成 schema
         * 逐字一致（可空 TEXT 无默认值）；既有缓存行 workdir 为 null（「工作区」
         * 分段归「未分组」组，下一次轮询刷新补齐）。
         */
        private val MIGRATION_5_6 = object : Migration(5, 6) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE `session_cache` ADD COLUMN `workdir` TEXT")
            }
        }

        fun get(context: Context): DevHubDb =
            instance ?: synchronized(this) {
                instance ?: Room.databaseBuilder(
                    context.applicationContext,
                    DevHubDb::class.java,
                    "devhub-mobile.db",
                )
                    .addMigrations(MIGRATION_4_5, MIGRATION_5_6)
                    // v5 以前的历史升级路径保持既有破坏性口径（纯缓存库，先例 v2 注释）；
                    // 4→5 已被上方增量迁移精确接管，不落破坏路径。
                    .fallbackToDestructiveMigration()
                    .build()
                    .also { instance = it }
            }
    }
}
