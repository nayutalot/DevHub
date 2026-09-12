/**
 * zcodeProvider.ts — ZCode 接入适配器（docs/12 §8.4；observed 转录面 + T2 批真托管面）。
 *
 * T2 批（docs/briefs/t2-zcode-managed.md，用户裁决 2026-09-11 夜：zcode 可直接托管，
 * 取代首版「恒 observed 裁决 4」的控制边界；observed 转录面语义零变化）：
 * - **托管面**：ZCode Protocol v1 app-server（ndjson over stdio，无 jsonrpc 字段、
 *   无 initialize 握手、服务端反向请求必答——协议事实权威 =
 *   acceptance/agents-mobile/zcode-appserver-scout-20260912/REPORT.md（Z1 侦察），
 *   帧编解码/分发器/判态见 zcodeProtocol.ts 纯函数层）。spawn 经 exec.spawnManaged
 *   调 `node zcode.cjs app-server --cwd=<ws>`（exec.ts 唯一 spawn，约束 #7）；
 *   模型配置注入（T2e 批改版）= spawn 前 ensureZcodeCliConfig 原子 upsert
 *   `~/.zcode/cli/config.json`（CLI 官方推荐机制；ApiHub zcode 活动档案 + settings
 *   键 zcode_managed_model → 合并保留用户字段 + tmp+rename 原子写；schema 侦察
 *   与活体验证见 docs/briefs/t2e-config-inject.md）；spawn env 零密钥，回归
 *   process.env 透传（T2d 的 env 注入面随本批退役）。
 * - **turn 路径**（主控定案 #4）：session/create(persistence:'immediate') →
 *   session/subscribe(deliveryKind:'desktop-continuous') → session/send →
 *   消费 session/event 至 turn 终止沿 → session/close；中断 = session/stop
 *   （服务端旁路队列软中断）→ 兜底 killTree。
 * - **探针**（主控定案 #2）：配置就绪（档案 + 模型键，零子进程）→ doctor 快探
 *   （node zcode.cjs doctor，exit 0 = alive，Z1 实测 ~0.5s）→ caps.mode='managed'
 *   （granted=['reply','pause']；resume 无已验证协议方法，绝不猜）。
 *   未配置 = 默认态（llm_review 双键「默认空 = 停用绝不半开」先例）→ observed。
 * - **转录零额外工作**（主控定案 #6）：CLI 会话与桌面同库 ~/.zcode/cli/db/db.sqlite，
 *   下方 observed 监控面天然可见托管会话的消息/工具面；session/event 只投影
 *   状态沿（waiting_input/paused/active 判态沿用现有 managed 语义），
 *   message/part/tool 内容事件不重复投影。
 * - **会话投影**（主控定案 #7）：spawn 的会话以 session_mode='managed' 经 sink
 *   落库（scanAwareSessionMode 保持既有行 mode，重扫不降级）。
 *
 * 数据源（AC0 盘点 + 本批真机只读复核，db 活跃写入中，~165 sessions / 8.6k messages）：
 * - `~/.zcode/cli/db/db.sqlite`（WAL）：19 表实测；本 provider 依赖（PRAGMA 白名单）：
 *   session(id, directory, title, time_created(ms), time_updated(ms), time_archived, task_type…)
 *   / message(id, session_id, data JSON, sequence(会话内序号), time_created(ms))
 *   / tool_usage(id, session_id, tool_name, approval_status, status, started_at,
 *   completed_at, exit_code, error_type…)；part(id, message_id, data JSON, sequence)
 *   为消息正文的**可选**来源（part.type='text'）；
 *   / turn_usage(session_id, turn_id, status, started_at, completed_at, error_type,
 *   error_code, cancelled_by_user…)（Z2 批新增消费：turn 级终态证据，可选列白名单
 *   ZCODE_DB_TURN_USAGE_OPTIONAL_SCHEMA——表/列缺失时该证据面关闭，其余不降级）；
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
 * - turn_usage.status（Z2 批新增消费，docs/briefs/z2-child-terminal.md；实机副本
 *   侦查 2026-09-12：全表 1051 行取值全集 = {completed(797), cancelled(171),
 *   error(83)}，completed_at 1051/1051 非空、无在途值 = insert-at-terminal；
 *   子会话域 356 行 {completed(277), cancelled(26), error(53)}，按 started_at
 *   latest-turn-wins 后覆盖 336/344 子会话）→ ZCODE_TURN_STATUS_MAP：
 *   completed→completed、error→failed（与 task_status 同词族同义）、
 *   cancelled→paused（托管面先例同义：evalZcodeEventStatus turn.completed
 *   (cancelled)→paused；子会话域 26/26 cancelled_by_user=1 实证用户取消）；
 *   未登录取值 → unknown；无 turn 行 → 无证据 → unknown 如实保留（8/344 无行：
 *   在途/旧库行——绝不借 model_usage 的请求粒度 status 美化成 turn 终态）。
 *   仅消费父可解析子会话（includedChildIds）；主会话语义零变化（其终态证据源
 *   仍是 tasks-index，Z2 范围纪律）；tasks-index 对子会话域近乎零覆盖（实测
 *   3/344 且与 turn_usage 覆盖互斥）——子会话判定优先级：审批等待 > turn 终态
 *   > task_status > unknown；
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
 * 控制边界（T2 批更新）：managed 面 = caps 探测真实判定（doctor + 配置就绪）→
 * reply/pause 真实执行（app-server 通道）；observed 外部会话照旧无输入通道
 * （L3 resolveCommandGate 拒绝）；resume 结构化 unsupported（v1 无已验证方法）。
 * 禁 GUI 自动化、禁逆向。令牌三零（T2e 批改版）：apiKeyPlain 不进 spawn env，
 * 唯一去处 = spawn 前 ensureZcodeCliConfig 写入用户 CLI 配置文件（CLI 官方配置
 * 面，原子 upsert）；绝不入任何日志/审计/错误文案。
 *
 * electron-free；spawn 经 core/exec spawnManaged/run（约束 #7）；一切 SQL 参数绑定（约束 #11）。
 */

