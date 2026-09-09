/**
 * reminderEngine.ts — ContestPin 提醒引擎（CP4 批次，docs/22 §7 + 任务书 §1.1）。
 *
 * - electron-free 纯 Node 模块（contestService/overlayStateService 同纪律）：计划
 *   计算（planReminder/computeDue/scanCatchUp）为纯函数——nowSec 由调用方注入，
 *   smoke 直测；SQL 全参数绑定静态字面量（约束 #11）；结构化 ServiceError（约束 #14）。
 * - 时间语义（docs/22 §2.2 + 任务书 §1.1 权威）：
 *   · before_days：date 精度节点按自然日语义 → 「节点日 - N 自然日」的当日 09:00
 *     本地（fire_key 取自然日桶，时钟扰动不重复）；exact 精度按 start_at 秒级减
 *     N*86400（秒桶）；month 精度无自然日语义 → 计划期跳过（flag）。
 *   · before_hours：start_at - N*3600，仅 exact 节点合法（date/month/tbd 拒绝——
 *     upsert 期 BAD_PAYLOAD；计划期 flag 兜底，精度后续变更仍安全）。
 *   · at_time：start_at 时刻本身（offset_value 恒 0）。
 *   · tbd 节点 start_at 恒 NULL → 无计划（missing_start_at）。
 * - done 节点全部提醒停扫；已过期超 1 自然日（86400s）的计划不再产 due；
 *   补发窗口默认 48h（scanCatchUp，更早的错过记 skipped 统计，绝不补发）。
 * - 幂等去重根 = contest_reminder_log UNIQUE(reminder_id, fire_key)：触发即
 *   INSERT（INSERT OR IGNORE，冲突 = 已发过跳过）；fireKey 形如
 *   `r<reminderId>@d<YYYY-MM-DD>`（自然日桶）或 `r<reminderId>@s<fireAt>`（秒桶）。
 * - 通知经注入 applier（materialService setClipboardImageReader 先例）：wire 层
 *   （notifyWire.ts）注册生产 Electron Notification；纯 Node/测试语境未注入或
 *   applier 抛错 → 结构化降级（账本行照写 = in-app 记录，绝不向上抛）。
 */

import type { DatabaseSync } from 'node:sqlite'
import { getDatabase } from '../../db/index.ts'
import { logger } from '../../core/logger.ts'
import type {
  ContestReminderChannel,
  ContestReminderLogEntry,
  ContestReminderLogListPayload,
  ContestReminderLogListResult,
  ContestReminderOffsetKind,
  ContestReminderDeletePayload,
  ContestReminderDeleteStart,
  ContestReminderDeleteResult,
  ContestReminderUpsertPayload,
  ContestReminderRuleInput,
  ContestReminderView,
} from '../../../shared/types.ts'
import { nowSec, ServiceError } from '../internal.ts'

// ---------------------------------------------------------------------------
// 常量（任务书 §1.1 权威语义的数值锚点）
// ---------------------------------------------------------------------------

/** computeDue 的过期地板：计划已过期超过 1 自然日 → 不产 due（任务书 §1.1 #1）。 */
export const REMINDER_DUE_PAST_FLOOR_SEC = 86_400
/** scanCatchUp 补发窗口默认 48h：更早的错过不再补，记 skipped 统计（任务书 §1.1 #2）。 */
export const REMINDER_CATCHUP_WINDOW_SEC_DEFAULT = 48 * 3_600
/** date 精度 before_days 的当日触发时刻（本地 09:00，任务书 §1.1 #1）。 */
export const REMINDER_DAY_BUCKET_HOUR = 9
/** reminderLogList 分页边界（contestpin:list 同款：默认 100、上限 200）。 */
export const REMINDER_LOG_LIMIT_MAX = 200
const REMINDER_LOG_LIMIT_DEFAULT = 100

/** 提醒规则枚举白名单（contestService 同款第二道运行期防线，错误码 BAD_PAYLOAD）。 */
export const CONTEST_REMINDER_OFFSET_KINDS: readonly ContestReminderOffsetKind[] = [
  'before_days',
  'before_hours',
  'at_time',
]
export const CONTEST_REMINDER_CHANNELS: readonly ContestReminderChannel[] = ['windows', 'in_app']

