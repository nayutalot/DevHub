/**
 * deepseekProtocol.ts — DeepSeek Harness SDK runtime 协议纯函数层（DM 批，
 * docs/briefs/dm-dsh-managed.md §1.1；协议事实权威 = docs/27 §1.2/§1.6 + 本机
 * HROOT 源码 D:\Apps\deepseek-harness\packages\sdk\*（@deepseek-ai/dsh-sdk-protocol
 * 0.1.0-rc.5，全部 文件:行号 证据已复核））。
 *
 * wire 形态（transport.ts:121-160、:201-257）：
 * - ndjson JSON-RPC 2.0 over stdio；出站请求帧 `{jsonrpc:'2.0', id:'req_<uuid>',
 *   method, params}`（SDK client 同款 id 形态）；
 * - **入站帧不校验 `jsonrpc` 字段**（transport.ts:201-224 只看 id/method/error/
 *   result 键；畸形行静默忽略）→ 与 zcodeProtocol.parseZcodeFrame 的判定序
 *   完全同构（docs/27 §1.6：DSH 入站帧可被现有解析器零改动解析）——本模块
 *   **直接复用 parseZcodeFrame**（最小侵入，零复制），出站编码补 `jsonrpc:'2.0'`；
 * - 未知方法 → -32601（server 侧）；handler 抛错 → -32603；**SDK 协议无服务端
 *   反向请求**（4 个方法全是 server→client 通知，docs/27 §1.6）——本客户端对
 *   入站 request 帧结构化回 -32601（冗余防御，zcode 分发器先例）。
 *
 * 方法全集（types.ts:16-104）：
 * - 请求 initialize{cwd,provider,model,maxTokens?} → {serverInfo:{name,version}}
 *   （name 恒 'deepseek-harness-sdk-runtime'）；session/prompt{sessionId,
 *   contentBlocks:[{type:'text',text}]} → {messageId}（未知 sessionId 惰性建会话，
 *   create 与 send 合一）；shutdown{} → {}（应答后 runtime 自杀 exit 0）。
 * - 通知 session.event{sessionId,event:{type,seq,time,data,…}}（44 型 firehose，
 *   **event 槽顶替 zcode 的 payload 槽**——extractDshSessionEvent 薄适配）；
 *   session.status{sessionId,status:'idle'|'running'}（idle = 回合消费收尾沿，
 *   比 zcode 多一个权威信号）；subagent.started/finished（血缘通知，v1 只登记）。
 *
 * electron-free；零 IO、零 child_process、零时钟依赖；本模块绝不携带凭据
 * （DEEPSEEK_API_KEY 由 harness credential seam 自取——凭据三零红线）。
 */

import {
  parseZcodeFrame,
  type ZcodeFrame,
  type ZcodeFrameId,
  type ZcodeRpcError,
} from './zcodeProtocol.ts'
import type { SessionStatus } from '../../../../shared/types.ts'

// ---------------------------------------------------------------------------
// 帧编解码（SDK transport.ts 形态；复用 zcode 解析器——docs/27 §1.6 结论）
// ---------------------------------------------------------------------------

export type DshFrameId = ZcodeFrameId
export type DshRpcError = ZcodeRpcError
/** 入站帧形态与 zcode 判定序同构（SDK 入站不校验 jsonrpc 字段）。 */
export type DshFrame = ZcodeFrame

/** 入站帧解析：直接复用 zcodeProtocol.parseZcodeFrame（零改动，docs/27 §1.6）。 */
export function parseDshFrame(line: string): DshFrame {
  return parseZcodeFrame(line)
}

/**
 * 出站请求帧（JSON-RPC 2.0 合规范；id = `req_<32hex>`，与 SDK transport.ts:121
 * 的 `req_${randomUUID().replaceAll('-','')}` 形态逐字对齐）。idGen 注入缝：
 * 生产 = randomUUID 派生；smoke 夹具注入确定性序列（可重放断言）。
 */
export function encodeDshRequest(id: string, method: string, params?: Record<string, unknown>): string {
  const frame: Record<string, unknown> = { jsonrpc: '2.0', id, method }
  if (params !== undefined) frame['params'] = params
  return JSON.stringify(frame)
}

/** 请求 id 生成器形态（生产注入 randomUUID；返回值形如 `req_<hex>`）。 */
export type DshRequestIdGen = () => string

/**
 * shutdown 请求帧（无 params——types.ts:104 params: undefined；JSON-RPC 允许
 * 省略 params 键，SDK server 的 handleRequest 只按 method 分发）。
 */
export function encodeDshShutdown(id: string): string {
  return encodeDshRequest(id, 'shutdown')
}

