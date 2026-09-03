/**
 * exec.ts — 全项目唯一 spawn 入口（约束 #7，docs/02 §2）。
 *
 * 任何新增的系统命令调用必须经过本模块；其他模块禁止直接
 * import node:child_process 的 spawn/exec/execFile 及其同步变体。
 *
 * 规则：
 *  - 参数数组 + shell:false，禁止任何字符串拼接命令（约束 #8）；
 *  - 默认 15s 超时，超时 kill 进程并返回结构化超时结果（约束 #9）；
 *  - stdout/stderr 以 Buffer 收集，结束后按 BOM 选择解码（FF FE → UTF-16LE，
 *    UTF-8 BOM → UTF-8，否则兜底 UTF-8），返回结构化 ExecResult（约束 #10）；
 *  - spawn 失败（ENOENT 等）捕获为结构化结果，不向上抛异常；
 *  - 交互窗口（资源管理器 / VS Code / 终端 / WSL）统一经 launchViaStartProcess，
 *    PowerShell 脚本为静态字面量，动态值仅经 $env:DH_TARGET 传入（约束 #12）。
 */

import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import type { ExecResult } from '../../shared/types.ts'

export interface ExecOptions {
  /** 子进程工作目录，透传给 spawn。 */
  cwd?: string
  /** 子进程环境变量；不传则继承父进程（launchViaStartProcess 会合并 DH_TARGET）。 */
  env?: NodeJS.ProcessEnv
  /** 超时毫秒数，默认 15000（约束 #9）。 */
  timeoutMs?: number
  /** 透传 spawn 的 windowsVerbatimArguments（个别命令需要原样引号时开启）。 */
  windowsVerbatimArguments?: boolean
}

const DEFAULT_TIMEOUT_MS = 15_000

/**
 * 按字节序标记（BOM）选择解码：FF FE → UTF-16LE（wsl.exe 等 Windows 工具），
 * EF BB BF / 无 BOM → UTF-8 兜底；解码后剥掉行首 U+FEFF。
 */
function decodeOutput(buffer: Buffer): string {
  let text: string
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    text = buffer.toString('utf16le')
  } else {
    text = buffer.toString('utf8')
  }
  return text.replace(/^\uFEFF/, '')
}

/** 唯一的进程启动点：参数数组、无 shell、隐藏窗口、强制超时（约束 #7-#10）。 */
export function run(command: string, args: string[] = [], options: ExecOptions = {}): Promise<ExecResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return new Promise<ExecResult>((resolve) => {
    const startedAt = Date.now()
    const stdoutChunksAll: Buffer[] = []
    const stderrChunksAll: Buffer[] = []

    let timedOut = false
    let settled = false
    let exitCode: number | null = null
    let spawnErrorMessage: string | null = null
    let timer: NodeJS.Timeout | null = null

    const settle = (): void => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      let stderr = decodeOutput(Buffer.concat(stderrChunksAll))
      // spawn 层失败（如 ENOENT）没有进程 stderr，把错误消息放进 stderr 字段
      if (spawnErrorMessage !== null && stderr.trim().length === 0) {
        stderr = spawnErrorMessage
      }
      const code = timedOut ? -1 : (exitCode ?? -1)
      resolve({
        code,
        stdout: decodeOutput(Buffer.concat(stdoutChunksAll)),
        stderr,
        timedOut,
        command,
        args,
        durationMs: Date.now() - startedAt,
      })
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: options.windowsVerbatimArguments ?? false,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      // 参数非法等同步抛出的场景：同样折叠为结构化结果，不 throw（约束 #10/#14）
      spawnErrorMessage = err instanceof Error ? err.message : String(err)
      settle()
      return
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutChunksAll.push(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrChunksAll.push(chunk)
    })

    child.on('error', (err: Error) => {
      spawnErrorMessage = err.message
      // ENOENT 等致命失败后 'close' 不保证触发，立即收敛；
      // settled 守卫保证随后到来的 'close' 被忽略。
      settle()
    })

    child.on('close', (code: number | null) => {
      exitCode = typeof code === 'number' ? code : -1
      settle()
    })

    timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill()
      } catch {
        // 进程可能已退出，忽略
      }
    }, timeoutMs)
  })
}

// ---------------------------------------------------------------------------
// 交互窗口启动（docs/02 §2 规则 5，约束 #12）
// ---------------------------------------------------------------------------

export type LaunchKind = 'folder' | 'vscode' | 'terminal' | 'wsl'

