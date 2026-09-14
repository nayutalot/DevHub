/**
 * kimiProvider.ts — Kimi Code CLI 接入适配器（docs/12 §8.3）。
 *
 * 数据源（AC0 实测事实 + 本批真机只读复核，Kimi 0.36.0）：
 * - exe：`~/.kimi-code/bin/kimi.exe`（旁有 fd.exe/rg.exe）；`--version` → `0.36.0`
 *   （exit 0；真机验证边界内的只读命令）；
 * - `~/.kimi-code/session_index.jsonl`：每行 `{sessionId, sessionDir, workDir}`；
 *   **实测存在删除墓碑行 `{"sessionId":"…","deleted":true}`**（解析时必须处理）；
 *   sessionId 形态 `session_<uuid>`；
 * - `<sessionDir>/state.json`：{id, version, cwd, createdAt(ms), updatedAt(ms),
 *   archived, agents:{<name>:{homedir,type}}, custom, lastTurnReason}；
 *   lastTurnReason 实测取值 {completed, cancelled, failed, null}；
 * - `<sessionDir>/agents/<agent>/wire.jsonl`：行类型全集（实机 6 会话语料）=
 *   metadata | profile.bind | permission.set_mode | turn.prompt |
 *   context.append_message(message:{role,content:[{type:'text',text}],id}) |
 *   plugin.session_start | context.append_loop_event(event:{type: step.begin|
 *   content.part(part.type= think|text)|step.end|tool.call|tool.result}) |
 *   llm.tools_snapshot | llm.request | turn.ended(reason) | usage.record |
 *   config.update | interaction.request(kind) | interaction.resolved |
 *   permission.record_approval_result | turn.cancel | tools.update_store |
 *   task.started | task.terminated | plan_mode.enter | plan_mode.cancel；
 * - **审批判定源（实机复核）**：`interaction.request` kind='approval'（全部 7 条），
 *   以 `interaction.resolved`（response.decision: approved|rejected）闭环；
 *   其他 kind 语料未出现 → 不据此产生任何状态（绝不猜）；
 * - config.toml：default_model / [providers.*]（type/base_url/**api_key 明文——
 *   红线**）/ [models.*] / [thinking]；api_key 任何投影只经 maskKey（尾 4 位+长度）。
 *
 * 状态判定（docs/12 §5 判定表；实机语料后定，映射见 evalKimiWireLine）：
 * - running ← turn.prompt（回合在途）；
 * - approval_required ← interaction.request(kind='approval') 且未 resolved
 *   （docs/12 §5 指定判定源之一；resolved 全部消化后回到 running）；
 * - waiting_input ← turn.ended(reason='completed')（回合正常收束、等用户下一条
 *   输入——与 claude Stop hook 语义一致）；
 * - failed ← turn.ended(reason='failed')（有真实失败记录）；
 * - turn.ended(reason='cancelled') → unknown（对齐 codex turn_aborted 先例：
 *   用户取消不推断为会话终态）；
 * - 其余行类型一律不产生状态（判定不了 → unknown/无证据）。
 *
 * managed 通道（docs/12 §8.3）：sendReply = spawnManaged 托管启动 kimi（stdinWritable）
 * + writeStdin 注入 → **轮询会话文件终态确认**（wire.jsonl 新增 turn.ended 或
 * state.json updatedAt 推进且 lastTurnReason 非空），超时/进程先退且无终态 → 结构化
 * 失败——**禁仅凭进程退出判成功**。真机边界（KM 批改版）：kimi 真实托管启动必然
 * 写入 ~/.kimi-code（sessions/logs）且必然消耗真实推理 → 默认（settings 键
 * `kimi_managed_enabled` 缺行/≠'1'）保持 observed + 空集，原因随 evidence 记录；
 * 键=1（用户显式授权，docs/briefs/km-kimi-managed.md Phase B/C）时经 options.managedGate
 * 授 managed+reply（evidence 带真实 CLI 版本；zcode doctor 先例：存活探测+配置
 * 就绪 → managed，回合级真实验证由真实 sendReply 承担——一次性 -p 探测必然消耗
 * 推理并产生垃圾会话，绝不作 caps 探测面）。
 *
 * KM 批真机通道（Phase A kimi 0.42.0 只读复核定形）：一次性 argv 模板
 * `kimi -S {sessionId} -p {prompt} --output-format stream-json`——0.42 的 TUI+管道
 * stdin 有 workspace 信任门+TTY 依赖不可托管；resume 实测不建新会话（turn 增量落
 * 同一 wire.jsonl，turnId 递增）；stream-json stdout NDJSON 事件流喂托管心跳
 * （重试退避实测可达 ~34s，门注入 idle 60s）。0.36→0.42 漂移面详见
 * acceptance/kimi-managed-e2e/phase-a-0.42-review.md。
 *
 * 红线：`~/.kimi-code/**` 全程零写入；config.toml 明文 api_key 任何投影只有尾 4 位
 * + 长度（projectKimiConfig → maskKey，docs/12 §8.3 / docs/15 §6）；
 * electron-free；一切系统命令经 core/exec.run()/spawnManaged()（约束 #7/#8）。
 */

import { watch, type FSWatcher } from 'node:fs'
import { open, readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentCapabilitySet, SessionStatus } from '../../../../shared/types.ts'
import { run, spawnManaged, type ManagedProcess } from '../../../core/exec.ts'
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
import { maskKey, redactText } from '../redact.ts'
import { KIMI_MANAGED_ENABLED_SETTING_KEY, type KimiManagedGateState } from './kimiManagedConfig.ts'
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

