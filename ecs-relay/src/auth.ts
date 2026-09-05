/**
 * auth.ts — ECS Relay 鉴权面（docs/19 §2 三层身份 + docs/18 §2/§7.4）。
 *
 * 移植蓝本 = gateway/auth.ts（防重放/滑窗限流/常数时间比对原样）；差异点：
 * - L1 设备注册表 = relay_devices（sha256(端到端 Token) 镜像，docs/19 §2.1）；
 *   注册表中无此身份 → RELAY_DEVICE_UNKNOWN（docs/18 §8.2 新码）；
 *   撤销 → DEVICE_REVOKED（撤销即拒不可复活）。
 * - L2 主机凭据 = relay_hosts（sha256(Relay 凭据)，docs/19 §2.2）；无此身份 → RELAY_HOST_UNKNOWN。
 * - ECS 不解释 Token 授权含义，只做「注册过 + active」判定 + 限流（docs/19 §2.1 裁决③）。
 * 限流三件套（docs/18 §7.4，同参 docs/14 §B.4，全部内存滑窗、重启清零）：
 *   ① 鉴权失败 5 次/60s/源 → 429 AUTH_RATE_LIMITED + Retry-After；
 *   ② 常规请求 120 次/min/设备 → 429；
 *   ③ 配对 claim 5 次/5min/源（pairing.ts 复用同款窗口原语）。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Store } from './store.ts'
import { RelayError } from './errors.ts'

/** sha256 hex（Token/凭据/配对码共用哈希管道；明文绝不落日志/DB——红线）。 */
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
 * 语义镜像 gateway/auth.ts（HTTP 头值合法空白仅为 SP/HTAB）。
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

export interface RelayDevice {
  id: number
  winDeviceId: number | null
  deviceName: string
  platform: string
  tokenVersion: number
}

export interface RelayHost {
  id: number
  hostName: string | null
}

/**
 * L1 设备注册表校验（docs/19 §2.1）：sha256(token) ∈ relay_devices 且 status='active'。
 * 无此身份 → RELAY_DEVICE_UNKNOWN（不泄漏设备存在性：对占位等长哈希做常数时间比较）；
 * 撤销 → DEVICE_REVOKED（W8 撤销即拒）。
 */
export function authenticateDeviceToken(store: Store, token: string | null): RelayDevice {
  if (token === null) {
    throw new RelayError('AUTH_INVALID_TOKEN', 'relay: missing or malformed Authorization: Bearer header')
  }
  const tokenHash = sha256Hex(token)
  const row = store.get<{ id: number; win_device_id: number | null; device_name: string; platform: string; token_hash: string; token_version: number; status: string }>(
    'SELECT id, win_device_id, device_name, platform, token_hash, token_version, status FROM relay_devices WHERE token_hash = ?',
    tokenHash,
  )
  if (row === undefined) {
    constantTimeEquals(tokenHash, '0'.repeat(64))
    throw new RelayError('RELAY_DEVICE_UNKNOWN', 'relay: device is not enrolled in the relay registry')
  }
  if (!constantTimeEquals(tokenHash, row.token_hash)) {
    throw new RelayError('RELAY_DEVICE_UNKNOWN', 'relay: device is not enrolled in the relay registry')
  }
  if (row.status === 'revoked') {
    throw new RelayError('DEVICE_REVOKED', `relay: device ${row.id} is revoked (token permanently rejected)`)
  }
  return { id: row.id, winDeviceId: row.win_device_id, deviceName: row.device_name, platform: row.platform, tokenVersion: row.token_version }
}