/**
 * PowerShell 脚本表 —— 全部为静态字面量，禁止插入动态值（约束 #12）。
 * 目标路径一律经环境变量 $env:DH_TARGET 传入（由 run 的 options.env 注入）。
 * 导出仅供 smoke 做语法校验（不执行），调用方不得绕过 launchViaStartProcess 直接取用。
 */
export const LAUNCH_SCRIPTS: Record<LaunchKind, string> = {
  // 资源管理器打开目录
  folder: `Start-Process -FilePath 'explorer.exe' -ArgumentList ('"{0}"' -f $env:DH_TARGET)`,
  // VS Code：code 实际是 code.cmd，经 cmd 的 PATHEXT 解析；start "" 使其脱离本进程
  vscode: `Start-Process -FilePath 'cmd.exe' -ArgumentList '/d','/c','start','""','code',('"{0}"' -f $env:DH_TARGET) -WindowStyle Hidden`,
  // 终端：优先 Windows Terminal（wt -d <dir>），回退到停在该目录的 cmd
  terminal: `$wt = Get-Command 'wt.exe' -ErrorAction SilentlyContinue; if ($wt) { Start-Process -FilePath $wt.Source -ArgumentList '-d',('"{0}"' -f $env:DH_TARGET) } else { Start-Process -FilePath 'cmd.exe' -ArgumentList '/d','/k',('cd /d "{0}"' -f $env:DH_TARGET) }`,
  // WSL：打开默认发行版并 cd 到目标路径
  wsl: `Start-Process -FilePath 'wsl.exe' -ArgumentList '--cd',('"{0}"' -f $env:DH_TARGET)`,
}

/**
 * 通过 PowerShell Start-Process 打开交互窗口（不使用 detached+unref 组合）。
 * target 为目录或 WSL 路径；存在性校验由调用方（Service 层）负责。
 */
export function launchViaStartProcess(kind: LaunchKind, target: string): Promise<ExecResult> {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', LAUNCH_SCRIPTS[kind]], {
    env: { ...process.env, DH_TARGET: target },
  })
}

// ---------------------------------------------------------------------------
// 受控长驻/流式进程（docs/12 §3 spawnManaged 契约，裁决 1）
//
// 单次命令的 15s 强制 timeout（约束 #9）在长驻语义下细化为两个独立上限：
//   - 心跳空闲超时 idleTimeoutMs（任何 stdout/stderr 增量都重置心跳计时）；
//   - 总生命周期上限 lifetimeTimeoutMs（绝对天花板）。
// 触发任一上限 → killTree() 树杀 + ManagedExit.reason 标明——不存在无超时状态。
// 树杀复用 services/archive/procGuard.ts 的 taskkill /T → /T /F 范本（taskkill
// 参数数组经本模块自身的 run()，约束 #7/#8/#12 不受影响）。
// 本节所有形态仍受约束 #7-#10 管辖：参数数组 + shell:false + windowsHide:true；
// spawn 同步异常折叠为 exited('spawn-error')，不 throw。
// ---------------------------------------------------------------------------

export interface ManagedProcessOptions {
  /** 心跳空闲超时：连续 idleTimeoutMs 无任何 stdout/stderr 增量 → 树杀收尾。默认 30_000。 */
  idleTimeoutMs?: number
  /** 总生命周期上限：无论是否活跃，超时即树杀收尾。默认 600_000，必须允许显式放宽。 */
  lifetimeTimeoutMs?: number
  /** 子进程工作目录，透传给 spawn。 */
  cwd?: string
  /** 子进程环境变量；不传则继承父进程。 */
  env?: NodeJS.ProcessEnv
  /** 需要 stdin 注入（reply 通道）时开启；默认 false。 */
  stdinWritable?: boolean
  /** 增量回调（按行缓冲解码后回调；沿用 run() 的 BOM 双解码规则）。 */
  onStdout?: (line: string) => void
  onStderr?: (line: string) => void
}

export interface ManagedExit {
  code: number | null
  signal: NodeJS.Signals | null
  reason: 'exit' | 'idle-timeout' | 'lifetime-timeout' | 'spawn-error'
  /** 尾部 8KB（结构化返回，约束 #10）。 */
  stderrTail: string
  durationMs: number
}

export interface ManagedProcess {
  /** 子进程 pid；spawn 失败时为 -1。 */
  readonly pid: number
  /**
   * stdin 注入（仅 stdinWritable=true 时可用；写入前进程已退出 → 结构化失败，不抛）。
   */
  writeStdin(text: string): { ok: boolean; error?: { code: string; message: string } }
  /**
   * 树杀：taskkill /PID <pid> /T 温和 → 2.5s 存活则 /T /F 强制（procGuard 范本，
   * 参数数组经本模块 run()）。pid 无效或进程已退出时幂等立即返回。
   */
  killTree(): Promise<void>
  readonly exited: Promise<ManagedExit>
}

