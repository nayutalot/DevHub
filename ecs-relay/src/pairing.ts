/**
 * pairing.ts — 配对码落表/校验/作废/限流（docs/19 §5.2，蓝本 = gateway/pairing.ts + auth.ts claim 语义）。
 *
 * 语义上移（G4 裁决①，docs/18 §3.2 校验归属表）：
 * - 码存在 / TTL 300s / 一次性 / 新码废旧码 / 失败 5 次作废 → **ECS**（pairing_codes 表）；
 * - claim 限流 5 次/5min/源 → ECS（替代现 Gateway 同源限流，CLAIM_LIMIT 同参）；
 * - pairingId 活性 / Token 签发 / token_hash 落库 → **Windows**（pair_accepted 回帧，L3）。
 * 码明文只在 device leg pair 帧出现过境一次：不入日志、不入审计 detail、不入 DB
 * （表内只存 sha256(code)——docs/19 §2.4 凭据总表）。platform 强制 android。
 */
import type { Store } from './store.ts'
import { RelayError } from './errors.ts'
import { constantTimeEquals, sha256Hex } from './auth.ts'
import type { RateLimits } from './auth.ts'

export interface RegisteredPairing {
  pairingId: string
  expiresAt: number
}

/**
 * host leg register_pairing 帧 → pairing_codes 落表（docs/19 §4.5 pairingBridge）。
 * 新码签发即废旧码（status='voided'，PAIRING_CODE_VOIDED 语义面）；同时至多 1 活跃码。
 */
export function registerPairing(
  store: Store,
  input: { pairingId: string; codeHash: string; expiresAt: number; deviceNameHint?: string | null },
  nowSec: number,
  ttlSec: number,
): RegisteredPairing {
  if (typeof input.pairingId !== 'string' || input.pairingId.length === 0 || input.pairingId.length > 200) {
    throw new RelayError('BAD_PAYLOAD', 'pairing: pairingId must be a non-empty string (≤200 chars)')
  }
  if (typeof input.codeHash !== 'string' || !/^[0-9a-f]{64}$/.test(input.codeHash)) {
    throw new RelayError('BAD_PAYLOAD', 'pairing: codeHash must be sha256 hex (64 chars)')
  }
  const expiresAt = typeof input.expiresAt === 'number' && Number.isSafeInteger(input.expiresAt)
    ? input.expiresAt
    : nowSec + ttlSec
  const boundedExpiry = Math.min(expiresAt, nowSec + ttlSec) // TTL 上限 300s（docs/18 §3.2），host 侧更长也截断
  store.run("UPDATE pairing_codes SET status='voided' WHERE status='active'")
  store.run(
    'INSERT INTO pairing_codes (pairing_id, code_hash, expires_at, fail_count, status, created_at) VALUES (?, ?, ?, 0, \'active\', ?)',
    input.pairingId,
    input.codeHash.toLowerCase(),
    boundedExpiry,
    nowSec,
  )
  return { pairingId: input.pairingId, expiresAt: boundedExpiry }
}

export interface PairClaimInput {
  code: string
  deviceName: string
  platform: string
}

export interface PairClaimResult {
  ecsDeviceId: number
  pairingId: string
  deviceName: string
  platform: string
}

/** 常数时间码核验：sha256(提交码) 与库存 code_hash 逐字节比对（防时序，蓝本同款）。 */
function codeMatches(submitted: string, storedHash: string): boolean {
  return constantTimeEquals(sha256Hex(submitted), storedHash)
}

/**
 * pair 帧核销（docs/18 §3.2/§9.1；校验序镜像 gateway/pairing.ts claimPairingCode）：
 * 限流 → 活跃码存在 → 未过期 → 码匹配（失败计数 ≥5 作废）→ 成功即建 pending 设备行
 * （token_version=0 占位，pair_accepted 回帧时绑定 Token）。错误码按 docs/18 §8.2 分化：
 * PAIRING_INVALID_CODE（无活跃码/码不对/已用）/ PAIRING_CODE_EXPIRED（TTL 过）/
 * PAIRING_CODE_VOIDED（失败 5 次作废/新码废旧码后重放旧码）。
 */