// ---------------------------------------------------------------------------
// 请求参数/结果投影（types.ts:16-104 形态；全部宽容提取，绝不抛）
// ---------------------------------------------------------------------------

/** initialize 请求参数（types.ts:19-31）。 */
export interface DshInitializeParams {
  cwd: string
  provider: string
  model: string
  maxTokens?: number
}

/** initialize 结果（types.ts:33-36；name 恒 deepseek-harness-sdk-runtime）。 */
export interface DshServerInfo {
  name: string
  version: string
}

/** initialize 结果宽容提取（形态漂移 → null，由调用方结构化拒绝）。 */
export function extractDshServerInfo(result: unknown): DshServerInfo | null {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return null
  const info = (result as Record<string, unknown>)['serverInfo']
  if (info === null || typeof info !== 'object' || Array.isArray(info)) return null
  const name = (info as Record<string, unknown>)['name']
  const version = (info as Record<string, unknown>)['version']
  if (typeof name !== 'string' || name.length === 0) return null
  if (typeof version !== 'string' || version.length === 0) return null
  return { name, version }
}

/** session/prompt 结果宽容提取 → durable messageId（types.ts:46）。 */
export function extractDshMessageId(result: unknown): string | null {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return null
  const messageId = (result as Record<string, unknown>)['messageId']
  return typeof messageId === 'string' && messageId.length > 0 ? messageId : null
}

// ---------------------------------------------------------------------------
// 通知消费：session.event（44 型 firehose）薄适配 + session.status + subagent.*
// ---------------------------------------------------------------------------

/**
 * session.event 通知投影（zcode extractSessionEvent 的 DSH 对位；**event 槽
 * 顶替 payload 槽**——docs/27 §1.6 对照表）。字段：
 * - sessionId（通知 params 顶层，types.ts:52）；
 * - event.type / event.seq / event.time（会话日志事件信封，core/session types.ts
 *   :404-440；seq 会话内单调）；
 * - data 原样透传（unknown 形态容忍——消费者按 44 型词表自取）。
 */
export interface DshSessionEventParams {
  sessionId: string
  type: string | null
  seq: number | null
  timeMs: number | null
  data: unknown
}

/** session.event 通知宽容提取（缺键 → null 字段；非该方法 → null）。 */
export function extractDshSessionEvent(method: string, params: unknown): DshSessionEventParams | null {
  if (method !== 'session.event') return null
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return null
  const p = params as Record<string, unknown>
  const sessionId = typeof p['sessionId'] === 'string' && p['sessionId'].length > 0 ? p['sessionId'] : null
  if (sessionId === null) return null
  const event = p['event']
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    return { sessionId, type: null, seq: null, timeMs: null, data: undefined }
  }
  const e = event as Record<string, unknown>
  const type = typeof e['type'] === 'string' ? e['type'] : null
  const seq = typeof e['seq'] === 'number' && Number.isSafeInteger(e['seq']) ? e['seq'] : null
  const timeMs = typeof e['time'] === 'number' && Number.isFinite(e['time']) ? e['time'] : null
  return { sessionId, type, seq, timeMs, data: e['data'] }
}

/** session.status 通知投影（types.ts:59-64）。 */
export interface DshSessionStatusParams {
  sessionId: string
  status: 'idle' | 'running'
}

/** session.status 通知宽容提取（status 非两值枚举 → null——绝不猜）。 */
export function extractDshSessionStatus(method: string, params: unknown): DshSessionStatusParams | null {
  if (method !== 'session.status') return null
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return null
  const p = params as Record<string, unknown>
  const sessionId = typeof p['sessionId'] === 'string' && p['sessionId'].length > 0 ? p['sessionId'] : null
  if (sessionId === null) return null
  const status = p['status']
  if (status !== 'idle' && status !== 'running') return null
  return { sessionId, status }
}

/** subagent.started 通知投影（types.ts:66-72）。 */
export interface DshSubagentStartedParams {
  parentSessionId: string
  childSessionId: string
}

/** subagent.finished 通知投影（types.ts:74-90；lastAssistantMessage 原样）。 */
export interface DshSubagentFinishedParams {
  provider: string | null
  parentSessionId: string
  childSessionId: string
  status: 'ok' | 'error' | null
  stopReason: unknown
  lastAssistantMessage: unknown
}

