/**
 * auth.ts — Remote Gateway 鉴权面（docs/15 §3/§4，docs/14 §B.4）。
 *
 * 职责（AC6，docs/12 §9 gateway/auth.ts 行）：
 * 1. Bearer 设备 Token 校验：sha256(token) 比对 remote_devices.token_hash；
 *    常数时间比较（timingSafeEqual）防时序侧信道；撤销设备 → DEVICE_REVOKED。
 *    token_hash 查询属「读」，gateway 层允许（裁决：写库一律经 L3 函数）。
 * 2. 防重放（docs/14 §B.4）：X-DevHub-Timestamp（unix 秒，±300s 窗口）+
 *    X-DevHub-Nonce（128-bit 随机，内存 LRU 10 分钟去重）；窗口外/重复 →
 *    401 AUTH_REPLAYED。豁免面 = /v1/pairing/claim 与 /v1/health（调用方控制）。
 * 3. 限流（docs/14 §B.4 参数表，全部内存滑动窗口，重启清零——可接受并已注明）：
 *    - 鉴权失败：同源 5 次/60s → 429 AUTH_RATE_LIMITED + Retry-After: 60；
 *    - 配对 claim：同源 5 次/5min（pairing.ts 经本模块统一窗口原语）；
 *    - 常规请求：120 次/min/设备。
 *
 * electron-free（node:crypto/node:sqlite DatabaseSync 只读查询）；一切 SQL 参数
 * 绑定（约束 #11）；本模块零写库（写审计经 L3 recordSecurityAudit，调用方执行）。
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { getDatabase } from '../../../db/index.ts'
import { nowSec, ServiceError } from '../../internal.ts'

// ---------------------------------------------------------------------------
// Token 校验（docs/15 §3：SHA-256 只存哈希；撤销即拒）
// ---------------------------------------------------------------------------

/** remote_devices 行（gateway 只读投影，docs/13 §4.5）。 */
export interface GatewayDeviceRow {
  id: number
  device_name: string
  platform: string
  token_hash: string
  token_version: number
  status: string
  paired_at: number
  last_seen_at: number | null
}

/** sha256 hex（Token/配对码共用哈希管道；明文绝不落日志/DB——红线 docs/15 §6）。 */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** 常数时间比较（两个 hex 摘要逐字节比对；等长检查防 timingSafeEqual 抛错）。 */
export function constantTimeEquals(hexA: string, hexB: string): boolean {
  const bufA = Buffer.from(hexA, 'hex')
  const bufB = Buffer.from(hexB, 'hex')
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB)
}

/**
 * 读取 Authorization: Bearer <token> 头值；形态不合法 → null。
 * 纯字符串拆解（trim/toLowerCase/startsWith/slice，无正则捕获、无任何进程或
 * 命令执行——只是 HTTP 头文本解析，产物交给 authenticateBearerToken 做
 * SHA-256 常数时间比对）。语义等价原 /^Bearer\s+(.+)$/i：HTTP 头值合法空白
 * 仅为 SP/HTAB，故前缀后须紧跟一个空白再接非空 token。
 */
export function readBearerHeaderValue(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null
  const trimmed = header.trim()
  const prefix = 'bearer'
  if (trimmed.length <= prefix.length + 1) return null
  if (trimmed.slice(0, prefix.length).toLowerCase() !== prefix) return null
  if (trimmed[prefix.length] !== ' ' && trimmed[prefix.length] !== '\t') return null
  const token = trimmed.slice(prefix.length + 1).trim()
  return token.length > 0 ? token : null
}

export interface AuthenticatedDevice {
  id: number
  deviceName: string
  platform: string
  tokenVersion: number
}

/**
 * 轮换宽限窗（docs/18 §3.14 权威值 300s，M3-C7b 修 ② 桌面镜像）：旧 Token 自
 * token_rotation 帧发出（= rotateDeviceToken 落库 rotated_at）起 300s 内仍被
 * 认可，窗外拒绝；无轮换（previous_token_hash IS NULL）恒只认当前 token_hash。
 */