/** L2 主机凭据校验（docs/19 §2.2）：sha256(credential) ∈ relay_hosts 且 active。 */
export function authenticateHostCredential(store: Store, credential: string | null): RelayHost {
  if (credential === null) {
    throw new RelayError('AUTH_INVALID_TOKEN', 'relay: missing or malformed Authorization: Bearer header')
  }
  const credentialHash = sha256Hex(credential)
  const row = store.get<{ id: number; host_name: string | null; credential_hash: string; status: string }>(
    'SELECT id, host_name, credential_hash, status FROM relay_hosts WHERE credential_hash = ?',
    credentialHash,
  )
  if (row === undefined) {
    constantTimeEquals(credentialHash, '0'.repeat(64))
    throw new RelayError('RELAY_HOST_UNKNOWN', 'relay: host credential is not enrolled')
  }
  if (!constantTimeEquals(credentialHash, row.credential_hash)) {
    throw new RelayError('RELAY_HOST_UNKNOWN', 'relay: host credential is not enrolled')
  }
  if (row.status === 'revoked') {
    throw new RelayError('DEVICE_REVOKED', `relay: host ${row.id} is revoked`)
  }
  return { id: row.id, hostName: row.host_name }
}

/** 256-bit Relay 凭据签发（base64url；明文仅注册响应一次性出现，docs/19 §2.2）。 */
export function generateHostCredential(): string {
  return randomBytes(32).toString('base64url')
}

// ---------------------------------------------------------------------------
// 滑动窗口原语（gateway/auth.ts 蓝本移植；内存态，重启清零——docs/14 §B.4 落地注记）
// ---------------------------------------------------------------------------

interface SlidingWindowOptions {
  windowMs: number
  maxEvents: number
  maxKeptPerKey?: number
}

export class SlidingWindow {
  private readonly hits = new Map<string, number[]>()
  private readonly options: SlidingWindowOptions

  constructor(options: SlidingWindowOptions) {
    this.options = options
  }

  record(key: string, nowMs: number): void {
    this.prune(key, nowMs)
    const arr = this.hits.get(key) ?? []
    arr.push(nowMs)
    const kept = this.options.maxKeptPerKey ?? this.options.maxEvents * 4
    this.hits.set(key, arr.length > kept ? arr.slice(arr.length - kept) : arr)
  }

  isFull(key: string, nowMs: number): boolean {
    this.prune(key, nowMs)
    return (this.hits.get(key)?.length ?? 0) >= this.options.maxEvents
  }

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
// 防重放（docs/18 §7.4：REST 面同参 docs/14 §B.4 —— ±300s 窗口 + nonce LRU 10min）
// ---------------------------------------------------------------------------

export const REPLAY_TIMESTAMP_WINDOW_SEC = 300
export const NONCE_TTL_MS = 10 * 60 * 1000
const NONCE_MAX_ENTRIES = 20000
const NONCE_MIN_CHARS = 16
const NONCE_MAX_CHARS = 128

interface SeenNonce {
  value: string
  seenAt: number
}

export class ReplayGuard {
  private readonly seenNonces = new Map<string, SeenNonce>()

  check(headers: { timestamp: string | string[] | undefined; nonce: string | string[] | undefined }, nowMs: number): void {
    const tsRaw = headers.timestamp
    const tsStr = typeof tsRaw === 'string' ? tsRaw.trim() : Array.isArray(tsRaw) ? String(tsRaw[0] ?? '').trim() : ''
    if (!/^\d{1,12}$/.test(tsStr)) {
      throw new RelayError('AUTH_REPLAYED', 'relay: protected requests must carry X-DevHub-Timestamp (unix seconds, ±300s window)')
    }
    const ts = Number.parseInt(tsStr, 10)
    const nowSec = Math.floor(nowMs / 1000)
    if (Math.abs(nowSec - ts) > REPLAY_TIMESTAMP_WINDOW_SEC) {
      throw new RelayError('AUTH_REPLAYED', `relay: X-DevHub-Timestamp outside ±${REPLAY_TIMESTAMP_WINDOW_SEC}s window`)
    }
    const nonceRaw = headers.nonce
    const nonce =
      typeof nonceRaw === 'string' ? nonceRaw.trim() : Array.isArray(nonceRaw) ? String(nonceRaw[0] ?? '').trim() : ''
    if (nonce.length < NONCE_MIN_CHARS || nonce.length > NONCE_MAX_CHARS || !/^[\x21-\x7e]+$/.test(nonce)) {
      throw new RelayError('AUTH_REPLAYED', 'relay: protected requests must carry X-DevHub-Nonce (128-bit random, 16-128 printable chars)')
    }
    this.prune(nowMs)
    if (this.seenNonces.has(nonce)) {
      throw new RelayError('AUTH_REPLAYED', 'relay: X-DevHub-Nonce already seen within 10min LRU window')
    }
    this.seenNonces.set(nonce, { value: nonce, seenAt: nowMs })
    while (this.seenNonces.size > NONCE_MAX_ENTRIES) {
      const oldestKey = this.seenNonces.keys().next()
      if (oldestKey.done === true) break
      this.seenNonces.delete(oldestKey.value)
    }
  }

