/**
 * zcodeProtocol.ts — ZCode Protocol v1 纯函数层（T2 批，docs/briefs/t2-zcode-managed.md §2.1）。
 *
 * 协议事实权威依据（先完整读，绝不猜）：acceptance/agents-mobile/
 * zcode-appserver-scout-20260912/REPORT.md（Z1 侦察：反混淆静态 + 3 次最小活体）。
 * 与 JSON-RPC 2.0 的关键差异（Z1 对照表 #1/#2/#5）：
 * - 帧无 `jsonrpc` 字段（ndjson over stdio，服务端 zod strict 逐行校验）；
 * - id 为 string|int（服务端反向请求 id 形如 "server-1"；错误 id 可为
 *   "parse-error"/"invalid-message" 等字符串）；
 * - 无 initialize 握手（方法总表不存在 initialize；首帧直接业务请求）；
 * - 服务端→客户端反向请求必须应答（不答 session/create 挂起至 -32022 超时；
 *   客户端回 -32601/-32020 时服务端有兼容回退——Z1 活体 run2 实测应答即放行）。
 *
 * 帧形态（Z1 REPORT Q1，全部以证据为源）：
 * - 请求     `{id: string|int, method, params?, trace?}`
 * - 通知     `{method, params?, trace?}`
 * - 响应     `{id, result}`
 * - 错误响应 `{id, error:{code, message, data?}}`
 *
 * electron-free 纯函数；零 IO、零 child_process、零时钟依赖（可重放）；
 * 本模块绝不携带凭据（令牌三零）。
 */

import type { SessionStatus } from '../../../../shared/types.ts'

// ---------------------------------------------------------------------------
// 帧编解码（Z1 证据形态；id 宽松 string|int）
// ---------------------------------------------------------------------------

/** 协议 id 全域：客户端请求用自增 int；服务端反向请求/解析错误用字符串。 */
export type ZcodeFrameId = string | number

export interface ZcodeRpcError {
  code: number
  message: string
  data?: unknown
}

export type ZcodeFrame =
  | { kind: 'request'; id: ZcodeFrameId; method: string; params?: unknown }
  | { kind: 'notification'; method: string; params?: unknown }
  | { kind: 'response'; id: ZcodeFrameId; result: unknown }
  | { kind: 'error'; id: ZcodeFrameId; error: ZcodeRpcError }
  | { kind: 'invalid' }

/** id 宽松判定（string|int；Z1：两类都实证）。 */
export function isZcodeFrameId(value: unknown): value is ZcodeFrameId {
  return typeof value === 'string' || typeof value === 'number'
}

/** 序列化 id（数字 id 不得丢精度——本客户端只发自增 int，安全域内）。 */
function serializeId(id: ZcodeFrameId): string | number {
  return id
}

/** 请求帧（无 jsonrpc 字段——Z1 差异 #1）。 */
export function encodeRequest(id: ZcodeFrameId, method: string, params?: Record<string, unknown>): string {
  const frame: Record<string, unknown> = { id: serializeId(id), method }
  if (params !== undefined) frame['params'] = params
  return JSON.stringify(frame)
}

/** 通知帧。 */
export function encodeNotification(method: string, params?: Record<string, unknown>): string {
  const frame: Record<string, unknown> = { method }
  if (params !== undefined) frame['params'] = params
  return JSON.stringify(frame)
}

/** 响应帧（服务端反向请求的应答用）。 */
export function encodeResponse(id: ZcodeFrameId, result: unknown): string {
  return JSON.stringify({ id: serializeId(id), result })
}

/** 错误响应帧（未实现的 server-request 回 -32601，Z1 差异 #3）。 */
export function encodeErrorResponse(id: ZcodeFrameId, code: number, message: string): string {
  return JSON.stringify({ id: serializeId(id), error: { code, message } })
}

/**
 * 逐行解析（容忍 trace 等附加字段；非法/半帧 → invalid，由调用方计数）。
 * 判定序（Z1 帧形态互斥）：有 id → method 在 = 请求 / error 在 = 错误响应 /
 * result 键在 = 响应；无 id → method 在 = 通知；其余 invalid。
 */