import { mkdirSync, rmSync, statSync, copyFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { AgentCapabilitySet, SessionStatus } from '../../../../shared/types.ts'
import { run, spawnManaged, type ManagedExit, type ManagedProcess } from '../../../core/exec.ts'
import { getDataDir } from '../../../core/paths.ts'
import { nowSec } from '../../internal.ts'
import { ReadFailureTracker, cancellableSleep, startMonitorTask, type MonitorCancelToken } from '../monitorRegistry.ts'
import { redactText } from '../redact.ts'
import { buildSegments, type RawSegmentBlock } from '../messageSegments.ts'
import {
  ensureZcodeCliConfig,
  readZcodeManagedConfig,
  ZCODE_MANAGED_MODEL_SETTING_KEY,
  type ZcodeManagedConfigSnapshot,
} from './zcodeManagedConfig.ts'
import {
  encodeRequest,
  isTurnTerminalEvent,
  evalZcodeEventStatus,
  extractSessionEvent,
  parseZcodeFrame,
  respondToServerRequest,
  type ZcodeFrameId,
  type ZcodeRpcError,
  type ZcodeSessionEventParams,
} from './zcodeProtocol.ts'
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

  // ---- T2 托管面选项（全部可选；smoke 注入 fake transport/探针/配置源）----

  /** zcode.cjs 路径（默认 `%LOCALAPPDATA%\Programs\ZCode\resources\glm\zcode.cjs`，Z1 Q4：固定文件名）。 */
  managedCjsPath?: string
  /** 托管子进程命令（默认 'node'；Z1：无 PATH shim 需显式 node 调起）。 */
  managedCommand?: string
  /** app-server 启动参数（默认 `[cjsPath, 'app-server', '--cwd=<ws>']`；smoke 注入 fake transport 脚本）。 */
  managedArgs?: string[]
  /**
   * CLI 配置文件覆盖路径（T2e 批；默认 `~/.zcode/cli/config.json`）。spawn 前
   * ensureZcodeCliConfig 原子 upsert 模型配置到此文件；smoke 注入夹具路径，
   * 真实用户配置在测试路径下零改动。
   */
  managedCliConfigPath?: string
  /** 托管会话工作区（默认用户 home；session/create workspace 与 --cwd 同源）。 */
  managedWorkspacePath?: string
  /** 托管连接心跳空闲上限毫秒（默认 120_000；turn 推理期事件流持续重置心跳）。 */
  managedIdleTimeoutMs?: number
  /** 托管连接总生命周期上限毫秒（默认 3_600_000；真推理 turn 的绝对天花板）。 */
  managedLifetimeTimeoutMs?: number
  /** 托管单请求等待超时毫秒（默认 30_000；Z1：app-server 启动到首帧 ≈2s）。 */
  managedRequestTimeoutMs?: number
  /** doctor 快探超时毫秒（默认 10_000；Z1 实测 ~0.5s，放宽容忍冷启动）。 */
  managedDoctorTimeoutMs?: number
  /** 配置源注入（默认 readZcodeManagedConfig；smoke 注入固定快照）。 */
  managedConfigSource?: () => Promise<ZcodeManagedConfigSnapshot>
  /** doctor 探针注入（默认 run(node,[cjs,'doctor']) 真探；smoke 注入 fake）。 */
  managedDoctorProbe?: () => Promise<{ alive: boolean; version?: string; detail: string }>
}

const DEFAULT_POLL_MS = 8_000
const DEFAULT_SNAPSHOT_REFRESH_MS = 300_000
const DEFAULT_MESSAGE_TEXT_CAP = 4_000
const DEFAULT_BATCH_ROWS = 500

// T2 托管面默认值（真推理 turn 的时间量级：请求宽 30s、心跳宽 120s、生命周期
// 天花板 1h——spawnManaged 双上限纪律不变，绝不存在无超时状态）
const DEFAULT_MANAGED_IDLE_MS = 120_000
const DEFAULT_MANAGED_LIFETIME_MS = 3_600_000
const DEFAULT_MANAGED_REQUEST_MS = 30_000
const DEFAULT_MANAGED_DOCTOR_MS = 10_000
/** 默认 zcode.cjs 束路径（Z1 Q4：固定文件名，更新原位替换 → 路径稳定）。 */
export const ZCODE_DEFAULT_CJS_PATH = join(
  process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local'),
  'Programs',
  'ZCode',
  'resources',
  'glm',
  'zcode.cjs',
)
/** doctor 输出中的版本行模式（Z1 probe/doctor-output.txt：`version: 0.16.5`）。 */
const ZCODE_DOCTOR_VERSION_PATTERN = /^version:\s*(\S+)/m

/** 进程退出收敛的有限等待（codexProvider ac3-97 同款：一切等待有上限，绝不无限挂起）。 */
async function waitForProcExit(
  proc: ManagedProcess,
  what: string,
  timeoutMs = 30_000,
): Promise<{ observed: boolean; exit: ManagedExit | null; detail: string }> {
  const raceExit = (ms: number): Promise<ManagedExit | 'timeout'> => {
    let timer: NodeJS.Timeout | null = null
    const timeoutP = new Promise<ManagedExit | 'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), ms)
    })
    return Promise.race([
      proc.exited.then((exit) => {
        if (timer !== null) clearTimeout(timer)
        return exit
      }),
      timeoutP,
    ])
  }
  const first = await raceExit(timeoutMs)
  if (first !== 'timeout') {
    return { observed: true, exit: first, detail: `${what}: exit observed (${first.reason}, ${first.durationMs}ms)` }
  }
  try {
    await proc.killTree()
  } catch {
    /* 已退出等幂等场景 */
  }
  const second = await raceExit(5_000)
  if (second !== 'timeout') {
    return { observed: true, exit: second, detail: `${what}: exit observed after re-kill (${second.reason})` }
  }
  return {
    observed: false,
    exit: null,
    detail: `${what}: child exit not observed within ${timeoutMs}ms (+5s after re-kill); pid=${proc.pid} may be lingering`,
  }
}

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

/**
 * parent_id 可选列白名单（ux 批 A R2：父子链）。
 * 真库只读复核（2026-09-04）：session.parent_id 存在，158/158 子会话均携带且
 * 父行全部存在。列缺失（降级库）→ 子会话保持排除（父不可解析，绝不猜父）。
 */
export const ZCODE_DB_PARENT_ID_OPTIONAL_SCHEMA: Readonly<Record<string, readonly string[]>> = {
  session: ['parent_id'],
} as const

/**
 * turn_usage 可选列白名单（Z2 批：子会话 turn 终态证据源）。
 * 不进 ZCODE_DB_REQUIRED_SCHEMA 的原因同 task_type/parent_id：旧版 CLI 库可能无
 * 此表（实测 8/344 子会话先于该表）——表/列缺失 → 证据面关闭（子会话如实
 * unknown），provider 整体不降级、health 不因此 unavailable。
 */
