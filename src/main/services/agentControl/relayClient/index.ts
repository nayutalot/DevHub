/**
 * index.ts — RelayClient 编排（M2-R1 模块 8/8，docs/19 §4.1/§4.2）。
 *
 * 状态机（docs/19 §4.2）：`disabled → connecting → ready`；`ready --断线--> 重连退避`
 * （1s→2s→…→60s 封顶 ±20% jitter，BackoffCalculator 移植自 Android core/Backoff.kt）。
 * config 结构化注册态（docs/19 §4.7）优先于连接：disabled / misconfigured /
 * unregistered 一律零连接（结构化投影而非错误）。
 *
 * 帧路由（docs/18 §3 host 腿）：hello（握手 + ECS 缓存水位）/ register_pairing_ack、
 * pair（pairingBridge）/ sync_request（累计 ACK → L3 markEventsAckedThrough，经
 * ecsDeviceId→winDeviceId 映射）/ heartbeat（E→H tokenVersion 容错确认信道 →
 * rotationBridge）/ error（结构化 lastError）/ disconnect（reason:revoked → 不得
 * 自动重连，docs/18 §3.15）。未知 type 静默忽略（绝不猜）。
 *
 * 三步恢复序（docs/19 §4.2，hello 后）：① 按 hello.sequence 回填 ECS 缺失事件
 * （eventUplink.backfillFromWatermark）；② ECS 排队命令按 requested_at 序在 ready
 * 后推送（host 侧零动作）；③ 实时推送（relay sink 已注册，ready 先置位防回填窗口
 * 内新事件丢失）。
 *
 * 生命周期：随 Main 进程（main/index.ts 启动 applyRelaySettings；settings:set
 * relay_enabled/relay_endpoint 翻转即时生效——applyGatewaySettings 同款先例；
 * shutdownAgentControlRuntime 收尾顺序追加 stopRelayClient，docs/12 §10 延伸）。
 * 撤销踢线注入（docs/18 §3.15/§9.5）：L3 revoke 路径 addDeviceRevokedListener →
 * disconnect{deviceId(Windows 侧), reason:'revoked'}。
 *
 * electron-free；写库只经 L3（markEventsAckedThrough / 各桥注入缝，约束 #20）。
 */

import { markEventsAckedThrough } from '../eventPipeline.ts'
import {
  addDeviceRevokedListener,
  clearExtraDeviceRevokedListeners,
  setPairingIssuedListener,
} from '../agentControlService.ts'
import { nowSec } from '../../internal.ts'
import {
  readRelayRegistrationState,
  loadRelayCredential,
  relayEndpointError,
} from './config.ts'
import {
  BACKOFF_BASE_DELAY_MS,
  BACKOFF_MAX_DELAY_MS,
  BackoffCalculator,
} from './backoff.ts'
import {
  openRelayConnection,
  type HostToEcsFrame,
  type RelayClientConnection,
  type RelayClientConnectionHooks,
} from './wsClient.ts'
import {
  backfillFromWatermark,
  clearEventUplinkHost,
  currentLastSentSeq,
  resetEventUplinkState,
  setEventUplinkHost,
} from './eventUplink.ts'
import {
  clearPairingBridgeState,
  handlePairFrame,
  handlePairingIssued,
  handleRegisterPairingAck,
  setPairingBridgeHost,
  type PairingBridgeHost,
} from './pairingBridge.ts'
import {
  clearRotationBridgeState,
  noteTokenRotationConfirmed,
  requestTokenRotation,
  setRotationBridgeHost,
} from './rotationBridge.ts'
import { clearCommandDownlinkState, setCommandDownlinkHost } from './commandDownlink.ts'
import { setRelayRuntimeView } from './statusProjector.ts'

// ---------------------------------------------------------------------------
// 状态机（docs/19 §4.2 + config 结构化注册态）
// ---------------------------------------------------------------------------

/** RelayClient 运行态全集：disabled/misconfigured/unregistered = 零连接结构化投影。 */
export type RelayClientStatus =
  | 'disabled'
  | 'misconfigured'
  | 'unregistered'
  | 'connecting'
  | 'ready'
  | 'waiting-retry'
  | 'stopped'

