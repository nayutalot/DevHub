/**
 * zcodeProvider.ts — ZCode 接入适配器（docs/12 §8.4；**首版全部 observed，裁决 4**）。
 *
 * 数据源（AC0 盘点 + 本批真机只读复核，db 活跃写入中，~165 sessions / 8.6k messages）：
 * - `~/.zcode/cli/db/db.sqlite`（WAL）：19 表实测；本 provider 依赖（PRAGMA 白名单）：
 *   session(id, directory, title, time_created(ms), time_updated(ms), time_archived, task_type…)
 *   / message(id, session_id, data JSON, sequence(会话内序号), time_created(ms))
 *   / tool_usage(id, session_id, tool_name, approval_status, status, started_at,
 *   completed_at, exit_code, error_type…)；part(id, message_id, data JSON, sequence)
 *   为消息正文的**可选**来源（part.type='text'）；
 *
 * 子会话过滤（用户需求：ZCode provider 只抓主智能体会话，过滤子智能体会话）：
 * ZCode 库 session 表的子会话判别特征（真库实测三重）：task_type='subagent_child'
 * （显式列）/ id 前缀 'sess_subagent_agent_' / parent_id 非空。本 provider 取前两重
 * **双保险**（isZcodeSubagentSession：两者都判，命中任一即排除）；parent_id 不作判据
 * （主会话也可能携带别的 parent 语义，绝不猜）。task_type 列按可选列白名单
 * （ZCODE_DB_TASK_TYPE_OPTIONAL）检测：列缺失（schema 白名单比对不匹配的降级场景）
 * 时仅前缀判据兜底；行值 NULL 时亦由前缀判据兜底。listSessions / 监控增量
 * （sessions 发现、messages 投影、tool_usage 审批、tasks 复核）一切会话发现路径
 * 全部过滤——子会话不过 sink：L3 的 persistMessage/applySessionStatus 会经
 * ensureSessionRow 反向建行，漏滤即重新污染。投影字段不变（observed-only 语义不变）。
 * 历史污染行由 scripts/cleanup-zcode-subagent-sessions.mjs 一次性清理。
 * - `~/.zcode/v2/tasks-index.sqlite`：tasks(task_id, title, task_status, workspace_path,
 *   updated_at)；task_id 与 db.session.id 同键空间（实测 51/51 全覆盖）。
 *
 * 状态判定（实机复核取值集合，映射表写死；绝不猜）：
 * - task_status 实测全集 = {completed(43), error(8)} → ZCODE_TASK_STATUS_MAP：
 *   completed→completed、error→failed；未登录取值 → unknown；无任务行 → 无证据；
 * - tool_usage.approval_status 实测全集 = {none(8601)}（resolved 后归 none）：
 *   'none'/空 = 无审批；匹配 pending/request/await/wait 形态（docs/12 §5 指定判定源）
 *   → approval_required；其余取值不产生审批状态（绝不猜）；
 * - waiting_input：语料无判定源（session_input.status 实测 {promoted, cancelled,
 *   discarded}，无 pending 形态）→ 不产生（绝不猜）。
 *
 * 只读策略（docs/12 §8.4）：优先 node:sqlite readOnly 直连（试开失败含 CANTOPEN/
 * 锁/损坏 → 降级）；降级 = 复制 db+-wal+-shm 三文件到 getDataDir()/tmp/
 * zcode-snap-<ts>-<rand>/，先试 readOnly 打开、失败则可写打开 + `PRAGMA query_only=1`
 * （WAL/shm 恢复需要可写句柄；query_only 兜底禁止数据写），读快照，用完即删
 * （finally 清理）。**绝不写第三方库、绝不 checkpoint、绝不创建附加连接写句柄。**
 * 实测：直连 readOnly 对活跃真库当前可用（CANTOPEN 为陈旧 shm 场景，快照即为此设计）。
 *
 * schema 防御：启动/建连时 PRAGMA table_info 与白名单常量比对；不匹配 → provider
 * unavailable + health_detail 结构化说明（绝不猜字段、绝不崩溃）。
 *
 * 监控：db 为 WAL 高频写入库（本机 ZCode 活跃使用）——stat 轮询（默认 8s，≥5s
 * 纪律）不 fs.watch 热路径；快照周期性刷新（默认 300s）；各表 max(rowid) 游标增量
 * （首启从 0 全量入库，与 codex/claude 重放语义一致）；读失败连续 5 次 →
 * connection_lost 降级沿。
 *
 * 控制边界：getCapabilities 恒 observed + 空集（裁决 4）；sendReply/pause/resume
 * 结构化 unsupported；禁 GUI 自动化、禁逆向。
 *
 * electron-free；零 child_process import（约束 #7）；一切 SQL 参数绑定（约束 #11）。
 */

