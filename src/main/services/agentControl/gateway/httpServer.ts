/**
 * httpServer.ts — Remote Gateway HTTP 面（docs/14 Part B 13 端点 + WS 挂载，
 * docs/12 §2/§9/§10：Electron Main 进程内 node:http，无新进程形态）。
 *
 * 监听：绑定 127.0.0.1（回环外不可达——铁律，不起任何 0.0.0.0 监听）；
 * 端口 = settings gateway_port（默认 8746），占用则 8747–8755 顺延尝试，
 * 全占 → 结构化 GATEWAY_PORT_IN_USE（gatewayStatus.lastError 同步承载）；
 * gateway_enabled=0 → 零监听（start 幂等；stop 关 WS → 关监听，docs/12 §10 顺序）。
 *
 * 端点（docs/14 §B.1，13 + 4 条；鉴权/请求校验/响应/错误结构逐条对齐）：
 *   POST   /v1/pairing/create        仅回环（GATEWAY_LOCAL_ONLY）；防重放必带；201
 *   POST   /v1/pairing/claim         无 Token（一次性码 + claim 限流）；防重放豁免
 *   GET    /v1/health                无鉴权活性；防重放豁免
 *   GET    /v1/diagnostics           Bearer；与 IPC agents:diagnostics 同投影红线
 *   GET    /v1/devices               Bearer；绝无 Token 明文/哈希
 *   DELETE /v1/devices/{id}          Bearer；仅自撤销（他设备 403 DEVICE_FORBIDDEN）
 *   GET    /v1/agents                Bearer；providers 受限投影
 *   GET    /v1/sessions              Bearer；query providerId/status/limit/parentId(R2)/
 *                                    includeArchived(R3)；默认主会话 + 非归档
 *   GET    /v1/sessions/{id}         Bearer；{ session(含 childSessions/providerKey/
 *                                    providerLabel), capabilities }
 *   GET    /v1/sessions/{id}/messages Bearer；after 正向 / last|before 尾部取数
 *                                    (R10, prevAfter 游标)；items 可选 segments(R1/R8)
 *   POST   /v1/sessions/{id}/reply   Bearer；能力门；202 { commandId, status }
 *   POST   /v1/sessions/{id}/actions Bearer；能力门（observed 全禁/attached 无 pause）；202
 *   POST   /v1/sessions/{id}/archive Bearer；R3 幂等归档（只动本地投影）
 *   POST   /v1/sessions/{id}/unarchive Bearer；R3 幂等取消归档
 *   DELETE /v1/sessions/{id}         Bearer；R3 删除（本地投影级联清理，源文件零触碰）
 *   POST   /v1/providers/{providerId}/sessions Bearer；R6 启动托管会话（managed
 *                                    能力门；四件套；202 { commandId, sessionId?, nativeId? }）
 *   POST   /v1/events/{id}/ack       Bearer；delivery_state → acked（只前进）
 *   WS     /v1/events                upgrade 挂载（ws.ts，docs/14 §B.2 协议）
 *
 * 通用面：统一错误 {"error":{code,message}} + Part C HTTP 状态映射；JSON body
 * 上限 64KB；CORS 不需要（Android 原生客户端）；请求日志只记方法/路径/来源/结果码
 * （零凭据——约束 #13）；限流/防重放参数见 auth.ts（docs/14 §B.4 落值）。
 *
 * 写库纪律：本模块零直接写库——读投影直查/L3 读函数，配对/命令/审计/last_seen
 * 全部经 L3 函数（recordSecurityAudit/pairDevice/submitRemoteCommand/revokeDevice/
 * touchDeviceLastSeen，约束 #20）。事件投递接线：eventPipeline 投递回调 →
 * WS 在线设备推送；markDelivered/markAcked 由 ws.ts 调 L3 eventPipeline。
 * electron-free（node:http/node:crypto），.ts 直载可被 smoke 加载。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { logger } from '../../../core/logger.ts'
import { ServiceError } from '../../internal.ts'
import { getSetting } from '../../settingsService.ts'
import type { SessionStatus } from '../../../../shared/types.ts'
import {
  AGENT_LIST_LIMIT_MAX,
  AGENT_SESSION_STATUSES,
  getAgentSessionDetail,
  getDiagnostics,
  isGatewayEnabled,
  listAgentMessages,
  listAgentProviders,
  listAgentSessions,
  listDevices,
  MANAGED_SESSION_TASK_MAX_CHARS,
  recordSecurityAudit,
  revokeDevice,
  setDeviceRevokedListener,
  setGatewayRuntimeProbe,
  startProviderManagedSession,
  submitRemoteCommand,
  touchDeviceLastSeen,
} from '../agentControlService.ts'
import { archiveSession, deleteSession, unarchiveSession } from '../sessionLifecycle.ts'
import { markEventAcked, setEventDeliverySink } from '../eventPipeline.ts'
import {
  authenticateBearerToken,
  checkReplayHeaders,
  isAuthFailureLimited,
  readBearerHeaderValue,
  recordAuthFailure,
  recordDeviceRequest,
  sourceKeyFromRemoteAddress,
  type AuthenticatedDevice,
} from './auth.ts'
import { createPairingCode, claimPairingCode } from './pairing.ts'
import { attachWebSocketServer, type GatewayWsHandle, type GatewayWsOptions } from './ws.ts'

// ---------------------------------------------------------------------------
// 常量（docs/14 Part B / §B.4 落值）
// ---------------------------------------------------------------------------

/** 默认端口（settings gateway_port 缺省回退；004 种子同值）。 */
export const GATEWAY_DEFAULT_PORT = 8746
/** 端口顺延尝试上限（8747–8755；全占 → GATEWAY_PORT_IN_USE，docs/14 Part C）。 */
export const GATEWAY_PORT_FALLBACK_RANGE = [8747, 8748, 8749, 8750, 8751, 8752, 8753, 8754, 8755] as const
/** JSON body 上限（防滥用）。 */
export const JSON_BODY_LIMIT_BYTES = 64 * 1024
/** reply 文本上限（docs/14 §A.1 #6 同源：非空 ≤4000 字符）。 */
const REPLY_TEXT_MAX_CHARS = 4000

