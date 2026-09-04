/**
 * eventPipeline.ts — 事件归一化 / event_id 派生 / 去重 / 落库 / 投递（docs/12 §6）。
 *
 * 7 event_type（docs/12 §6 全集）：
 *   session.started | session.status_changed | session.waiting_input |
 *   session.finished | message.appended | provider.health_changed | command.result
 *
 * 语义（裁决 5，强制）：
 * 1. 先写 SQLite 再投递：单事务内 INSERT agent_events + INSERT event_deliveries
 *    (pending) × 活跃设备（无活跃设备则 0 行），COMMIT 后才调用投递回调；
 *    投递失败不回滚 DB（WS 投递接口留桩给 AC6，AC3 投递 = 落 deliveries 行）。
 * 2. sequence 单调递增：agent_events.id AUTOINCREMENT（docs/13 §4.4）。
 * 3. 去重：event_id 唯一（<provider>:<native_id>:<type>:<内容指纹> 派生）；
 *    重放同一文件段不产生重复事件。
 * 4. payload / summary 一律先脱敏再落库（redact.ts 全覆盖，事件/消息/日志零明文凭据）。
 *
 * status_changed 仅状态 ≠ 旧值才发：比较归 L3（applySessionStatus），本模块
 * 只提供 recordWaitingInputEvent 的 status 两值校验（'waiting_input' | 'approval_required'）。
 *
 * AC4 收口（docs/16 §1 AC4 行）：delivery_state 状态机 API（markEventDelivered /
 * markEventAcked，只前进不回退，供 AC6 Gateway 调用）+ 补发查询 API
 * （eventsSince(seq, deviceId)，基于 deliveries 状态，供 WS sync 补发）。
 * 未确认事件绝不删除：本模块零 DELETE 路径（smoke 静态断言）。
 *
 * electron-free：零 electron import，可被 smoke 在系统 Node 下直接加载；
 * 一切 SQL 参数绑定（约束 #11）。
 */

import { createHash, randomUUID } from 'node:crypto'
import { getDatabase } from '../../db/index.ts'
import type { AgentEventTypeWaitStatus } from './providerRegistry.ts'
import type { EventDeliveryState } from '../../../shared/types.ts'
import { ServiceError, dbVal, nowSec } from '../internal.ts'
import { redactText, redactValueDeep } from './redact.ts'
import { recordLatencySample } from './latencyStats.ts'

/** 7 event_type 全集（docs/12 §6）。 */
export const AGENT_EVENT_TYPES = [
  'session.started',
  'session.status_changed',
  'session.waiting_input',
  'session.finished',
  'message.appended',
  'provider.health_changed',
  'command.result',
] as const

export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number]

/** session.waiting_input payload.status 两值全集（docs/12 §6）。 */
export const WAITING_INPUT_PAYLOAD_STATUSES = ['waiting_input', 'approval_required'] as const satisfies readonly AgentEventTypeWaitStatus[]

/** 终态集合：session.finished 的 finalStatus 合法值（docs/12 §6）。 */
export const FINISHED_STATUSES = ['completed', 'failed', 'stopped'] as const

/** 事件摘要上限（docs/12 §6：≤120 字符脱敏摘要）。 */
const SUMMARY_MAX_CHARS = 120
/** 内容指纹 hash 截断长度（event_id 第 4 段）。 */
const FINGERPRINT_HEX_CHARS = 16

/** payload 深度脱敏：字符串值过 redactText；敏感键名（token 等）整值打码（redact.ts）。 */
export function redactPayloadDeep(payload: Record<string, unknown>): Record<string, unknown> {
  return redactValueDeep(payload) as Record<string, unknown>
}

/**
 * event_id 派生：`<provider>:<native_id>:<type>:<内容指纹>`（docs/12 §6 语义 3）。
 * 指纹 = sha256(fingerprintSource) 前 16 hex；native_id 为空时以 '-' 占位。
 */
export function deriveEventId(providerKey: string, nativeId: string, eventType: AgentEventType, fingerprintSource: string): string {
  const hash = createHash('sha256').update(fingerprintSource, 'utf8').digest('hex')
  return `${providerKey}:${nativeId.length > 0 ? nativeId : '-'}:${eventType}:${hash.slice(0, FINGERPRINT_HEX_CHARS)}`
}