/** subagent.* 通知宽容提取（方法名不匹配/形态漂移 → null）。 */
export function extractDshSubagentNotice(
  method: string,
  params: unknown,
): { kind: 'started'; payload: DshSubagentStartedParams } | { kind: 'finished'; payload: DshSubagentFinishedParams } | null {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return null
  const p = params as Record<string, unknown>
  if (method === 'subagent.started') {
    const parent = p['parentSessionId']
    const child = p['childSessionId']
    if (typeof parent !== 'string' || typeof child !== 'string' || parent.length === 0 || child.length === 0) return null
    return { kind: 'started', payload: { parentSessionId: parent, childSessionId: child } }
  }
  if (method === 'subagent.finished') {
    const parent = p['parentSessionId']
    const child = p['childSessionId']
    if (typeof parent !== 'string' || typeof child !== 'string' || parent.length === 0 || child.length === 0) return null
    const status = p['status']
    return {
      kind: 'finished',
      payload: {
        provider: typeof p['provider'] === 'string' ? p['provider'] : null,
        parentSessionId: parent,
        childSessionId: child,
        status: status === 'ok' || status === 'error' ? status : null,
        stopReason: p['stopReason'],
        lastAssistantMessage: p['lastAssistantMessage'],
      },
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// 事件 → 状态判定（docs/27 §4.3-4 判定表；zcode evalZcodeEventStatus 对位）
// ---------------------------------------------------------------------------

/**
 * turn/end reason 六值词表（harness packages/acp/acp/src/codec.ts:14-34 同源；
 * docs/27 §1.6「判定表可直接平移」）。
 */
export const DSH_TURN_END_REASONS: readonly string[] = [
  'completed',
  'max-tokens',
  'aborted',
  'interrupted',
  'blocked',
  'error',
] as const

/**
 * DSH 会话日志事件 → 9 值状态判定（判定源明确才产生，绝不猜）：
 * - turn/start → running；
 * - approval/asked → approval_required（v1 无远程应答通道——SDK 协议事实，
 *   approval policy never 组合下越权操作自动拒绝、不挂起；状态如实投影）；
 * - approval/decided → running；
 * - turn/end 按 reason 如实映射：completed → waiting_input（回合正常收尾）；
 *   max-tokens → waiting_input（截断收尾仍等输入，detail 由调用方注明）；
 *   aborted → paused；interrupted → paused；blocked/error → failed；
 *   未登记录值 → unknown（绝不猜）。
 *   reason 形态（真机实测绘）：字符串 `'completed'` 或对象 `{kind:'completed'}`
 *   双形态容忍（真机 2026-09-15 实测 `{kind:'completed'}`）。
 */
export function evalDshEventStatus(type: string, data: unknown): SessionStatus | null {
  if (type === 'turn/start') return 'running'
  if (type === 'approval/asked') return 'approval_required'
  if (type === 'approval/decided') return 'running'
  if (type === 'turn/end') {
    switch (reasonKindOf(data)) {
      case 'completed':
      case 'max-tokens':
        return 'waiting_input'
      case 'aborted':
      case 'interrupted':
        return 'paused'
      case 'blocked':
      case 'error':
        return 'failed'
      default:
        return 'unknown'
    }
  }
  return null
}

/** turn/end data 的 reason 宽容归一（字符串或 `{kind}` 包裹对象；真机双形态实测）。 */
export function reasonKindOf(data: unknown): string | null {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null
  const raw = (data as Record<string, unknown>)['reason']
  if (typeof raw === 'string') return raw
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const kind = (raw as Record<string, unknown>)['kind']
    if (typeof kind === 'string') return kind
  }
  return null
}

/**
 * turn/end reason → 人类可读注记（detail 面；截断/失败如实区分）。
 */
export function describeDshTurnEnd(reason: string | null): string {
  switch (reason) {
    case 'completed':
      return 'turn ended (reason: completed)'
    case 'max-tokens':
      return 'turn ended (reason: max-tokens; output truncated)'
    case 'aborted':
      return 'turn ended (reason: aborted)'
    case 'interrupted':
      return 'turn ended (reason: interrupted)'
    case 'blocked':
      return 'turn ended (reason: blocked)'
    case 'error':
      return 'turn ended (reason: error)'
    default:
      return `turn ended (reason: ${reason ?? 'unspecified'})`
  }
}

/** turn/end data → reason 归一（evalDshEventStatus 同源；provider detail 用）。 */
export function describeDshTurnEndData(data: unknown): string {
  return describeDshTurnEnd(reasonKindOf(data))
}

/**
 * 回合消费收尾沿（provider 消费循环用；SDK 比 zcode 多一个权威 idle 信号——
 * session.status:'idle'）。turn/end 事件或 session.status idle = 本轮收尾。
 */
export function isDshTurnTerminalNotice(method: string, params: unknown): boolean {
  if (method === 'session.status') {
    const st = extractDshSessionStatus(method, params)
    return st !== null && st.status === 'idle'
  }
  if (method === 'session.event') {
    const ev = extractDshSessionEvent(method, params)
    return ev !== null && ev.type === 'turn/end'
  }
  return false
}
