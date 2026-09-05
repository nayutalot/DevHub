/**
 * backoff.ts — 重连指数退避计算器（M2-R1 模块 2/8，docs/19 §4.2）。
 *
 * **行为规格移植自 Android `core/Backoff.kt`**（docs/19 §4.2「参数与 docs/14 §B.2
 * 断线行一致」）：1s → 2s → 4s → 8s → 16s → 32s → 封顶 60s，±20% jitter。
 * 语义逐条镜像（防三线漂移，R1×R3 对拍基础）：
 * - `delayMsForAttempt(attempt)` = base·2^(attempt-1) 封顶 60s × jitter 因子；
 *   封顶后停止翻倍（防溢出，Kotlin 同款 while 结构）；
 * - jitter：r = randomSource() ∈ [0,1] 强制收敛 → 因子 = 1 - f + 2f·r
 *   → [base·(1-f), base·(1+f)]；截断 = Kotlin `.toLong()` 的向零截断（Math.trunc）；
 * - `reset()`：连接成功归零（下次回到 base 1s）——状态机 hello/ready 转换时调用；
 * - randomSource 注入缝：测试固定值断言 jitter 边界（Backoff.kt 同名缝）。
 *
 * 纯逻辑零 I/O 零 electron——smoke 系统 Node 直载断言重连退避参数
 * （docs/20 §2.1 R1 验收线①「重连退避参数」）。
 */

/** 基础延迟（1s，docs/14 §B.2 断线行）。 */
export const BACKOFF_BASE_DELAY_MS = 1_000
/** 封顶延迟（60s）。 */
export const BACKOFF_MAX_DELAY_MS = 60_000
/** jitter 比例（±20%）。 */
export const BACKOFF_JITTER_FRACTION = 0.2

export interface BackoffOptions {
  baseDelayMs?: number
  maxDelayMs?: number
  jitterFraction?: number
  /** 注入缝：返回 [0,1) 随机数；测试固定值以断言 jitter 边界。 */
  randomSource?: () => number
}

export class BackoffCalculator {
  private attempt = 0
  // 显式字段赋值（不用 TS 参数属性——Node strip-only 模式不支持
  // ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX，smoke 系统 Node 直载 .ts 必须 strip-only 可加载）
  private readonly baseDelayMs: number
  private readonly maxDelayMs: number
  private readonly jitterFraction: number
  private readonly randomSource: () => number

  constructor(options: BackoffOptions = {}) {
    this.baseDelayMs = options.baseDelayMs ?? BACKOFF_BASE_DELAY_MS
    this.maxDelayMs = options.maxDelayMs ?? BACKOFF_MAX_DELAY_MS
    this.jitterFraction = options.jitterFraction ?? BACKOFF_JITTER_FRACTION
    this.randomSource = options.randomSource ?? Math.random
  }

  /** 重连成功：计数归零（下次 nextDelayMs 回到 base）。 */
  reset(): void {
    this.attempt = 0
  }

  /** 当前连续失败计数（诊断投影用）。 */
  get attempts(): number {
    return this.attempt
  }

  /** 下一次重连延迟（连续失败第 n 次；每次失败后调用一次，内部计数 +1）。 */
  nextDelayMs(): number {
    this.attempt += 1
    return this.delayMsForAttempt(this.attempt)
  }

  /**
   * 第 attempt 次失败后的延迟：base = min(base·2^(attempt-1), cap)
   * （封顶前最多 log2(cap/base) 步，封顶后停止翻倍）；jitter 因子
   * = 1 - f + 2f·r，r∈[0,1] → [base·(1-f), base·(1+f)]；向零截断（Kotlin toLong）。
   */
  delayMsForAttempt(attempt: number): number {
    if (!Number.isSafeInteger(attempt) || attempt < 1) {
      throw new RangeError(`attempt must be >= 1, got ${attempt}`)
    }
    let base = this.baseDelayMs
    let shift = attempt - 1
    while (shift > 0 && base < this.maxDelayMs) {
      base = Math.min(base * 2, this.maxDelayMs)
      shift -= 1
    }
    base = Math.min(base, this.maxDelayMs)
    const raw = this.randomSource()
    const r = Math.min(1, Math.max(0, raw))
    const factor = 1 - this.jitterFraction + 2 * this.jitterFraction * r
    return Math.max(0, Math.trunc(base * factor))
  }
}
