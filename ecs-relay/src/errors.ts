/**
 * errors.ts — 结构化错误与 docs/18 §8.2 映射（统一形态：{error:{code,message}}，零堆栈零凭据）。
 *
 * 新码（Relay 域 append-only，docs/18 §8.2）：PAIRING_INVALID_CODE / PAIRING_CODE_EXPIRED /
 * PAIRING_CODE_VOIDED / RELAY_UPSTREAM_OFFLINE / RELAY_UPSTREAM_TIMEOUT / RELAY_REST_READONLY /
 * RELAY_QUEUE_FULL / RELAY_DEVICE_UNKNOWN / RELAY_HOST_UNKNOWN。
 */

/** HTTP 状态映射（REST 面；docs/18 §8.2 列「HTTP（REST 面）」）。 */
const HTTP_STATUS: Record<string, number> = {
  AUTH_INVALID_TOKEN: 401,
  DEVICE_REVOKED: 401,
  DEVICE_NOT_PAIRED: 401,
  AUTH_REPLAYED: 401,
  AUTH_RATE_LIMITED: 429,
  BAD_PAYLOAD: 400,
  NOT_FOUND: 404,
  AGENT_CAPABILITY_MISSING: 403,
  COMMAND_NOT_EXECUTABLE: 403,
  COMMAND_KEY_CONFLICT: 409,
  COMMAND_EXPIRED: 409,
  AGENT_PROVIDER_UNAVAILABLE: 503,
  AGENT_MONITOR_DISABLED: 409,
  AGENT_PROVIDER_DISABLED: 409,
  AGENT_SOURCE_UNREADABLE: 503,
  GATEWAY_DISABLED: 503,
  INTERNAL: 500,
  PAIRING_INVALID_CODE: 400,
  PAIRING_CODE_EXPIRED: 400,
  PAIRING_CODE_VOIDED: 400,
  RELAY_UPSTREAM_OFFLINE: 503,
  RELAY_UPSTREAM_TIMEOUT: 504,
  RELAY_REST_READONLY: 405,
  RELAY_QUEUE_FULL: 503,
  RELAY_DEVICE_UNKNOWN: 401,
  RELAY_HOST_UNKNOWN: 401,
}

/** 业务级错误（只回 error/*_ack 帧，不断连）；协议级违规仍走 close 1002/1003（docs/18 §3.16）。 */
const RETRYABLE = new Set(['RELAY_UPSTREAM_OFFLINE', 'RELAY_UPSTREAM_TIMEOUT'])

export class RelayError extends Error {
  readonly code: string
  readonly retryAfterSec?: number

  constructor(code: string, message: string, retryAfterSec?: number) {
    super(message)
    this.name = 'RelayError'
    this.code = code
    this.retryAfterSec = retryAfterSec
  }

  get httpStatus(): number {
    return HTTP_STATUS[this.code] ?? 500
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.code)
  }
}

/** REST/升级拒绝响应体（docs/14 Part C 形态原样：{error:{code,message}}）。 */
export function errorBody(code: string, message: string, extra: Record<string, unknown> = {}): {
  error: { code: string; message: string } & Record<string, unknown>
} {
  return { error: { code, message, ...extra } }
}

/** WS error 帧构造（docs/18 §3.16：零凭据零堆栈）。 */
export function errorFrame(
  code: string,
  message: string,
  options: { requestId?: string; retryAfterSec?: number } = {},
): { type: 'error'; code: string; message: string; requestId?: string; retryable?: boolean; retryAfterSec?: number } {
  const frame: { type: 'error'; code: string; message: string; requestId?: string; retryable?: boolean; retryAfterSec?: number } = {
    type: 'error',
    code,
    message,
  }
  if (options.requestId !== undefined) frame.requestId = options.requestId
  if (RETRYABLE.has(code)) frame.retryable = true
  if (options.retryAfterSec !== undefined) frame.retryAfterSec = options.retryAfterSec
  return frame
}