export interface KimiProviderOptions {
  /** `~/.kimi-code`（默认真实 home；smoke 注入夹具目录）。 */
  kimiHome?: string
  /** kimi.exe 路径（默认 `<kimiHome>/bin/kimi.exe`；smoke 注入夹具假进程）。 */
  exePath?: string
  /** `--version` 超时（约束 #9 显式放宽；kimi.exe 体积大，冷启动慢）。 */
  versionTimeoutMs?: number
  /** 托管进程心跳空闲超时。 */
  managedIdleTimeoutMs?: number
  /** 托管进程总生命周期上限。 */
  managedLifetimeTimeoutMs?: number
  /** 托管启动参数（sendReply 用）。默认 undefined = managed 通道未配置：
   * sendReply 结构化拒绝（真实 kimi 托管启动会写 ~/.kimi-code 且无法保证不触发
   * 推理——零写入红线下绝不真机启动；smoke 注入夹具假进程脚本）。
   */
  spawnArgs?: string[]
  /** 托管进程环境变量（默认继承；smoke 注入夹具会话目录等）。 */
  spawnEnv?: NodeJS.ProcessEnv
  /** 托管探测参数（getCapabilities managed 握手用；默认 undefined = 跳过真机探测）。 */
  managedProbeArgs?: string[]
  /** 托管探测进程环境变量。 */
  managedProbeEnv?: NodeJS.ProcessEnv
  /** managed 探测确认用会话目录（探测进程收到 stdin 后应在其 state.json 落终态线索）。 */
  managedProbeSessionDir?: string
  /** sendReply 后会话文件终态确认窗口毫秒（超时 → 结构化失败）。 */
  replySettleMs?: number
  /** 终态轮询间隔毫秒。 */
  replyPollMs?: number
  /** 托管探测确认窗口毫秒。 */
  managedProbeConfirmMs?: number
  /**
   * KM 批：真机 managed 授权门（每调用读取，kimiManagedConfig.readKimiManagedGate
   * 生产注入）。enabled=true 时 getCapabilities 授 managed+reply（evidence 带真实
   * CLI 版本），sendReply 走一次性 argv 模板通道；停用/undefined = 现行为逐字节
   * 不变——夹具 stdin 通道与 observed 红线全保留。
   */
  managedGate?: () => KimiManagedGateState
  /** 消息投影单条字符上限（完整内容在源文件，source_ref 指回）。 */
  messageTextCap?: number
  /** 单 tick 消息投影上限（防御超大 wire 语料）。 */
  tickMessageCap?: number
}

const DEFAULT_VERSION_TIMEOUT_MS = 60_000
const DEFAULT_MANAGED_IDLE_MS = 15_000
const DEFAULT_MANAGED_LIFETIME_MS = 120_000
const DEFAULT_REPLY_SETTLE_MS = 30_000
const DEFAULT_REPLY_POLL_MS = 250
const DEFAULT_PROBE_CONFIRM_MS = 15_000
const DEFAULT_MESSAGE_TEXT_CAP = 4_000
const DEFAULT_TICK_MESSAGE_CAP = 400
/** --version 结果缓存（探测不反复打子进程）。 */
const VERSION_CACHE_MS = 300_000

/**
 * interaction.request 审批 kind 全集——实机复核（0.36.0，全部语料 7 条）仅
 * 'approval' 一种；其他 kind 不产生任何状态（绝不猜）。
 */
export const KIMI_APPROVAL_KINDS: readonly string[] = ['approval'] as const
/** 等待文本输入的 interaction kind 全集——语料未出现 → 置空（绝不猜）。 */
export const KIMI_INPUT_INTERACTION_KINDS: readonly string[] = [] as const

/**
 * wire.jsonl 行 → 状态判定（docs/12 §5；返回 null = 无状态证据）。
 * pendingApprovals：跨行记忆的未闭环审批 id 集（interaction.request 加入 /
 * interaction.resolved 移除）；同会话多 agent wire 文件共享同一集合。
 */
export function evalKimiWireLine(
  obj: Record<string, unknown>,
  pendingApprovals: Set<string>,
): SessionStatus | null {
  const type = obj['type']
  if (typeof type !== 'string') return null
  if (type === 'interaction.request') {
    const kind = obj['kind']
    const id = obj['id']
    if (typeof kind === 'string' && typeof id === 'string' && id.length > 0) {
      if (KIMI_APPROVAL_KINDS.includes(kind)) {
        pendingApprovals.add(id)
        return 'approval_required'
      }
      if (KIMI_INPUT_INTERACTION_KINDS.includes(kind)) return 'waiting_input'
    }
    return null
  }
  if (type === 'interaction.resolved') {
    const id = obj['id']
    if (typeof id === 'string') pendingApprovals.delete(id)
    // 审批闭环后回合继续在途；仍有未闭环审批则保持 approval_required
    return pendingApprovals.size > 0 ? 'approval_required' : 'running'
  }
  if (type === 'turn.prompt') {
    pendingApprovals.clear() // 新回合开始：旧审批必然已消化
    return 'running'
  }
  if (type === 'turn.ended') {
    pendingApprovals.clear()
    const reason = obj['reason']
    if (reason === 'completed') return 'waiting_input'
    if (reason === 'failed') return 'failed'
    return 'unknown' // cancelled / 未知 reason：绝不推断会话终态
  }
  return null
}

/** state.json lastTurnReason → 状态（listSessions/终态兜底判定；无证据 → null）。 */
export function evalKimiLastTurnReason(reason: unknown): SessionStatus | null {
  if (reason === 'completed') return 'waiting_input'
  if (reason === 'failed') return 'failed'
  if (reason === 'cancelled') return 'unknown'
  return null
}

// ---------------------------------------------------------------------------
// config.toml 投影（api_key 红线：任何投影只经 maskKey = 尾 4 位 + 长度）
// ---------------------------------------------------------------------------

export interface KimiConfigProviderProjection {
  name: string
  type?: string
  baseUrl?: string
  /** maskKey 投影（尾 4 位 + 长度）；绝不含明文。 */
  apiKeyMasked: { tail: string; len: number } | null
}

export interface KimiConfigProjection {
  defaultModel?: string
  providers: KimiConfigProviderProjection[]
  thinkingEnabled?: boolean
}

/**
 * 极简 TOML 行解析（只覆盖 config.toml 实测结构：[section] / key = value），
 * 唯一目的 = 脱敏投影；解析失败行跳过不中断。值段的引号剥离后非敏感键原样保留，
 * api_key 只输出 maskKey 投影（T10 红线断言对象）。
 */
export async function projectKimiConfig(configPath: string): Promise<KimiConfigProjection> {
  const projection: KimiConfigProjection = { providers: [] }
  let raw: string
  try {
    raw = await readFile(configPath, 'utf8')
  } catch {
    return projection
  }
  let section = ''
  let currentProvider: KimiConfigProviderProjection | null = null
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const sec = /^\[+([^\]]+)\]+$/.exec(line)
    if (sec !== null) {
      section = sec[1]
      if (section.startsWith('providers.')) {
        currentProvider = { name: section.slice('providers.'.length), apiKeyMasked: null }
        projection.providers.push(currentProvider)
      } else {
        currentProvider = null
      }
      continue
    }
    const kv = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line)
    if (kv === null) continue
    const key = kv[1]
    const value = kv[2].trim().replace(/^"(.*)"$/, '$1')
    if (section.length === 0) {
      if (key === 'default_model') projection.defaultModel = value
      continue
    }
    if (section === 'thinking') {
      if (key === 'enabled') projection.thinkingEnabled = value === 'true'
      continue
    }
    if (currentProvider !== null) {
      if (key === 'type') currentProvider.type = value
      else if (key === 'base_url') currentProvider.baseUrl = value
      else if (/api[_-]?key/i.test(key)) currentProvider.apiKeyMasked = maskKey(value)
    }
  }
  return projection
}

