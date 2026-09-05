/**
 * eventUplink.ts — 事件上行桥（M2-R1 模块 3/8，docs/19 §4.3）。
 *
 * 职责（docs/20 §2.1 R1 范围行「eventPipeline 多 sink 注入 + hello.sequence 断线
 * 回填 + lastSentSeq 水位」）：
 * 1. **多 sink 注入**：eventPipeline 已备 relay sink 缝（setRelayEventSink，与
 *    gateway WS sink 相互独立、COMMIT 后按序调用、失败不回滚 DB）。本模块注册
 *    relay sink：事件 → Relay event 帧（H→E）推送；写 socket 成功（sendFrame
 *    未抛 = 已交 ECS，host 腿 delivered 语义，蓝本 ws.ts 夜间#1 同款）→
 *    markEventDelivered（事件行聚合推进；设备粒度 ack 由 sync_request 累计游标
 *    经 markEventsAckedThrough 回写，见 eventPipeline）。
 * 2. **投影规则**（docs/18 §3.6/§4，字段面以 fixture + R2 裁定为准）：判别
 *    type:'event'、事件类型在 eventType（R2 裁定①）；seq→sequence、createdAt→
 *    timestamp 改名；provider/sessionId/summary 可选缺省不伪造；
 *    requiresUserAction = 白名单制（仅 session.waiting_input 且 payload.status
 *    ∈ {waiting_input, approval_required} 为 true，docs/18 §4.2——未来新增类型
 *    缺省 false，绝不猜）。
 * 3. **断线回填**：重连 hello.sequence 给出 ECS 缓存水位 → eventsSince(watermark,
 *    null) 分页（100/页，ECS 按 sequence UNIQUE 幂等去重——重复无害双保险）补推
 *    event 帧；ECS 已有的帧照样重发（幂等），本端零重复判定职责。
 * 4. **lastSentSeq 水位**：已成功交 ECS 的最高 sequence；心跳帧（H→E）携带；
 *    settings `relay_last_sent_seq` 持久化（docs/19 §4.3，普通键值非凭据）防进程
 *    重启后重复回填。水位只在「写 socket 成功」时前进（绝不虚报）。
 *
 * electron-free；写库仅经 eventPipeline L3 函数（markEventDelivered，约束 #20）。
 */

import {
  eventsSince,
  markEventDelivered,
  setRelayEventSink,
  type RelayEventSink,
  EVENTS_SINCE_DEFAULT_LIMIT,
} from '../eventPipeline.ts'
import { getSetting, setSetting } from '../../settingsService.ts'
import type { HostToEcsFrame } from './wsClient.ts'

// ---------------------------------------------------------------------------
// 投影规则（集中一处防漂移，docs/19 §4.3「投影函数集中一处」）
// ---------------------------------------------------------------------------

/** requiresUserAction 白名单（docs/18 §4.2：仅 waiting_input 两态为 true）。 */
const REQUIRES_USER_ACTION_STATUSES: readonly string[] = ['waiting_input', 'approval_required']

/**
 * requiresUserAction 投影（白名单制，绝不猜）：仅 session.waiting_input 且
 * payload.status ∈ {waiting_input, approval_required} → true；其余全部 6 类与
 * 未来新增类型恒 false。
 */
export function requiresUserActionFor(eventType: string, payload: Record<string, unknown>): boolean {
  if (eventType !== 'session.waiting_input') return false
  const status = payload.status
  return typeof status === 'string' && (REQUIRES_USER_ACTION_STATUSES as readonly string[]).includes(status)
}

/** 事件上行帧输入（RelayEventSink 形态 + provider；eventsSince 行同构）。 */
export interface RelayEventFrameInput {
  sequence: number
  eventId: string
  eventType: string
  payload: Record<string, unknown>
  sessionId: number | null
  summary?: string | null
  createdAt: number
  provider: string | null
}

/**
 * 事件 → Relay event 帧投影（H→E；docs/18 §4.1 字段映射 + fixture 裁定面）：
 * 可选字段（provider/sessionId/summary）缺省不伪造；eventId 无值不可能发生
 * （agent_events.event_id NOT NULL）——防御性折叠为空串以保帧形完整。
 */
export function projectRelayEventFrame(event: RelayEventFrameInput): HostToEcsFrame {
  const frame: HostToEcsFrame = {
    type: 'event',
    sequence: event.sequence,
    eventId: event.eventId ?? '',
    eventType: event.eventType,
    timestamp: event.createdAt,
    payload: event.payload,
    requiresUserAction: requiresUserActionFor(event.eventType, event.payload),
  }
  if (event.provider !== null && event.provider.length > 0) {
    ;(frame as { provider?: string }).provider = event.provider
  }
  if (event.sessionId !== null) {
    ;(frame as { sessionId?: number }).sessionId = event.sessionId
  }
  if (event.summary !== undefined && event.summary !== null && event.summary.length > 0) {
    ;(frame as { summary?: string }).summary = event.summary
  }
  return frame
}

// ---------------------------------------------------------------------------
// 上行接线（多 sink 注入 + 水位）
// ---------------------------------------------------------------------------

/** 上行宿主接口（relayClient/index.ts 实现；smoke 以捕获数组注入）。 */
export interface EventUplinkHost {
  /** 连接就绪（ready 态）时为 true；离线时 sink 记录水位、不投帧（回填兜底）。 */
  isReady(): boolean
  /** 发送一帧（写 socket 未抛 = true = 已交 ECS）。 */
  sendEvent(frame: HostToEcsFrame): boolean
}

