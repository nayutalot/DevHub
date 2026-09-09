/**
 * contestService.ts — ContestPin 比赛域 CRUD / 时间节点 / 项目关联（CP1 批次，
 * docs/22 §2/§3 + docs/04「ContestPin 追加」节）。
 *
 * - electron-free 纯 Node 模块（db 经 getDatabase() 单例，DEVHUB_HOME 驱动），
 *   smoke 可在系统 Node 下直测；SQL 全参数绑定（约束 #11）；结构化 ServiceError
 *   （约束 #14）。
 * - 时间语义权威 = docs/22 §2.2：precision 'tbd' → start/end 恒 NULL；
 *   已有低精度（date/month/tbd）节点不得提升为 'exact'，除非 payload 显式携带
 *   原文 raw_text 依据；end_at 给定时 ≥ start_at。
 * - 资源边（docs/22 §2.3）：create/update/delete 同步维护 resources 'contest'
 *   节点（改名同步 display_name、删除显式清节点清边）；linkProject 建/删
 *   contest→project `uses` 边（INSERT OR IGNORE 幂等）。
 * - delete / nodeDelete 为 CONFIRM_REQUIRED 两段式：缺省 confirmed 回 impacts
 *   （节点/材料/提醒计数），confirmed 后级联删（表 FK CASCADE 兜底，日志记数）。
 */

import type { DatabaseSync } from 'node:sqlite'
import { getDatabase } from '../../db/index.ts'
import { logger } from '../../core/logger.ts'
import type {
  ContestArchivePayload,
  ContestCreatePayload,
  ContestDeletePayload,
  ContestDeleteResult,
  ContestDeleteStart,
  ContestDetailView,
  ContestListPayload,
  ContestListItem,
  ContestLinkedProject,
  ContestListResult,
  ContestMaterialView,
  ContestNodeDeletePayload,
  ContestNodeDeleteResult,
  ContestNodeDeleteStart,
  ContestNodeInput,
  ContestNodeKind,
  ContestNodePrecision,
  ContestNodeSource,
  ContestNodeUpsertPayload,
  ContestNodeView,
  ContestDueNode,
  ContestLinkProjectPayload,
  ContestPatch,
  ContestReminderChannel,
  ContestReminderOffsetKind,
  ContestReminderView,
  ContestStatus,
  ContestUpdatePayload,
  ContestView,
} from '../../../shared/types.ts'
import { dbVal, nowSec, ServiceError } from '../internal.ts'
import { deleteResource, registerResource, relate } from '../resourceGraph.ts'

// ---------------------------------------------------------------------------
// 枚举白名单（表内 CHECK 兜底之外的第二道运行期防线，错误码统一 BAD_PAYLOAD）
// ---------------------------------------------------------------------------

export const CONTEST_STATUSES: readonly ContestStatus[] = [
  'watching',
  'registered',
  'submitted',
  'completed',
  'given_up',
]

export const CONTEST_NODE_KINDS: readonly ContestNodeKind[] = [
  'signup_start',
  'signup_deadline',
  'payment_deadline',
  'contest_start',
  'contest_end',
  'submit_deadline',
  'custom',
]

export const CONTEST_NODE_PRECISIONS: readonly ContestNodePrecision[] = ['exact', 'date', 'month', 'tbd']

export const CONTEST_NODE_SOURCES: readonly ContestNodeSource[] = ['manual', 'imported', 'agent']

export const CONTEST_REMINDER_OFFSET_KINDS: readonly ContestReminderOffsetKind[] = [
  'before_days',
  'before_hours',
  'at_time',
]

export const CONTEST_REMINDER_CHANNELS: readonly ContestReminderChannel[] = ['windows', 'in_app']

/** year 可空；给定时 1990..2100 整数（任务书 §2.9）。 */
const CONTEST_YEAR_MIN = 1990
const CONTEST_YEAR_MAX = 2100

/** 列表分页边界（agents 列表同款：默认 100、上限 200）。 */
export const CONTEST_LIST_LIMIT_MAX = 200
const CONTEST_LIST_LIMIT_DEFAULT = 100

// ---------------------------------------------------------------------------
// 行投影
// ---------------------------------------------------------------------------