export const ROTATION_GRACE_SEC = 300

/** 轮换宽限判定（rotated_at 缺失视为已出窗——绝不猜；只前进不回拨）。 */
export function isWithinRotationGrace(rotatedAt: number | null, now: number = nowSec()): boolean {
  return rotatedAt !== null && Number.isSafeInteger(rotatedAt) && now - rotatedAt <= ROTATION_GRACE_SEC
}

/**
 * Bearer Token 校验（docs/15 §3/§4）：sha256(token) 查 remote_devices（token_hash
 * 唯一索引）；常数时间二次比对防时序；撤销 → DEVICE_REVOKED（W8 撤销即拒）。
 * 抛 ServiceError：AUTH_INVALID_TOKEN / DEVICE_REVOKED（docs/14 Part C）。
 *
 * M3-C7b 修 ②（docs/18 §3.14 轮换宽限桌面镜像）：主哈希未命中时按
 * previous_token_hash（migration 006 append-only 新列）二次查表——命中且
 * (now - rotated_at) ≤ ROTATION_GRACE_SEC → 宽限放行（设备侧 v1 在窗内仍有效，
 * R-B4/R-B5 解锁根）；窗外/rotated_at 缺失 → AUTH_INVALID_TOKEN。撤销即拒对
 * 两条命中路径同等生效（宽限绝不复活已撤销设备，docs/15 §4）。tokenVersion
 * 返回行现值（新版本号）——设备自己的 v1 视图由其本地状态承载，本侧不伪造。
 */
export function authenticateBearerToken(token: string | null): AuthenticatedDevice {
  if (token === null) {
    throw new ServiceError('AUTH_INVALID_TOKEN', 'gateway: missing or malformed Authorization: Bearer header')
  }
  const tokenHash = sha256Hex(token)
  const row = getDatabase()
    .prepare('SELECT id, device_name, platform, token_hash, token_version, status FROM remote_devices WHERE token_hash = ?')
    .get(tokenHash) as
    | { id: number; device_name: string; platform: string; token_hash: string; token_version: number; status: string }
    | undefined
  if (row !== undefined) {
    // 常数时间二次比对：sha256(提交 Token) 与库存 token_hash 逐字节比对（防时序）
    if (!constantTimeEquals(tokenHash, row.token_hash)) {
      throw new ServiceError('AUTH_INVALID_TOKEN', 'gateway: device token is invalid')
    }
    if (row.status === 'revoked') {
      throw new ServiceError('DEVICE_REVOKED', `gateway: device ${row.id} is revoked (token permanently rejected, docs/15 §4)`)
    }
    return { id: row.id, deviceName: row.device_name, platform: row.platform, tokenVersion: row.token_version }
  }
  // 轮换宽限镜像（docs/18 §3.14）：旧 Token 窗内仍认（M3-C7b 修 ②）
  const prevRow = getDatabase()
    .prepare(
      'SELECT id, device_name, platform, previous_token_hash, rotated_at, token_version, status FROM remote_devices WHERE previous_token_hash = ?',
    )
    .get(tokenHash) as
    | {
        id: number
        device_name: string
        platform: string
        previous_token_hash: string
        rotated_at: number | null
        token_version: number
        status: string
      }
    | undefined
  if (
    prevRow !== undefined &&
    constantTimeEquals(tokenHash, prevRow.previous_token_hash) &&
    isWithinRotationGrace(prevRow.rotated_at === null || prevRow.rotated_at === undefined ? null : Number(prevRow.rotated_at))
  ) {
    if (prevRow.status === 'revoked') {
      throw new ServiceError('DEVICE_REVOKED', `gateway: device ${prevRow.id} is revoked (token permanently rejected, docs/15 §4)`)
    }
    return { id: prevRow.id, deviceName: prevRow.device_name, platform: prevRow.platform, tokenVersion: prevRow.token_version }
  }
  // 行不存在与哈希不一致同一口径（不泄漏设备存在性）：对占位等长哈希做一次
  // 常数时间比较保持恒定路径，再统一 AUTH_INVALID_TOKEN
  constantTimeEquals(tokenHash, '0'.repeat(64))
  throw new ServiceError('AUTH_INVALID_TOKEN', 'gateway: device token is invalid')
}