/** 投递回调（COMMIT 后调用）。AC6 接 WS 帧发送；AC3 默认无 sink（投递=落 deliveries 行）。 */
export interface EventDeliverySink {
  (event: {
    sequence: number
    eventId: string
    eventType: AgentEventType
    payload: Record<string, unknown>
    sessionId: number | null
    /**
     * AC6 修复：脱敏摘要（redactText 后 ≤120）——docs/14 §B.2 事件帧 summary
     * 字段的数据源（与 sync 补发路径 eventsSince 的 row.summary 同源），无摘要为 null。
     */
    summary?: string | null
    /** agent_events.created_at（unix 秒；WS event 帧 createdAt 字段的数据源）。 */
    createdAt: number
  }): void
}

let deliverySink: EventDeliverySink | null = null

/** 注册投递回调（AC6 WS 接线点；smoke 用它断言「先落库后投递」顺序）。 */
export function setEventDeliverySink(sink: EventDeliverySink | null): void {
  deliverySink = sink
}

export interface EventRecordInput {
  eventType: AgentEventType
  /** provider 业务键（'codex' 等）；agent_providers 行不存在时 provider_id 落 NULL。 */
  providerKey?: string
  sessionId?: number
  nativeId?: string
  /** 脱敏前负载；落库前经 redactPayloadDeep。 */
  payload?: Record<string, unknown>
  /** 脱敏前摘要；落库前 redactText + 截断 120。 */
  summary?: string
  /**
   * 内容指纹源（缺省 = 脱敏后 payload JSON）；重放同段内容时相同指纹 → event_id
   * 相同 → 去重（docs/12 §6 语义 3）。
   */
  fingerprint?: string
}

export interface EventRecordResult {
  /** false = event_id 已存在（重放去重），sequence 为既有行 id。 */
  recorded: boolean
  /** agent_events.id（全局 sequence）。 */
  sequence: number | null
  eventId: string
  /** 本次事务写入的 event_deliveries 行数（活跃设备数；无设备 = 0）。 */
  deliveries: number
}

function resolveProviderId(providerKey: string): number | null {
  const row = getDatabase().prepare('SELECT id FROM agent_providers WHERE provider = ?').get(providerKey) as
    | { id: number }
    | undefined
  return row !== undefined ? row.id : null
}

/**
 * 单事件落库（先 DB 后投递，docs/12 §6 语义 1）：
 * BEGIN → INSERT agent_events → INSERT event_deliveries(pending)×活跃设备 → COMMIT
 * →（COMMIT 后）deliverySink。event_id 已存在时零写入直接返回（重放幂等）。
 */