// ---------------------------------------------------------------------------
// 运行时状态（模块级单例：Gateway 与 Main 同生命周期，docs/12 §2）
// ---------------------------------------------------------------------------

export interface GatewayRuntimeStatus {
  running: boolean
  /** 实际监听端口（顺延后可能 ≠ 配置端口；未运行 undefined）。 */
  actualPort?: number
  activeConnections: number
  lastError?: string
}

export interface GatewayStartOptions extends GatewayWsOptions {
  /** /v1/health 的 name 字段（默认 'devhub'）。 */
  appName?: string
  /** /v1/health 的 version 字段（index.ts 传 app.getVersion()）。 */
  appVersion?: string
}

interface GatewayRuntime {
  server: Server | null
  listening: boolean
  ws: GatewayWsHandle | null
  actualPort: number | null
  lastError: string | null
  appName: string
  appVersion: string
  wired: boolean
}

const runtime: GatewayRuntime = {
  server: null,
  listening: false,
  ws: null,
  actualPort: null,
  lastError: null,
  appName: 'devhub',
  appVersion: '0.0.0',
  wired: false,
}

function configuredPort(): number {
  const raw = getSetting('gateway_port')
  const parsed = raw !== undefined ? Number.parseInt(raw, 10) : Number.NaN
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 65535 ? parsed : GATEWAY_DEFAULT_PORT
}

/** 一次性注入缝注册（probe/撤销监听/事件投递回调；重复注册幂等）。 */
function ensureWiring(): void {
  if (runtime.wired) return
  runtime.wired = true
  // gatewayStatus 真值探针（L3 注入缝，docs/14 §A.1 #10 running/actualPort 真值）
  setGatewayRuntimeProbe(() => ({
    running: runtime.listening,
    ...(runtime.actualPort !== null ? { actualPort: runtime.actualPort } : {}),
    activeConnections: runtime.ws?.activeConnections() ?? 0,
    ...(runtime.lastError !== null ? { lastError: runtime.lastError } : {}),
  }))
  // 设备撤销 → 已建立 WS 服务端立即关闭（docs/15 §4；L3 撤销路径经注入缝回调）
  setDeviceRevokedListener((deviceId) => {
    runtime.ws?.closeDeviceConnections(deviceId, 'device revoked')
  })
}

// ---------------------------------------------------------------------------
// 生命周期（start 幂等；stop 关 WS → 关监听；enabled=0 → 零监听）
// ---------------------------------------------------------------------------