export function claimPairing(
  store: Store,
  input: PairClaimInput,
  sourceKey: string,
  rateLimits: RateLimits,
  audit: { write: (entry: { category: 'pairing' | 'auth'; action: string; outcome: 'success' | 'denied' | 'error'; detail?: Record<string, unknown> }) => void },
  nowMs: number = Date.now(),
): PairClaimResult {
  const nowSec = Math.floor(nowMs / 1000)
  if (typeof input.code !== 'string' || input.code.trim().length === 0) {
    throw new RelayError('BAD_PAYLOAD', 'pairing: code must be a non-empty string')
  }
  if (input.platform !== 'android') {
    // 强制 android（docs/18 §3.2：与现 pairing.ts 一致）；取值错 = 载荷错误
    throw new RelayError('BAD_PAYLOAD', 'pairing: platform must be "android"')
  }
  const deviceName = typeof input.deviceName === 'string' && input.deviceName.trim().length > 0
    ? input.deviceName.trim().slice(0, 100)
    : 'android-device'

  // claim 限流（docs/18 §3.2：5 次/5min/源；尝试即计数，含成功——蓝本语义原样）
  if (rateLimits.recordClaimAttempt(sourceKey, nowMs)) {
    const retryAfterSec = Math.max(1, rateLimits.claimRetryAfterSec(sourceKey, nowMs))
    audit.write({ category: 'auth', action: 'rate_limited', outcome: 'denied', detail: { scope: 'pairing_claim', windowSec: 300 } })
    throw new RelayError('AUTH_RATE_LIMITED', `pairing: rate limited (5 attempts / 5min per source); retry after ${retryAfterSec}s`, retryAfterSec)
  }

  const code = input.code.trim()
  const codeHash = sha256Hex(code)

  // 历史码精确归因（docs/18 §8.2：used → INVALID（已用）；voided → PAIRING_CODE_VOIDED（作废/被废旧码））
  const historical = store.get<{ id: number; pairing_id: string; status: string }>(
    'SELECT id, pairing_id, status FROM pairing_codes WHERE code_hash = ? ORDER BY id DESC LIMIT 1',
    codeHash,
  )
  const active = store.get<{ id: number; pairing_id: string; code_hash: string; expires_at: number; fail_count: number }>(
    "SELECT id, pairing_id, code_hash, expires_at, fail_count FROM pairing_codes WHERE status = 'active' ORDER BY id DESC LIMIT 1",
  )
  if (active === undefined) {
    const reason = historical?.status === 'voided' ? 'voided' : historical?.status === 'used' ? 'already_used' : 'no_active_pairing'
    audit.write({ category: 'pairing', action: 'pairing_failed', outcome: 'denied', detail: { reason, source: 'device_leg' } })
    throw new RelayError(
      historical?.status === 'voided' ? 'PAIRING_CODE_VOIDED' : 'PAIRING_INVALID_CODE',
      'pairing: no active pairing code (issue a new code on the desktop first, docs/18 §3.2)',
    )
  }
  if (nowSec > active.expires_at) {
    store.run("UPDATE pairing_codes SET status='expired' WHERE id = ?", active.id)
    audit.write({ category: 'pairing', action: 'pairing_failed', outcome: 'denied', detail: { pairingId: active.pairing_id, reason: 'expired' } })
    throw new RelayError('PAIRING_CODE_EXPIRED', 'pairing: code expired (TTL 300s, docs/18 §3.2)')
  }
  // 提交的是已知的死码（非当前活跃行）：voided → VOIDED；used/expired → INVALID（计入活跃码失败）
  if (historical !== undefined && historical.id !== active.id) {
    if (historical.status === 'voided') {
      audit.write({ category: 'pairing', action: 'pairing_failed', outcome: 'denied', detail: { pairingId: historical.pairing_id, reason: 'voided_code_replay' } })
      throw new RelayError('PAIRING_CODE_VOIDED', 'pairing: code was voided (superseded by a newer code or too many failures, docs/18 §3.2)')
    }
    if (historical.status === 'used' || historical.status === 'expired') {
      const voided = recordPairingFailure(store, active.id, 5)
      audit.write({ category: 'pairing', action: 'pairing_failed', outcome: 'denied', detail: { pairingId: active.pairing_id, reason: 'dead_code_replay', voided } })
      throw new RelayError(
        voided ? 'PAIRING_CODE_VOIDED' : 'PAIRING_INVALID_CODE',
        voided ? 'pairing: code voided after 5 failed attempts (docs/18 §3.2)' : 'pairing: code mismatch (failure recorded, 5 failures void the code)',
      )
    }
  }
  // 常数时间码核验（防时序，蓝本同款）：sha256(提交码) vs 活跃码 code_hash
  if (!codeMatches(code, active.code_hash)) {
    const voided = recordPairingFailure(store, active.id, 5)
    audit.write({
      category: 'pairing',
      action: 'pairing_failed',
      outcome: 'denied',
      detail: { pairingId: active.pairing_id, reason: 'code_mismatch', voided },
    })
    throw new RelayError(
      voided ? 'PAIRING_CODE_VOIDED' : 'PAIRING_INVALID_CODE',
      voided
        ? 'pairing: code voided after 5 failed attempts (docs/18 §3.2)'
        : 'pairing: code mismatch (failure recorded, 5 failures void the code)',
    )
  }

  // 成功：码即失效（一次性）→ 建 pending 设备行（pair_accepted 绑定 Token）
  store.run("UPDATE pairing_codes SET status='used' WHERE id = ?", active.id)
  const result = store.run(
    'INSERT INTO relay_devices (win_device_id, device_name, platform, token_hash, token_version, status, paired_at, updated_at) VALUES (?, ?, ?, ?, 0, \'active\', ?, ?)',
    null,
    deviceName,
    'android',
    // pending 占位：随机 256-bit 哈希（无法被任何 Token 命中）；pair_accepted 回填真实哈希
    sha256Hex(codeHash + ':' + active.id + ':' + nowMs + ':' + Math.random()),
    nowSec,
    nowSec,
  )
  const ecsDeviceId = Number(result.lastInsertRowid)
  audit.write({ category: 'pairing', action: 'pairing_claimed', outcome: 'success', detail: { pairingId: active.pairing_id, ecsDeviceId } })
  return { ecsDeviceId, pairingId: active.pairing_id, deviceName, platform: 'android' }
}

