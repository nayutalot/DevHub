/**
 * commandDownlink.ts — 命令下行桥（M2-R1 模块 5/8，docs/19 §4.4）。
 *
 * 流水（docs/19 §4.4 逐行；执行入口 = L3 submitRemoteCommand，与 Gateway REST
 * 同一底层，docs/18 §9.2 时序）：
 *   1) auth 校验：gateway/auth.ts 同源函数（authenticateBearerToken：sha256 +
 *      timingSafeEqual + 撤销即拒）+ checkReplayHeaders（±300s 窗口 / nonce LRU
 *      10min，docs/14 §B.4 同参——帧内 auth{ts,nonce} 即 X-DevHub-* 语义）。
 *      失败 → error{AUTH_INVALID_TOKEN|AUTH_REPLAYED|DEVICE_REVOKED}（不触达 L3）。
 *   2) action 翻译：send_message→reply（≡ 改名映射，docs/18 §5.1）；pause/resume
 *      原样；approve/interrupt → 结构化拒绝 AGENT_CAPABILITY_MISSING（G6 默认
 *      恒不授予，docs/19 §6.1——能力验证函数骨架属后续批次）；未知值 → 拒绝
 *      BAD_PAYLOAD。
 *   3) 执行：submitRemoteCommand（能力门二次校验 resolveCommandGate + 幂等 +
 *      TTL 300s + 审计全部在 L3，绝不复刻）；本地 Gateway 未启用 → GATEWAY_DISABLED
 *      （docs/19 §4.8 relay 模式前提）。
 *   4) 回帧：受理 → command_ack{accepted|rejected, errorCode}（docs/18 §3.9）；
 *      终态 → command_result（docs/18 §3.10；与 command.result 事件双通道，
 *      Android 按 commandId 去重）。同幂等键重试命中已终态命令 → ack + 原
 *      command_result 重放（L3 getRemoteCommandResultView，docs/14 §B.5 语义）。
 *
 * 幂等键在调用 submitRemoteCommand **之前**登记（终态监听按 idempotencyKey 路由）：
 * executeRemoteCommand 的终态通知是 submitRemoteCommand 返回前已排队的微任务，
 * 若在返回后才登记会漏掉同步完成的指令（fixture provider 即此形态）。
 *
 * electron-free；零直接写库（L3 submitRemoteCommand / getRemoteCommandResultView
 * 只读豁免；gateway/auth 读豁免——约束 #20）。
 */

import { isGatewayEnabled, submitRemoteCommand, getRemoteCommandResultView, setRemoteCommandCompleteListener, type RemoteCommandTerminalEvent } from '../agentControlService.ts'
import { authenticateBearerToken, checkReplayHeaders } from '../gateway/auth.ts'
import type { HostToEcsFrame } from './wsClient.ts'

// ---------------------------------------------------------------------------
// 回帧宿主（relayClient/index.ts 注入；smoke 以捕获数组注入）
// ---------------------------------------------------------------------------

/** 命令下行宿主接口（H→E 帧出口）。 */
export interface CommandDownlinkHost {
  /** 发送 command_ack 帧（受理/拒绝回执）。 */
  sendAck(frame: HostToEcsFrame): boolean
  /** 发送 command_result 帧（终态回执）。 */
  sendResult(frame: HostToEcsFrame): boolean
  /** 发送 error 帧（auth 失败等不触达 L3 的错误，docs/19 §4.4）。 */
  sendError(frame: HostToEcsFrame): boolean
}

// ---------------------------------------------------------------------------
// action 翻译（docs/18 §5.1 映射表；集中一处防漂移）
// ---------------------------------------------------------------------------

/** Relay action → 内部 AgentCapability（docs/18 §5.1：send_message ≡ reply）。 */
export function relayActionToInternal(action: string): 'reply' | 'pause' | 'resume' | null {
  if (action === 'send_message') return 'reply'
  if (action === 'pause') return 'pause'
  if (action === 'resume') return 'resume'
  return null
}

/** 内部 action → Relay action（command_result 帧回投影；command_result 帧形用 Relay 名）。 */
export function internalActionToRelay(action: string): string {
  if (action === 'reply') return 'send_message'
  return action
}

/** approve/interrupt：协议帧面接收，执行面恒结构化拒绝（docs/19 §6.1 默认态）。 */
const NEVER_GRANTED_ACTIONS: readonly string[] = ['approve', 'interrupt']

/** reply 文本上限（docs/14 §A.1 #6 同源 ≤4000；commandDownlink 复刻同一校验值）。 */
export const RELAY_REPLY_TEXT_MAX_CHARS = 4000

// ---------------------------------------------------------------------------
// 下行处理（帧路由入口；单帧异常绝不杀伤连接——调用方逐帧隔离）
// ---------------------------------------------------------------------------

