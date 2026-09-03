/**
 * claudeProvider.ts — Claude Code 接入适配器（docs/12 §8.2）。
 *
 * 数据源（AC0 实测事实 + 本批真机只读复核，Claude Code 2.1.150）：
 * - exe：npm 全局 claude.cmd（Node 直接 spawn .cmd 会 EINVAL → 复用
 *   versionCenter/npm.ts 的 cmd.exe /d /s /c 参数数组通道，约束 #7/#8）；
 * - `~/.claude/projects/<编码目录>/<sessionId>.jsonl`：转录行类型实测 =
 *   user | assistant | system(subtype: compact_boundary|turn_duration|api_error) |
 *   last-prompt | attachment | queue-operation | ai-title | file-history-* |
 *   mode | permission-mode；user/assistant 行携带 uuid/timestamp/cwd/sessionId，
 *   assistant message.content = [{type: text|thinking|tool_use}]；
 *   **实测无任何等待输入/审批/会话终态片段** → observed 通道状态判定只能 unknown
 *   （判定不了 → unknown，绝不猜）；**approval_required 判定源 = hooks 审批事件**
 *   （docs/12 §5）；
 * - `~/.claude/settings.json`：真实用户配置（env.ANTHROPIC_BASE_URL=ApiHub 写入目标、
 *   permissions.allow；当前无 hooks 键——绝不可损坏）。
 *
 * hooks 合并写入（供 AC5 UI 显式调用；AC3 绝不在真机自动写入）：
 *   读 → 只合并 hooks 子键（保留其余全部键）→ 时间戳备份 → tmp+rename 原子写 →
 *   返回备份路径；恢复函数从备份逐字节还原；hook 命令内嵌本地随机 secret；
 *   写前重读整文件（不使用陈旧缓存）。
 *
 * 独立内部回环 listener：node:http 绑定 127.0.0.1 随机端口，只收 POST hooks 回调；
 * secret 不匹配 → 静默丢弃 + 计数；回调事件 → waiting_input/approval_required 等
 * 状态判定经 sink 上抛（L3 落库）；随 provider 监控启停，与 gateway_enabled 无关。
 *
 * 红线：`~/.claude/**` 除 hooks 显式写入动作外全程只读；禁 GUI 自动化。
 * electron-free；一切系统命令经 core/exec（约束 #7/#8）。
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { watch, statSync, type FSWatcher } from 'node:fs'
import { readdir, readFile, stat, writeFile, rename, mkdir, open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AgentCapabilitySet, SessionStatus } from '../../../../shared/types.ts'
import { run } from '../../../core/exec.ts'
import { runViaCmd } from '../../versionCenter/npm.ts'
import { ServiceError, nowSec } from '../../internal.ts'
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

export interface ClaudeProviderOptions {
  /** `~/.claude`（默认真实 home；smoke 全部隔离夹具）。 */
  claudeHome?: string
  /** claude 命令路径（默认 PATH/npm 全局解析；smoke 注入夹具）。 */
  claudeCmd?: string
  /** `--version` 超时（npm shim 启动慢，显式放宽）。 */
  versionTimeoutMs?: number
  /** 回环 listener 端口（默认 0 = 随机）。 */
  hooksPort?: number
  /** hooks secret（默认实例期生成一次；writeClaudeHooks 可显式传入）。 */
  hooksSecret?: string
  /** 转录快照扫描的文件数上限。 */
  scanFileLimit?: number
  /** 消息投影单条字符上限。 */
  messageTextCap?: number
}

const DEFAULT_VERSION_TIMEOUT_MS = 90_000
const DEFAULT_SCAN_FILE_LIMIT = 200
const DEFAULT_MESSAGE_TEXT_CAP = 4_000
/** 回环请求体上限（hook 载荷很小；超限直接 413）。 */
const HOOK_BODY_LIMIT_BYTES = 256 * 1024
/** hooks 回调路径（固定；防扫描面）。 */
export const CLAUDE_HOOKS_PATH = '/hooks/claude'
/** DevHub hooks 条目标记头（写入的 hook 命令内含；幂等判定依据）。 */
export const CLAUDE_HOOKS_MARKER_HEADER = 'X-DevHub-Hooks: 1'
/** 默认注册的 hooks 事件（docs/12 §8.2：审批/输入等待/回合结束的判定源）。 */
export const CLAUDE_HOOK_EVENTS = ['UserPromptSubmit', 'Notification', 'Stop', 'SessionStart', 'SessionEnd'] as const
/** 转录扫描缓存毫秒。 */
const SCAN_CACHE_MS = 3_000

