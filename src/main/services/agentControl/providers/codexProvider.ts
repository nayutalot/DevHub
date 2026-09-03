/**
 * codexProvider.ts — Codex 接入适配器（docs/12 §8.1）。
 *
 * 数据源（AC0 实测事实 + 本批真机只读复核）：
 * - exe：`%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`（多个 hash 目录，
 *   仅部分含 codex.exe → 扫描取 mtime 最新；不在 PATH）；
 * - `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`：行结构
 *   {timestamp, ordinal, type: session_meta|event_msg|response_item|turn_context, payload}；
 *   session_meta.payload 携带 session_id/cwd/cli_version（native_id 权威来源）；
 * - `~/.codex/session_index.jsonl`：{id, thread_name, updated_at}（无 cwd）；
 * - app-server（experimental）：stdio JSON-RPC。真机 0.152.1/0.153.0-alpha.5 实测：
 *   initialize{clientInfo} → {userAgent, codexHome, platformOs}；
 *   thread/list → {data[], nextCursor}；未知方法 → -32600 错误消息枚举全部
 *   受支持方法（turn/steer、turn/interrupt、thread/resume、turn/start、thread/start
 *   均在列；AC8 实测 0.153.0-alpha.5 全集 158 方法）。
 * - 托管会话最小路径（AC8，docs/16 §1 AC8 行）：thread/start 新建 thread（真机实测
 *   立即返回 thread{id,cwd,path,...}，turn/start 20ms 即回、turn 异步进行）→ 快照以
 *   mode:'managed' 经 sink 落库 → 真实 turn 由 Codex 自己写 rollout → 监控管线照常
 *   消费 event_msg/response_item 推进状态机。触发面 = 数据目录 trigger 文件
 *   （getDataDir()/tmp/agent-control/managed-turn.json，IPC 白名单冻结 68 条下的
 *   最小接缝；task 文本为唯一内容，零凭据）。真实推理经用户 Codex 账号发生。
 * - 控制通道为**持久连接**（docs/12 §2「长驻受控」语义）：sendReply/pause/resume/
 *   startManagedTurn 复用同一 app-server 子进程（空闲/生命周期双上限兜底，退出后
 *   下条命令惰性重生 + thread/resume 重挂历史）；否则 turn/start 后立即 killTree 会
 *   掐死进行中的 turn（AC8 实测 turn/start 响应 20ms、真实推理数秒后完成）。
 *
 * 状态判定（docs/12 §5 判定表，绝不猜测）：
 * - running ← event_msg payload.type === 'task_started'（任务在途，语义可验证）；
 * - approval_required ← rollout 审批片段。实机复核：全部 rollout 语料中不存在任何
 *   审批请求片段（grep approval 仅命中 approval_policy 配置字段）→ 判定源缺失，
 *   APPROVAL_FRAGMENT_TYPES 置空，observed 通道绝不产生 approval_required（绝不猜）；
 * - task_complete / turn_aborted 仅证明一轮结束（非会话终态，docs/12 §5 completed
 *   是终态）→ 判定不定 → unknown；
 * - 禁用窗口标题/进程存活判态。
 *
 * 红线：`~/.codex/**` 只读（app-server 探测子进程本身除外）；协议字段未知一律
 * 容忍丢弃 + 计数；探测进程用后 killTree 收尾，绝不留活进程。
 *
 * electron-free；一切系统命令经 core/exec.run()/spawnManaged()（约束 #7/#8）。
 */

import { randomUUID } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
import { open, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentCapabilitySet, SessionStatus } from '../../../../shared/types.ts'
import { run, spawnManaged, type ManagedProcess } from '../../../core/exec.ts'
import { getDataDir } from '../../../core/paths.ts'
import { nowSec } from '../../internal.ts'
import {
  FAST_POLL_MS,
  IncrementalJsonlReader,
  ReadFailureTracker,
  SLOW_POLL_MS,
  cancellableSleep,
  startMonitorTask,
  type MonitorCancelToken,
} from '../monitorRegistry.ts'
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

export interface CodexProviderOptions {
  /** `~/.codex`（默认真实 home；smoke 注入夹具目录）。 */
  codexHome?: string
  /** bin 根（默认 %LOCALAPPDATA%\OpenAI\Codex\bin；smoke 注入夹具）。 */
  codexBinRoot?: string
  /** 显式 exe 路径（跳过发现逻辑）。 */
  exePath?: string
  /** `--version` 超时（约束 #9 显式放宽）。 */
  versionTimeoutMs?: number
  /** app-server 单请求等待超时。 */
  requestTimeoutMs?: number
  /** app-server 探测进程心跳空闲超时（probe 生命周期由此自然封顶）。 */
  managedIdleTimeoutMs?: number
  /** app-server 探测进程总生命周期上限。 */
  managedLifetimeTimeoutMs?: number
  /** app-server 启动参数（默认 ['app-server']；smoke 注入夹具脚本）。 */
  appServerArgs?: string[]
  /** app-server 探测进程环境变量（默认继承；smoke 注入夹具模式开关）。 */
  appServerEnv?: NodeJS.ProcessEnv
  /** rollout 扫描结果缓存毫秒。 */
  scanCacheMs?: number
  /** 会话快照扫描的文件数上限（防御超大语料）。 */
  scanFileLimit?: number
  /** 消息投影单条字符上限（完整内容在源文件，source_ref 指回）。 */
  messageTextCap?: number
  /**
   * AC8 托管会话触发文件（IPC 白名单冻结下的最小接缝）：存在即消费（读后即删），
   * 内容 {task: string, requestId?: string}——task 为唯一字段，零凭据。
   */
  managedTriggerPath?: string
}

const DEFAULT_VERSION_TIMEOUT_MS = 30_000
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const DEFAULT_MANAGED_IDLE_MS = 15_000
const DEFAULT_MANAGED_LIFETIME_MS = 120_000
const DEFAULT_SCAN_CACHE_MS = 3_000
const DEFAULT_SCAN_FILE_LIMIT = 400
const DEFAULT_MESSAGE_TEXT_CAP = 4_000
/** exe 发现缓存（bin\<hash> 目录随更新变化，mtime 判新后失效）。 */
const EXE_DISCOVERY_CACHE_MS = 300_000
/** session_meta 首行读取上限（首行含 base_instructions 大文本，截断读）。 */
const FIRST_LINE_READ_CAP = 512 * 1024
/** AC8 托管任务文本上限（与 reply 文本上限同源，docs/14 §A.1 #6）。 */
export const MANAGED_TASK_MAX_CHARS = 4_000