// ---------------------------------------------------------------------------
// 纯逻辑：计划计算（plan → due/catch-up 扫描）
// ---------------------------------------------------------------------------

/** 引擎输入的提醒规则（enabled=false 的规则在扫描层直接忽略）。 */
export interface EngineReminder {
  id: number
  nodeId: number
  offsetKind: ContestReminderOffsetKind
  offsetValue: number
  enabled: boolean
}

/** 引擎输入的节点投影（precision/start_at/done 即决定计划的全部字段）。 */
export interface EngineNode {
  id: number
  precision: 'exact' | 'date' | 'month' | 'tbd'
  startAt: number | null
  done: boolean
}

/** 单条提醒的计划触发时刻（任务书 §1.1 返回形状 + 桶类型供 fire_key 语义可读）。 */
export interface ReminderDueItem {
  reminderId: number
  nodeId: number
  /** 计划触发时刻 unix 秒。 */
  fireAt: number
  /** 去重键（自然日桶 `@d<YYYY-MM-DD>` / 秒桶 `@s<sec>`）。 */
  fireKey: string
}

/** 计划不可计算的 flag（upsert 期已挡 before_hours 非法组合，此处是运行期兜底）。 */
export type ReminderSkipReason =
  | 'node_done'
  | 'missing_start_at'
  | 'before_hours_non_exact'
  | 'month_precision_unsupported'

export interface ReminderPlanSkip {
  reminderId: number
  nodeId: number
  reason: ReminderSkipReason
}

/** scanCatchUp 的跳过统计（补发窗口外的错过不补发，只记账）。 */
export type CatchUpSkipReason = ReminderSkipReason | 'already_fired' | 'outside_catchup_window'

export interface ReminderSkippedItem {
  reminderId: number
  nodeId: number
  reason: CatchUpSkipReason
}

export interface CatchUpState {
  reminders: readonly EngineReminder[]
  nodes: readonly EngineNode[]
  /** contest_reminder_log 已存在的 fire_key 集合（幂等去重根）。 */
  firedKeys: ReadonlySet<string>
}

/**
 * date 精度自然日语义：start_at 当地日历日偏移 shiftDays 天后的 hour:00 整点
 * （本地时区，DST 由 JS Date 语义兜底）。纯函数，便于 smoke 精确断言。
 */
export function localDayAt(sec: number, shiftDays: number, hour: number): number {
  const d = new Date(sec * 1000)
  return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate() + shiftDays, hour, 0, 0, 0).getTime() / 1000)
}