function listenOn(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      server.removeListener('listening', onListening)
      reject(err)
    }
    const onListening = (): void => {
      server.removeListener('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

function isAddrInUse(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as { code?: string }).code === 'EADDRINUSE'
}

/**
 * 启动 Gateway（幂等）：enabled=0 → 确保零监听后返回；已监听 → 原样返回；
 * 端口顺延 8747–8755；全占 → GATEWAY_PORT_IN_USE（记录 lastError + 审计）。
 */
export async function startGateway(options: GatewayStartOptions = {}): Promise<GatewayRuntimeStatus> {
  ensureWiring()
  if (options.appName !== undefined) runtime.appName = options.appName
  if (options.appVersion !== undefined) runtime.appVersion = options.appVersion
  if (!isGatewayEnabled()) {
    await stopGateway('gateway disabled (settings gateway_enabled = 0)')
    runtime.lastError = null
    return getGatewayRuntimeStatus()
  }
  if (runtime.listening && runtime.server !== null) {
    return getGatewayRuntimeStatus() // start 幂等
  }
  runtime.lastError = null
  const wanted = configuredPort()
  const candidates = [wanted, ...GATEWAY_PORT_FALLBACK_RANGE.filter((p) => p !== wanted)]
  let lastError: unknown = null
  for (const port of candidates) {
    const server = createServer((req, res) => {
      void handleRequest(req, res)
    })
    // 自研 WS 挂载（upgrade 事件；docs/12 §9 裁决默认自研）
    const ws = attachWebSocketServer(server, {
      ...(options.heartbeatIntervalMs !== undefined ? { heartbeatIntervalMs: options.heartbeatIntervalMs } : {}),
      ...(options.pongTimeoutMs !== undefined ? { pongTimeoutMs: options.pongTimeoutMs } : {}),
    })
    try {
      await listenOn(server, port, '127.0.0.1')
      runtime.server = server
      runtime.ws = ws
      runtime.actualPort = port
      runtime.listening = true
      // 事件投递接线（docs/12 §6 语义 1：COMMIT 后回调；失败不回滚 DB）
      setEventDeliverySink((event) => {
        runtime.ws?.pushEvent(event)
      })
      recordSecurityAudit('gateway', 'gateway_started', null, 'success', JSON.stringify({ port }))
      logger.info(`gateway: listening on 127.0.0.1:${port} (settings gateway_port=${wanted})`)
      return getGatewayRuntimeStatus()
    } catch (err) {
      lastError = err
      // 清场失败尝试的 server 实例（占用 → 试下一端口；其他错误 → 终止）
      try {
        await new Promise<void>((resolve) => {
          server.close(() => resolve())
          server.closeAllConnections?.()
        })
      } catch {
        /* 忽略清场失败 */
      }
      if (!isAddrInUse(err)) {
        runtime.lastError = `gateway listen failed on port ${port}: ${err instanceof Error ? err.message : String(err)}`
        logger.warn(`gateway: ${runtime.lastError}`)
        break
      }
    }
  }
  if (!runtime.listening) {
    const detail = isAddrInUse(lastError)
      ? `gateway: no available port (settings gateway_port=${wanted}, fallback ${GATEWAY_PORT_FALLBACK_RANGE[0]}-${GATEWAY_PORT_FALLBACK_RANGE[GATEWAY_PORT_FALLBACK_RANGE.length - 1]} all in use)`
      : (runtime.lastError ?? 'gateway: listen failed')
    runtime.lastError = detail
    recordSecurityAudit('gateway', 'gateway_start_failed', null, 'error', JSON.stringify({ wanted }))
    logger.warn(detail)
    if (isAddrInUse(lastError)) {
      throw new ServiceError('GATEWAY_PORT_IN_USE', detail)
    }
    throw new ServiceError('INTERNAL', detail)
  }
  return getGatewayRuntimeStatus()
}

/** 停止 Gateway（幂等；docs/12 §10 顺序：关 WS → 关监听）。 */
export async function stopGateway(reason = 'stop requested'): Promise<void> {
  setEventDeliverySink(null)
  if (runtime.ws !== null) {
    runtime.ws.closeAll(reason)
    runtime.ws = null
  }
  const server = runtime.server
  runtime.server = null
  if (server !== null) {
    const wasListening = runtime.listening
    runtime.listening = false
    const port = runtime.actualPort
    runtime.actualPort = null
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    })
    if (wasListening) {
      recordSecurityAudit('gateway', 'gateway_stopped', null, 'success', JSON.stringify({ ...(port !== null ? { port } : {}), reason }))
      logger.info(`gateway: listener closed (${reason})`)
    }
  } else {
    runtime.listening = false
    runtime.actualPort = null
  }
}

/** AC6 修复：apply 串行队列——settings:set 的 gateway 接线是 fire-and-forget
 * （handlers.ts void apply），连续翻转 gateway_enabled/gateway_port 会产生并发
 * apply；stop/start 交错会让 runtime.server 指向其中一个，另一个 server 泄漏
 * （listening 无人引用 → 进程不退出 + 端口被占）。队列化后每次 apply 完整
 * 「停旧→启新」原子收敛，runtime.server 恒为唯一真相。 */
let applyQueue: Promise<unknown> = Promise.resolve()

/**
 * 按 settings 真值收敛运行时（settings:set gateway_enabled/gateway_port 翻转即时
 * 生效，照 agents_monitor_enabled 的 syncMonitorTasks 先例；agents:gatewayRestart
 * confirmed 复用）：enabled → 停旧监听 + 重新绑定（重读端口）；disabled → 停。
 * 失败不抛（settings 已落账），错误进 lastError → gatewayStatus 结构化可见。
 * 多次并发调用按调用序串行执行（见 applyQueue 注记）。
 */
export function applyGatewaySettings(options: GatewayStartOptions = {}): Promise<GatewayRuntimeStatus> {
  const result = applyQueue.then(() => doApplyGatewaySettings(options))
  applyQueue = result.catch(() => {})
  return result
}

async function doApplyGatewaySettings(options: GatewayStartOptions = {}): Promise<GatewayRuntimeStatus> {
  ensureWiring()
  try {
    await stopGateway('settings change (re-read gateway_enabled/gateway_port)')
    return await startGateway(options)
  } catch (err) {
    if (!(err instanceof ServiceError)) {
      runtime.lastError = err instanceof Error ? err.message : String(err)
    }
    return getGatewayRuntimeStatus()
  }
}

