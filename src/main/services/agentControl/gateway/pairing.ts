/**
 * pairing.ts — 配对码签发 / 核销（docs/15 §2，docs/14 §B.1/B.3）。
 *
 * 语义（docs/15 §2 逐条）：
 * - 8 字符 Crockford Base32（32 符号表，去 I/L/O/U），码空间 32^8 ≈ 1.1×10^12；
 *   种子 = 256-bit crypto 随机（randomBytes(32) → SHA-256 折叠取 40 bit 映射 8 符号）。
 * - TTL 300s；即用即废（成功/过期/作废均不可再用）；同时至多 1 个活跃码，
 *   新码签发即废旧码（废旧码审计 pairing_code_expired/reason=superseded）。
 * - 防爆破：claim 同源限流 5 次/5min（限流窗口在 auth.ts）；单码连续失败 5 次 →
 *   码作废（审计 reason=too_many_failures）；全部尝试写 security_audit_logs。
 * - 码明文只在签发返回与 claim 请求中出现：不入日志、不入审计 detail、不入 DB
 *   （内存态只存 SHA-256 比对值——进程重启码失效，重签即可，TTL 300s 语义不受影响）。
 * - claim 成功 → 256-bit Token（base64url），token_hash 经 L3 pairDevice 落库
 *   （remote_devices 行 + device_paired 审计）；明文 Token 仅本次响应返回。
 *
 * gateway_enabled=0 → GATEWAY_DISABLED（语义裁决：引导启用，UI 文案 AC5 已有）。
 * electron-free；写库全部经 L3 函数（recordSecurityAudit / pairDevice，约束 #20）；
 * remote_devices 读取仅按 token_hash 查（auth.ts，属读豁免）。
 */

import { randomUUID, timingSafeEqual } from 'node:crypto'
import { ServiceError } from '../../internal.ts'
import { CLAIM_LIMIT, claimRetryAfterSec, generateDeviceToken, recordClaimAttempt, sha256Hex } from './auth.ts'
import { isGatewayEnabled, pairDevice, recordSecurityAudit } from '../agentControlService.ts'

/** 8 字符码长度（docs/15 §2）。 */
const CODE_LENGTH = 8
/** 配对码 TTL（300s，docs/15 §2 / docs/14 §B.3）。 */
export const PAIRING_TTL_SEC = 300
/** 单码连续失败作废阈值（docs/15 §2：失败 5 次 → 码作废）。 */
export const PAIRING_MAX_FAILURES = 5
/** claim 响应的 gateway 标识（docs/14 §B.1 gatewayName 字段）。 */
export const GATEWAY_NAME = 'devhub-gateway'

/** Crockford Base32 符号表（0-9 + 大写字母去 I/L/O/U，docs/15 §2）。 */
export const CROCKFORD_BASE32_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * 256-bit 随机 → 8 位 Crockford Base32：randomUUID 对种子 → SHA-256 折叠，
 * 每 2 个 hex 字符（1 字节）取低 5 bit 映射符号（256 → 32 整除，无模偏差）。
 */
export function generatePairingCode(randomSeed: string): string {
  const digest = sha256Hex(randomSeed)
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    const byte = Number.parseInt(digest.slice(i * 2, i * 2 + 2), 16)
    code += CROCKFORD_BASE32_ALPHABET[byte & 0x1f]
  }
  return code
}

/** 活跃配对码（内存态；同时至多 1 个，docs/15 §2）。 */
interface ActivePairing {
  pairingId: string
  /** SHA-256(code)（明文绝不驻留内存投影面之外的日志/审计）。 */
  codeHash: string
  deviceNameHint: string | null
  createdAt: number
  expiresAt: number
  consumed: boolean
  failures: number
}

let activePairing: ActivePairing | null = null

function nowMs(): number {
  return Date.now()
}

/** 作废当前活跃码（审计 pairing_code_expired；action 全集见 docs/13 §4.8）。 */
function voidActivePairing(reason: 'superseded' | 'expired' | 'too_many_failures'): void {
  if (activePairing === null) return
  recordSecurityAudit('pairing', 'pairing_code_expired', null, 'success', JSON.stringify({ pairingId: activePairing.pairingId, reason }))
  activePairing = null
}