/** 配对失败计数（码存在但 pairingId/其他校验失败时由调用方使用；≥5 次作废）。 */
export function recordPairingFailure(store: Store, pairingCodeRowId: number, maxFailures: number): boolean {
  store.run('UPDATE pairing_codes SET fail_count = fail_count + 1 WHERE id = ?', pairingCodeRowId)
  const row = store.get<{ fail_count: number; status: string }>('SELECT fail_count, status FROM pairing_codes WHERE id = ?', pairingCodeRowId)
  if (row !== undefined && row.status === 'active' && row.fail_count >= maxFailures) {
    store.run("UPDATE pairing_codes SET status='voided' WHERE id = ?", pairingCodeRowId)
    return true
  }
  return false
}

/**
 * pending 设备行定位（pair_accepted 回帧复核）：ecsDeviceId 存在、Token 未绑定
 * （token_version=0 占位、win_device_id 空）。绑定完成后不可重复绑定。
 */
export function findPendingDevice(store: Store, ecsDeviceId: number): { id: number; device_name: string; platform: string } | null {
  const row = store.get<{ id: number; device_name: string; platform: string }>(
    'SELECT id, device_name, platform FROM relay_devices WHERE id = ? AND win_device_id IS NULL AND token_version = 0 AND status = \'active\'',
    ecsDeviceId,
  )
  return row ?? null
}
