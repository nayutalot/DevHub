/**
 * deepseekProvider.ts — DeepSeek Harness observed 会话投影接入（docs/12 §8.5）。
 *
 * 2026-09-14 用户令「推进 deepseekharness 适配」= known-limitations §1.2 等待的
 * 真机探测授权；本批真机**只读**侦察（绝不启动/运行任何 harness 进程或脚本）
 * 结论：DeepSeek Harness（@deepseek-ai/dsh-root 0.1.0-rc.5，源码重建形态 pnpm
 * monorepo，安装根 = settings `deepseekHarnessRoot` 默认 D:\Apps\deepseek-harness）
 * 已在本机运行过，用户侧数据根实存且可解析：
 *
 * - 数据根 = `~/.dsh`（harness 自身约定 @deepseek-ai/dsh-home-paths
 *   packages/util/home-paths/src/index.ts:12 `DSH_HOME_DIR_NAME = '.dsh'`、
 *   :18 `DSH_HOME_ENV = 'DSH_HOME'`、:87-91 空白 env 视同未设；本 provider
 *   逐字对齐该解析规则，零新 settings 键）。
 * - 会话日志 = `~/.dsh/sessions/<projectKey>/session-<uuid>/session.jsonl.zstd`
 *   （本机 7 个真实会话实存）。容器为**拼接 zstd 帧**：首帧 = `{"type":"session",…}`
 *   header JSONL 行 + '\n'，后续帧 = 事件批次 JSONL（格式权威 =
 *   harness packages/session/session-persistence-jsonl/src/format.ts
 *   HeaderLine/toHeaderLine/logPath 与 zstd.ts scanZstdFrames；帧边界扫描算法
 *   为 RFC 8878 标准帧布局）。事件信封 = {type, seq, time, data, ignorable?}
 *   （packages/core/session/src/types.ts:404-423）；事件词表权威 =
 *   packages/core/session/src/known-event-types.ts:19-64（approval/asked、
 *   turn/start、user/message 等 44 型）。
 * - 会话投影缓存 = `~/.dsh/storages/session_projcache.json`（storage-json KV：
 *   tables.sessions.<id>.identity.{createdAt,cwd} + rows.title.val +
 *   rows.sessionListMetadata.val.lastPromptAt——本机实测，listSessions 的
 *   title/workdir/startedAt 事实源，绝不造 title）。
 * - zstd 解码走 `node:zlib` 内建 zstd（harness 自身同款：
 *   session-persistence-jsonl/src/zstd.ts:8-13 import {zstdCompress,…} from
 *   'node:zlib'；Node ≥22.15 可用；DevHub 运行期 Electron 44 = Node 24.18，
 *   smoke 系统 Node 24 实测解压成功）——零新依赖、零子进程。
 *
 * 控制面（本批结论，见 ProviderDiagnosticsInfo.control）：harness 源码树存在
 * 两条可编程通道——packages/acp/acp（"Automation-only Agent Client Protocol
 * server … over JSON-RPC stdio"）与 packages/sdk/dsh-sdk-client（stdio
 * JSON-RPC subprocess SDK）——但**均未真机验证**（验证需启动 harness 进程，
 * 红线禁止）→ getCapabilities 恒 observed + 空集；sendReply/pause/resume
 * 结构化 unsupported；未来批次获授权后可按 zcode app-server 同口径评估。
 *
 * 纪律：`~/.dsh/**` 只读（`.credentials.yaml` 绝不读取）；未知事件类型容忍
 * 丢弃 + 计数；脏尾帧（torn write）跳过；解析失败结构化降级绝不抛穿。
 *
 * electron-free；零 child_process import（约束 #7）。
 */

import { existsSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import type { AgentCapabilitySet } from '../../../../shared/types.ts'
import { nowSec } from '../../internal.ts'
import { getSetting } from '../../settingsService.ts'
import {
  FAST_POLL_MS,
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

export interface DeepseekProviderOptions {
  /** harness 安装根（默认 settings deepseekHarnessRoot → D:\Apps\deepseek-harness；仅 probeHealth 线索）。 */
  harnessRoot?: string
  /**
   * harness 数据根（默认 env DSH_HOME 非空白 → 其值，否则 ~/.dsh；对齐
   * dsh-home-paths resolveDshHome 优先级；smoke 注入夹具目录实现真机隔离）。
   */
  dshHome?: string
  /** 消息投影单条字符上限（完整内容在源文件，sourceRef 指回）。 */
  messageTextCap?: number
  /** 会话文件扫描上限（防御超大语料）。 */
  scanFileLimit?: number
  /** 监控轮询间隔毫秒（默认 FAST_POLL_MS；smoke 注入短间隔）。 */
  pollIntervalMs?: number
}

/** settings 缺省时的默认安装根（AC0 实测；docs/12 §8.5）。 */
export const DEEPSEEK_HARNESS_ROOT_DEFAULT = 'D:/Apps/deepseek-harness'

/** harness 数据根目录名（dsh-home-paths src/index.ts:12 逐字）。 */
export const DEEPSEEK_DSH_HOME_DIR_NAME = '.dsh'

/** harness 数据根 env 覆盖变量名（dsh-home-paths src/index.ts:18 逐字）。 */
export const DEEPSEEK_DSH_HOME_ENV = 'DSH_HOME'

/**
 * 控制面显式文案（docs/14 §A.1 #1 降级可读）：observed 投影已实接，控制通道
 * 源码在位但未真机验证——绝不因「理论上支持」放行（docs/12 §5）。
 */
export const DEEPSEEK_CONTROL_NOTE =
  'observed session projection only: control channels (ACP/SDK stdio) present in harness source but never verified (DevHub never launches the harness)'

/** 监控状态判定事件全集（known-event-types.ts 词表内；docs/12 §5 判定源真实）。 */
export const DEEPSEEK_STATUS_EVENT_TYPES = {
  running: ['turn/start', 'approval/decided'],
  approvalRequired: ['approval/asked'],
  // turn 终止（completed/aborted/error/…）只证明一轮结束，非会话终态（与
  // codex task_complete 同口径判 unknown，绝不猜 idle 终态）
  turnEnd: 'turn/end',
} as const

/**
 * 会话事件 → 状态判定（docs/12 §5；返回 null = 无状态证据）。
 * 判定源 = harness SessionEventMap 词表事件名（语义可验证）：
 * turn/start → running；approval/asked → approval_required（一次性批准请求，
 * apiproxy src/api-proxy.ts:1428-1443 同款 ask/decide 审计对语义）；
 * approval/decided → running；turn/end → unknown。
 */
export function evalDeepseekEventStatus(eventType: unknown): 'running' | 'approval_required' | 'unknown' | null {
  if (typeof eventType !== 'string') return null
  if ((DEEPSEEK_STATUS_EVENT_TYPES.approvalRequired as readonly string[]).includes(eventType)) return 'approval_required'
  if ((DEEPSEEK_STATUS_EVENT_TYPES.running as readonly string[]).includes(eventType)) return 'running'
  if (eventType === DEEPSEEK_STATUS_EVENT_TYPES.turnEnd) return 'unknown'
  return null
}

/** 会话日志文件单读字节上限（防御病态超大文件；真实语料 MB 量级）。 */
const LOG_READ_BYTE_CAP = 256 * 1024 * 1024
const DEFAULT_MESSAGE_TEXT_CAP = 4_000
const DEFAULT_SCAN_FILE_LIMIT = 400

interface SessionFileInfo {
  sessionId: string
  file: string
  mtimeMs: number
}

interface ProjectionEntry {
  createdAtSec?: number
  cwd?: string
  title?: string
  lastPromptAtSec?: number
}

interface DecodedLog {
  ok: boolean
  events: Array<Record<string, unknown>>
  parseFailures: number
  detail?: string
}

const ZSTD_MAGIC = 0xfd2fb528

export function createDeepseekProvider(options: DeepseekProviderOptions = {}): AgentProvider {
  const messageTextCap = options.messageTextCap ?? DEFAULT_MESSAGE_TEXT_CAP
  const scanFileLimit = options.scanFileLimit ?? DEFAULT_SCAN_FILE_LIMIT
  const pollIntervalMs = options.pollIntervalMs ?? FAST_POLL_MS

  // 协议容忍计数（解析失败行 + 非对话面事件，docs/12 §8 schema 防御）
  const protocolStats = { unprojectedEvents: 0, parseFailures: 0, unreadableLogs: 0 }

  function harnessRoot(): string {
    if (options.harnessRoot !== undefined) return options.harnessRoot
    try {
      const configured = getSetting('deepseekHarnessRoot')
      if (configured !== undefined && configured.trim().length > 0) return configured
    } catch {
      // settings 不可用（无库上下文）：默认根兜底
    }
    return DEEPSEEK_HARNESS_ROOT_DEFAULT
  }

  /**
   * 数据根解析（对齐 dsh-home-paths resolveDshHome 优先级：显式配置 >
   * $DSH_HOME 非空白 > ~/.dsh；空白 env 视同未设）。
   */
  function dshHome(): string {
    if (options.dshHome !== undefined) return options.dshHome
    const fromEnv = process.env[DEEPSEEK_DSH_HOME_ENV]
    if (fromEnv !== undefined && fromEnv.trim().length > 0) return fromEnv
    return join(homedir(), DEEPSEEK_DSH_HOME_DIR_NAME)
  }

  function sessionsRoot(): string {
    return join(dshHome(), 'sessions')
  }

  /** 只读安装根探测：检测到什么（供 health_detail 与诊断面）。 */
  function probeRoot(): {
    exists: boolean
    detail: string
    version?: string
    name?: string
  } {
    const root = harnessRoot()
    let isDir = false
    try {
      isDir = statSync(root).isDirectory()
    } catch {
      isDir = false
    }
    if (!isDir) {
      return { exists: false, detail: `deepseekHarnessRoot not found at ${root}` }
    }
    const clues: string[] = [`root present: ${root}`]
    let name: string | undefined
    let version: string | undefined
    const pkgPath = join(root, 'package.json')
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: unknown; version?: unknown }
        if (typeof pkg.name === 'string') {
          name = pkg.name
          clues.push(`package.json ${pkg.name}`)
        }
        if (typeof pkg.version === 'string') {
          version = pkg.version
          clues.push(`version ${pkg.version}`)
        }
      } catch {
        clues.push('package.json unreadable')
      }
    } else {
      clues.push('package.json missing')
    }
    for (const marker of ['AGENTS.md', 'CLAUDE.md', 'apps', 'packages']) {
      clues.push(`${marker} ${existsSync(join(root, marker)) ? 'present' : 'missing'}`)
    }
    return { exists: true, detail: clues.join(', '), ...(version !== undefined ? { version } : {}), ...(name !== undefined ? { name } : {}) }
  }

  /** 数据根只读探测：sessions 目录可读即会话事实源在位。 */
  function probeSessionSource(): { present: boolean; detail: string } {
    const root = sessionsRoot()
    try {
      if (!statSync(root).isDirectory()) {
        return { present: false, detail: `no session data under ${dshHome()} (sessions dir absent)` }
      }
    } catch {
      return { present: false, detail: `no session data under ${dshHome()} (sessions dir absent)` }
    }
    return { present: true, detail: `session data home verified at ${dshHome()} (sessions dir readable)` }
  }

  // -------------------------------------------------------------------------
  // zstd 拼接帧容器解码（RFC 8878 帧边界扫描 + node:zlib 逐帧解压）
  // -------------------------------------------------------------------------

  /**
   * 帧边界定位（不解压块体）。算法与 harness session-persistence-jsonl/src/
   * zstd.ts scanZstdFrames 一致：magic → FHD 描述符 → 块头游走 →（可选校验和）。
   * EOF 截断的残尾帧（harness 运行中 torn write）直接排除——只回完整帧。
   */
  function scanZstdFrameRanges(buffer: Buffer): Array<{ start: number; end: number }> {
    const frames: Array<{ start: number; end: number }> = []
    let offset = 0
    while (offset < buffer.length) {
      const start = offset
      if (buffer.length - offset < 4) return frames
      if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
        throw new Error(`corrupt zstd container: invalid frame magic at byte ${offset}`)
      }
      offset += 4
      if (offset === buffer.length) return frames
      const descriptor = buffer.readUInt8(offset)
      offset += 1
      if ((descriptor & 0x18) !== 0) {
        throw new Error(`corrupt zstd container: reserved frame-header bit at byte ${offset - 1}`)
      }
      const contentSizeFlag = descriptor >>> 6
      const singleSegment = (descriptor & 0x20) !== 0
      const checksum = (descriptor & 0x04) !== 0
      const dictionaryFlag = descriptor & 0x03
      const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
      const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
      const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
      if (buffer.length - offset < remainingHeaderBytes) return frames
      offset += remainingHeaderBytes
      for (;;) {
        if (buffer.length - offset < 3) return frames
        const blockHeader = buffer.readUIntLE(offset, 3)
        offset += 3
        const lastBlock = (blockHeader & 1) !== 0
        const blockType = (blockHeader >>> 1) & 0x03
        const blockSize = blockHeader >>> 3
        if (blockType === 0x03) {
          throw new Error(`corrupt zstd container: reserved block type at byte ${offset - 3}`)
        }
        const payloadBytes = blockType === 0x01 ? 1 : blockSize
        if (buffer.length - offset < payloadBytes) return frames
        offset += payloadBytes
        if (lastBlock) break
      }
      if (checksum) {
        if (buffer.length - offset < 4) return frames
        offset += 4
      }
      frames.push({ start, end: offset })
    }
    return frames
  }

  /** 事件信封取 seq（unknown 形态容忍 → null）。 */
  function seqOf(event: Record<string, unknown>): number | null {
    const seq = event['seq']
    if (typeof seq === 'number' && Number.isSafeInteger(seq)) return seq
    return null
  }

  /**
   * 会话日志解码：.jsonl.zstd（拼接帧逐帧解压）或明文 .jsonl（compression
   * 'none' 物理形态，format.ts logSuffix）。行解析容忍：unparsable 行计数
   * 不中断（投影读者非重建读者，ignorable 语义从严仅用于 harness 自身）。
   */
  async function readSessionLog(file: string): Promise<DecodedLog> {
    let raw: Buffer
    try {
      raw = await readFile(file)
    } catch (err) {
      protocolStats.unreadableLogs += 1
      return { ok: false, events: [], parseFailures: 0, detail: `session log unreadable: ${err instanceof Error ? err.message : String(err)}` }
    }
    if (raw.length > LOG_READ_BYTE_CAP) {
      protocolStats.unreadableLogs += 1
      return { ok: false, events: [], parseFailures: 0, detail: `session log exceeds read cap (${raw.length} bytes)` }
    }
    let text: string
    if (file.endsWith('.zstd')) {
      try {
        const frames = scanZstdFrameRanges(raw)
        const parts: Buffer[] = []
        for (const frame of frames) {
          parts.push(zstdDecompressSync(raw.subarray(frame.start, frame.end)))
        }
        text = Buffer.concat(parts).toString('utf8')
      } catch (err) {
        protocolStats.unreadableLogs += 1
        return { ok: false, events: [], parseFailures: 0, detail: `zstd container decode failed: ${err instanceof Error ? err.message : String(err)}` }
      }
    } else {
      text = raw.toString('utf8')
    }
    const events: Array<Record<string, unknown>> = []
    let parseFailures = 0
    for (const line of text.split('\n')) {
      if (line.length === 0) continue
      try {
        const parsed: unknown = JSON.parse(line)
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          events.push(parsed as Record<string, unknown>)
        } else {
          parseFailures += 1
        }
      } catch {
        parseFailures += 1
      }
    }
    protocolStats.parseFailures += parseFailures
    return { ok: true, events, parseFailures }
  }

  // -------------------------------------------------------------------------
  // 九方法 1：probeHealth（只读探测；绝不启动 harness 进程）
  // -------------------------------------------------------------------------

  async function probeHealth(): Promise<ProviderHealth> {
    const probe = probeRoot()
    if (!probe.exists) {
      return {
        installed: false,
        health: 'unavailable',
        healthDetail: `${probe.detail} (${DEEPSEEK_CONTROL_NOTE})`,
      }
    }
    const sessionSource = probeSessionSource()
    return {
      installed: true,
      ...(probe.version !== undefined ? { version: probe.version } : {}),
      health: 'ok',
      healthDetail: `harness detected: ${probe.detail}; ${sessionSource.detail}; observed session projection wired (read-only)`,
    }
  }

  // -------------------------------------------------------------------------
  // 九方法 2：listSessions（磁盘扫描 + projcache 投影；title 绝不伪造）
  // -------------------------------------------------------------------------

  /** 解析 session_projcache.json（storage-json KV；容忍缺失/损坏 → 空投影）。 */
  async function readProjectionCache(): Promise<Map<string, ProjectionEntry>> {
    const map = new Map<string, ProjectionEntry>()
    let raw: string
    try {
      raw = await readFile(join(dshHome(), 'storages', 'session_projcache.json'), 'utf8')
    } catch {
      return map // 无投影缓存：纯磁盘扫描兜底（title/startedAt 缺省，绝不猜）
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      protocolStats.parseFailures += 1
      return map
    }
    const tables = (parsed as { tables?: unknown } | null)?.tables
    const sessions = (tables as { sessions?: unknown } | null)?.sessions
    if (sessions === null || typeof sessions !== 'object') return map
    for (const [id, entry] of Object.entries(sessions as Record<string, unknown>)) {
      if (typeof id !== 'string' || id.length === 0 || entry === null || typeof entry !== 'object') continue
      const e = entry as {
        identity?: { createdAt?: unknown; cwd?: unknown }
        rows?: {
          title?: { val?: unknown }
          sessionListMetadata?: { val?: { lastPromptAt?: unknown } }
        }
      }
      const out: ProjectionEntry = {}
      if (typeof e.identity?.createdAt === 'number' && Number.isSafeInteger(e.identity.createdAt)) {
        out.createdAtSec = Math.floor(e.identity.createdAt / 1000)
      }
      if (typeof e.identity?.cwd === 'string' && e.identity.cwd.length > 0) out.cwd = e.identity.cwd
      if (typeof e.rows?.title?.val === 'string' && e.rows.title.val.length > 0) out.title = e.rows.title.val
      if (
        typeof e.rows?.sessionListMetadata?.val?.lastPromptAt === 'number'
        && Number.isSafeInteger(e.rows.sessionListMetadata.val.lastPromptAt)
      ) {
        out.lastPromptAtSec = Math.floor(e.rows.sessionListMetadata.val.lastPromptAt / 1000)
      }
      map.set(id, out)
    }
    return map
  }

  /** 扫描 sessions/<projectKey>/session-<id>/ 下的会话日志文件。 */
  async function scanSessionFiles(): Promise<SessionFileInfo[]> {
    const root = sessionsRoot()
    const out: SessionFileInfo[] = []
    let workspaces
    try {
      workspaces = await readdir(root, { withFileTypes: true })
    } catch {
      return [] // sessions 根不可读：observed 降级（unavailable 由调用方判定）
    }
    for (const ws of workspaces) {
      if (!ws.isDirectory()) continue
      const wsDir = join(root, ws.name)
      const sessions = await readdir(wsDir, { withFileTypes: true }).catch(() => [])
      for (const s of sessions) {
        if (!s.isDirectory() || !s.name.startsWith('session-')) continue
        const dir = join(wsDir, s.name)
        // 物理编码二形态（format.ts JsonlCompression 'zstd' | 'none'）
        const zstdPath = join(dir, 'session.jsonl.zstd')
        const plainPath = join(dir, 'session.jsonl')
        const file = existsSync(zstdPath) ? zstdPath : existsSync(plainPath) ? plainPath : null
        if (file === null) continue
        const st = await stat(file).catch(() => null)
        if (st === null || !st.isFile()) continue
        out.push({ sessionId: s.name, file, mtimeMs: st.mtimeMs })
      }
    }
    if (out.length > scanFileLimit) {
      out.sort((a, b) => b.mtimeMs - a.mtimeMs)
      out.length = scanFileLimit
    }
    return out
  }

  async function listSessions(): Promise<SessionSnapshot[]> {
    const [cache, files] = await Promise.all([readProjectionCache(), scanSessionFiles()])
    const snapshots: SessionSnapshot[] = []
    for (const info of files) {
      const proj = cache.get(info.sessionId)
      const lastActivityCandidates = [Math.floor(info.mtimeMs / 1000), ...(proj?.lastPromptAtSec !== undefined ? [proj.lastPromptAtSec] : [])]
      const snap: SessionSnapshot = {
        nativeId: info.sessionId,
        lastActivityAt: Math.max(...lastActivityCandidates),
      }
      if (proj?.cwd !== undefined) snap.workdir = proj.cwd
      if (proj?.title !== undefined) snap.title = proj.title
      if (proj?.createdAtSec !== undefined) snap.startedAt = proj.createdAtSec
      snapshots.push(snap)
    }
    return snapshots
  }

  /** nativeId → 会话日志文件（无 projcache 依赖：目录名即 encodeSegment(id)）。 */
  async function resolveSessionFile(nativeId: string): Promise<string | null> {
    const files = await scanSessionFiles()
    let newest: SessionFileInfo | null = null
    for (const info of files) {
      if (info.sessionId !== nativeId) continue
      if (newest === null || info.mtimeMs > newest.mtimeMs) newest = info
    }
    return newest?.file ?? null
  }

  // -------------------------------------------------------------------------
  // 九方法 3：readMessages（会话事件投影；脱敏 + seq 游标）
  // -------------------------------------------------------------------------

  /** content 块数组 → 纯文本（type==='text' 的 text 段；其余忽略）。 */
  function textFromContentBlocks(content: unknown): string {
    if (!Array.isArray(content)) return ''
    const parts: string[] = []
    for (const block of content) {
      if (block !== null && typeof block === 'object') {
        const c = block as { type?: unknown; text?: unknown }
        if (c.type === 'text' && typeof c.text === 'string' && c.text.length > 0) parts.push(c.text)
      }
    }
    return parts.join('\n')
  }

  /**
   * 会话事件 → 消息投影（claude/codex 同款脱敏惯例）：
   * - user/message → role 'user'（content[].text）；
   * - assistant/message → role 'assistant'（text 块 + tool-call 块折叠
   *   `[tool_call <name>]` 标记，thinking/reasoning 块不投影）；
   * - tool/result → role 'tool' 固定 `[tool_result]`（内容不投影，sourceRef 指回）。
   * - 其余事件类型（approval/policy、request/header、session/title、chunk 流、
   *   packed chunk 行等）非对话面 → 不投影；未知类型容忍计数。
   */
  function projectEvent(event: Record<string, unknown>, file: string): RedactedMessage | null {
    const type = event['type']
    const seq = seqOf(event)
    if (seq === null) return null
    const time = event['time']
    const occurredAt = typeof time === 'number' && Number.isFinite(time) ? Math.floor(time / 1000) : undefined
    const base = {
      nativeMsgId: String(seq),
      ...(occurredAt !== undefined ? { occurredAt } : {}),
      sourceRef: `${file}#seq=${seq}`,
    }
    if (type === 'user/message') {
      const data = event['data']
      const text = textFromContentBlocks((data as { content?: unknown } | null)?.content)
      return { role: 'user', contentRedacted: redactText(text).slice(0, messageTextCap), ...base }
    }
    if (type === 'assistant/message') {
      const message = (event['data'] as { message?: unknown } | null)?.message
      const content = (message as { content?: unknown } | null)?.content
      if (!Array.isArray(content)) return null
      const parts: string[] = []
      for (const block of content) {
        if (block === null || typeof block !== 'object') continue
        const c = block as { type?: unknown; text?: unknown; name?: unknown }
        if (c.type === 'text' && typeof c.text === 'string' && c.text.length > 0) parts.push(c.text)
        else if (c.type === 'tool-call' && typeof c.name === 'string' && c.name.length > 0) parts.push(`[tool_call ${c.name}]`)
      }
      if (parts.length === 0) return null
      return { role: 'assistant', contentRedacted: redactText(parts.join('\n')).slice(0, messageTextCap), ...base }
    }
    if (type === 'tool/result') {
      return { role: 'tool', contentRedacted: '[tool_result]', ...base }
    }
    if (typeof type === 'string') {
      protocolStats.unprojectedEvents += 1 // 非对话面事件：容忍计数（不投影）
    }
    return null
  }

  async function readMessages(ref: SessionRef, after?: string): Promise<MessagePage> {
    const file = await resolveSessionFile(ref.nativeId)
    if (file === null) return { messages: [], cursor: after ?? '0', hasMore: false }
    const afterSeq = after !== undefined ? Number.parseInt(after, 10) : 0
    const from = Number.isSafeInteger(afterSeq) && afterSeq > 0 ? afterSeq : 0
    const log = await readSessionLog(file)
    if (!log.ok) return { messages: [], cursor: after ?? '0', hasMore: false }
    const messages: RedactedMessage[] = []
    let cursor = from
    for (const event of log.events) {
      const seq = seqOf(event)
      if (seq === null || seq <= cursor) continue
      cursor = seq
      if (seq <= from) continue
      const message = projectEvent(event, file)
      if (message !== null) messages.push(message)
    }
    return { messages, cursor: String(cursor), hasMore: false }
  }

  // -------------------------------------------------------------------------
  // 九方法 4-7：能力恒 observed + 空集（控制通道未真机验证）；动作不支持
  // -------------------------------------------------------------------------

  async function getCapabilities(_ref: SessionRef): Promise<AgentCapabilitySet> {
    return {
      mode: 'observed',
      granted: [],
      verifiedAt: nowSec(),
      evidence: DEEPSEEK_CONTROL_NOTE,
    }
  }

  function unsupported(): CommandOutcome {
    return {
      ok: false,
      status: 'unsupported',
      errorCode: 'AGENT_CAPABILITY_MISSING',
      detail: DEEPSEEK_CONTROL_NOTE,
    }
  }

  // -------------------------------------------------------------------------
  // 九方法 8：startMonitor（sessions 根 watch + 轮询；seq 增量投影）
  // -------------------------------------------------------------------------

  interface TrackedSession {
    sessionId: string
    file: string
    size: number
    mtimeMs: number
    lastSeq: number
    lastStatus: 'running' | 'approval_required' | 'unknown' | undefined
  }

  function startMonitor(sink: EventSink): MonitorHandle {
    let loopDone: Promise<void> | null = null
    const task = startMonitorTask(
      'deepseek',
      (token) => {
        loopDone = runMonitorLoop(sink, token)
        return loopDone
      },
      'deepseek session monitor',
    )
    return {
      providerId: 'deepseek',
      async stop(): Promise<void> {
        task.cancel()
        if (loopDone !== null) await loopDone.catch(() => {})
      },
    }
  }

  async function runMonitorLoop(sink: EventSink, token: MonitorCancelToken): Promise<void> {
    const root = sessionsRoot()
    const tracked = new Map<string, TrackedSession>()
    const tracker = new ReadFailureTracker()
    let degraded = false
    let pollMs = pollIntervalMs
    let dirty = true
    let watcher: FSWatcher | null = null
    try {
      watcher = watch(root, { recursive: true }, () => {
        dirty = true
      })
      watcher.on('error', () => {
        watcher?.close()
        watcher = null
        dirty = true
      })
    } catch {
      watcher = null // fs.watch 不可用 → 轮询回落
    }
    try {
      while (!token.cancelled) {
        if (dirty) {
          dirty = false
          await discoverSessions(sink, tracked)
        }
        let failDetail: string | null = null
        for (const t of tracked.values()) {
          if (token.cancelled) break
          const st = await stat(t.file).catch(() => null)
          if (st === null || !st.isFile()) {
            failDetail = `session log stat failed: ${t.sessionId}`
            continue
          }
          if (st.size === t.size && st.mtimeMs === t.mtimeMs) continue
          const log = await readSessionLog(t.file)
          if (!log.ok) {
            failDetail = log.detail ?? 'session log unreadable'
            continue
          }
          t.size = st.size
          t.mtimeMs = st.mtimeMs
          applyMonitoredEvents(t, log.events, sink)
        }
        if (failDetail !== null) {
          if (tracker.recordFailure()) {
            degraded = true
            pollMs = SLOW_POLL_MS
            sink.onProviderDegraded?.('deepseek', `session log reads failing (${failDetail.slice(0, 160)})`)
          }
        } else if (tracker.recordSuccess() && degraded) {
          degraded = false
          pollMs = pollIntervalMs
          sink.onProviderRecovered?.('deepseek')
        }
        await cancellableSleep(pollMs, token)
        if (watcher === null) dirty = true // 纯轮询模式：每轮重扫发现新会话
      }
    } finally {
      try {
        watcher?.close()
      } catch {
        /* 已关闭 */
      }
    }
  }

  /** 新会话发现：全量首读（历史消息 + 状态一次投影，与 codex 首读同口径）。 */
  async function discoverSessions(sink: EventSink, tracked: Map<string, TrackedSession>): Promise<void> {
    const [cache, files] = await Promise.all([readProjectionCache(), scanSessionFiles()])
    const seen = new Set<string>()
    for (const info of files) {
      seen.add(info.sessionId)
      if (tracked.has(info.sessionId)) continue
      const entry: TrackedSession = {
        sessionId: info.sessionId,
        file: info.file,
        size: 0,
        mtimeMs: 0,
        lastSeq: 0,
        lastStatus: undefined,
      }
      tracked.set(info.sessionId, entry)
      const proj = cache.get(info.sessionId)
      const snapshot: SessionSnapshot = {
        nativeId: info.sessionId,
        lastActivityAt: Math.max(Math.floor(info.mtimeMs / 1000), ...(proj?.lastPromptAtSec !== undefined ? [proj.lastPromptAtSec] : [0])),
      }
      if (proj?.cwd !== undefined) snapshot.workdir = proj.cwd
      if (proj?.title !== undefined) snapshot.title = proj.title
      if (proj?.createdAtSec !== undefined) snapshot.startedAt = proj.createdAtSec
      sink.onSessionDiscovered?.('deepseek', snapshot)
      const log = await readSessionLog(info.file)
      if (log.ok) {
        const st = await stat(info.file).catch(() => null)
        if (st !== null) {
          entry.size = st.size
          entry.mtimeMs = st.mtimeMs
        }
        applyMonitoredEvents(entry, log.events, sink)
      }
    }
    for (const sessionId of [...tracked.keys()]) {
      if (!seen.has(sessionId)) tracked.delete(sessionId) // 文件消失（清理/归档）→ 停止跟踪
    }
  }

  /** 事件批处理：seq 增量消息投影 + 状态判定（docs/12 §7 sink 段）。 */
  function applyMonitoredEvents(t: TrackedSession, events: Array<Record<string, unknown>>, sink: EventSink): void {
    const ref: SessionRef = { providerId: 'deepseek', nativeId: t.sessionId }
    for (const event of events) {
      const seq = seqOf(event)
      if (seq === null || seq <= t.lastSeq) continue
      t.lastSeq = seq
      const message = projectEvent(event, t.file)
      if (message !== null) sink.onMessageAppended?.(ref, message)
      const status = evalDeepseekEventStatus(event['type'])
      if (status !== null && status !== t.lastStatus) {
        const from = t.lastStatus
        t.lastStatus = status
        sink.onStatusChanged?.(ref, from, status, `${String(event['type'])} (seq ${seq})`)
      }
    }
  }

  // -------------------------------------------------------------------------
  // 九方法 9：dispose + 诊断投影
  // -------------------------------------------------------------------------

  async function dispose(): Promise<void> {
    /* 无常驻资源（监控任务由 monitorRegistry 统一取消） */
  }

  function describeDiagnostics(): ProviderDiagnosticsInfo {
    const probe = probeRoot()
    const sessionSource = probeSessionSource()
    return {
      dataSource: {
        kind: 'session-jsonl-zstd',
        readable: probe.exists && sessionSource.present,
        detail: `${probe.detail}; ${sessionSource.detail}`,
      },
      control: {
        note: DEEPSEEK_CONTROL_NOTE,
      },
    }
  }

  return {
    id: 'deepseek',
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