// ---------------------------------------------------------------------------
// session_index.jsonl / state.json 解析
// ---------------------------------------------------------------------------

export interface KimiIndexEntry {
  sessionId: string
  sessionDir: string
  workDir?: string
}

export interface KimiIndexParseResult {
  entries: KimiIndexEntry[]
  /** 墓碑行数（{"deleted":true}）——已删会话不再发现。 */
  tombstones: number
  parseFailures: number
}

/** 解析 session_index.jsonl（逐行 try-parse；失败行计数不中断；墓碑行剔除）。 */
export async function parseKimiSessionIndex(indexPath: string): Promise<KimiIndexParseResult> {
  const result: KimiIndexParseResult = { entries: [], tombstones: 0, parseFailures: 0 }
  let raw: string
  try {
    raw = await readFile(indexPath, 'utf8')
  } catch {
    return result
  }
  const byId = new Map<string, KimiIndexEntry>()
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim()
    if (text.length === 0) continue
    try {
      const obj = JSON.parse(text) as Record<string, unknown>
      const sessionId = obj['sessionId']
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        result.parseFailures += 1
        continue
      }
      if (obj['deleted'] === true) {
        result.tombstones += 1
        byId.delete(sessionId) // 墓碑：删除既有条目（后写优先）
        continue
      }
      const sessionDir = obj['sessionDir']
      if (typeof sessionDir !== 'string' || sessionDir.length === 0) {
        result.parseFailures += 1
        continue
      }
      const workDir = obj['workDir']
      byId.set(sessionId, {
        sessionId,
        sessionDir,
        ...(typeof workDir === 'string' && workDir.length > 0 ? { workDir } : {}),
      })
    } catch {
      result.parseFailures += 1
    }
  }
  result.entries = [...byId.values()]
  return result
}

interface KimiStateJson {
  id?: unknown
  cwd?: unknown
  createdAt?: unknown
  updatedAt?: unknown
  archived?: unknown
  lastTurnReason?: unknown
  agents?: unknown
}

/** 托管进程「是否已退出」的非阻塞标记（exited promise 的旁路观察，不消费 exited 本身）。 */
function trackEarlyExit(proc: ManagedProcess): { get(): boolean } {
  let exited = false
  void proc.exited.then(
    () => {
      exited = true
    },
    () => {
      exited = true
    },
  )
  return { get: () => exited }
}

async function readKimiState(sessionDir: string): Promise<{ state: KimiStateJson | null; parseFailed: boolean }> {
  try {
    const raw = await readFile(join(sessionDir, 'state.json'), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { state: parsed as KimiStateJson, parseFailed: false }
    }
    return { state: null, parseFailed: true }
  } catch {
    return { state: null, parseFailed: false } // 无 state.json（非常早期会话）不算解析失败
  }
}