/**
 * 签发配对码（IPC agents:pairingCreate 与 REST POST /v1/pairing/create 共用，
 * 语义完全一致，docs/14 §B.1 注）。gateway_enabled=0 → GATEWAY_DISABLED；
 * 新签发即废旧码；审计 pairing_code_created（detail 零码明文——红线 docs/15 §2）。
 * ttlSec 为 smoke/测试注入口（缺省 PAIRING_TTL_SEC=300；生产调用方不传）。
 */
export function createPairingCode(
  deviceName?: string,
  ttlSec: number = PAIRING_TTL_SEC,
): { pairingId: string; code: string; expiresAt: number } {
  if (!isGatewayEnabled()) {
    throw new ServiceError('GATEWAY_DISABLED', 'pairing: remote gateway is disabled (settings gateway_enabled = 0); enable the gateway first')
  }
  voidActivePairing('superseded')
  const now = Math.floor(nowMs() / 1000)
  const code = generatePairingCode(randomUUID() + randomUUID())
  activePairing = {
    pairingId: `pair-${randomUUID()}`,
    codeHash: sha256Hex(code),
    deviceNameHint: typeof deviceName === 'string' && deviceName.trim().length > 0 ? deviceName.trim().slice(0, 100) : null,
    createdAt: now,
    expiresAt: now + ttlSec,
    consumed: false,
    failures: 0,
  }
  recordSecurityAudit('pairing', 'pairing_code_created', null, 'success', JSON.stringify({ pairingId: activePairing.pairingId, ttlSec: PAIRING_TTL_SEC }))
  return { pairingId: activePairing.pairingId, code, expiresAt: activePairing.expiresAt }
}

export interface PairingClaimInput {
  /**
   * AC7b 裁决放宽：可选。未提供时按活跃码匹配（同时至多 1 活跃码，code 即唯一定位）；
   * 提供时必须与活跃码精确匹配（pairingId 对不上 → AUTH_INVALID_TOKEN，语义同码错）。
   * 响应/审计/限流/TTL/一次性语义零变化。
   */
  pairingId?: string
  code: string
  deviceName: string
  platform: string
}

export interface PairingClaimResult {
  deviceId: number
  token: string
  tokenVersion: number
  gatewayName: string
}

function rejectInvalidCode(message: string): never {
  throw new ServiceError('AUTH_INVALID_TOKEN', `pairing claim: ${message}`)
}