/** 本地日历日 YYYY-MM-DD（自然日桶 fire_key 用）。 */
function localDayKey(sec: number): string {
  const d = new Date(sec * 1000)
  const p = (n: number): string => (n < 10 ? `0${n}` : String(n))
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** fire_key（任务书 §1.1：`r<reminderId>@<fireAt 自然日桶或秒桶>`）。 */
export function fireKeyFor(reminderId: number, fireAt: number, bucket: 'day' | 'sec'): string {
  return bucket === 'day' ? `r${reminderId}@d${localDayKey(fireAt)}` : `r${reminderId}@s${fireAt}`
}

/**
 * 单条提醒的计划触发时刻（纯函数；不可计算返回 flag，绝不抛）。
 * 语义权威 docs/22 §2.2/§7 + 任务书 §1.1 #1（见文件头）。
 */
export function planReminder(reminder: EngineReminder, node: EngineNode): ReminderDueItem | ReminderPlanSkip {
  const base = { reminderId: reminder.id, nodeId: reminder.nodeId }
  if (node.done) return { ...base, reason: 'node_done' }
  if (node.startAt === null) return { ...base, reason: 'missing_start_at' }

  if (reminder.offsetKind === 'at_time') {
    return { ...base, fireAt: node.startAt, fireKey: fireKeyFor(reminder.id, node.startAt, 'sec') }
  }
  if (reminder.offsetKind === 'before_hours') {
    if (node.precision !== 'exact') return { ...base, reason: 'before_hours_non_exact' }
    const fireAt = node.startAt - reminder.offsetValue * 3_600
    return { ...base, fireAt, fireKey: fireKeyFor(reminder.id, fireAt, 'sec') }
  }
  // before_days
  if (node.precision === 'exact') {
    const fireAt = node.startAt - reminder.offsetValue * 86_400
    return { ...base, fireAt, fireKey: fireKeyFor(reminder.id, fireAt, 'sec') }
  }
  if (node.precision === 'date') {
    // 自然日语义：节点日 - N 自然日的当日 09:00 本地（自然日桶对时钟扰动鲁棒）
    const fireAt = localDayAt(node.startAt, -reminder.offsetValue, REMINDER_DAY_BUCKET_HOUR)
    return { ...base, fireAt, fireKey: fireKeyFor(reminder.id, fireAt, 'day') }
  }
  return { ...base, reason: 'month_precision_unsupported' }
}

/**
 * computeDue（任务书 §1.1 #1）：enabled 提醒在未 done 节点上的到期计划——
 * fireAt 已到（<= now）且过期不超过 1 自然日；已过期超 1 自然日的计划不产 due。
 * 返回按 fireAt 升序（先到先触发）。
 */
export function computeDue(
  reminders: readonly EngineReminder[],
  nodes: readonly EngineNode[],
  now: number,
): ReminderDueItem[] {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]))
  const due: ReminderDueItem[] = []
  for (const reminder of reminders) {
    if (!reminder.enabled) continue
    const node = nodeMap.get(reminder.nodeId)
    if (node === undefined) continue
    const planned = planReminder(reminder, node)
    if (!('fireAt' in planned)) continue
    if (planned.fireAt <= now && now - planned.fireAt < REMINDER_DUE_PAST_FLOOR_SEC) {
      due.push({ reminderId: planned.reminderId, nodeId: planned.nodeId, fireAt: planned.fireAt, fireKey: planned.fireKey })
    }
  }
  return due.sort((a, b) => a.fireAt - b.fireAt || a.reminderId - b.reminderId)
}

/**
 * scanCatchUp（任务书 §1.1 #2）：启动/恢复/时钟变化后的补发扫描——due 已过且
 * 账本无该 fire_key 且在补发窗口内 → toFire；窗口外记 skipped（outside_catchup_window，
 * 绝不补发）；账本已存在（已发过）记 skipped（already_fired）；不可计算计划记
 * skipped（对应 flag）。toFire 按 fireAt 升序。
 */
export function scanCatchUp(
  state: CatchUpState,
  now: number,
  opts?: { windowSec?: number },
): { toFire: ReminderDueItem[]; skipped: ReminderSkippedItem[] } {
  const windowSec = opts?.windowSec ?? REMINDER_CATCHUP_WINDOW_SEC_DEFAULT
  const nodeMap = new Map(state.nodes.map((n) => [n.id, n]))
  const toFire: ReminderDueItem[] = []
  const skipped: ReminderSkippedItem[] = []
  for (const reminder of state.reminders) {
    const base = { reminderId: reminder.id, nodeId: reminder.nodeId }
    if (!reminder.enabled) continue
    const node = nodeMap.get(reminder.nodeId)
    if (node === undefined) continue
    const planned = planReminder(reminder, node)
    if (!('fireAt' in planned)) {
      skipped.push({ ...base, reason: planned.reason })
      continue
    }
    if (planned.fireAt > now) continue // 尚未到期：既不补发也不算错过
    if (state.firedKeys.has(planned.fireKey)) {
      skipped.push({ ...base, reason: 'already_fired' })
      continue
    }
    if (now - planned.fireAt > windowSec) {
      skipped.push({ ...base, reason: 'outside_catchup_window' })
      continue
    }
    toFire.push({
      reminderId: planned.reminderId,
      nodeId: planned.nodeId,
      fireAt: planned.fireAt,
      fireKey: planned.fireKey,
    })
  }
  toFire.sort((a, b) => a.fireAt - b.fireAt || a.reminderId - b.reminderId)
  return { toFire, skipped }
}