const MANAGED_IDLE_DEFAULT_MS = 30_000
const MANAGED_LIFETIME_DEFAULT_MS = 600_000
/** 树杀温和段后存活判定窗口（procGuard 范本同值 2.5s）。 */
const TREE_KILL_GRACE_MS = 2500
/** stderr 尾部保留字节数（docs/12 §3 ManagedExit.stderrTail）。 */
const STDERR_TAIL_BYTES = 8 * 1024

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM' // 无权限但存在
  }
}

async function waitPidGone(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return !isPidAlive(pid)
}

/**
 * BOM 感知行切分器：沿用 run() 的 BOM 双解码规则（FF FE → UTF-16LE，否则 UTF-8），
 * 首个 U+FEFF 剥离；StringDecoder 处理跨 chunk 的多字节/UTF-16 代理对边界。
 * 行缓冲携带不完整尾行直到换行或退出时冲刷（docs/12 §3 语义 4）。
 */
class BomAwareLineSplitter {
  private readonly onLine: (line: string) => void
  private decoder: StringDecoder | null = null
  private bomBuf: Buffer = Buffer.alloc(0)
  private pending = ''
  private bomStripped = false

  constructor(onLine: (line: string) => void) {
    this.onLine = onLine
  }

  push(chunk: Buffer): void {
    if (this.decoder === null) {
      this.bomBuf = Buffer.concat([this.bomBuf, chunk])
      if (this.bomBuf.length < 2) return // BOM 判定至少需要 2 字节
      const enc = this.bomBuf[0] === 0xff && this.bomBuf[1] === 0xfe ? 'utf16le' : 'utf8'
      this.decoder = new StringDecoder(enc)
      chunk = this.bomBuf
      this.bomBuf = Buffer.alloc(0)
    }
    let text = this.decoder.write(chunk)
    if (!this.bomStripped) {
      text = text.replace(/^\uFEFF/, '')
      this.bomStripped = true
    }
    this.pending += text
    let idx = this.pending.indexOf('\n')
    while (idx >= 0) {
      const raw = this.pending.slice(0, idx)
      this.pending = this.pending.slice(idx + 1)
      this.onLine(raw.endsWith('\r') ? raw.slice(0, -1) : raw)
      idx = this.pending.indexOf('\n')
    }
  }

  /** 退出冲刷：解码器残留 + 不完整尾行（docs/12 §3 语义 4）。 */
  flush(): void {
    if (this.decoder !== null) {
      const rest = this.decoder.end()
      if (rest.length > 0) this.pending += rest
    }
    if (this.pending.length > 0) {
      const tail = this.pending
      this.pending = ''
      this.onLine(tail.endsWith('\r') ? tail.slice(0, -1) : tail)
    }
  }
}

/**
 * 受控长驻/流式进程启动（docs/12 §3 契约全文）。参数数组、无 shell、隐藏窗口；
 * 双超时上限（心跳空闲 + 总生命周期）触发即 killTree 收尾；行回调保证顺序；
 * spawn 失败（同步抛出或异步 error 事件）折叠为 exited('spawn-error')，不 throw。
 */