/**
 * hook 回调 → 状态判定映射（docs/12 §5：hooks 事件 > 转录推断；审批判定源 =
 * Notification 中 permission/approval 形态）。返回 null = 无状态证据（忽略计数）。
 */
export function evalClaudeHookEvent(
  eventName: string,
  message: string | undefined,
): { status: SessionStatus; detail: string } | null {
  const name = eventName.trim()
  if (name.length === 0) return null
  if (name === 'Notification') {
    const permissionish = /permission|approval|approve|authorize/i.test(message ?? '')
    return permissionish
      ? { status: 'approval_required', detail: 'hook: Notification (permission/approval)' }
      : { status: 'waiting_input', detail: 'hook: Notification' }
  }
  if (name === 'UserPromptSubmit' || name === 'SessionStart') return { status: 'running', detail: `hook: ${name}` }
  if (name === 'Stop') return { status: 'waiting_input', detail: 'hook: Stop (agent turn finished, awaiting user input)' }
  if (name === 'SessionEnd') return { status: 'stopped', detail: 'hook: SessionEnd' }
  return null // 未知事件：容忍丢弃（由调用方计数）
}

/** hook 命令模板：静态结构 + 自生成值（hex secret / 校验过的整数端口，无用户数据）。 */
export function buildClaudeHookCommand(port: number, secret: string): string {
  return (
    `curl.exe -s -o NUL -X POST ` +
    `-H "Content-Type: application/json" ` +
    `-H "${CLAUDE_HOOKS_MARKER_HEADER}" ` +
    `-H "X-DevHub-Secret: ${secret}" ` +
    `--data-binary @- http://127.0.0.1:${port}${CLAUDE_HOOKS_PATH}`
  )
}

// ---------------------------------------------------------------------------
// hooks 合并写入 / 恢复（供 AC5 UI 显式调用；AC3 绝不在真机自动写入）
// ---------------------------------------------------------------------------

export interface HooksWriteResult {
  backupPath: string
  secret: string
  url: string
  eventsWritten: string[]
  alreadyRegistered: boolean
}

function settingsPathOf(claudeHome: string): string {
  return join(claudeHome, 'settings.json')
}

function backupStamp(d = new Date()): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

async function atomicWriteFile(path: string, data: string | Buffer): Promise<void> {
  const tmp = `${path}.tmp-${randomBytes(6).toString('hex')}`
  await writeFile(tmp, data)
  await rename(tmp, path)
}

/** 备份路径防同秒碰撞：已存在时追加 -2/-3…（保留 docs/12 §8.2 的 .bak-<stamp> 主形态）。 */
async function uniqueBackupPath(settingsPath: string, stamp: string): Promise<string> {
  let candidate = `${settingsPath}.bak-${stamp}`
  let n = 2
  while (existsBackup(candidate)) {
    candidate = `${settingsPath}.bak-${stamp}-${n}`
    n += 1
  }
  return candidate
}

function existsBackup(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

interface HooksReadState {
  raw: string
  settings: Record<string, unknown>
  devhubEntries: number
}

/** 读 + 解析 settings.json（只读；损坏 → 结构化错误，绝不覆写）。 */
async function readSettingsState(claudeHome: string): Promise<HooksReadState | null> {
  let raw: string
  try {
    raw = await readFile(settingsPathOf(claudeHome), 'utf8')
  } catch {
    return null // 无 settings.json：写入时从空对象起步
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ServiceError('DB_ERROR', 'claude settings.json is not a JSON object; refusing to touch it')
    }
    const hooks = (parsed as { hooks?: unknown }).hooks
    let devhubEntries = 0
    if (hooks !== null && typeof hooks === 'object' && !Array.isArray(hooks)) {
      const rawStr = JSON.stringify(hooks)
      devhubEntries = rawStr.split(CLAUDE_HOOKS_MARKER_HEADER).length - 1
    }
    return { raw, settings: parsed as Record<string, unknown>, devhubEntries }
  } catch (err) {
    if (err instanceof ServiceError) throw err
    throw new ServiceError('DB_ERROR', 'claude settings.json is not valid JSON; refusing to touch it (manual fix required)')
  }
}