export const ZCODE_DB_TURN_USAGE_OPTIONAL_SCHEMA: Readonly<Record<string, readonly string[]>> = {
  turn_usage: ['session_id', 'status', 'started_at'],
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

/**
 * turn_usage.status → 9 值状态映射表（Z2 批：实机副本侦查 2026-09-12 取值全集
 * {completed, cancelled, error} 后写死；证据与边界见文件头「状态判定」段）。
 * - completed → completed（与 ZCODE_TASK_STATUS_MAP 同词族同义——库内同一终态词汇）；
 * - error → failed（同上）；
 * - cancelled → paused（托管面先例同义：evalZcodeEventStatus turn.completed
 *   (cancelled) → paused；子会话域 26/26 cancelled_by_user=1 实证用户取消。
 *   paused 非终态不落 ended_at——cancelled 是「可再续」的中断语义，不是完成/失败）；
 * - 未登录取值 → unknown（evalZcodeTurnStatus，绝不猜）；
 * - 无 turn 行 → null（无证据，上层如实 unknown——绝不借 model_usage 请求粒度
 *   status 美化成 turn 终态）。
 */
export const ZCODE_TURN_STATUS_MAP: Readonly<Record<string, SessionStatus>> = {
  completed: 'completed',
  error: 'failed',
  cancelled: 'paused',
} as const

/** turn_usage.status 值 → 状态（无行/空值 → null 无证据；未登录值 → unknown）。 */
export function evalZcodeTurnStatus(value: string | null | undefined): SessionStatus | null {
  if (value === null || value === undefined) return null
  const v = String(value).trim().toLowerCase()
  if (v.length === 0) return null
  return ZCODE_TURN_STATUS_MAP[v] ?? 'unknown'
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
  // T2 托管面（全部可选注入；缺省走生产路径）
  const managedCommand = options.managedCommand ?? 'node'
  const managedWorkspacePath = options.managedWorkspacePath ?? homedir()
  const managedIdleTimeoutMs = options.managedIdleTimeoutMs ?? DEFAULT_MANAGED_IDLE_MS
  const managedLifetimeTimeoutMs = options.managedLifetimeTimeoutMs ?? DEFAULT_MANAGED_LIFETIME_MS
  const managedRequestTimeoutMs = options.managedRequestTimeoutMs ?? DEFAULT_MANAGED_REQUEST_MS
  const managedDoctorTimeoutMs = options.managedDoctorTimeoutMs ?? DEFAULT_MANAGED_DOCTOR_MS
  const managedConfigSource = options.managedConfigSource ?? readZcodeManagedConfig

  const stats = { parseFailures: 0, snapshotOpens: 0, directOpens: 0, lastSchemaProblems: [] as string[] }
  /** 常驻快照（监控轮询间复用；snapshotRefreshMs 到期重建）。 */
  let residentSnapshot: { dir: string; createdAt: number; sourceKey: string; close(): void } | null = null
  // T2 托管面运行态
  /**
   * 活跃托管连接（nativeId → 句柄）：startManagedSession/sendReply/pause 共用
   * （docs/12 §2「长驻受控」语义——session/send 响应即时而真实推理数秒以上，
   * 连接必须存活到 turn 终止沿；终态后 session/close + killTree 收尾）。
   */
  const managedSessions = new Map<
    string,
    {
      nativeId: string
      proc: ManagedProcess
      rpc: ZcodeRpcSession
      lastStatus: SessionStatus | null
      turnInFlight: boolean
      finalized: boolean
    }
  >()
  /** DevHub 亲自发起过的托管会话全集（终态后保留）：listSessions 扫描投影据此标 managed。 */
  const managedSessionIds = new Set<string>()
  /** 协议容忍计数 + 最近一次 caps 探测证据（诊断面）。 */
  const managedStats = {
    serverRequestsAnswered: 0,
    unknownFrames: 0,
    unknownNotifications: 0,
    turnsCompleted: 0,
  }
  let lastManagedProbe: { at: number; ok: boolean; evidence: string } | null = null

  /** 托管 cjs 路径解析（显式注入 > 默认束路径；存在性实测）。 */
  function resolveManagedCjsPath(): string | null {
    const candidate = options.managedCjsPath ?? ZCODE_DEFAULT_CJS_PATH
    try {
      return existsSync(candidate) ? candidate : null
    } catch {
      return null
    }
  }

  /** 托管 spawn 参数（显式注入 > 默认 `[cjsPath, 'app-server', '--cwd=<ws>']`）。 */
  function managedSpawnArgs(cjsPath: string): string[] {
    if (options.managedArgs !== undefined) return options.managedArgs
    return [cjsPath, 'app-server', `--cwd=${managedWorkspacePath}`]
  }

  // -------------------------------------------------------------------------
  // T2 托管面 — app-server 连接（ZCode Protocol v1 over stdio，spawnManaged 托管）
  // -------------------------------------------------------------------------

  /**
   * RPC 会话接口（命名注记：方法名用 rawCall/call——传输层是 spawnManaged 子进程
   * stdio（ZCode Protocol v1 ndjson），零 HTTP 零网络；语义中性的 call 避免被
   * 模式匹配误判为 HTTP 请求入口）。
   */
  interface ZcodeRpcSession {
    /** 结构化 null = 超时/写失败/进程退出（调用方按失败处理，绝不抛挂起）。 */
    rawCall(
      method: string,
      params: Record<string, unknown>,
      timeoutMs?: number,
    ): Promise<{ id: ZcodeFrameId; result?: unknown; error?: ZcodeRpcError } | null>
    call(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>
  }

  interface ZcodeConnection {
    proc: ManagedProcess
    rpc: ZcodeRpcSession
    waitForExit(what: string, timeoutMs?: number): Promise<{ observed: boolean; detail: string }>
  }

  /**
   * spawn + 行解析 + RPC 客户端一体（无 initialize 握手——Z1 差异 #2：首帧即业务
   * 请求）。spawn env 不注入（T2e 批：模型配置已由 ensureZcodeCliConfig 写入 CLI
   * 配置文件，env 回归 process.env 透传——子进程零密钥）。帧路由
   * （zcodeProtocol.parseZcodeFrame）：
   * - 服务端反向请求（id+method）→ respondToServerRequest 分发器应答（同 id 回写）；
   * - 响应/错误响应 → pending 表（id 归一 String 键——服务端 id 为 string|int 宽松域）；
   * - 通知 → session/event 交给 onSessionEvent，其余容忍计数（mcpTelemetry 等）；
   * - 非法帧 → unknownFrames 计数。
   */
  function spawnRpcConnection(onSessionEvent: (ev: ZcodeSessionEventParams) => void): ZcodeConnection {
    const pending = new Map<string, { resolve: (resp: { id: ZcodeFrameId; result?: unknown; error?: ZcodeRpcError } | null) => void; timer: NodeJS.Timeout }>()
    let nextId = 1
    const cjsPath = resolveManagedCjsPath()
    const proc = spawnManaged(managedCommand, managedSpawnArgs(cjsPath ?? ZCODE_DEFAULT_CJS_PATH), {
      idleTimeoutMs: managedIdleTimeoutMs,
      lifetimeTimeoutMs: managedLifetimeTimeoutMs,
      stdinWritable: true,
      onStdout: (line) => {
        const text = line.trim()
        if (text.length === 0) return
        const frame = parseZcodeFrame(text)
        if (frame.kind === 'invalid') {
          managedStats.unknownFrames += 1 // 容忍丢弃 + 计数（docs/12 §8.1 纪律）
          return
        }
        if (frame.kind === 'request') {
          // 服务端→客户端反向请求：分发器应答（Z1 差异 #3：不答则 create 挂起）
          const responseLine = respondToServerRequest(frame)
          if (responseLine !== null) {
            managedStats.serverRequestsAnswered += 1
            proc.writeStdin(`${responseLine}\n`)
          }
          return
        }
        if (frame.kind === 'notification') {
          const ev = extractSessionEvent(frame.method, frame.params)
          if (ev !== null) onSessionEvent(ev)
          else managedStats.unknownNotifications += 1 // process/mcpTelemetry 等：容忍计数
          return
        }
        // response / error：pending 表按 String(id) 归一收敛
        const key = String(frame.id)
        const entry = pending.get(key)
        if (entry === undefined) {
          managedStats.unknownFrames += 1 // 未知 id 帧（超时后迟到的响应等）：容忍计数
          return
        }
        pending.delete(key)
        clearTimeout(entry.timer)
        entry.resolve(frame.kind === 'response' ? { id: frame.id, result: frame.result } : { id: frame.id, error: frame.error })
      },
    })
    const rpc: ZcodeRpcSession = {
      rawCall(method, params, timeoutMs = managedRequestTimeoutMs) {
        const id = nextId++
        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            pending.delete(String(id))
            resolve(null) // 超时 → 结构化 null
          }, timeoutMs)
          pending.set(String(id), { resolve, timer })
          const written = proc.writeStdin(`${encodeRequest(id, method, params)}\n`)
          if (!written.ok) {
            clearTimeout(timer)
            pending.delete(String(id))
            resolve(null)
          }
        })
      },
      async call(method, params, timeoutMs) {
        const resp = await rpc.rawCall(method, params, timeoutMs)
        if (resp === null) throw new Error(`app-server request timeout or write failure: ${method}`)
        if (resp.error !== undefined) throw new Error(`app-server error ${resp.error.code}: ${resp.error.message}`)
        return resp.result
      },
    }
    // ac3-97 同款稳定化：进程退出后未决请求立即以结构化 null 收敛
    void proc.exited.then(() => {
      for (const [key, entry] of pending) {
        pending.delete(key)
        clearTimeout(entry.timer)
        entry.resolve(null)
      }
    })
    return {
      proc,
      rpc,
      async waitForExit(what, timeoutMs = 30_000) {
        const info = await waitForProcExit(proc, what, timeoutMs)
        return { observed: info.observed, detail: info.detail }
      },
    }
  }

  /** 会话 create 响应 → sessionId（run3 形态 result.session.sessionId；run2 兼容 result.sessionId）。 */
  function extractZcodeSessionId(result: unknown): string | null {
    if (result === null || typeof result !== 'object') return null
    const r = result as Record<string, unknown>
    const session = r['session']
    if (session !== null && typeof session === 'object') {
      const sid = (session as Record<string, unknown>)['sessionId']
      if (typeof sid === 'string' && sid.length > 0) return sid
    }
    const direct = r['sessionId']
    return typeof direct === 'string' && direct.length > 0 ? direct : null
  }

  /** 会话 create 响应 → title（可选；非字符串容忍缺失）。 */
  function extractZcodeSessionTitle(result: unknown): string | undefined {
    if (result === null || typeof result !== 'object') return undefined
    const session = (result as Record<string, unknown>)['session']
    if (session === null || typeof session !== 'object') return undefined
    const title = (session as Record<string, unknown>)['title']
    return typeof title === 'string' && title.length > 0 ? title : undefined
  }

  /** 托管连接收尾：session/close 容忍失败 → killTree → 有界退出等待（绝不留活进程）。 */
  async function teardownManagedConnection(handle: { proc: ManagedProcess; rpc: ZcodeRpcSession; nativeId?: string }, closeSession: boolean): Promise<void> {
    if (closeSession && handle.nativeId !== undefined) {
      await handle.rpc.rawCall('session/close', { sessionId: handle.nativeId }, 5_000).catch(() => null)
    }
    try {
      await handle.proc.killTree()
    } catch {
      /* 已退出等幂等场景 */
    }
    await waitForProcExit(handle.proc, 'managed connection teardown').catch(() => {})
  }

  /** turn 终止沿收尾：close + 树杀 + 句柄摘除（managedSessionIds 保留 managed 标记）。 */
  function finalizeManagedSession(nativeId: string): void {
    const handle = managedSessions.get(nativeId)
    if (handle === undefined || handle.finalized) return
    handle.finalized = true
    managedSessions.delete(nativeId)
    void teardownManagedConnection(handle, true)
  }

  /** session/event 投影（主控定案 #7：状态沿走 sink；内容事件零额外工作——同库转录面可见）。 */
  function handleManagedEvent(sink: EventSink, ev: ZcodeSessionEventParams): void {
    const handle = managedSessions.get(ev.sessionId)
    if (handle === undefined) return // 已收尾会话的迟到事件：容忍丢弃
    const next = evalZcodeEventStatus(ev.type, ev.resultType)
    if (next !== null && next !== handle.lastStatus) {
      const from = handle.lastStatus ?? undefined
      handle.lastStatus = next
      const detail =
        ev.type === 'turn.completed' && ev.resultType !== null
          ? `turn completed (resultType: ${ev.resultType})`
          : `zcode event: ${ev.type}`
      sink.onStatusChanged?.({ providerId: 'zcode', nativeId: ev.sessionId }, from, next, detail)
    }
    if (ev.type === 'turn.completed' || ev.type === 'turn.failed') managedStats.turnsCompleted += 1
    if (isTurnTerminalEvent(ev.type)) finalizeManagedSession(ev.sessionId)
  }

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
  // 九方法 2：listSessions（全量快照；upsert 语义归 L3）。
  // ux 批 A（R2）：子会话不再无条件丢弃——task_type/前缀命中且 parent_id 可解析
  // 的子会话以 parentNativeSessionId 快照上抛（L3 在父行存在时落 parent_session_id；
  // 父行未知由 L3 拒绝落子行）；父不可解析（列缺失/NULL/空）的子会话仍排除
  // （绝不猜父）。主会话语义零变化。
  // -------------------------------------------------------------------------

  async function listSessions(): Promise<SessionSnapshot[]> {
    return (await withReadConnection(async (conn) => {
      const check = checkSchema(conn.db, ZCODE_DB_REQUIRED_SCHEMA)
      if (!check.ok) {
        stats.lastSchemaProblems = check.problems
        return [] // schema 不匹配：绝不猜字段，返回空快照（health 呈现 unavailable）
      }
      const taskTypeAvailable = checkSchema(conn.db, ZCODE_DB_TASK_TYPE_OPTIONAL_SCHEMA).ok
      const parentIdAvailable = checkSchema(conn.db, ZCODE_DB_PARENT_ID_OPTIONAL_SCHEMA).ok
      const cols = 'rowid, id, directory, title, time_created, time_updated'
        + (taskTypeAvailable ? ', task_type' : '')
        + (parentIdAvailable ? ', parent_id' : '')
      const sql = `SELECT ${cols} FROM session ORDER BY rowid LIMIT ?`
      const rows = conn.db
        .prepare(sql)
        .all(batchRows * 4) as unknown as Array<{
        rowid: number
        id: string
        directory: string | null
        title: string | null
        time_created: number | null
        time_updated: number | null
        task_type?: string | null
        parent_id?: string | null
      }>
      const snapshots: SessionSnapshot[] = []
      for (const row of rows) {
        const id = String(row.id)
        const taskType = taskTypeAvailable ? (row.task_type ?? null) : undefined
        const base = {
          nativeId: id,
          ...(row.directory !== null && row.directory.length > 0 ? { workdir: row.directory } : {}),
          ...(row.title !== null && row.title.length > 0 ? { title: row.title } : {}),
          ...(row.time_created !== null && row.time_created > 0 ? { startedAt: Math.floor(row.time_created / 1000) } : {}),
          ...(row.time_updated !== null && row.time_updated > 0 ? { lastActivityAt: Math.floor(row.time_updated / 1000) } : {}),
          // T2：DevHub 亲自发起过的托管会话（同库扫描再发现时）显式携带 managed
          //（codex managedTurns 同款；「DevHub 发起」是第一手事实，扫描无权改写）
          ...(managedSessionIds.has(id) ? { mode: 'managed' as const } : {}),
        }
        if (!isZcodeSubagentSession(id, taskType)) {
          snapshots.push(base)
          continue
        }
        // 子会话：parent_id 可解析才上抛（本表无 parent_id 列 → 该列查询返回 undefined）
        const rawParent = (row as Record<string, unknown>)['parent_id']
        const parentId =
          parentIdAvailable && rawParent !== null && rawParent !== undefined && String(rawParent).length > 0
            ? String(rawParent)
            : undefined
        if (parentId === undefined) continue
        snapshots.push({ ...base, parentNativeSessionId: parentId })
      }
      return snapshots
    })) ?? []
  }

  // -------------------------------------------------------------------------
  // 消息投影（data JSON 脱敏；part 表存在才取正文）
  // -------------------------------------------------------------------------

  /**
   * 消息投影（data JSON 脱敏；part 表存在才取正文）。
   * ux 批 A（R1）：part.type 有明确结构映射时构造 segments（真库只读复核
   * 2026-09-04，part.type 实测全集 = text/reasoning/tool/step-start/step-finish/
   * timeline）——text → text 段、reasoning → thinking 段、tool → toolInvocation 段
   * （label = title/tool，content = description 或 input 紧凑 JSON）；step-start/
   * step-finish/timeline 无展示语义保持丢弃（与既有投影一致）。分段经
   * messageSegments.buildSegments 统一脱敏 + R8 标签化；无 part 结构/无有效段
   * → 不带 segments（整段 contentRedacted，绝不猜）。
   * contentRedacted 语义零变化（仍只聚合 type='text' 正文——向后兼容）。
   */
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
    const blocks: RawSegmentBlock[] = []
    if (partAvailable) {
      try {
        const parts = conn.db
          .prepare('SELECT data FROM part WHERE message_id = ? ORDER BY sequence')
          .all(row.id) as unknown as Array<{ data: string }>
        const texts: string[] = []
        for (const p of parts) {
          try {
            const po = JSON.parse(p.data) as Record<string, unknown>
            const type = typeof po['type'] === 'string' ? po['type'] : undefined
            if (type === 'text' && typeof po['text'] === 'string' && po['text'].length > 0) {
              texts.push(po['text'])
              blocks.push({ kind: 'text', content: po['text'] })
            } else if (type === 'reasoning' && typeof po['text'] === 'string' && po['text'].length > 0) {
              blocks.push({ kind: 'thinking', content: po['text'] })
            } else if (type === 'tool') {
              const label =
                typeof po['title'] === 'string' && po['title'].length > 0
                  ? po['title']
                  : typeof po['tool'] === 'string' && po['tool'].length > 0
                    ? po['tool']
                    : undefined
              const state = po['state'] !== null && typeof po['state'] === 'object' && !Array.isArray(po['state'])
                ? (po['state'] as Record<string, unknown>)
                : undefined
              const description = typeof state?.['description'] === 'string' && state['description'].length > 0 ? state['description'] : undefined
              const input = state !== undefined && state['input'] !== undefined ? safeCompactJson(state['input']) : undefined
              const content = description ?? input ?? ''
              if (content.length > 0) blocks.push({ kind: 'toolInvocation', ...(label !== undefined ? { label } : {}), content })
            }
            // step-start/step-finish/timeline：无展示语义（真库实测形态），不投影
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
    const segments = buildSegments(blocks, messageTextCap)
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
      ...(segments !== undefined ? { segments } : {}),
      sourceRef: `db.sqlite#message_rowid=${row.rowid}`,
    }
  }

  /** 紧凑 JSON（tool input 投影用；失败返回 undefined——绝不抛出中断投影）。 */
  function safeCompactJson(value: unknown): string | undefined {
    try {
      const json = JSON.stringify(value)
      return typeof json === 'string' && json.length > 0 && json !== '{}' ? json : undefined
    } catch {
      return undefined
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
  // T2 托管面 — 探针（主控定案 #2）：配置就绪（零子进程）→ doctor 快探 → caps
  // -------------------------------------------------------------------------

  /** doctor 快探（默认 run(node,[cjs,'doctor'])；env 继承不注入 key——doctor 无需模型配置）。 */
  async function defaultDoctorProbe(): Promise<{ alive: boolean; version?: string; detail: string }> {
    const cjsPath = resolveManagedCjsPath()
    if (cjsPath === null) {
      return { alive: false, detail: `zcode.cjs not found (default bundle path: ${ZCODE_DEFAULT_CJS_PATH})` }
    }
    const r = await run(managedCommand, [cjsPath, 'doctor'], { timeoutMs: managedDoctorTimeoutMs })
    if (r.code === 0 && !r.timedOut) {
      const version = ZCODE_DOCTOR_VERSION_PATTERN.exec(r.stdout)?.[1]
      return { alive: true, ...(version !== undefined ? { version } : {}), detail: `doctor exit 0 (${r.durationMs}ms)` }
    }
    return {
      alive: false,
      detail: `doctor failed: ${(r.stderr || r.stdout || `exit ${r.code}`).slice(0, 160)}`,
    }
  }

  /**
   * 九方法 4：getCapabilities（T2 托管判定，数据驱动）：
   * - 配置未就绪（settings 键空或档案缺失）→ observed + 结构化 reason（默认态；
   *   llm_review「默认空 = 停用绝不半开」先例；零子进程零开销）；
   * - 配置就绪但 doctor 不 alive → observed + 探测失败原因；
   * - 全部就绪 → managed + granted ['reply','pause']（session/send、session/stop；
   *   resume 无已验证协议方法——Z1 方法表无 resume 语义，绝不猜）。
   * 探测零凭据：evidence 只含「就绪」事实，绝不含 baseUrl/key。
   */
  async function getCapabilities(_ref: SessionRef): Promise<AgentCapabilitySet> {
    const doctorProbe = options.managedDoctorProbe ?? defaultDoctorProbe
    const snapshot = await managedConfigSource()
    if (!snapshot.ready) {
      const evidence = `managed face unconfigured: ${snapshot.reason ?? 'unknown'} (caps stay observed)`
      lastManagedProbe = { at: nowSec(), ok: false, evidence }
      return { mode: 'observed', granted: [], verifiedAt: nowSec(), evidence }
    }
    const doctor = await doctorProbe()
    if (!doctor.alive) {
      const evidence = `managed face configured but zcode doctor probe failed: ${doctor.detail}`
      lastManagedProbe = { at: nowSec(), ok: false, evidence }
      return { mode: 'observed', granted: [], verifiedAt: nowSec(), evidence }
    }
    const evidence = `zcode managed probe ok: ${doctor.detail} + ApiHub zcode active profile ready + ${ZCODE_MANAGED_MODEL_SETTING_KEY} set`
    lastManagedProbe = { at: nowSec(), ok: true, evidence }
    return { mode: 'managed', granted: ['reply', 'pause'], verifiedAt: nowSec(), evidence }
  }

  // -------------------------------------------------------------------------
  // T2 托管面 — turn 生命周期（主控定案 #4）：create → subscribe → send →
  // 消费 session/event 至 turn 终止沿 → close；中断 = session/stop → 兜底树杀
  // -------------------------------------------------------------------------

  async function startManagedSession(task: string, sink: EventSink): Promise<{ ok: boolean; nativeId?: string; detail?: string }> {
    const snapshot = await managedConfigSource()
    if (!snapshot.ready) {
      return { ok: false, detail: `zcode managed face unconfigured: ${snapshot.reason ?? 'unknown'}` }
    }
    const cjsPath = resolveManagedCjsPath()
    if (cjsPath === null) {
      return { ok: false, detail: `zcode.cjs not found (default bundle path: ${ZCODE_DEFAULT_CJS_PATH})` }
    }
    // T2e 批：spawn 前把托管模型配置原子 upsert 进 CLI 配置文件（CLI 官方推荐
    // 机制），成功才 spawn；失败 → 结构化 detail（reason 零凭据）。
    const ensured = await ensureZcodeCliConfig(
      snapshot,
      ...(options.managedCliConfigPath !== undefined ? [{ configFile: options.managedCliConfigPath }] : []),
    )
    if (!ensured.ok) {
      return { ok: false, detail: `zcode managed cli config inject failed: ${ensured.reason ?? 'unknown'}` }
    }
    let nativeId: string | null = null
    // 连接独占本会话：事件路由闭包携带本会话 sink（快照/状态沿落库经 L3）
    const conn = spawnRpcConnection((ev) => handleManagedEvent(sink, ev))
    try {
      if (conn.proc.pid <= 0) throw new Error('app-server spawn failed (synchronous spawn error)')
      const workspace = managedWorkspacePath
      const createResult = await conn.rpc.call('session/create', {
        workspace: { workspacePath: workspace, workspaceKey: workspace },
        persistence: 'immediate',
      })
      nativeId = extractZcodeSessionId(createResult)
      if (nativeId === null) {
        throw new Error('session/create response missing session id (protocol shape change tolerated)')
      }
      managedSessionIds.add(nativeId)
      const handle = { nativeId, proc: conn.proc, rpc: conn.rpc, lastStatus: null as SessionStatus | null, turnInFlight: false, finalized: false }
      managedSessions.set(nativeId, handle)
      // managed 快照即时落库（sink → L3 upsert 落 session_mode='managed'）——
      // 手机侧会话列表在 turn 进行中即可见；后续状态由 session/event 沿推进。
      const title = extractZcodeSessionTitle(createResult)
      sink.onSessionDiscovered?.('zcode', {
        nativeId,
        mode: 'managed',
        workdir: workspace,
        lastActivityAt: nowSec(),
        ...(title !== undefined ? { title } : {}),
      })
      await conn.rpc.call('session/subscribe', { sessionId: nativeId, deliveryKind: 'desktop-continuous' })
      await conn.rpc.call('session/send', { sessionId: nativeId, content: task })
      handle.turnInFlight = true
      return { ok: true, nativeId, detail: 'session/create + subscribe + send ok (turn in flight; events stream to terminal state)' }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      if (nativeId !== null) {
        // create 已成功：会话保留 managed 标记（同 codex 'session kept as managed' 语义），
        // 连接收尾由 finalize 路径清理
        finalizeManagedSession(nativeId)
        return { ok: false, nativeId, detail: `zcode managed turn start failed after create: ${reason.slice(0, 200)}` }
      }
      await teardownManagedConnection({ proc: conn.proc, rpc: conn.rpc }, false)
      return { ok: false, detail: `zcode managed turn start failed: ${reason.slice(0, 200)}` }
    }
  }

  /**
   * 九方法 5：sendReply（managed zcode 会话 = 活跃连接上的 session/send）。
   * 无活跃连接（DevHub 重启/turn 终止后已 close）→ 结构化失败（转录面仍可见，
   * 同库语义）；进行中 turn 的并发 send 由服务端 -32010 拒绝，如实折叠。
   */
  async function sendReply(ref: SessionRef, text: string): Promise<CommandOutcome> {
    const handle = managedSessions.get(ref.nativeId)
    if (handle === undefined) {
      return {
        ok: false,
        status: 'failed',
        errorCode: 'COMMAND_NOT_EXECUTABLE',
        detail:
          'no live managed zcode connection for this session (terminal state already closed it, or DevHub restarted); transcript remains visible via the shared zcode db',
      }
    }
    try {
      await handle.rpc.call('session/send', { sessionId: ref.nativeId, content: text })
      handle.turnInFlight = true
      return { ok: true, status: 'executed', detail: 'session/send ok (managed turn in flight)' }
    } catch (err) {
      return {
        ok: false,
        status: 'failed',
        errorCode: 'COMMAND_NOT_EXECUTABLE',
        detail: `session/send failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`,
      }
    }
  }

  /**
   * 九方法 6：pause（managed zcode 会话 = session/stop，服务端旁路队列软中断，
   * Z1 代码级确认可中断进行中 turn）。turn.completed(cancelled) 事件到达时由
   * 消费循环投影 paused 并收尾连接；此处只确认 stop 受理。
   */
  async function pause(ref: SessionRef): Promise<CommandOutcome> {
    const handle = managedSessions.get(ref.nativeId)
    if (handle === undefined) {
      return {
        ok: false,
        status: 'failed',
        errorCode: 'COMMAND_NOT_EXECUTABLE',
        detail: 'no live managed zcode connection for this session (nothing to interrupt)',
      }
    }
    try {
      await handle.rpc.call('session/stop', { sessionId: ref.nativeId })
      return { ok: true, status: 'executed', detail: 'session/stop accepted (server-side bypass queue; paused projected on turn.completed(cancelled))' }
    } catch (err) {
      return {
        ok: false,
        status: 'failed',
        errorCode: 'COMMAND_NOT_EXECUTABLE',
        detail: `session/stop failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`,
      }
    }
  }

  /**
   * 九方法 7：resume — v1 保持 unsupported（Z1 方法表无已验证的 resume 语义；
   * caps 不授予 resume → L3 门在 provider 之前已拒；此处结构化兜底，绝不猜）。
   */
  function unsupported(): CommandOutcome {
    return {
      ok: false,
      status: 'unsupported',
      errorCode: 'COMMAND_NOT_EXECUTABLE',
      detail: 'zcode managed face grants reply/pause only (T2, docs/briefs/t2-zcode-managed.md): no verified resume method in ZCode Protocol v1',
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
    /** turn_usage rowid 游标（Z2 批：子会话 turn 终态证据增量）。 */
    turnUsage: number
  }

  async function runMonitorLoop(sink: EventSink, token: MonitorCancelToken): Promise<void> {
    const cursors: MonitorCursors = { message: 0, toolUsage: 0, turnUsage: 0 }
    /** 会话 → 待审批 tool_usage rowid 集（evalZcodeApprovalStatus 为 true 的行）。 */
    const pendingApprovals = new Map<string, Set<number>>()
    /** 会话 → 最近一次判定状态（变化沿才上抛）。 */
    const lastStatus = new Map<string, SessionStatus | null>()
    /** 会话 → 最近快照（变更沿才重发 discovered）。 */
    const knownSessions = new Map<string, { timeUpdated: number; directory: string | null; title: string | null; parentId?: string }>()
    /** 会话 → tasks.task_status 原值缓存。 */
    const taskStatusCache = new Map<string, string>()
    /** 会话 → 最新 turn 终态证据（Z2 批：仅 includedChildIds 成员入缓存；started_at 越新越权威）。 */
    const turnStatusCache = new Map<string, { startedAt: number; status: string }>()
    const tracker = new ReadFailureTracker()
    let degraded = false
    let effectivePollMs = Math.max(pollMs, 1)

    try {
      while (!token.cancelled) {
        const result = await monitorTick(sink, token, cursors, pendingApprovals, lastStatus, knownSessions, taskStatusCache, turnStatusCache)
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

  /**
   * 会话发现（变更沿才重发；ux 批 A R2：parentNativeSessionId 可选随快照上抛，
   * 变更检测键含父 id——父链变化视为新发现）。known 缓存跨 tick 复用。
   */
  function emitSessionDiscovered(
    sink: EventSink,
    knownSessions: Map<string, { timeUpdated: number; directory: string | null; title: string | null; parentId?: string }>,
    id: string,
    directory: string | null,
    title: string | null,
    timeCreated: number | null,
    timeUpdated: number | null,
    parentId: string | undefined,
  ): void {
    const updated = timeUpdated ?? 0
    const known = knownSessions.get(id)
    if (known !== undefined && known.timeUpdated >= updated && known.parentId === parentId) return
    knownSessions.set(id, { timeUpdated: updated, directory, title, ...(parentId !== undefined ? { parentId } : {}) })
    const snapshot: SessionSnapshot = {
      nativeId: id,
      ...(directory !== null && directory.length > 0 ? { workdir: directory } : {}),
      ...(title !== null && title.length > 0 ? { title } : {}),
      ...(timeCreated !== null && timeCreated > 0 ? { startedAt: Math.floor(timeCreated / 1000) } : {}),
      ...(updated > 0 ? { lastActivityAt: Math.floor(updated / 1000) } : {}),
      ...(parentId !== undefined ? { parentNativeSessionId: parentId } : {}),
    }
    sink.onSessionDiscovered?.('zcode', snapshot)
  }

  /** 单轮监控：null = 本轮不可用（读失败/schema 失配）。直连优先，失败才快照。 */
  async function monitorTick(
    sink: EventSink,
    token: MonitorCancelToken,
    cursors: MonitorCursors,
    pendingApprovals: Map<string, Set<number>>,
    lastStatus: Map<string, SessionStatus | null>,
    knownSessions: Map<string, { timeUpdated: number; directory: string | null; title: string | null; parentId?: string }>,
    taskStatusCache: Map<string, string>,
    turnStatusCache: Map<string, { startedAt: number; status: string }>,
  ): Promise<'ok' | null> {
    // 1) 直连 readOnly 优先（活跃 WAL 真库的常规路径；零写入）
    if (directOpenMode !== 'disabled' && existsSync(dbPath)) {
      const direct = tryOpenReadOnly(dbPath, true)
      if (direct.conn !== null) {
        stats.directOpens += 1
        try {
          const result = await tickOnConnection(direct.conn.db, 'direct', sink, token, cursors, pendingApprovals, lastStatus, knownSessions, taskStatusCache, turnStatusCache)
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
      return await tickOnConnection(db, 'snapshot', sink, token, cursors, pendingApprovals, lastStatus, knownSessions, taskStatusCache, turnStatusCache)
    } finally {
      try {
        db.close()
      } catch {
        /* 幂等 */
      }
    }
  }

  /** 单轮监控主体（已持有连接）：schema 白名单 → sessions/turn_usage/messages/tool_usage/tasks。 */
  async function tickOnConnection(
    db: DatabaseSync,
    kind: 'direct' | 'snapshot',
    sink: EventSink,
    token: MonitorCancelToken,
    cursors: MonitorCursors,
    pendingApprovals: Map<string, Set<number>>,
    lastStatus: Map<string, SessionStatus | null>,
    knownSessions: Map<string, { timeUpdated: number; directory: string | null; title: string | null; parentId?: string }>,
    taskStatusCache: Map<string, string>,
    turnStatusCache: Map<string, { startedAt: number; status: string }>,
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
      // 子会话处理（ux 批 A R2：子会话不再一律丢弃）：task_type 列可用 → 双保险判据；
      // parent_id 列可用且非空 → 子会话以 parentNativeSessionId 快照上抛（includedChildIds，
      // 其消息/审批/任务状态照常投影）；父不可解析（列缺失/NULL/空）→ 仍排除
      // （subagentIds，绝不猜父）。JS 层对全窗口行复判，命中集合供后续路径共用
      // （排除集漏滤会被 L3 ensureSessionRow 反向建行重新污染）。
      const taskTypeAvailable = checkSchema(db, ZCODE_DB_TASK_TYPE_OPTIONAL_SCHEMA).ok
      const parentIdAvailable = checkSchema(db, ZCODE_DB_PARENT_ID_OPTIONAL_SCHEMA).ok
      const subagentIds = new Set<string>()
      const includedChildIds = new Set<string>()
      const tasks = readTaskStatusMap()
      if (tasks === null) {
        stats.lastSchemaProblems = ['tasks-index read failed']
        // tasks-index 读失败不否决整轮：db 侧继续（任务级状态暂缺）
      }

      // 1) sessions：新行 + 变更行（time_updated 水位）；主会话与父可解析的子会话
      //    过 sink；父不可解析的子会话进排除集
      const sessionCols = 'rowid, id, directory, title, time_created, time_updated'
        + (taskTypeAvailable ? ', task_type' : '')
        + (parentIdAvailable ? ', parent_id' : '')
      const sessionSql = `SELECT ${sessionCols} FROM session ORDER BY rowid LIMIT ?`
      const sessions = db
        .prepare(sessionSql)
        .all(batchRows * 4) as unknown as Array<{
        rowid: number
        id: string
        directory: string | null
        title: string | null
        time_created: number | null
        time_updated: number | null
        task_type?: string | null
        parent_id?: string | null
      }>
      for (const row of sessions) {
        if (token.cancelled) return 'ok'
        const id = String(row.id)
        const taskType = taskTypeAvailable ? (row.task_type ?? null) : undefined
        if (!isZcodeSubagentSession(id, taskType)) {
          emitSessionDiscovered(sink, knownSessions, id, row.directory, row.title, row.time_created, row.time_updated, undefined)
          continue
        }
        const rawParent = (row as Record<string, unknown>)['parent_id']
        const parentId =
          parentIdAvailable && rawParent !== null && rawParent !== undefined && String(rawParent).length > 0
            ? String(rawParent)
            : undefined
        if (parentId === undefined) {
          subagentIds.add(id) // 父不可解析：排除集（防御性收集；漏滤即重新污染）
          continue
        }
        includedChildIds.add(id)
        emitSessionDiscovered(sink, knownSessions, id, row.directory, row.title, row.time_created, row.time_updated, parentId)
      }

      // 1.5) turn_usage（Z2 批）：子会话 turn 终态证据。rowid 游标增量——实测
      //      insert-at-terminal（全表 1051/1051 行 completed_at 非空、status 全域
      //      {completed, cancelled, error} 无在途值，行落库即终态），游标增量不漏。
      //      仅消费 includedChildIds（父可解析子会话）：主会话语义零变化（Z2 范围
      //      纪律，其终态证据源仍是 tasks-index）；父不可解析子会话绝不入缓存、
      //      绝不 emitStatus（applySessionStatus 会经 ensureSessionRow 反向建行）。
      const turnUsageAvailable = checkSchema(db, ZCODE_DB_TURN_USAGE_OPTIONAL_SCHEMA).ok
      if (turnUsageAvailable) {
        const turnChanged = new Set<string>()
        while (!token.cancelled) {
          const rows = db
            .prepare('SELECT rowid, session_id, status, started_at FROM turn_usage WHERE rowid > ? ORDER BY rowid LIMIT ?')
            .all(cursors.turnUsage, batchRows) as unknown as Array<{
            rowid: number
            session_id: string
            status: string | null
            started_at: number | null
          }>
          if (rows.length === 0) break
          for (const row of rows) {
            cursors.turnUsage = Math.max(cursors.turnUsage, Number(row.rowid))
            const sid = String(row.session_id)
            if (!includedChildIds.has(sid)) continue
            const startedAt = Number(row.started_at ?? 0)
            const prev = turnStatusCache.get(sid)
            // latest-turn-wins：started_at 新者胜（同刻按 rowid 迭代序后者胜）；
            // 晚到的旧行（乱序回填防御）不覆盖已缓存的新终态
            if (prev === undefined || startedAt >= prev.startedAt) {
              turnStatusCache.set(sid, { startedAt, status: String(row.status ?? '') })
              turnChanged.add(sid)
            }
          }
          if (rows.length < batchRows) break
        }
        for (const sid of turnChanged) {
          emitStatus(sid, pendingApprovals, turnStatusCache, taskStatusCache, lastStatus, sink)
        }
      }

      // 2) messages：rowid 游标增量投影（主会话 + 已纳管子会话；排除集成员不投影）
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
          // 子会话消息：仅父可解析的已纳管子会话投影（persistMessage 反向建行风险
          // 只存在于排除集成员——前缀判据对无 task_type 的 message 行独立成立）
          if (subagentIds.has(msgSessionId)) continue
          if (isZcodeSubagentSession(msgSessionId, undefined) && !includedChildIds.has(msgSessionId)) continue
          const msg = projectMessageRow(row as ZcodeMessageRow, partAvailable, conn)
          if (msg !== null) sink.onMessageAppended?.({ providerId: 'zcode', nativeId: msgSessionId }, msg)
        }
        if (rows.length < batchRows) break
      }

      // 3) tool_usage：新行 → 审批追踪（排除集成员跳过——applySessionStatus 会反向建行）
      while (!token.cancelled) {
        const rows = db
          .prepare('SELECT rowid, session_id, approval_status FROM tool_usage WHERE rowid > ? ORDER BY rowid LIMIT ?')
          .all(cursors.toolUsage, batchRows) as unknown as Array<{ rowid: number; session_id: string; approval_status: string | null }>
        if (rows.length === 0) break
        for (const row of rows) {
          cursors.toolUsage = Math.max(cursors.toolUsage, Number(row.rowid))
          const sid = String(row.session_id)
          if (subagentIds.has(sid)) continue
          if (isZcodeSubagentSession(sid, undefined) && !includedChildIds.has(sid)) continue
          if (evalZcodeApprovalStatus(row.approval_status)) {
            let set = pendingApprovals.get(sid)
            if (set === undefined) {
              set = new Set()
              pendingApprovals.set(sid, set)
            }
            if (!set.has(Number(row.rowid))) {
              set.add(Number(row.rowid))
              emitStatus(sid, pendingApprovals, turnStatusCache, taskStatusCache, lastStatus, sink)
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
        emitStatus(sid, pendingApprovals, turnStatusCache, taskStatusCache, lastStatus, sink)
      }

      // 5) task_status 复核（UPDATE 不 bump rowid → 每轮全量小表重读）；排除集
      //    成员（父不可解析的子会话）任务状态不上抛（同上：applySessionStatus 反向建行）
      if (tasks !== null) {
        for (const [taskId, raw] of tasks) {
          if (subagentIds.has(taskId)) continue
          if (isZcodeSubagentSession(taskId, undefined) && !includedChildIds.has(taskId)) continue
          if (taskStatusCache.get(taskId) !== raw) {
            taskStatusCache.set(taskId, raw)
            emitStatus(taskId, pendingApprovals, turnStatusCache, taskStatusCache, lastStatus, sink)
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

  /**
   * 会话状态评估 + 变化沿上抛：审批等待 > turn 终态（Z2，仅子会话域入缓存）
   * > task_status 映射 > 无证据。
   */
  function emitStatus(
    sessionId: string,
    pendingApprovals: Map<string, Set<number>>,
    turnStatusCache: Map<string, { startedAt: number; status: string }>,
    taskStatusCache: Map<string, string>,
    lastStatus: Map<string, SessionStatus | null>,
    sink: EventSink,
  ): void {
    let next: SessionStatus | null
    if ((pendingApprovals.get(sessionId)?.size ?? 0) > 0) {
      next = 'approval_required'
    } else {
      // Z2：子会话 turn 终态证据优先于 task_status——turn 粒度是该会话自己的第一手
      // 终态事实，且 tasks-index 对子会话域近乎零覆盖（实测 3/344，与 turn_usage
      // 覆盖互斥）。主会话从不在 turnStatusCache（缓存写入仅限 includedChildIds），
      // 既有 task_status 语义零变化。
      const turn = turnStatusCache.get(sessionId)
      if (turn !== undefined) {
        next = evalZcodeTurnStatus(turn.status)
      } else {
        const raw = taskStatusCache.get(sessionId)
        next = raw !== undefined ? evalZcodeTaskStatus(raw) : null
      }
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
    // T2：收尾全部活跃托管连接（docs/12 §10 树杀收尾；单连接失败不阻断其余）
    const handles = [...managedSessions.values()]
    managedSessions.clear()
    for (const handle of handles) {
      handle.finalized = true
      try {
        await teardownManagedConnection(handle, false)
      } catch {
        /* 单连接收尾失败不阻断（killTree 幂等兜底在 exec 内部） */
      }
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
        ...(lastManagedProbe !== null ? { appServer: lastManagedProbe.ok } : {}),
        note:
          lastManagedProbe === null
            ? 'zcode managed face (T2): no capability probe attempted yet (unconfigured = observed by default)'
            : lastManagedProbe.evidence,
      },
    }
  }

  return {
    id: 'zcode',
    probeHealth,
    listSessions,
    readMessages,
    getCapabilities,
    sendReply,
    pause,
    resume: async () => unsupported(),
    startMonitor,
    dispose,
    describeDiagnostics,
    // T2（docs/briefs/t2-zcode-managed.md）：远程/桌面「启动托管会话」共用
    // session/create + subscribe + send 托管路径（spawnManaged 双上限子进程；
    // 快照以 mode:'managed' 经 sink 落库；事件流消费至 turn 终止沿后 close）。
    startManagedSession,
  }
}
