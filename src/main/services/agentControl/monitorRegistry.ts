/**
 * monitorRegistry.ts — Map 化可取消监控任务表 + 监控管线读端基建（docs/12 §7）。
 *
 * - 任务表：Map<ProviderId, MonitorTask>，每 provider 同时至多 1 个活跃 task
 *   （重复 start 先 cancel 旧 task）；cancel token = { cancelled: boolean }
 *   （archive/walker.ts 同款共享 token，每行/每轮循环检查点）；开关关闭 / 托盘退出 /
 *   provider 停用 → cancelAll()。
 * - 错误降级：单次读失败计数（ReadFailureTracker），连续 5 次 → 调用方把 task
 *   降级为慢轮询并上抛 health_changed（受影响活跃会话置 connection_lost 的
 *   判定归 L3 sink 接线）；恢复后重探刷新。
 * - IncrementalJsonlReader：增量读基建（byte offset 记忆 → 轮转/截断检测
 *   （offset > size → 重置全量重读，靠 event_id 唯一约束幂等）→ 行缓冲保留
 *   不完整尾行至下次拼接 → 逐行 try-parse，失败行计数不中断）。
 *
 * electron-free：零 electron import，可被 smoke 在系统 Node 下直接加载；
 * 本模块零 child_process import（进程纪律归 core/exec.ts，约束 #7）。
 */

import { open, stat } from 'node:fs/promises'
import type { AgentProviderId } from '../../../shared/types.ts'

/** 慢轮询（降级后）间隔毫秒。 */
export const SLOW_POLL_MS = 15_000
/** 快轮询（watcher 失败回落 / 正常增量轮询）间隔毫秒（docs/12 §7：2s stat 轮询回落）。 */
export const FAST_POLL_MS = 2_000
/** 连续读失败降级阈值（docs/12 §7：连续 5 次 → 慢轮询 + health_changed）。 */
export const READ_FAILURE_DEGRADE_THRESHOLD = 5
/** 不完整尾行字节缓冲上限（防单行无限膨胀吃内存）。 */
const PARTIAL_BUF_CAP_BYTES = 4 * 1024 * 1024
/** 单次增量读取的字节上限（单轮读不完留给下一轮；防大文件首轮拖垮轮询）。 */
const READ_CHUNK_CAP_BYTES = 4 * 1024 * 1024

// ---------------------------------------------------------------------------
// 可取消任务表（docs/12 §7：Map<ProviderId, MonitorTask>）
// ---------------------------------------------------------------------------

/** 共享取消 token（walker.ts 先例形态）：循环体在每个检查点读 token.cancelled。 */
export interface MonitorCancelToken {
  cancelled: boolean
}

export interface MonitorTask {
  readonly providerId: AgentProviderId
  /** 任务标注（诊断用，如 'codex rollout monitor'）。 */
  readonly label: string
  /** 启动时刻（unix 秒）。 */
  readonly startedAt: number
  readonly token: MonitorCancelToken
  /** 取消任务：置 token + 从注册表摘除（幂等）。 */
  cancel(): void
}

type MonitorRunner = (token: MonitorCancelToken) => void | Promise<void>

const tasks = new Map<AgentProviderId, MonitorTask>()

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

/**
 * 注册并启动监控任务；该 provider 已有活跃 task 时先 cancel 旧 task
 * （docs/12 §7：每 provider 至多 1 个活跃 task）。runner 的拒绝不冒泡——
 * 记为任务失败并从注册表摘除（结构化降级，不拖垮其他 provider）。
 */
export function startMonitorTask(providerId: AgentProviderId, runner: MonitorRunner, label?: string): MonitorTask {
  const previous = tasks.get(providerId)
  if (previous !== undefined) previous.cancel()

  const token: MonitorCancelToken = { cancelled: false }
  const task: MonitorTask = {
    providerId,
    label: label ?? `${providerId} monitor`,
    startedAt: nowSec(),
    token,
    cancel(): void {
      token.cancelled = true
      if (tasks.get(providerId) === task) tasks.delete(providerId)
    },
  }
  tasks.set(providerId, task)
  try {
    const result = runner(token)
    if (result instanceof Promise) {
      result.catch(() => {
        // runner 异步失败：摘除任务（调用方经 token 感知取消；错误不冒泡）
        if (tasks.get(providerId) === task) tasks.delete(providerId)
      })
    }
  } catch {
    // runner 同步抛出：同样只摘除任务
    if (tasks.get(providerId) === task) tasks.delete(providerId)
  }
  return task
}