// 显式字段赋值 + 模块级单例（与 gateway/httpServer runtime 同款组织）
let status: RelayClientStatus = 'stopped'
let connection: RelayClientConnection | null = null
let hostId: number | null = null
let lastError: string | null = null
/** 连接代数：stop/重触发后旧异步流（openRelayConnection/hello 等待）全部失效。 */
let generation = 0
let reconnectTimer: NodeJS.Timeout | null = null
let heartbeatTimer: NodeJS.Timeout | null = null
let heartbeatIntervalMs = 30_000
let helloWaiter: ((hello: { sequence: number; heartbeatSec: number } | null) => void) | null = null
let helloTimer: NodeJS.Timeout | null = null
/** ecsDeviceId（ECS 注册表 id）→ winDeviceId（remote_devices.id）；pair 流建立，进程内存。 */
const deviceMappings = new Map<number, number>()
/** 配对桥宿主（wireSeams 构建；pair 帧路由复用同一实例）。 */
let pairingHost: PairingBridgeHost | null = null
let backoff = new BackoffCalculator()
let seamsWired = false

/** 时序参数（生产默认；configureRelayClientRuntime 供 smoke/测试注入短窗）。 */
const runtimeTimings = {
  helloTimeoutMs: 10_000,
  pongTimeoutMs: 10_000,
  baseDelayMs: BACKOFF_BASE_DELAY_MS,
  maxDelayMs: BACKOFF_MAX_DELAY_MS,
}

export interface RelayRuntimeTimingOverrides {
  /** hello 握手超时（默认 10s）。 */
  helloTimeoutMs?: number
  /** 传输层 pong 超时（默认 10s，docs/14 §B.2 同参）。 */
  pongTimeoutMs?: number
  /** 重连退避基数（默认 1s）。 */
  baseDelayMs?: number
  /** 重连退避封顶（默认 60s）。 */
  maxDelayMs?: number
}

/** 注入时序覆盖（smoke/测试缝；生产不调用）。 */
export function configureRelayClientRuntime(overrides: RelayRuntimeTimingOverrides): void {
  if (typeof overrides.helloTimeoutMs === 'number' && overrides.helloTimeoutMs > 0) runtimeTimings.helloTimeoutMs = overrides.helloTimeoutMs
  if (typeof overrides.pongTimeoutMs === 'number' && overrides.pongTimeoutMs > 0) runtimeTimings.pongTimeoutMs = overrides.pongTimeoutMs
  if (typeof overrides.baseDelayMs === 'number' && overrides.baseDelayMs > 0) runtimeTimings.baseDelayMs = overrides.baseDelayMs
  if (typeof overrides.maxDelayMs === 'number' && overrides.maxDelayMs > 0) runtimeTimings.maxDelayMs = overrides.maxDelayMs
  backoff = new BackoffCalculator({ baseDelayMs: runtimeTimings.baseDelayMs, maxDelayMs: runtimeTimings.maxDelayMs })
}

/** 诊断快照（smoke/状态投影数据源；零凭据）。 */
export interface RelayClientDiagnostics {
  status: RelayClientStatus
  connected: boolean
  hostId: number | null
  lastError: string | null
  /** 已建立映射的 relay 设备数（pair 流累计，stop 清零）。 */
  mappedDevices: number
  /** 当前退避计数（连接成功归零）。 */
  reconnectAttempts: number
}

export function getRelayClientDiagnostics(): RelayClientDiagnostics {
  return {
    status,
    connected: status === 'ready',
    hostId,
    lastError,
    mappedDevices: deviceMappings.size,
    reconnectAttempts: backoff.attempts,
  }
}

// ---------------------------------------------------------------------------
// 状态转换 + 投影回报（statusProjector 镜像；docs/19 §4.7）
// ---------------------------------------------------------------------------

function setStatus(next: RelayClientStatus): void {
  status = next
  setRelayRuntimeView({
    connected: next === 'ready',
    ...(next === 'ready' && hostId !== null ? { hostId } : {}),
    ...(lastError !== null && lastError.length > 0 ? { lastError } : {}),
  })
}

