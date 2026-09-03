/**
 * redact.ts — AC 域脱敏统一实现（docs/12 §9 文件布局：「redact.ts 脱敏统一实现
 * （尾 4 位 + 长度；密钥/Token/Cookie 模式）」；红线细则 docs/15 §6）。
 *
 * - maskKey：密钥类值的唯一对外投影形态 = 尾 4 位 + 长度（照
 *   src/main/services/apihub/keyStore.ts maskKey 同款形态；AC 域独立实现，
 *   不跨域 import ApiHub 模块）。Kimi config.toml 明文 api_key 的任何投影
 *   只允许经过本函数（docs/12 §8.3 红线）。
 * - redactText：自由文本中的敏感赋值值段打码（token= / secret= / password= 等
 *   → key=***，照 src/main/mcp/projection.ts redactSecrets 同款模式；含引号
 *   包裹形态）。agent_messages.content_redacted、agent_events.payload_json、
 *   事件 summary 一律先经本函数再落库（docs/13 §4.3/§4.4 注释）。
 *
 * electron-free：纯函数模块，可被 smoke 在系统 Node 下直接断言。
 */

/**
 * 统一 mask：只留尾 4 位与长度（对外投影唯一形态）。
 * 空串/超短值的长度照实返回，tail 可能为空串——调用方不得据此补造内容。
 */
export function maskKey(secret: string): { tail: string; len: number } {
  return { tail: secret.slice(-4), len: secret.length }
}

/** 敏感赋值模式：password=/token=/secret=/api_key=/authorization= 等值段打码。 */
const SENSITIVE_ASSIGNMENT =
  /(password|passwd|pwd|token|secret|api[_-]?key|authorization|credential)\s*[=:]\s*("[^"]*"|'[^']*'|[^\s;"']+)/gi

/**
 * 自由文本脱敏：敏感赋值的值段（含引号包裹形态）统一替换为 ***，键名保留。
 * 非敏感文本原样返回；幂等（已打码文本再过一遍不变）。
 */
export function redactText(text: string): string {
  return text.replace(SENSITIVE_ASSIGNMENT, (_match: string, key: string) => `${key}=***`)
}

/** 敏感键名模式（JSON 结构化负载的键级判定；redactValueDeep 复用）。 */
const SENSITIVE_KEY = /(password|passwd|pwd|token|secret|api[_-]?key|authorization|credential)/i

/**
 * 结构化负载深度脱敏：字符串值过 redactText；键名命中敏感模式（token/secret/
 * password/api_key 等）时整值替换为 ***（JSON 载荷的 "token":"v" 形态不带
 * 赋值符，redactText 正则不覆盖——键级判定兜底）。事件 payload_json 落库前
 * 一律经本函数（docs/13 §4.4 红线）。
 */
export function redactValueDeep(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value)
  if (Array.isArray(value)) return value.map((v) => redactValueDeep(v))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? '***' : redactValueDeep(v)
    }
    return out
  }
  return value
}