/** 常数时间码核验：sha256(提交码) 与内存 codeHash 逐字节比对（防时序）。 */
function codeMatches(submitted: string, storedHash: string): boolean {
  const a = Buffer.from(sha256Hex(submitted), 'hex')
  const b = Buffer.from(storedHash, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * claim 核销（docs/14 §B.3 时序）：限流 → 码存在/未过期/未用 → 失败计数 →
 * 成功即 256-bit Token 签发 + 设备行落库（L3 pairDevice）+ 审计；码即失效。
 * 无效/过期/已用/作废统一 AUTH_INVALID_TOKEN（不区分具体原因，收敛爆破信息面）。
 * AC7b 裁决：pairingId 可选（docs/14 §B.1 实现注记）——code-only claim 依赖
 * 同时仅 1 活跃码的唯一定位语义；两者同给必须全匹配。
 */
export function claimPairingCode(input: PairingClaimInput, sourceKey: string): PairingClaimResult {
  const now = nowMs()
  // 配对 claim 限流（docs/14 §B.4：同源 5 次/5min；尝试即计数，含成功）
  if (recordClaimAttempt(sourceKey, now)) {
    const retryAfterSec = Math.max(1, claimRetryAfterSec(sourceKey, now))
    recordSecurityAudit('auth', 'rate_limited', null, 'denied', JSON.stringify({ scope: 'pairing_claim', windowSec: CLAIM_LIMIT.windowMs / 1000 }))
    throw Object.assign(
      new ServiceError('AUTH_RATE_LIMITED', `pairing claim: rate limited (5 attempts / 5min per source, docs/14 B.4); retry after ${retryAfterSec}s`),
      { retryAfterSec },
    )
  }
  const pairing = activePairing
  if (pairing === null) {
    rejectInvalidCode('no active pairing code (issue a new code on the desktop first)')
  }
  if (pairing.consumed) {
    rejectInvalidCode('pairing code already consumed (one-time, docs/15 §2)')
  }
  if (nowMs() / 1000 > pairing.expiresAt) {
    voidActivePairing('expired')
    rejectInvalidCode('pairing code expired (TTL 300s)')
  }
  // AC7b 裁决：pairingId 可选——提供时必须精确匹配；code 恒必核验（唯一凭据语义不变）
  if ((input.pairingId !== undefined && input.pairingId !== pairing.pairingId) || !codeMatches(input.code, pairing.codeHash)) {
    pairing.failures += 1
    if (pairing.failures >= PAIRING_MAX_FAILURES) {
      voidActivePairing('too_many_failures')
    }
    rejectInvalidCode(`pairing id/code mismatch (failure ${pairing.failures}/${PAIRING_MAX_FAILURES})`)
  }
  // 成功：码即失效（一次性）→ 设备行 + 审计；Token 明文仅本次返回（红线）
  pairing.consumed = true
  activePairing = null
  const token = generateDeviceToken()
  const paired = pairDevice({ deviceName: input.deviceName, platform: input.platform, tokenHash: sha256Hex(token) })
  recordSecurityAudit('pairing', 'pairing_claimed', paired.deviceId, 'success', JSON.stringify({ pairingId: pairing.pairingId, source: sourceKey }))
  return { deviceId: paired.deviceId, token, tokenVersion: paired.tokenVersion, gatewayName: GATEWAY_NAME }
}

/**
 * Relay 面核销（M2-R1 pairingBridge，docs/18 §3.2 校验归属表 + §3.3；docs/19 §4.5）：
 * Relay 模式下码校验上移 ECS（TTL/一次性/失败作废/限流），明文码不出 device leg
 * ——E→H pair 帧只携 pairingId。Windows 保留「pairingId 活性复核 + Token 签发 +
 * token_hash 落库」三权（G4 裁决）：本函数按 pairingId 定位活跃码复核活性后签发，
 * 语义与 claimPairingCode 同源（一次性/审计/L3 pairDevice），仅省去码比对步
 * （ECS 已完成）。claim 限流在 ECS 面（5 次/5min），本函数不计 Windows 窗口。
 */
export function claimPairingByRelayId(input: { pairingId: string; deviceName: string; platform: string }): PairingClaimResult {
  if (!isGatewayEnabled()) {
    throw new ServiceError('GATEWAY_DISABLED', 'pairing: remote gateway is disabled (settings gateway_enabled = 0); enable the gateway first')
  }
  const pairing = activePairing
  if (pairing === null || input.pairingId !== pairing.pairingId) {
    rejectInvalidCode('relay pairing claim: no active pairing code for this pairingId (issue a new code on the desktop first)')
  }
  if (pairing.consumed) {
    rejectInvalidCode('relay pairing claim: pairing code already consumed (one-time, docs/15 §2)')
  }
  if (nowMs() / 1000 > pairing.expiresAt) {
    voidActivePairing('expired')
    rejectInvalidCode('relay pairing claim: pairing code expired (TTL 300s)')
  }
  // 成功：码即失效（一次性）→ 设备行 + 审计；Token 明文仅经 pair_accepted 帧一次性过境
  pairing.consumed = true
  activePairing = null
  const token = generateDeviceToken()
  const paired = pairDevice({ deviceName: input.deviceName, platform: input.platform, tokenHash: sha256Hex(token) })
  recordSecurityAudit('pairing', 'pairing_claimed', paired.deviceId, 'success', JSON.stringify({ pairingId: pairing.pairingId, source: 'relay' }))
  return { deviceId: paired.deviceId, token, tokenVersion: paired.tokenVersion, gatewayName: GATEWAY_NAME }
}

/** smoke/测试复位（内存态配对码；生产不调用——重启即等效复位）。 */
export function resetPairingState(): void {
  activePairing = null
}