  private prune(nowMs: number): void {
    for (const [key, entry] of this.seenNonces) {
      if (nowMs - entry.seenAt >= NONCE_TTL_MS) this.seenNonces.delete(key)
    }
  }

  reset(): void {
    this.seenNonces.clear()
  }
}

// ---------------------------------------------------------------------------
// 限流三件套（docs/18 §7.4，同参 docs/14 §B.4）
// ---------------------------------------------------------------------------

export const AUTH_FAILURE_LIMIT = { maxEvents: 5, windowMs: 60 * 1000 } as const
export const DEVICE_REQUEST_LIMIT = { maxEvents: 120, windowMs: 60 * 1000 } as const
export const CLAIM_LIMIT = { maxEvents: 5, windowMs: 5 * 60 * 1000 } as const

export class RateLimits {
  readonly authFailureWindow = new SlidingWindow({ windowMs: AUTH_FAILURE_LIMIT.windowMs, maxEvents: AUTH_FAILURE_LIMIT.maxEvents })
  readonly deviceRequestWindow = new SlidingWindow({ windowMs: DEVICE_REQUEST_LIMIT.windowMs, maxEvents: DEVICE_REQUEST_LIMIT.maxEvents })
  readonly claimWindow = new SlidingWindow({ windowMs: CLAIM_LIMIT.windowMs, maxEvents: CLAIM_LIMIT.maxEvents })

  /** 来源键（「同源」粒度 = 套接字对端 IP；docs/19 §5.1 Relay 只绑回环/反代透传）。 */
  sourceKey(remoteAddress: string | undefined): string {
    return remoteAddress !== undefined && remoteAddress.length > 0 ? remoteAddress : 'unknown'
  }

  /** 鉴权失败登记；返回 true = 本次失败触发限流（窗口内后续同源一律 429）。 */
  recordAuthFailure(sourceKey: string, nowMs: number): boolean {
    this.authFailureWindow.record(sourceKey, nowMs)
    return this.authFailureWindow.isFull(sourceKey, nowMs)
  }

  isAuthFailureLimited(sourceKey: string, nowMs: number): boolean {
    return this.authFailureWindow.isFull(sourceKey, nowMs)
  }

  authFailureRetryAfterSec(sourceKey: string, nowMs: number): number {
    return Math.ceil(this.authFailureWindow.retryAfterMs(sourceKey, nowMs) / 1000)
  }

  /** 常规请求登记（120/min/设备；先判满再记录——第 120 次放行，第 121 次起 429，gateway AC6 off-by-one 语义）。 */
  recordDeviceRequest(deviceId: number, nowMs: number): boolean {
    const key = `device:${deviceId}`
    const full = this.deviceRequestWindow.isFull(key, nowMs)
    this.deviceRequestWindow.record(key, nowMs)
    return full
  }

  deviceRequestRetryAfterSec(deviceId: number, nowMs: number): number {
    return Math.ceil(this.deviceRequestWindow.retryAfterMs(`device:${deviceId}`, nowMs) / 1000)
  }

  /** claim 尝试登记（5 次/5min/源；尝试即计数含成功）。返回 true = 超限。 */
  recordClaimAttempt(sourceKey: string, nowMs: number): boolean {
    this.claimWindow.record(sourceKey, nowMs)
    return this.claimWindow.isFull(sourceKey, nowMs)
  }

  claimRetryAfterSec(sourceKey: string, nowMs: number): number {
    return Math.ceil(this.claimWindow.retryAfterMs(sourceKey, nowMs) / 1000)
  }

  reset(): void {
    this.authFailureWindow.clear()
    this.deviceRequestWindow.clear()
    this.claimWindow.clear()
  }
}