function clearTimers(): void {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  stopHeartbeatTimer()
  if (helloTimer !== null) {
    clearTimeout(helloTimer)
    helloTimer = null
  }
  const waiter = helloWaiter
  helloWaiter = null
  if (waiter !== null) waiter(null)
}

function stopHeartbeatTimer(): void {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

// ---------------------------------------------------------------------------
// 生命周期（start 幂等重触发；stop 全收口；apply 序列化——applyGatewaySettings 先例）
// ---------------------------------------------------------------------------

/**
 * 按 settings 真值启动（main/index.ts 启动 + applyRelaySettings 消费）：
 * disabled/misconfigured/unregistered → 零连接结构化投影；ready（凭据齐备）→
 * connecting + 异步连接流。重复调用 = 重触发（旧连接流经 generation 失效）。
 */
export function startRelayClient(): void {
  const registration = readRelayRegistrationState()
  if (!registration.enabled) {
    generation += 1
    clearTimers()
    closeConnection('relay disabled')
    deviceMappings.clear()
    hostId = null
    lastError = null
    setStatus('disabled')
    return
  }
  if (!registration.endpointOk) {
    generation += 1
    clearTimers()
    closeConnection('relay misconfigured')
    deviceMappings.clear()
    hostId = null
    lastError = relayEndpointError(registration.endpoint) ?? 'relay endpoint invalid (wss required, docs/18 §2)'
    setStatus('misconfigured')
    return
  }
  if (!registration.hasCredential) {
    generation += 1
    clearTimers()
    closeConnection('relay unregistered')
    deviceMappings.clear()
    hostId = null
    lastError = null
    setStatus('unregistered')
    return
  }
  wireSeams()
  generation += 1
  setStatus('connecting')
  void attemptConnect(generation)
}

/** 停止（幂等；settings 翻转 / 退出收尾 / smoke 复位消费）。 */
export function stopRelayClient(reason = 'stop requested'): void {
  generation += 1
  clearTimers()
  closeConnection(reason)
  clearEventUplinkHost()
  deviceMappings.clear()
  hostId = null
  lastError = null
  setStatus('stopped')
}

/** 关闭现连接（连接不存在/已闭为 no-op）。 */
function closeConnection(reason: string): void {
  const conn = connection
  connection = null
  if (conn !== null && !conn.closed) {
    conn.close(1000, reason)
  }
}

let applyQueue: Promise<void> = Promise.resolve()

/**
 * 按 settings 真值收敛运行时（settings:set relay_enabled/relay_endpoint 翻转即时
 * 生效；agents_monitor_enabled/gateway 先例）。并发调用按调用序串行（applyQueue）。
 */
export function applyRelaySettings(): Promise<void> {
  const result = applyQueue.then(async () => {
    stopRelayClient('settings change (re-read relay_enabled/relay_endpoint)')
    startRelayClient()
  })
  applyQueue = result.catch(() => {})
  return result
}

/** smoke/测试复位（进程内多次隔离场景；生产不调用——stop 等效收口）。 */
export function resetRelayClientForSmoke(): void {
  stopRelayClient('smoke reset')
  clearPairingBridgeState()
  clearCommandDownlinkState()
  clearRotationBridgeState()
  resetEventUplinkState()
  clearExtraDeviceRevokedListeners()
  setPairingIssuedListener(null)
  setRelayRuntimeView(null)
  seamsWired = false
  pairingHost = null
  runtimeTimings.helloTimeoutMs = 10_000
  runtimeTimings.pongTimeoutMs = 10_000
  runtimeTimings.baseDelayMs = BACKOFF_BASE_DELAY_MS
  runtimeTimings.maxDelayMs = BACKOFF_MAX_DELAY_MS
  backoff = new BackoffCalculator()
}

// ---------------------------------------------------------------------------
// 注入缝接线（进程级一次；各桥宿主经 sendFrame 的 ready 门离线自熄）
// ---------------------------------------------------------------------------

function wireSeams(): void {
  if (seamsWired) return
  seamsWired = true
  // 事件上行（eventUplink 完成批：sink 幂等注册 + lastSentSeq 水位恢复）
  setEventUplinkHost({
    isReady: () => status === 'ready',
    sendEvent: (frame) => sendFrame(frame),
  })
  // 配对桥（pairingBridge 完成批）：帧出口 + 设备配对回调（ECS↔Windows 映射登记 +
  // post-pairing 自动轮换，docs/19 §4.5 / docs/18 §9.4）
  pairingHost = {
    sendRegisterPairing: (frame) => sendFrame(frame),
    sendPairAccepted: (frame) => sendFrame(frame),
    sendError: (frame) => sendFrame(frame),
  }
  setPairingBridgeHost(pairingHost, (ecsDeviceId, winDeviceId) => {
    deviceMappings.set(ecsDeviceId, winDeviceId)
    requestTokenRotation(winDeviceId, 'post-pairing')
  })
  // 轮换桥（本批）：ready 门 + token_rotation 帧出口
  setRotationBridgeHost({
    isReady: () => status === 'ready',
    sendTokenRotation: (frame) => sendFrame(frame),
  })
  // 命令下行（commandDownlink 完成批）：ack/result/error 帧出口 + L3 终态监听
  setCommandDownlinkHost({
    sendAck: (frame) => sendFrame(frame),
    sendResult: (frame) => sendFrame(frame),
    sendError: (frame) => sendFrame(frame),
  })
  // L3 配对码签发同步（createPairing → register_pairing；离线 false → 本地模式退化）
  setPairingIssuedListener((event) => {
    handlePairingIssued(event)
  })
  // 撤销踢线（docs/18 §3.15/§9.5）：L3 revoke 附加监听槽 → 定点踢线帧。
  // deviceId 即 Windows 侧 remote_devices.id（docs/18 §3.15 H→E 帧形），零映射。
  addDeviceRevokedListener((deviceId) => {
    sendFrame({ type: 'disconnect', deviceId, reason: 'revoked' })
  })
}

// ---------------------------------------------------------------------------
// 连接流（attemptConnect → hello 握手 → 三步恢复序）
// ---------------------------------------------------------------------------

async function attemptConnect(gen: number): Promise<void> {
  try {
    if (gen !== generation) return
    const credential = loadRelayCredential()
    if (!credential.ok || credential.credential === undefined) {
      // 凭据运行中消失（文件被清）：结构化未注册投影，零连接（docs/19 §4.7）
      lastError = null
      setStatus('unregistered')
      return
    }
    const endpoint = readRelayRegistrationState().endpoint
    const result = await openRelayConnection({ endpoint, credential: credential.credential }, makeConnectionHooks(gen))
    if (gen !== generation) {
      if (result.upgraded) result.connection.close(1000, 'stale connect attempt (superseded)')
      return
    }
    if (!result.upgraded) {
      lastError =
        result.status !== undefined
          ? `relay upgrade refused (HTTP ${result.status}${result.code !== undefined ? ` ${result.code}` : ''})`
          : `relay connect failed (${result.error ?? 'unknown error'})`
      scheduleReconnect(gen)
      return
    }
    connection = result.connection
    const hello = await waitForHello(runtimeTimings.helloTimeoutMs)
    if (gen !== generation) return
    if (hello === null || connection === null) {
      lastError = `relay hello timeout (${runtimeTimings.helloTimeoutMs}ms, docs/19 §4.2 handshake)`
      closeConnection('hello timeout')
      scheduleReconnect(gen)
      return
    }
    // hello 已收（handleHelloFrame 回填 hostId/心跳参数）→ ready 先置位（防回填窗口
    // 内实时事件只落库），再执行三步恢复序①：断线回填（②③由 ECS 推送/sink 承载）
    heartbeatIntervalMs = hello.heartbeatSec * 1000
    backoff.reset()
    startHeartbeatTimer()
    setStatus('ready')
    try {
      backfillFromWatermark(hello.sequence)
    } catch (err) {
      // 回填查询失败不杀伤连接（sync 兜底重发幂等）；仅记录结构化诊断
      lastError = `relay backfill failed: ${err instanceof Error ? err.message : String(err)}`
    }
  } catch (err) {
    if (gen !== generation) return
    lastError = `relay connect error: ${err instanceof Error ? err.message : String(err)}`
    scheduleReconnect(gen)
  }
}

function waitForHello(timeoutMs: number): Promise<{ sequence: number; heartbeatSec: number } | null> {
  return new Promise((resolve) => {
    helloWaiter = resolve
    helloTimer = setTimeout(() => {
      resolveHelloWaiter(null)
    }, timeoutMs)
  })
}

function resolveHelloWaiter(value: { sequence: number; heartbeatSec: number } | null): void {
  if (helloTimer !== null) {
    clearTimeout(helloTimer)
    helloTimer = null
  }
  const waiter = helloWaiter
  helloWaiter = null
  if (waiter !== null) waiter(value)
}

/** 重连退避调度（BackoffCalculator 1s→60s ±20%；ready 归零）。 */
function scheduleReconnect(gen: number): void {
  connection = null
  stopHeartbeatTimer()
  if (helloWaiter !== null) resolveHelloWaiter(null)
  if (gen !== generation) return
  if (reconnectTimer !== null) return // 幂等：close 回调与 hello 超时竞争只挂一个
  const delay = backoff.nextDelayMs()
  setStatus('waiting-retry')
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    if (gen !== generation) return
    setStatus('connecting')
    void attemptConnect(gen)
  }, delay)
}