/**
 * hooks 合并写入（docs/12 §8.2）：只合并 hooks 子键，env 与 permissions 等其余键
 * 逐字节保留；时间戳备份 `settings.json.bak-<yyyyMMdd-HHmmss>`；tmp+rename 原子写；
 * 写前重读整文件（不使用陈旧缓存）。幂等：已存在 DevHub 条目（marker 头命中）不重复追加。
 */
export async function writeClaudeHooks(options: {
  claudeHome?: string
  port: number
  secret: string
  events?: readonly string[]
}): Promise<HooksWriteResult> {
  const claudeHome = options.claudeHome ?? join(homedir(), '.claude')
  const { port, secret } = options
  const events = options.events ?? CLAUDE_HOOK_EVENTS
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ServiceError('BAD_PAYLOAD', `hook port must be an integer within 0-65535 (got ${String(port)})`)
  }
  if (!/^[0-9a-f]{32,128}$/i.test(secret)) {
    throw new ServiceError('BAD_PAYLOAD', 'hook secret must be hex (32-128 chars)')
  }
  const state = await readSettingsState(claudeHome)
  const command = buildClaudeHookCommand(port, secret)
  const base: Record<string, unknown> = state !== null ? JSON.parse(state.raw) : {}
  const existingHooks =
    base['hooks'] !== null && typeof base['hooks'] === 'object' && !Array.isArray(base['hooks'])
      ? (base['hooks'] as Record<string, unknown>)
      : {}
  const eventsWritten: string[] = []
  const nextHooks: Record<string, unknown> = { ...existingHooks }
  for (const event of events) {
    const existingList = Array.isArray(existingHooks[event]) ? (existingHooks[event] as unknown[]) : []
    const already = existingList.some((entry) => JSON.stringify(entry).includes(CLAUDE_HOOKS_MARKER_HEADER))
    if (already) continue // 幂等：DevHub 条目已在（不动用户既有条目）
    nextHooks[event] = [...existingList, { hooks: [{ type: 'command', command }] }]
    eventsWritten.push(event)
  }
  if (eventsWritten.length === 0) {
    // 幂等零写：无新条目时不落备份、不重写文件（同秒重复调用绝不覆盖更早的备份）
    return {
      backupPath: '',
      secret,
      url: `http://127.0.0.1:${port}${CLAUDE_HOOKS_PATH}`,
      eventsWritten,
      alreadyRegistered: true,
    }
  }
  // 备份现有文件（存在才备份；不存在则本次为首建）
  const backupPath =
    state !== null ? await uniqueBackupPath(settingsPathOf(claudeHome), backupStamp()) : ''
  if (state !== null) {
    await writeFile(backupPath, state.raw, 'utf8')
  }
  const next: Record<string, unknown> = { ...base, hooks: nextHooks } // 其余键原样保留（引用透传）
  await mkdir(claudeHome, { recursive: true })
  await atomicWriteFile(settingsPathOf(claudeHome), `${JSON.stringify(next, null, 2)}\n`)
  return {
    backupPath,
    secret,
    url: `http://127.0.0.1:${port}${CLAUDE_HOOKS_PATH}`,
    eventsWritten,
    alreadyRegistered: false,
  }
}

/** 从备份还原 settings.json（逐字节还原；备份不存在 → NOT_FOUND）。 */
export async function restoreClaudeHooks(backupPath: string, claudeHome?: string): Promise<{ restored: boolean }> {
  let raw: Buffer
  try {
    raw = await readFile(backupPath)
  } catch {
    throw new ServiceError('NOT_FOUND', `hooks backup not found: ${backupPath}`)
  }
  const home = claudeHome ?? join(homedir(), '.claude')
  await atomicWriteFile(settingsPathOf(home), raw)
  return { restored: true }
}

// ---------------------------------------------------------------------------
// 独立内部回环 listener（node:http，127.0.0.1 随机端口；随监控启停）
// ---------------------------------------------------------------------------

export interface HookCallbackEvent {
  eventName: string
  message?: string
  sessionId?: string
  cwd?: string
  raw: Record<string, unknown>
}