/** 终态待路由表容量上限（防内存放大；极端积压下最旧键让位——设备重试幂等兜底）。 */
const PENDING_KEYS_MAX = 1_000

interface PendingKeyRoute {
  /** 终态 command_result 帧的 action 用 Relay 名。 */
  relayAction: string
}

/** 幂等键 → 终态路由（提交前登记；终态后删除）。 */
const pendingKeys = new Map<string, PendingKeyRoute>()

/** 宿主接线（setCommandDownlinkHost 幂等覆盖；smoke 重置用 clearCommandDownlinkState）。 */
let downlinkHost: CommandDownlinkHost | null = null

/** smoke/测试复位（进程内多次隔离场景；生产不调用）。 */
export function clearCommandDownlinkState(): void {
  pendingKeys.clear()
  downlinkHost = null
  setRemoteCommandCompleteListener(null)
}

/**
 * 接线（relayClient/index.ts start 路径）：宿主注入 + L3 终态监听注册。
 * 监听按 idempotencyKey 过滤（只有经 relay 下达的指令在 pendingKeys 中——
 * Gateway/IPC 来源指令的终态由 command.result 事件承载，不在 relay 面回帧，
 * agentControlService 缝注释同口径）。
 */
export function setCommandDownlinkHost(host: CommandDownlinkHost): void {
  downlinkHost = host
  setRemoteCommandCompleteListener(onRemoteCommandTerminal)
}

/** L3 终态监听（command_result 回帧；异常绝不影响 L3 状态机——notify 侧已隔离）。 */
function onRemoteCommandTerminal(event: RemoteCommandTerminalEvent): void {
  if (downlinkHost === null) return
  const route = pendingKeys.get(event.idempotencyKey)
  if (route === undefined) return
  pendingKeys.delete(event.idempotencyKey)
  downlinkHost.sendResult({
    type: 'command_result',
    commandId: event.commandId,
    idempotencyKey: event.idempotencyKey,
    ...(event.sessionId > 0 ? { sessionId: event.sessionId } : {}),
    action: internalActionToRelay(event.action),
    status: event.status,
    errorCode: event.errorCode,
    timestamp: Math.floor(Date.now() / 1000),
  })
}

/** 结构校验失败的 error 帧（协议级；BAD_PAYLOAD——docs/18 §3.16）。 */
function badPayloadError(requestId: unknown, message: string): HostToEcsFrame {
  return {
    type: 'error',
    ...(typeof requestId === 'string' && requestId.length > 0 ? { requestId } : {}),
    code: 'BAD_PAYLOAD',
    message,
  }
}

/**
 * command 帧处理（E→H；docs/18 §3.8 D→E 原样中继形态）。绝不抛：所有失败
 * 折叠为 error / command_ack 帧回执（业务级错误不断连，docs/18 §3.16）。
 */