function makeConnectionHooks(gen: number): RelayClientConnectionHooks {
  return {
    onText(_connection, text) {
      routeFrame(text)
    },
    onClosed(_connection) {
      handleConnectionClosed(gen)
    },
  }
}

/** 连接终止（对端关/协议关/网络断）：退避重连（stop/disabled 后 generation 失效）。 */
function handleConnectionClosed(gen: number): void {
  connection = null
  stopHeartbeatTimer()
  if (helloWaiter !== null) resolveHelloWaiter(null)
  if (gen !== generation) return
  if (status === 'ready' || status === 'connecting') {
    scheduleReconnect(gen)
  }
}

// ---------------------------------------------------------------------------
// 帧路由（docs/18 §3 host 腿 E→H 面；单帧异常绝不杀伤连接——调用方逐帧隔离）
// ---------------------------------------------------------------------------

function routeFrame(text: string): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return // 非 JSON 帧面：ECS 恒发 JSON（wsClient 编解码已镜像同款纪律）
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
  const frame = parsed as { type?: unknown } & Record<string, unknown>
  switch (frame.type) {
    case 'hello':
      handleHelloFrame(frame)
      return
    case 'register_pairing_ack':
      handleRegisterPairingAckSafe(frame)
      return
    case 'pair':
      handlePairFrameSafe(frame)
      return
    case 'sync_request':
      handleSyncRequestFrame(frame)
      return
    case 'heartbeat':
      handleHeartbeatFrame(frame)
      return
    case 'error':
      handleErrorFrame(frame)
      return
    case 'disconnect':
      handleDisconnectFrame(frame)
      return
    default:
      return // 未知 type：绝不猜语义（协议演进向前兼容面）
  }
}

