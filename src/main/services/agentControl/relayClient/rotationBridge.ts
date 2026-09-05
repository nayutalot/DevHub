/**
 * rotationBridge.ts — Token 轮换桥（M2-R1 模块 7/8，docs/18 §3.14 + §9.4 + docs/19 §4.6）。
 *
 * docs/18 §3.14 全流程的 Windows 侧编排（L3 落点 = agentControlService.rotateDeviceToken，
 * 基线批已落：新 Token 生成 + sha256 覆盖 token_hash + token_version+1 + 审计
 * device/token_rotated，schema 现字段承载零 migration）。本模块补齐桥面三件事：
 *
 * 1. **帧发送**（H→E token_rotation，R2 裁定②必携 deviceId = Windows 侧
 *    remote_devices.id）：`newToken` 明文一次性过境（红线受控面 docs/19 §3 W-R3，
 *    与 pair_accepted.deviceToken 同一面）——绝不入日志/审计/DB/settings。
 * 2. **两平面同步前置门**：ECS 注册表以收帧同步 sha256(newToken)（docs/18 §3.14
 *    「ECS 转发同时更新注册表」行）——离线时 L3 落库会让两平面哈希永久分叉（Windows
 *    单哈希列无回滚位），因此 **host 腿非 ready → 拒绝轮换且不触达 L3**（结构化
 *    stage:'offline'，零副作用；manual/periodic 触发方稍后重试即可）。
 * 3. **宽限跟踪**（docs/18 §3.14「宽限 300s」行的 Windows 侧半边）：帧发出起 300s
 *    确认窗口——确认信道 = E→H heartbeat 兼容携带的 tokenVersion（docs/18 §3.13
 *    「tokenVersion 兼作轮换确认信道」；fixture 未冻结该字段，本桥只按显式字段
 *    容错消费，绝不猜）；确认 → 审计 token_rotation_confirmed；窗口过期未确认 →
 *    维持新 Token 生效（无回滚位），设备将 401 → 重配对路径（docs/15 §3 等价语义），
 *    审计 token_rotation_grace_expired（docs/18 §3.14「该结果审计落库（Windows 与
 *    ECS 双侧 device 类目）」的 Windows 半边）。发送写失败（两平面已分叉、不可回滚）
 *    → 审计 token_rotation_dispatch_failed（error）。
 *
 * electron-free；审计经 L3 recordSecurityAudit（约束 #20）；定时器仅窗口跟踪
 * （clearRotationBridgeState 全清，进程退出零悬挂）。
 */

import { randomUUID } from 'node:crypto'
import { rotateDeviceToken, recordSecurityAudit, type DeviceTokenRotationReason } from '../agentControlService.ts'
import type { HostToEcsFrame } from './wsClient.ts'

// ---------------------------------------------------------------------------
// 宿主接口（relayClient/index.ts 注入；smoke 以捕获数组注入）
// ---------------------------------------------------------------------------

/** 轮换桥宿主接口（ready 门 + H→E 帧出口）。 */
export interface RotationBridgeHost {
  /** host 腿就绪（hello 已收且恢复序完成）才允许轮换——两平面凭据同步前置门。 */
  isReady(): boolean
  /** 发送 token_rotation 帧（写 socket 未抛 = 已交 ECS）。 */
  sendTokenRotation(frame: HostToEcsFrame): boolean
}

/** 宽限确认窗口（docs/18 §3.14 权威值 300s；setRotationGraceWindowMs 仅供 smoke）。 */
export const ROTATION_GRACE_WINDOW_SEC = 300

let bridgeHost: RotationBridgeHost | null = null
/** 窗口毫秒（生产 = ROTATION_GRACE_WINDOW_SEC*1000；smoke 注入短窗）。 */
let graceWindowMs = ROTATION_GRACE_WINDOW_SEC * 1000

/** 待确认轮换（deviceId → 跟踪行；确认/过期即出清）。 */
interface PendingRotation {
  tokenVersion: number
  requestId: string
  dispatchedAtMs: number
  timer: NodeJS.Timeout
}

const pendingRotations = new Map<number, PendingRotation>()

/** 轮换触发结果（结构化；绝不携带 Token 明文）。 */
export interface RotationDispatchResult {
  dispatched: boolean
  /** offline = 非 ready 拒绝（L3 零触达）；refused = L3 结构化拒绝（NOT_FOUND/DEVICE_REVOKED）；
   *  send-failed = 帧写失败（L3 已落库，两平面分叉已审计）；dispatched = 已交 ECS。 */
  stage: 'dispatched' | 'offline' | 'refused' | 'send-failed'
  tokenVersion?: number
  requestId?: string
  errorCode?: string
}

/** 宿主接线（relayClient/index.ts start 路径；幂等覆盖）。 */
export function setRotationBridgeHost(host: RotationBridgeHost): void {
  bridgeHost = host
}

/** 宽限窗口注入（smoke/测试缝；生产不调用——docs/18 §3.14 权威 300s 不变）。 */
export function setRotationGraceWindowMs(ms: number): void {
  if (Number.isSafeInteger(ms) && ms > 0) {
    graceWindowMs = ms
  }
}

/** smoke/测试复位（清宿主 + 待确认表 + 全部窗口 timer；生产不调用）。 */
export function clearRotationBridgeState(): void {
  bridgeHost = null
  for (const pending of pendingRotations.values()) {
    clearTimeout(pending.timer)
  }
  pendingRotations.clear()
  graceWindowMs = ROTATION_GRACE_WINDOW_SEC * 1000
}