/** 256-bit Token 签发（base64url 明文仅 claim 响应一次性出现；docs/15 §3）。 */
export function generateDeviceToken(): string {
  return randomBytes(32).toString('base64url')
}

// ---------------------------------------------------------------------------
// 滑动窗口原语（内存；重启清零可接受——docs/14 §B.4 参数表的落地注记）
// ---------------------------------------------------------------------------

interface SlidingWindowOptions {
  /** 窗口宽度（毫秒）。 */
  windowMs: number
  /** 窗口内允许的最大事件数。 */
  maxEvents: number
  /** 单 key 事件时间戳上限（防内存放大；超出即整体丢弃最旧）。 */
  maxKeptPerKey?: number
}

class SlidingWindow {
  private readonly hits = new Map<string, number[]>()
  // 显式字段赋值（不用 TS 参数属性——Node strip-only 模式不支持
  // ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX，smoke 系统 Node 直载 .ts 必须 strip-only 可加载）
  private readonly options: SlidingWindowOptions

  constructor(options: SlidingWindowOptions) {
    this.options = options
  }

  /** 记录一次事件。 */
  record(key: string, nowMs: number): void {
    this.prune(key, nowMs)
    const arr = this.hits.get(key) ?? []
    arr.push(nowMs)
    const kept = this.options.maxKeptPerKey ?? this.options.maxEvents * 4
    this.hits.set(key, arr.length > kept ? arr.slice(arr.length - kept) : arr)
  }

  /** 窗口内是否已满（记录后判断超限，或先判断再记录——由调用方定序）。 */
  isFull(key: string, nowMs: number): boolean {
    this.prune(key, nowMs)
    return (this.hits.get(key)?.length ?? 0) >= this.options.maxEvents
  }

  /** 窗口剩余等待毫秒（超限时给 Retry-After 用；未超限 → 0）。 */
  retryAfterMs(key: string, nowMs: number): number {
    this.prune(key, nowMs)
    const arr = this.hits.get(key)
    if (arr === undefined || arr.length < this.options.maxEvents) return 0
    const oldest = arr[0]
    return Math.max(0, oldest + this.options.windowMs - nowMs)
  }

  private prune(key: string, nowMs: number): void {
    const arr = this.hits.get(key)
    if (arr === undefined) return
    const fresh = arr.filter((t) => nowMs - t < this.options.windowMs)
    if (fresh.length === 0) this.hits.delete(key)
    else this.hits.set(key, fresh)
  }

  clear(): void {
    this.hits.clear()
  }
}

// ---------------------------------------------------------------------------
// 防重放（docs/14 §B.4：±300s 窗口 + nonce LRU 10 分钟）
// ---------------------------------------------------------------------------

/** 时间戳窗口（±300s，docs/14 §B.4）。 */
export const REPLAY_TIMESTAMP_WINDOW_SEC = 300
/** nonce LRU 保留时长（10 分钟，docs/14 §B.4）。 */
export const NONCE_TTL_MS = 10 * 60 * 1000
/** nonce LRU 容量上限（10 分钟窗口内的合理上界，防内存放大）。 */
const NONCE_MAX_ENTRIES = 20000
/** nonce 合法形态：128-bit 随机的 hex/base64url 常见编码 → 16–128 可打印 ASCII 字符。 */
const NONCE_MIN_CHARS = 16
const NONCE_MAX_CHARS = 128

interface SeenNonce {
  value: string
  seenAt: number
}

const seenNonces = new Map<string, SeenNonce>()

function rememberNonce(nonce: string, nowMs: number): void {
  seenNonces.set(nonce, { value: nonce, seenAt: nowMs })
  // LRU 淘汰：超容量先删最旧（Map 迭代序 = 插入序）
  while (seenNonces.size > NONCE_MAX_ENTRIES) {
    const oldestKey = seenNonces.keys().next()
    if (oldestKey.done === true) break
    seenNonces.delete(oldestKey.value)
  }
}