/** 取消指定 provider 的活跃任务；无活跃任务返回 false。 */
export function cancelMonitorTask(providerId: AgentProviderId): boolean {
  const task = tasks.get(providerId)
  if (task === undefined) return false
  task.cancel()
  return true
}

/** 全部取消（开关关闭 / 托盘退出 / provider 停用，docs/12 §7）。 */
export function cancelAllMonitorTasks(): void {
  for (const task of [...tasks.values()]) task.cancel()
}

export function getMonitorTask(providerId: AgentProviderId): MonitorTask | undefined {
  return tasks.get(providerId)
}

export function activeMonitorProviderIds(): AgentProviderId[] {
  return [...tasks.keys()]
}

/** 取消 token 感知的 sleep：提前取消立即返回（循环检查点语义）。 */
export function cancellableSleep(ms: number, token: MonitorCancelToken): Promise<boolean> {
  return new Promise((resolve) => {
    if (token.cancelled) {
      resolve(false)
      return
    }
    const timer = setTimeout(() => {
      clearInterval(poll)
      resolve(!token.cancelled)
    }, ms)
    const poll = setInterval(() => {
      if (token.cancelled) {
        clearTimeout(timer)
        clearInterval(poll)
        resolve(false)
      }
    }, Math.min(ms, 100))
  })
}

// ---------------------------------------------------------------------------
// 读失败降级（docs/12 §7：连续 5 次 → 降级慢轮询 + health_changed）
// ---------------------------------------------------------------------------

export class ReadFailureTracker {
  private consecutive = 0
  private degraded = false
  readonly threshold: number

  constructor(threshold: number = READ_FAILURE_DEGRADE_THRESHOLD) {
    this.threshold = threshold
  }

  /**
   * 记一次失败；恰好跨越阈值时返回 true（只在该瞬间返回一次，
   * 之后持续失败继续返回 false——health_changed 只在状态变化沿触发）。
   */
  recordFailure(): boolean {
    this.consecutive += 1
    if (!this.degraded && this.consecutive >= this.threshold) {
      this.degraded = true
      return true
    }
    return false
  }

  /** 记一次成功；降级态下首个成功返回 true（恢复沿，供重探刷新）。 */
  recordSuccess(): boolean {
    const wasDegraded = this.degraded
    this.consecutive = 0
    this.degraded = false
    return wasDegraded
  }

  get isDegraded(): boolean {
    return this.degraded
  }

  get consecutiveFailures(): number {
    return this.consecutive
  }
}

// ---------------------------------------------------------------------------
// 增量 jsonl 读端基建（docs/12 §7 reader 段）
// ---------------------------------------------------------------------------

/** 单个完整行（byteOffset = 行首字节偏移，供 source_ref 指向源文件+offset）。 */
export interface JsonlLine {
  readonly byteOffset: number
  readonly text: string
}

export interface JsonlReadResult {
  /** 文件可读（stat/open/read 全链成功）。 */
  readonly readable: boolean
  /** 本轮是否发生轮转/截断（offset > size → 重置全量重读）。 */
  readonly rotated: boolean
  readonly lines: JsonlLine[]
  readonly parsed: unknown[]
  /** JSON 解析失败行数（计入 health_detail，不中断监控）。 */
  readonly parseFailures: number
  /** 读失败原因（readable=false 时的结构化降级依据）。 */
  readonly error?: string
}

/**
 * 增量 jsonl 读取器：byte offset 记忆；offset > size 视为轮转/截断 → 重置重读；
 * 不完整尾行（无换行符）留在字节缓冲，下次增量拼接后再解析；逐行 try-parse。
 */
