/**
 * contestRules.ts — ContestPin 域内共享校验规则（CP3b 批次，任务书 §2.3 #9：
 * "复用 contestService 同款规则抽出的共享校验函数"）。
 *
 * - 纯函数、零 IO、零 DB：contestService（CP1 CRUD）与 importPipeline（CP3b
 *   识别结果校验）共用同一实现，避免规则漂移。
 * - 时间语义权威 = docs/22 §2.2（precision 四值 × startAt/endAt 组合约束）。
 * - 错误统一 ServiceError('BAD_PAYLOAD')，消息文本与 contestService 原实现
 *   逐字一致（smoke 子串断言锚定）。
 */

import { ServiceError } from '../internal.ts'
import type { ContestNodePrecision } from '../../../shared/types.ts'

export const CONTEST_YEAR_MIN = 1990
export const CONTEST_YEAR_MAX = 2100

/** year 可空；给定时 1990..2100 整数（消息与 contestService 原实现一致）。 */
export function validateContestYear(year: number | null | undefined, when: string): number | null {
  if (year === undefined || year === null) return null
  if (!Number.isSafeInteger(year) || year < CONTEST_YEAR_MIN || year > CONTEST_YEAR_MAX) {
    throw new ServiceError('BAD_PAYLOAD', `${when}: year must be an integer within ${CONTEST_YEAR_MIN}..${CONTEST_YEAR_MAX} when present`)
  }
  return year
}

/**
 * 精度/时刻组合校验（docs/22 §2.2 权威语义，消息与 contestService 原实现一致）：
 *  - 'tbd' → startAt/endAt 恒 NULL；
 *  - 'exact'/'date'/'month' → startAt 必填；
 *  - endAt 给定时 ≥ startAt。
 */
export function validateNodePrecisionState(
  precision: ContestNodePrecision,
  startAt: number | null,
  endAt: number | null,
  when: string,
): void {
  if (precision === 'tbd') {
    if (startAt !== null || endAt !== null) {
      throw new ServiceError('BAD_PAYLOAD', `${when}: precision='tbd' requires startAt/endAt to be null (time TBD)`)
    }
    return
  }
  if (startAt === null) {
    throw new ServiceError('BAD_PAYLOAD', `${when}: precision='${precision}' requires startAt`)
  }
  if (endAt !== null && endAt < startAt) {
    throw new ServiceError('BAD_PAYLOAD', `${when}: endAt must be >= startAt when present`)
  }
}

/** URL 形状：仅 http/https 绝对 URL 且无空白（与 contestService.validateUrl 同款判定）。 */
export function isValidContestHttpUrl(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.length === 0) return false
  return /^https?:\/\/\S+$/i.test(trimmed)
}
