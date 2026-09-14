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
 * 控制面（DM 批改版，docs/briefs/dm-dsh-managed.md；两态并存如实）：
 * - **observed 面（默认，键≠'1' 行为逐字节不变）**：harness 控制通道源码在位，
 *   getCapabilities 恒 observed + 空集；sendReply/pause/resume 结构化 unsupported。
 * - **managed 面（settings 键 `deepseek_managed_enabled` 恰 '1' 授权）**：SDK
 *   jsonrpc 直连（docs/27 §4 设计全案）——spawn Electron 内置 node +
 *   jsonrpc-demo bin.js（DSH_CORDIS_CONFIG 指 DevHub 渲染 cordis.yml）→
 *   initialize 握手（版本哨兵）→ session/prompt 惰性 create→prompt 合一 →
 *   session.event 44 型 firehose 薄适配（event→payload 槽，复用 zcodeProtocol
 *   帧解析）喂 sink（流式 chunk 增量落投影）→ session.status idle 收尾；
 *   sendReply 对 live 会话走 prompt、死会话回退 one-shot resume（evidence 诚实
 *   区分）；无 wire cancel（SDK 协议事实）——pause=kill 阶梯（shutdown→
 *   taskkill 温和→/T /F 强制，docs/27 SDK client 阶梯的 Windows 映射）+双超时；
 *   approval policy never v1（无远程应答通道，UI/ⓘ 如实标注）。
 *   授权门/渲染/哨兵在 deepseekManagedConfig.ts；协议纯函数在 deepseekProtocol.ts。
 *
 * 纪律：`~/.dsh/**` 只读（`.credentials.yaml` 绝不读取）；未知事件类型容忍
 * 丢弃 + 计数；脏尾帧（torn write）跳过；解析失败结构化降级绝不抛穿。
 *
 * electron-free；spawn 经 core/exec spawnManaged/run（约束 #7）。
 */

import { existsSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { zstdDecompressSync } from 'node:zlib'
import type { AgentCapabilitySet, SessionStatus } from '../../../../shared/types.ts'
import { spawnManaged, type ManagedProcess } from '../../../core/exec.ts'
import { nowSec } from '../../internal.ts'
import { getSetting } from '../../settingsService.ts'
import { buildSegments, type RawSegmentBlock } from '../messageSegments.ts'
import {
  FAST_POLL_MS,
  ReadFailureTracker,
  SLOW_POLL_MS,
  cancellableSleep,
  startMonitorTask,
  type MonitorCancelToken,
} from '../monitorRegistry.ts'
import { redactText } from '../redact.ts'
import {
  DEEPSEEK_MANAGED_REQUEST_TIMEOUT_MS,
  DEEPSEEK_MANAGED_SHUTDOWN_TIMEOUT_MS,
  DEEPSEEK_HARNESS_ROOT_DEFAULT,
  ensureDeepseekCordisConfig,
  readDeepseekManagedGate,
  verifyDeepseekHandshake,
  type DeepseekManagedGateState,
} from './deepseekManagedConfig.ts'
import {
  describeDshTurnEnd,
  encodeDshRequest,
  evalDshEventStatus,
  extractDshServerInfo,
  extractDshMessageId,
  extractDshSessionEvent,
  extractDshSessionStatus,
  extractDshSubagentNotice,
  parseDshFrame,
  type DshFrameId,
  type DshRpcError,
  type DshSessionEventParams,
} from './deepseekProtocol.ts'
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

  // ---- DM 批托管面选项（全部可选；键≠'1' 时零消费，行为逐字节不变）----

  /**
   * managed 授权门注入（默认 readDeepseekManagedGate——生产 settings 键读取；
   * smoke 注入固定门态实现真机隔离夹具）。undefined = 仍走生产门（键≠'1' 停用）。
   */
  managedGate?: () => DeepseekManagedGateState
  /** 托管子进程命令覆盖（默认门态 spawnCommand = process.execPath）。 */
  managedCommand?: string
  /** 托管 argv 覆盖（默认门态 [binPath]；smoke 注入假 dsh 脚本）。 */
  managedArgs?: string[]
  /** spawn env 覆盖（默认 process.env 透传 + 门态 DSH_CORDIS_CONFIG；零 key 注入）。 */
  managedEnv?: NodeJS.ProcessEnv
  /** cordis.yml 渲染物落位覆盖（默认门态 configPath；smoke 注入夹具路径）。 */
  managedConfigPath?: string
  /** 托管会话工作区覆盖（默认门态 workspacePath = 用户 home）。 */
  managedWorkspacePath?: string
  /** initialize/单请求等待超时毫秒（默认 30_000；握手秒级宽容忍冷启动）。 */
  managedRequestTimeoutMs?: number
  /** kill 阶梯 shutdown 段超时毫秒（默认 8_000；smoke 注入小值提速）。 */
  managedShutdownTimeoutMs?: number
  /** managed caps 探测注入（默认零 spawn：门态+bin 在位即 managed——caps 探测
   * 零推理红线；smoke 注入假探针验证 caps 链）。 */
  managedCapsProbe?: () => { alive: boolean; detail: string }
  /** 消息投影单条字符上限沿用 messageTextCap；managed 流式 chunk 逐条投影共用。 */
}

/**
 * settings 缺省时的默认安装根（AC0 实测；docs/12 §8.5。DM 批起定义归位
 * deepseekManagedConfig.ts——模块依赖保持 provider → config 单向无环；本处
 * re-export 保持既有公共面零变化）。
 */
export { DEEPSEEK_HARNESS_ROOT_DEFAULT } from './deepseekManagedConfig.ts'

/** harness 数据根目录名（dsh-home-paths src/index.ts:12 逐字）。 */
export const DEEPSEEK_DSH_HOME_DIR_NAME = '.dsh'