// ---------------------------------------------------------------------------
// 通知 applier 注入位（materialService setClipboardImageReader 先例；wire 层
// notifyWire 注册生产 Electron Notification；electron-free/测试语境为 null →
// 结构化降级为 in-app 记录，绝不抛）
// ---------------------------------------------------------------------------

/** 引擎递给通知面的载荷（title/body 已在此定稿，通知面只负责展示与点击）。 */
export interface ReminderFireNotification {
  reminderId: number
  nodeId: number
  contestId: number
  contestName: string
  nodeLabel: string
  offsetKind: ContestReminderOffsetKind
  offsetValue: number
  fireAt: number
  fireKey: string
  title: string
  body: string
}

/** windows 通道通知实现（生产 = Electron Notification + 点击导航 contest:<id>）。 */
export type NotifyApplier = (notification: ReminderFireNotification) => void

let notifyApplier: NotifyApplier | null = null

export function setNotifyApplier(applier: NotifyApplier | null): void {
  notifyApplier = applier
}

/** 提前量描述文案（通知 body 用；纯函数）。 */
export function describeOffset(offsetKind: ContestReminderOffsetKind, offsetValue: number): string {
  if (offsetKind === 'before_days') return `提前 ${offsetValue} 天`
  if (offsetKind === 'before_hours') return `提前 ${offsetValue} 小时`
  return '时间到'
}

// ---------------------------------------------------------------------------
// SQL 静态字面量（约束 #11：零拼接/零插值，取值全 ? 绑定）
// ---------------------------------------------------------------------------

/** enabled 提醒 + 节点精度/时刻 + 所属比赛名的单查投影（扫描驱动唯一取数面）。 */
const SCAN_SOURCE_SQL = `
  SELECT r.id AS reminder_id, r.node_id, r.offset_kind, r.offset_value, r.channel, r.enabled,
         n.precision, n.start_at, n.done, n.label AS node_label, n.contest_id,
         c.name AS contest_name
  FROM contest_reminders r
  JOIN contest_nodes n ON n.id = r.node_id
  JOIN contests c ON c.id = n.contest_id
  WHERE r.enabled = 1`
const LOG_KEYS_ALL_SQL = 'SELECT fire_key FROM contest_reminder_log'
const LOG_INSERT_SQL =
  'INSERT OR IGNORE INTO contest_reminder_log (reminder_id, node_id, fire_at, fire_key, created_at) VALUES (?, ?, ?, ?, ?)'
const REMINDER_TOUCH_FIRED_SQL = 'UPDATE contest_reminders SET last_fired_at = ?, updated_at = ? WHERE id = ?'
const NODE_ROW_SQL = 'SELECT * FROM contest_nodes WHERE id = ?'
const REMINDER_ROW_BY_UNIQUE_SQL =
  'SELECT * FROM contest_reminders WHERE node_id = ? AND offset_kind = ? AND offset_value = ? AND channel = ?'
const REMINDER_ROW_BY_ID_SQL = 'SELECT * FROM contest_reminders WHERE id = ?'
const REMINDER_INSERT_SQL =
  'INSERT INTO contest_reminders (node_id, offset_kind, offset_value, channel, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
const REMINDER_UPDATE_BY_UNIQUE_SQL =
  'UPDATE contest_reminders SET enabled = ?, updated_at = ? WHERE node_id = ? AND offset_kind = ? AND offset_value = ? AND channel = ?'
const REMINDER_DELETE_SQL = 'DELETE FROM contest_reminders WHERE id = ?'
const LOG_COUNT_BY_REMINDER_SQL = 'SELECT COUNT(*) AS c FROM contest_reminder_log WHERE reminder_id = ?'
const LOG_LIST_SQL = `
  SELECT l.id, l.reminder_id, l.node_id, l.fire_at, l.fire_key, l.created_at,
         r.offset_kind, r.offset_value, r.channel,
         n.label AS node_label, n.contest_id, c.name AS contest_name
  FROM contest_reminder_log l
  JOIN contest_reminders r ON r.id = l.reminder_id
  JOIN contest_nodes n ON n.id = l.node_id
  JOIN contests c ON c.id = n.contest_id
  ORDER BY l.fire_at DESC, l.id DESC
  LIMIT ?`