function pruneNonces(nowMs: number): void {
  // AC6 修复：逐项独立判断过期（LRU 语义 = 每个 nonce 按自身 seenAt 判 10min）。
  // 此前的「插入序 = 时间序，首个未过期即全未过期」break 优化在 nowMs 注入缝
  // （smoke 注入 clock / 时钟回拨）下失效：真实时钟登记的 nonce seenAt 大于注入
  // nowMs 时首项即「未过期」而提前 break，导致尾部已过期 nonce 永不清理。
  for (const [key, entry] of seenNonces) {
    if (nowMs - entry.seenAt >= NONCE_TTL_MS) seenNonces.delete(key)
  }
}

export interface ReplayHeaders {
  timestamp: string | string[] | undefined
  nonce: string | string[] | undefined
}

/**
 * 防重放校验（受保护请求必须带两头，docs/15 §4）：
 * - X-DevHub-Timestamp：unix 秒整数，|now - ts| > 300 → AUTH_REPLAYED；
 * - X-DevHub-Nonce：16–128 可打印 ASCII（128-bit 随机编码形态），重复 → AUTH_REPLAYED。
 * 缺头同为 AUTH_REPLAYED（受保护面合同：无防重放凭据 = 按重放嫌疑拒绝，docs/14 §B.4
 * 「受保护请求必须带」）。首次出现的 nonce 在此登记（check-and-set 原子语义由单线程
 * Main 事件循环保证）。
 */
export function checkReplayHeaders(headers: ReplayHeaders, nowMs: number = Date.now()): void {
  const tsRaw = headers.timestamp
  const tsStr = typeof tsRaw === 'string' ? tsRaw.trim() : Array.isArray(tsRaw) ? String(tsRaw[0] ?? '').trim() : ''
  if (!/^\d{1,12}$/.test(tsStr)) {
    throw new ServiceError('AUTH_REPLAYED', 'gateway: protected requests must carry X-DevHub-Timestamp (unix seconds, ±300s window, docs/14 B.4)')
  }
  const ts = Number.parseInt(tsStr, 10)
  const nowSec = Math.floor(nowMs / 1000)
  if (Math.abs(nowSec - ts) > REPLAY_TIMESTAMP_WINDOW_SEC) {
    throw new ServiceError('AUTH_REPLAYED', `gateway: X-DevHub-Timestamp outside ±${REPLAY_TIMESTAMP_WINDOW_SEC}s window (docs/14 B.4)`)
  }
  const nonceRaw = headers.nonce
  const nonce =
    typeof nonceRaw === 'string' ? nonceRaw.trim() : Array.isArray(nonceRaw) ? String(nonceRaw[0] ?? '').trim() : ''
  if (
    nonce.length < NONCE_MIN_CHARS ||
    nonce.length > NONCE_MAX_CHARS ||
    !/^[\x21-\x7e]+$/.test(nonce)
  ) {
    throw new ServiceError('AUTH_REPLAYED', 'gateway: protected requests must carry X-DevHub-Nonce (128-bit random, 16-128 printable chars, docs/14 B.4)')
  }
  pruneNonces(nowMs)
  if (seenNonces.has(nonce)) {
    throw new ServiceError('AUTH_REPLAYED', 'gateway: X-DevHub-Nonce already seen within 10min LRU window (docs/14 B.4)')
  }
  rememberNonce(nonce, nowMs)
}

/** smoke/测试复位（进程内多次隔离场景用；生产不调用）。 */
export function resetReplayState(): void {
  seenNonces.clear()
}

// ---------------------------------------------------------------------------
// 限流（docs/14 §B.4 参数表）
// ---------------------------------------------------------------------------

/** 鉴权失败限流：同源 5 次/60s。 */
export const AUTH_FAILURE_LIMIT = { maxEvents: 5, windowMs: 60 * 1000 } as const
/** 常规请求限流：120 次/min/设备。 */
export const DEVICE_REQUEST_LIMIT = { maxEvents: 120, windowMs: 60 * 1000 } as const
/** 配对 claim 限流：同源 5 次/5min（pairing.ts 复用同款窗口原语）。 */
export const CLAIM_LIMIT = { maxEvents: 5, windowMs: 5 * 60 * 1000 } as const