/** 待确认轮换数（smoke/诊断；零凭据）。 */
export function pendingRotationCount(): number {
  return pendingRotations.size
}

/** 指定设备的待确认 tokenVersion（无 → null）。 */
export function getPendingRotationVersion(deviceId: number): number | null {
  const pending = pendingRotations.get(deviceId)
  return pending === undefined ? null : pending.tokenVersion
}

// ---------------------------------------------------------------------------
// 轮换触发（全流程：ready 门 → L3 落库 → 帧发送 → 宽限登记）
// ---------------------------------------------------------------------------

/**
 * Token 轮换全流程（docs/18 §3.14 / §9.4；触发源：pairingBridge 设备配对回调 →
 * 'post-pairing'（docs/19 §4.5/§3.2 缓解 b）；manual = 用户触发；periodic = 周期
 * backlog（触发器属后续批次，reason 值本桥已承载））。绝不抛——结构化结果。
 */
export function requestTokenRotation(deviceId: number, reason: DeviceTokenRotationReason): RotationDispatchResult {
  if (bridgeHost === null || !bridgeHost.isReady()) {
    // 两平面凭据同步只能在连接面进行：离线轮换会让 ECS 注册表滞留旧哈希 → 设备
    // 经 ECS 全 401。拒绝且零副作用（L3 不触达），触发方稍后重试。
    return { dispatched: false, stage: 'offline' }
  }
  let rotated: { deviceId: number; tokenVersion: number; token: string }
  try {
    rotated = rotateDeviceToken(deviceId, reason)
  } catch (err) {
    // NOT_FOUND / DEVICE_REVOKED（撤销即拒，docs/15 §4）等 L3 结构化拒绝：零落库零帧
    const code = err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : 'INTERNAL'
    return { dispatched: false, stage: 'refused', errorCode: code }
  }
  const requestId = randomUUID()
  const sent = bridgeHost.sendTokenRotation({
    type: 'token_rotation',
    requestId,
    deviceId: rotated.deviceId,
    newToken: rotated.token,
    tokenVersion: rotated.tokenVersion,
    reason,
  })
  if (!sent) {
    // 写失败 = ECS 永不知新哈希（Windows 已落库、单哈希列无回滚位）：设备经 ECS
    // 401 → 重配对路径（docs/18 §3.14 轮换失败面语义）；审计留痕，绝不回滚。
    recordSecurityAudit(
      'device',
      'token_rotation_dispatch_failed',
      rotated.deviceId,
      'error',
      JSON.stringify({ reason, tokenVersion: rotated.tokenVersion, stage: 'send-failed' }),
    )
    return { dispatched: false, stage: 'send-failed', tokenVersion: rotated.tokenVersion, requestId }
  }
  scheduleGraceWindow(rotated.deviceId, rotated.tokenVersion, requestId)
  return { dispatched: true, stage: 'dispatched', tokenVersion: rotated.tokenVersion, requestId }
}

/** 窗口登记（300s 确认跟踪；timer 只做审计出清，绝不改动凭据状态）。 */
function scheduleGraceWindow(deviceId: number, tokenVersion: number, requestId: string): void {
  const prior = pendingRotations.get(deviceId)
  if (prior !== undefined) {
    clearTimeout(prior.timer) // 同设备新轮换覆盖旧窗口（版本单调，旧窗口作废）
  }
  const timer = setTimeout(() => {
    const pending = pendingRotations.get(deviceId)
    if (pending === undefined || pending.tokenVersion !== tokenVersion) return
    pendingRotations.delete(deviceId)
    // docs/18 §3.14：确认超时未观察到新 tokenVersion → 维持新 Token 生效（Windows
    // 单哈希列无回滚位），设备将 401 → 重配对路径；结果审计落库（Windows 半边）。
    recordSecurityAudit(
      'device',
      'token_rotation_grace_expired',
      deviceId,
      'success',
      JSON.stringify({
        tokenVersion,
        windowSec: ROTATION_GRACE_WINDOW_SEC,
        note: 'confirm window elapsed without observed tokenVersion; new token stays effective, device re-pairing path (docs/18 §3.14)',
      }),
    )
  }, graceWindowMs)
  pendingRotations.set(deviceId, { tokenVersion, requestId, dispatchedAtMs: Date.now(), timer })
}

// ---------------------------------------------------------------------------
// 确认信道（E→H heartbeat 兼容携带 tokenVersion；docs/18 §3.13）
// ---------------------------------------------------------------------------

/**
 * 轮换确认（relayClient/index.ts heartbeat 路由消费）。fixture 未冻结 E→H heartbeat
 * 的 tokenVersion 字段——只按**显式数值字段**容错消费（绝不猜语义）：
 * tokenVersion 与某待确认轮换一致 → 出清窗口 + 审计 token_rotation_confirmed。
 * 无待确认/版本不符 → false（合法 no-op：多设备各轮换各确认，绝不张冠李戴）。
 */
export function noteTokenRotationConfirmed(tokenVersion: number): boolean {
  if (!Number.isSafeInteger(tokenVersion) || tokenVersion <= 0) return false
  for (const [deviceId, pending] of pendingRotations) {
    if (pending.tokenVersion !== tokenVersion) continue
    clearTimeout(pending.timer)
    pendingRotations.delete(deviceId)
    recordSecurityAudit(
      'device',
      'token_rotation_confirmed',
      deviceId,
      'success',
      JSON.stringify({ tokenVersion, confirmedAfterMs: Date.now() - pending.dispatchedAtMs }),
    )
    return true
  }
  return false
}
