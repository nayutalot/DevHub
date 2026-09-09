/**
 * wake.ts — RemoteWake 执行器（RW0，docs/18 §3.17）：relay 原生「唤醒 Windows」帧对的
 * 执行面（electron 无关纯 Node）。复用用户已实测打通的 wake-win 路径（主控更正 2026-09-09）：
 * 默认 `ssh pi wake-windows`（HostName/Port/User/密钥全在 ECS ~/.ssh/config 的 `pi` 别名层，
 * 仓库与代码零凭据零端点字面量）；env WAKE_COMMAND 可覆盖（如 /usr/local/bin/wake-win wrapper）。
 *
 * 执行链（docs/18 §3.17 门控序）：disabled 检查 → 每设备冷却窗（内存态，重启清零——
 * 限流三件套同款纪律）→ 快路径（host leg 在线 → already_on 零执行）→ spawn 固定命令。
 *
 * 红线：
 * - 本侧参数数组 spawn（shell 恒 false），零 shell 拼接；WAKE_COMMAND 按空白切分为 argv
 *   （契约：命令不得依赖引号分组语义——ssh config/wrapper 层已吸收全部参数）；
 * - 凭据零字面量：key/token 值绝不入仓/入 env 值/入日志/入审计/入帧；
 * - 审计 detail 零凭据零 argv 零 stderr（约束 #13 同款——只允许 status/latency/exitCode/
 *   timedOut 结果与计数类字段）；
 * - exec_failed 携带的 stderrSummary 必须截断 + 脱敏（redactStderrSummary），绝不原样回传。
 *
 * 测试缝：runner 注入式（defaultWakeRunner = node:child_process spawn，AbortSignal 超时）；
 * 单测全走 fake runner，真实 SSH 路径不在单测范围（`pi` 别名是 ECS 机器级配置，
 * e2e 留主控部署后手工验证）。
 */
import { spawn } from 'node:child_process'
import type { RelayConfig } from './config.ts'
import type { Audit } from './audit.ts'

/** wake_result.status 全量枚举（docs/18 §3.17；业务级——绝不因本帧 close 连接）。 */
export type WakeStatus =
  | 'sent'
  | 'already_on'
  | 'disabled'
  | 'rate_limited'
  | 'exec_failed'
  | 'timeout'

/** execute() 结果（forwarder 据此拼 wake_result 帧；latencyMs 仅执行路径携带）。 */
export interface WakeResult {
  status: WakeStatus
  latencyMs?: number
  retryAfterMs?: number
  /** 仅 exec_failed：截断 + 脱敏后的 stderr 摘要（绝不含 key/token，redactStderrSummary）。 */
  stderrSummary?: string
}

/** 单次进程执行结果（code null = 信号终止/spawn 失败，无退出码）。 */
export interface WakeRunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

/**
 * 执行缝：argv 参数数组 + 整体超时。实现者必须以参数数组启动（零 shell）、
 * 永不 reject（错误映射为结果——绝不猜纪律的执行器侧投影）。
 */
export type WakeRunner = (argv: string[], options: { timeoutMs: number }) => Promise<WakeRunResult>

/** 进程整体上限（主控更正缺省 15s；AbortSignal.timeout 语义——到点杀进程归 timeout 态）。 */
const WAKE_EXEC_TIMEOUT_MS = 15_000
/** stdout/stderr 捕获上界（映射只需信号；防异常输出撑爆内存）。 */
const OUTPUT_CAPTURE_MAX_BYTES = 64 * 1024
/** stderrSummary 截断上界（帧字段，脱敏后再截）。 */
const STDERR_SUMMARY_MAX_CHARS = 200
/**
 * 秘密样形态（脱敏红线）：≥32 连续 base64/hex/jwt 样字符 → <redacted>。
 * 覆盖 SSH 公钥 blob（AAAA…）、指纹尾（SHA256: 后 43 字符）、token 样长串；
 * 误伤 benign 长词可接受（宁枉勿纵，帧面/日志面一致）。
 */
const SECRET_LIKE_PATTERN = /[A-Za-z0-9+/=_-]{32,}/g

/** stderr 摘要：先脱敏再截断（顺序不可换——截断不得制造半截秘密泄漏面）。 */
export function redactStderrSummary(text: string): string {
  const redacted = text.replace(SECRET_LIKE_PATTERN, '<redacted>')
  const flattened = redacted.replace(/\s+/g, ' ').trim()
  return flattened.length > STDERR_SUMMARY_MAX_CHARS ? `${flattened.slice(0, STDERR_SUMMARY_MAX_CHARS)}…` : flattened
}

/**
 * 默认执行器：node:child_process spawn，shell 恒不启用（options.shell 缺省 false），
 * 参数数组原样过 execve；stdin 关闭（无交互面）。超时经 AbortSignal.timeout
 * （到点杀进程 → close code null + timedOut=true）。spawn 失败（如命令不在 PATH）
 * → code null（映射为 exec_failed），绝不 reject。
 */
