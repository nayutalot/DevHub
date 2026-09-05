/**
 * pairingBridge.ts — 配对桥（M2-R1 模块 6/8，docs/19 §4.5 + docs/18 §3.2/§3.3）。
 *
 * 两个方向：
 * 1. 签发同步（H→E 控制帧 register_pairing，16 帧之外的 host 腿控制面，fixture
 *    meta.conventions.hostControlFrames）：L3 createPairing 成功签发后（注入缝
 *    setPairingIssuedListener）→ {pairingId, codeHash=sha256(code), expiresAt}
 *    同步 ECS 落 pairing_codes（审计 pairing_code_registered）。code 明文在现场
 *    哈希后即刻丢弃——绝不出现在帧、日志、审计（docs/15 §2 红线）。relay 离线
 *    时跳过同步：配对退化为本地模式专用（docs/19 §4.5），签发本身不受影响。
 * 2. pair / pair_accepted（docs/18 §3.2/§3.3）：E→H pair 帧（ECS 已完成码校验，
 *    无 code 字段）→ L3 claimPairingByRelayId 复核 pairingId 活性 + Token 签发 +
 *    remote_devices 落库（G4 裁决三权在 Windows）→ pair_accepted{deviceToken}
 *    一次性过境（红线受控面，docs/19 §3 W-R3）→ 设备映射回调（ecsDeviceId →
 *    Windows deviceId，sync_request ACK 路由数据源）→ post-pairing 轮换回调
 *    （rotationBridge，docs/19 §4.5 / §3.2 缓解 b）。
 *
 * electron-free；写库全部经 L3（gateway/pairing.claimPairingByRelayId →
 * pairDevice / recordSecurityAudit，约束 #20）。
 */

import { randomUUID } from 'node:crypto'
import { claimPairingByRelayId } from '../gateway/pairing.ts'
import { sha256Hex } from '../gateway/auth.ts'
import type { HostToEcsFrame } from './wsClient.ts'

// ---------------------------------------------------------------------------
// 宿主与回调（relayClient/index.ts 注入；smoke 以捕获数组注入）
// ---------------------------------------------------------------------------

/** 配对桥宿主接口（H→E 帧出口）。 */
export interface PairingBridgeHost {
  /** 发送 register_pairing 帧（签发同步）。 */
  sendRegisterPairing(frame: HostToEcsFrame): boolean
  /** 发送 pair_accepted 帧（配对成功，Token 一次性过境）。 */
  sendPairAccepted(frame: HostToEcsFrame): boolean
  /** 发送 error 帧（复核失败路径，docs/18 §3.3 失败 → error{requestId, code}）。 */
  sendError(frame: HostToEcsFrame): boolean
}

/** 设备配对回调（ecsDeviceId = ECS 注册表 id；winDeviceId = remote_devices.id）。 */
export type DevicePairedCallback = (ecsDeviceId: number, winDeviceId: number) => void

let bridgeHost: PairingBridgeHost | null = null
let devicePairedCallback: DevicePairedCallback | null = null

/** 已发出的 register_pairing 请求（requestId → pairingId；ack 关联 + 诊断）。 */
const pendingRegisterRequests = new Map<string, string>()

/** 最近一次 register_pairing_ack（诊断投影；零凭据——无码哈希）。 */
export interface RegisterPairingAckView {
  pairingId: string
  accepted: boolean
  expiresAt: number
}

let lastRegisterAck: RegisterPairingAckView | null = null

/** 最近一次 register_pairing_ack（smoke/诊断只读；未收到过 → null）。 */
export function getLastRegisterPairingAck(): RegisterPairingAckView | null {
  return lastRegisterAck
}

/** smoke/测试复位（进程内多次隔离场景；生产不调用）。 */
export function clearPairingBridgeState(): void {
  bridgeHost = null
  devicePairedCallback = null
  pendingRegisterRequests.clear()
  lastRegisterAck = null
}

/** 接线（relayClient/index.ts start 路径；幂等覆盖）。 */
export function setPairingBridgeHost(host: PairingBridgeHost, onDevicePaired: DevicePairedCallback): void {
  bridgeHost = host
  devicePairedCallback = onDevicePaired
}

// ---------------------------------------------------------------------------
// 方向一：签发同步（L3 createPairing 注入缝 → register_pairing）
// ---------------------------------------------------------------------------

/** 签发同步输入（agentControlService PairingIssuedEvent 同构）。 */
export interface PairingIssuedInput {
  pairingId: string
  /** 8 位 Crockford Base32 明文（现场哈希后即刻丢弃，绝不出帧/落盘）。 */
  code: string
  expiresAt: number
}

/**
 * 签发同步（agentControlService.createPairing 注入缝调用）。relay 离线（host 缺席）
 * → false（本地模式专用退化，docs/19 §4.5）；在线 → register_pairing 帧发送结果。
 * pending 登记发生在发送前（ack 即刻回帧的时序安全）。
 */