export function getGatewayRuntimeStatus(): GatewayRuntimeStatus {
  return {
    running: runtime.listening,
    ...(runtime.actualPort !== null ? { actualPort: runtime.actualPort } : {}),
    activeConnections: runtime.ws?.activeConnections() ?? 0,
    ...(runtime.lastError !== null ? { lastError: runtime.lastError } : {}),
  }
}

/** smoke/测试复位（进程内多次隔离场景；生产不调用）。 */
export async function resetGatewayInMemoryState(): Promise<void> {
  const { resetReplayState, resetRateLimitState } = await import('./auth.ts')
  const { resetPairingState } = await import('./pairing.ts')
  await stopGateway('smoke reset')
  resetReplayState()
  resetRateLimitState()
  resetPairingState()
}

// ---------------------------------------------------------------------------
// HTTP 通用面（错误映射 / 回包 / 日志 / body / 回环判定）
// ---------------------------------------------------------------------------

/** Part C：错误码 → HTTP 状态映射（docs/14 Part C 逐条）。 */
export function httpStatusForCode(code: string): number {
  switch (code) {
    case 'AGENT_PROVIDER_UNAVAILABLE':
    case 'AGENT_SOURCE_UNREADABLE':
    case 'GATEWAY_DISABLED':
    case 'GATEWAY_PORT_IN_USE':
    case 'DEGRADED':
      return 503
    case 'AGENT_PROVIDER_DISABLED':
    case 'AGENT_MONITOR_DISABLED':
    case 'COMMAND_KEY_CONFLICT':
    case 'COMMAND_EXPIRED':
      return 409
    case 'AGENT_CAPABILITY_MISSING':
    case 'GATEWAY_LOCAL_ONLY':
    case 'DEVICE_FORBIDDEN':
    case 'COMMAND_NOT_EXECUTABLE':
      return 403
    case 'DEVICE_NOT_PAIRED':
    case 'DEVICE_REVOKED':
    case 'AUTH_INVALID_TOKEN':
    case 'AUTH_REPLAYED':
      return 401
    case 'AUTH_RATE_LIMITED':
      return 429
    case 'BAD_PAYLOAD':
      return 400
    case 'NOT_FOUND':
      return 404
    default:
      // DB_ERROR / INTERNAL / CHANNEL_NOT_ALLOWED / 未知码折叠 500
      return 500
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown, extraHeaders: Record<string, string> = {}): void {
  if (res.headersSent) return
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  })
  res.end(body)
}

function respondError(res: ServerResponse, err: unknown, extraHeaders: Record<string, string> = {}): void {
  const code = err instanceof ServiceError ? err.code : 'INTERNAL'
  const message = err instanceof ServiceError ? err.message : 'gateway: internal error'
  sendJson(res, err instanceof ServiceError ? httpStatusForCode(code) : 500, { error: { code, message } }, extraHeaders)
}

/** 请求日志：方法/路径/来源/结果码（零 query、零 header、零 body——约束 #13）。 */
function logRequest(method: string, pathname: string, sourceKey: string, status: number): void {
  logger.info(`gateway: ${method} ${pathname} from ${sourceKey} -> ${status}`)
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false
    req.on('data', (chunk: Buffer) => {
      if (settled) return // 超限后丢弃余量（drain），让 400 响应能正常写出
      total += chunk.length
      if (total > JSON_BODY_LIMIT_BYTES) {
        settled = true
        chunks.length = 0
        req.resume()
        reject(new ServiceError('BAD_PAYLOAD', `gateway: request body exceeds ${JSON_BODY_LIMIT_BYTES} bytes limit`))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      if (total === 0) {
        resolve(null)
        return
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new ServiceError('BAD_PAYLOAD', 'gateway: request body must be a JSON object'))
          return
        }
        resolve(parsed as Record<string, unknown>)
      } catch {
        reject(new ServiceError('BAD_PAYLOAD', 'gateway: request body is not valid JSON'))
      }
    })
    req.on('error', () => {
      if (!settled) {
        settled = true
        reject(new ServiceError('BAD_PAYLOAD', 'gateway: request stream error'))
      }
    })
  })
}

/** 回环判定（docs/14 §B.1：/v1/pairing/create 仅限 127.0.0.1 回环）。 */
export function isLoopbackRemoteAddress(remoteAddress: string | undefined): boolean {
  if (remoteAddress === undefined || remoteAddress.length === 0) return false
  const normalized = remoteAddress.startsWith('::ffff:') ? remoteAddress.slice('::ffff:'.length) : remoteAddress
  return normalized === '127.0.0.1' || normalized === '::1'
}

// ---------------------------------------------------------------------------
// 查询/请求参数小助手（严格校验，违例 → BAD_PAYLOAD，与 IPC handler 同纪律）
// ---------------------------------------------------------------------------