export class IncrementalJsonlReader {
  private offset = 0
  private partial: Buffer = Buffer.alloc(0)
  private bomHandled = false
  private readonly filePath: string

  constructor(filePath: string, initialOffset = 0) {
    this.filePath = filePath
    this.offset = Number.isSafeInteger(initialOffset) && initialOffset > 0 ? initialOffset : 0
  }

  get currentOffset(): number {
    return this.offset
  }

  /** 供持久化游标恢复。 */
  resetTo(offset: number): void {
    this.offset = Number.isSafeInteger(offset) && offset > 0 ? offset : 0
    this.partial = Buffer.alloc(0)
  }

  async read(): Promise<JsonlReadResult> {
    let size: number
    try {
      size = (await stat(this.filePath)).size
    } catch (e) {
      return {
        readable: false,
        rotated: false,
        lines: [],
        parsed: [],
        parseFailures: 0,
        error: `stat failed: ${e instanceof Error ? e.message : String(e)}`,
      }
    }

    let rotated = false
    if (size < this.offset) {
      // 轮转/截断：重置 offset=0 全量重读（docs/12 §7；幂等靠 event_id 唯一约束）
      rotated = true
      this.offset = 0
      this.partial = Buffer.alloc(0)
      this.bomHandled = false
    }

    const want = Math.min(size - this.offset, READ_CHUNK_CAP_BYTES)
    let chunk: Buffer
    try {
      const handle = await open(this.filePath, 'r')
      try {
        if (want <= 0) {
          chunk = Buffer.alloc(0)
        } else {
          chunk = Buffer.alloc(want)
          const { bytesRead } = await handle.read(chunk, 0, want, this.offset)
          chunk = chunk.subarray(0, bytesRead)
        }
      } finally {
        await handle.close()
      }
    } catch (e) {
      return {
        readable: false,
        rotated,
        lines: [],
        parsed: [],
        parseFailures: 0,
        error: `read failed: ${e instanceof Error ? e.message : String(e)}`,
      }
    }

    this.offset += chunk.length

    // data 的绝对文件起点：本轮读取前 offset 回退本轮已读 + 上一轮残留 partial 长度
    const prevPartialLen = this.partial.length
    const dataStart = this.offset - chunk.length - prevPartialLen
    let data = this.partial.length > 0 ? Buffer.concat([this.partial, chunk]) : chunk
    // BOM：仅文件头首个读段处理（EF BB BF → UTF-8；rollout/转录均无 UTF-16 形态）
    let bomSkip = 0
    if (!this.bomHandled && this.offset > 0 && data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) {
      bomSkip = 3
      data = data.subarray(3)
    }
    this.bomHandled = true

    // 完整行截止到最后一个 \n；其后的不完整尾行留在缓冲
    const lastNewline = data.lastIndexOf(0x0a)
    let pendingAfter: Buffer
    if (lastNewline >= 0) {
      pendingAfter = data.subarray(lastNewline + 1)
      data = data.subarray(0, lastNewline + 1)
    } else {
      pendingAfter = data
      data = Buffer.alloc(0)
    }
    if (pendingAfter.length > PARTIAL_BUF_CAP_BYTES) {
      // 单行超上限：放弃该行（防御性截断，不中断监控）
      pendingAfter = Buffer.alloc(0)
    }
    this.partial = Buffer.from(pendingAfter)

    const text = data.toString('utf8')
    const lines: JsonlLine[] = []
    const parsed: unknown[] = []
    let parseFailures = 0
    let lineOffset = dataStart + bomSkip
    for (const raw of text.split('\n')) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
      const lineStart = lineOffset
      lineOffset += Buffer.byteLength(raw, 'utf8') + 1 // + \n
      if (line.length === 0) continue
      lines.push({ byteOffset: lineStart, text: line })
      try {
        parsed.push(JSON.parse(line))
      } catch {
        parseFailures += 1 // 解析失败行计数入 health_detail，不中断（docs/12 §8.1）
      }
    }
    return { readable: true, rotated, lines, parsed, parseFailures }
  }
}