const authFailureWindow = new SlidingWindow({ windowMs: AUTH_FAILURE_LIMIT.windowMs, maxEvents: AUTH_FAILURE_LIMIT.maxEvents })
const deviceRequestWindow = new SlidingWindow({ windowMs: DEVICE_REQUEST_LIMIT.windowMs, maxEvents: DEVICE_REQUEST_LIMIT.maxEvents })
const claimWindow = new SlidingWindow({ windowMs: CLAIM_LIMIT.windowMs, maxEvents: CLAIM_LIMIT.maxEvents })

/**
 * 来源键（「同源」粒度）：远程 IP。Gateway 只绑 127.0.0.1，直连来源恒为回环；
 * 经 NatPierce 隧道的来源同样以套接字对端为准（隧道不改变安全决策，docs/15 §8）。
 */
export function sourceKeyFromRemoteAddress(remoteAddress: string | undefined): string {
  return remoteAddress !== undefined && remoteAddress.length > 0 ? remoteAddress : 'unknown'
}

/**
 * 鉴权失败登记 + 超限判定（docs/14 §B.4：同源 5 次/60s → 429 + Retry-After: 60）。
 * 返回 true = 本次失败触发限流（后续同源请求在窗口内一律 429）。
 */
export function recordAuthFailure(sourceKey: string, nowMs: number = Date.now()): boolean {
  authFailureWindow.record(sourceKey, nowMs)
  return authFailureWindow.isFull(sourceKey, nowMs)
}

/** 同源是否已被鉴权失败限流（窗口未滑出前一律拒绝）。 */
export function isAuthFailureLimited(sourceKey: string, nowMs: number = Date.now()): boolean {
  return authFailureWindow.isFull(sourceKey, nowMs)
}

/** 鉴权失败限流的 Retry-After 秒数（向上取整；未超限 → 0）。 */
export function authFailureRetryAfterSec(sourceKey: string, nowMs: number = Date.now()): number {
  return Math.ceil(authFailureWindow.retryAfterMs(sourceKey, nowMs) / 1000)
}

/** claim 限流的 Retry-After 秒数（向上取整；未超限 → 0）。 */
export function claimRetryAfterSec(sourceKey: string, nowMs: number = Date.now()): number {
  return Math.ceil(claimWindow.retryAfterMs(sourceKey, nowMs) / 1000)
}

/**
 * 常规请求登记（per-device 120/min）。返回 true = 超限（调用方回 429）。
 * AC6 修复：先判满再记录——窗口内第 120 次请求放行、第 121 次起 429
 * （docs/14 §B.4「120 次/min/设备」允许恰好 120 次；先 record 后 isFull 的
 * 「记录即判满」序会让第 120 次即被拒，off-by-one）。鉴权失败/claim 限流
 * 保留「记录即判满」序不变（前者由下一次请求的 isAuthFailureLimited 判定，
 * 后者是安全侧更严格的语义，docs/15 §2）。
 */
export function recordDeviceRequest(deviceId: number, nowMs: number = Date.now()): boolean {
  const key = `device:${deviceId}`
  const full = deviceRequestWindow.isFull(key, nowMs)
  deviceRequestWindow.record(key, nowMs)
  return full
}

/** claim 尝试登记（同源 5 次/5min）。返回 true = 超限（调用方回 429）。 */
export function recordClaimAttempt(sourceKey: string, nowMs: number = Date.now()): boolean {
  claimWindow.record(sourceKey, nowMs)
  return claimWindow.isFull(sourceKey, nowMs)
}

/** smoke/测试复位（限流窗口为内存态，重启清零语义的测试等价物）。 */
export function resetRateLimitState(): void {
  authFailureWindow.clear()
  deviceRequestWindow.clear()
  claimWindow.clear()
}