function optionalPositiveInt(value: string | null, label: string): number | undefined {
  if (value === null || value.length === 0) return undefined
  const parsed = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ServiceError('BAD_PAYLOAD', `gateway: query ${label} must be a positive integer`)
  }
  return parsed
}

function optionalListLimit(value: string | null): number | undefined {
  const parsed = optionalPositiveInt(value, 'limit')
  if (parsed === undefined) return undefined
  if (parsed > AGENT_LIST_LIMIT_MAX) {
    throw new ServiceError('BAD_PAYLOAD', `gateway: query limit must be ≤ ${AGENT_LIST_LIMIT_MAX}`)
  }
  return parsed
}

function optionalStatusFilter(value: string | null): string | undefined {
  if (value === null || value.length === 0) return undefined
  if (!(AGENT_SESSION_STATUSES as readonly string[]).includes(value)) {
    throw new ServiceError('BAD_PAYLOAD', `gateway: query status must be one of: ${AGENT_SESSION_STATUSES.join(' | ')}`)
  }
  return value
}

/** R3：includeArchived=1 时归档会话可见（其余取值视为缺省隐藏）。 */
function optionalIncludeArchived(value: string | null): boolean | undefined {
  if (value === null || value.length === 0) return undefined
  if (value === '1' || value === 'true') return true
  if (value === '0' || value === 'false') return false
  throw new ServiceError('BAD_PAYLOAD', 'gateway: query includeArchived must be one of: 1 | 0 | true | false')
}

function requireStringField(
  body: Record<string, unknown>,
  field: string,
  maxChars?: number,
  opts: { allowEmpty?: boolean } = {},
): string {
  const raw = body[field]
  if (typeof raw !== 'string' || (!opts.allowEmpty && raw.trim().length === 0)) {
    throw new ServiceError('BAD_PAYLOAD', `gateway: field "${field}" must be a non-empty string`)
  }
  if (maxChars !== undefined && raw.length > maxChars) {
    throw new ServiceError('BAD_PAYLOAD', `gateway: field "${field}" exceeds ${maxChars} characters`)
  }
  return raw
}

function optionalStringField(body: Record<string, unknown>, field: string, maxChars: number): string | undefined {
  const raw = body[field]
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string' || raw.length > maxChars) {
    throw new ServiceError('BAD_PAYLOAD', `gateway: field "${field}" must be a string ≤${maxChars} characters`)
  }
  return raw
}

// ---------------------------------------------------------------------------
// 鉴权管线（受保护端点：限流 → Token → 防重放 → 常规限流 → last_seen）
// ---------------------------------------------------------------------------

/**
 * 受保护端点管线（docs/14 §B.4）：
 * 1. 同源已在鉴权失败限流窗口 → 429 + Retry-After（不再消耗校验）；
 * 2. Bearer Token 校验（失败：登记 + 审计 auth_failed，AUTH_INVALID_TOKEN/DEVICE_REVOKED）；
 * 3. 防重放（时间戳 ±300s + nonce LRU；拒绝：审计 replay_rejected + 计入失败限流）；
 * 4. 常规请求限流 120/min/设备（超限：审计 rate_limited + 429）；
 * 5. last_seen 节流更新（L3 touchDeviceLastSeen）。
 * AUTH_RATE_LIMITED 错误附 retryAfterSec（respondError 侧转 Retry-After 头）。
 */
function requireDevice(req: IncomingMessage, sourceKey: string): AuthenticatedDevice {
  if (isAuthFailureLimited(sourceKey)) {
    throw Object.assign(
      new ServiceError('AUTH_RATE_LIMITED', 'gateway: auth failures rate limited (5 / 60s per source, docs/14 B.4)'),
      { retryAfterSec: 60 },
    )
  }
  let device: AuthenticatedDevice
  try {
    device = authenticateBearerToken(readBearerHeaderValue(req.headers.authorization))
  } catch (err) {
    recordAuthFailure(sourceKey)
    if (err instanceof ServiceError) {
      recordSecurityAudit('auth', 'auth_failed', null, 'denied', JSON.stringify({ code: err.code, source: sourceKey }))
    }
    throw err
  }
  try {
    checkReplayHeaders({ timestamp: req.headers['x-devhub-timestamp'], nonce: req.headers['x-devhub-nonce'] })
  } catch (err) {
    recordAuthFailure(sourceKey)
    if (err instanceof ServiceError) {
      recordSecurityAudit('auth', 'replay_rejected', device.id, 'denied', JSON.stringify({ source: sourceKey }))
    }
    throw err
  }
  if (recordDeviceRequest(device.id)) {
    recordSecurityAudit('auth', 'rate_limited', device.id, 'denied', JSON.stringify({ scope: 'device_requests', limitPerMin: 120 }))
    throw Object.assign(
      new ServiceError('AUTH_RATE_LIMITED', 'gateway: device request rate limited (120 / min, docs/14 B.4)'),
      { retryAfterSec: 60 },
    )
  }
  touchDeviceLastSeen(device.id)
  return device
}