export interface ClaudeHooksListener {
  port: number
  secret: string
  acceptedCount: number
  rejectedCount: number
  close(): Promise<void>
}

function secretMatches(expected: string, got: string | string[] | undefined): boolean {
  const value = Array.isArray(got) ? got[0] : got
  if (value === undefined) return false
  const a = createHash('sha256').update(expected, 'utf8').digest()
  const b = createHash('sha256').update(value, 'utf8').digest()
  return timingSafeEqual(a, b)
}

export async function startClaudeHooksListener(options: {
  port?: number
  secret: string
  onEvent: (event: HookCallbackEvent) => void
}): Promise<ClaudeHooksListener> {
  const secret = options.secret
  const counters = { accepted: 0, rejected: 0 }
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const finish = (code: number): void => {
      res.statusCode = code
      res.end()
    }
    if (req.method !== 'POST' || !(req.url ?? '').startsWith(CLAUDE_HOOKS_PATH)) {
      finish(404)
      return
    }
    if (!secretMatches(secret, req.headers['x-devhub-secret'])) {
      counters.rejected += 1 // secret 不匹配 → 静默丢弃 + 计数（防本机其他进程伪造回调）
      finish(403)
      return
    }
    const chunks: Buffer[] = []
    let total = 0
    let aborted = false
    req.on('data', (c: Buffer) => {
      total += c.length
      if (total > HOOK_BODY_LIMIT_BYTES) {
        aborted = true
        finish(413)
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (aborted) return
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          counters.rejected += 1
          finish(400)
          return
        }
        const body = parsed as Record<string, unknown>
        counters.accepted += 1
        options.onEvent({
          eventName: typeof body['hook_event_name'] === 'string' ? body['hook_event_name'] : String(body['event'] ?? ''),
          message: typeof body['message'] === 'string' ? body['message'] : undefined,
          sessionId: typeof body['session_id'] === 'string' ? body['session_id'] : undefined,
          cwd: typeof body['cwd'] === 'string' ? body['cwd'] : undefined,
          raw: body,
        })
        finish(202)
      } catch {
        counters.rejected += 1
        finish(400)
      }
    })
    req.on('error', () => finish(400))
  })
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      const addr = server.address()
      resolve(typeof addr === 'object' && addr !== null ? addr.port : (options.port ?? 0))
    })
  })
  return {
    port,
    secret,
    get acceptedCount(): number {
      return counters.accepted
    },
    get rejectedCount(): number {
      return counters.rejected
    },
    close(): Promise<void> {
      return new Promise((resolve) => {
        server.close(() => resolve())
        // 既有 keep-alive 连接不阻塞收尾
        server.closeAllConnections?.()
      })
    },
  }
}

// ---------------------------------------------------------------------------
// Provider（docs/12 §4 九方法）
// ---------------------------------------------------------------------------

interface TrackedTranscript {
  nativeId: string
  reader: IncrementalJsonlReader
  cwd?: string
  title?: string
  startedAtSec?: number
  lastActivitySec?: number
}