/**
 * rollout 审批片段类型全集——实机复核（0.152.1，全部语料）不存在任何审批请求
 * 片段 → 判定源缺失置空：observed 通道绝不产生 approval_required（docs/12 §5
 * 「找不到判定源就不产生该状态，绝不猜」）。若未来版本实测到片段形态，在此登记。
 */
export const CODEX_APPROVAL_FRAGMENT_TYPES: readonly string[] = []
/** 等待文本输入片段全集——同理置空（rollout 无提问/输入请求片段形态）。 */
export const CODEX_WAITING_FRAGMENT_TYPES: readonly string[] = []

/** event_msg → 状态判定（docs/12 §5；返回 null = 无状态证据）。 */
export function evalCodexEventPayload(payload: unknown): SessionStatus | null {
  if (payload === null || typeof payload !== 'object') return null
  const type = (payload as { type?: unknown }).type
  if (typeof type !== 'string') return null
  if (CODEX_APPROVAL_FRAGMENT_TYPES.includes(type)) return 'approval_required'
  if (CODEX_WAITING_FRAGMENT_TYPES.includes(type)) return 'waiting_input'
  if (type === 'task_started') return 'running'
  if (type === 'task_complete' || type === 'turn_aborted') return 'unknown'
  return null
}

interface RolloutFileInfo {
  file: string
  mtimeMs: number
  sessionId: string | null
  cwd: string | null
  startedAtSec: number | null
}

interface TrackedFile {
  sessionId: string
  reader: IncrementalJsonlReader
  lastStatus: SessionStatus | undefined
  parseFailures: number
}

interface JsonRpcError {
  code: number
  message: string
}

interface PendingRequest {
  resolve: (response: { id: number; result?: unknown; error?: JsonRpcError } | null) => void
  timer: NodeJS.Timeout
}

