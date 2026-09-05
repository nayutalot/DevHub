/**
 * config.ts — 环境配置（docs/19 §5.1/§5.6）。
 *
 * 部署态默认：绑定 127.0.0.1:8443（TLS 永远在反代终结，Relay 不感知）；
 * DB /var/lib/devhub-relay/relay.db；注册码经 EnvironmentFile（0600）注入。
 * 测试缝：TTL/淘汰/限流参数可用 env 覆盖（仅测试/演练；缺省 = 生产值原样）。
 */

export interface RelayConfig {
  /** 监听地址（部署恒 127.0.0.1，docs/18 §2 TLS 在反代）。 */
  bind: string
  /** 监听端口（部署 8443；测试用端口 0 = 随机高端口，绝不占 8746-8755）。 */
  port: number
  /** relay.db 路径。 */
  dbPath: string
  /** 一次性注册码（L2 首装换发，docs/19 §2.2）；未设置 = 注册面关闭。 */
  registrationCode: string | null
  /** relayVersion 观测字段（docs/18 §3.1；N-R5：不做版本协商）。 */
  relayVersion: string
  /** 应用层/传输层心跳参数（docs/18 §2：30s ping + 10s pong，ws.ts 参数不动）。 */
  heartbeatIntervalMs: number
  pongTimeoutMs: number
  /** 裸 pair 连接首帧时限（docs/18 §2：10s 内必须 pair）。 */
  barePairTimeoutMs: number
  /** 配对码 TTL（docs/18 §3.2：300s）。 */
  pairingTtlSec: number
  /** 配对失败作废阈值（5 次）。 */
  pairingMaxFailures: number
  /** 命令 TTL（docs/18 §5.2：expires = 收帧 + 300s；排队 TTL 同步）。 */
  commandTtlSec: number
  /** 命令排队上限（docs/18 §3.9：每设备 100 / 全局 1000）。 */
  queueLimitPerDevice: number
  queueLimitGlobal: number
  /** 请求-响应帧超时（docs/18 §3.0：agent_list/session_list/message 10s）。 */
  relayResponseTimeoutMs: number
  /** sync 页上限（docs/18 §3.12：EVENTS_SINCE_DEFAULT_LIMIT=100）。 */
  syncPageLimit: number
  /** 缓存淘汰（docs/19 §5.4：ACK 后 72h 删 payload；元数据行 7 天后整行删）。 */
  cachePayloadTtlSec: number
  cacheRowTtlSec: number
  /** 容量两级（docs/19 §5.4：软 25,000 行/100MB，硬 50,000 行/200MB）。 */
  cacheSoftRows: number
  cacheSoftBytes: number
  cacheHardRows: number
  cacheHardBytes: number
  /** 缓存 payload 单条上界（docs/19 §5.4：≤4KB/条）。 */
  cachePayloadMaxBytes: number
  /** 淘汰扫描周期（毫秒）。 */
  evictionIntervalMs: number
  /** 审计保留（docs/19 §5.4：180 天滚动删除）。 */
  auditRetentionSec: number
  /** 容量预算护栏（docs/19 §5.5：WS 连接 ≤64）。 */
  maxWsConnections: number
}

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined || raw.trim().length === 0) return fallback
  const value = Number.parseInt(raw, 10)
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

/** 端口解析：0 合法（OS 随机高端口分配——测试/自检缝，绝不占 8746-8755）。 */
function portEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined || raw.trim().length === 0) return fallback
  const value = Number.parseInt(raw, 10)
  return Number.isSafeInteger(value) && value >= 0 && value <= 65535 ? value : fallback
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  return {
    bind: env.RELAY_BIND ?? '127.0.0.1',
    port: portEnv(env, 'RELAY_PORT', 8443),
    dbPath: env.RELAY_DB_PATH ?? 'data/relay.db',
    registrationCode: env.RELAY_REGISTRATION_CODE && env.RELAY_REGISTRATION_CODE.trim().length > 0
      ? env.RELAY_REGISTRATION_CODE.trim()
      : null,
    relayVersion: env.RELAY_VERSION ?? '1.0.0',
    heartbeatIntervalMs: intEnv(env, 'RELAY_HEARTBEAT_SEC', 30) * 1000,
    pongTimeoutMs: intEnv(env, 'RELAY_PONG_TIMEOUT_SEC', 10) * 1000,
    barePairTimeoutMs: intEnv(env, 'RELAY_BARE_PAIR_TIMEOUT_SEC', 10) * 1000,
    pairingTtlSec: intEnv(env, 'RELAY_PAIRING_TTL_SEC', 300),
    pairingMaxFailures: intEnv(env, 'RELAY_PAIRING_MAX_FAILURES', 5),
    commandTtlSec: intEnv(env, 'RELAY_COMMAND_TTL_SEC', 300),
    queueLimitPerDevice: intEnv(env, 'RELAY_QUEUE_LIMIT_PER_DEVICE', 100),
    queueLimitGlobal: intEnv(env, 'RELAY_QUEUE_LIMIT_GLOBAL', 1000),
    relayResponseTimeoutMs: intEnv(env, 'RELAY_RESPONSE_TIMEOUT_SEC', 10) * 1000,
    syncPageLimit: intEnv(env, 'RELAY_SYNC_PAGE_LIMIT', 100),
    cachePayloadTtlSec: intEnv(env, 'RELAY_CACHE_PAYLOAD_TTL_HOURS', 72) * 3600,
    cacheRowTtlSec: intEnv(env, 'RELAY_CACHE_ROW_TTL_DAYS', 7) * 86400,
    cacheSoftRows: intEnv(env, 'RELAY_CACHE_SOFT_ROWS', 25000),
    cacheSoftBytes: intEnv(env, 'RELAY_CACHE_SOFT_MB', 100) * 1024 * 1024,
    cacheHardRows: intEnv(env, 'RELAY_CACHE_HARD_ROWS', 50000),
    cacheHardBytes: intEnv(env, 'RELAY_CACHE_HARD_MB', 200) * 1024 * 1024,
    cachePayloadMaxBytes: intEnv(env, 'RELAY_CACHE_PAYLOAD_MAX_KB', 4) * 1024,
    evictionIntervalMs: intEnv(env, 'RELAY_EVICTION_INTERVAL_SEC', 300) * 1000,
    auditRetentionSec: intEnv(env, 'RELAY_AUDIT_RETENTION_DAYS', 180) * 86400,
    maxWsConnections: intEnv(env, 'RELAY_MAX_WS_CONNECTIONS', 64),
  }
}