export function parseZcodeFrame(line: string): ZcodeFrame {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return { kind: 'invalid' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'invalid' }
  const obj = parsed as Record<string, unknown>
  if (obj['id'] !== undefined) {
    if (!isZcodeFrameId(obj['id'])) return { kind: 'invalid' }
    if (typeof obj['method'] === 'string' && obj['method'].length > 0) {
      const frame: { kind: 'request'; id: ZcodeFrameId; method: string; params?: unknown } = {
        kind: 'request',
        id: obj['id'],
        method: obj['method'],
      }
      if (obj['params'] !== undefined) frame['params'] = obj['params']
      return frame
    }
    const err = obj['error']
    if (err !== null && typeof err === 'object' && !Array.isArray(err)) {
      const e = err as Record<string, unknown>
      if (typeof e['code'] === 'number' && typeof e['message'] === 'string') {
        const error: ZcodeRpcError = { code: e['code'], message: e['message'] }
        if (e['data'] !== undefined) error['data'] = e['data']
        return { kind: 'error', id: obj['id'], error }
      }
    }
    if ('result' in obj) return { kind: 'response', id: obj['id'], result: obj['result'] }
    return { kind: 'invalid' }
  }
  if (typeof obj['method'] === 'string' && obj['method'].length > 0) {
    const frame: { kind: 'notification'; method: string; params?: unknown } = { kind: 'notification', method: obj['method'] }
    if (obj['params'] !== undefined) frame['params'] = obj['params']
    return frame
  }
  return { kind: 'invalid' }
}

// ---------------------------------------------------------------------------
// server-request 分发器（Z1 差异 #3：服务端反向请求必须应答）
// ---------------------------------------------------------------------------

/**
 * `session/requestRuntimePreferences` 默认四字段（主控定案 #3：false/false/false/
 * 默认策略）。应答帧形态以 Z1 活体 run2/run3 为源（服务端收到四字段即放行 create）；
 * `modelContextBudgetStrategy` 取 Z1 实证值 "preflight-v1"（证据：
 * probe/appserver-lifecycle-probe-run2.log/run3-envconfig.log）。
 */
export const ZCODE_RUNTIME_PREFERENCES_DEFAULT: Readonly<{
  nativeSearchEnhancementsEnabled: boolean
  memoryEnabled: boolean
  askUserQuestionAutoResolutionEnabled: boolean
  modelContextBudgetStrategy: string
}> = {
  nativeSearchEnhancementsEnabled: false,
  memoryEnabled: false,
  askUserQuestionAutoResolutionEnabled: false,
  modelContextBudgetStrategy: 'preflight-v1',
} as const

/**
 * `interaction/requestPermission` v1 一律 denied（主控定案 #3：保守诚实，UI 路由
 * 留后续批）。注：denied 应答的精确 schema 未在 Z1 活体中出现（Z1 仅静态枚举该方法），
 * 此处取最保守的 `{decision:'denied'}` 结果帧；协议歧义以 Z1 证据为准——若服务端
 * 不识别该形态，其兼容回退（客户端 -32601/-32020 时回退默认值，Z1 REPORT Q1 实测
 * 注记）保证会话不挂起；权限拒绝语义不因回退翻转。
 */
export const ZCODE_PERMISSION_DENIED_RESULT: Readonly<{ decision: 'denied' }> = { decision: 'denied' } as const

/** 通用 method-not-found 错误码（Z1 活体：未知方法 → -32601）。 */
export const ZCODE_METHOD_NOT_FOUND = -32601

export type ZcodeServerRequestDecision =
  | { kind: 'result'; result: unknown }
  | { kind: 'error'; code: number; message: string }

/**
 * 纯判定：对服务端反向请求给出应答体（不含 id——由调用方回填原帧 id）。
 * - session/requestRuntimePreferences → 默认四字段；
 * - interaction/requestPermission → denied（v1 保守决策）；
 * - 其余（interaction/requestUserInput、requestOfficialMcpAuthHeaders、
 *   requestProviderRuntimeHeaders、browser* 等）→ -32601（服务端有兼容回退）。
 */
export function decideServerRequest(method: string): ZcodeServerRequestDecision {
  if (method === 'session/requestRuntimePreferences') return { kind: 'result', result: ZCODE_RUNTIME_PREFERENCES_DEFAULT }
  if (method === 'interaction/requestPermission') return { kind: 'result', result: ZCODE_PERMISSION_DENIED_RESULT }
  return { kind: 'error', code: ZCODE_METHOD_NOT_FOUND, message: `DevHub does not implement server request: ${method}` }
}

/** 分发器一步到位：请求帧 → 应答行（调用方直接 writeStdin）；非请求帧 → null。 */
export function respondToServerRequest(frame: ZcodeFrame): string | null {
  if (frame.kind !== 'request') return null
  const decision = decideServerRequest(frame.method)
  if (decision.kind === 'result') return encodeResponse(frame.id, decision.result)
  return encodeErrorResponse(frame.id, decision.code, decision.message)
}

// ---------------------------------------------------------------------------
// 事件类型枚举 + 判态（Z1 静态全量枚举为源；映射沿用现有 managed 语义）
// ---------------------------------------------------------------------------

/**
 * session/event payload.type 静态全量枚举（Z1 REPORT Q1「payload.type 枚举（静态
 * 全量）」原文清单）。仅作登记/防御参照：未知类型容忍丢弃 + 计数（绝不猜）。
 */