export function spawnManaged(command: string, args: string[], options: ManagedProcessOptions = {}): ManagedProcess {
  const idleTimeoutMs = options.idleTimeoutMs ?? MANAGED_IDLE_DEFAULT_MS
  const lifetimeTimeoutMs = options.lifetimeTimeoutMs ?? MANAGED_LIFETIME_DEFAULT_MS

  const startedAt = Date.now()
  let settled = false
  let timeoutReason: 'idle-timeout' | 'lifetime-timeout' | null = null
  let spawnErrorMessage: string | null = null
  let exitCode: number | null = null
  let exitSignal: NodeJS.Signals | null = null
  let killInProgress = false
  const stderrBytes: Buffer[] = []
  let stderrTotal = 0

  let resolveExited!: (exit: ManagedExit) => void
  const exited = new Promise<ManagedExit>((resolve) => {
    resolveExited = resolve
  })

  let idleTimer: NodeJS.Timeout | null = null
  let lifetimeTimer: NodeJS.Timeout | null = null
  const clearTimers = (): void => {
    if (idleTimer !== null) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
    if (lifetimeTimer !== null) {
      clearTimeout(lifetimeTimer)
      lifetimeTimer = null
    }
  }
  const resetIdle = (): void => {
    if (idleTimer !== null) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      idleTimer = null
      if (settled) return
      timeoutReason = 'idle-timeout'
      void internalKillTree()
    }, idleTimeoutMs)
  }

  const stdoutSplitter = new BomAwareLineSplitter((line) => {
    if (options.onStdout !== undefined && !settled) options.onStdout(line)
  })
  const stderrSplitter = new BomAwareLineSplitter((line) => {
    if (options.onStderr !== undefined && !settled) options.onStderr(line)
  })

  const pushStderrBytes = (chunk: Buffer): void => {
    stderrBytes.push(chunk)
    stderrTotal += chunk.length
    while (stderrTotal > STDERR_TAIL_BYTES * 2) {
      const first = stderrBytes[0]
      if (first === undefined) break
      stderrBytes.shift()
      stderrTotal -= first.length
    }
  }

  let child: ReturnType<typeof spawn> | null = null
  try {
    child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: [options.stdinWritable === true ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    })
  } catch (err) {
    // 参数非法等同步抛出的场景：折叠为 exited('spawn-error')，不 throw（约束 #10/#14）
    spawnErrorMessage = err instanceof Error ? err.message : String(err)
  }

  const pid: number = typeof child?.pid === 'number' ? (child.pid as number) : -1

  const settle = (reason?: 'spawn-error'): void => {
    if (settled) return
    settled = true
    clearTimers()
    if (reason === 'spawn-error') {
      resolveExited({
        code: null,
        signal: null,
        reason: 'spawn-error',
        stderrTail: spawnErrorMessage ?? 'spawn failed',
        durationMs: Date.now() - startedAt,
      })
      return
    }
    stdoutSplitter.flush()
    stderrSplitter.flush()
    const tail = Buffer.concat(stderrBytes).subarray(-STDERR_TAIL_BYTES)
    let stderrTail = tail.toString('utf8').replace(/^\uFEFF/, '')
    if (spawnErrorMessage !== null && stderrTail.trim().length === 0) {
      stderrTail = spawnErrorMessage
    }
    resolveExited({
      code: exitCode,
      signal: exitSignal,
      reason: timeoutReason ?? 'exit',
      stderrTail,
      durationMs: Date.now() - startedAt,
    })
  }

  const internalKillTree = async (): Promise<void> => {
    if (killInProgress) return
    killInProgress = true
    try {
      if (!isPidAlive(pid)) return
      await run('taskkill', ['/PID', String(pid), '/T'], { timeoutMs: 8000 })
      if (await waitPidGone(pid, TREE_KILL_GRACE_MS)) return
      await run('taskkill', ['/PID', String(pid), '/T', '/F'], { timeoutMs: 8000 })
      await waitPidGone(pid, 3000)
    } catch {
      // taskkill 本身失败（权限等）：交给退出事件收敛，不向上抛
    } finally {
      killInProgress = false
    }
  }

  if (child !== null) {
    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return
      resetIdle()
      stdoutSplitter.push(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (settled) return
      resetIdle()
      pushStderrBytes(chunk)
      stderrSplitter.push(chunk)
    })
    child.on('error', (err: Error) => {
      // ENOENT 等致命失败后 'close' 不保证触发：立即收敛（spawn-error）；
      // settled 守卫保证随后到来的 'close' 被忽略。
      spawnErrorMessage = err.message
      settle('spawn-error')
    })
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      exitCode = code
      exitSignal = signal
      settle()
    })
  } else {
    // 同步 spawn 失败：无进程、无事件，立即折叠
    settle('spawn-error')
  }

  if (!settled) {
    resetIdle()
    lifetimeTimer = setTimeout(() => {
      lifetimeTimer = null
      if (settled) return
      timeoutReason = 'lifetime-timeout'
      void internalKillTree()
    }, lifetimeTimeoutMs)
  }

  return {
    pid,
    writeStdin(text: string): { ok: boolean; error?: { code: string; message: string } } {
      if (spawnErrorMessage !== null) {
        return { ok: false, error: { code: 'SPAWN_ERROR', message: spawnErrorMessage } }
      }
      if (options.stdinWritable !== true || child === null || child.stdin === null) {
        return {
          ok: false,
          error: { code: 'STDIN_NOT_WRITABLE', message: 'stdinWritable was not enabled for this managed process' },
        }
      }
      if (settled || child.stdin.writableEnded || child.stdin.destroyed) {
        return { ok: false, error: { code: 'STDIN_CLOSED', message: 'managed process stdin is closed (process exited)' } }
      }
      try {
        child.stdin.write(text)
        return { ok: true }
      } catch (err) {
        return {
          ok: false,
          error: { code: 'STDIN_WRITE_FAILED', message: err instanceof Error ? err.message : String(err) },
        }
      }
    },
    killTree: internalKillTree,
    exited,
  }
}