/** hello（docs/18 §3.1 E→H host 形态）：握手首帧 + 水位信标（幂等回填）。 */
function handleHelloFrame(frame: Record<string, unknown>): void {
  const sequence = typeof frame.sequence === 'number' && Number.isSafeInteger(frame.sequence) && frame.sequence >= 0 ? frame.sequence : 0
  const heartbeatSec = clampHeartbeatSec(frame.heartbeatSec)
  if (typeof frame.hostId === 'number' && Number.isSafeInteger(frame.hostId) && frame.hostId > 0) {
    hostId = frame.hostId
  }
  if (helloWaiter !== null) {
    resolveHelloWaiter({ sequence, heartbeatSec })
    return
  }
  // 已 ready 的再 hello（ECS 水位信标）：幂等回填（ECS 按 sequence UNIQUE 去重双保险）
  if (status === 'ready') {
    try {
      backfillFromWatermark(sequence)
    } catch {
      /* 回填失败不杀伤连接（sync 兜底） */
    }
  }
}

/** 心跳秒钳制（hello.heartbeatSec 异常值防抖；缺省 30 = docs/14 §B.2 同参）。 */
function clampHeartbeatSec(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const rounded = Math.round(value)
    if (rounded >= 5 && rounded <= 300) return rounded
    if (rounded > 300) return 300
    if (rounded >= 1) return 5
  }
  return 30
}