export function createClaudeProvider(options: ClaudeProviderOptions = {}): AgentProvider {
  const claudeHome = options.claudeHome ?? join(homedir(), '.claude')
  const versionTimeoutMs = options.versionTimeoutMs ?? DEFAULT_VERSION_TIMEOUT_MS
  const scanFileLimit = options.scanFileLimit ?? DEFAULT_SCAN_FILE_LIMIT
  const messageTextCap = options.messageTextCap ?? DEFAULT_MESSAGE_TEXT_CAP
  const hooksSecret = options.hooksSecret ?? randomBytes(24).toString('hex')

  let claudeCmdCache: string | null | undefined
  let lastHookEvent: { at: number; accepted: number; rejected: number } | null = null

  function projectsRoot(): string {
    return join(claudeHome, 'projects')
  }

  async function resolveClaudeCmd(): Promise<string | null> {
    if (options.claudeCmd !== undefined) return options.claudeCmd
    if (claudeCmdCache !== undefined) return claudeCmdCache
    const r = await run('where.exe', ['claude.cmd'], { timeoutMs: 15_000 })
    let resolved: string | null = null
    if (r.code === 0 && !r.timedOut) {
      resolved = r.stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? null
    }
    if (resolved === null) {
      const candidate = join(process.env['APPDATA'] ?? '', 'npm', 'claude.cmd')
      try {
        const st = await stat(candidate)
        if (st.isFile()) resolved = candidate
      } catch {
        resolved = null
      }
    }
    claudeCmdCache = resolved
    return resolved
  }

  async function probeHealth(): Promise<ProviderHealth> {
    const cmd = await resolveClaudeCmd()
    if (cmd === null) {
      return { installed: false, health: 'unavailable', healthDetail: 'claude.cmd not found (PATH / %APPDATA%\\npm)' }
    }
    const r = await runViaCmd([cmd, '--version'], versionTimeoutMs)
    if (r.code === 0 && !r.timedOut) {
      const version = /(\d+\.\d+\.\d+)/.exec(r.stdout)?.[1]
      return {
        installed: true,
        ...(version !== undefined ? { version } : {}),
        exePath: cmd,
        health: 'ok',
        ...(version === undefined ? { healthDetail: `version not parseable from: ${r.stdout.trim().slice(0, 80)}` } : {}),
      }
    }
    return {
      installed: true,
      exePath: cmd,
      health: 'degraded',
      healthDetail: `claude --version failed: ${(r.stderr || r.stdout || `exit ${r.code}`).slice(0, 200)}`,
    }
  }

  // 会话发现：projects/*/*.jsonl；native_id = 行内 sessionId（缺省文件名 stem）；
  // cwd 以行内 cwd 字段为权威（目录名编码有歧义——破折号替换空格，绝不反解）。
  let scanCache: { at: number; files: Array<{ file: string; mtimeMs: number }> } | null = null
  async function scanTranscripts(): Promise<Array<{ file: string; mtimeMs: number }>> {
    if (scanCache !== null && Date.now() - scanCache.at < SCAN_CACHE_MS) return scanCache.files
    const files: Array<{ file: string; mtimeMs: number }> = []
    let projectDirs: string[] = []
    try {
      projectDirs = (await readdir(projectsRoot(), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
    } catch {
      scanCache = { at: Date.now(), files: [] }
      return []
    }
    for (const dir of projectDirs) {
      const dirPath = join(projectsRoot(), dir)
      const entries = await readdir(dirPath, { withFileTypes: true }).catch(() => [])
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith('.jsonl')) {
          const file = join(dirPath, e.name)
          const st = await stat(file).catch(() => null)
          if (st !== null) files.push({ file, mtimeMs: st.mtimeMs })
        }
      }
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs)
    const capped = files.slice(0, scanFileLimit)
    scanCache = { at: Date.now(), files: capped }
    return capped
  }

  interface TranscriptProbe {
    nativeId: string
    cwd?: string
    title?: string
    startedAtSec?: number
  }

  /** 轻探针：读文件（>4MB 截前 256KB）找 sessionId/cwd/时间戳/标题。 */
  async function probeTranscript(file: string): Promise<TranscriptProbe> {
    const probe: TranscriptProbe = { nativeId: '' }
    try {
      let raw: string
      const st = await stat(file)
      if (st.size > 4 * 1024 * 1024) {
        const handle = await open(file, 'r')
        try {
          const buf = Buffer.alloc(256 * 1024)
          const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
          raw = buf.subarray(0, bytesRead).toString('utf8')
        } finally {
          await handle.close().catch(() => {})
        }
      } else {
        raw = await readFile(file, 'utf8')
      }
      for (const line of raw.split('\n')) {
        const text = line.trim()
        if (text.length === 0) continue
        try {
          const o = JSON.parse(text) as Record<string, unknown>
          if (probe.nativeId.length === 0 && typeof o['sessionId'] === 'string') probe.nativeId = o['sessionId']
          if (probe.cwd === undefined && typeof o['cwd'] === 'string') probe.cwd = o['cwd']
          if (probe.startedAtSec === undefined && typeof o['timestamp'] === 'string') {
            const ts = Date.parse(o['timestamp'])
            if (Number.isFinite(ts)) probe.startedAtSec = Math.floor(ts / 1000)
          }
          if (o['type'] === 'ai-title' && typeof o['aiTitle'] === 'string' && probe.title === undefined) {
            probe.title = o['aiTitle']
          }
          if (probe.nativeId.length > 0 && probe.cwd !== undefined && probe.startedAtSec !== undefined && probe.title !== undefined) break
        } catch {
          continue // 损坏行跳过（不中断）
        }
      }
    } catch {
      /* 读失败 → 文件名 stem 兜底 */
    }
    if (probe.nativeId.length === 0) {
      const stem = file.split(/[\\/]/).pop() ?? file
      probe.nativeId = stem.replace(/\.jsonl$/i, '')
    }
    return probe
  }

  async function listSessions(): Promise<SessionSnapshot[]> {
    const files = await scanTranscripts()
    const snapshots: SessionSnapshot[] = []
    for (const f of files) {
      const probe = await probeTranscript(f.file)
      snapshots.push({
        nativeId: probe.nativeId,
        ...(probe.cwd !== undefined ? { workdir: probe.cwd } : {}),
        ...(probe.title !== undefined ? { title: probe.title } : {}),
        ...(probe.startedAtSec !== undefined ? { startedAt: probe.startedAtSec } : {}),
        lastActivityAt: Math.floor(f.mtimeMs / 1000),
      })
    }
    return snapshots
  }

  function projectTranscriptLine(o: Record<string, unknown>, file: string, byteOffset: number): RedactedMessage | null {
    const type = o['type']
    if (type !== 'user' && type !== 'assistant') return null
    const message = o['message']
    if (message === null || typeof message !== 'object') return null
    const m = message as { role?: unknown; content?: unknown }
    let text = ''
    let role = type === 'user' ? 'user' : 'assistant'
    if (typeof m.content === 'string') {
      text = m.content
    } else if (Array.isArray(m.content)) {
      const parts: string[] = []
      let toolResult = false
      for (const item of m.content) {
        if (item === null || typeof item !== 'object') continue
        const c = item as { type?: unknown; text?: unknown; name?: unknown }
        if (c.type === 'text' && typeof c.text === 'string') parts.push(c.text)
        else if (c.type === 'tool_result') toolResult = true
        else if (c.type === 'tool_use' && typeof c.name === 'string') parts.push(`[tool_use ${c.name}]`)
      }
      text = parts.join('\n')
      if (text.length === 0 && toolResult && type === 'user') {
        role = 'tool'
        text = '[tool_result]'
      }
    }
    if (text.length === 0) return null
    const uuid = typeof o['uuid'] === 'string' ? o['uuid'] : `line:${byteOffset}`
    const ts = typeof o['timestamp'] === 'string' ? Date.parse(o['timestamp']) : Number.NaN
    return {
      role,
      contentRedacted: redactText(text).slice(0, messageTextCap),
      nativeMsgId: uuid,
      ...(Number.isFinite(ts) ? { occurredAt: Math.floor(ts / 1000) } : {}),
      sourceRef: `${file}#offset=${byteOffset}`,
    }
  }

  async function readMessages(ref: SessionRef, after?: string): Promise<MessagePage> {
    const files = await scanTranscripts()
    let target: string | null = null
    for (const f of files) {
      const probe = await probeTranscript(f.file)
      if (probe.nativeId === ref.nativeId) {
        target = f.file
        break
      }
    }
    if (target === null) return { messages: [], cursor: after ?? '0', hasMore: false }
    const startOffset = after !== undefined ? Number.parseInt(after, 10) : 0
    const reader = new IncrementalJsonlReader(target, Number.isSafeInteger(startOffset) && startOffset > 0 ? startOffset : 0)
    const result = await reader.read()
    if (!result.readable) return { messages: [], cursor: after ?? '0', hasMore: false }
    const messages: RedactedMessage[] = []
    for (let i = 0; i < result.lines.length; i++) {
      const parsed = result.parsed[i]
      if (parsed === null || typeof parsed !== 'object') continue
      const msg = projectTranscriptLine(parsed as Record<string, unknown>, target, result.lines[i].byteOffset)
      if (msg !== null) messages.push(msg)
    }
    return { messages, cursor: String(reader.currentOffset), hasMore: false }
  }

  async function readHooksRegistration(): Promise<{ registered: boolean; entries: number }> {
    try {
      const state = await readSettingsState(claudeHome)
      if (state === null) return { registered: false, entries: 0 }
      return { registered: state.devhubEntries > 0, entries: state.devhubEntries }
    } catch {
      return { registered: false, entries: 0 } // settings 不可读 → 观察能力（绝不因诊断面报错）
    }
  }

  async function getCapabilities(_ref: SessionRef): Promise<AgentCapabilitySet> {
    // 能力验证门（docs/12 §5 强制）：只授予「此刻真实验证存在」的能力。
    // attached 通道的 reply 注入在 AC3 无可验证执行路径（hooks 无输入注入 API）→
    // granted 收缩为空集；observed 转录通道无任何控制能力。
    const hooks = await readHooksRegistration()
    const now = nowSec()
    if (hooks.registered) {
      return {
        mode: 'attached',
        granted: [],
        verifiedAt: now,
        evidence: `hooks registered (${hooks.entries} DevHub entries; reply injection not verified in AC3)`,
      }
    }
    return {
      mode: 'observed',
      granted: [],
      verifiedAt: now,
      evidence: 'read-only transcript source (no DevHub hooks registered)',
    }
  }

  function unsupported(action: 'reply' | 'pause' | 'resume'): CommandOutcome {
    return {
      ok: false,
      status: 'unsupported',
      errorCode: action === 'reply' ? 'AGENT_CAPABILITY_MISSING' : 'COMMAND_NOT_EXECUTABLE',
      detail:
        action === 'reply'
          ? 'claude reply injection is not verified (hooks carry no input-injection API in 2.1.150)'
          : 'claude has no pause/resume input channel (observed/attached without verified control)',
    }
  }

  // ---------------------------------------------------------------------------
  // startMonitor：转录 watcher + hooks 回环 listener（随监控启停）
  // ---------------------------------------------------------------------------

  function startMonitor(sink: EventSink): MonitorHandle {
    let loopDone: Promise<void> | null = null
    const task = startMonitorTask(
      'claude-code',
      (token) => {
        loopDone = runMonitorLoop(sink, token)
        return loopDone
      },
      'claude transcript monitor + hooks loopback',
    )
    return {
      providerId: 'claude-code',
      async stop(): Promise<void> {
        task.cancel()
        if (loopDone !== null) await loopDone.catch(() => {})
      },
    }
  }

  async function runMonitorLoop(sink: EventSink, token: MonitorCancelToken): Promise<void> {
    const tracked = new Map<string, TrackedTranscript>()
    const tracker = new ReadFailureTracker()
    let degraded = false
    let pollMs = FAST_POLL_MS
    let dirty = true
    let watcher: FSWatcher | null = null
    try {
      watcher = watch(projectsRoot(), { recursive: true }, () => {
        dirty = true
      })
      watcher.on('error', () => {
        watcher?.close()
        watcher = null
        dirty = true
      })
    } catch {
      watcher = null
    }

    // 独立内部回环 listener（docs/12 §8.2）：随 provider 监控启停，与 gateway_enabled 无关
    const listenerRef = await startClaudeHooksListener({
      port: options.hooksPort ?? 0,
      secret: hooksSecret,
      onEvent: (event) => {
        lastHookEvent = {
          at: nowSec(),
          accepted: listenerRef?.acceptedCount ?? 0,
          rejected: listenerRef?.rejectedCount ?? 0,
        }
        const verdict = evalClaudeHookEvent(event.eventName, event.message)
        if (verdict === null) return // 未知事件容忍丢弃（映射表之外不计状态）
        const nativeId = event.sessionId ?? 'unknown-session'
        const ref: SessionRef = { providerId: 'claude-code', nativeId }
        sink.onStatusChanged?.(ref, undefined, verdict.status, verdict.detail)
      },
    }).catch(() => null)

    try {
      while (!token.cancelled) {
        if (dirty) {
          dirty = false
          await discoverTranscripts(sink, tracked)
        }
        let failDetail: string | null = null
        for (const t of tracked.values()) {
          if (token.cancelled) break
          const result = await t.reader.read()
          if (!result.readable) {
            failDetail = result.error ?? 'transcript unreadable'
            continue
          }
          applyTranscriptLines(t, result.lines, result.parsed, sink)
        }
        if (failDetail !== null) {
          if (tracker.recordFailure()) {
            degraded = true
            pollMs = SLOW_POLL_MS
            sink.onProviderDegraded?.('claude-code', `transcript reads failing (${failDetail.slice(0, 160)})`)
          }
        } else if (tracker.recordSuccess() && degraded) {
          degraded = false
          pollMs = FAST_POLL_MS
          sink.onProviderRecovered?.('claude-code')
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
      if (listenerRef !== null) await listenerRef.close().catch(() => {})
    }
  }

  async function discoverTranscripts(sink: EventSink, tracked: Map<string, TrackedTranscript>): Promise<void> {
    const files = await scanTranscripts()
    const seen = new Set<string>()
    for (const f of files) {
      seen.add(f.file)
      if (tracked.has(f.file)) continue
      const probe = await probeTranscript(f.file)
      tracked.set(f.file, {
        nativeId: probe.nativeId,
        reader: new IncrementalJsonlReader(f.file),
        ...(probe.cwd !== undefined ? { cwd: probe.cwd } : {}),
        ...(probe.title !== undefined ? { title: probe.title } : {}),
        ...(probe.startedAtSec !== undefined ? { startedAtSec: probe.startedAtSec } : {}),
        lastActivitySec: Math.floor(f.mtimeMs / 1000),
      })
      sink.onSessionDiscovered?.('claude-code', {
        nativeId: probe.nativeId,
        ...(probe.cwd !== undefined ? { workdir: probe.cwd } : {}),
        ...(probe.title !== undefined ? { title: probe.title } : {}),
        ...(probe.startedAtSec !== undefined ? { startedAt: probe.startedAtSec } : {}),
        lastActivityAt: Math.floor(f.mtimeMs / 1000),
      })
    }
    for (const file of [...tracked.keys()]) if (!seen.has(file)) tracked.delete(file)
  }

  function applyTranscriptLines(
    t: TrackedTranscript,
    lines: Array<{ byteOffset: number; text: string }>,
    parsed: unknown[],
    sink: EventSink,
  ): void {
    const ref: SessionRef = { providerId: 'claude-code', nativeId: t.nativeId }
    for (let i = 0; i < lines.length; i++) {
      const obj = parsed[i]
      if (obj === null || typeof obj !== 'object') continue
      const o = obj as Record<string, unknown>
      const msg = projectTranscriptLine(o, '', lines[i].byteOffset)
      if (msg !== null) {
        sink.onMessageAppended?.(ref, { ...msg, sourceRef: `${t.nativeId}#offset=${lines[i].byteOffset}` })
        const ts = typeof o['timestamp'] === 'string' ? Date.parse(o['timestamp']) : Number.NaN
        if (Number.isFinite(ts)) t.lastActivitySec = Math.floor(ts / 1000)
        if (t.cwd === undefined && typeof o['cwd'] === 'string') t.cwd = o['cwd']
        continue
      }
      if (o['type'] === 'ai-title' && typeof o['aiTitle'] === 'string' && t.title !== o['aiTitle']) {
        t.title = o['aiTitle'] // 标题晚到：快照补发（L3 upsert 幂等）
        sink.onSessionDiscovered?.('claude-code', {
          nativeId: t.nativeId,
          ...(t.cwd !== undefined ? { workdir: t.cwd } : {}),
          title: t.title,
          ...(t.startedAtSec !== undefined ? { startedAt: t.startedAtSec } : {}),
          ...(t.lastActivitySec !== undefined ? { lastActivityAt: t.lastActivitySec } : {}),
        })
      }
    }
  }

  async function dispose(): Promise<void> {
    /* listener/监控随 monitorRegistry 任务收尾；无额外常驻资源 */
  }

  function describeDiagnostics(): ProviderDiagnosticsInfo {
    return {
      dataSource: {
        kind: 'transcripts-jsonl',
        readable: true,
        ...(lastHookEvent !== null ? { detail: `hooks callback accepted=${lastHookEvent.accepted} rejected=${lastHookEvent.rejected}` } : {}),
      },
      control: {
        hooks: lastHookEvent !== null ? true : undefined,
        note:
          lastHookEvent === null
            ? 'hooks loopback listener starts with the monitor; no callbacks observed yet'
            : `hooks loopback active (accepted=${lastHookEvent.accepted}, rejected=${lastHookEvent.rejected})`,
      },
    }
  }

  return {
    id: 'claude-code',
    probeHealth,
    listSessions,
    readMessages,
    getCapabilities,
    sendReply: async () => unsupported('reply'),
    pause: async () => unsupported('pause'),
    resume: async () => unsupported('resume'),
    startMonitor,
    dispose,
    describeDiagnostics,
  }
}