export function createCodexProvider(options: CodexProviderOptions = {}): AgentProvider {
  const codexHome = options.codexHome ?? join(homedir(), '.codex')
  const codexBinRoot =
    options.codexBinRoot ?? join(process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin')
  const versionTimeoutMs = options.versionTimeoutMs ?? DEFAULT_VERSION_TIMEOUT_MS
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const managedIdleTimeoutMs = options.managedIdleTimeoutMs ?? DEFAULT_MANAGED_IDLE_MS
  const managedLifetimeTimeoutMs = options.managedLifetimeTimeoutMs ?? DEFAULT_MANAGED_LIFETIME_MS
  const appServerArgs = options.appServerArgs ?? ['app-server']
  const scanCacheMs = options.scanCacheMs ?? DEFAULT_SCAN_CACHE_MS
  const scanFileLimit = options.scanFileLimit ?? DEFAULT_SCAN_FILE_LIMIT
  const messageTextCap = options.messageTextCap ?? DEFAULT_MESSAGE_TEXT_CAP
  // AC8 托管触发文件（默认数据目录 tmp；smoke 注入夹具路径隔离）
  const managedTriggerPath =
    options.managedTriggerPath ?? join(getDataDir(), 'tmp', 'agent-control', 'managed-turn.json')

  // exe 发现缓存（bin\* 最新 hash 目录，docs/12 §8.1）
  let exeCache: { path: string | null; probedAt: number } | null = null
  // 协议容忍计数（未知行/解析失败行，docs/12 §8.1 schema 防御）
  const protocolStats = { unknownLines: 0, parseFailures: 0 }
  let lastHandshake: { ok: boolean; at: number; evidence: string } | null = null
  /**
   * AC8 托管线程登记（nativeId → DevHub 已发起的 turn 数）：监控管线据此把
   * task_complete 判为 waiting_input、turn_aborted 判为 paused——这些是「DevHub
   * 亲自发起的会话」才成立的判定（docs/12 §5：找不到判定源不产生该状态；此处
   * 判定源 = DevHub 自己的 turn/start，非猜测）。仅内存态：进程重启后回退
   * observed 判定（未知），DB 行 session_mode 由 L3 护栏保持 managed。
   */
  const managedTurns = new Map<string, number>()

  async function discoverExe(): Promise<string | null> {
    if (options.exePath !== undefined) return options.exePath
    if (exeCache !== null && Date.now() - exeCache.probedAt < EXE_DISCOVERY_CACHE_MS) return exeCache.path
    let newest: { path: string; mtimeMs: number } | null = null
    try {
      for (const entry of await readdir(codexBinRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const candidate = join(codexBinRoot, entry.name, 'codex.exe')
        try {
          const st = await stat(candidate)
          if (!st.isFile()) continue
          if (newest === null || st.mtimeMs > newest.mtimeMs) newest = { path: candidate, mtimeMs: st.mtimeMs }
        } catch {
          continue // 候选不存在/不可 stat → 跳过
        }
      }
    } catch {
      newest = null // bin 根不可读 → 未安装形态
    }
    exeCache = { path: newest?.path ?? null, probedAt: Date.now() }
    return exeCache.path
  }

  // ---------------------------------------------------------------------------
  // 九方法 1-2：probeHealth / listSessions
  // ---------------------------------------------------------------------------

  async function probeHealth(): Promise<ProviderHealth> {
    const exe = await discoverExe()
    if (exe === null) {
      return {
        installed: false,
        health: 'unavailable',
        healthDetail: `codex.exe not found under ${codexBinRoot} (hash-dir discovery empty)`,
      }
    }
    const r = await run(exe, ['--version'], { timeoutMs: versionTimeoutMs })
    if (r.code === 0 && !r.timedOut) {
      const version = /codex-cli\s+(\S+)/.exec(r.stdout)?.[1] ?? r.stdout.trim().split(/\s+/)[0] ?? undefined
      return { installed: true, ...(version !== undefined ? { version } : {}), exePath: exe, health: 'ok' }
    }
    return {
      installed: true,
      exePath: exe,
      health: 'degraded',
      healthDetail: `--version failed: ${(r.stderr || r.stdout || `exit ${r.code}`).slice(0, 200)}`,
    }
  }

  /** 解析 session_index.jsonl（逐行 try-parse；失败行计数不中断）。 */
  async function readSessionIndex(): Promise<Map<string, { title: string; updatedAtSec: number | null }>> {
    const map = new Map<string, { title: string; updatedAtSec: number | null }>()
    let raw: string
    try {
      raw = await readFile(join(codexHome, 'session_index.jsonl'), 'utf8')
    } catch {
      return map // 无索引文件：纯 rollout 扫描兜底
    }
    for (const line of raw.split('\n')) {
      const text = line.trim()
      if (text.length === 0) continue
      try {
        const obj = JSON.parse(text) as { id?: unknown; thread_name?: unknown; updated_at?: unknown }
        if (typeof obj.id !== 'string') continue
        const ts = typeof obj.updated_at === 'string' ? Date.parse(obj.updated_at) : Number.NaN
        map.set(obj.id, {
          title: typeof obj.thread_name === 'string' ? obj.thread_name : '',
          updatedAtSec: Number.isFinite(ts) ? Math.floor(ts / 1000) : null,
        })
      } catch {
        protocolStats.parseFailures += 1
      }
    }
    return map
  }

  /**
   * 扫描 sessions/YYYY/MM/DD/rollout-*.jsonl；每个文件读首行 session_meta
   * （native_id 权威来源 = payload.session_id；fork 文件取 mtime 新者）。
   */
  async function scanRolloutFiles(): Promise<RolloutFileInfo[]> {
    const files: string[] = []
    const pushIfRollout = async (dir: string, name: string): Promise<void> => {
      if (name.startsWith('rollout-') && name.endsWith('.jsonl')) files.push(join(dir, name))
    }
    try {
      const years = await readdir(sessionsRoot(), { withFileTypes: true })
      for (const year of years) {
        if (!year.isDirectory()) continue
        const months = await readdir(join(sessionsRoot(), year.name), { withFileTypes: true }).catch(() => [])
        for (const month of months) {
          if (!month.isDirectory()) continue
          const days = await readdir(join(sessionsRoot(), year.name, month.name), { withFileTypes: true }).catch(() => [])
          for (const day of days) {
            if (!day.isDirectory()) continue
            const dayDir = join(sessionsRoot(), year.name, month.name, day.name)
            const entries = await readdir(dayDir, { withFileTypes: true }).catch(() => [])
            for (const e of entries) if (e.isFile()) await pushIfRollout(dayDir, e.name)
          }
        }
      }
    } catch {
      return [] // sessions 目录不可读：observed 降级（unavailable 由调用方判定）
    }
    if (files.length > scanFileLimit) {
      // 语料超限：按文件名时间倒序取最新（rollout 文件名含时间戳，字典序=时间序）
      files.sort((a, b) => (a < b ? 1 : -1))
      files.length = scanFileLimit
    }
    const infos: RolloutFileInfo[] = []
    for (const file of files) {
      const meta = await readRolloutMeta(file)
      let mtimeMs = 0
      try {
        mtimeMs = (await stat(file)).mtimeMs
      } catch {
        continue
      }
      infos.push({
        file,
        mtimeMs,
        sessionId: meta?.sessionId ?? null,
        cwd: meta?.cwd ?? null,
        startedAtSec: meta?.startedAtSec ?? null,
      })
    }
    return infos
  }

  function sessionsRoot(): string {
    return join(codexHome, 'sessions')
  }

  async function readRolloutMeta(file: string): Promise<{ sessionId: string; cwd: string | null; startedAtSec: number | null } | null> {
    let handle
    try {
      handle = await open(file, 'r')
    } catch {
      return null
    }
    try {
      const buf = Buffer.alloc(FIRST_LINE_READ_CAP)
      const { bytesRead } = await handle.read(buf, 0, FIRST_LINE_READ_CAP, 0)
      const text = buf.subarray(0, bytesRead).toString('utf8')
      const firstLine = text.slice(0, text.indexOf('\n') >= 0 ? text.indexOf('\n') : text.length).trim()
      if (firstLine.length === 0) return null
      const obj = JSON.parse(firstLine) as { type?: unknown; payload?: { session_id?: unknown; cwd?: unknown; timestamp?: unknown } }
      if (obj.type !== 'session_meta' || obj.payload === null || typeof obj.payload !== 'object') return null
      const sessionId = obj.payload.session_id
      if (typeof sessionId !== 'string' || sessionId.length === 0) return null
      const ts = typeof obj.payload.timestamp === 'string' ? Date.parse(obj.payload.timestamp) : Number.NaN
      return {
        sessionId,
        cwd: typeof obj.payload.cwd === 'string' ? obj.payload.cwd : null,
        startedAtSec: Number.isFinite(ts) ? Math.floor(ts / 1000) : null,
      }
    } catch {
      return null // 首行损坏 → 该文件以路径哈希兜底（不猜 session_id）
    } finally {
      await handle.close().catch(() => {})
    }
  }

  // 缓存的扫描结果（listSessions 与监控发现共用）
  let scanCache: { at: number; infos: RolloutFileInfo[] } | null = null
  async function cachedScan(): Promise<RolloutFileInfo[]> {
    if (scanCache !== null && Date.now() - scanCache.at < scanCacheMs) return scanCache.infos
    const infos = await scanRolloutFiles()
    scanCache = { at: Date.now(), infos }
    return infos
  }

  async function listSessions(): Promise<SessionSnapshot[]> {
    const [index, infos] = await Promise.all([readSessionIndex(), cachedScan()])
    const byId = new Map<string, SessionSnapshot>()
    for (const info of infos) {
      const nativeId = info.sessionId ?? `rollout-${pathHash(info.file)}`
      const existing = byId.get(nativeId)
      if (existing !== undefined) continue // 同 native_id 多文件（fork）：保持最新（infos 按 mtime 无序 → 下面统一重排）
      const indexed = index.get(nativeId)
      byId.set(nativeId, {
        nativeId,
        ...(info.cwd !== null ? { workdir: info.cwd } : {}),
        ...(indexed !== undefined && indexed.title.length > 0 ? { title: indexed.title } : {}),
        ...(info.startedAtSec !== null ? { startedAt: info.startedAtSec } : {}),
        lastActivityAt: Math.floor(info.mtimeMs / 1000),
        // AC8：DevHub 发起的托管线程（含重启后仍存活的内存登记）显式携带 managed
        ...(managedTurns.has(nativeId) ? { mode: 'managed' as const } : {}),
      })
    }
    // fork 文件同 native_id：mtime 新者覆盖（scanRolloutFiles 顺序不定 → 显式重排）
    for (const info of infos) {
      const nativeId = info.sessionId ?? `rollout-${pathHash(info.file)}`
      const snap = byId.get(nativeId)
      if (snap === undefined) continue
      const activity = Math.floor(info.mtimeMs / 1000)
      if (snap.lastActivityAt !== undefined && activity > snap.lastActivityAt) snap.lastActivityAt = activity
    }
    return [...byId.values()]
  }

  function pathHash(p: string): string {
    // 路径哈希兜底 native_id（首行损坏的 rollout 文件；稳定、可重放）
    let h = 0
    for (let i = 0; i < p.length; i++) h = (Math.imul(31, h) + p.charCodeAt(i)) | 0
    return (h >>> 0).toString(16).padStart(8, '0')
  }

  // ---------------------------------------------------------------------------
  // 九方法 3：readMessages（rollout jsonl 增量 → MessagePage）
  // ---------------------------------------------------------------------------

  async function resolveRolloutFile(nativeId: string): Promise<string | null> {
    const infos = await cachedScan()
    let newest: RolloutFileInfo | null = null
    for (const info of infos) {
      if (info.sessionId !== nativeId) continue
      if (newest === null || info.mtimeMs > newest.mtimeMs) newest = info
    }
    return newest?.file ?? null
  }

  function projectMessage(obj: Record<string, unknown>, file: string, byteOffset: number): RedactedMessage | null {
    if (obj.type !== 'response_item') return null
    const payload = obj.payload
    if (payload === null || typeof payload !== 'object') return null
    const p = payload as { type?: unknown; role?: unknown; id?: unknown; content?: unknown }
    if (p.type !== 'message') return null
    const roleRaw = typeof p.role === 'string' ? p.role : 'system'
    const role = roleRaw === 'developer' ? 'system' : roleRaw
    let text = ''
    if (Array.isArray(p.content)) {
      const parts: string[] = []
      for (const item of p.content) {
        if (item !== null && typeof item === 'object') {
          const c = item as { type?: unknown; text?: unknown }
          if ((c.type === 'input_text' || c.type === 'output_text') && typeof c.text === 'string') parts.push(c.text)
        }
      }
      text = parts.join('\n')
    } else if (typeof p.content === 'string') {
      text = p.content
    }
    const nativeMsgId = typeof p.id === 'string' && p.id.length > 0 ? p.id : `line:${byteOffset}`
    const ts = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : Number.NaN
    return {
      role,
      contentRedacted: redactText(text).slice(0, messageTextCap),
      nativeMsgId,
      ...(Number.isFinite(ts) ? { occurredAt: Math.floor(ts / 1000) } : {}),
      sourceRef: `${file}#offset=${byteOffset}`,
    }
  }

  async function readMessages(ref: SessionRef, after?: string): Promise<MessagePage> {
    const file = await resolveRolloutFile(ref.nativeId)
    if (file === null) return { messages: [], cursor: after ?? '0', hasMore: false }
    const startOffset = after !== undefined ? Number.parseInt(after, 10) : 0
    const reader = new IncrementalJsonlReader(file, Number.isSafeInteger(startOffset) && startOffset > 0 ? startOffset : 0)
    const result = await reader.read()
    if (!result.readable) return { messages: [], cursor: after ?? '0', hasMore: false }
    const messages: RedactedMessage[] = []
    for (let i = 0; i < result.lines.length; i++) {
      const parsed = result.parsed[i]
      if (parsed === null || typeof parsed !== 'object') continue
      const msg = projectMessage(parsed as Record<string, unknown>, file, result.lines[i].byteOffset)
      if (msg !== null) messages.push(msg)
    }
    return { messages, cursor: String(reader.currentOffset), hasMore: false }
  }

  // ---------------------------------------------------------------------------
  // app-server 通道（JSON-RPC over stdio，spawnManaged 托管）。
  // AC8 拆双形态：withAppServer = 一次性探测（用后 killTree，能力握手用）；
  // 持久连接 = 控制命令/托管会话共用（docs/12 §2「长驻受控」；turn/start 响应
  // ~20ms 而真实推理数秒——即杀即断 turn，故命令面绝不即杀，退出后惰性重生）。
  // ---------------------------------------------------------------------------

  interface RpcSession {
    rawRequest(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<{ result?: unknown; error?: JsonRpcError } | null>
    request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>
  }

  /** spawn + stdio 行解析 + RPC 客户端构造（初始化握手由调用方决定时机）。 */
  function spawnRpcConnection(): { proc: ManagedProcess; rpc: RpcSession } {
    const pending = new Map<number, PendingRequest>()
    let nextId = 1
    const proc = spawnManaged(exePathSync(), appServerArgs, {
      idleTimeoutMs: managedIdleTimeoutMs,
      lifetimeTimeoutMs: managedLifetimeTimeoutMs,
      stdinWritable: true,
      ...(options.appServerEnv !== undefined ? { env: options.appServerEnv } : {}),
      onStdout: (line) => {
        const text = line.trim()
        if (text.length === 0) return
        let msg: unknown
        try {
          msg = JSON.parse(text)
        } catch {
          protocolStats.unknownLines += 1 // 容忍丢弃 + 计数（docs/12 §8.1）
          return
        }
        if (msg === null || typeof msg !== 'object') {
          protocolStats.unknownLines += 1
          return
        }
        const id = (msg as { id?: unknown }).id
        if (typeof id !== 'number' || !pending.has(id)) {
          protocolStats.unknownLines += 1 // 通知/未知 id 帧：容忍丢弃 + 计数
          return
        }
        const entry = pending.get(id)
        if (entry !== undefined) {
          pending.delete(id)
          clearTimeout(entry.timer)
          entry.resolve(msg as { id: number; result?: unknown; error?: JsonRpcError })
        }
      },
    })
    const rpc: RpcSession = {
      rawRequest(method, params, timeoutMs = requestTimeoutMs) {
        const id = nextId++
        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            pending.delete(id)
            resolve(null) // 超时 → 结构化 null（调用方按失败处理）
          }, timeoutMs)
          pending.set(id, { resolve, timer })
          const written = proc.writeStdin(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
          if (!written.ok) {
            clearTimeout(timer)
            pending.delete(id)
            resolve(null)
          }
        })
      },
      async request(method, params, timeoutMs) {
        const resp = await rpc.rawRequest(method, params, timeoutMs)
        if (resp === null) throw new Error(`app-server request timeout or write failure: ${method}`)
        if (resp.error !== undefined) throw new Error(`app-server error ${resp.error.code}: ${resp.error.message}`)
        return resp.result
      },
    }
    return { proc, rpc }
  }

  /** exe 路径同步取值（discoverExe 缓存命中时同步可用；未缓存 → 抛错引导先 await）。 */
  function exePathSync(): string {
    if (options.exePath !== undefined) return options.exePath
    if (exeCache !== null && exeCache.path !== null) return exeCache.path
    throw new Error(`codex.exe not resolved yet under ${codexBinRoot}`)
  }

  /** spawn + initialize 握手一体（失败即杀，绝不留半死连接）。 */
  async function openHandshakenConnection(): Promise<{ proc: ManagedProcess; rpc: RpcSession }> {
    const exe = await discoverExe()
    if (exe === null) throw new Error(`codex.exe not found under ${codexBinRoot}`)
    const { proc, rpc } = spawnRpcConnection()
    try {
      if (proc.pid <= 0) throw new Error('app-server spawn failed (synchronous spawn error)')
      await rpc.request('initialize', { clientInfo: { name: 'devhub', title: 'DevHub', version: '0.1.0' } })
    } catch (err) {
      try {
        await proc.killTree()
      } catch {
        /* 已退出等幂等场景 */
      }
      await proc.exited.catch(() => {})
      throw err
    }
    return { proc, rpc }
  }

  async function withAppServer<T>(fn: (rpc: RpcSession) => Promise<T>): Promise<T> {
    const { proc, rpc } = await openHandshakenConnection()
    try {
      return await fn(rpc)
    } finally {
      // 用后 killTree 收尾，绝不留活进程（docs/12 §8.1 / 批次铁律）
      try {
        await proc.killTree()
      } catch {
        /* 已退出等幂等场景 */
      }
      await proc.exited.catch(() => {})
    }
  }

  // --- 持久连接（AC8：控制命令/托管会话共用；退出自清 + 惰性重生） ------------

  let persistent: { proc: ManagedProcess; rpc: RpcSession } | null = null
  let persistentOpening: Promise<RpcSession> | null = null

  async function acquirePersistentAppServer(): Promise<RpcSession> {
    if (persistent !== null) return persistent.rpc
    if (persistentOpening !== null) return persistentOpening
    persistentOpening = (async () => {
      const conn = await openHandshakenConnection()
      persistent = conn
      // 进程退出（idle/lifetime 上限或崩溃）→ 自清；下条命令惰性重生 + thread/resume 重挂
      void conn.proc.exited.catch(() => {}).then(() => {
        if (persistent !== null && persistent.proc === conn.proc) persistent = null
      })
      return conn.rpc
    })()
    try {
      return await persistentOpening
    } finally {
      persistentOpening = null
    }
  }

  /** 从 -32600 错误消息提取受支持方法全集（真机 0.152.1 实测形态：`a`, `b`, …）。 */
  function parseMethodListFromError(message: string): string[] {
    const m = /expected one of (.+)$/s.exec(message)
    if (m === null) return []
    return [...m[1].matchAll(/`([^`]+)`/g)].map((x) => x[1])
  }

  // ---------------------------------------------------------------------------
  // 九方法 4：getCapabilities（app-server 托管握手，能力逐个验证）
  // ---------------------------------------------------------------------------

  async function getCapabilities(_ref: SessionRef): Promise<AgentCapabilitySet> {
    try {
      const verdict = await withAppServer(async (rpc) => {
        // initialize 握手已由 openHandshakenConnection 完成（withAppServer 唯一入口）；
        // 此处不再重复 initialize——真机 0.153.0-alpha.5 对二次 initialize 回
        // -32600 "Already initialized"（AC8 e2e 实测），会使能力验证整体失败。
        // 线程列举类方法尽力探测（协议字段未知容忍丢弃；失败不阻断能力判定）
        await rpc.rawRequest('thread/list', { cursor: null, sortKey: 'updated_at', sortDirection: 'desc', limit: 1 })
        // 方法存在性验证：未知方法探测 → -32600 消息枚举全部受支持方法
        const probeResp = await rpc.rawRequest(`devhub/__capability_probe_${randomUUID().slice(0, 8)}`, {})
        const methodList = probeResp?.error !== undefined ? parseMethodListFromError(probeResp.error.message) : []
        const granted: Array<'reply' | 'pause' | 'resume'> = []
        if (methodList.includes('turn/start') || methodList.includes('turn/steer')) granted.push('reply')
        if (methodList.includes('turn/interrupt')) granted.push('pause')
        if (methodList.includes('thread/resume')) granted.push('resume')
        return { ok: true as const, granted, methodCount: methodList.length }
      })
      lastHandshake = { ok: true, at: nowSec(), evidence: 'app-server handshake ok' }
      return {
        mode: 'managed',
        granted: verdict.granted,
        verifiedAt: nowSec(),
        evidence: `app-server handshake ok (${verdict.methodCount} protocol methods observed)`,
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      lastHandshake = { ok: false, at: nowSec(), evidence: `app-server handshake failed: ${reason}` }
      return {
        mode: 'observed',
        granted: [],
        verifiedAt: nowSec(),
        evidence: `app-server handshake failed: ${reason.slice(0, 200)}`,
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 九方法 5-7：sendReply / pause / resume（仅 app-server 通道真实执行）
  // ---------------------------------------------------------------------------

  /** 深度提取活跃 turn id（容忍协议形态；找不到 → null → 结构化失败）。 */
  function extractActiveTurnId(value: unknown, depth = 0): string | null {
    if (depth > 8 || value === null || typeof value !== 'object') return null
    if (Array.isArray(value)) {
      for (const item of value) {
        const hit = extractActiveTurnId(item, depth + 1)
        if (hit !== null) return hit
      }
      return null
    }
    const obj = value as Record<string, unknown>
    const status = obj['status']
    let active = false
    if (typeof status === 'string') active = status === 'running' || status === 'active' || status === 'in_progress'
    else if (status !== null && typeof status === 'object') {
      const t = (status as { type?: unknown }).type
      active = t === 'running' || t === 'active' || t === 'in_progress'
    }
    if (active && typeof obj['id'] === 'string' && obj['id'].length > 0) return obj['id']
    for (const v of Object.values(obj)) {
      const hit = extractActiveTurnId(v, depth + 1)
      if (hit !== null) return hit
    }
    return null
  }

  /**
   * 控制命令执行（AC8 起走持久连接——turn/start 后进程必须存活到真实推理完成，
   * 状态推进由监控管线消费 rollout 完成；连接退出由惰性重生兜底）。
   * 成功的 reply/pause/resume 同时登记 managedTurns：此后该线程的 task_complete →
   * waiting_input、turn_aborted → paused（判定源 = DevHub 自己的 turn/start/interrupt）。
   */
  async function executeCommand(ref: SessionRef, action: 'reply' | 'pause' | 'resume', text?: string): Promise<CommandOutcome> {
    let rpc: RpcSession
    try {
      rpc = await acquirePersistentAppServer()
    } catch (err) {
      return { ok: false, status: 'failed', errorCode: 'AGENT_PROVIDER_UNAVAILABLE', detail: err instanceof Error ? err.message : String(err) }
    }
    try {
      const resumeResp = await rpc.rawRequest('thread/resume', { threadId: ref.nativeId })
      if (resumeResp?.error !== undefined) {
        return {
          ok: false,
          status: 'failed',
          errorCode: 'COMMAND_NOT_EXECUTABLE',
          detail: `thread/resume failed: ${resumeResp.error.message.slice(0, 200)}`,
        }
      }
      if (resumeResp === null) {
        return { ok: false, status: 'failed', errorCode: 'COMMAND_NOT_EXECUTABLE', detail: 'thread/resume timed out' }
      }
      if (action === 'resume') {
        // AC8 附加验证语义（docs/16 §1 AC8 步骤 5「resume 发新 turn」）：
        // thread/resume 重挂历史 + turn/start 发起恢复 turn（真实推理）。
        const startResp = await rpc.rawRequest('turn/start', {
          threadId: ref.nativeId,
          input: [{ type: 'text', text: 'Resume: reply with exactly: RESUMED. Then stop.' }],
        })
        if (startResp?.error !== undefined) {
          return {
            ok: false,
            status: 'failed',
            errorCode: 'COMMAND_NOT_EXECUTABLE',
            detail: `resume turn/start failed: ${startResp.error.message.slice(0, 200)}`,
          }
        }
        if (startResp === null) {
          return { ok: false, status: 'failed', errorCode: 'COMMAND_NOT_EXECUTABLE', detail: 'resume turn/start timed out' }
        }
        managedTurns.set(ref.nativeId, (managedTurns.get(ref.nativeId) ?? 0) + 1)
        return { ok: true, status: 'executed', detail: 'thread/resume + turn/start ok (resume turn initiated)' }
      }
      if (action === 'reply') {
        const startResp = await rpc.rawRequest('turn/start', {
          threadId: ref.nativeId,
          input: [{ type: 'text', text: text ?? '' }],
        })
        if (startResp?.error !== undefined) {
          return {
            ok: false,
            status: 'failed',
            errorCode: 'COMMAND_NOT_EXECUTABLE',
            detail: `turn/start failed: ${startResp.error.message.slice(0, 200)}`,
          }
        }
        if (startResp === null) {
          return { ok: false, status: 'failed', errorCode: 'COMMAND_NOT_EXECUTABLE', detail: 'turn/start timed out' }
        }
        managedTurns.set(ref.nativeId, (managedTurns.get(ref.nativeId) ?? 0) + 1)
        return { ok: true, status: 'executed', detail: 'turn/start ok' }
      }
      // pause：需要活跃 turnId；thread/resume 响应中容忍提取，找不到结构化失败
      const turnId = extractActiveTurnId(resumeResp.result)
      if (turnId === null) {
        return {
          ok: false,
          status: 'failed',
          errorCode: 'COMMAND_NOT_EXECUTABLE',
          detail: 'no active turn id to interrupt (thread is not running a turn)',
        }
      }
      const interruptResp = await rpc.rawRequest('turn/interrupt', { threadId: ref.nativeId, turnId })
      if (interruptResp?.error !== undefined) {
        return {
          ok: false,
          status: 'failed',
          errorCode: 'COMMAND_NOT_EXECUTABLE',
          detail: `turn/interrupt failed: ${interruptResp.error.message.slice(0, 200)}`,
        }
      }
      if (interruptResp === null) {
        return { ok: false, status: 'failed', errorCode: 'COMMAND_NOT_EXECUTABLE', detail: 'turn/interrupt timed out' }
      }
      managedTurns.set(ref.nativeId, Math.max(managedTurns.get(ref.nativeId) ?? 0, 1))
      return { ok: true, status: 'executed', detail: `turn/interrupt ok (${turnId.slice(0, 8)}…)` }
    } catch (err) {
      // 传输层异常（超时/写失败）→ provider 通道不可用（与 AC3 外层折叠语义一致）
      return { ok: false, status: 'failed', errorCode: 'AGENT_PROVIDER_UNAVAILABLE', detail: err instanceof Error ? err.message : String(err) }
    }
  }

  // ---------------------------------------------------------------------------
  // AC8 — 托管会话最小路径（docs/16 §1 AC8 行）：thread/start 新建托管线程 →
  // managed 快照经 sink 落库 → turn/start 极小真实任务 → 状态推进交给监控管线。
  // ---------------------------------------------------------------------------

  async function startManagedTurn(
    task: string,
    sink: EventSink,
  ): Promise<{ ok: boolean; nativeId?: string; detail?: string }> {
    let rpc: RpcSession
    try {
      rpc = await acquirePersistentAppServer()
    } catch (err) {
      return { ok: false, detail: `app-server unavailable: ${err instanceof Error ? err.message : String(err)}` }
    }
    const startResp = await rpc.rawRequest('thread/start', {})
    if (startResp === null) return { ok: false, detail: 'thread/start timed out' }
    if (startResp.error !== undefined) {
      return { ok: false, detail: `thread/start failed: ${startResp.error.message.slice(0, 200)}` }
    }
    const thread = (startResp.result as { thread?: { id?: unknown; cwd?: unknown } } | undefined)?.thread
    const nativeId = typeof thread?.id === 'string' && thread.id.length > 0 ? thread.id : undefined
    if (nativeId === undefined) {
      return { ok: false, detail: 'thread/start response missing thread.id (protocol shape change tolerated)' }
    }
    managedTurns.set(nativeId, 0)
    // managed 快照即时落库（session.started 事件由 L3 sink 发出）——手机侧会话
    // 列表在 turn 进行中即可见（「running」由监控管线随 task_started 推进）。
    const snapshot: SessionSnapshot = { nativeId, mode: 'managed', lastActivityAt: nowSec() }
    if (typeof thread?.cwd === 'string' && thread.cwd.length > 0) snapshot.workdir = thread.cwd
    sink.onSessionDiscovered?.('codex', snapshot)
    const turnResp = await rpc.rawRequest('turn/start', {
      threadId: nativeId,
      input: [{ type: 'text', text: task }],
    })
    if (turnResp === null) return { ok: false, nativeId, detail: 'turn/start timed out (session kept as managed)' }
    if (turnResp.error !== undefined) {
      return { ok: false, nativeId, detail: `turn/start failed: ${turnResp.error.message.slice(0, 200)}` }
    }
    managedTurns.set(nativeId, 1)
    return { ok: true, nativeId, detail: 'thread/start + turn/start ok (real turn in flight)' }
  }

  /**
   * 托管触发文件消费（每轮监控循环检查；读后即删防重复消费）。
   * 文件协议：{task: string, requestId?: string} → 结果写 <trigger>.result.json
   * （requestId/ok/nativeId/detail）。task 为唯一业务字段，零凭据（docs/15 §6）。
   */
  async function consumeManagedTrigger(sink: EventSink): Promise<void> {
    let raw: string
    try {
      raw = await readFile(managedTriggerPath, 'utf8')
    } catch {
      return // 无触发文件 = 常态
    }
    await unlink(managedTriggerPath).catch(() => {})
    let parsed: { task?: unknown; requestId?: unknown } = {}
    try {
      const obj: unknown = JSON.parse(raw)
      if (obj !== null && typeof obj === 'object' && !Array.isArray(obj)) parsed = obj as typeof parsed
    } catch {
      /* 走下方 task 校验失败路径 */
    }
    const requestId = typeof parsed.requestId === 'string' && parsed.requestId.length > 0 ? parsed.requestId : `req-${Date.now()}`
    const task = typeof parsed.task === 'string' ? parsed.task.trim() : ''
    let outcome: { ok: boolean; nativeId?: string; detail?: string }
    if (task.length === 0 || task.length > MANAGED_TASK_MAX_CHARS) {
      outcome = { ok: false, detail: `task must be a non-empty string of 1..${MANAGED_TASK_MAX_CHARS} chars` }
    } else {
      try {
        outcome = await startManagedTurn(task, sink)
      } catch (err) {
        outcome = { ok: false, detail: err instanceof Error ? err.message : String(err) }
      }
    }
    const resultJson = JSON.stringify({ requestId, ...outcome })
    await writeFile(`${managedTriggerPath}.result.json`, resultJson, 'utf8').catch(() => {})
  }

  // ---------------------------------------------------------------------------
  // 九方法 8：startMonitor（fs.watch 优先 + 2s 轮询回落 + 5 次失败降级）
  // ---------------------------------------------------------------------------

  function startMonitor(sink: EventSink): MonitorHandle {
    let loopDone: Promise<void> | null = null
    const task = startMonitorTask(
      'codex',
      (token) => {
        loopDone = runMonitorLoop(sink, token)
        return loopDone
      },
      'codex rollout monitor',
    )
    return {
      providerId: 'codex',
      async stop(): Promise<void> {
        task.cancel()
        if (loopDone !== null) await loopDone.catch(() => {})
      },
    }
  }

  async function runMonitorLoop(sink: EventSink, token: MonitorCancelToken): Promise<void> {
    const root = sessionsRoot()
    const tracked = new Map<string, TrackedFile>()
    const tracker = new ReadFailureTracker()
    let degraded = false
    let pollMs = FAST_POLL_MS
    let dirty = true
    let watcher: FSWatcher | null = null
    try {
      watcher = watch(root, { recursive: true }, () => {
        dirty = true
      })
      watcher.on('error', () => {
        // watcher 失效 → 关闭并回落 2s stat 轮询（docs/12 §7）
        watcher?.close()
        watcher = null
        dirty = true
      })
    } catch {
      watcher = null // fs.watch 不可用 → 2s stat 轮询回落
    }

    try {
      while (!token.cancelled) {
        if (dirty) {
          dirty = false
          await discoverSessions(sink, tracked)
        }
        // AC8 托管触发文件（读后即删；失败绝不阻断监控循环）
        await consumeManagedTrigger(sink).catch(() => {})
        let failDetail: string | null = null
        for (const t of tracked.values()) {
          if (token.cancelled) break
          const result = await t.reader.read()
          if (!result.readable) {
            failDetail = result.error ?? 'rollout unreadable'
            continue
          }
          t.parseFailures += result.parseFailures
          protocolStats.parseFailures += result.parseFailures
          applyMonitoredLines(t, result.lines, result.parsed, sink)
        }
        if (failDetail !== null) {
          if (tracker.recordFailure()) {
            degraded = true
            pollMs = SLOW_POLL_MS
            sink.onProviderDegraded?.('codex', `rollout reads failing (${failDetail.slice(0, 160)})`)
          }
        } else if (tracker.recordSuccess() && degraded) {
          degraded = false
          pollMs = FAST_POLL_MS
          sink.onProviderRecovered?.('codex')
        }
        await cancellableSleep(pollMs, token)
        if (watcher === null) dirty = true // 纯轮询模式：每轮重扫发现新文件
      }
    } finally {
      try {
        watcher?.close()
      } catch {
        /* 已关闭 */
      }
    }
  }

  async function discoverSessions(sink: EventSink, tracked: Map<string, TrackedFile>): Promise<void> {
    const infos = await cachedScan()
    const seen = new Set<string>()
    for (const info of infos) {
      const nativeId = info.sessionId ?? `rollout-${pathHash(info.file)}`
      seen.add(info.file)
      const existing = tracked.get(info.file)
      if (existing !== undefined) continue
      tracked.set(info.file, {
        sessionId: nativeId,
        reader: new IncrementalJsonlReader(info.file),
        lastStatus: undefined,
        parseFailures: 0,
      })
      const snap: SessionSnapshot = {
        nativeId,
        ...(info.cwd !== null ? { workdir: info.cwd } : {}),
        ...(info.startedAtSec !== null ? { startedAt: info.startedAtSec } : {}),
        lastActivityAt: Math.floor(info.mtimeMs / 1000),
        // AC8：托管线程的 rollout 被扫描发现时，快照显式携带 managed（L3 以此落库）
        ...(managedTurns.has(nativeId) ? { mode: 'managed' as const } : {}),
      }
      sink.onSessionDiscovered?.('codex', snap)
    }
    for (const file of [...tracked.keys()]) {
      if (!seen.has(file)) tracked.delete(file) // 文件消失（归档/清理）→ 停止跟踪
    }
  }

  /** 监控行处理：消息投影（带行首 offset）+ event_msg 状态判定（docs/12 §7 reader 段）。 */
  function applyMonitoredLines(
    t: TrackedFile,
    lines: Array<{ byteOffset: number; text: string }>,
    parsed: unknown[],
    sink: EventSink,
  ): void {
    const ref: SessionRef = { providerId: 'codex', nativeId: t.sessionId }
    // AC8：managed 线程的 turn 终止事件有第一手判定源（DevHub 自己的 turn/start /
    // turn/interrupt）→ task_complete = waiting_input、turn_aborted = paused；
    // observed 线程维持 docs/12 §5 原判定（task_complete/turn_aborted → unknown）。
    const managed = managedTurns.has(t.sessionId)
    for (let i = 0; i < lines.length; i++) {
      const obj = parsed[i]
      if (obj === null || typeof obj !== 'object') continue // parseFailures 已在 reader 计数
      const o = obj as Record<string, unknown>
      const msg = projectMessage(o, '', lines[i].byteOffset)
      if (msg !== null) {
        sink.onMessageAppended?.(ref, { ...msg, sourceRef: `${t.sessionId}#offset=${lines[i].byteOffset}` })
        continue
      }
      if (o.type !== 'event_msg') continue
      const payload = o.payload
      const payloadType = payload !== null && typeof payload === 'object' ? (payload as { type?: unknown }).type : undefined
      let next = evalCodexEventPayload(payload)
      let detail: string | undefined
      if (managed && payloadType === 'task_complete') {
        next = 'waiting_input'
        const turnId =
          payload !== null && typeof payload === 'object' && typeof (payload as { turn_id?: unknown }).turn_id === 'string'
            ? (payload as { turn_id: string }).turn_id.slice(0, 8)
            : String(managedTurns.get(t.sessionId) ?? '?')
        detail = `turn ${turnId} ended; awaiting next user input`
      } else if (managed && payloadType === 'turn_aborted') {
        next = 'paused'
        detail = 'turn interrupted (turn_aborted observed on managed thread)'
      }
      if (next === null || next === t.lastStatus) continue
      const from = t.lastStatus
      t.lastStatus = next
      sink.onStatusChanged?.(ref, from, next, detail)
    }
  }

  // ---------------------------------------------------------------------------
  // 九方法 9：dispose + 诊断投影
  // ---------------------------------------------------------------------------

  async function dispose(): Promise<void> {
    // AC8：收尾持久 app-server 连接（docs/12 §10 树杀收尾；监控任务由
    // monitorRegistry 统一取消；一次性探测进程由 withAppServer 自收尾）。
    const conn = persistent
    persistent = null
    if (conn !== null) {
      try {
        await conn.proc.killTree()
      } catch {
        /* 已退出等幂等场景 */
      }
      await conn.proc.exited.catch(() => {})
    }
  }

  function describeDiagnostics(): ProviderDiagnosticsInfo {
    return {
      dataSource: {
        kind: 'rollout-jsonl',
        readable: true, // 可读性按轮次实测（monitor 循环失败计数）；诊断面给出通道形态
        ...(protocolStats.parseFailures > 0 || protocolStats.unknownLines > 0
          ? { detail: `parse failures: ${protocolStats.parseFailures}, unknown protocol lines: ${protocolStats.unknownLines}` }
          : {}),
      },
      control: {
        ...(lastHandshake !== null ? { appServer: lastHandshake.ok } : {}),
        note: lastHandshake === null ? 'no app-server handshake attempted yet' : lastHandshake.evidence,
      },
    }
  }

  return {
    id: 'codex',
    probeHealth,
    listSessions,
    readMessages,
    getCapabilities,
    sendReply: (ref, text) => executeCommand(ref, 'reply', text),
    pause: (ref) => executeCommand(ref, 'pause'),
    resume: (ref) => executeCommand(ref, 'resume'),
    startMonitor,
    dispose,
    describeDiagnostics,
  }
}