export function recordEvent(input: EventRecordInput): EventRecordResult {
  const db = getDatabase()
  const providerKey = input.providerKey ?? '-'
  const payload = redactPayloadDeep(input.payload ?? {})
  const payloadJson = JSON.stringify(payload)
  const eventId = deriveEventId(providerKey, input.nativeId ?? '', input.eventType, input.fingerprint ?? payloadJson)
  const summary = input.summary !== undefined ? redactText(input.summary).slice(0, SUMMARY_MAX_CHARS) : null

  const existing = db.prepare('SELECT id FROM agent_events WHERE event_id = ?').get(eventId) as { id: number } | undefined
  if (existing !== undefined) {
    return { recorded: false, sequence: Number(existing.id), eventId, deliveries: 0 }
  }

  const providerId = input.providerKey !== undefined ? resolveProviderId(input.providerKey) : null
  const now = nowSec()
  db.exec('BEGIN')
  try {
    const info = db
      .prepare(
        'INSERT INTO agent_events (provider_id, session_id, event_type, event_id, payload_json, summary, delivery_state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(dbVal(providerId), dbVal(input.sessionId), input.eventType, eventId, payloadJson, summary, 'pending', now)
    const sequence = Number(info.lastInsertRowid)
    const devices = db.prepare("SELECT id FROM remote_devices WHERE status = 'active'").all() as { id: number }[]
    let deliveries = 0
    if (devices.length > 0) {
      const insertDelivery = db.prepare(
        "INSERT OR IGNORE INTO event_deliveries (event_id, device_id, status, created_at) VALUES (?, ?, 'pending', ?)",
      )
      for (const device of devices) {
        const r = insertDelivery.run(sequence, device.id, now)
        deliveries += Number(r.changes)
      }
    }
    db.exec('COMMIT')
    // COMMIT 后才投递（docs/12 §6 语义 1）；投递失败不回滚 DB。
    // R5.1（ux 批 A）：db-to-ws 分段打点（agent_events.created_at → WS 投递回调触发）。
    if (deliverySink !== null) {
      recordLatencySample('db-to-ws', Date.now() - now * 1000)
      try {
        deliverySink({
          sequence,
          eventId,
          eventType: input.eventType,
          payload,
          sessionId: input.sessionId ?? null,
          summary,
          createdAt: now,
        })
      } catch {
        // 投递异常不影响落库结果（重连补发兜底，AC6）
      }
    }
    return { recorded: true, sequence, eventId, deliveries }
  } catch (err) {
    db.exec('ROLLBACK')
    throw new ServiceError('DB_ERROR', `agent event persist failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * session.waiting_input 专用入口：payload.status 两值强制校验
 * （'waiting_input' | 'approval_required'，docs/12 §6 event 表第 3 行）。
 */
export function recordWaitingInputEvent(input: {
  providerKey: string
  sessionId: number
  nativeId: string
  status: AgentEventTypeWaitStatus
  summary?: string
}): EventRecordResult {
  if (!(WAITING_INPUT_PAYLOAD_STATUSES as readonly string[]).includes(input.status)) {
    throw new ServiceError('BAD_PAYLOAD', `waiting_input payload.status must be one of: ${WAITING_INPUT_PAYLOAD_STATUSES.join(' | ')}`)
  }
  return recordEvent({
    eventType: 'session.waiting_input',
    providerKey: input.providerKey,
    sessionId: input.sessionId,
    nativeId: input.nativeId,
    payload: { sessionId: input.sessionId, nativeId: input.nativeId, status: input.status },
    summary: input.summary,
    fingerprint: `${input.nativeId}:${input.status}:${input.summary ?? ''}`,
  })
}

/** command.result 事件入口（command 终态；AC3 的 IPC sessionAction 不落远程指令流水，AC6 REST 路径复用本入口）。 */
export function recordCommandResult(input: {
  providerKey?: string
  sessionId?: number
  nativeId?: string
  commandId: string
  action: string
  status: 'executed' | 'rejected' | 'failed' | 'expired'
  errorCode?: string
}): EventRecordResult {
  return recordEvent({
    eventType: 'command.result',
    providerKey: input.providerKey,
    sessionId: input.sessionId,
    nativeId: input.nativeId,
    payload: {
      commandId: input.commandId,
      action: input.action,
      status: input.status,
      ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
    },
    fingerprint: `${input.commandId}:${input.status}:${randomUUID()}`,
  })
}

// ---------------------------------------------------------------------------
// AC4 — delivery_state 状态机 + 补发查询（docs/12 §6 语义 4/5；AC6 Gateway 消费）
//
// 状态机：pending(0) → delivered(1) → acked(2)，只前进不回退：
//   - markEventDelivered：pending → delivered（acked 保持 acked，拒绝回退）；
//   - markEventAcked：pending|delivered → acked（ack 可跳过 delivered 直达）；
//   - 设备粒度：带 deviceId 时先动 event_deliveries 行，再聚合 agent_events
//     （全 acked → acked；全 ≥delivered → delivered；否则保持 pending——docs/13
//     §4.7「聚合态由 L3 维护」的本实现落点）。
// 未确认事件绝不删除：本模块与整个 AC 域不存在任何 DELETE agent_events /
// DELETE event_deliveries 路径（smoke 静态断言，T13 配套）。
// ---------------------------------------------------------------------------

/** delivery_state 前进秩（只前进不回退的比较依据）。 */
const DELIVERY_RANK: Record<EventDeliveryState, number> = { pending: 0, delivered: 1, acked: 2 }

export interface DeliveryTransitionResult {
  /** false = 已处于目标或更靠后的状态（只前进语义下的合法拒绝）。 */
  updated: boolean
  /** 转移后 agent_events.delivery_state 聚合值。 */
  state: EventDeliveryState
}

function readEventRow(sequence: number): { id: number; delivery_state: string } {
  const row = getDatabase().prepare('SELECT id, delivery_state FROM agent_events WHERE id = ?').get(sequence) as
    | { id: number; delivery_state: string }
    | undefined
  if (row === undefined) {
    throw new ServiceError('NOT_FOUND', `agent event ${sequence} not found`)
  }
  return row
}

/** 聚合 agent_events.delivery_state（设备行存在时按设备行聚合，否则用事件行自身）。 */
function aggregateDeliveryState(eventId: number): EventDeliveryState {
  const rows = getDatabase().prepare('SELECT status FROM event_deliveries WHERE event_id = ?').all(eventId) as Array<{
    status: string
  }>
  if (rows.length === 0) return 'pending'
  const states = rows.map((r) => (r.status === 'delivered' || r.status === 'acked' ? r.status : 'pending'))
  if (states.every((s) => s === 'acked')) return 'acked'
  if (states.every((s) => s === 'delivered' || s === 'acked')) return 'delivered'
  return 'pending'
}

/** 只前进聚合写回：设备粒度转移 → 按设备行重算聚合；无设备形态 → 目标值直推事件行。
 *  两种形态都受「只前进」约束（新秩 ≤ 当前秩则保持不变）。 */
function advanceAggregate(eventId: number, target: EventDeliveryState, at: number, hasDeviceContext: boolean): EventDeliveryState {
  const db = getDatabase()
  const row = db.prepare('SELECT delivery_state FROM agent_events WHERE id = ?').get(eventId) as
    | { delivery_state: string }
    | undefined
  const stored = asState(row?.delivery_state ?? 'pending')
  const desired: EventDeliveryState = hasDeviceContext ? aggregateDeliveryState(eventId) : target
  const finalState = DELIVERY_RANK[desired] > DELIVERY_RANK[stored] ? desired : stored
  if (DELIVERY_RANK[finalState] > DELIVERY_RANK[stored]) {
    db.prepare(
      'UPDATE agent_events SET delivery_state = ?, delivered_at = COALESCE(delivered_at, ?), acked_at = ? WHERE id = ?',
    ).run(finalState, finalState === 'pending' ? null : at, finalState === 'acked' ? at : null, eventId)
  }
  return finalState
}

/**
 * 标记已投递（pending → delivered；供 AC6 Gateway WS 发送成功后调用）。
 * 带 deviceId：先推进该设备的 event_deliveries 行，再聚合事件行；
 * 不带 deviceId：直接推进事件行（无设备粒度场景/本地广播事件）。
 */
export function markEventDelivered(sequence: number, deviceId?: number): DeliveryTransitionResult {
  const db = getDatabase()
  const row = readEventRow(sequence)
  const now = nowSec()
  let deviceChanged = false
  db.exec('BEGIN')
  try {
    if (deviceId !== undefined) {
      const r = db
        .prepare(
          "UPDATE event_deliveries SET status = 'delivered', delivered_at = ? WHERE event_id = ? AND device_id = ? AND status = 'pending'",
        )
        .run(now, sequence, deviceId)
      deviceChanged = Number(r.changes) > 0
    }
    const state = advanceAggregate(row.id, 'delivered', now, deviceId !== undefined)
    db.exec('COMMIT')
    return { updated: deviceChanged || state !== asState(row.delivery_state), state }
  } catch (err) {
    db.exec('ROLLBACK')
    throw err instanceof ServiceError ? err : new ServiceError('DB_ERROR', `markEventDelivered failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * 标记已确认（pending|delivered → acked；供 AC6 设备 ack 调用）。
 * acked 是终态：其后的 markEventDelivered 只前进语义下被拒绝（updated:false）。
 */
export function markEventAcked(sequence: number, deviceId?: number): DeliveryTransitionResult {
  const db = getDatabase()
  const row = readEventRow(sequence)
  const now = nowSec()
  let deviceChanged = false
  db.exec('BEGIN')
  try {
    if (deviceId !== undefined) {
      const r = db
        .prepare(
          "UPDATE event_deliveries SET status = 'acked', acked_at = ?, delivered_at = COALESCE(delivered_at, ?) WHERE event_id = ? AND device_id = ? AND status IN ('pending', 'delivered')",
        )
        .run(now, now, sequence, deviceId)
      deviceChanged = Number(r.changes) > 0
    }
    const state = advanceAggregate(row.id, 'acked', now, deviceId !== undefined)
    db.exec('COMMIT')
    return { updated: deviceChanged || state !== asState(row.delivery_state), state }
  } catch (err) {
    db.exec('ROLLBACK')
    throw err instanceof ServiceError ? err : new ServiceError('DB_ERROR', `markEventAcked failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function asState(value: string): EventDeliveryState {
  return value === 'delivered' || value === 'acked' ? value : 'pending'
}

/** 补发行投影（payload 已脱敏——落库前经 redactPayloadDeep，此处不再二次处理）。 */
export interface EventReplayRow {
  /** agent_events.id = 全局 sequence。 */
  sequence: number
  eventId: string
  eventType: string
  /** 事件归属会话（provider.health_changed 等无会话事件为 null；AC6 WS event 帧投影）。 */
  sessionId: number | null
  /** 脱敏摘要（可为 null；AC6 WS event 帧 summary 字段的数据源）。 */
  summary: string | null
  payload: Record<string, unknown>
  deliveryState: EventDeliveryState
  createdAt: number
}

export interface EventReplayPage {
  events: EventReplayRow[]
  /** true = 仍有更多未确认事件（下次从 last sequence 续拉）。 */
  hasMore: boolean
}

/** 补发查询缺省页大小（AC6 WS sync 帧复用）。 */
export const EVENTS_SINCE_DEFAULT_LIMIT = 100

/**
 * 补发查询（docs/12 §6 语义 5「重连补发」的 L3 侧数据源；AC6 WS sync 消费）：
 * 返回 sequence > afterSequence 且对该设备未确认（ack）的事件，按 sequence 升序。
 * - deviceId 为 null（无设备上下文）：按事件行聚合状态过滤（delivery_state ≠ acked）。
 * - deviceId 给定：按 event_deliveries 设备行过滤——该设备已 ack 的排除；
 *   无设备投递行的事件（设备配对前产生）视同未确认，一并补发。
 * 未确认事件绝不删除，因此补发窗口天然完整（ack 即移出补发集）。
 */
export function eventsSince(afterSequence: number, deviceId: number | null, limit: number = EVENTS_SINCE_DEFAULT_LIMIT): EventReplayPage {
  const capped = Math.max(1, Math.min(limit, 200))
  const db = getDatabase()
  const after = Number.isSafeInteger(afterSequence) && afterSequence > 0 ? afterSequence : 0
  const rows = (
    deviceId !== null
      ? db
          .prepare(
            `SELECT e.id, e.session_id, e.event_id, e.event_type, e.summary, e.payload_json, e.delivery_state, e.created_at
             FROM agent_events e
             WHERE e.id > ? AND NOT EXISTS (
               SELECT 1 FROM event_deliveries d WHERE d.event_id = e.id AND d.device_id = ? AND d.status = 'acked'
             )
             ORDER BY e.id ASC LIMIT ?`,
          )
          .all(after, deviceId, capped + 1)
      : db
          .prepare(
            `SELECT e.id, e.session_id, e.event_id, e.event_type, e.summary, e.payload_json, e.delivery_state, e.created_at
             FROM agent_events e
             WHERE e.id > ? AND e.delivery_state != 'acked'
             ORDER BY e.id ASC LIMIT ?`,
          )
          .all(after, capped + 1)
  ) as unknown as Array<{
    id: number
    session_id: number | null
    event_id: string
    event_type: string
    summary: string | null
    payload_json: string
    delivery_state: string
    created_at: number
  }>

  const hasMore = rows.length > capped
  const events: EventReplayRow[] = rows.slice(0, capped).map((row) => {
    let payload: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(row.payload_json) as unknown
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>
    } catch {
      // 损坏 JSON → 空 payload（宁缺毋滥）
    }
    return {
      sequence: Number(row.id),
      eventId: row.event_id,
      eventType: row.event_type,
      sessionId: row.session_id === null ? null : Number(row.session_id),
      summary: row.summary,
      payload,
      deliveryState: asState(row.delivery_state),
      createdAt: Number(row.created_at),
    }
  })
  return { events, hasMore }
}

/**
 * 当前全局 sequence（WS hello 帧的 sequence 字段数据源，docs/14 §B.2）：
 * agent_events.id 为 AUTOINCREMENT 单调递增（docs/13 §4.4）；空表 → 0。
 * 只读查询（gateway 层读库豁免裁决适用；写路径仍全部在本模块）。
 */
export function currentGlobalSequence(): number {
  const row = getDatabase().prepare('SELECT MAX(id) AS m FROM agent_events').get() as { m: number | null }
  return row.m === null ? 0 : Number(row.m)
}