/** AUTH_RATE_LIMITED 的 Retry-After 头（附在错误对象 retryAfterSec 上时优先）。 */
function retryAfterHeaderFor(err: unknown): Record<string, string> {
  const retry = (err as { retryAfterSec?: number }).retryAfterSec
  if (typeof retry === 'number' && retry > 0) {
    return { 'Retry-After': String(Math.ceil(retry)) }
  }
  if (err instanceof ServiceError && err.code === 'AUTH_RATE_LIMITED') {
    return { 'Retry-After': '60' }
  }
  return {}
}

// ---------------------------------------------------------------------------
// 路由（docs/14 §B.1 13 端点逐条）
// ---------------------------------------------------------------------------

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase()
  let pathname = '/'
  try {
    pathname = new URL(req.url ?? '/', 'http://gateway.internal').pathname
  } catch {
    /* 保持 '/' */
  }
  const sourceKey = sourceKeyFromRemoteAddress(req.socket.remoteAddress)
  const segments = pathname.split('/').filter(Boolean)
  try {
    const status = await route(method, pathname, segments, req, res, sourceKey)
    logRequest(method, pathname, sourceKey, status)
  } catch (err) {
    respondError(res, err, retryAfterHeaderFor(err))
    logRequest(method, pathname, sourceKey, err instanceof ServiceError ? httpStatusForCode(err.code) : 500)
  }
}