/** 进程内水位（内存镜像；持久化在 settings relay_last_sent_seq）。 */
let lastSentSeq = 0
/** 宿主接线（setEventUplinkHost 幂等覆盖；smoke 重置用）。 */
let uplinkHost: EventUplinkHost | null = null
/** 已注册 relay sink 标记（防重复注册）。 */
let sinkRegistered = false

/** 当前水位（心跳帧 lastSentSeq 数据源）。 */
export function currentLastSentSeq(): number {
  return lastSentSeq
}

/** 水位恢复（进程启动/接线时：settings 持久值与内存镜像取大——绝不回退）。 */
export function restoreLastSentSeq(): void {
  const persisted = Number.parseInt(getSetting('relay_last_sent_seq') ?? '0', 10)
  if (Number.isSafeInteger(persisted) && persisted > lastSentSeq) {
    lastSentSeq = persisted
  }
}

/** 水位前进（只在写 socket 成功路径调用；持久化失败不阻断投递——内存镜像兜底）。 */
function advanceLastSentSeq(sequence: number): void {
  if (sequence <= lastSentSeq) return
  lastSentSeq = sequence
  try {
    setSetting('relay_last_sent_seq', String(sequence))
  } catch {
    /* 持久化失败不阻断投递（幂等回填兜底，docs/19 §4.3） */
  }
}

/** smoke/测试复位（内存水位归零；生产不调用）。 */
export function resetEventUplinkState(): void {
  lastSentSeq = 0
  uplinkHost = null
}

/**
 * 停止/注销（relayClient.stop 路径）：宿主摘除 + relay sink 注销（事件回到
 * 「只落库、离线回填兜底」语义）+ 注册标记复位（下次 setEventUplinkHost 重新注册）。
 * 水位不清零（持久层与内存镜像保留——stop/start 往返不回退，docs/18 §6.2 只前进）。
 */
export function clearEventUplinkHost(): void {
  uplinkHost = null
  sinkRegistered = false
  setRelayEventSink(null)
}

/**
 * 注册上行（幂等）：relay sink 注入 eventPipeline 多 sink 缝 + 水位恢复。
 * sink 投递语义：离线（非 ready）→ 只记录（COMMIT 已完成，回填兜底）；在线 →
 * 投帧成功即 markEventDelivered + 水位前进。sink 异常绝不外抛（eventPipeline
 * 已隔离，这里双保险）。
 */
export function setEventUplinkHost(host: EventUplinkHost): void {
  uplinkHost = host
  restoreLastSentSeq()
  if (sinkRegistered) return
  sinkRegistered = true
  const sink: RelayEventSink = (event) => {
    deliverEvent(event)
  }
  setRelayEventSink(sink)
}

/** 单事件投递（sink 与回填共用；返回是否已交 ECS）。 */
function deliverEvent(event: RelayEventFrameInput): boolean {
  if (uplinkHost === null || !uplinkHost.isReady()) {
    return false // 离线：零投递，重连回填兜底（COMMIT 已完成不回滚）
  }
  const frame = projectRelayEventFrame(event)
  if (!uplinkHost.sendEvent(frame)) {
    return false // 写失败：不标记（sync/回填兜底）
  }
  try {
    markEventDelivered(event.sequence)
  } catch {
    /* 标记失败不影响投递（只前进语义，重发幂等） */
  }
  advanceLastSentSeq(event.sequence)
  return true
}

// ---------------------------------------------------------------------------
// 断线回填（hello.sequence 水位起点；docs/19 §4.3 三步恢复序第①步）
// ---------------------------------------------------------------------------

export interface BackfillResult {
  /** 实际补推帧数（含 ECS 侧幂等去重的重复帧）。 */
  sent: number
  /** 补发窗口扫描到的最高 sequence（空窗 → null）。 */
  scannedThrough: number | null
  /** 分页遍历次数（诊断）。 */
  pages: number
}

/**
 * 断线回填：从 ECS 水位 watermark 起分页补推全部未 ack 事件（eventsSince(watermark,
 * null)——设备粒度 ack 经聚合状态过滤；无设备上下文形态即「未被任何 ack 覆盖」）。
 * 串行分页直到 hasMore:false；单页投递失败即止（剩余留给下次回填——写失败意味着
 * 连接异常，继续翻页只会重复失败）。
 */
export function backfillFromWatermark(watermark: number): BackfillResult {
  let after = Number.isSafeInteger(watermark) && watermark > 0 ? watermark : 0
  let sent = 0
  let pages = 0
  let scannedThrough: number | null = null
  while (true) {
    const page = eventsSince(after, null, EVENTS_SINCE_DEFAULT_LIMIT)
    pages += 1
    for (const row of page.events) {
      const delivered = deliverEvent({
        sequence: row.sequence,
        eventId: row.eventId,
        eventType: row.eventType,
        payload: row.payload,
        sessionId: row.sessionId,
        summary: row.summary,
        createdAt: row.createdAt,
        provider: row.provider,
      })
      if (delivered) {
        sent += 1
        scannedThrough = row.sequence
      } else {
        // 写失败：即刻中止（连接异常，剩余留给下次回填；已送达部分水位已前进）
        return { sent, scannedThrough, pages }
      }
    }
    if (!page.hasMore || page.events.length === 0) break
    after = page.events[page.events.length - 1].sequence
  }
  return { sent, scannedThrough, pages }
}