/** harness 数据根 env 覆盖变量名（dsh-home-paths src/index.ts:18 逐字）。 */
export const DEEPSEEK_DSH_HOME_ENV = 'DSH_HOME'

/**
 * 控制面显式文案（docs/14 §A.1 #1 降级可读；DM 批两态改版）：observed 投影已实接；
 * managed 面（SDK jsonrpc 直连）已实装但被授权门钉住——settings 键恰 '1' 才启用
 * （真实推理 + ~/.dsh 写入必须显式授权），默认态行为与未接线逐字节一致。
 */
export const DEEPSEEK_CONTROL_NOTE =
  'observed session projection wired; managed face (SDK jsonrpc direct) implemented but gated off by default (settings key deepseek_managed_enabled must be exactly \'1\')'

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
  const managedRequestTimeoutMs = options.managedRequestTimeoutMs ?? DEEPSEEK_MANAGED_REQUEST_TIMEOUT_MS
  const managedShutdownTimeoutMs = options.managedShutdownTimeoutMs ?? DEEPSEEK_MANAGED_SHUTDOWN_TIMEOUT_MS

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
      // DM 批（docs/27 §4.4 同一性）：DevHub 亲自发起过的托管会话（同 sessionId
      // 落盘 persistence 同根）在扫描投影中标 managed——L3 resolveSessionMode 对
      // 显式 mode 快照照常采用，行不会被无 mode 的扫描投影降级。
      if (managedSessionIds.has(info.sessionId)) snap.mode = 'managed'
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
  // DM 批托管面 — SDK jsonrpc 直连（deepseekProtocol/deepseekManagedConfig；键
  // ≠'1' 时本节全部入口被授权门结构化拒绝，observed 路径零触碰逐字节不变）
  // -------------------------------------------------------------------------

  /**
   * 活跃 live 连接（nativeId → 句柄）：SDK 协议无独立 create——session/prompt
   * 惰性建会话（create 与 send 合一，docs/27 §4.3-2），DevHub 侧自生成
   * `session-<uuid>` 形态 nativeId（wire 只要求 string 键）。连接跨回合存活
   * （zcode「终态即 close」不同：DSH 无 close 方法，收尾只有 kill 阶梯——
   * idle 后连接保留等下一条 prompt，idle-timeout 树杀后自然回退 one-shot resume）。
   */
  interface DshManagedHandle {
    nativeId: string
    proc: ManagedProcess
    rpc: DshRpcSession
    lastStatus: SessionStatus | null
    turnInFlight: boolean
    finalized: boolean
    /** 最近一次 firehose 事件 seq（增量容忍对账面）。 */
    lastEventSeq: number | null
    /** 流式证据：最近一次 assistant/chunk 到达时刻（秒）与条数（诊断面）。 */
    lastChunkAtSec: number | null
    chunksStreamed: number
    /** sendReply evidence 通道记忆（live prompt vs one-shot resume 如实区分）。 */
    lastReplyMode: 'live-prompt' | 'one-shot-resume' | null
  }

  interface DshRpcSession {
    /** 结构化 null = 超时/写失败/进程退出（调用方按失败处理，绝不抛挂起）。 */
    rawCall(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<{ id: DshFrameId; result?: unknown; error?: DshRpcError } | null>
    call(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>
  }

  const managedSessions = new Map<string, DshManagedHandle>()
  /** DevHub 亲自发起过的托管会话全集（连接收尾后保留）：listSessions managed 标记。 */
  const managedSessionIds = new Set<string>()
  /** dispose 后拒绝新托管 spawn（B2 审查矩阵 #1 同款防关停竞态孤儿进程）。 */
  let disposed = false
  /** 协议容忍计数 + 最近一次门态/哨兵证据（诊断面；零凭据）。 */
  const managedStats = {
    unknownFrames: 0,
    unknownNotifications: 0,
    serverRequestsRefused: 0,
    turnsCompleted: 0,
    lateEvents: 0,
    sinkErrors: 0,
    eventsSeen: 0,
    subagentNotices: 0,
    /** kill 阶梯各段触发计数（shutdown/温和段/强制段）。 */
    shutdownOk: 0,
    killTreeUsed: 0,
  }
  let lastSpawnVerdict: string | null = null

  /** 门读取（生产注入缝；smoke 覆盖）。 */
  function managedGate(): DeepseekManagedGateState {
    return options.managedGate?.() ?? readDeepseekManagedGate()
  }

  /**
   * spawn + 行解析 + RPC 客户端一体（zcode spawnRpcConnection 同构；差异：
   * 出站帧带 jsonrpc:'2.0' 且 id 为 `req_<hex>` 串、**无服务端反向请求**
   * （SDK 协议四通知全是 notification——入站 request 帧属协议外形态，结构化
   * 回 -32601 冗余防御）。spawn env = 透传 + DSH_CORDIS_CONFIG（配置路径，
   * 零凭据）。onNotice 为可后绑定的通知路由（startManagedSession 侧在句柄
   * 登记前 spawn——闭包经 noticeRoute 槽延迟到登记后生效；登记前的通知帧
   * 属握手期 boot 噪声，容忍计数）。
   */
  function spawnDshRpcConnection(
    gate: DeepseekManagedGateState,
  ): { proc: ManagedProcess; rpc: DshRpcSession; noticeRoute: { target: ((method: string, params: unknown) => void) | null } } {
    const pending = new Map<string, { resolve: (resp: { id: DshFrameId; result?: unknown; error?: DshRpcError } | null) => void; timer: NodeJS.Timeout }>()
    const noticeRoute: { target: ((method: string, params: unknown) => void) | null } = { target: null }
    const nextId = (): string => `req_${randomUUID().replaceAll('-', '')}`
    const command = options.managedCommand ?? gate.spawnCommand ?? process.execPath
    const args = options.managedArgs ?? gate.spawnArgs ?? []
    const env = options.managedEnv ?? { ...process.env, ...(gate.spawnEnv ?? {}) }
    const workspace = options.managedWorkspacePath ?? gate.workspacePath
    const handleLine = (line: string): void => {
      const text = line.trim()
      if (text.length === 0) return
      const frame = parseDshFrame(text)
      if (frame.kind === 'invalid') {
        managedStats.unknownFrames += 1 // 畸形行：SDK server 静默忽略同款容忍 + 计数
        return
      }
      if (frame.kind === 'request') {
        // SDK 协议无服务端反向请求（docs/27 §1.6）：结构化 -32601 冗余防御
        managedStats.serverRequestsRefused += 1
        proc.writeStdin(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: `DevHub does not implement server request: ${frame.method}` } })}\n`)
        return
      }
      if (frame.kind === 'notification') {
        if (noticeRoute.target !== null) noticeRoute.target(frame.method, frame.params)
        else managedStats.lateEvents += 1 // 握手期通知（路由未绑定）：容忍计数
        return
      }
      // response / error：pending 表按 id 归一收敛
      const key = String(frame.id)
      const entry = pending.get(key)
      if (entry === undefined) {
        managedStats.unknownFrames += 1 // 未知 id（超时后迟到响应等）：容忍计数
        return
      }
      pending.delete(key)
      clearTimeout(entry.timer)
      entry.resolve(frame.kind === 'response' ? { id: frame.id, result: frame.result } : { id: frame.id, error: frame.error })
    }
    const proc = spawnManaged(command, args, {
      idleTimeoutMs: gate.managedIdleTimeoutMs,
      lifetimeTimeoutMs: gate.managedLifetimeTimeoutMs,
      stdinWritable: true,
      ...(workspace !== undefined ? { cwd: workspace } : {}),
      env,
      onStdout: handleLine,
    })
    const rpc: DshRpcSession = {
      rawCall(method, params, timeoutMs = managedRequestTimeoutMs) {
        const id = nextId()
        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            pending.delete(id)
            resolve(null) // 超时 → 结构化 null
          }, timeoutMs)
          pending.set(id, { resolve, timer })
          const written = proc.writeStdin(`${encodeDshRequest(id, method, params)}\n`)
          if (!written.ok) {
            clearTimeout(timer)
            pending.delete(id)
            resolve(null)
          }
        })
      },
      async call(method, params, timeoutMs) {
        const resp = await rpc.rawCall(method, params, timeoutMs)
        if (resp === null) throw new Error(`dsh runtime request timeout or write failure: ${method}`)
        if (resp.error !== undefined) throw new Error(`dsh runtime error ${resp.error.code}: ${resp.error.message}`)
        return resp.result
      },
    }
    return { proc, rpc, noticeRoute }
  }

  /**
   * kill 阶梯（docs/27 SDK client dispose 阶梯的 Windows 映射 + 双超时）：
   * 1. shutdown 请求（应答后 runtime 自杀 exit 0；超时 DEEPSEEK_MANAGED_SHUTDOWN_
   *    TIMEOUT_MS 放弃等待）；
   * 2. 兜底 taskkill /PID /T 温和段（killTree 内建）→ 2.5s 存活 → /T /F 强制段
   *    （SIGTERM→SIGKILL 语义的 Windows 落法；docs/27 的 stdin-EOF 段在
   *    spawnManaged 契约中无对应面——ManagedProcess 不暴露 stdin.end()，
   *    温和 taskkill 已覆盖其语义，偏差如实记录）；
   * 3. 有界退出等待（绝不留活进程，绝不无限挂起）。
   */
  async function teardownDshConnection(handle: { proc: ManagedProcess; rpc: DshRpcSession }, what: string): Promise<string> {
    let verdict = `${what}: shutdown response ok`
    const resp = await handle.rpc.rawCall('shutdown', {}, managedShutdownTimeoutMs).catch(() => null)
    if (resp !== null && resp.error === undefined) {
      const exit = await waitForProcExit(handle.proc, `${what} shutdown`, managedShutdownTimeoutMs)
      if (exit.observed) {
        managedStats.shutdownOk += 1
        return `${what}: graceful shutdown ok (runtime self-exit; ${exit.detail})`
      }
      verdict = `${what}: shutdown ok but exit unobserved`
    } else {
      verdict = `${what}: shutdown request failed/timed out`
    }
    try {
      await handle.proc.killTree()
      managedStats.killTreeUsed += 1
    } catch {
      /* 已退出等幂等场景 */
    }
    const exit = await waitForProcExit(handle.proc, `${what} killTree`, 8_000)
    return `${verdict}; kill ladder applied (${exit.detail})`
  }

  /** live 连接收尾（幂等；managedSessionIds 保留 managed 标记供 listSessions）。 */
  function finalizeDshSession(nativeId: string, why: string): void {
    const handle = managedSessions.get(nativeId)
    if (handle === undefined) return
    if (handle.finalized) return
    handle.finalized = true
    managedSessions.delete(nativeId)
    lastSpawnVerdict = `session ${nativeId} connection closed (${why})`
    void teardownDshConnection(handle, `finalize ${nativeId}`).catch(() => {})
  }

  /**
   * firehose 事件 → 消息投影（managed 消费面；与 observed projectEvent 同脱敏
   * 惯例 + messageSegments 薄适配）。投影面（判定源 = 44 型词表内可验证结构）：
   * - user/message → role 'user'（content[].text）；
   * - assistant/chunk（text-delta）→ role 'assistant' 逐 delta 增量投影
   *   （nativeMsgId = `chunk-<seq>`；流式证据面——launch-verify #3）；
   *   reasoning-delta/usage/finish 等 chunk 变体不投影（内部推理/记账面）；
   * - assistant/message → role 'assistant'（text 块 + tool-call 块折叠
   *   `[tool_call <name>]`；tool-call 块映射 toolInvocation 段，label=name）；
   * - tool/call → role 'tool' `[tool_call <name>]`（callId 配对 tool/result）；
   * - tool/result → role 'tool' `[tool_result]`（内容不投影，与 observed 同口径）；
   * - 其余类型 → null（非对话面；容忍计数由调用方做）。
   */
  function projectDshLiveEvent(ev: DshSessionEventParams, file: string): RedactedMessage | null {
    if (ev.type === null) return null
    const data = ev.data
    const seqTag = ev.seq !== null ? String(ev.seq) : 'na'
    const base = {
      nativeMsgId: `${ev.type.replaceAll('/', '-')}-${seqTag}`,
      ...(ev.timeMs !== null && Number.isFinite(ev.timeMs) ? { occurredAt: Math.floor(ev.timeMs / 1000) } : {}),
      sourceRef: `${file}#seq=${seqTag}`,
    }
    const record = data !== null && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : null
    if (ev.type === 'user/message') {
      const text = textFromContentBlocks(record?.['content'])
      if (text.length === 0) return null
      return { role: 'user', contentRedacted: redactText(text).slice(0, messageTextCap), ...base }
    }
    if (ev.type === 'assistant/chunk') {
      const chunk = record?.['chunk']
      if (chunk === null || typeof chunk !== 'object' || Array.isArray(chunk)) return null
      const c = chunk as Record<string, unknown>
      if (c['type'] !== 'text-delta' || typeof c['text'] !== 'string' || c['text'].length === 0) return null
      const segments = buildSegments([{ kind: 'text', content: c['text'] }], messageTextCap)
      return {
        role: 'assistant',
        contentRedacted: redactText(c['text']).slice(0, messageTextCap),
        ...(segments !== undefined ? { segments } : {}),
        ...base,
      }
    }
    if (ev.type === 'assistant/message') {
      const message = record?.['message']
      const content = message !== null && typeof message === 'object' && !Array.isArray(message) ? (message as Record<string, unknown>)['content'] : undefined
      if (!Array.isArray(content)) return null
      const parts: string[] = []
      const blocks: RawSegmentBlock[] = []
      for (const block of content) {
        if (block === null || typeof block !== 'object' || Array.isArray(block)) continue
        const b = block as { type?: unknown; text?: unknown; name?: unknown; arguments?: unknown }
        if (b.type === 'text' && typeof b.text === 'string' && b.text.length > 0) {
          parts.push(b.text)
          blocks.push({ kind: 'text', content: b.text })
        } else if (b.type === 'tool-call' && typeof b.name === 'string' && b.name.length > 0) {
          parts.push(`[tool_call ${b.name}]`)
          blocks.push({ kind: 'toolInvocation', label: b.name, content: typeof b.arguments === 'string' ? b.arguments : '' })
        }
      }
      if (parts.length === 0) return null
      const segments = buildSegments(blocks, messageTextCap)
      return {
        role: 'assistant',
        contentRedacted: redactText(parts.join('\n')).slice(0, messageTextCap),
        ...(segments !== undefined ? { segments } : {}),
        ...base,
      }
    }
    if (ev.type === 'tool/call') {
      const name = typeof record?.['name'] === 'string' ? record['name'] : null
      if (name === null || name.length === 0) return null
      const segments = buildSegments([{ kind: 'toolInvocation', label: name, content: typeof record?.['arguments'] === 'string' ? record['arguments'] : '' }], messageTextCap)
      return {
        role: 'tool',
        contentRedacted: `[tool_call ${name}]`,
        ...(segments !== undefined ? { segments } : {}),
        ...base,
      }
    }
    if (ev.type === 'tool/result') {
      return { role: 'tool', contentRedacted: '[tool_result]', ...base }
    }
    return null
  }

  /**
   * 通知消费（连接闭包路由）：session.event firehose 薄适配喂 sink（状态沿 +
   * 流式增量落投影）、session.status idle 收尾语义、subagent.* 血缘登记。
   * sink 回调截断（B2 崩溃面修复同款：L3 落库异常不穿透 stdout data 链）。
   */
  function handleDshNotice(sink: EventSink, handle: DshManagedHandle, method: string, params: unknown): void {
    if (method === 'session.event') {
      const ev = extractDshSessionEvent(method, params)
      if (ev === null) {
        managedStats.unknownNotifications += 1
        return
      }
      if (ev.sessionId !== handle.nativeId) {
        managedStats.lateEvents += 1 // 非本会话事件（含未挂 subagent 插件不可能到达的子会话）：容忍计数
        return
      }
      if (ev.type === null) {
        managedStats.unknownNotifications += 1 // 事件信封缺 type（形态漂移）：容忍计数
        return
      }
      managedStats.eventsSeen += 1
      if (ev.seq !== null && (handle.lastEventSeq === null || ev.seq > handle.lastEventSeq)) {
        handle.lastEventSeq = ev.seq
      }
      if (ev.type === 'assistant/chunk') {
        handle.chunksStreamed += 1
        handle.lastChunkAtSec = nowSec()
      }
      const ref: SessionRef = { providerId: 'deepseek', nativeId: handle.nativeId }
      const message = projectDshLiveEvent(ev, `dsh-live://${handle.nativeId}`)
      if (message !== null) {
        try {
          sink.onMessageAppended?.(ref, message)
        } catch {
          managedStats.sinkErrors += 1
        }
      }
      const next = evalDshEventStatus(ev.type, ev.data)
      if (next !== null && next !== handle.lastStatus) {
        const from = handle.lastStatus ?? undefined
        handle.lastStatus = next
        const detail = ev.type === 'turn/end'
          ? describeDshTurnEnd(reasonOfTurnEnd(ev.data))
          : `dsh event: ${ev.type}`
        try {
          sink.onStatusChanged?.(ref, from, next, detail)
        } catch {
          managedStats.sinkErrors += 1
        }
      }
      if (ev.type === 'turn/end') managedStats.turnsCompleted += 1
      return
    }
    if (method === 'session.status') {
      const st = extractDshSessionStatus(method, params)
      if (st === null) {
        managedStats.unknownNotifications += 1
        return
      }
      if (st.sessionId !== handle.nativeId) {
        managedStats.lateEvents += 1
        return
      }
      // idle = 回合消费权威收尾沿（SDK 比 zcode 多的信号）；live 连接保留
      // 等下一条 prompt（无 close 方法——收尾只有 kill 阶梯，见 finalize 触发面）
      if (st.status === 'idle') {
        if (handle.lastStatus !== 'waiting_input') {
          const from = handle.lastStatus ?? undefined
          handle.lastStatus = 'waiting_input'
          try {
            sink.onStatusChanged?.({ providerId: 'deepseek', nativeId: handle.nativeId }, from, 'waiting_input', 'session.status idle (turn consumption settled)')
          } catch {
            managedStats.sinkErrors += 1
          }
        }
        handle.turnInFlight = false
      } else if (st.status === 'running' && handle.lastStatus !== 'running') {
        const from = handle.lastStatus ?? undefined
        handle.lastStatus = 'running'
        try {
          sink.onStatusChanged?.({ providerId: 'deepseek', nativeId: handle.nativeId }, from, 'running', 'session.status running')
        } catch {
          managedStats.sinkErrors += 1
        }
      }
      return
    }
    const sub = extractDshSubagentNotice(method, params)
    if (sub !== null) {
      managedStats.subagentNotices += 1 // v1 只记事件不建 UI（docs/27 §4.4）
      return
    }
    managedStats.unknownNotifications += 1 // 其余通知：容忍计数
  }

  function reasonOfTurnEnd(data: unknown): string | null {
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return null
    const reason = (data as Record<string, unknown>)['reason']
    return typeof reason === 'string' ? reason : null
  }

  /**
   * 九方法 4：getCapabilities（DM 托管判定，数据驱动；键≠'1' 逐字节不变）：
   * - 门停用（键/模型路由/版本哨兵第一层任一不满足）→ observed + 门态 reason
   *   （默认态；零子进程零开销——caps 探测零推理红线）；
   * - 门就绪 → managed + granted ['reply']（evidence 带版本哨兵证据：bin 在位 +
   *   wire-stable runtime 名 + 预期版本）。**granted 不含 pause**：SDK 协议无
   *   wire cancel（docs/27 §1.6 唯一硬缺口如实呈现——取消语义=终止进程，v1 caps
   *   不通告）；approval 无远程应答（policy never v1）如实注记。
   */
  async function getCapabilities(_ref: SessionRef): Promise<AgentCapabilitySet> {
    const gate = managedGate()
    if (!gate.enabled) {
      // 键≠'1'：legacy observed 形态逐字节不变（evidence = DEEPSEEK_CONTROL_NOTE
      // 同一常量；门态 reason 只进诊断面——REST 面零漂移）
      return { mode: 'observed', granted: [], verifiedAt: nowSec(), evidence: DEEPSEEK_CONTROL_NOTE }
    }
    if (options.managedCapsProbe !== undefined) {
      const probe = options.managedCapsProbe()
      if (!probe.alive) {
        return {
          mode: 'observed',
          granted: [],
          verifiedAt: nowSec(),
          evidence: `deepseek managed face gated on but caps probe failed: ${probe.detail}`,
        }
      }
      return {
        mode: 'managed',
        granted: ['reply'],
        verifiedAt: nowSec(),
        evidence: `deepseek managed face enabled (${gate.provider}/${gate.model}): ${probe.detail}; reply = live session/prompt or one-shot resume fallback; NO wire cancel (SDK protocol has none; cancel semantics = process kill ladder); approval policy 'never' v1 (no remote approval channel; out-of-workspace ops auto-refused)`,
      }
    }
    return {
      mode: 'managed',
      granted: ['reply'],
      verifiedAt: nowSec(),
      evidence: `deepseek managed face enabled (${gate.provider}/${gate.model}): version sentinel layer-1 ok (bin present at ${gate.binPath}); layer-2 initialize handshake identity check enforced at spawn; reply = live session/prompt or one-shot resume fallback (evidence distinguishes both states); NO wire cancel (SDK protocol has none; cancel semantics = process kill ladder); approval policy 'never' v1 (no remote approval channel; out-of-workspace ops auto-refused)`,
    }
  }

  /**
   * spawn → initialize（版本哨兵第二层）→ 惰性 create→prompt 合一 → live 连接
   * 登记 + managed 快照落库（mode:'managed' 即时可见）。失败路径全结构化：
   * dispose 后拒绝 / 门停用零 spawn / 渲染物写失败 / 握手超时或哨兵失配
   * （结构化拒绝——绝不带病对接）。
   */
  async function startManagedSession(task: string, sink: EventSink): Promise<{ ok: boolean; nativeId?: string; detail?: string }> {
    if (disposed) {
      return { ok: false, detail: 'deepseek provider disposed (runtime teardown in progress); managed session spawn refused' }
    }
    if (task.trim().length === 0 || task.length > 4_000) {
      return { ok: false, detail: 'task must be a non-empty string of 1..4000 chars' }
    }
    const gate = managedGate()
    if (!gate.enabled) {
      return { ok: false, detail: `deepseek managed gate disabled: ${gate.reason ?? 'unknown'}` }
    }
    const workspace = options.managedWorkspacePath ?? gate.workspacePath
    // 渲染物落盘（原子写；幂等跳过；失败结构化拒绝——绝不 spawn 无配置的 runtime）
    const ensured = ensureDeepseekCordisConfig(
      { workspacePath: workspace ?? homedir(), harnessRoot: gate.harnessRoot },
      ...(options.managedConfigPath !== undefined || gate.configPath !== undefined ? [{ configPath: options.managedConfigPath ?? gate.configPath }] : []),
    )
    if (!ensured.ok) {
      return { ok: false, detail: `deepseek managed cordis config failed: ${ensured.reason ?? 'unknown'}` }
    }
    const configPath = ensured.path ?? gate.configPath ?? ''
    // spawn（env 增量仅 DSH_CORDIS_CONFIG 配置路径——零凭据；渲染物路径以实际
    // 写盘路径为准，覆盖门态 spawnEnv）
    const spawnGate: DeepseekManagedGateState = {
      ...gate,
      configPath,
      spawnEnv: { ...(gate.spawnEnv ?? {}), DSH_CORDIS_CONFIG: configPath },
    }
    const conn = spawnDshRpcConnection(spawnGate)
    const nativeId = `session-${randomUUID()}`
    const handle: DshManagedHandle = {
      nativeId,
      proc: conn.proc,
      rpc: conn.rpc,
      lastStatus: null,
      turnInFlight: false,
      finalized: false,
      lastEventSeq: null,
      lastChunkAtSec: null,
      chunksStreamed: 0,
      lastReplyMode: null,
    }
    // 通知路由：登记后绑定（握手期通知走 lateEvents 计数）
    conn.noticeRoute.target = (method, params) => handleDshNotice(sink, handle, method, params)
    // 进程退出（任意原因：shutdown/idle-timeout/lifetime/崩溃）→ 结构化收尾
    void conn.proc.exited.then(() => {
      if (managedSessions.has(nativeId)) finalizeDshSession(nativeId, 'runtime process exited')
    })
    try {
      if (conn.proc.pid <= 0) throw new Error('dsh runtime spawn failed (synchronous spawn error)')
      // 握手 + 版本哨兵第二层（bin 存在性是第一层；name/version 失配结构化拒绝）
      const initResult = await conn.rpc.call('initialize', {
        cwd: workspace ?? homedir(),
        provider: gate.provider ?? 'deepseek-official',
        model: gate.model ?? 'deepseek-v4-flash',
      })
      const serverInfo = extractDshServerInfo(initResult)
      const sentinel = verifyDeepseekHandshake(initResult)
      if (!sentinel.ok) throw new Error(sentinel.reason)
      managedSessions.set(nativeId, handle)
      managedSessionIds.add(nativeId)
      // managed 快照即时落库（sink → L3 upsert 落 session_mode='managed'）
      sink.onSessionDiscovered?.('deepseek', {
        nativeId,
        mode: 'managed',
        ...(workspace !== undefined ? { workdir: workspace } : {}),
        lastActivityAt: nowSec(),
      })
      // 惰性 create→prompt 合一：session/prompt 携 DevHub 自生成 sessionId，
      // runtime 未知该 id 即建 agent+session（server.ts getOrCreateSession）
      await conn.rpc.call('session/prompt', {
        sessionId: nativeId,
        contentBlocks: [{ type: 'text', text: task }],
      })
      handle.turnInFlight = true
      handle.lastReplyMode = 'live-prompt'
      lastSpawnVerdict = `session ${nativeId} spawned (${serverInfo?.name ?? 'dsh'} ${serverInfo?.version ?? '?'}); first turn in flight`
      return {
        ok: true,
        nativeId,
        detail: `dsh runtime spawned + initialize handshake ok (serverInfo ${serverInfo?.name ?? '?'} v${serverInfo?.version ?? '?'}); lazy create+prompt in one (turn in flight; 44-type firehose streams to idle)`,
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      lastSpawnVerdict = `managed spawn failed: ${reason.slice(0, 160)}`
      if (managedSessions.has(nativeId)) {
        finalizeDshSession(nativeId, `spawn failure: ${reason.slice(0, 80)}`)
        return { ok: false, nativeId, detail: `deepseek managed turn start failed after handshake: ${reason.slice(0, 200)}` }
      }
      // 尚未登记：直接收尾孤儿连接
      void teardownDshConnection({ proc: conn.proc, rpc: conn.rpc }, 'pre-register failure').catch(() => {})
      return { ok: false, detail: `deepseek managed turn start failed: ${reason.slice(0, 200)}` }
    }
  }

  /**
   * 九方法 5：sendReply（两态并存，evidence 诚实区分）：
   * - live 会话 → 同连接 session/prompt（turn 增量续投）；
   * - 死会话（DevHub 重启/idle-timeout 树杀后）→ one-shot resume 回退：spawn
   *   新 runtime → initialize → session/prompt 携同一 sessionId（runtime 惰性
   *   建会话；会话历史由 persistence 同根落盘，observed 面可读）。协议级会话
   *   连续性由真机验证序列证明（launch-verify #4），此处 evidence 如实标注。
   */
  async function sendReply(ref: SessionRef, text: string): Promise<CommandOutcome> {
    const live = managedSessions.get(ref.nativeId)
    if (live !== undefined && !live.finalized) {
      try {
        await live.rpc.call('session/prompt', {
          sessionId: ref.nativeId,
          contentBlocks: [{ type: 'text', text }],
        })
        live.turnInFlight = true
        live.lastReplyMode = 'live-prompt'
        return { ok: true, status: 'executed', detail: 'live session/prompt ok (turn in flight on the existing connection)' }
      } catch (err) {
        // live 路径失败（连接已死等）：落 kill 阶梯后走 one-shot resume 回退
        const reason = err instanceof Error ? err.message : String(err)
        finalizeDshSession(ref.nativeId, `live prompt failure: ${reason.slice(0, 80)}`)
      }
    }
    // 键≠'1'：legacy unsupported 形态逐字节不变（REST 面零漂移；无 live 连接是
    // 键=1 时的常态——observed 会话的 reply 由 L3 caps 门先行拒绝）
    const gate = managedGate()
    if (!gate.enabled) return unsupported()
    return sendReplyOneShotResume(ref, text)
  }

  /** one-shot resume 回退（死会话）：门停用零 spawn；每次回复一次受控生命周期。 */
  async function sendReplyOneShotResume(ref: SessionRef, text: string): Promise<CommandOutcome> {
    const gate = managedGate()
    if (!gate.enabled) {
      return {
        ok: false,
        status: 'failed',
        errorCode: 'COMMAND_NOT_EXECUTABLE',
        detail: `deepseek managed gate disabled: ${gate.reason ?? 'unknown'}`,
      }
    }
    const workspace = options.managedWorkspacePath ?? gate.workspacePath
    const ensured = ensureDeepseekCordisConfig(
      { workspacePath: workspace ?? homedir(), harnessRoot: gate.harnessRoot },
      ...(options.managedConfigPath !== undefined || gate.configPath !== undefined ? [{ configPath: options.managedConfigPath ?? gate.configPath }] : []),
    )
    if (!ensured.ok) {
      return { ok: false, status: 'failed', errorCode: 'COMMAND_NOT_EXECUTABLE', detail: `deepseek managed cordis config failed: ${ensured.reason ?? 'unknown'}` }
    }
    const configPath = ensured.path ?? gate.configPath ?? ''
    const spawnGate: DeepseekManagedGateState = {
      ...gate,
      configPath,
      spawnEnv: { ...(gate.spawnEnv ?? {}), DSH_CORDIS_CONFIG: configPath },
    }
    // one-shot 通知旁路记忆（单槽——one-shot 通道无并发设计；每次清零重用）
    receiptMemory.receiptSeen = false
    receiptMemory.idleSeen = false
    const pendingMessageId: { id: string | null } = { id: null }
    const conn = spawnDshRpcConnection(spawnGate)
    conn.noticeRoute.target = (method, params) => {
      const ev = extractDshSessionEvent(method, params)
      if (ev !== null && ev.sessionId === ref.nativeId && ev.type === 'agent/inbox/spliced') {
        // durable 回执判据（SDK api.ts:225-229 同款）：spliced 事件含本 prompt 的
        // messageId；messageId 由 prompt 结果回填（resultReceived 槽）
        const messageId = pendingMessageId.id
        if (messageId === null || JSON.stringify(ev.data ?? {}).includes(messageId)) {
          receiptMemory.receiptSeen = true
        }
        return
      }
      const st = extractDshSessionStatus(method, params)
      if (st !== null && st.sessionId === ref.nativeId && st.status === 'idle') {
        receiptMemory.idleSeen = true
      }
    }
    const exitFlag = trackEarlyExit(conn.proc)
    try {
      if (conn.proc.pid <= 0) {
        return { ok: false, status: 'failed', errorCode: 'COMMAND_NOT_EXECUTABLE', detail: 'dsh runtime spawn failed (one-shot resume)' }
      }
      await conn.rpc.call('initialize', {
        cwd: workspace ?? homedir(),
        provider: gate.provider ?? 'deepseek-official',
        model: gate.model ?? 'deepseek-v4-flash',
      })
      const promptResult = await conn.rpc.call('session/prompt', {
        sessionId: ref.nativeId,
        contentBlocks: [{ type: 'text', text }],
      })
      pendingMessageId.id = extractDshMessageId(promptResult)
      // 回执确认 = agent/inbox/spliced 含本消息（api.ts:225-229 判据）；消费收尾 =
      // session.status idle（有界轮询 90s）。进程先退且无回执 ≠ 成功（红线）。
      const receipt = await pollDshReceipt(exitFlag)
      if (receipt.ok) {
        return {
          ok: true,
          status: 'executed',
          detail: `one-shot resume ok (fresh runtime; same sessionId ${ref.nativeId}; ${receipt.detail})`,
        }
      }
      return {
        ok: false,
        status: 'failed',
        errorCode: 'COMMAND_NOT_EXECUTABLE',
        detail: `one-shot resume not confirmed: ${receipt.detail}`,
      }
    } catch (err) {
      return {
        ok: false,
        status: 'failed',
        errorCode: 'COMMAND_NOT_EXECUTABLE',
        detail: `one-shot resume failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`,
      }
    } finally {
      void teardownDshConnection({ proc: conn.proc, rpc: conn.rpc }, 'one-shot resume teardown').catch(() => {})
    }
  }

  /** one-shot resume 通知旁路记忆（receipt = agent/inbox/spliced 含 messageId；idle = 收尾沿）。 */
  const receiptMemory = { receiptSeen: false, idleSeen: false }

  /** 回执+idle 有界确认轮询（one-shot 专供；90s 上限——一切等待有上限纪律）。 */
  async function pollDshReceipt(exitFlag: { get(): boolean }): Promise<{ ok: boolean; detail: string }> {
    const deadline = Date.now() + 90_000
    while (Date.now() < deadline) {
      if (receiptMemory.receiptSeen && receiptMemory.idleSeen) {
        return { ok: true, detail: 'inbox receipt + session.status idle confirmed' }
      }
      if (exitFlag.get()) {
        if (receiptMemory.receiptSeen) {
          return { ok: true, detail: 'inbox receipt confirmed; process exited before idle' }
        }
        return { ok: false, detail: 'process exited before any inbox receipt (process exit ≠ success)' }
      }
      await new Promise((r) => setTimeout(r, 200))
    }
    return receiptMemory.receiptSeen
      ? { ok: false, detail: 'inbox receipt seen but session.status idle not observed within 90000ms' }
      : { ok: false, detail: 'no inbox receipt within 90000ms' }
  }

  /** 进程「是否已退出」非阻塞标记（kimi trackEarlyExit 同款）。 */
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

  /**
   * 九方法 6：pause — SDK 协议无 wire cancel（docs/27 §1.6 唯一硬缺口）：取消
   * 语义 = 终止进程（kill 阶梯）。v1 caps 不通告 pause（granted=['reply']）——
   * 本方法是 L3 之后的 provider 级兜底，行为如实（终止 + persistence 落盘的
   * 回合状态由 observed 面收敛）。
   */
  async function pause(ref: SessionRef): Promise<CommandOutcome> {
    const handle = managedSessions.get(ref.nativeId)
    if (handle === undefined || handle.finalized) {
      // 键≠'1'：legacy unsupported 形态逐字节不变
      if (!managedGate().enabled) return unsupported()
      return {
        ok: false,
        status: 'failed',
        errorCode: 'COMMAND_NOT_EXECUTABLE',
        detail: 'no live managed dsh connection for this session (nothing to terminate)',
      }
    }
    finalizeDshSession(ref.nativeId, 'pause (no wire cancel in the SDK protocol; cancel semantics = process termination)')
    return {
      ok: true,
      status: 'executed',
      detail: 'session process terminated via kill ladder (no wire-level cancel in the SDK protocol; turn state converges via persisted log)',
    }
  }

  /** 九方法 7：resume — v1 unsupported（observed 面;managed 连续性由 sendReply 两态承担）。 */
  function unsupported(): CommandOutcome {
    return {
      ok: false,
      status: 'unsupported',
      errorCode: 'AGENT_CAPABILITY_MISSING',
      detail: DEEPSEEK_CONTROL_NOTE,
    }
  }

  /** 有界退出等待（zcode waitForProcExit 同款；一切等待有上限）。 */
  async function waitForProcExit(
    proc: ManagedProcess,
    what: string,
    timeoutMs = 30_000,
  ): Promise<{ observed: boolean; detail: string }> {
    const raceExit = (ms: number): Promise<'timeout' | 'exited'> => {
      let timer: NodeJS.Timeout | null = null
      const timeoutP = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), ms)
      })
      return Promise.race([
        proc.exited.then(() => {
          if (timer !== null) clearTimeout(timer)
          return 'exited' as const
        }),
        timeoutP,
      ])
    }
    const first = await raceExit(timeoutMs)
    if (first === 'exited') return { observed: true, detail: `${what}: exit observed` }
    try {
      await proc.killTree()
      managedStats.killTreeUsed += 1
    } catch {
      /* 已退出等幂等场景 */
    }
    const second = await raceExit(5_000)
    if (second === 'exited') return { observed: true, detail: `${what}: exit observed after re-kill` }
    return { observed: false, detail: `${what}: exit not observed within ${timeoutMs}ms (+5s after re-kill); pid=${proc.pid} may be lingering` }
  }

  // -------------------------------------------------------------------------
  // 九方法 4-7 实现在上方 DM 托管面节（observed 默认态由授权门结构化承担：
  // 键≠'1' 时 caps 恒 observed + 空集 + 门态 reason，行为与未接线逐字节一致）
  // -------------------------------------------------------------------------

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
    // B2 同款防关停竞态：先置 disposed（拒绝新 spawn），再收尾全部 live 连接
    // （kill 阶梯并发安全，幂等）——绝不留孤儿 runtime 进程。
    disposed = true
    const live = [...managedSessions.keys()]
    await Promise.all(
      live.map(async (nativeId) => {
        const handle = managedSessions.get(nativeId)
        if (handle === undefined || handle.finalized) return
        handle.finalized = true
        managedSessions.delete(nativeId)
        try {
          await teardownDshConnection(handle, `dispose ${nativeId}`)
        } catch {
          /* 单连接收尾失败不阻断（killTree 幂等兜底在 exec 内部） */
        }
      }),
    )
  }

  function describeDiagnostics(): ProviderDiagnosticsInfo {
    const probe = probeRoot()
    const sessionSource = probeSessionSource()
    const gate = managedGate()
    const managedNote = gate.enabled
      ? `managed face enabled (${gate.provider}/${gate.model}; idle ${gate.managedIdleTimeoutMs}ms / lifetime ${gate.managedLifetimeTimeoutMs}ms); live connections: ${managedSessions.size}; last spawn verdict: ${lastSpawnVerdict ?? 'none yet'}; firehose events seen: ${managedStats.eventsSeen} (chunks streamed: ${[...managedSessions.values()].reduce((acc, h) => acc + h.chunksStreamed, 0)}), unknown frames: ${managedStats.unknownFrames}, unknown notifications: ${managedStats.unknownNotifications}, late/foreign events: ${managedStats.lateEvents}, sink errors: ${managedStats.sinkErrors}, subagent notices: ${managedStats.subagentNotices}, shutdown-ok/killTree: ${managedStats.shutdownOk}/${managedStats.killTreeUsed}`
      : DEEPSEEK_CONTROL_NOTE
    return {
      dataSource: {
        kind: 'session-jsonl-zstd',
        readable: probe.exists && sessionSource.present,
        detail: `${probe.detail}; ${sessionSource.detail}`,
      },
      control: {
        note: managedNote,
      },
    }
  }

  return {
    id: 'deepseek',
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
    // DM 批（docs/18 §5.3 spawn_session 契约 DeepSeek 侧落点）：SDK jsonrpc live
    // 会话（initialize 握手版本哨兵 + 惰性 create→prompt 合一；firehose 流式落投影）
    startManagedSession: (task, sink) => startManagedSession(task, sink),
  }
}
