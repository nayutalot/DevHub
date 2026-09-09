/**
 * reviewClient.ts — LLM 复核层 OpenAI 兼容 Chat Completions 客户端（LR1 批次，
 * docs/briefs/lr1-llm-review.md §2/§6）。
 *
 * - electron-free 纯 Node 模块，零新依赖（默认传输 = 原生 fetch + AbortSignal
 *   30s 超时）；**与 ContestPin openaiClient 不耦合不复用**（任务书裁决：本层
 *   = 纯文本 / 无鉴权 / lan 端点 / 四态 envelope 的独立轻实现，docs/22 §6 同款裁决）。
 * - **传输注入**：ReviewTransport = (url, init) => { status, bodyText }；生产语境
 *   用默认 fetch 实现，smoke / 测试一律 setReviewTransport(fake) 注入假传输——
 *   **零真实网络**（cp3a 同范式）。
 * - **v1 零鉴权**：请求头恒不带 Authorization（端点 = 用户自备局域网
 *   OpenAI chat/completions 兼容服务，占位 http://<lan-ip>:11434/v1）；请求体
 *   只含 model/messages/stream，绝无 key 字段（prompt 红线：零文件内容零 key）。
 * - **非流式**；超时 30s（任务书 §2 固定值，超时由 service 折叠为
 *   failed/skipped 语义，永不打断归档主流程）。
 * - 返回判别联合：{ ok:true, content, latencyMs } | { ok:false, failure }，
 *   failure.kind 四分类 HTTP_ERROR | TIMEOUT | NETWORK | BAD_RESPONSE——
 *   比 ContestPin 六分类少 AUTH/RATE_LIMIT（无鉴权面，429 归 HTTP_ERROR 语义），
 *   envelope 四态归并（ok/skipped/failed/unparseable）在 reviewService 完成。
 */

/** 单次复核调用配置（settings 双键 + 超时缺省 30s）。 */
export interface ReviewClientConfig {
  /** OpenAI 兼容端点基底（http://<lan-ip>:11434/v1 或已带 /chat/completions 的完整 URL）。 */
  baseUrl: string
  model: string
  /** 缺省 30000（任务书 §2 固定 30s）。 */
  timeoutMs?: number
}

/** 失败四分类（无鉴权面 → 无 AUTH；限流归 HTTP_ERROR 携带 status）。 */
export type ReviewFailureKind = 'HTTP_ERROR' | 'TIMEOUT' | 'NETWORK' | 'BAD_RESPONSE'

/** 结构化失败：message 为简短摘要（≤200 字符），绝无 key/文件内容（本层本就不持有）。 */
export interface ReviewFailure {
  kind: ReviewFailureKind
  /** HTTP_ERROR 时的 HTTP 状态码；其余分类恒 undefined。 */
  status?: number
  message: string
}

export type ReviewChatResult =
  | { ok: true; content: string; latencyMs: number }
  | { ok: false; failure: ReviewFailure; latencyMs: number }

/**
 * 传输接口：唯一出站点。返回原始 status 与 body 文本，由客户端统一分类；
 * smoke 注入 fake 后全程零联网（时窗红线）。
 */
export type ReviewTransport = (url: string, init: RequestInit) => Promise<{ status: number; bodyText: string }>

/** 任务书 §2 固定超时：30s（超时按 failed/skipped 语义落 envelope，不阻塞主流程）。 */
export const REVIEW_TIMEOUT_MS = 30_000

/** 默认传输 = 原生 fetch（读 body 文本）；仅生产语境可达，测试一律注入 fake。 */
function defaultReviewTransport(url: string, init: RequestInit): Promise<{ status: number; bodyText: string }> {
  return fetch(url, init).then(async (res) => ({ status: res.status, bodyText: await res.text() }))
}

let activeTransport: ReviewTransport | null = null

/** 注入 fake 传输（smoke/测试）；传 null 恢复默认 fetch 实现。 */
export function setReviewTransport(transport: ReviewTransport | null): void {
  activeTransport = transport
}

/** 当前传输（未注入 = 默认 fetch）。 */
export function getReviewTransport(): ReviewTransport {
  return activeTransport ?? defaultReviewTransport
}

/**
 * URL 规范化：baseUrl 去尾斜杠后，若已以 /chat/completions 结尾则原样用，否则追加。
 * 兼容 `http://x:11434/v1`、`http://x:11434/v1/` 与 `http://x:11434/v1/chat/completions`
 * 三种写法（与 ContestPin 归一语义一致，独立实现）。
 */