export const ZCODE_EVENT_PAYLOAD_TYPES: readonly string[] = [
  'session.created',
  'session.resumed',
  'session.updated',
  'session.titleUpdated',
  'session.closed',
  'turn.started',
  'turn.steerQueued',
  'turn.steerDrained',
  'turn.completed',
  'turn.failed',
  'message.upserted',
  'message.removed',
  'part.started',
  'part.delta',
  'part.upserted',
  'part.removed',
  'model.streaming',
  'tool.updated',
  'permission.requested',
  'permission.resolved',
  'userInput.requested',
  'userInput.resolved',
  'checkpoint.created',
  'rewind.triggered',
  'streamRecovery.updated',
  'state.updated',
] as const

/**
 * turn.completed resultType 六值（Z1 REPORT 原文：success|cancelled|error_max_turns|
 * error_max_budget|error_during_execution|error_max_tool_calls）。
 */
export const ZCODE_TURN_RESULT_TYPES: readonly string[] = [
  'success',
  'cancelled',
  'error_max_turns',
  'error_max_budget',
  'error_during_execution',
  'error_max_tool_calls',
] as const

/**
 * session/event 通知 params 形态（Z1：params 含 seq,eventId,sessionId,turnId,
 * deliveryKind,payload）。payload.type 为上述枚举。
 */
export interface ZcodeSessionEventParams {
  sessionId: string
  seq: number | null
  type: string
  resultType: string | null
  turnId: string | null
  deliveryKind: string | null
}

/**
 * 从 session/event 通知 params 提取投影输入（容忍形态漂移：缺键 → null，绝不抛）。
 * 非该方法的通知返回 null。
 */
export function extractSessionEvent(method: string, params: unknown): ZcodeSessionEventParams | null {
  if (method !== 'session/event') return null
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return null
  const p = params as Record<string, unknown>
  const sessionId = typeof p['sessionId'] === 'string' ? p['sessionId'] : null
  if (sessionId === null) return null
  const payload = p['payload']
  const type =
    payload !== null && typeof payload === 'object' && !Array.isArray(payload) && typeof (payload as Record<string, unknown>)['type'] === 'string'
      ? ((payload as Record<string, unknown>)['type'] as string)
      : null
  if (type === null) return null
  const resultType =
    payload !== null && typeof payload === 'object' && !Array.isArray(payload) && typeof (payload as Record<string, unknown>)['resultType'] === 'string'
      ? ((payload as Record<string, unknown>)['resultType'] as string)
      : null
  const turnId = typeof p['turnId'] === 'string' ? p['turnId'] : null
  const deliveryKind = typeof p['deliveryKind'] === 'string' ? p['deliveryKind'] : null
  const seq = typeof p['seq'] === 'number' && Number.isFinite(p['seq']) ? p['seq'] : null
  return { sessionId, seq, type, resultType, turnId, deliveryKind }
}

/**
 * 事件 → 9 值状态判定（docs/12 §5 判定表精神：判定源明确才产生，绝不猜）。
 * 映射沿用现有 managed 语义（codex 托管面：DevHub 自己的 turn 终止事件有第一手
 * 判定源 → task_complete=waiting_input、interrupt=paused）：
 * - turn.started → running（DevHub session/send 后 turn 在途）
 * - turn.completed 按 resultType 如实映射：
 *     success → waiting_input（turn 正常收尾，会话闲置等下一条输入——codex managed 同义）
 *     cancelled → paused（软中断收尾：session/stop 或服务端取消——codex turn_aborted 同义）
 *     error_*（max_turns/max_budget/during_execution/max_tool_calls）→ failed
 *     未登录取值 → unknown（判定未定，绝不猜——升级防御）
 * - turn.failed → failed
 * - permission.requested → approval_required（v1 客户端侧回 denied 后由
 *   permission.resolved 收敛；判定如实投影会话事件）
 * - userInput.requested → waiting_input
 * - session.closed → stopped（有终态记录的正常停止）
 * - 其余类型 → null（无状态证据；message/part/tool 等内容事件走同库转录面，零额外工作）
 */
export function evalZcodeEventStatus(type: string, resultType: string | null): SessionStatus | null {
  switch (type) {
    case 'turn.started':
      return 'running'
    case 'turn.completed': {
      switch (resultType) {
        case 'success':
          return 'waiting_input'
        case 'cancelled':
          return 'paused'
        case 'error_max_turns':
        case 'error_max_budget':
        case 'error_during_execution':
        case 'error_max_tool_calls':
          return 'failed'
        default:
          return 'unknown'
      }
    }
    case 'turn.failed':
      return 'failed'
    case 'permission.requested':
      return 'approval_required'
    case 'userInput.requested':
      return 'waiting_input'
    case 'session.closed':
      return 'stopped'
    default:
      return null
  }
}

/**
 * turn 终止判定（provider 消费循环用）：turn.completed / turn.failed / session.closed
 * = 本轮消费收尾沿。
 */
export function isTurnTerminalEvent(type: string): boolean {
  return type === 'turn.completed' || type === 'turn.failed' || type === 'session.closed'
}
