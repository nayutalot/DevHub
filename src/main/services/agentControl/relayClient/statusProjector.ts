/**
 * statusProjector.ts — agents:gatewayStatus.relay 状态投影（M2-R1 模块 8/8，
 * docs/19 §4.7 + shared/types RelayStatusView）。
 *
 * 次级决策 D5（docs/19 §4.7）：不新增 IPC channel，gatewayStatus 响应**追加可选
 * 字段** `relay?`，白名单 70 条不动，向后兼容（disabled → 字段缺席 = 零噪声）。
 *
 * 数据源（两平面各自只读，静态 import 零环——本模块是 agentControlService 静态
 * 依赖的叶子，反向绝不回指）：
 * 1. settings/config 面：readRelayRegistrationState（relay_enabled/relay_endpoint/
 *    凭据文件存在性 → 结构化注册态，docs/19 §4.7「结构化而非错误」纪律）；
 * 2. 运行态面：relayClient/index.ts 状态机每次转换回报 setRelayRuntimeView
 *    （connected/hostId/lastError——与 gatewayRuntimeProbe 同款注入缝先例，
 *    本模块存内存镜像，绝不做 I/O）。
 *
 * 红线：凭据/注册码绝不入投影（docs/19 §2.2）；结构化告警（warning，非错误）：
 * relay 启用但本地 Gateway 未启用（docs/19 §4.8 表行——gateway_enabled 直读
 * settingsService，不 import agentControlService）+ 未注册/配置坏态（注册态原因）。
 */

import type { RelayStatusView } from '../../../../shared/types.ts'
import { getSetting } from '../../settingsService.ts'
import { readRelayRegistrationState } from './config.ts'

// ---------------------------------------------------------------------------
// 运行态镜像（relayClient/index.ts 状态机回报；smoke 可直接注入）
// ---------------------------------------------------------------------------

/** 运行态回报（index.ts 状态机每次转换调用；零凭据三字段）。 */
export interface RelayRuntimeView {
  /** hello 已收且恢复序完成（ready）= true。 */
  connected: boolean
  /** ECS relay_hosts.id（hello 帧回填；未连接缺席）。 */
  hostId?: number
  /** 最近一次连接失败的结构化原因（零凭据）。 */
  lastError?: string
}

let runtimeView: RelayRuntimeView | null = null

/** 运行态回报入口（index.ts 每状态转换调用；null = 复位投影到零连接）。 */
export function setRelayRuntimeView(view: RelayRuntimeView | null): void {
  runtimeView = view
}

/** 当前运行态镜像（smoke/诊断只读）。 */
export function getRelayRuntimeView(): RelayRuntimeView | null {
  return runtimeView
}

// ---------------------------------------------------------------------------
// 投影（docs/19 §4.7 可选字段；disabled → null = 字段缺席向后兼容）
// ---------------------------------------------------------------------------

/**
 * gatewayStatus.relay 投影：disabled → null（agentControlService.getGatewayStatus
 * 据此省略字段——零噪声向后兼容，AC2 形态逐字节不变）；enabled → 结构化真值
 * （connected/endpoint 运行态镜像 + hostId/lastError 透传 + warning 告警面）。
 */
export function projectRelayStatus(): RelayStatusView | null {
  const registration = readRelayRegistrationState()
  if (!registration.enabled) {
    return null
  }
  const warnings: string[] = []
  // docs/19 §4.8 表行：relay 模式要求 gateway_enabled=1；违反 → 结构化告警（非错误）
  if (getSetting('gateway_enabled') !== '1') {
    warnings.push('relay is enabled but the local gateway is disabled (relay mode requires gateway_enabled=1, docs/19 §4.8)')
  }
  if (registration.state === 'unregistered') {
    warnings.push('relay credential file missing (host unregistered; provision %LOCALAPPDATA%\\DevHub\\relay\\credential per docs/19 §2.2)')
  } else if (registration.state === 'misconfigured' && !registration.endpointOk) {
    warnings.push('relay endpoint invalid (wss required, cleartext ws:// is loopback-only, docs/18 §2)')
  }
  return {
    enabled: true,
    connected: runtimeView?.connected ?? false,
    endpoint: registration.endpoint,
    ...(runtimeView?.hostId !== undefined ? { hostId: runtimeView.hostId } : {}),
    ...(runtimeView?.lastError !== undefined && runtimeView.lastError.length > 0 ? { lastError: runtimeView.lastError } : {}),
    ...(warnings.length > 0 ? { warning: warnings.join('; ') } : {}),
  }
}