export function handleCommandFrame(frame: unknown, host: CommandDownlinkHost): void {
  if (!isObject(frame)) return
  const requestId = (frame as { requestId?: unknown }).requestId
  // 1) 结构校验（协议级）——字段缺失/类型错 → error BAD_PAYLOAD
  const idempotencyKey = (frame as { idempotencyKey?: unknown }).idempotencyKey
  const sessionId = (frame as { sessionId?: unknown }).sessionId
  const action = (frame as { action?: unknown }).action
  const auth = (frame as { auth?: unknown }).auth
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
    host.sendError(badPayloadError(requestId, 'command.idempotencyKey must be a non-empty string (docs/18 §3.8)'))
    return
  }
  if (typeof sessionId !== 'number' || !Number.isSafeInteger(sessionId) || sessionId <= 0) {
    host.sendError(badPayloadError(requestId, 'command.sessionId must be a positive integer (docs/18 §3.8)'))
    return
  }
  if (typeof action !== 'string' || action.length === 0) {
    host.sendError(badPayloadError(requestId, 'command.action must be a non-empty string (docs/18 §3.8)'))
    return
  }
  if (!isObject(auth)) {
    host.sendError(badPayloadError(requestId, 'command.auth {token, ts, nonce} is required (docs/18 §3.8)'))
    return
  }
  const token = (auth as { token?: unknown }).token
  const ts = (auth as { ts?: unknown }).ts
  const nonce = (auth as { nonce?: unknown }).nonce
  if (typeof token !== 'string' || token.length === 0 || typeof ts !== 'number' || typeof nonce !== 'string') {
    host.sendError(badPayloadError(requestId, 'command.auth fields token/ts/nonce are malformed (docs/18 §3.8)'))
    return
  }
  const payload = (frame as { payload?: unknown }).payload

  // 2) auth 校验（docs/19 §4.4 第 1 步；失败 → error 帧，不触达 L3）
  let authedDeviceId: number
  try {
    const authed = authenticateBearerToken(token)
    authedDeviceId = authed.id
    // ts/nonce 防重放（gateway/auth.ts 同源：±300s 窗口 + nonce LRU 10min；
    // auth.ts 数字时间戳 → String 形态复用同一校验函数，docs/19 §4.4「同参」）
    checkReplayHeaders({ timestamp: String(ts), nonce }, Date.now())
  } catch (err) {
    const code = err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : 'INTERNAL'
    host.sendError({
      type: 'error',
      ...(typeof requestId === 'string' && requestId.length > 0 ? { requestId } : {}),
      code,
      message: err instanceof Error ? err.message : 'command authentication failed',
    })
    return
  }

  const reject = (errorCode: string, commandId?: string): void => {
    host.sendAck({
      type: 'command_ack',
      ...(typeof requestId === 'string' && requestId.length > 0 ? { requestId } : {}),
      idempotencyKey,
      ...(commandId !== undefined ? { commandId } : {}),
      status: 'rejected',
      errorCode,
    })
  }

  // 3) 本地 Gateway 前提（docs/19 §4.4/§4.8：relay 模式要求 gateway_enabled=1）
  if (!isGatewayEnabled()) {
    reject('GATEWAY_DISABLED')
    return
  }

  // 4) action 翻译（docs/18 §5.1）+ 门控拒绝
  if ((NEVER_GRANTED_ACTIONS as readonly string[]).includes(action)) {
    // G6：approve/interrupt 默认恒不授予（docs/19 §6.1）；结构化拒绝，绝不触达 L3
    reject('AGENT_CAPABILITY_MISSING')
    return
  }
  const internalAction = relayActionToInternal(action)
  if (internalAction === null) {
    reject('BAD_PAYLOAD')
    return
  }
  let text: string | undefined
  if (internalAction === 'reply') {
    // 载荷校验（docs/14 §A.1 #6 同源：send_message 必带非空 ≤4000 文本；
    // D4 选型注记：handler 层载荷校验在 commandDownlink 复刻同一校验值）
    const raw = isObject(payload) ? (payload as { text?: unknown }).text : undefined
    if (typeof raw !== 'string' || raw.trim().length === 0 || raw.length > RELAY_REPLY_TEXT_MAX_CHARS) {
      reject('BAD_PAYLOAD')
      return
    }
    text = raw
  }

  // 5) 终态路由登记（先于 submitRemoteCommand——见文件头时序注记）
  if (!pendingKeys.has(idempotencyKey)) {
    while (pendingKeys.size >= PENDING_KEYS_MAX) {
      const oldest = pendingKeys.keys().next()
      if (oldest.done === true) break
      pendingKeys.delete(oldest.value)
    }
  }
  pendingKeys.set(idempotencyKey, { relayAction: action })

  // 6) 执行（L3 submitRemoteCommand：能力门二次校验 + 幂等 + TTL + 审计）
  void submitRemoteCommand({
    deviceId: authedDeviceId,
    sessionId,
    action: internalAction,
    ...(text !== undefined ? { text } : {}),
    idempotencyKey,
  })
    .then((accepted) => {
      if (accepted.status === 'accepted') return // 终态稍后经监听回流
      // 幂等重试命中已终态命令：回执原结果（docs/14 §B.5「同 key 重试返回原结果」）
      pendingKeys.delete(idempotencyKey)
      const prior = getRemoteCommandResultView(accepted.commandId)
      if (prior !== null) {
        host.sendResult({
          type: 'command_result',
          commandId: prior.commandId,
          idempotencyKey: prior.idempotencyKey,
          ...(prior.sessionId > 0 ? { sessionId: prior.sessionId } : {}),
          action: internalActionToRelay(prior.action),
          status: prior.status,
          errorCode: prior.errorCode,
          timestamp: Math.floor(Date.now() / 1000),
        })
      }
      host.sendAck({
        type: 'command_ack',
        ...(typeof requestId === 'string' && requestId.length > 0 ? { requestId } : {}),
        idempotencyKey,
        commandId: accepted.commandId,
        status: accepted.status === 'rejected' ? 'rejected' : 'accepted',
        ...(prior?.errorCode !== undefined && prior.errorCode !== null && accepted.status === 'rejected'
          ? { errorCode: prior.errorCode }
          : {}),
      })
    })
    .catch((err: unknown) => {
      // 业务级拒绝（NOT_FOUND/BAD_PAYLOAD/COMMAND_EXPIRED/COMMAND_KEY_CONFLICT/
      // AGENT_CAPABILITY_MISSING/…）→ command_ack rejected（docs/18 §3.9 形态）
      pendingKeys.delete(idempotencyKey)
      const code = err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : 'INTERNAL'
      reject(code)
    })
}

/** 窄化助手（frame 形态校验专用）。 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