function handleRegisterPairingAckSafe(frame: unknown): void {
  try {
    handleRegisterPairingAck(frame)
  } catch {
    /* 逐帧隔离 */
  }
}

function handlePairFrameSafe(frame: unknown): void {
  const host = pairingHost
  if (host === null) return
  try {
    handlePairFrame(frame, host)
  } catch {
    /* 逐帧隔离（失败路径已折 error 帧） */
  }
}

/** sync_request（docs/18 §3.11 E→H 仅 ACK 部分中继）：累计游标 → L3 范围批 ack。 */
function handleSyncRequestFrame(frame: Record<string, unknown>): void {
  const after = frame.after
  const ecsDeviceId = frame.deviceId
  if (typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0) return
  if (typeof ecsDeviceId !== 'number' || !Number.isSafeInteger(ecsDeviceId) || ecsDeviceId <= 0) return
  // R2 实现面：E→H sync_request.deviceId = ECS 注册表 id → pair 流建立的映射回查；
  // 未知映射（host 重启内存映射丢失）→ 忽略（绝不猜），设备侧重发兜底。
  const winDeviceId = deviceMappings.get(ecsDeviceId)
  if (winDeviceId === undefined) return
  try {
    markEventsAckedThrough(after, winDeviceId)
  } catch {
    /* DB 异常不断连：ack 只前进语义下重复 sync_request 幂等 */
  }
}

/** heartbeat（docs/18 §3.13 E→H）：tokenVersion 兼作轮换确认信道（容错显式字段）。 */
function handleHeartbeatFrame(frame: Record<string, unknown>): void {
  const tokenVersion = frame.tokenVersion
  if (typeof tokenVersion === 'number') {
    noteTokenRotationConfirmed(tokenVersion)
  }
}

/** error（docs/18 §3.16 E→H）：结构化 lastError（零凭据零堆栈，截断防放大）。 */
function handleErrorFrame(frame: Record<string, unknown>): void {
  const code = typeof frame.code === 'string' ? frame.code : 'UNKNOWN'
  const message = typeof frame.message === 'string' ? frame.message : ''
  lastError = `relay error ${code}: ${message}`.slice(0, 300)
  setStatus(status) // lastError 变更回报投影
}

/**
 * disconnect（docs/18 §3.15 E→H）：reason:revoked → **不得自动重连**（停止状态机，
 * 结构化 lastError）；其余（server_shutdown/maintenance/superseded）→ 关闭后走
 * 既有退避重连（onClosed 驱动）。
 */
function handleDisconnectFrame(frame: Record<string, unknown>): void {
  const reason = typeof frame.reason === 'string' ? frame.reason : 'unknown'
  if (reason === 'revoked') {
    generation += 1
    clearTimers()
    closeConnection('relay host leg revoked by ECS')
    deviceMappings.clear()
    hostId = null
    lastError = 'relay host leg revoked by ECS (no auto-reconnect, docs/18 §3.15)'
    setStatus('stopped')
    return
  }
  closeConnection(`relay disconnect (${reason})`)
}

// ---------------------------------------------------------------------------
// 出站面（心跳节拍 + sendFrame ready 门）
// ---------------------------------------------------------------------------

/** 心跳节拍：传输层 ping/pong（docs/14 §B.2 参数）+ 应用层 heartbeat 帧（H→E 上行进度）。 */
function startHeartbeatTimer(): void {
  stopHeartbeatTimer()
  heartbeatTimer = setInterval(() => {
    const conn = connection
    if (conn === null || conn.closed) return
    conn.heartbeatTick(runtimeTimings.pongTimeoutMs)
    conn.sendFrame({ type: 'heartbeat', ts: nowSec(), lastSentSeq: currentLastSentSeq() })
  }, heartbeatIntervalMs)
}

/** H→E 帧统一出口：ready 门（离线一律 false——各桥离线自熄语义）。 */
function sendFrame(frame: HostToEcsFrame): boolean {
  const conn = connection
  if (conn === null || conn.closed || status !== 'ready') return false
  return conn.sendFrame(frame)
}