async function route(
  method: string,
  pathname: string,
  segments: string[],
  req: IncomingMessage,
  res: ServerResponse,
  sourceKey: string,
): Promise<number> {
  // --- GET /v1/health（无鉴权活性；防重放豁免，docs/14 §B.4） -----------------
  if (method === 'GET' && pathname === '/v1/health') {
    sendJson(res, 200, { ok: true, name: runtime.appName, version: runtime.appVersion, uptimeSec: Math.floor(process.uptime()) })
    return 200
  }

  // --- POST /v1/pairing/create（仅回环；防重放必带；无设备 Token） -------------
  if (method === 'POST' && pathname === '/v1/pairing/create') {
    if (!isLoopbackRemoteAddress(req.socket.remoteAddress)) {
      throw new ServiceError('GATEWAY_LOCAL_ONLY', 'gateway: pairing/create is restricted to loopback sources (docs/14 B.1)')
    }
    try {
      checkReplayHeaders({ timestamp: req.headers['x-devhub-timestamp'], nonce: req.headers['x-devhub-nonce'] })
    } catch (err) {
      // 重放拒绝同样落审计（docs/15 §4：重放 → AUTH_REPLAYED + 审计 replay_rejected）
      if (err instanceof ServiceError) {
        recordSecurityAudit('auth', 'replay_rejected', null, 'denied', JSON.stringify({ source: sourceKey, scope: 'pairing_create' }))
      }
      throw err
    }
    const body = (await readJsonBody(req)) ?? {}
    const deviceName = optionalStringField(body, 'deviceName', 100)
    const created = createPairingCode(deviceName)
    sendJson(res, 201, created)
    return 201
  }

  // --- POST /v1/pairing/claim（一次性码；claim 限流；防重放豁免） --------------
  if (method === 'POST' && pathname === '/v1/pairing/claim') {
    const body = (await readJsonBody(req)) ?? {}
    // AC7b 裁决：pairingId 可选——未提供按活跃码唯一定位（同时仅 1 活跃码）；
    // 提供时必须与活跃码精确匹配。限流/TTL/一次性/审计语义零变化（pairing.ts）。
    const pairingId = optionalStringField(body, 'pairingId', 64)
    const code = requireStringField(body, 'code', 8)
    if (!/^[0-9A-HJ-NP-TV-Z]{8}$/.test(code)) {
      throw new ServiceError('BAD_PAYLOAD', 'gateway: field "code" must be 8-char Crockford Base32 (no I/L/O/U)')
    }
    const deviceName = requireStringField(body, 'deviceName', 100)
    const platform = requireStringField(body, 'platform', 32)
    if (platform !== 'android') {
      throw new ServiceError('BAD_PAYLOAD', 'gateway: field "platform" must be "android" (docs/14 B.1)')
    }
    // AUTH_RATE_LIMITED 附 claim 窗口 Retry-After（retryAfterHeaderFor 消费）
    const result = claimPairingCode({ pairingId, code, deviceName, platform }, sourceKey)
    sendJson(res, 200, result) // Token 明文仅此一次（红线 docs/15 §3）
    return 200
  }

  // --- GET /v1/diagnostics --------------------------------------------------
  if (method === 'GET' && pathname === '/v1/diagnostics') {
    requireDevice(req, sourceKey)
    const diag = await getDiagnostics()
    sendJson(res, 200, { providers: diag.providers, gateway: diag.gateway })
    return 200
  }

  // --- GET /v1/devices -------------------------------------------------------
  if (method === 'GET' && pathname === '/v1/devices') {
    requireDevice(req, sourceKey)
    sendJson(res, 200, listDevices())
    return 200
  }

  // --- DELETE /v1/devices/{id}（仅自撤销，docs/14 §B.1） ----------------------
  if (method === 'DELETE' && segments.length === 3 && segments[0] === 'v1' && segments[1] === 'devices') {
    const device = requireDevice(req, sourceKey)
    const id = Number.parseInt(segments[2], 10)
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new ServiceError('NOT_FOUND', `gateway: no route for ${pathname}`)
    }
    if (id !== device.id) {
      throw new ServiceError('DEVICE_FORBIDDEN', 'gateway: devices may only revoke themselves (desktop IPC agents:deviceRevoke manages others, docs/15 §5)')
    }
    revokeDevice(id, true, 'rest-self')
    sendJson(res, 200, { revoked: true })
    return 200
  }

  // --- GET /v1/agents（providers 受限投影，docs/14 §B.1） ---------------------
  if (method === 'GET' && pathname === '/v1/agents') {
    requireDevice(req, sourceKey)
    const { providers } = await listAgentProviders()
    sendJson(res, 200, {
      providers: providers.map((p) => ({ id: p.id, displayName: p.displayName, health: p.health, capabilities: p.capabilities })),
    })
    return 200
  }

  // --- GET /v1/sessions ------------------------------------------------------
  // ux 批 A：默认过滤 = 主会话（parent IS NULL，R2 语义）+ 未归档（R3）；
  // parentId= 指向子会话页（含已结束/归档）；includeArchived=1 归档可见
  if (method === 'GET' && pathname === '/v1/sessions') {
    requireDevice(req, sourceKey)
    const url = new URL(req.url ?? '/', 'http://gateway.internal')
    const statusFilter = optionalStatusFilter(url.searchParams.get('status'))
    const result = listAgentSessions({
      providerId: optionalPositiveInt(url.searchParams.get('providerId'), 'providerId'),
      ...(statusFilter !== undefined ? { status: statusFilter as SessionStatus } : {}),
      limit: optionalListLimit(url.searchParams.get('limit')),
      parentId: optionalPositiveInt(url.searchParams.get('parentId'), 'parentId'),
      includeArchived: optionalIncludeArchived(url.searchParams.get('includeArchived')),
    })
    sendJson(res, 200, result)
    return 200
  }

  // --- POST /v1/sessions/{id}/archive | /unarchive（R3；Bearer+防重放+限流；
  //     幂等 = 状态置位语义天然幂等；只动 DevHub 本地投影，源文件零触碰） --------
  if (method === 'POST' && segments.length === 4 && segments[0] === 'v1' && segments[1] === 'sessions' && (segments[3] === 'archive' || segments[3] === 'unarchive')) {
    requireDevice(req, sourceKey)
    const sessionId = Number.parseInt(segments[2], 10)
    if (!Number.isSafeInteger(sessionId) || sessionId <= 0) {
      throw new ServiceError('NOT_FOUND', `gateway: no route for ${pathname}`)
    }
    if (segments[3] === 'archive') {
      sendJson(res, 200, archiveSession(sessionId))
    } else {
      sendJson(res, 200, unarchiveSession(sessionId))
    }
    return 200
  }

  // --- DELETE /v1/sessions/{id}（R3；只删 DevHub 本地投影行（含子会话链级联清理
  //     消息/事件/deliveries/资源边），源文件零触碰；重删 → NOT_FOUND） -------------
  if (method === 'DELETE' && segments.length === 3 && segments[0] === 'v1' && segments[1] === 'sessions') {
    requireDevice(req, sourceKey)
    const sessionId = Number.parseInt(segments[2], 10)
    if (!Number.isSafeInteger(sessionId) || sessionId <= 0) {
      throw new ServiceError('NOT_FOUND', `gateway: no route for ${pathname}`)
    }
    sendJson(res, 200, deleteSession(sessionId))
    return 200
  }

  // --- GET /v1/sessions/{id} 与 GET /v1/sessions/{id}/messages ----------------
  if (method === 'GET' && segments.length >= 3 && segments[0] === 'v1' && segments[1] === 'sessions') {
    requireDevice(req, sourceKey)
    const sessionId = Number.parseInt(segments[2], 10)
    if (!Number.isSafeInteger(sessionId) || sessionId <= 0) {
      throw new ServiceError('NOT_FOUND', `gateway: no route for ${pathname}`)
    }
    if (segments.length === 3) {
      const detail = getAgentSessionDetail(sessionId)
      // R2：session 视图附 childSessions（含已结束）；R4：providerKey/providerLabel 同视图
      sendJson(res, 200, { session: detail.session, capabilities: detail.capabilities })
      return 200
    }
    if (segments.length === 4 && segments[3] === 'messages') {
      const url = new URL(req.url ?? '/', 'http://gateway.internal')
      // R10：last/before 尾部取数 + prevAfter 游标（与 after/limit 组合互斥 → BAD_PAYLOAD）
      const lastRaw = optionalPositiveInt(url.searchParams.get('last'), 'last')
      const before = optionalPositiveInt(url.searchParams.get('before'), 'before')
      const page = listAgentMessages({
        sessionId,
        after: optionalPositiveInt(url.searchParams.get('after'), 'after'),
        ...(before !== undefined ? { before } : {}),
        ...(lastRaw !== undefined ? { last: Math.min(lastRaw, AGENT_LIST_LIMIT_MAX) } : {}),
        limit: optionalListLimit(url.searchParams.get('limit')),
      })
      // 远程投影（docs/14 §B.1）：contentRedacted 脱敏同源；绝不携带 sourceRef
      // （本地源指针不出本机，docs/15 §6）；segments 为展示投影（R8 标签化后，
      // 原始 plugin:// 等 URI 只保留在 contentRedacted 兼容字段）
      sendJson(res, 200, {
        items: page.items.map((m) => ({
          id: m.id,
          role: m.role,
          contentRedacted: m.contentRedacted,
          ...(m.occurredAt !== undefined ? { occurredAt: m.occurredAt } : {}),
          ...(m.segments !== undefined ? { segments: m.segments } : {}),
        })),
        ...(page.nextAfter !== undefined ? { nextAfter: page.nextAfter } : {}),
        ...(page.prevAfter !== undefined ? { prevAfter: page.prevAfter } : {}),
      })
      return 200
    }
  }

  // --- POST /v1/providers/{providerId}/sessions（R6 启动托管会话；四件套；
  //     仅 capabilities 已授予 managed 的 provider 开放，其余 403
  //     COMMAND_NOT_EXECUTABLE；providerId 受理数字 id 或业务键） ------------------
  if (method === 'POST' && segments.length === 4 && segments[0] === 'v1' && segments[1] === 'providers' && segments[3] === 'sessions') {
    const device = requireDevice(req, sourceKey)
    let providerRef = segments[2]
    try {
      providerRef = decodeURIComponent(providerRef)
    } catch {
      throw new ServiceError('BAD_PAYLOAD', 'gateway: providerId path segment is not a valid URI component')
    }
    if (providerRef.length === 0 || providerRef.length > 64) {
      throw new ServiceError('NOT_FOUND', `gateway: no route for ${pathname}`)
    }
    const body = (await readJsonBody(req)) ?? {}
    const idempotencyKey = optionalStringField(body, 'idempotencyKey', 128)
    const task = requireStringField(body, 'task', MANAGED_SESSION_TASK_MAX_CHARS)
    const started = await startProviderManagedSession({ deviceId: device.id, provider: providerRef, task, idempotencyKey })
    sendJson(res, 202, started)
    return 202
  }

  // --- POST /v1/sessions/{id}/reply | /actions（指令链；202 accepted） --------
  // AC6 修复：/v1/sessions/{id}/reply|actions 为 4 段路径（docs/14 §B.1 端点表），
  // {id} 取 segments[2]——此前误判 length===5 / segments[3] 致端点整体 404 不可达
  if (method === 'POST' && segments.length === 4 && segments[0] === 'v1' && segments[1] === 'sessions' && (segments[3] === 'reply' || segments[3] === 'actions')) {
    const device = requireDevice(req, sourceKey)
    const sessionId = Number.parseInt(segments[2], 10)
    if (!Number.isSafeInteger(sessionId) || sessionId <= 0) {
      throw new ServiceError('NOT_FOUND', `gateway: no route for ${pathname}`)
    }
    const body = (await readJsonBody(req)) ?? {}
    const idempotencyKey = optionalStringField(body, 'idempotencyKey', 128)
    if (segments[3] === 'reply') {
      const text = requireStringField(body, 'text', REPLY_TEXT_MAX_CHARS)
      const accepted = await submitRemoteCommand({ deviceId: device.id, sessionId, action: 'reply', text, idempotencyKey })
      sendJson(res, 202, accepted)
      return 202
    }
    const action = body['action']
    if (action !== 'pause' && action !== 'resume') {
      throw new ServiceError('BAD_PAYLOAD', 'gateway: field "action" must be "pause" | "resume"')
    }
    const accepted = await submitRemoteCommand({ deviceId: device.id, sessionId, action, idempotencyKey })
    sendJson(res, 202, accepted)
    return 202
  }

  // --- POST /v1/events/{id}/ack（delivery_state → acked，只前进） -------------
  if (method === 'POST' && segments.length === 4 && segments[0] === 'v1' && segments[1] === 'events' && segments[3] === 'ack') {
    const device = requireDevice(req, sourceKey)
    const sequence = Number.parseInt(segments[2], 10)
    if (!Number.isSafeInteger(sequence) || sequence <= 0) {
      throw new ServiceError('NOT_FOUND', `gateway: no route for ${pathname}`)
    }
    markEventAcked(sequence, device.id) // NOT_FOUND/结构化错误自然上抛
    sendJson(res, 200, { acked: true })
    return 200
  }

  throw new ServiceError('NOT_FOUND', `gateway: no route for ${method} ${pathname}`)
}