export function handlePairingIssued(pairing: PairingIssuedInput): boolean {
  if (bridgeHost === null) return false
  const requestId = randomUUID()
  const codeHash = sha256Hex(pairing.code)
  pendingRegisterRequests.set(requestId, pairing.pairingId)
  while (pendingRegisterRequests.size > 100) {
    const oldest = pendingRegisterRequests.keys().next()
    if (oldest.done === true) break
    pendingRegisterRequests.delete(oldest.value)
  }
  return bridgeHost.sendRegisterPairing({
    type: 'register_pairing',
    requestId,
    pairingId: pairing.pairingId,
    codeHash,
    expiresAt: pairing.expiresAt,
  })
}

/**
 * register_pairing_ack（E→H；fixture hostControlFrames 形态）。requestId 关联 +
 * 诊断记录（零凭据）；未知 requestId → 忽略（绝不猜语义）。
 */
export function handleRegisterPairingAck(frame: unknown): void {
  if (typeof frame !== 'object' || frame === null) return
  const f = frame as { requestId?: unknown; pairingId?: unknown; accepted?: unknown; expiresAt?: unknown }
  if (typeof f.requestId !== 'string' || !pendingRegisterRequests.has(f.requestId)) return
  pendingRegisterRequests.delete(f.requestId)
  if (typeof f.pairingId !== 'string' || typeof f.accepted !== 'boolean' || typeof f.expiresAt !== 'number') return
  lastRegisterAck = { pairingId: f.pairingId, accepted: f.accepted, expiresAt: f.expiresAt }
}

// ---------------------------------------------------------------------------
// 方向二：pair / pair_accepted（docs/18 §3.2 E→H 中继形态 → §3.3 H→E）
// ---------------------------------------------------------------------------

/**
 * pair 帧处理（ECS 已完成码校验的中继帧）。流程：结构校验 → platform 强制 android
 * （docs/18 §3.2，与现 pairing.ts 一致）→ L3 claimPairingByRelayId（pairingId 活性
 * 复核 + 256-bit Token 签发 + remote_devices 落库 + 审计）→ pair_accepted{deviceToken}
 * → 设备映射回调 + post-pairing 轮换回调。失败 → error{requestId, code}（docs/18
 * §3.3 失败路径），绝不抛。
 */
export function handlePairFrame(frame: unknown, host: PairingBridgeHost): void {
  if (typeof frame !== 'object' || frame === null) return
  const f = frame as { requestId?: unknown; ecsDeviceId?: unknown; pairingId?: unknown; deviceName?: unknown; platform?: unknown }
  if (typeof f.requestId !== 'string' || f.requestId.length === 0) return
  const fail = (code: string, message: string): void => {
    host.sendError({ type: 'error', requestId: f.requestId as string, code, message })
  }
  if (typeof f.ecsDeviceId !== 'number' || !Number.isSafeInteger(f.ecsDeviceId) || f.ecsDeviceId <= 0) {
    fail('BAD_PAYLOAD', 'pair.ecsDeviceId must be a positive integer (docs/18 §3.2)')
    return
  }
  if (typeof f.pairingId !== 'string' || f.pairingId.length === 0) {
    fail('BAD_PAYLOAD', 'pair.pairingId must be a non-empty string (docs/18 §3.2)')
    return
  }
  if (typeof f.deviceName !== 'string' || f.deviceName.trim().length === 0) {
    fail('BAD_PAYLOAD', 'pair.deviceName must be a non-empty string (docs/18 §3.2)')
    return
  }
  if (f.platform !== 'android') {
    fail('BAD_PAYLOAD', 'pair.platform must be "android" (docs/18 §3.2, 强制 android)')
    return
  }
  try {
    const claimed = claimPairingByRelayId({
      pairingId: f.pairingId,
      deviceName: f.deviceName,
      platform: f.platform,
    })
    const sent = host.sendPairAccepted({
      type: 'pair_accepted',
      requestId: f.requestId,
      ecsDeviceId: f.ecsDeviceId,
      device: {
        deviceId: claimed.deviceId,
        deviceName: f.deviceName.trim().slice(0, 100),
        platform: f.platform,
        tokenVersion: claimed.tokenVersion,
      },
      deviceToken: claimed.token,
      gatewayName: claimed.gatewayName,
    })
    if (!sent) {
      // 写 socket 失败 = 设备拿不到 Token：一次性码已核销，设备重试 pair 会因
      // 码已消费被拒 → 重新签发码（与 claim 后连接中断的本地模式语义一致）
      return
    }
    // 设备映射（sync_request ACK 路由数据源）+ post-pairing 轮换（docs/19 §4.5）；
    // 回调异常不影响 pair_accepted 结果（轮换失败有独立审计路径）
    if (devicePairedCallback !== null) {
      try {
        devicePairedCallback(f.ecsDeviceId, claimed.deviceId)
      } catch {
        /* 回调异常不影响配对结果 */
      }
    }
  } catch (err) {
    const code = err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : 'INTERNAL'
    fail(code, err instanceof Error ? err.message : 'relay pairing claim failed')
  }
}