/** state.json.agents 键 → wire.jsonl 文件列表（缺省扫 agents 目录下各 agent 的 wire.jsonl）。 */
async function wireFilesOf(sessionDir: string, state: KimiStateJson | null): Promise<string[]> {
  const agentNames =
    state?.agents !== null && typeof state?.agents === 'object' && !Array.isArray(state?.agents)
      ? Object.keys(state.agents as Record<string, unknown>)
      : null
  const agentsDir = join(sessionDir, 'agents')
  if (agentNames !== null && agentNames.length > 0) {
    return agentNames.map((name) => join(agentsDir, name, 'wire.jsonl'))
  }
  try {
    const dirs = await readdir(agentsDir, { withFileTypes: true })
    return dirs.filter((d) => d.isDirectory()).map((d) => join(agentsDir, d.name, 'wire.jsonl'))
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// wire.jsonl 消息投影
// ---------------------------------------------------------------------------

function textOfContentParts(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const item of content) {
    if (item !== null && typeof item === 'object') {
      const c = item as { type?: unknown; text?: unknown }
      if (c.type === 'text' && typeof c.text === 'string') parts.push(c.text)
    }
  }
  return parts.join('\n')
}

function lineTimeSec(obj: Record<string, unknown>): number | undefined {
  const ts = obj['time']
  if (typeof ts === 'number' && Number.isFinite(ts) && ts > 0) return Math.floor(ts / 1000)
  return undefined
}

/**
 * wire 行 → 消息投影：
 * - context.append_message：message.{role, content, id}（实机 role=user）；
 * - context.append_loop_event(content.part, part.type='text')：assistant 正文分片
 *   （think 分片不投影——内部推理非用户可见面）；
 * - 其余行类型不投影。
 */
export function projectKimiWireMessage(
  obj: Record<string, unknown>,
  byteOffset: number,
  textCap: number,
): RedactedMessage | null {
  const type = obj['type']
  if (type === 'context.append_message') {
    const message = obj['message']
    if (message === null || typeof message !== 'object') return null
    const m = message as Record<string, unknown>
    const text = textOfContentParts(m['content'])
    if (text.length === 0) return null
    const role = typeof m['role'] === 'string' && m['role'].length > 0 ? m['role'] : 'user'
    const id = typeof m['id'] === 'string' && m['id'].length > 0 ? m['id'] : `line:${byteOffset}`
    return {
      role,
      contentRedacted: redactText(text).slice(0, textCap),
      nativeMsgId: id,
      ...(lineTimeSec(obj) !== undefined ? { occurredAt: lineTimeSec(obj) } : {}),
      sourceRef: `wire#offset=${byteOffset}`,
    }
  }
  if (type === 'context.append_loop_event') {
    const event = obj['event']
    if (event === null || typeof event !== 'object') return null
    const ev = event as Record<string, unknown>
    if (ev['type'] !== 'content.part') return null
    const part = ev['part']
    if (part === null || typeof part !== 'object') return null
    const p = part as Record<string, unknown>
    if (p['type'] !== 'text' || typeof p['text'] !== 'string' || p['text'].length === 0) return null
    const uuid = typeof ev['uuid'] === 'string' && ev['uuid'].length > 0 ? ev['uuid'] : `line:${byteOffset}`
    return {
      role: 'assistant',
      contentRedacted: redactText(p['text']).slice(0, textCap),
      nativeMsgId: uuid,
      ...(lineTimeSec(obj) !== undefined ? { occurredAt: lineTimeSec(obj) } : {}),
      sourceRef: `wire#offset=${byteOffset}`,
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Provider（docs/12 §4 九方法）
// ---------------------------------------------------------------------------

interface TrackedWire {
  sessionId: string
  reader: IncrementalJsonlReader
  parseFailures: number
}

export function createKimiProvider(options: KimiProviderOptions = {}): AgentProvider {
  const kimiHome = options.kimiHome ?? join(homedir(), '.kimi-code')
  const versionTimeoutMs = options.versionTimeoutMs ?? DEFAULT_VERSION_TIMEOUT_MS
  const managedIdleTimeoutMs = options.managedIdleTimeoutMs ?? DEFAULT_MANAGED_IDLE_MS
  const managedLifetimeTimeoutMs = options.managedLifetimeTimeoutMs ?? DEFAULT_MANAGED_LIFETIME_MS
  const replySettleMs = options.replySettleMs ?? DEFAULT_REPLY_SETTLE_MS
  const replyPollMs = options.replyPollMs ?? DEFAULT_REPLY_POLL_MS
  const managedProbeConfirmMs = options.managedProbeConfirmMs ?? DEFAULT_PROBE_CONFIRM_MS
  const messageTextCap = options.messageTextCap ?? DEFAULT_MESSAGE_TEXT_CAP
  const tickMessageCap = options.tickMessageCap ?? DEFAULT_TICK_MESSAGE_CAP

  const stats = { indexParseFailures: 0, wireParseFailures: 0 }
  let versionCache: { version?: string; ok: boolean; at: number; detail: string } | null = null
  let lastReplyVerdict: string | null = null

  function indexPath(): string {
    return join(kimiHome, 'session_index.jsonl')
  }

  function defaultExePath(): string {
    return join(kimiHome, 'bin', 'kimi.exe')
  }

  async function resolveExe(): Promise<string> {
    return options.exePath ?? defaultExePath()
  }

  /** --version 探测（缓存 300s；失败/成功都是合法结果）。 */
  async function probeVersion(force = false): Promise<{ ok: boolean; version?: string; detail: string }> {
    if (!force && versionCache !== null && Date.now() - versionCache.at < VERSION_CACHE_MS) {
      return { ok: versionCache.ok, ...(versionCache.version !== undefined ? { version: versionCache.version } : {}), detail: versionCache.detail }
    }
    const exe = await resolveExe()
    let st: { isFile: boolean } | null = null
    try {
      const s = await stat(exe)
      st = { isFile: s.isFile() }
    } catch {
      st = null
    }
    if (st === null || !st.isFile) {
      versionCache = { version: undefined, ok: false, at: Date.now(), detail: `kimi exe not found at ${exe}` }
      return { ok: false, detail: versionCache.detail }
    }
    const r = await run(exe, ['--version'], { timeoutMs: versionTimeoutMs })
    if (r.code === 0 && !r.timedOut) {
      const version = /(\d+\.\d+\.\d+)/.exec(r.stdout)?.[1]
      const cache = {
        ...(version !== undefined ? { version } : {}),
        ok: true,
        at: Date.now(),
        detail: version !== undefined ? `kimi --version ok (${version})` : `kimi --version ok (output not parseable: ${r.stdout.trim().slice(0, 60)})`,
      }
      versionCache = cache
      return { ok: true, ...(version !== undefined ? { version } : {}), detail: cache.detail }
    }
    versionCache = {
      version: undefined,
      ok: false,
      at: Date.now(),
      detail: `kimi --version failed: ${(r.stderr || r.stdout || `exit ${r.code}`).slice(0, 160)}`,
    }
    return { ok: false, detail: versionCache.detail }
  }

  // -------------------------------------------------------------------------
  // 九方法 1-2：probeHealth / listSessions
  // -------------------------------------------------------------------------

  async function probeHealth(): Promise<ProviderHealth> {
    const exe = await resolveExe()
    try {
      const s = await stat(exe)
      if (!s.isFile()) {
        return { installed: false, health: 'unavailable', healthDetail: `kimi exe not found at ${exe}` }
      }
    } catch {
      return { installed: false, health: 'unavailable', healthDetail: `kimi exe not found at ${exe}` }
    }
    const v = await probeVersion(true)
    if (!v.ok) {
      return { installed: true, exePath: exe, health: 'degraded', healthDetail: v.detail }
    }
    return {
      installed: true,
      ...(v.version !== undefined ? { version: v.version } : {}),
      exePath: exe,
      health: 'ok',
    }
  }

  /** 索引 + state.json → 会话快照（workDir 归一匹配归 L3；绝不造 title）。 */
  async function listSessions(): Promise<SessionSnapshot[]> {
    const index = await parseKimiSessionIndex(indexPath())
    stats.indexParseFailures += index.parseFailures
    const snapshots: SessionSnapshot[] = []
    for (const entry of index.entries) {
      const dirStat = await stat(entry.sessionDir).catch(() => null)
      const { state } = await readKimiState(entry.sessionDir)
      const createdAt = typeof state?.createdAt === 'number' ? Math.floor(state.createdAt / 1000) : undefined
      const updatedAt = typeof state?.updatedAt === 'number' ? Math.floor(state.updatedAt / 1000) : undefined
      const dirActivity = dirStat !== null ? Math.floor(dirStat.mtimeMs / 1000) : undefined
      const lastActivity = [updatedAt, dirActivity].filter((v): v is number => v !== undefined)
      snapshots.push({
        nativeId: entry.sessionId,
        ...(typeof state?.cwd === 'string' && state.cwd.length > 0 ? { workdir: state.cwd } : entry.workDir !== undefined ? { workdir: entry.workDir } : {}),
        ...(createdAt !== undefined ? { startedAt: createdAt } : {}),
        ...(lastActivity.length > 0 ? { lastActivityAt: Math.max(...lastActivity) } : {}),
      })
    }
    return snapshots
  }

  async function findSessionDir(nativeId: string): Promise<string | null> {
    const index = await parseKimiSessionIndex(indexPath())
    stats.indexParseFailures += index.parseFailures
    return index.entries.find((e) => e.sessionId === nativeId)?.sessionDir ?? null
  }

  // -------------------------------------------------------------------------
  // 九方法 3：readMessages（wire.jsonl 增量 → MessagePage）
  // -------------------------------------------------------------------------

  async function readMessages(ref: SessionRef, after?: string): Promise<MessagePage> {
    const sessionDir = await findSessionDir(ref.nativeId)
    if (sessionDir === null) return { messages: [], cursor: after ?? '0', hasMore: false }
    const files = await wireFilesOf(sessionDir, (await readKimiState(sessionDir)).state)
    const startOffset = after !== undefined ? Number.parseInt(after, 10) : 0
    const from = Number.isSafeInteger(startOffset) && startOffset > 0 ? startOffset : 0
    const messages: RedactedMessage[] = []
    let maxOffset = from
    for (const file of files) {
      const reader = new IncrementalJsonlReader(file, from)
      const result = await reader.read()
      if (!result.readable) continue
      stats.wireParseFailures += result.parseFailures
      maxOffset = Math.max(maxOffset, reader.currentOffset)
      for (let i = 0; i < result.lines.length; i++) {
        const parsed = result.parsed[i]
        if (parsed === null || typeof parsed !== 'object') continue
        const msg = projectKimiWireMessage(parsed as Record<string, unknown>, result.lines[i].byteOffset, messageTextCap)
        if (msg !== null) messages.push({ ...msg, sourceRef: `${ref.nativeId}#offset=${result.lines[i].byteOffset}` })
        if (messages.length >= tickMessageCap) break
      }
      if (messages.length >= tickMessageCap) break
    }
    return { messages, cursor: String(maxOffset), hasMore: false }
  }

  // -------------------------------------------------------------------------
  // 九方法 4：getCapabilities（observed 首版 + 夹具 managed 探测）
  // -------------------------------------------------------------------------

  async function getCapabilities(_ref: SessionRef): Promise<AgentCapabilitySet> {
    // managed 探测（真机跳过：见文件头「真机边界」——真实托管启动必然写入
    // ~/.kimi-code 且无法保证不触发推理；夹具经 managedProbeArgs 注入验证）
    if (options.managedProbeArgs !== undefined) {
      const verdict = await runManagedProbe()
      return verdict
    }
    // KM 批：settings 授权门开着（键=1，用户显式授权真机推理+写入）→ 门驱动判定
    // （真实 CLI 版本探测+配置面可读；门停用/未注入 → 落到既有 observed 路径，
    // 行为逐字节不变）
    const gate = options.managedGate?.()
    if (gate !== undefined && gate.enabled) return gateCapabilities(gate)
    const v = await probeVersion()
    const indexReadable = await stat(indexPath()).then(() => true, () => false)
    const reason =
      !v.ok
        ? `exe/version probe failed (${v.detail})`
        : !indexReadable
          ? 'session_index.jsonl not readable'
          : 'managed probe skipped: launching a real kimi session would write into ~/.kimi-code and cannot be guaranteed inference-free (red line; fixture-verified managed channel, real-machine e2e lands in AC8)'
    return {
      mode: 'observed',
      granted: [],
      verifiedAt: nowSec(),
      evidence: `read-only session files; ${reason}`,
    }
  }

  /** 夹具 managed 探测：stdin 注入探针 → 轮询探测会话目录的 state.json 终态线索。 */
  async function runManagedProbe(): Promise<AgentCapabilitySet> {
    const probeDir = options.managedProbeSessionDir
    if (probeDir === undefined) {
      return {
        mode: 'observed',
        granted: [],
        verifiedAt: nowSec(),
        evidence: 'managed probe skipped: managedProbeSessionDir not configured',
      }
    }
    const exe = await resolveExe()
    const proc = spawnManaged(exe, options.managedProbeArgs ?? [], {
      idleTimeoutMs: managedIdleTimeoutMs,
      lifetimeTimeoutMs: managedLifetimeTimeoutMs,
      stdinWritable: true,
      ...(options.managedProbeEnv !== undefined ? { env: options.managedProbeEnv } : {}),
    })
    const exitFlag = trackEarlyExit(proc)
    try {
      if (proc.pid <= 0) {
        return { mode: 'observed', granted: [], verifiedAt: nowSec(), evidence: 'managed probe failed: spawn error' }
      }
      const written = proc.writeStdin(`${JSON.stringify({ probe: 'devhub-managed-probe' })}\n`)
      if (!written.ok) {
        return {
          mode: 'observed',
          granted: [],
          verifiedAt: nowSec(),
          evidence: `managed probe failed: stdin write (${written.error?.code ?? 'unknown'})`,
        }
      }
      const deadline = Date.now() + managedProbeConfirmMs
      while (Date.now() < deadline) {
        const { state } = await readKimiState(probeDir)
        if (state !== null && typeof state['lastTurnReason'] === 'string' && (state['lastTurnReason'] as string).length > 0) {
          return {
            mode: 'managed',
            granted: ['reply'],
            verifiedAt: nowSec(),
            evidence: 'managed probe ok: stdin probe confirmed by session-file terminal state',
          }
        }
        if (exitFlag.get()) break
        await new Promise((r) => setTimeout(r, Math.max(50, replyPollMs)))
      }
      const detail = exitFlag.get()
        ? 'managed probe failed: process exited without session-file terminal state'
        : 'managed probe timed out without session-file terminal state'
      return { mode: 'observed', granted: [], verifiedAt: nowSec(), evidence: detail }
    } finally {
      try {
        await proc.killTree()
      } catch {
        /* 已退出 */
      }
      await proc.exited.catch(() => {})
    }
  }

  /**
   * KM 批：settings 授权门驱动的 managed 判定（键=1）。判定面 = 真实 CLI 版本探测
   * （--version，零推理零写入）+ config.toml 可读性（只 stat 不读内容——api_key
   * 红线）；回合级真实验证由真实 sendReply 承担（一次性 -p 探测必然消耗推理并
   * 产生垃圾会话，绝不作 caps 探测面）。版本探测失败/配置缺失 → observed + 结构化
   * evidence（绝不半开：门开着但 CLI 不可用 = 不可托管）。
   */
  async function gateCapabilities(gate: KimiManagedGateState): Promise<AgentCapabilitySet> {
    const v = await probeVersion(true)
    if (!v.ok) {
      return {
        mode: 'observed',
        granted: [],
        verifiedAt: nowSec(),
        evidence: `kimi managed face enabled (${KIMI_MANAGED_ENABLED_SETTING_KEY}=1) but version probe failed: ${v.detail}`,
      }
    }
    const configPath = join(gate.kimiHome ?? kimiHome, 'config.toml')
    const configReadable = await stat(configPath).then(
      () => true,
      () => false,
    )
    return {
      mode: 'managed',
      granted: ['reply'],
      verifiedAt: nowSec(),
      evidence: `kimi managed face enabled (${KIMI_MANAGED_ENABLED_SETTING_KEY}=1): ${v.detail}; config.toml ${configReadable ? 'readable' : 'NOT readable (reply will fail closed)'}; reply = one-shot "kimi -S <id> -p <text>" with session-file terminal confirmation`,
    }
  }

  // -------------------------------------------------------------------------
  // 九方法 5-7：sendReply / pause / resume（managed stdin 注入 + 会话文件终态确认）
  // -------------------------------------------------------------------------

  function unsupported(action: 'reply' | 'pause' | 'resume'): CommandOutcome {
    return {
      ok: false,
      status: 'unsupported',
      errorCode: 'COMMAND_NOT_EXECUTABLE',
      detail:
        action === 'reply'
          ? 'kimi managed channel not configured (spawnArgs missing): real kimi launch would write ~/.kimi-code and cannot be guaranteed inference-free'
          : 'kimi has no verified pause/resume channel (observed; managed stdin carries reply only)',
    }
  }

  /**
   * sendReply：baseline（wire 尺寸 + state.json updatedAt）→ spawnManaged 托管 →
   * writeStdin 注入 → 轮询会话文件终态（wire 新增 turn.ended / state.json updatedAt
   * 推进且 lastTurnReason 非空）→ executed；超时或进程先退且无终态 → 结构化失败
   * （进程退出 ≠ 成功，docs/12 §8.3）。
   * KM 批：授权门开着且带一次性 argv 模板 → 走 sendReplyManagedArgv（0.42 真机
   * 形态）；门停用/未注入 → 既有 stdin 路径逐字节保留（夹具通道）。
   */
  async function sendReply(ref: SessionRef, text: string): Promise<CommandOutcome> {
    const gate = options.managedGate?.()
    if (gate !== undefined && gate.enabled && gate.replyTemplate !== undefined) {
      return sendReplyManagedArgv(ref, text, gate)
    }
    if (options.spawnArgs === undefined) return unsupported('reply')
    const sessionDir = await findSessionDir(ref.nativeId)
    if (sessionDir === null) {
      return {
        ok: false,
        status: 'failed',
        errorCode: 'COMMAND_NOT_EXECUTABLE',
        detail: `kimi session ${ref.nativeId} not found in session_index.jsonl`,
      }
    }
    const baseline = await readTerminalBaseline(sessionDir)
    const exe = await resolveExe()
    const proc = spawnManaged(exe, options.spawnArgs, {
      idleTimeoutMs: managedIdleTimeoutMs,
      lifetimeTimeoutMs: managedLifetimeTimeoutMs,
      stdinWritable: true,
      ...(options.spawnEnv !== undefined ? { env: options.spawnEnv } : {}),
    })
    const exitFlag = trackEarlyExit(proc)
    try {
      if (proc.pid <= 0) {
        lastReplyVerdict = 'spawn failed'
        return { ok: false, status: 'failed', errorCode: 'COMMAND_NOT_EXECUTABLE', detail: 'kimi managed spawn failed' }
      }
      const written = proc.writeStdin(`${text}\n`)
      if (!written.ok) {
        lastReplyVerdict = `stdin write failed (${written.error?.code ?? 'unknown'})`
        return {
          ok: false,
          status: 'failed',
          errorCode: 'COMMAND_NOT_EXECUTABLE',
          detail: `kimi reply stdin write failed: ${written.error?.message ?? written.error?.code ?? 'unknown'}`,
        }
      }
      return await pollTerminalOutcome(sessionDir, baseline, exitFlag, replyPollMs, replySettleMs)
    } finally {
      try {
        await proc.killTree()
      } catch {
        /* 已退出 */
      }
      await proc.exited.catch(() => {})
    }
  }

  /**
   * KM 批真机通道：授权门的一次性 argv 模板 spawn（无 stdin 注入——0.42 实测
   * TUI+管道 stdin 有 workspace 信任门不可托管）。模板占位符 {sessionId}/{prompt}
   * 全量替换；参数数组无 shell，prompt 原样单 argv 传递（零注入面）。终态确认与
   * stdin 路径完全同款（进程退出 ≠ 成功红线原样保留）。门注入 idle/lifetime 覆盖
   * 默认（stream-json 事件流喂心跳；重试退避实测 ~34s > 默认 idle 15s）。
   */
  async function sendReplyManagedArgv(ref: SessionRef, text: string, gate: KimiManagedGateState): Promise<CommandOutcome> {
    const template = gate.replyTemplate
    if (template === undefined) {
      lastReplyVerdict = 'gate enabled without reply template'
      return {
        ok: false,
        status: 'failed',
        errorCode: 'COMMAND_NOT_EXECUTABLE',
        detail: 'kimi managed gate enabled without a reply template (malformed gate state)',
      }
    }
    const sessionDir = await findSessionDir(ref.nativeId)
    if (sessionDir === null) {
      return {
        ok: false,
        status: 'failed',
        errorCode: 'COMMAND_NOT_EXECUTABLE',
        detail: `kimi session ${ref.nativeId} not found in session_index.jsonl`,
      }
    }
    const baseline = await readTerminalBaseline(sessionDir)
    const exe = await resolveExe()
    const args = template.map((arg) =>
      arg.replaceAll('{sessionId}', ref.nativeId).replaceAll('{prompt}', text),
    )
    const proc = spawnManaged(exe, args, {
      idleTimeoutMs: gate.managedIdleTimeoutMs ?? managedIdleTimeoutMs,
      lifetimeTimeoutMs: gate.managedLifetimeTimeoutMs ?? managedLifetimeTimeoutMs,
      stdinWritable: false,
    })
    const exitFlag = trackEarlyExit(proc)
    try {
      if (proc.pid <= 0) {
        lastReplyVerdict = 'spawn failed'
        return { ok: false, status: 'failed', errorCode: 'COMMAND_NOT_EXECUTABLE', detail: 'kimi managed spawn failed' }
      }
      return await pollTerminalOutcome(sessionDir, baseline, exitFlag, replyPollMs, replySettleMs)
    } finally {
      try {
        await proc.killTree()
      } catch {
        /* 已退出 */
      }
      await proc.exited.catch(() => {})
    }
  }

  /** 终态确认轮询（stdin/argv 两条 managed 通道共用；逐字节同款语义）。 */
  async function pollTerminalOutcome(
    sessionDir: string,
    baseline: TerminalBaseline,
    exitFlag: { get(): boolean },
    pollMs: number,
    settleMs: number,
  ): Promise<CommandOutcome> {
    const deadline = Date.now() + settleMs
    while (Date.now() < deadline) {
      const terminal = await readTerminalEvidence(sessionDir, baseline)
      if (terminal !== null) {
        lastReplyVerdict = `terminal state confirmed (${terminal})`
        return { ok: true, status: 'executed', detail: `kimi session file terminal state: ${terminal}` }
      }
      if (exitFlag.get()) {
        // 进程先退：最后再核对一次（退出冲刷可能已落盘）
        const final = await readTerminalEvidence(sessionDir, baseline)
        if (final !== null) {
          lastReplyVerdict = `terminal state confirmed after exit (${final})`
          return { ok: true, status: 'executed', detail: `kimi session file terminal state (process exited): ${final}` }
        }
        lastReplyVerdict = 'process exited without session-file terminal state'
        return {
          ok: false,
          status: 'failed',
          errorCode: 'COMMAND_NOT_EXECUTABLE',
          detail: 'kimi process exited before any session-file terminal state (process exit ≠ success)',
        }
      }
      await new Promise((r) => setTimeout(r, pollMs))
    }
    lastReplyVerdict = `no terminal state within ${settleMs}ms`
    return {
      ok: false,
      status: 'failed',
      errorCode: 'COMMAND_NOT_EXECUTABLE',
      detail: `kimi reply not confirmed in session files within ${settleMs}ms`,
    }
  }

  async function pause(): Promise<CommandOutcome> {
    return unsupported('pause')
  }

  async function resume(): Promise<CommandOutcome> {
    return unsupported('resume')
  }

  interface TerminalBaseline {
    wireSizes: Map<string, number>
    stateUpdatedAt: number
    lastTurnReason: string | null
  }

  async function readTerminalBaseline(sessionDir: string): Promise<TerminalBaseline> {
    const { state } = await readKimiState(sessionDir)
    const files = await wireFilesOf(sessionDir, state)
    const sizes = new Map<string, number>()
    for (const f of files) {
      const st = await stat(f).catch(() => null)
      sizes.set(f, st?.size ?? 0)
    }
    return {
      wireSizes: sizes,
      stateUpdatedAt: typeof state?.updatedAt === 'number' ? state.updatedAt : 0,
      lastTurnReason: typeof state?.lastTurnReason === 'string' ? state.lastTurnReason : null,
    }
  }

  /** 终态证据：wire 新增 turn.ended 行 或 state.json updatedAt 推进且 lastTurnReason 非空。 */
  async function readTerminalEvidence(sessionDir: string, baseline: TerminalBaseline): Promise<string | null> {
    const { state } = await readKimiState(sessionDir)
    if (
      state !== null &&
      typeof state['updatedAt'] === 'number' &&
      state['updatedAt'] > baseline.stateUpdatedAt &&
      typeof state['lastTurnReason'] === 'string' &&
      (state['lastTurnReason'] as string).length > 0
    ) {
      return `state.json lastTurnReason=${state['lastTurnReason'] as string}`
    }
    const files = await wireFilesOf(sessionDir, state)
    for (const f of files) {
      const baselineSize = baseline.wireSizes.get(f) ?? 0
      const st = await stat(f).catch(() => null)
      if (st === null || st.size <= baselineSize) continue
      const tail = await readTailForTurnEnded(f, baselineSize)
      if (tail) return 'wire.jsonl turn.ended appended'
    }
    return null
  }

  /** 只读增量扫描 baseline 之后的行，命中 turn.ended 即为终态证据。 */
  async function readTailForTurnEnded(file: string, fromByte: number): Promise<boolean> {
    let handle
    try {
      handle = await open(file, 'r')
    } catch {
      return false
    }
    try {
      const size = (await handle.stat()).size
      const want = Math.min(size - fromByte, 4 * 1024 * 1024)
      if (want <= 0) return false
      const buf = Buffer.alloc(want)
      const { bytesRead } = await handle.read(buf, 0, want, fromByte)
      const text = buf.subarray(0, bytesRead).toString('utf8')
      for (const rawLine of text.split('\n')) {
        const line = rawLine.trim()
        if (line.length === 0) continue
        try {
          const obj = JSON.parse(line) as Record<string, unknown>
          if (obj['type'] === 'turn.ended') return true
        } catch {
          continue // 不完整尾行/损坏行：下轮再核
        }
      }
      return false
    } catch {
      return false
    } finally {
      await handle.close().catch(() => {})
    }
  }

  // -------------------------------------------------------------------------
  // 九方法 8：startMonitor（fs.watch 优先 + 轮询回落 + 5 次失败降级）
  // -------------------------------------------------------------------------

  function startMonitor(sink: EventSink): MonitorHandle {
    let loopDone: Promise<void> | null = null
    const task = startMonitorTask(
      'kimi',
      (token) => {
        loopDone = runMonitorLoop(sink, token)
        return loopDone
      },
      'kimi wire.jsonl monitor',
    )
    return {
      providerId: 'kimi',
      async stop(): Promise<void> {
        task.cancel()
        if (loopDone !== null) await loopDone.catch(() => {})
      },
    }
  }

  async function runMonitorLoop(sink: EventSink, token: MonitorCancelToken): Promise<void> {
    const tracked = new Map<string, TrackedWire>()
    /** 会话 → 未闭环审批 id 集（evalKimiWireLine 跨行记忆）。 */
    const pendingApprovals = new Map<string, Set<string>>()
    /** 会话 → 最近一次判定状态（变化沿才上抛）。 */
    const lastStatus = new Map<string, SessionStatus | null>()
    const tracker = new ReadFailureTracker()
    let degraded = false
    let pollMs = FAST_POLL_MS
    let dirty = true
    let watcher: FSWatcher | null = null
    try {
      watcher = watch(kimiHome, { recursive: true }, () => {
        dirty = true
      })
      watcher.on('error', () => {
        watcher?.close()
        watcher = null
        dirty = true
      })
    } catch {
      watcher = null // fs.watch 不可用 → 纯轮询回落
    }

    try {
      while (!token.cancelled) {
        if (dirty) {
          dirty = false
          const failDetail = await discoverWires(sink, tracked, pendingApprovals, lastStatus)
          if (failDetail !== null) {
            if (tracker.recordFailure()) {
              degraded = true
              pollMs = SLOW_POLL_MS
              sink.onProviderDegraded?.('kimi', `kimi index reads failing (${failDetail.slice(0, 160)})`)
            }
          } else {
            tracker.recordSuccess()
            if (degraded) {
              degraded = false
              pollMs = FAST_POLL_MS
              sink.onProviderRecovered?.('kimi')
            }
          }
        }
        let readFailDetail: string | null = null
        for (const t of tracked.values()) {
          if (token.cancelled) break
          const result = await t.reader.read()
          if (!result.readable) {
            readFailDetail = result.error ?? 'wire unreadable'
            continue
          }
          t.parseFailures += result.parseFailures
          stats.wireParseFailures += result.parseFailures
          applyWireLines(t, result.lines, result.parsed, pendingApprovals, lastStatus, sink)
        }
        if (readFailDetail !== null) {
          if (tracker.recordFailure()) {
            degraded = true
            pollMs = SLOW_POLL_MS
            sink.onProviderDegraded?.('kimi', `wire reads failing (${readFailDetail.slice(0, 160)})`)
          }
        } else if (tracked.size > 0 && tracker.recordSuccess() && degraded) {
          degraded = false
          pollMs = FAST_POLL_MS
          sink.onProviderRecovered?.('kimi')
        }
        await cancellableSleep(pollMs, token)
        if (watcher === null) dirty = true
      }
    } finally {
      try {
        watcher?.close()
      } catch {
        /* 已关闭 */
      }
    }
  }

  /** 索引 → 新 wire 文件发现（墓碑/目录消失 → 停止跟踪）。返回失败详情或 null。 */
  async function discoverWires(
    sink: EventSink,
    tracked: Map<string, TrackedWire>,
    pendingApprovals: Map<string, Set<string>>,
    lastStatus: Map<string, SessionStatus | null>,
  ): Promise<string | null> {
    let index: KimiIndexParseResult
    try {
      index = await parseKimiSessionIndex(indexPath())
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
    stats.indexParseFailures += index.parseFailures
    const seen = new Set<string>()
    for (const entry of index.entries) {
      const { state, parseFailed } = await readKimiState(entry.sessionDir)
      if (parseFailed) stats.indexParseFailures += 1
      const files = await wireFilesOf(entry.sessionDir, state)
      for (const file of files) {
        const st = await stat(file).catch(() => null)
        if (st === null || !st.isFile()) continue
        seen.add(file)
        if (tracked.has(file)) continue
        tracked.set(file, { sessionId: entry.sessionId, reader: new IncrementalJsonlReader(file), parseFailures: 0 })
        if (!pendingApprovals.has(entry.sessionId)) pendingApprovals.set(entry.sessionId, new Set())
        if (!lastStatus.has(entry.sessionId)) lastStatus.set(entry.sessionId, null)
        const createdAt = typeof state?.createdAt === 'number' ? Math.floor(state.createdAt / 1000) : undefined
        const updatedAt = typeof state?.updatedAt === 'number' ? Math.floor(state.updatedAt / 1000) : undefined
        const dirStat = await stat(entry.sessionDir).catch(() => null)
        const activities = [updatedAt, dirStat !== null ? Math.floor(dirStat.mtimeMs / 1000) : undefined].filter(
          (v): v is number => v !== undefined,
        )
        sink.onSessionDiscovered?.('kimi', {
          nativeId: entry.sessionId,
          ...(typeof state?.cwd === 'string' && state.cwd.length > 0
            ? { workdir: state.cwd }
            : entry.workDir !== undefined
              ? { workdir: entry.workDir }
              : {}),
          ...(createdAt !== undefined ? { startedAt: createdAt } : {}),
          ...(activities.length > 0 ? { lastActivityAt: Math.max(...activities) } : {}),
        })
      }
    }
    for (const file of [...tracked.keys()]) if (!seen.has(file)) tracked.delete(file)
    return null
  }

  function applyWireLines(
    t: TrackedWire,
    lines: Array<{ byteOffset: number; text: string }>,
    parsed: unknown[],
    pendingApprovals: Map<string, Set<string>>,
    lastStatus: Map<string, SessionStatus | null>,
    sink: EventSink,
  ): void {
    let approvals = pendingApprovals.get(t.sessionId)
    if (approvals === undefined) {
      approvals = new Set()
      pendingApprovals.set(t.sessionId, approvals)
    }
    const ref: SessionRef = { providerId: 'kimi', nativeId: t.sessionId }
    for (let i = 0; i < lines.length; i++) {
      const obj = parsed[i]
      if (obj === null || typeof obj !== 'object') continue // parseFailures 已计数
      const o = obj as Record<string, unknown>
      const msg = projectKimiWireMessage(o, lines[i].byteOffset, messageTextCap)
      if (msg !== null) {
        sink.onMessageAppended?.(ref, { ...msg, sourceRef: `${t.sessionId}#offset=${lines[i].byteOffset}` })
        continue
      }
      const next = evalKimiWireLine(o, approvals)
      if (next === null || next === lastStatus.get(t.sessionId)) continue
      const from = lastStatus.get(t.sessionId) ?? undefined
      lastStatus.set(t.sessionId, next)
      sink.onStatusChanged?.(ref, from, next)
    }
  }

  // -------------------------------------------------------------------------
  // 九方法 9：dispose + 诊断投影
  // -------------------------------------------------------------------------

  async function dispose(): Promise<void> {
    /* provider 无常驻资源（监控任务由 monitorRegistry 统一取消） */
  }

  function describeDiagnostics(): ProviderDiagnosticsInfo {
    const gate = options.managedGate?.()
    const gateEnabled = gate !== undefined && gate.enabled
    const managedConfigured = options.spawnArgs !== undefined
    return {
      dataSource: {
        kind: 'kimi-wire-jsonl',
        readable: true, // 可读性按轮次实测（失败计数走 ReadFailureTracker）
        ...(stats.indexParseFailures > 0 || stats.wireParseFailures > 0
          ? { detail: `index parse failures: ${stats.indexParseFailures}, wire parse failures: ${stats.wireParseFailures}` }
          : {}),
      },
      control: {
        ...(managedConfigured ? { stdin: true } : {}),
        // KM 批两态如实：门开=一次性 prompt 通道；门停/未注入=既有文案逐字节不变
        note: gateEnabled
          ? `managed one-shot prompt channel enabled (${KIMI_MANAGED_ENABLED_SETTING_KEY}=1, real inference authorized); last reply verdict: ${lastReplyVerdict ?? 'none yet'}`
          : managedConfigured
            ? `managed stdin channel configured; last reply verdict: ${lastReplyVerdict ?? 'none yet'}`
            : 'managed stdin channel not configured (real kimi launch would write ~/.kimi-code; red line) — observed only',
      },
    }
  }

  return {
    id: 'kimi',
    probeHealth,
    listSessions,
    readMessages,
    getCapabilities,
    sendReply,
    pause: () => pause(),
    resume: () => resume(),
    startMonitor,
    dispose,
    describeDiagnostics,
  }
}
