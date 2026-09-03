/**
 * projection.ts — MCP 输出红线与投影工具（docs/08 §10.5、§6.6、§7）。
 *
 * - 自由文本字段（commandLine / reason / detail / errorSummary / Markdown 内嵌文本）
 *   统一 截断 ≤ 500 字符 + 敏感赋值打码（password= / token= / SECRET 等值段 → ***）；
 * - sanitizeDeep 对 tool 出参做深度遍历（结构化字段原样，字符串统一过红线）；
 * - project 归因规整：undefined / 空 → 字面量 'unknown'，绝不就近猜测（§6.6 铁律）；
 * - 路径归一键复用 services/internal.ts 的共享实现（§10.3，单一来源）；
 * - Markdown 表格小助手供 resources/* 渲染复用（§7 渲染规则）。
 */

import { normalizePathKey } from '../services/internal.ts'

export { normalizePathKey }

/** 自由文本字段截断上限（docs/08 §10.5）。 */
export const FREE_TEXT_LIMIT = 500
/** 人类可读摘要文本的安全上限（摘要由已过红线的字段拼装，此处只防病态输出）。 */
export const SUMMARY_TEXT_LIMIT = 8000
/** Markdown 表格单元格的紧凑截断（≤ 上限 500，表格可读性优先）。 */
export const TABLE_CELL_LIMIT = 120

/** 敏感赋值模式：password=/token=/secret=/api_key=/authorization= 等值段打码。 */
const SENSITIVE_ASSIGNMENT =
  /(password|passwd|pwd|token|secret|api[_-]?key|authorization|credential)\s*[=:]\s*("[^"]*"|'[^']*'|[^\s;"']+)/gi

/** 敏感赋值打码：值段（含引号包裹形态）统一替换为 ***。 */
export function redactSecrets(text: string): string {
  return text.replace(SENSITIVE_ASSIGNMENT, (_match: string, key: string) => `${key}=***`)
}

/** 截断：超限时保留前 max-1 字符并以 … 结尾（输出长度恰 ≤ max）。 */
export function truncateText(text: string, max: number = FREE_TEXT_LIMIT): string {
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

/** 自由文本红线：打码 + 截断；undefined 透传。 */
export function sanitizeFreeText(value: string | undefined, max: number = FREE_TEXT_LIMIT): string | undefined {
  if (value === undefined) return undefined
  return truncateText(redactSecrets(value), max)
}

/**
 * 深度出参红线：递归处理对象 / 数组，所有字符串值打码 + 截断；
 * number / boolean / null / undefined 原样保留（结构化字段无损）。
 */
export function sanitizeDeep<T>(value: T): T {
  if (typeof value === 'string') {
    return truncateText(redactSecrets(value)) as unknown as T
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeDeep(item)) as unknown as T
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = sanitizeDeep(item)
    }
    return out as unknown as T
  }
  return value
}

/**
 * project 归因规整（docs/08 §6.6）：undefined / 空 → 字面量 'unknown'。
 * 归因不到必须显式 unknown，禁止猜测。
 */
export function unknownableName(value: string | undefined | null): string {
  return value !== undefined && value !== null && value.length > 0 ? value : 'unknown'
}

/** unix 秒 → 人类可读相对时间（Markdown services/projects 渲染用）。 */
export function relativeTime(seconds: number | undefined | null, now: number = Math.floor(Date.now() / 1000)): string {
  if (seconds === undefined || seconds === null || seconds <= 0) return 'never'
  const delta = Math.max(0, now - seconds)
  if (delta < 60) return 'just now'
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`
  return `${Math.floor(delta / 86400)}d ago`
}

// ---------------------------------------------------------------------------
// Markdown 渲染助手（docs/08 §7：纯文本 Markdown、无 HTML、每节带来源标注）
// ---------------------------------------------------------------------------

/** 单元格净化：单行化 + 打码 + 截断 + 竖线转义。 */
export function mdCell(value: string | number | undefined | null, max: number = TABLE_CELL_LIMIT): string {
  if (value === undefined || value === null) return '—'
  const oneLine = redactSecrets(String(value)).replace(/\s+/g, ' ').trim()
  return truncateText(oneLine.length > 0 ? oneLine : '—', max).replace(/\|/g, '\\|')
}

/** 管道表格：表头 + 分隔行 + 数据行；空数据时输出一行 — 占位（列数对齐）。 */
export function mdTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const header = `| ${headers.join(' | ')} |`
  const separator = `| ${headers.map(() => '---').join(' | ')} |`
  if (rows.length === 0) {
    return [header, separator, `| ${headers.map(() => '—').join(' | ')} |`].join('\n')
  }
  const body = rows.map((row) => `| ${row.join(' | ')} |`).join('\n')
  return [header, separator, body].join('\n')
}

/** 来源标注行：DB 快照（unix 秒）或 live probe。 */
export function mdSource(snapshotAt?: number): string {
  return snapshotAt !== undefined ? `_source: snapshot at ${snapshotAt}_` : '_source: live probe_'
}