interface ContestDbRow {
  id: number
  name: string
  year: number | null
  edition: string | null
  organizer: string | null
  note: string | null
  status: string
  archived: number
  official_site: string | null
  signup_url: string | null
  submit_url: string | null
  created_at: number
  updated_at: number
}

interface ContestRowWithNodeCount extends ContestDbRow {
  node_count: number
}

interface ContestNodeDbRow {
  id: number
  contest_id: number
  kind: string
  label: string
  start_at: number | null
  end_at: number | null
  tz: string
  precision: string
  raw_text: string | null
  done: number
  done_at: number | null
  source: string
  created_at: number
  updated_at: number
}

interface ContestReminderDbRow {
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

interface ContestMaterialDbRow {
  id: number
  sha256: string
  original_name: string
  stored_path: string
  size_bytes: number | null
  pages: number | null
  kind: string
  imported_at: number
}

// 全静态语句字面量（约束 #11：SQL 文本零拼接/零插值，全部取值走 ? 绑定）
const COUNT_NODES_SQL = 'SELECT COUNT(*) AS c FROM contest_nodes WHERE contest_id = ?'
const COUNT_REMINDERS_BY_CONTEST_SQL = `
  SELECT COUNT(*) AS c FROM contest_reminders r
  JOIN contest_nodes n ON n.id = r.node_id
  WHERE n.contest_id = ?`
const COUNT_MATERIALS_BY_CONTEST_SQL = `
  SELECT COUNT(DISTINCT m.id) AS c FROM contest_materials m
  JOIN contest_import_jobs j ON j.material_id = m.id
  WHERE j.contest_id = ?`
const COUNT_REMINDERS_BY_NODE_SQL = 'SELECT COUNT(*) AS c FROM contest_reminders WHERE node_id = ?'
const LIST_NODES_SQL = 'SELECT * FROM contest_nodes WHERE contest_id = ? ORDER BY (start_at IS NULL), start_at, id'
const LIST_REMINDERS_BY_CONTEST_SQL = `
  SELECT r.* FROM contest_reminders r
  JOIN contest_nodes n ON n.id = r.node_id
  WHERE n.contest_id = ?
  ORDER BY r.id`
const LIST_MATERIALS_BY_CONTEST_SQL = `
  SELECT m.* FROM contest_materials m
  JOIN contest_import_jobs j ON j.material_id = m.id
  WHERE j.contest_id = ?
  ORDER BY m.id`
const FIND_PROJECT_BY_CONTEST_SQL = `
  SELECT p.id, p.name FROM relationships rel
  JOIN resources rs ON rs.id = rel.source_resource_id
  JOIN resources rt ON rt.id = rel.target_resource_id
  JOIN projects p ON p.id = rt.ref_id
  WHERE rs.resource_type = 'contest' AND rs.ref_id = ? AND rt.resource_type = 'project'
    AND rel.relation_type = 'uses'
  ORDER BY rel.id
  LIMIT 1`
const DELETE_USES_EDGES_SQL = `
  DELETE FROM relationships
  WHERE relation_type = 'uses' AND source_resource_id = ?
    AND target_resource_id IN (SELECT id FROM resources WHERE resource_type = 'project')`

function toListItem(row: ContestRowWithNodeCount): ContestListItem {
  return {
    id: row.id,
    name: row.name,
    year: row.year,
    edition: row.edition ?? undefined,
    organizer: row.organizer ?? undefined,
    status: row.status as ContestStatus,
    archived: row.archived === 1,
    // CP2：三链接随行投影（悬浮窗入口按钮直用，省逐条 contestpin:get）
    officialSite: row.official_site ?? undefined,
    signupUrl: row.signup_url ?? undefined,
    submitUrl: row.submit_url ?? undefined,
    nodeCount: Number(row.node_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toContestView(row: ContestRowWithNodeCount): ContestView {
  return {
    ...toListItem(row),
    note: row.note ?? undefined,
    officialSite: row.official_site ?? undefined,
    signupUrl: row.signup_url ?? undefined,
    submitUrl: row.submit_url ?? undefined,
  }
}

function toNodeView(row: ContestNodeDbRow): ContestNodeView {
  return {
    id: row.id,
    contestId: row.contest_id,
    kind: row.kind as ContestNodeKind,
    label: row.label,
    startAt: row.start_at,
    endAt: row.end_at,
    tz: row.tz,
    precision: row.precision as ContestNodePrecision,
    rawText: row.raw_text ?? undefined,
    done: row.done === 1,
    doneAt: row.done_at,
    source: row.source as ContestNodeSource,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toReminderView(row: ContestReminderDbRow): ContestReminderView {
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

function toMaterialView(row: ContestMaterialDbRow): ContestMaterialView {
  return {
    id: row.id,
    sha256: row.sha256,
    originalName: row.original_name,
    storedPath: row.stored_path,
    sizeBytes: row.size_bytes,
    pages: row.pages,
    kind: row.kind as ContestMaterialView['kind'],
    importedAt: row.imported_at,
  }
}

// ---------------------------------------------------------------------------
// 内部查询与校验助手
// ---------------------------------------------------------------------------

function getContestRow(db: DatabaseSync, id: number): ContestDbRow {
  const row = db.prepare('SELECT * FROM contests WHERE id = ?').get(id) as ContestDbRow | undefined
  if (row === undefined) {
    throw new ServiceError('NOT_FOUND', `contest ${id} not found`)
  }
  return row
}

function getNodeRow(db: DatabaseSync, id: number): ContestNodeDbRow | undefined {
  return db.prepare('SELECT * FROM contest_nodes WHERE id = ?').get(id) as ContestNodeDbRow | undefined
}

function getContestRowWithNodeCount(db: DatabaseSync, id: number): ContestRowWithNodeCount {
  const row = db
    .prepare(
      'SELECT c.*, (SELECT COUNT(*) FROM contest_nodes n WHERE n.contest_id = c.id) AS node_count FROM contests c WHERE c.id = ?',
    )
    .get(id) as ContestRowWithNodeCount | undefined
  if (row === undefined) {
    throw new ServiceError('NOT_FOUND', `contest ${id} not found`)
  }
  return row
}

function countBySql(db: DatabaseSync, sql: string, id: number): number {
  const row = db.prepare(sql).get(id) as { c: number | bigint }
  return Number(row.c)
}

function badRequest(detail: string): ServiceError {
  return new ServiceError('BAD_PAYLOAD', `contest: ${detail}`)
}

/** name 必填非空（trim 后非空白）。 */
function requireContestName(name: string | undefined | null, when: string): string {
  const trimmed = name?.trim() ?? ''
  if (trimmed.length === 0) {
    throw badRequest(`${when} requires a non-empty name`)
  }
  return trimmed
}

/** year 可空；给定时 1990..2100 整数。 */
function validateYear(year: number | null | undefined, when: string): number | null {
  if (year === undefined || year === null) return null
  if (!Number.isSafeInteger(year) || year < CONTEST_YEAR_MIN || year > CONTEST_YEAR_MAX) {
    throw badRequest(`${when}: year must be an integer within ${CONTEST_YEAR_MIN}..${CONTEST_YEAR_MAX} when present`)
  }
  return year
}

/** URL 字段仅 http/https；空串 = 清空（投影为 null）。入参已按 undefined=未提及 在调用侧分流。 */
function validateUrl(value: string | null, field: string, when: string): string | null {
  const trimmed = value?.trim() ?? ''
  if (trimmed.length === 0) return null
  if (/^https?:\/\/\S+$/i.test(trimmed) === false) {
    throw badRequest(`${when}: ${field} must be an http(s) URL when present`)
  }
  return trimmed
}

function validateStatus(status: string | undefined, when: string): ContestStatus | undefined {
  if (status === undefined) return undefined
  if ((CONTEST_STATUSES as readonly string[]).includes(status) === false) {
    throw badRequest(`${when}: status must be one of: ${CONTEST_STATUSES.join(' | ')}`)
  }
  return status as ContestStatus
}

/** contest 资源节点定位（create/update 维护，docs/22 §2.3）。 */
function contestResourceId(db: DatabaseSync, contestId: number, name: string): number {
  return registerResource(db, 'contest', contestId, name)
}

// ---------------------------------------------------------------------------
// due-node 投影（CP2，任务书 §2.1 #6）：悬浮窗/详情的"当前节点"纯逻辑计算，
// smoke 可直调断言。语义（docs/22 §2.2/§4）：
//  - 临近优先：未 done 且 start_at 最近的未来节点（start_at >= now）；
//  - 全部候选已过期 → 最近的过去未 done 节点带 overdue:true；
//  - done 后推进下一节点（候选集排除 done，自然前移）；
//  - tbd（无 start_at）排最后：仅在无任何时刻候选时充当 dueNode；
//  - precision 随投影返回，展示层据此区分"日期 · 未注明具体时刻"/"时间待定"。
// ---------------------------------------------------------------------------
export function computeDueNodes(
  nodes: readonly ContestNodeView[],
  now: number,
): { dueNode: ContestDueNode | null; nextNode: ContestDueNode | null } {
  const open = nodes.filter((n) => !n.done)
  const timed = open
    .filter((n) => n.startAt !== null)
    .sort((a, b) => (a.startAt as number) - (b.startAt as number) || a.id - b.id)
  const tbdNodes = open.filter((n) => n.startAt === null)
  const ordered = [...timed, ...tbdNodes]
  const toDue = (n: ContestNodeView, overdue: boolean): ContestDueNode => ({
    nodeId: n.id,
    contestId: n.contestId,
    kind: n.kind,
    label: n.label,
    startAt: n.startAt,
    precision: n.precision,
    done: n.done,
    overdue,
  })

  const firstFutureIdx = timed.findIndex((n) => (n.startAt as number) >= now)
  let dueIdx: number
  let overdue = false
  if (firstFutureIdx !== -1) {
    dueIdx = firstFutureIdx
  } else if (timed.length > 0) {
    dueIdx = timed.length - 1 // 全过期：最近的过去节点
    overdue = true
  } else if (tbdNodes.length > 0) {
    dueIdx = timed.length // 只剩 tbd：排最后的待定节点
  } else {
    return { dueNode: null, nextNode: null }
  }
  const due = ordered[dueIdx]
  const next = ordered[dueIdx + 1]
  return {
    dueNode: toDue(due, overdue),
    nextNode: next !== undefined ? toDue(next, false) : null,
  }
}

/** 单比赛的节点拉取 + due 投影（list 逐行 / get 单条共用）。 */
function dueProjection(
  db: DatabaseSync,
  contestId: number,
  now: number,
): { dueNode: ContestDueNode | null; nextNode: ContestDueNode | null } {
  const rows = db.prepare(LIST_NODES_SQL).all(contestId) as unknown as ContestNodeDbRow[]
  return computeDueNodes(
    rows.map(toNodeView),
    now,
  )
}

// ---------------------------------------------------------------------------
// contestpin:list / contestpin:get
// ---------------------------------------------------------------------------

export function listContests(payload: ContestListPayload = {}): ContestListResult {
  const db = getDatabase()

  const status = validateStatus(payload.status, 'list')
  const query = payload.query?.trim()
  const limit = Math.min(
    payload.limit ?? CONTEST_LIST_LIMIT_DEFAULT,
    CONTEST_LIST_LIMIT_MAX,
  )
  if (limit < 1) {
    throw badRequest('list: limit must be a positive integer when present')
  }
  const offset = payload.offset ?? 0
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw badRequest('list: offset must be a non-negative integer when present')
  }

  // 过滤片段拼接走静态字面量片段（agentControlService 先例），取值全部 ? 绑定
  const conditions: string[] = []
  const params: (string | number)[] = []
  if (payload.archived !== true) {
    conditions.push('c.archived = 0')
  }
  if (query !== undefined && query.length > 0) {
    conditions.push('(CAST(c.name AS TEXT) LIKE ? OR CAST(c.year AS TEXT) LIKE ?)')
    params.push(`%${query}%`, `%${query}%`)
  }
  if (status !== undefined) {
    conditions.push('c.status = ?')
    params.push(status)
  }
  const whereSql = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''

  const rows = db
    .prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM contest_nodes n WHERE n.contest_id = c.id) AS node_count FROM contests c${whereSql}
       ORDER BY c.updated_at DESC, c.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as unknown as ContestRowWithNodeCount[]

  const now = nowSec()
  const items = rows.map((row) => {
    const item = toListItem(row)
    const projection = dueProjection(db, row.id, now)
    item.dueNode = projection.dueNode
    item.nextNode = projection.nextNode
    return item
  })
  const totalRow = db
    .prepare(`SELECT COUNT(*) AS c FROM contests c${whereSql}`)
    .get(...params) as { c: number | bigint }

  return { items, total: Number(totalRow.c) }
}

export function getContest(id: number): ContestDetailView {
  const db = getDatabase()
  const row = getContestRow(db, id)

  const nodes = (db.prepare(LIST_NODES_SQL).all(id) as unknown as ContestNodeDbRow[]).map(toNodeView)
  const reminders = (db.prepare(LIST_REMINDERS_BY_CONTEST_SQL).all(id) as unknown as ContestReminderDbRow[]).map(
    toReminderView,
  )
  const materials = (db.prepare(LIST_MATERIALS_BY_CONTEST_SQL).all(id) as unknown as ContestMaterialDbRow[]).map(
    toMaterialView,
  )
  const project = (db.prepare(FIND_PROJECT_BY_CONTEST_SQL).get(id) as ContestLinkedProject | undefined) ?? null
  const projection = dueProjection(db, row.id, nowSec())

  return {
    id: row.id,
    name: row.name,
    year: row.year,
    edition: row.edition ?? undefined,
    organizer: row.organizer ?? undefined,
    note: row.note ?? undefined,
    status: row.status as ContestStatus,
    archived: row.archived === 1,
    officialSite: row.official_site ?? undefined,
    signupUrl: row.signup_url ?? undefined,
    submitUrl: row.submit_url ?? undefined,
    nodeCount: nodes.length,
    dueNode: projection.dueNode,
    nextNode: projection.nextNode,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    nodes,
    materials,
    reminders,
    project,
  }
}

/** 轻量存在性检查（contestpin:openInMain 先校验后导航，handlers 调用）。 */
export function contestExists(id: number): boolean {
  const row = getDatabase().prepare('SELECT 1 FROM contests WHERE id = ?').get(id)
  return row !== undefined
}

// ---------------------------------------------------------------------------
// contestpin:create / contestpin:update / contestpin:archive
// ---------------------------------------------------------------------------

export function createContest(payload: ContestCreatePayload): ContestView {
  const db = getDatabase()

  const name = requireContestName(payload.name, 'create')
  const year = validateYear(payload.year, 'create')
  const status = validateStatus(payload.status, 'create') ?? 'watching'
  const officialSite = validateUrl(payload.officialSite ?? null, 'officialSite', 'create')
  const signupUrl = validateUrl(payload.signupUrl ?? null, 'signupUrl', 'create')
  const submitUrl = validateUrl(payload.submitUrl ?? null, 'submitUrl', 'create')

  const now = nowSec()
  const result = db
    .prepare(
      'INSERT INTO contests (name, year, edition, organizer, note, status, archived, official_site, signup_url, submit_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)',
    )
    .run(
      name,
      dbVal(year),
      dbVal(payload.edition?.trim() || null),
      dbVal(payload.organizer?.trim() || null),
      dbVal(payload.note ?? null),
      status,
      dbVal(officialSite),
      dbVal(signupUrl),
      dbVal(submitUrl),
      now,
      now,
    )
  const contestId = Number(result.lastInsertRowid)

  // docs/22 §2.3：create 登记 contest 资源节点（display_name=name）
  contestResourceId(db, contestId, name)

  return toContestView(getContestRowWithNodeCount(db, contestId))
}

export function updateContest(payload: ContestUpdatePayload): ContestView {
  const db = getDatabase()
  const row = getContestRow(db, payload.id)
  const patch: ContestPatch = payload.patch ?? {}

  let name = row.name
  const incomingName = patch.name?.trim()
  if (incomingName !== undefined && incomingName.length === 0) {
    throw badRequest('update: name cannot be empty when present')
  }
  if (incomingName !== undefined && incomingName !== row.name) {
    name = incomingName
  }
  const year = patch.year !== undefined ? validateYear(patch.year, 'update') : row.year
  const status = validateStatus(patch.status, 'update') ?? (row.status as ContestStatus)
  // URL：undefined = 保持原值；''/null = 清空；其余仅 http/https
  const officialSite =
    patch.officialSite === undefined
      ? row.official_site
      : validateUrl(patch.officialSite ?? null, 'officialSite', 'update')
  const signupUrl =
    patch.signupUrl === undefined ? row.signup_url : validateUrl(patch.signupUrl ?? null, 'signupUrl', 'update')
  const submitUrl =
    patch.submitUrl === undefined ? row.submit_url : validateUrl(patch.submitUrl ?? null, 'submitUrl', 'update')

  db.prepare(
    'UPDATE contests SET name = ?, year = ?, edition = ?, organizer = ?, note = ?, status = ?, official_site = ?, signup_url = ?, submit_url = ?, updated_at = ? WHERE id = ?',
  ).run(
    name,
    dbVal(year),
    dbVal(patch.edition?.trim() || (patch.edition === undefined ? row.edition : null)),
    dbVal(patch.organizer?.trim() || (patch.organizer === undefined ? row.organizer : null)),
    dbVal(patch.note ?? row.note),
    status,
    dbVal(officialSite),
    dbVal(signupUrl),
    dbVal(submitUrl),
    nowSec(),
    row.id,
  )

  // 改名同步资源节点 display_name（registerResource 已存在即更新语义，幂等）
  if (name !== row.name) {
    contestResourceId(db, row.id, name)
  }
  return toContestView(getContestRowWithNodeCount(db, row.id))
}

export function archiveContest(payload: ContestArchivePayload): ContestView {
  const db = getDatabase()
  const row = getContestRow(db, payload.id)
  db.prepare('UPDATE contests SET archived = ?, updated_at = ? WHERE id = ?').run(
    payload.archived ? 1 : 0,
    nowSec(),
    row.id,
  )
  return toContestView(getContestRowWithNodeCount(db, row.id))
}

// ---------------------------------------------------------------------------
// contestpin:delete（CONFIRM_REQUIRED 两段式）
// ---------------------------------------------------------------------------

export function deleteContest(payload: ContestDeletePayload): ContestDeleteStart | ContestDeleteResult {
  const db = getDatabase()
  const row = getContestRow(db, payload.id)
  // 影响面：节点数 + 提醒数 + 材料引用数（materials 经导入任务间接关联）
  const impacts = {
    nodes: countBySql(db, COUNT_NODES_SQL, row.id),
    materials: countBySql(db, COUNT_MATERIALS_BY_CONTEST_SQL, row.id),
    reminders: countBySql(db, COUNT_REMINDERS_BY_CONTEST_SQL, row.id),
  }

  if (payload.confirmed !== true) {
    return { confirmRequired: true, impacts }
  }

  // 先显式删 contest 资源节点（以其为端点的 uses 边经 FK CASCADE 一并清理，
  // projectService.removeProject 先例），再删行（nodes/reminders/jobs 行内 CASCADE 兜底）
  deleteResource(db, 'contest', row.id)
  db.prepare('DELETE FROM contests WHERE id = ?').run(row.id)
  logger.info(
    `contest delete: contest ${row.id} removed (nodes=${impacts.nodes}, reminders=${impacts.reminders}, materials=${impacts.materials})`,
  )
  return { confirmRequired: undefined, removed: true }
}

// ---------------------------------------------------------------------------
// contestpin:nodeUpsert / contestpin:nodeDelete
// ---------------------------------------------------------------------------

/** 节点 label 归一：kind='custom' 必填非空；其余缺省以 kind 值兜底展示。 */
function resolveNodeLabel(input: ContestNodeInput, kind: ContestNodeKind, when: string): string {
  const trimmed = input.label?.trim() ?? ''
  if (trimmed.length > 0) return trimmed
  if (kind === 'custom') {
    throw badRequest(`${when}: label is required for kind='custom' nodes`)
  }
  return kind
}

/**
 * 精度/时刻组合校验（docs/22 §2.2 权威语义）：
 *  - 'tbd' → startAt/endAt 恒 NULL；
 *  - 'exact'/'date'/'month' → startAt 必填；
 *  - endAt 给定时 ≥ startAt。
 */
function validatePrecisionState(
  precision: ContestNodePrecision,
  startAt: number | null,
  endAt: number | null,
  when: string,
): void {
  if (precision === 'tbd') {
    if (startAt !== null || endAt !== null) {
      throw badRequest(`${when}: precision='tbd' requires startAt/endAt to be null (time TBD)`)
    }
    return
  }
  if (startAt === null) {
    throw badRequest(`${when}: precision='${precision}' requires startAt`)
  }
  if (endAt !== null && endAt < startAt) {
    throw badRequest(`${when}: endAt must be >= startAt when present`)
  }
}

export function upsertNode(payload: ContestNodeUpsertPayload): ContestNodeView {
  const db = getDatabase()
  const contest = getContestRow(db, payload.contestId)
  const input = payload.node
  if (input === undefined || input === null || typeof input !== 'object') {
    throw badRequest('nodeUpsert: node is required')
  }

  if (input.id !== undefined) {
    // ---- 更新路径：禁止低精度 → exact 无依据提升（docs/22 §2.2） ----
    const existing = getNodeRow(db, input.id)
    if (existing === undefined) {
      throw new ServiceError('NOT_FOUND', `contest node ${input.id} not found`)
    }
    if (existing.contest_id !== contest.id) {
      throw badRequest(`nodeUpsert: node ${input.id} does not belong to contest ${contest.id}`)
    }

    const kind = input.kind ?? (existing.kind as ContestNodeKind)
    if ((CONTEST_NODE_KINDS as readonly string[]).includes(kind) === false) {
      throw badRequest('nodeUpsert: kind must be one of: ' + CONTEST_NODE_KINDS.join(' | '))
    }
    const precision = input.precision ?? (existing.precision as ContestNodePrecision)
    if ((CONTEST_NODE_PRECISIONS as readonly string[]).includes(precision) === false) {
      throw badRequest('nodeUpsert: precision must be one of: ' + CONTEST_NODE_PRECISIONS.join(' | '))
    }
    if (
      existing.precision !== 'exact' &&
      precision === 'exact' &&
      (input.rawText === undefined || input.rawText.trim().length === 0)
    ) {
      throw badRequest(
        `nodeUpsert: precision upgrade '${existing.precision}' -> 'exact' requires explicit rawText evidence (docs/22 §2.2)`,
      )
    }
    // startAt/endAt：显式 null = 清空；undefined = 保持原值
    const startAt = input.startAt !== undefined ? input.startAt : existing.start_at
    const endAt = input.endAt !== undefined ? input.endAt : existing.end_at
    validatePrecisionState(precision, startAt, endAt, `nodeUpsert(node ${input.id})`)

    // label：未提及保持既有行（行内 NOT NULL）；显式给定时按 kind 规则校验
    const label = input.label !== undefined ? resolveNodeLabel(input, kind, `nodeUpsert(node ${input.id})`) : existing.label
    const tz = input.tz?.trim() || existing.tz
    const rawText =
      input.rawText !== undefined ? (input.rawText.trim().length > 0 ? input.rawText.trim() : null) : existing.raw_text
    const done = input.done !== undefined ? (input.done ? 1 : 0) : existing.done
    const doneAt = done === 1 ? (existing.done === 1 ? existing.done_at : nowSec()) : null

    db.prepare(
      'UPDATE contest_nodes SET kind = ?, label = ?, start_at = ?, end_at = ?, tz = ?, precision = ?, raw_text = ?, done = ?, done_at = ?, updated_at = ? WHERE id = ?',
    ).run(kind, label, startAt, endAt, tz, precision, dbVal(rawText), done, doneAt, nowSec(), existing.id)
    const updated = getNodeRow(db, existing.id)
    if (updated === undefined) {
      throw new ServiceError('NOT_FOUND', `contest node ${existing.id} disappeared after update`)
    }
    return toNodeView(updated)
  }

  // ---- 新建路径 ----
  const kind = input.kind ?? 'custom'
  if ((CONTEST_NODE_KINDS as readonly string[]).includes(kind) === false) {
    throw badRequest('nodeUpsert: kind must be one of: ' + CONTEST_NODE_KINDS.join(' | '))
  }
  const precision = input.precision ?? 'exact'
  if ((CONTEST_NODE_PRECISIONS as readonly string[]).includes(precision) === false) {
    throw badRequest('nodeUpsert: precision must be one of: ' + CONTEST_NODE_PRECISIONS.join(' | '))
  }
  // CP1 仅人工 CRUD：source 由系统赋值 'manual'（imported/agent 归 CP3/CP5 管线）
  const source: ContestNodeSource = 'manual'
  const startAt = input.startAt === undefined || input.startAt === null ? null : input.startAt
  const endAt = input.endAt === undefined || input.endAt === null ? null : input.endAt
  if (typeof startAt !== 'number' && startAt !== null) {
    throw badRequest('nodeUpsert: startAt must be a unix-seconds integer or null')
  }
  if (typeof endAt !== 'number' && endAt !== null) {
    throw badRequest('nodeUpsert: endAt must be a unix-seconds integer or null')
  }
  validatePrecisionState(precision, startAt, endAt, 'nodeUpsert')
  const label = resolveNodeLabel(input, kind, 'nodeUpsert')
  const tz = input.tz?.trim() || 'local'
  const rawText = input.rawText?.trim() || null
  const done = input.done === true ? 1 : 0

  const now = nowSec()
  const result = db
    .prepare(
      'INSERT INTO contest_nodes (contest_id, kind, label, start_at, end_at, tz, precision, raw_text, done, done_at, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(contest.id, kind, label, startAt, endAt, tz, precision, dbVal(rawText), done, done === 1 ? now : null, source, now, now)
  const nodeId = Number(result.lastInsertRowid)
  const created = getNodeRow(db, nodeId)
  if (created === undefined) {
    throw new ServiceError('NOT_FOUND', `contest node ${nodeId} disappeared after insert`)
  }
  return toNodeView(created)
}

export function deleteNode(payload: ContestNodeDeletePayload): ContestNodeDeleteStart | ContestNodeDeleteResult {
  const db = getDatabase()
  const existing = getNodeRow(db, payload.id)
  if (existing === undefined) {
    throw new ServiceError('NOT_FOUND', `contest node ${payload.id} not found`)
  }

  if (payload.confirmed !== true) {
    return {
      confirmRequired: true,
      impacts: { reminders: countBySql(db, COUNT_REMINDERS_BY_NODE_SQL, existing.id) },
    }
  }

  const reminders = countBySql(db, COUNT_REMINDERS_BY_NODE_SQL, existing.id)
  db.prepare('DELETE FROM contest_nodes WHERE id = ?').run(existing.id)
  logger.info(`contest node delete: node ${existing.id} removed (reminders=${reminders})`)
  return { confirmRequired: undefined, removed: true }
}

// ---------------------------------------------------------------------------
// contestpin:linkProject（docs/22 §2.3：resources + relationships `uses` 边）
// ---------------------------------------------------------------------------

export function linkProject(payload: ContestLinkProjectPayload): { linked: boolean } {
  const db = getDatabase()
  const contest = getContestRow(db, payload.contestId)
  const contestResId = contestResourceId(db, contest.id, contest.name)

  if (payload.projectId === null) {
    // 解除关联：删 contest→project 全部 uses 边（projectService 容器边删除先例）
    db.prepare(DELETE_USES_EDGES_SQL).run(contestResId)
    return { linked: false }
  }

  const projectRow = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(payload.projectId) as
    | { id: number; name: string }
    | undefined
  if (projectRow === undefined) {
    throw new ServiceError('NOT_FOUND', `project ${payload.projectId} not found`)
  }
  // 已存在幂等（registerResource 更新 display_name），再建 uses 边（INSERT OR IGNORE）
  const projectResId = registerResource(db, 'project', projectRow.id, projectRow.name)
  relate(db, contestResId, projectResId, 'uses')
  return { linked: true }
}