import { mkdirSync, rmSync, statSync, copyFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { AgentCapabilitySet, SessionStatus } from '../../../../shared/types.ts'
import { getDataDir } from '../../../core/paths.ts'
import { nowSec } from '../../internal.ts'
import { ReadFailureTracker, cancellableSleep, startMonitorTask, type MonitorCancelToken } from '../monitorRegistry.ts'
import { redactText } from '../redact.ts'
import type {
  AgentProvider,
  CommandOutcome,
  EventSink,
  MessagePage,
  MonitorHandle,
  ProviderDiagnosticsInfo,
  ProviderHealth,
  RedactedMessage,
  SessionRef,
  SessionSnapshot,
} from '../providerRegistry.ts'

export interface ZcodeProviderOptions {
  /** db.sqlite 路径（默认 `~/.zcode/cli/db/db.sqlite`；smoke 注入夹具）。 */
  zcodeDbPath?: string
  /** tasks-index.sqlite 路径（默认 `~/.zcode/v2/tasks-index.sqlite`；smoke 注入夹具）。 */
  tasksIndexPath?: string
  /** 快照根目录（默认 getDataDir()/tmp；smoke 注入隔离目录）。 */
  snapshotRoot?: string
  /**
   * 直连模式：'auto' = 先直连后快照（默认/生产）；'disabled' = 视直连恒失败
   * （确定性模拟 CANTOPEN/锁，供 smoke 驱动真实快照降级路径；生产禁用）。
   */
  directOpenMode?: 'auto' | 'disabled'
  /** 监控轮询间隔毫秒（默认 8000，≥5s 纪律；夹具可注入小值）。 */
  pollMs?: number
  /** 快照周期刷新毫秒（默认 300_000；夹具可注入小值）。 */
  snapshotRefreshMs?: number
  /** 消息投影单条字符上限。 */
  messageTextCap?: number
  /** 每轮每表读取行上限（防大库单轮拖垮）。 */
  batchRows?: number
}

const DEFAULT_POLL_MS = 8_000
const DEFAULT_SNAPSHOT_REFRESH_MS = 300_000
const DEFAULT_MESSAGE_TEXT_CAP = 4_000
const DEFAULT_BATCH_ROWS = 500

/**
 * db.sqlite schema 白名单（表 → 必需列全集；实测 schema 子集，多余列/表不拒）。
 * ZCode 非公开 CLI——schema 变更防御优先（docs/12 §8.4 / R2）。
 */
export const ZCODE_DB_REQUIRED_SCHEMA: Readonly<Record<string, readonly string[]>> = {
  session: ['id', 'directory', 'title', 'time_created', 'time_updated'],
  message: ['id', 'session_id', 'data', 'sequence', 'time_created'],
  tool_usage: ['id', 'session_id', 'tool_name', 'approval_status', 'status', 'started_at', 'completed_at'],
} as const

/** 消息正文可选来源表（存在才 join；缺省不拒——投影退化为 data JSON 自带字段）。 */
export const ZCODE_DB_OPTIONAL_SCHEMA: Readonly<Record<string, readonly string[]>> = {
  part: ['id', 'message_id', 'data', 'sequence'],
} as const

/** tasks-index.sqlite schema 白名单。 */
export const ZCODE_TASKS_REQUIRED_SCHEMA: Readonly<Record<string, readonly string[]>> = {
  tasks: ['task_id', 'title', 'task_status', 'workspace_path', 'updated_at'],
} as const

/**
 * task_type 可选列白名单（子会话判别列；用户需求：只抓主智能体会话）。
 * 不进 ZCODE_DB_REQUIRED_SCHEMA 的原因：required 是「缺列即 unavailable」语义，
 * 会把「列缺失降级场景」整个判死——而本需求明确该场景由 id 前缀判据兜底继续工作。
 * 列存在 → 双保险（task_type + 前缀都判）；列缺失 → 仅前缀兜底。
 */
export const ZCODE_DB_TASK_TYPE_OPTIONAL_SCHEMA: Readonly<Record<string, readonly string[]>> = {
  session: ['task_type'],
} as const

/** 子会话显式 task_type 标记（真库实测取值；与 id 前缀判据 100% 重合，仍双保险都判）。 */
export const ZCODE_SUBAGENT_TASK_TYPE = 'subagent_child'
/** 子会话 ID 前缀（双保险第二判据：task_type 列缺失/行值 NULL 时的兜底）。 */
export const ZCODE_SUBAGENT_ID_PREFIX = 'sess_subagent_agent_'
/**
 * 前缀 LIKE pattern（绑定参数用；`_` 是 LIKE 通配符必须转义为字面下划线）。
 * SQL 形态：`id NOT LIKE ? ESCAPE '\'`。
 */
export const ZCODE_SUBAGENT_ID_LIKE_PATTERN = 'sess\\_subagent\\_agent\\_%'

/**
 * 子会话双保险判据（用户需求：只抓主智能体会话）：task_type 命中或 id 前缀命中
 * 即为子会话。taskType 传 undefined 表示 task_type 列不可用（缺列降级）——仅按
 * 前缀判；传 null 表示列存在但该行值为 NULL——同样由前缀兜底。parent_id 不作判据。
 */
export function isZcodeSubagentSession(id: string, taskType?: string | null): boolean {
  if (taskType !== undefined && taskType !== null && String(taskType) === ZCODE_SUBAGENT_TASK_TYPE) return true
  return String(id).startsWith(ZCODE_SUBAGENT_ID_PREFIX)
}

/**
 * tasks.task_status → 9 值状态映射表（实机复核取值全集 {completed, error} 后写死；
 * 未登录取值 → unknown，绝不猜）。报告列明：completed→completed、error→failed。
 */
export const ZCODE_TASK_STATUS_MAP: Readonly<Record<string, SessionStatus>> = {
  completed: 'completed',
  error: 'failed',
} as const

/** tool_usage.approval_status 的「无审批」取值（实机全集 = {'none'}）。 */
export const ZCODE_APPROVAL_NONE_VALUES: readonly string[] = ['none', ''] as const
/**
 * 审批等待形态（docs/12 §5 指定判定源；实机语料仅 'none'，此形态为设计内防御：
 * 未来出现 pending/request 形态时判 approval_required；approved/rejected 等已闭环
 * 形态不命中——绝不把闭环值猜成等待）。
 */
export const ZCODE_APPROVAL_PENDING_PATTERN = /pending|request|await|wait/i

/** approval_status 值 → 是否等待审批（绝不猜：闭环/未知值一律 false）。 */
export function evalZcodeApprovalStatus(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return false
  const v = String(value).trim().toLowerCase()
  if (v.length === 0 || ZCODE_APPROVAL_NONE_VALUES.includes(v)) return false
  return ZCODE_APPROVAL_PENDING_PATTERN.test(v)
}

/** task_status 值 → 状态（无任务行/空值 → null 无证据；未登录值 → unknown）。 */
export function evalZcodeTaskStatus(value: string | null | undefined): SessionStatus | null {
  if (value === null || value === undefined) return null
  const v = String(value).trim().toLowerCase()
  if (v.length === 0) return null
  return ZCODE_TASK_STATUS_MAP[v] ?? 'unknown'
}

// ---------------------------------------------------------------------------
// schema 白名单比对（PRAGMA table_info）
// ---------------------------------------------------------------------------

export interface SchemaCheckResult {
  ok: boolean
  problems: string[]
}

function checkSchema(db: DatabaseSync, required: Readonly<Record<string, readonly string[]>>): SchemaCheckResult {
  const problems: string[] = []
  let existing: Map<string, Set<string>>
  try {
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
    existing = new Map()
    for (const row of rows) {
      const cols = db.prepare(`PRAGMA table_info(${quoteIdent(String(row.name))})`).all() as Array<{ name: string }>
      existing.set(String(row.name), new Set(cols.map((c) => String(c.name))))
    }
  } catch (e) {
    return { ok: false, problems: [`sqlite_master read failed: ${e instanceof Error ? e.message : String(e)}`] }
  }
  for (const [table, cols] of Object.entries(required)) {
    const have = existing.get(table)
    if (have === undefined) {
      problems.push(`missing table: ${table}`)
      continue
    }
    for (const col of cols) {
      if (!have.has(col)) problems.push(`missing column: ${table}.${col}`)
    }
  }
  return { ok: problems.length === 0, problems }
}

/** SQL 标识符引用（PRAGMA table_info 参数不可绑定——内部双写引号防注入，约束 #11 精神）。 */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

// ---------------------------------------------------------------------------
// 只读连接管理（直连优先 → 快照降级，用完即删）
// ---------------------------------------------------------------------------

export interface ZcodeReadConnection {
  db: DatabaseSync
  /** 'direct' = readOnly 直连真库；'snapshot' = 副本快照（用后即删）。 */
  kind: 'direct' | 'snapshot'
  close(): void
}

interface OpenOutcome {
  conn: ZcodeReadConnection | null
  error: string | null
}

function tryOpenReadOnly(path: string, validate: boolean): OpenOutcome {
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(path, { readOnly: true })
    if (validate) db.prepare('SELECT COUNT(*) AS c FROM sqlite_master').get()
    return {
      conn: {
        db,
        kind: 'direct',
        close: () => {
          try {
            db?.close()
          } catch {
            /* 幂等 */
          }
        },
      },
      error: null,
    }
  } catch (e) {
    try {
      db?.close()
    } catch {
      /* 忽略 */
    }
    return { conn: null, error: `${e instanceof Error ? e.message : String(e)}` }
  }
}