export const defaultWakeRunner: WakeRunner = (argv, options) =>
  new Promise<WakeRunResult>((resolve) => {
    let timedOut = false
    let settled = false
    const abort = AbortSignal.timeout(options.timeoutMs)
    abort.addEventListener('abort', () => {
      timedOut = true
    })
    const child = spawn(argv[0] ?? 'ssh', argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], signal: abort })
    const append = (sink: { value: string }, chunk: Buffer) => {
      if (sink.value.length < OUTPUT_CAPTURE_MAX_BYTES) sink.value += chunk.toString('utf8')
    }
    const out = { value: '' }
    const err = { value: '' }
    child.stdout?.on('data', (chunk: Buffer) => append(out, chunk))
    child.stderr?.on('data', (chunk: Buffer) => append(err, chunk))
    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      resolve({ code, stdout: out.value, stderr: err.value, timedOut })
    }
    child.on('close', (code) => finish(code))
    child.on('error', () => {
      // AbortError（超时杀进程）与 spawn 级失败都无退出码；timedOut 已由 abort 监听区分
      finish(null)
    })
  })

/**
 * exit code → status 映射（docs/18 §3.17 全量枚举，主控更正版）：
 * - 0 → sent（exit 0 = 已验证 wake-win 路径成功发出；WoL 为无回执 UDP，无人能承诺「已开机」）；
 * - timedOut（含 code null + 超时杀）→ timeout；
 * - 其余（非零 exit / spawn 失败 code null）→ exec_failed（帧附脱敏 stderrSummary）。
 */
export function mapRunToStatus(run: WakeRunResult): WakeStatus {
  if (run.code === 0) return 'sent'
  if (run.timedOut) return 'timeout'
  return 'exec_failed'
}

/**
 * 构造 argv（参数数组；本侧零 shell 拼接）：WAKE_COMMAND 按空白切分。
 * 调用前提：config.wakeEnabled === true（execute 已门控）。
 */
export function buildWakeArgv(config: RelayConfig): string[] {
  return config.wakeCommand.split(/\s+/).filter((part) => part.length > 0)
}

export class WakeExecutor {
  private readonly config: RelayConfig
  private readonly audit: Audit
  private readonly runner: WakeRunner
  /** 每设备上次尝试时刻（内存；重启清零——限流三件套同款纪律，docs/18 §3.17）。 */
  private readonly lastAttemptAtMs = new Map<number, number>()

  constructor(deps: { config: RelayConfig; audit: Audit; runner?: WakeRunner }) {
    this.config = deps.config
    this.audit = deps.audit
    this.runner = deps.runner ?? defaultWakeRunner
  }

  /** 测试探针：已登记冷却窗的设备数。 */
  debugAttemptCount(): number {
    return this.lastAttemptAtMs.size
  }

  /**
   * wake_host 门控执行（forwarder.handleWakeHost 调用；契约：绝不 throw——
   * 全部结果落 status）。hostOnline 由调用方注入（forwarder.hostOnline 快路径）。
   */
  async execute(deviceId: number, hostOnline: boolean, nowMs: number = Date.now()): Promise<WakeResult> {
    // ① enabled 门（缺省禁用）：未配置 → disabled，不进冷却窗
    if (!this.config.wakeEnabled) {
      this.audit.write({ category: 'wake', action: 'wake_attempt', outcome: 'denied', deviceId, detail: { status: 'disabled' } })
      return { status: 'disabled' }
    }
    // ② 冷却窗（先于快路径——已在线重复请求同样计入，防滥用面一致）
    const cooldownMs = this.config.wakeCooldownSec * 1000
    const last = this.lastAttemptAtMs.get(deviceId)
    if (last !== undefined) {
      const elapsed = nowMs - last
      if (elapsed < cooldownMs) {
        const retryAfterMs = cooldownMs - elapsed
        this.audit.write({ category: 'wake', action: 'wake_attempt', outcome: 'denied', deviceId, detail: { status: 'rate_limited', retryAfterMs } })
        return { status: 'rate_limited', retryAfterMs }
      }
    }
    this.lastAttemptAtMs.set(deviceId, nowMs)
    // ③ 快路径：桌面会话在线 → already_on 零执行（docs/18 §3.17：桌面离线才是主用例，反向亦然）
    if (hostOnline) {
      this.audit.write({ category: 'wake', action: 'wake_attempt', outcome: 'success', deviceId, detail: { status: 'already_on' } })
      return { status: 'already_on' }
    }
    // ④ spawn 固定命令（参数数组；latency 只计执行段）
    const argv = buildWakeArgv(this.config)
    const startedAt = Date.now()
    const run = await this.runner(argv, { timeoutMs: WAKE_EXEC_TIMEOUT_MS })
    const latencyMs = Date.now() - startedAt
    const status = mapRunToStatus(run)
    this.audit.write({
      category: 'wake',
      action: 'wake_attempt',
      outcome: status === 'sent' ? 'success' : 'error',
      deviceId,
      detail: { status, latencyMs, exitCode: run.code, timedOut: run.timedOut },
    })
    if (status === 'exec_failed') {
      // 帧面 stderr 摘要：截断 + 脱敏（审计面不带 stderr——#13 纪律更严）
      return { status, latencyMs, stderrSummary: redactStderrSummary(run.stderr) }
    }
    return { status, latencyMs }
  }
}