const LOG_COUNT_SINCE_SQL = 'SELECT COUNT(*) AS c FROM contest_reminder_log WHERE created_at >= ?'

interface ReminderDbRow {
  id: number
  node_id: number
  offset_kind: string
  offset_value: number
  channel: string
  enabled: number
  last_fired_at: number | null
  created_at: number
  updated_at: number
}

interface ScanSourceRow {
  reminder_id: number
  node_id: number
  offset_kind: string
  offset_value: number
  channel: string
  enabled: number
  node_label: string
  contest_id: number
  contest_name: string
  precision: string
  start_at: number | null
  done: number
}

interface LogListRow {
  id: number
  reminder_id: number
  node_id: number
  fire_at: number
  fire_key: string
  created_at: number
  offset_kind: string
  offset_value: number
  channel: string
  node_label: string
  contest_id: number
  contest_name: string
}

function toReminderView(row: ReminderDbRow): ContestReminderView {
  return {
    id: row.id,
    nodeId: row.node_id,
    offsetKind: row.offset_kind as ContestReminderOffsetKind,
    offsetValue: row.offset_value,
    channel: row.channel as ContestReminderChannel,
    enabled: row.enabled === 1,
    lastFiredAt: row.last_fired_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function badRequest(detail: string): ServiceError {
  return new ServiceError('BAD_PAYLOAD', `reminder: ${detail}`)
}

// ---------------------------------------------------------------------------
// 通道 service：contestpin:reminderUpsert / reminderDelete / reminderLogList
// ---------------------------------------------------------------------------

/** 规则形状校验（枚举白名单 + offsetValue 语义；before_hours 的精度合法性强校验在此）。 */
function resolveRuleInput(
  db: DatabaseSync,
  nodeId: number,
  rule: ContestReminderRuleInput | undefined | null,
): { offsetKind: ContestReminderOffsetKind; offsetValue: number; channel: ContestReminderChannel; enabled: boolean } {
  if (typeof rule !== 'object' || rule === null || Array.isArray(rule)) {
    throw badRequest('upsert: rule { offsetKind, channel } is required')
  }
  const offsetKind = rule.offsetKind
  if ((CONTEST_REMINDER_OFFSET_KINDS as readonly string[]).includes(offsetKind) === false) {
    throw badRequest(`upsert: rule.offsetKind must be one of: ${CONTEST_REMINDER_OFFSET_KINDS.join(' | ')}`)
  }
  if ((CONTEST_REMINDER_CHANNELS as readonly string[]).includes(rule.channel) === false) {
    throw badRequest(`upsert: rule.channel must be one of: ${CONTEST_REMINDER_CHANNELS.join(' | ')}`)
  }
  let offsetValue: number
  if (offsetKind === 'at_time') {
    if (rule.offsetValue !== undefined && rule.offsetValue !== 0) {
      throw badRequest('upsert: rule.offsetValue must be 0/undefined for at_time (恒 0)')
    }
    offsetValue = 0
  } else {
    if (typeof rule.offsetValue !== 'number' || !Number.isSafeInteger(rule.offsetValue) || rule.offsetValue < 0) {
      throw badRequest(`upsert: rule.offsetValue must be a non-negative integer for ${offsetKind}`)
    }
    offsetValue = rule.offsetValue
  }

  const node = db.prepare(NODE_ROW_SQL).get(nodeId) as
    | { id: number; precision: string; start_at: number | null }
    | undefined
  if (node === undefined) {
    throw new ServiceError('NOT_FOUND', `reminder upsert: contest node ${nodeId} not found`)
  }
  // before_hours 仅 exact 节点合法（任务书 §1.1 #1「BAD_PAYLOAD 或 flag」——upsert 期
  // 选 BAD_PAYLOAD 硬挡，计划期 planReminder 另有 flag 兜底精度后续变更）
  if (offsetKind === 'before_hours' && node.precision !== 'exact') {
    throw badRequest(`upsert: before_hours requires an 'exact' node (node ${nodeId} precision='${node.precision}')`)
  }
  return { offsetKind, offsetValue, channel: rule.channel, enabled: rule.enabled !== false }
}

/**
 * contestpin:reminderUpsert（任务书 §1.3 #7）：UNIQUE(node_id, offset_kind,
 * offset_value, channel) 冲突 = 更新（enabled/updated_at），id 不变。
 */
export function upsertReminderRule(payload: ContestReminderUpsertPayload): ContestReminderView {
  const db = getDatabase()
  if (typeof payload?.nodeId !== 'number' || !Number.isSafeInteger(payload.nodeId) || payload.nodeId < 1) {
    throw badRequest('upsert: nodeId must be a positive integer')
  }
  const rule = resolveRuleInput(db, payload.nodeId, payload.rule)

  let result: { changes: number | bigint; lastInsertRowid: number | bigint }
  const now = nowSec()
  try {
    result = db
      .prepare(REMINDER_INSERT_SQL)
      .run(payload.nodeId, rule.offsetKind, rule.offsetValue, rule.channel, rule.enabled ? 1 : 0, now, now)
  } catch (err) {
    // UNIQUE 冲突 = 更新既有规则（任务书 §1.3 #7）。node:sqlite（Node 24）错误形态：
    // code='ERR_SQLITE_ERROR' + message 'UNIQUE constraint failed: ...'；部分版本在
    // code/errCode 携带 SQLITE_CONSTRAINT_*——两种形态都识别。
    const errCode = String((err as { code?: string }).code ?? '')
    const isUniqueConflict =
      errCode.startsWith('SQLITE_CONSTRAINT') ||
      (err instanceof Error && err.message.includes('UNIQUE constraint failed'))
    if (!isUniqueConflict) throw err
    db.prepare(REMINDER_UPDATE_BY_UNIQUE_SQL).run(
      rule.enabled ? 1 : 0,
      now,
      payload.nodeId,
      rule.offsetKind,
      rule.offsetValue,
      rule.channel,
    )
    const updated = db.prepare(REMINDER_ROW_BY_UNIQUE_SQL).get(payload.nodeId, rule.offsetKind, rule.offsetValue, rule.channel) as
      | ReminderDbRow
      | undefined
    if (updated === undefined) {
      throw new ServiceError('NOT_FOUND', 'reminder upsert: rule row disappeared after unique-update')
    }
    return toReminderView(updated)
  }
  const created = db.prepare(REMINDER_ROW_BY_ID_SQL).get(Number(result.lastInsertRowid)) as ReminderDbRow | undefined
  if (created === undefined) {
    throw new ServiceError('NOT_FOUND', 'reminder upsert: rule row disappeared after insert')
  }
  return toReminderView(created)
}

/**
 * contestpin:reminderDelete（CONFIRM_REQUIRED 两段式，任务书 §1.3 #7）：缺省回
 * impacts={logRows}（触发账本行数）；confirmed 后删提醒行（log 随 FK CASCADE 一并删）。
 */
export function deleteReminderRule(payload: ContestReminderDeletePayload): ContestReminderDeleteStart | ContestReminderDeleteResult {
  const db = getDatabase()
  if (typeof payload?.id !== 'number' || !Number.isSafeInteger(payload.id) || payload.id < 1) {
    throw badRequest('delete: id must be a positive integer')
  }
  const row = db.prepare(REMINDER_ROW_BY_ID_SQL).get(payload.id) as ReminderDbRow | undefined
  if (row === undefined) {
    throw new ServiceError('NOT_FOUND', `reminder ${payload.id} not found`)
  }
  const logRows = Number((db.prepare(LOG_COUNT_BY_REMINDER_SQL).get(row.id) as { c: number | bigint }).c)
  if (payload.confirmed !== true) {
    return { confirmRequired: true, impacts: { logRows } }
  }
  db.prepare(REMINDER_DELETE_SQL).run(row.id)
  logger.info(`reminder delete: reminder ${row.id} removed (logRows=${logRows})`)
  return { confirmRequired: undefined, removed: true }
}

/**
 * contestpin:reminderLogList（READ_ONLY，任务书 §1.3 #7）：近期触发账本 + 顶栏
 * 小铃铛聚合数（近 24h 已触发 / 未来 24h 待触发；轮询本通道，无推送面）。
 */
export function listReminderLog(payload: ContestReminderLogListPayload = {}): ContestReminderLogListResult {
  const db = getDatabase()
  const limit = Math.min(payload.limit ?? REMINDER_LOG_LIMIT_DEFAULT, REMINDER_LOG_LIMIT_MAX)
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw badRequest('logList: limit must be a positive integer when present')
  }

  const now = nowSec()
  const rows = db.prepare(LOG_LIST_SQL).all(limit) as unknown as LogListRow[]
  const entries: ContestReminderLogEntry[] = rows.map((row) => ({
    id: row.id,
    reminderId: row.reminder_id,
    nodeId: row.node_id,
    contestId: row.contest_id,
    contestName: row.contest_name,
    nodeLabel: row.node_label,
    offsetKind: row.offset_kind as ContestReminderOffsetKind,
    offsetValue: row.offset_value,
    channel: row.channel as ContestReminderChannel,
    fireAt: row.fire_at,
    fireKey: row.fire_key,
    createdAt: row.created_at,
  }))

  const firedLast24h = Number(
    (db.prepare(LOG_COUNT_SINCE_SQL).get(now - REMINDER_DUE_PAST_FLOOR_SEC) as { c: number | bigint }).c,
  )
  // 未来 24h 待触发：enabled 规则（含 channel 全量）× 未 done 节点计划落在 (now, now+24h]
  const sources = db.prepare(SCAN_SOURCE_SQL).all() as unknown as ScanSourceRow[]
  let upcoming24h = 0
  for (const row of sources) {
    const planned = planReminder(
      {
        id: row.reminder_id,
        nodeId: row.node_id,
        offsetKind: row.offset_kind as ContestReminderOffsetKind,
        offsetValue: row.offset_value,
        enabled: true,
      },
      { id: row.node_id, precision: row.precision as EngineNode['precision'], startAt: row.start_at, done: row.done === 1 },
    )
    if ('fireAt' in planned && planned.fireAt > now && planned.fireAt <= now + REMINDER_DUE_PAST_FLOOR_SEC) {
      upcoming24h += 1
    }
  }

  return { entries, summary: { firedLast24h, upcoming24h } }
}

// ---------------------------------------------------------------------------
// 触发驱动（notifyWire 60s 桶扫 / powerMonitor resume / clock-change 共用；
// 可注入 now 供 smoke 确定性断言；绝不向上抛——调度循环里的异常只记日志）
// ---------------------------------------------------------------------------

export type ReminderScanMode = 'tick' | 'catchup'

export interface ReminderScanStats {
  mode: ReminderScanMode
  /** 本轮发现的到期计划数。 */
  due: number
  /** 实际落账触发数（INSERT 成功；fire_key 冲突不重复计）。 */
  fired: number
  /** 账本已写但 windows 通知不可用/失败（降级 in-app 记录）数。 */
  degraded: number
  /** 补发窗口外错过数（仅 catchup 模式，绝不补发）。 */
  skippedOutsideWindow: number
}

/** 单次触发：INSERT 账本（冲突=已发过跳过）→ touch last_fired_at → windows 通道交 applier。 */
function fireOnce(
  db: DatabaseSync,
  source: ScanSourceRow,
  item: ReminderDueItem,
  now: number,
): { fired: boolean; degraded: boolean } {
  const insert = db.prepare(LOG_INSERT_SQL).run(item.reminderId, item.nodeId, item.fireAt, item.fireKey, now)
  if (Number(insert.changes) === 0) {
    return { fired: false, degraded: false } // fire_key 冲突 = 已发过（幂等去重根）
  }
  db.prepare(REMINDER_TOUCH_FIRED_SQL).run(now, now, item.reminderId)
  if (source.channel !== 'windows') {
    return { fired: true, degraded: false } // in_app：账本即记录（contest_reminder_log 即账本）
  }
  if (notifyApplier === null) {
    return { fired: true, degraded: true } // 未注入（纯 Node/测试）→ 结构化降级，不抛
  }
  try {
    notifyApplier({
      reminderId: item.reminderId,
      nodeId: item.nodeId,
      contestId: source.contest_id,
      contestName: source.contest_name,
      nodeLabel: source.node_label,
      offsetKind: source.offset_kind as ContestReminderOffsetKind,
      offsetValue: source.offset_value,
      fireAt: item.fireAt,
      fireKey: item.fireKey,
      title: `比赛提醒 · ${source.contest_name}`,
      body: `${source.node_label} · ${describeOffset(source.offset_kind as ContestReminderOffsetKind, source.offset_value)}`,
    })
    return { fired: true, degraded: false }
  } catch (err) {
    // 通知失败（系统禁专注助手等）降级 in-app 记录，不抛（任务书 §1.2 #4）
    logger.warn(`reminder notify failed (reminder ${item.reminderId}): ${err instanceof Error ? err.message : String(err)}`)
    return { fired: true, degraded: true }
  }
}

/**
 * 一轮扫描（任务书 §1.2 #5）：
 *  - tick（60s 桶扫）：computeDue（含 1 自然日过期地板）→ 逐条 fireOnce（账本去重）；
 *  - catchup（启动/恢复/时钟变化）：scanCatchUp（默认 48h 窗口）→ 逐条 fireOnce。
 * done 节点停扫由计划层承担（planReminder node_done flag）；统计结构化返回，
 * 异常只记日志绝不抛（调度循环稳定性优先）。
 */
export function runReminderScan(options?: { mode?: ReminderScanMode; now?: number; windowSec?: number }): ReminderScanStats {
  const mode = options?.mode ?? 'tick'
  const now = options?.now ?? nowSec()
  const stats: ReminderScanStats = { mode, due: 0, fired: 0, degraded: 0, skippedOutsideWindow: 0 }
  try {
    const db = getDatabase()
    const sources = db.prepare(SCAN_SOURCE_SQL).all() as unknown as ScanSourceRow[]
    const reminders: EngineReminder[] = []
    const nodes = new Map<number, EngineNode>()
    for (const row of sources) {
      reminders.push({
        id: row.reminder_id,
        nodeId: row.node_id,
        offsetKind: row.offset_kind as ContestReminderOffsetKind,
        offsetValue: row.offset_value,
        enabled: row.enabled === 1,
      })
      nodes.set(row.node_id, {
        id: row.node_id,
        precision: row.precision as EngineNode['precision'],
        startAt: row.start_at,
        done: row.done === 1,
      })
    }
    if (reminders.length === 0) return stats

    let dueItems: ReminderDueItem[]
    if (mode === 'catchup') {
      const firedKeys = new Set(
        (db.prepare(LOG_KEYS_ALL_SQL).all() as unknown as { fire_key: string }[]).map((r) => r.fire_key),
      )
      const result = scanCatchUp(
        { reminders, nodes: [...nodes.values()], firedKeys },
        now,
        options?.windowSec !== undefined ? { windowSec: options.windowSec } : undefined,
      )
      dueItems = result.toFire
      stats.skippedOutsideWindow = result.skipped.filter((s) => s.reason === 'outside_catchup_window').length
    } else {
      dueItems = computeDue(reminders, [...nodes.values()], now)
    }
    stats.due = dueItems.length

    for (const item of dueItems) {
      const source = sources.find((r) => r.reminder_id === item.reminderId)
      if (source === undefined) continue
      const outcome = fireOnce(db, source, item, now)
      if (outcome.fired) stats.fired += 1
      if (outcome.degraded) stats.degraded += 1
    }
    if (stats.fired > 0) {
      logger.info(`reminder scan(${mode}): due=${stats.due} fired=${stats.fired} degraded=${stats.degraded}`)
    }
    return stats
  } catch (err) {
    logger.error(`reminder scan(${mode}) failed: ${err instanceof Error ? err.message : String(err)}`)
    return stats
  }
}