/** 复制 db+-wal+-shm（存在才复制）到新快照目录；返回目录路径。 */
function copySnapshotFiles(dbPath: string, snapshotRoot: string): string {
  const dir = join(snapshotRoot, `zcode-snap-${Date.now()}-${randomBytes(4).toString('hex')}`)
  mkdirSync(dir, { recursive: true })
  for (const suffix of ['', '-wal', '-shm']) {
    const src = `${dbPath}${suffix}`
    if (existsSync(src)) copyFileSync(src, join(dir, `db.sqlite${suffix}`))
  }
  return dir
}

/**
 * 快照降级（docs/12 §8.4）：复制 db+-wal+-shm 三文件（存在才复制）到
 * <snapshotRoot>/zcode-snap-<ts>-<rand>/；先 readOnly 打开，失败（陈旧 shm 需恢复）
 * 则可写打开 + PRAGMA query_only=1（恢复机制需要可写句柄；query_only 兜底禁数据写，
 * 且对象是本域副本、绝不触碰源库）。调用方 finally 必须 close()（删除快照目录）。
 */
function openSnapshotCopy(dbPath: string, snapshotRoot: string): OpenOutcome {
  if (!existsSync(dbPath)) return { conn: null, error: 'source db.sqlite missing (nothing to snapshot)' }
  let dir = ''
  try {
    dir = copySnapshotFiles(dbPath, snapshotRoot)
    // 先试 readOnly；陈旧 -shm 需要恢复时可写打开 + query_only（副本上，安全）
    let db: DatabaseSync
    try {
      db = new DatabaseSync(join(dir, 'db.sqlite'), { readOnly: true })
    } catch {
      db = new DatabaseSync(join(dir, 'db.sqlite'))
      db.exec('PRAGMA query_only = 1')
    }
    return {
      conn: {
        db,
        kind: 'snapshot',
        close: () => {
          try {
            db.close()
          } catch {
            /* 幂等 */
          }
          try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 })
          } catch {
            /* 清理失败不阻断（临时目录，OS 兜底回收） */
          }
        },
      },
      error: null,
    }
  } catch (e) {
    try {
      if (dir.length > 0) rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 })
    } catch {
      /* 尽力清理 */
    }
    return { conn: null, error: `snapshot open failed: ${e instanceof Error ? e.message : String(e)}` }
  }
}

// ---------------------------------------------------------------------------
// Provider（docs/12 §4 九方法）
// ---------------------------------------------------------------------------

interface ZcodeMessageRow {
  rowid: number
  id: string
  session_id: string
  data: string
  sequence: number | null
  time_created: number | null
}