export function normalizeReviewChatUrl(rawBaseUrl: string): string {
  const trimmed = rawBaseUrl.trim().replace(/\/+$/, '')
  return trimmed.endsWith('/chat/completions') ? trimmed : `${trimmed}/chat/completions`
}

/** 摘要：压平空白并截断（≤200 字符），防超长服务端错误体刷屏（无 key 可打码）。 */
function summarizeBodyText(bodyText: string, max = 200): string {
  const text = bodyText.replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** fetch reject / abort → 四分类（AbortError/TimeoutError → TIMEOUT，其余 → NETWORK）。 */
function classifyTransportError(err: unknown): ReviewFailure {
  const name = err instanceof Error ? err.name : ''
  if (name === 'AbortError' || name === 'TimeoutError') {
    return { kind: 'TIMEOUT', message: '请求超时或被取消（30s，AbortError/TimeoutError）' }
  }
  const detail = err instanceof Error ? err.message : String(err)
  return { kind: 'NETWORK', message: `网络请求失败：${summarizeBodyText(detail)}` }
}

export interface ReviewChatMessage {
  role: 'system' | 'user'
  content: string
}

/**
 * Chat Completions 非流式调用（纯文本消息，无鉴权头）。POST {model, messages, stream:false}；
 * 错误四分类（见文件头）。本客户端只做传输与响应形状，不解释业务 JSON——
 * 模型回复的 JSON 解析与结构校验归 reviewService（unparseable 态判定）。
 */
export async function reviewChatCompletion(
  config: ReviewClientConfig,
  messages: readonly ReviewChatMessage[],
): Promise<ReviewChatResult> {
  const startedAt = Date.now()
  const url = normalizeReviewChatUrl(config.baseUrl)
  // 请求体只含 model/messages/stream —— 零 key 字段（任务书 §6 prompt 红线的传输半边）
  const body = JSON.stringify({ model: config.model, messages, stream: false })
  // v1 零鉴权：恒不带 Authorization（将来引入鉴权时凭据走 safeStorage，绝不进本层明文参数）
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }

  const timeoutSignal = AbortSignal.timeout(config.timeoutMs ?? REVIEW_TIMEOUT_MS)

  let status: number
  let bodyText: string
  try {
    const res = await getReviewTransport()(url, { method: 'POST', headers, body, signal: timeoutSignal })
    status = res.status
    bodyText = res.bodyText
  } catch (err) {
    return { ok: false, failure: classifyTransportError(err), latencyMs: Date.now() - startedAt }
  }
  const latencyMs = Date.now() - startedAt

  // 非 2xx → HTTP_ERROR（带 status；429 限流同归此类，message 保留状态码供文案）
  if (status < 200 || status >= 300) {
    return {
      ok: false,
      failure: { kind: 'HTTP_ERROR', status, message: `服务返回 HTTP ${status}：${summarizeBodyText(bodyText) || '无响应体'}` },
      latencyMs,
    }
  }

  // 2xx：解析 JSON → choices[0].message.content 必须是非空字符串，缺任一 → BAD_RESPONSE
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    return { ok: false, failure: { kind: 'BAD_RESPONSE', message: `响应不是合法 JSON：${summarizeBodyText(bodyText) || '空响应体'}` }, latencyMs }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, failure: { kind: 'BAD_RESPONSE', message: '响应 JSON 顶层不是对象' }, latencyMs }
  }
  const record = parsed as Record<string, unknown>
  const choices = record.choices
  if (!Array.isArray(choices) || choices.length === 0) {
    return { ok: false, failure: { kind: 'BAD_RESPONSE', message: '响应缺少 choices 数组或为空' }, latencyMs }
  }
  const first = choices[0]
  if (typeof first !== 'object' || first === null) {
    return { ok: false, failure: { kind: 'BAD_RESPONSE', message: 'choices[0] 不是对象' }, latencyMs }
  }
  const message = (first as Record<string, unknown>).message
  if (typeof message !== 'object' || message === null) {
    return { ok: false, failure: { kind: 'BAD_RESPONSE', message: 'choices[0].message 缺失' }, latencyMs }
  }
  const content = (message as Record<string, unknown>).content
  if (typeof content !== 'string' || content.trim().length === 0) {
    return { ok: false, failure: { kind: 'BAD_RESPONSE', message: 'choices[0].message.content 不是非空字符串' }, latencyMs }
  }
  return { ok: true, content, latencyMs }
}