export function createZcodeProvider(options: ZcodeProviderOptions = {}): AgentProvider {
  const dbPath = options.zcodeDbPath ?? join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite')
  const tasksIndexPath = options.tasksIndexPath ?? join(homedir(), '.zcode', 'v2', 'tasks-index.sqlite')
  const snapshotRoot = options.snapshotRoot ?? join(getDataDir(), 'tmp')
  const directOpenMode = options.directOpenMode ?? 'auto'
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS
  const snapshotRefreshMs = options.snapshotRefreshMs ?? DEFAULT_SNAPSHOT_REFRESH_MS
  const messageTextCap = options.messageTextCap ?? DEFAULT_MESSAGE_TEXT_CAP
  const batchRows = options.batchRows ?? DEFAULT_BATCH_ROWS

  const stats = { parseFailures: 0, snapshotOpens: 0, directOpens: 0, lastSchemaProblems: [] as string[] }
  /** 常驻快照（监控轮询间复用；snapshotRefreshMs 到期重建）。 */
  let residentSnapshot: { dir: string; createdAt: number; sourceKey: string; close(): void } | null = null

  // -------------------------------------------------------------------------

  function sourceStatKey(path: string): string {
    try {
      const st = statSync(path)
      return `${st.size}:${Math.floor(st.mtimeMs)}`
    } catch {
      return 'missing'
    }
  }

  /** 打开一个只读连接（直连优先 → 快照降级）。失败返回 null + 结构化原因。 */
  async function openReadConnection(): Promise<{ conn: ZcodeReadConnection | null; error: string | null }> {
    if (directOpenMode !== 'disabled') {
      const direct = tryOpenReadOnly(dbPath, true)
      if (direct.conn !== null) {
        stats.directOpens += 1
        return direct
      }
      // 直连失败（CANTOPEN/锁/损坏等）：快照降级
      if (!existsSync(dbPath)) return { conn: null, error: `db.sqlite missing (${direct.error})` }
      mkdirSync(snapshotRoot, { recursive: true })
      const snap = openSnapshotCopy(dbPath, snapshotRoot)
      if (snap.conn !== null) {
        stats.snapshotOpens += 1
        return snap
      }
      return { conn: null, error: `direct: ${direct.error}; snapshot: ${snap.error}` }
    }
    // directOpenMode 'disabled'（CANTOPEN 模拟）：直接快照
    if (!existsSync(dbPath)) return { conn: null, error: 'db.sqlite missing (direct disabled simulation)' }
    mkdirSync(snapshotRoot, { recursive: true })
    const snap = openSnapshotCopy(dbPath, snapshotRoot)
    if (snap.conn !== null) {
      stats.snapshotOpens += 1
      return snap
    }
    return { conn: null, error: `snapshot: ${snap.error}` }
  }

  function closeConnection(conn: ZcodeReadConnection): void {
    conn.close() // 快照：连接关闭 + 快照目录即删（用完即删）
  }

  /** 监控常驻快照：到期或源变更时重建（周期性刷新，避免每 tick 复制大库）。 */
  async function ensureResidentSnapshot(): Promise<{ path: string; fresh: boolean } | null> {
    if (!existsSync(dbPath)) return null
    const key = sourceStatKey(dbPath)
    const expired = residentSnapshot === null || Date.now() - residentSnapshot.createdAt >= snapshotRefreshMs
    if (!expired && residentSnapshot !== null && residentSnapshot.sourceKey === key) {
      return { path: join(residentSnapshot.dir, 'db.sqlite'), fresh: false }
    }
    if (residentSnapshot !== null) {
      try {
        residentSnapshot.close()
      } catch {
        /* 幂等 */
      }
      residentSnapshot = null
    }
    try {
      mkdirSync(snapshotRoot, { recursive: true })
      const dir = copySnapshotFiles(dbPath, snapshotRoot)
      residentSnapshot = {
        dir,
        createdAt: Date.now(),
        sourceKey: key,
        close: () => {
          try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 })
          } catch {
            /* 尽力清理 */
          }
        },
      }
      stats.snapshotOpens += 1
      return { path: join(dir, 'db.sqlite'), fresh: true }
    } catch {
      return null
    }
  }

  /** 临时只读连接（probeHealth/listSessions/readMessages 短命场景）。 */
  async function withReadConnection<T>(fn: (conn: ZcodeReadConnection) => T | Promise<T>): Promise<T | null> {
    const { conn, error } = await openReadConnection()
    if (conn === null) {
      stats.lastSchemaProblems = [`open failed: ${error ?? 'unknown'}`]
      return null
    }
    try {
      return await fn(conn)
    } finally {
      closeConnection(conn)
    }
  }

  // -------------------------------------------------------------------------
  // 九方法 1：probeHealth
  // -------------------------------------------------------------------------

  async function probeHealth(): Promise<ProviderHealth> {
    if (!existsSync(dbPath)) {
      return {
        installed: false,
        health: 'unavailable',
        healthDetail: `zcode db.sqlite not found at ${dbPath}`,
      }
    }
    // schema 白名单比对（直连优先；失败降级快照——两路都可用性真实呈现）
    const conn = await withReadConnection(async (c) => {
      const main = checkSchema(c.db, ZCODE_DB_REQUIRED_SCHEMA)
      const tasks = existsSync(tasksIndexPath) ? readTasksSchema() : { ok: false, problems: ['tasks-index.sqlite missing'] }
      return { main, tasks, kind: c.kind }
    })
    if (conn === null) {
      return {
        installed: true,
        health: 'unavailable',
        healthDetail: `db open failed (direct + snapshot): ${stats.lastSchemaProblems[0]?.slice(0, 180) ?? 'unknown'}`,
      }
    }
    const problems = [...conn.main.problems, ...conn.tasks.problems]
    if (problems.length > 0) {
      stats.lastSchemaProblems = problems
      return {
        installed: true,
        health: 'unavailable',
        healthDetail: `schema whitelist mismatch (ZCode is closed-source; never guessing fields): ${problems.slice(0, 6).join('; ')}`,
      }
    }
    return {
      installed: true,
      health: 'ok',
      healthDetail:
        conn.kind === 'snapshot'
          ? 'read via snapshot copy (direct readOnly open failed; stale-shm CANTOPEN path)'
          : undefined,
    }
  }

  function readTasksSchema(): SchemaCheckResult {
    const direct = tryOpenReadOnly(tasksIndexPath, true)
    if (direct.conn === null) return { ok: false, problems: [`tasks-index open failed: ${direct.error ?? ''}`] }
    try {
      return checkSchema(direct.conn.db, ZCODE_TASKS_REQUIRED_SCHEMA)
    } finally {
      direct.conn.close()
    }
  }

  // -------------------------------------------------------------------------
  // 九方法 2：listSessions（全量快照；upsert 语义归 L3）
  // -------------------------------------------------------------------------

  async function listSessions(): Promise<SessionSnapshot[]> {
    return (await withReadConnection(async (conn) => {
      const check = checkSchema(conn.db, ZCODE_DB_REQUIRED_SCHEMA)
      if (!check.ok) {
        stats.lastSchemaProblems = check.problems
        return [] // schema 不匹配：绝不猜字段，返回空快照（health 呈现 unavailable）
      }
      // 子会话过滤（用户需求：只抓主智能体会话）：task_type 列可用 → SQL 下推双条件
      // （前缀 NOT LIKE + task_type <> 'subagent_child'），列缺失降级 → 仅前缀条件兜底。
      const taskTypeAvailable = checkSchema(conn.db, ZCODE_DB_TASK_TYPE_OPTIONAL_SCHEMA).ok
      const sql = taskTypeAvailable
        ? 'SELECT rowid, id, directory, title, time_created, time_updated, task_type FROM session WHERE id NOT LIKE ? ESCAPE \'\\\' AND (task_type IS NULL OR task_type <> ?) ORDER BY rowid LIMIT ?'
        : 'SELECT rowid, id, directory, title, time_created, time_updated FROM session WHERE id NOT LIKE ? ESCAPE \'\\\' ORDER BY rowid LIMIT ?'
      const rows = conn.db
        .prepare(sql)
        .all(
          ZCODE_SUBAGENT_ID_LIKE_PATTERN,
          ...(taskTypeAvailable ? [ZCODE_SUBAGENT_TASK_TYPE] : []),
          batchRows * 4,
        ) as unknown as Array<{
        rowid: number
        id: string
        directory: string | null
        title: string | null
        time_created: number | null
        time_updated: number | null
        task_type?: string | null
      }>
      // JS 层双保险复判（SQL WHERE 之外的第二道滤网；两者都判）
      return rows
        .filter((row) => !isZcodeSubagentSession(String(row.id), taskTypeAvailable ? (row.task_type ?? null) : undefined))
        .map((row) => ({
          nativeId: String(row.id),
          ...(row.directory !== null && row.directory.length > 0 ? { workdir: row.directory } : {}),
          ...(row.title !== null && row.title.length > 0 ? { title: row.title } : {}),
          ...(row.time_created !== null && row.time_created > 0 ? { startedAt: Math.floor(row.time_created / 1000) } : {}),
          ...(row.time_updated !== null && row.time_updated > 0 ? { lastActivityAt: Math.floor(row.time_updated / 1000) } : {}),
        }))
    })) ?? []
  }

  // -------------------------------------------------------------------------
  // 消息投影（data JSON 脱敏；part 表存在才取正文）
  // -------------------------------------------------------------------------

  function projectMessageRow(row: ZcodeMessageRow, partAvailable: boolean, conn: ZcodeReadConnection): RedactedMessage | null {
    let data: Record<string, unknown>
    try {
      const parsed = JSON.parse(row.data) as unknown
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
      data = parsed as Record<string, unknown>
    } catch {
      stats.parseFailures += 1
      return null
    }
    // 合成/隐藏消息不投影（metadata.source=todo_reminder 等 runtime 内部消息）
    if (data['synthetic'] === true) return null
    const semantics = data['semantics']
    if (semantics !== null && typeof semantics === 'object' && !Array.isArray(semantics)) {
      const visibility = (semantics as Record<string, unknown>)['uiVisibility']
      if (visibility === 'hidden') return null
    }
    const role = typeof data['role'] === 'string' && data['role'].length > 0 ? data['role'] : 'user'
    let text = ''
    if (partAvailable) {
      try {
        const parts = conn.db
          .prepare('SELECT data FROM part WHERE message_id = ? ORDER BY sequence')
          .all(row.id) as unknown as Array<{ data: string }>
        const texts: string[] = []
        for (const p of parts) {
          try {
            const po = JSON.parse(p.data) as Record<string, unknown>
            if (po['type'] === 'text' && typeof po['text'] === 'string' && po['text'].length > 0) texts.push(po['text'])
          } catch {
            stats.parseFailures += 1
          }
        }
        text = texts.join('\n')
      } catch {
        stats.parseFailures += 1
      }
    }
    if (text.length === 0) {
      // part 表缺失/无正文：退化为 data 自带字符串字段（绝不造内容）
      const direct = data['text']
      if (typeof direct === 'string') text = direct
    }
    if (text.length === 0) return null
    const time = data['time']
    let occurredAt: number | undefined
    if (time !== null && typeof time === 'object' && !Array.isArray(time)) {
      const created = (time as Record<string, unknown>)['created']
      if (typeof created === 'number' && created > 0) occurredAt = Math.floor(created / 1000)
    }
    if (occurredAt === undefined && row.time_created !== null && row.time_created > 0) {
      occurredAt = Math.floor(row.time_created / 1000)
    }
    return {
      role,
      contentRedacted: redactText(text).slice(0, messageTextCap),
      nativeMsgId: String(row.id),
      seqInSession: row.sequence ?? undefined,
      ...(occurredAt !== undefined ? { occurredAt } : {}),
      sourceRef: `db.sqlite#message_rowid=${row.rowid}`,
    }
  }

  // -------------------------------------------------------------------------
  // 九方法 3：readMessages（rowid 游标增量）
  // -------------------------------------------------------------------------

  async function readMessages(ref: SessionRef, after?: string): Promise<MessagePage> {
    const page = await withReadConnection(async (conn) => {
      const check = checkSchema(conn.db, ZCODE_DB_REQUIRED_SCHEMA)
      if (!check.ok) {
        stats.lastSchemaProblems = check.problems
        return { messages: [], cursor: after ?? '0', hasMore: false }
      }
      const partAvailable = checkSchema(conn.db, ZCODE_DB_OPTIONAL_SCHEMA).ok
      const from = after !== undefined ? Number.parseInt(after, 10) : 0
      const start = Number.isSafeInteger(from) && from > 0 ? from : 0
      const rows = conn.db
        .prepare('SELECT rowid, id, session_id, data, sequence, time_created FROM message WHERE session_id = ? AND rowid > ? ORDER BY rowid LIMIT ?')
        .all(ref.nativeId, start, batchRows) as unknown as Array<{
        rowid: number
        id: string
        session_id: string
        data: string
        sequence: number | null
        time_created: number | null
      }>
      const messages: RedactedMessage[] = []
      let cursor = start
      for (const row of rows) {
        cursor = Number(row.rowid)
        const msg = projectMessageRow(row as ZcodeMessageRow, partAvailable, conn)
        if (msg !== null) messages.push(msg)
      }
      return { messages, cursor: String(cursor), hasMore: rows.length === batchRows }
    })
    return page ?? { messages: [], cursor: after ?? '0', hasMore: false }
  }

  // -------------------------------------------------------------------------
  // 九方法 4-7：getCapabilities（恒 observed，裁决 4）/ sendReply / pause / resume
  // -------------------------------------------------------------------------

  async function getCapabilities(_ref: SessionRef): Promise<AgentCapabilitySet> {
    return {
      mode: 'observed',
      granted: [],
      verifiedAt: nowSec(),
      evidence: 'observed-only per ruling 4 (docs/12 §8.4): read-only db snapshot source, no control channel implemented',
    }
  }

  function unsupported(): CommandOutcome {
    return {
      ok: false,
      status: 'unsupported',
      errorCode: 'COMMAND_NOT_EXECUTABLE',
      detail: 'zcode is observed-only (ruling 4, docs/12 §8.4): no control channel; GUI automation and reverse engineering forbidden',
    }
  }

  // -------------------------------------------------------------------------
  // 九方法 8：startMonitor（stat 轮询 ≥5s 纪律，不 fs.watch 热路径）
  // -------------------------------------------------------------------------

  function startMonitor(sink: EventSink): MonitorHandle {
    let loopDone: Promise<void> | null = null
    const task = startMonitorTask(
      'zcode',
      (token) => {
        loopDone = runMonitorLoop(sink, token)
        return loopDone
      },
      'zcode db snapshot monitor',
    )
    return {
      providerId: 'zcode',
      async stop(): Promise<void> {
        task.cancel()
        if (loopDone !== null) await loopDone.catch(() => {})
      },
    }
  }

  interface MonitorCursors {
    message: number
    toolUsage: number
  }

  async function runMonitorLoop(sink: EventSink, token: MonitorCancelToken): Promise<void> {
    const cursors: MonitorCursors = { message: 0, toolUsage: 0 }
    /** 会话 → 待审批 tool_usage rowid 集（evalZcodeApprovalStatus 为 true 的行）。 */
    const pendingApprovals = new Map<string, Set<number>>()
    /** 会话 → 最近一次判定状态（变化沿才上抛）。 */
    const lastStatus = new Map<string, SessionStatus | null>()
    /** 会话 → 最近快照（变更沿才重发 discovered）。 */
    const knownSessions = new Map<string, { timeUpdated: number; directory: string | null; title: string | null }>()
    /** 会话 → tasks.task_status 原值缓存。 */
    const taskStatusCache = new Map<string, string>()
    const tracker = new ReadFailureTracker()
    let degraded = false
    let effectivePollMs = Math.max(pollMs, 1)

    try {
      while (!token.cancelled) {
        const result = await monitorTick(sink, token, cursors, pendingApprovals, lastStatus, knownSessions, taskStatusCache)
        if (result === null) {
          if (tracker.recordFailure()) {
            degraded = true
            effectivePollMs = Math.max(pollMs * 2, 10_000)
            sink.onProviderDegraded?.('zcode', `zcode db reads failing (${(stats.lastSchemaProblems[0] ?? 'unknown').slice(0, 160)})`)
          }
        } else {
          if (tracker.recordSuccess() && degraded) {
            degraded = false
            effectivePollMs = Math.max(pollMs, 1)
            sink.onProviderRecovered?.('zcode')
          }
        }
        await cancellableSleep(effectivePollMs, token)
      }
    } finally {
      if (residentSnapshot !== null) {
        try {
          residentSnapshot.close()
        } catch {
          /* 尽力清理 */
        }
        residentSnapshot = null
      }
    }
  }

  /** 单轮监控：null = 本轮不可用（读失败/schema 失配）。直连优先，失败才快照。 */
  async function monitorTick(
    sink: EventSink,
    token: MonitorCancelToken,
    cursors: MonitorCursors,
    pendingApprovals: Map<string, Set<number>>,
    lastStatus: Map<string, SessionStatus | null>,
    knownSessions: Map<string, { timeUpdated: number; directory: string | null; title: string | null }>,
    taskStatusCache: Map<string, string>,
  ): Promise<'ok' | null> {
    // 1) 直连 readOnly 优先（活跃 WAL 真库的常规路径；零写入）
    if (directOpenMode !== 'disabled' && existsSync(dbPath)) {
      const direct = tryOpenReadOnly(dbPath, true)
      if (direct.conn !== null) {
        stats.directOpens += 1
        try {
          const result = await tickOnConnection(direct.conn.db, 'direct', sink, token, cursors, pendingApprovals, lastStatus, knownSessions, taskStatusCache)
          if (result !== null && residentSnapshot !== null) {
            // 直连恢复（CANTOPEN 退场）：常驻快照不再需要 → 即刻清理
            try {
              residentSnapshot.close()
            } catch {
              /* 尽力清理 */
            }
            residentSnapshot = null
          }
          return result
        } finally {
          direct.conn.close()
        }
      }
      // 直连失败（CANTOPEN/锁/损坏）：快照降级
    }

    // 2) 快照路径（直连禁用模拟 or 直连失败）：常驻快照 + 周期刷新
    const snap = await ensureResidentSnapshot()
    if (snap === null) {
      stats.lastSchemaProblems = [`snapshot unavailable (direct: ${directOpenMode === 'disabled' ? 'simulated-CANTOPEN' : 'failed'})`]
      return null
    }
    if (!existsSync(snap.path)) {
      stats.lastSchemaProblems = ['snapshot db file missing']
      return null
    }
    let db: DatabaseSync
    try {
      db = new DatabaseSync(snap.path, { readOnly: true })
    } catch {
      db = new DatabaseSync(snap.path) // 陈旧 shm 需恢复：可写打开 + query_only 兜底（本域副本）
      db.exec('PRAGMA query_only = 1')
    }
    try {
      return await tickOnConnection(db, 'snapshot', sink, token, cursors, pendingApprovals, lastStatus, knownSessions, taskStatusCache)
    } finally {
      try {
        db.close()
      } catch {
        /* 幂等 */
      }
    }
  }

  /** 单轮监控主体（已持有连接）：schema 白名单 → sessions/messages/tool_usage/tasks。 */
  async function tickOnConnection(
    db: DatabaseSync,
    kind: 'direct' | 'snapshot',
    sink: EventSink,
    token: MonitorCancelToken,
    cursors: MonitorCursors,
    pendingApprovals: Map<string, Set<number>>,
    lastStatus: Map<string, SessionStatus | null>,
    knownSessions: Map<string, { timeUpdated: number; directory: string | null; title: string | null }>,
    taskStatusCache: Map<string, string>,
  ): Promise<'ok' | null> {
    const conn: ZcodeReadConnection = {
      db,
      kind,
      close: () => {
        try {
          db.close()
        } catch {
          /* 幂等 */
        }
      },
    }
    try {
      const check = checkSchema(db, ZCODE_DB_REQUIRED_SCHEMA)
      if (!check.ok) {
        stats.lastSchemaProblems = check.problems
        return null
      }
      const partAvailable = checkSchema(db, ZCODE_DB_OPTIONAL_SCHEMA).ok
      // 子会话过滤（用户需求：只抓主智能体会话）：task_type 列可用 → SQL 下推双条件，
      // 列缺失降级 → 仅前缀兜底；JS 层对全窗口行复判，命中集合供后续消息/审批/任务
      // 路径共用（这些路径漏滤会被 L3 ensureSessionRow 反向建行重新污染）。
      const taskTypeAvailable = checkSchema(db, ZCODE_DB_TASK_TYPE_OPTIONAL_SCHEMA).ok
      const subagentIds = new Set<string>()
      const tasks = readTaskStatusMap()
      if (tasks === null) {
        stats.lastSchemaProblems = ['tasks-index read failed']
        // tasks-index 读失败不否决整轮：db 侧继续（任务级状态暂缺）
      }

      // 1) sessions：新行 + 变更行（time_updated 水位）；子会话不过 sink、不入 known
      const sessionSql = taskTypeAvailable
        ? 'SELECT rowid, id, directory, title, time_created, time_updated, task_type FROM session WHERE id NOT LIKE ? ESCAPE \'\\\' AND (task_type IS NULL OR task_type <> ?) ORDER BY rowid LIMIT ?'
        : 'SELECT rowid, id, directory, title, time_created, time_updated FROM session WHERE id NOT LIKE ? ESCAPE \'\\\' ORDER BY rowid LIMIT ?'
      const sessions = db
        .prepare(sessionSql)
        .all(
          ZCODE_SUBAGENT_ID_LIKE_PATTERN,
          ...(taskTypeAvailable ? [ZCODE_SUBAGENT_TASK_TYPE] : []),
          batchRows * 4,
        ) as unknown as Array<{
        rowid: number
        id: string
        directory: string | null
        title: string | null
        time_created: number | null
        time_updated: number | null
        task_type?: string | null
      }>
      for (const row of sessions) {
        if (token.cancelled) return 'ok'
        const id = String(row.id)
        if (isZcodeSubagentSession(id, taskTypeAvailable ? (row.task_type ?? null) : undefined)) {
          subagentIds.add(id) // 双保险兜底（SQL 已滤时不应到达；防御性收集）
          continue
        }
        const timeUpdated = row.time_updated ?? 0
        const known = knownSessions.get(id)
        if (known !== undefined && known.timeUpdated >= timeUpdated) continue
        knownSessions.set(id, { timeUpdated, directory: row.directory, title: row.title })
        const snapshot: SessionSnapshot = {
          nativeId: id,
          ...(row.directory !== null && row.directory.length > 0 ? { workdir: row.directory } : {}),
          ...(row.title !== null && row.title.length > 0 ? { title: row.title } : {}),
          ...(row.time_created !== null && row.time_created > 0 ? { startedAt: Math.floor(row.time_created / 1000) } : {}),
          ...(timeUpdated > 0 ? { lastActivityAt: Math.floor(timeUpdated / 1000) } : {}),
        }
        sink.onSessionDiscovered?.('zcode', snapshot)
      }

      // 2) messages：rowid 游标增量投影
      while (!token.cancelled) {
        const rows = db
          .prepare('SELECT rowid, id, session_id, data, sequence, time_created FROM message WHERE rowid > ? ORDER BY rowid LIMIT ?')
          .all(cursors.message, batchRows) as unknown as Array<{
          rowid: number
          id: string
          session_id: string
          data: string
          sequence: number | null
          time_created: number | null
        }>
        if (rows.length === 0) break
        for (const row of rows) {
          cursors.message = Math.max(cursors.message, Number(row.rowid))
          const msgSessionId = String(row.session_id)
          // 子会话消息不投影（persistMessage 会反向建行；前缀判据对无 task_type 的
          // message 行独立成立——一切会话发现路径都不得吃子会话）
          if (subagentIds.has(msgSessionId) || isZcodeSubagentSession(msgSessionId, undefined)) continue
          const msg = projectMessageRow(row as ZcodeMessageRow, partAvailable, conn)
          if (msg !== null) sink.onMessageAppended?.({ providerId: 'zcode', nativeId: msgSessionId }, msg)
        }
        if (rows.length < batchRows) break
      }

      // 3) tool_usage：新行 → 审批追踪
      while (!token.cancelled) {
        const rows = db
          .prepare('SELECT rowid, session_id, approval_status FROM tool_usage WHERE rowid > ? ORDER BY rowid LIMIT ?')
          .all(cursors.toolUsage, batchRows) as unknown as Array<{ rowid: number; session_id: string; approval_status: string | null }>
        if (rows.length === 0) break
        for (const row of rows) {
          cursors.toolUsage = Math.max(cursors.toolUsage, Number(row.rowid))
          const sid = String(row.session_id)
          // 子会话审批不追踪（applySessionStatus 会反向建行）
          if (subagentIds.has(sid) || isZcodeSubagentSession(sid, undefined)) continue
          if (evalZcodeApprovalStatus(row.approval_status)) {
            let set = pendingApprovals.get(sid)
            if (set === undefined) {
              set = new Set()
              pendingApprovals.set(sid, set)
            }
            if (!set.has(Number(row.rowid))) {
              set.add(Number(row.rowid))
              emitStatus(sid, pendingApprovals, taskStatusCache, lastStatus, sink)
            }
          }
        }
        if (rows.length < batchRows) break
      }

      // 4) 待审批行复核（resolved 后从追踪集移除 → 状态回退沿）
      for (const [sid, set] of [...pendingApprovals.entries()]) {
        if (set.size === 0) continue
        const rowids = [...set].slice(0, batchRows)
        const placeholders = rowids.map(() => '?').join(', ')
        const rows = db
          .prepare(`SELECT rowid, approval_status FROM tool_usage WHERE rowid IN (${placeholders})`)
          .all(...rowids) as unknown as Array<{ rowid: number; approval_status: string | null }>
        const stillPending = new Set(rowids)
        for (const row of rows) {
          if (!evalZcodeApprovalStatus(row.approval_status)) stillPending.delete(Number(row.rowid))
        }
        for (const resolved of rowids.filter((r) => !stillPending.has(r))) set.delete(resolved)
        if (stillPending.size === 0) pendingApprovals.set(sid, set)
        emitStatus(sid, pendingApprovals, taskStatusCache, lastStatus, sink)
      }

      // 5) task_status 复核（UPDATE 不 bump rowid → 每轮全量小表重读）；子会话任务
      //    状态不上抛（同上：applySessionStatus 反向建行）
      if (tasks !== null) {
        for (const [taskId, raw] of tasks) {
          if (subagentIds.has(taskId) || isZcodeSubagentSession(taskId, undefined)) continue
          if (taskStatusCache.get(taskId) !== raw) {
            taskStatusCache.set(taskId, raw)
            emitStatus(taskId, pendingApprovals, taskStatusCache, lastStatus, sink)
          }
        }
      }
      return 'ok'
    } catch (e) {
      stats.lastSchemaProblems = [`tick failed: ${e instanceof Error ? e.message : String(e)}`]
      return null
    }
  }

  /** tasks-index → Map<task_id, task_status 原值>（失败返回 null）。 */
  function readTaskStatusMap(): Map<string, string> | null {
    const direct = tryOpenReadOnly(tasksIndexPath, true)
    if (direct.conn === null) return null
    try {
      const check = checkSchema(direct.conn.db, ZCODE_TASKS_REQUIRED_SCHEMA)
      if (!check.ok) {
        stats.lastSchemaProblems = check.problems
        return null
      }
      const rows = direct.conn.db.prepare('SELECT task_id, task_status FROM tasks').all() as unknown as Array<{
        task_id: string
        task_status: string | null
      }>
      const map = new Map<string, string>()
      for (const row of rows) map.set(String(row.task_id), row.task_status ?? '')
      return map
    } catch {
      return null
    } finally {
      direct.conn.close()
    }
  }

  /** 会话状态评估 + 变化沿上抛：审批等待 > task_status 映射 > 无证据。 */
  function emitStatus(
    sessionId: string,
    pendingApprovals: Map<string, Set<number>>,
    taskStatusCache: Map<string, string>,
    lastStatus: Map<string, SessionStatus | null>,
    sink: EventSink,
  ): void {
    let next: SessionStatus | null
    if ((pendingApprovals.get(sessionId)?.size ?? 0) > 0) {
      next = 'approval_required'
    } else {
      const raw = taskStatusCache.get(sessionId)
      next = raw !== undefined ? evalZcodeTaskStatus(raw) : null
    }
    const previous = lastStatus.get(sessionId)
    if (next === null) {
      // 证据消失（审批闭环且无任务终态）且曾经有判定 → 回退 unknown（判定未定，绝不猜）
      if (previous !== undefined && previous !== null && previous !== 'unknown') {
        lastStatus.set(sessionId, 'unknown')
        sink.onStatusChanged?.({ providerId: 'zcode', nativeId: sessionId }, previous, 'unknown')
      }
      return
    }
    if (next === previous) return
    lastStatus.set(sessionId, next)
    sink.onStatusChanged?.({ providerId: 'zcode', nativeId: sessionId }, previous ?? undefined, next)
  }

  // -------------------------------------------------------------------------
  // 九方法 9：dispose + 诊断投影
  // -------------------------------------------------------------------------

  async function dispose(): Promise<void> {
    if (residentSnapshot !== null) {
      try {
        residentSnapshot.close()
      } catch {
        /* 尽力清理 */
      }
      residentSnapshot = null
    }
  }

  function describeDiagnostics(): ProviderDiagnosticsInfo {
    return {
      dataSource: {
        kind: 'zcode-db-readonly-snapshot',
        readable: stats.lastSchemaProblems.length === 0,
        detail:
          stats.lastSchemaProblems.length > 0
            ? `schema/open problems: ${stats.lastSchemaProblems.slice(0, 4).join('; ').slice(0, 200)}`
            : `direct opens: ${stats.directOpens}, snapshot opens: ${stats.snapshotOpens}, parse failures: ${stats.parseFailures}`,
      },
      control: {
        note: 'observed-only (ruling 4, docs/12 §8.4): no control channel implemented',
      },
    }
  }

  return {
    id: 'zcode',
    probeHealth,
    listSessions,
    readMessages,
    getCapabilities,
    sendReply: async () => unsupported(),
    pause: async () => unsupported(),
    resume: async () => unsupported(),
    startMonitor,
    dispose,
    describeDiagnostics,
  }
}
