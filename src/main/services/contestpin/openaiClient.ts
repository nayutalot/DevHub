/**
 * openaiClient.ts — ContestPin OpenAI 兼容 Chat Completions 客户端（CP3a 批次，
 * docs/22 §6 + 任务书 §2.1）。
 *
 * - electron-free 纯 Node 模块，零新依赖（传输默认 = 原生 fetch + AbortSignal
 *   超时，范式同 versionCenter/github.ts）；全仓首个 OpenAI 兼容客户端（首建）。
 * - **传输注入**：ChatTransport = (url, init) => { status, bodyText }；生产语境
 *   用默认 fetch 实现，smoke / 测试一律 setChatTransport(fake) 注入假传输——
 *   **零真实网络**。默认传输只在本模块未被注入时可达（生产 renderer 触发的
 *   configTest/识别调用路径），测试面永不触达。
 * - **错误分类（任务书二选一裁决：专用 result 判别联合，非 ServiceError）**：
 *   chatCompletion 返回
 *     { ok:true,  content, usage, latencyMs }
 *   | { ok:false, failure: { kind: AUTH|RATE_LIMIT|TIMEOUT|NETWORK|BAD_RESPONSE|
 *                            HTTP_ERROR, status?, message }, latencyMs }
 *   理由：单次调用需要区分六类失败并携带 status/简短摘要，判别联合让上层
 *   （recognitionConfigService 的连接测试落库与文案映射）逐类处理而不必逐类
 *   catch。IMAGE_UNSUPPORTED 不在客户端六分类内——它由 service 层按服务端错误
 *   摘要（含 image/multimodal 字样）从 HTTP_ERROR/BAD_RESPONSE 派生（docs/22 §6）。
 * - **密钥红线**：apiKey 仅在内存拼接 Authorization: Bearer 头；绝不进日志/
 *   错误对象/返回值；服务端错误响应若回显 key 字样，摘要按 apiKey 原文打码。
 * - **usage 仅实测**：响应体含 usage 对象才原样返回，否则 usage:'unknown'；
 *   上层（识别配置 last_test_usage_json）只在实测时落库。
 * - 与 LR1 客户端不耦合（docs/22 §6 裁决：LR1=纯文本无鉴权 advisory；本客户端
 *   = vision+鉴权+多配置超集，独立实现，去重合并留作后续重构）。
 */

/** OpenAI 兼容 chat.completions 的单条消息（content 支持纯文本或多模态数组）。 */
export type ChatRole = 'system' | 'user' | 'assistant'

/** 文本片段（vision 多模态数组的 text 部分）。 */
export interface ChatContentTextPart {
  type: 'text'
  text: string
}

/** 图片片段：image_url.url 为 http(s) 或 data:image/png;base64,… 形式的 data URL。 */
export interface ChatContentImageUrlPart {
  type: 'image_url'
  image_url: { url: string }
}

export type ChatContentPart = ChatContentTextPart | ChatContentImageUrlPart

export type ChatMessageContent = string | ChatContentPart[]

export interface ChatMessage {
  role: ChatRole
  content: ChatMessageContent
}

/** 单次调用配置（recognitionConfigService 行投影 + 内存中的明文 key）。 */
export interface ChatClientConfig {
  /** OpenAI 兼容端点基底（https://host/v1 或已带 /chat/completions 的完整 URL）。 */
  baseUrl: string
  model: string
  /** 缺省/空串 = 无鉴权端点（不携带 Authorization 头）。 */
  apiKey?: string
  /** 缺省 60000。 */
  timeoutMs?: number
}

/** 实测 usage（响应体 usage 字段原样透传；字段由服务端决定，不猜形状）。 */
export type ChatUsage = Record<string, unknown>

/** usage:'unknown' = 服务端未返回 usage（非实测），绝不伪造。 */
export type ChatUsageOrUnknown = ChatUsage | 'unknown'

export type ChatFailureKind = 'AUTH' | 'RATE_LIMIT' | 'TIMEOUT' | 'NETWORK' | 'BAD_RESPONSE' | 'HTTP_ERROR'

/** 结构化失败：message 为简短摘要，绝不含 apiKey 明文与完整请求体。 */
export interface ChatFailure {
  kind: ChatFailureKind
  /** HTTP_ERROR 时的 HTTP 状态码；其余分类恒 undefined。 */
  status?: number
  message: string
}

export type ChatCompletionResult =
  | { ok: true; content: string; usage: ChatUsageOrUnknown; latencyMs: number }
  | { ok: false; failure: ChatFailure; latencyMs: number }

/**
 * 传输接口：唯一出站点。返回原始 status 与 body 文本，由客户端统一分类；
 * smoke 注入 fake 后全程零联网（时窗红线）。
 */
export type ChatTransport = (url: string, init: RequestInit) => Promise<{ status: number; bodyText: string }>

const DEFAULT_TIMEOUT_MS = 60000

/** 默认传输 = 原生 fetch（读 body 文本）；仅生产语境可达，测试一律注入 fake。 */
function defaultChatTransport(url: string, init: RequestInit): Promise<{ status: number; bodyText: string }> {
  return fetch(url, init).then(async (res) => ({ status: res.status, bodyText: await res.text() }))
}

let activeTransport: ChatTransport | null = null

/** 注入 fake 传输（smoke/测试）；传 null 恢复默认 fetch 实现。 */
export function setChatTransport(transport: ChatTransport | null): void {
  activeTransport = transport
}

/** 当前传输（未注入 = 默认 fetch）。 */
export function getChatTransport(): ChatTransport {
  return activeTransport ?? defaultChatTransport
}

/**
 * URL 规范化（任务书锚定测试点）：baseUrl 去尾斜杠后，若已以 /chat/completions
 * 结尾则原样用，否则追加。兼容 `https://x/v1`、`https://x/v1/` 与
 * `https://x/v1/chat/completions` 三种写法。
 */
export function normalizeChatCompletionsUrl(rawBaseUrl: string): string {
  const trimmed = rawBaseUrl.trim().replace(/\/+$/, '')
  return trimmed.endsWith('/chat/completions') ? trimmed : `${trimmed}/chat/completions`
}

/**
 * 响应体摘要：压平空白并截断（≤200 字符）；secrets 中出现的子串一律打码
 * ——防服务端错误文案回显 API key（如 "Incorrect API key provided: sk-…"），
 * 密钥红线在错误出口再兜一道。
 */
function summarizeBodyText(bodyText: string, secrets: readonly string[], max = 200): string {
  let text = bodyText.replace(/\s+/g, ' ').trim()
  for (const secret of secrets) {
    if (secret.length > 0) text = text.split(secret).join('***')
  }
  if (text.length > max) text = `${text.slice(0, max)}…`
  return text
}

/** fetch reject / abort → 六分类（AbortError/TimeoutError → TIMEOUT，其余 → NETWORK）。 */
function classifyTransportError(err: unknown): ChatFailure {
  const name = err instanceof Error ? err.name : ''
  if (name === 'AbortError' || name === 'TimeoutError') {
    return { kind: 'TIMEOUT', message: '请求超时或被取消（AbortError/TimeoutError）' }
  }
  const detail = err instanceof Error ? err.message : String(err)
  return { kind: 'NETWORK', message: `网络请求失败：${summarizeBodyText(detail, [])}` }
}

/**
 * Chat Completions 非流式调用。POST {model, messages, stream:false}；
 * 错误六分类（见文件头）；usage 仅服务真实返回才透传，否则 'unknown'。
 */
export async function chatCompletion(
  config: ChatClientConfig,
  messages: readonly ChatMessage[],
  opts: { signal?: AbortSignal } = {},
): Promise<ChatCompletionResult> {
  const startedAt = Date.now()
  const url = normalizeChatCompletionsUrl(config.baseUrl)
  // 请求体只含 model/messages/stream —— 绝不夹带 apiKey（密钥红线）
  const body = JSON.stringify({ model: config.model, messages, stream: false })
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const apiKey = config.apiKey ?? ''
  if (apiKey.length > 0) {
    headers.Authorization = `Bearer ${apiKey}` // 仅内存拼接；不落日志/错误/返回值
  }

  // 超时合并（Node ≥20 AbortSignal.any）：固定超时 + 外部取消任一触发即中止
  const timeoutSignal = AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const signal = opts.signal !== undefined ? AbortSignal.any([timeoutSignal, opts.signal]) : timeoutSignal

  let status: number
  let bodyText: string
  try {
    const res = await getChatTransport()(url, { method: 'POST', headers, body, signal })
    status = res.status
    bodyText = res.bodyText
  } catch (err) {
    return { ok: false, failure: classifyTransportError(err), latencyMs: Date.now() - startedAt }
  }
  const latencyMs = Date.now() - startedAt
  const secrets: readonly string[] = apiKey.length > 0 ? [apiKey] : []

  // 非 2xx：AUTH（401/403）/ RATE_LIMIT（429）/ HTTP_ERROR（其余，带 status）
  if (status < 200 || status >= 300) {
    const summary = summarizeBodyText(bodyText, secrets)
    if (status === 401 || status === 403) {
      return { ok: false, failure: { kind: 'AUTH', message: `鉴权被拒绝（HTTP ${status}）：${summary || '无响应体'}` }, latencyMs }
    }
    if (status === 429) {
      return { ok: false, failure: { kind: 'RATE_LIMIT', message: `触发限流（HTTP 429）：${summary || '无响应体'}` }, latencyMs }
    }
    return { ok: false, failure: { kind: 'HTTP_ERROR', status, message: `服务返回 HTTP ${status}：${summary || '无响应体'}` }, latencyMs }
  }

  // 2xx：解析 JSON → choices[0].message.content 必须是非空结构校验，缺任一 → BAD_RESPONSE
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    return { ok: false, failure: { kind: 'BAD_RESPONSE', message: `响应不是合法 JSON：${summarizeBodyText(bodyText, secrets) || '空响应体'}` }, latencyMs }
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
  if (typeof content !== 'string') {
    return { ok: false, failure: { kind: 'BAD_RESPONSE', message: 'choices[0].message.content 不是字符串（本客户端仅收非流式文本 content）' }, latencyMs }
  }
  // usage 仅实测：响应体带 usage 对象才透传，否则 'unknown'（绝不伪造）
  const usage: ChatUsageOrUnknown =
    typeof record.usage === 'object' && record.usage !== null && !Array.isArray(record.usage)
      ? { ...(record.usage as ChatUsage) }
      : 'unknown'
  return { ok: true, content, usage, latencyMs }
}

/** 连接测试角色：vision/multimodal 发测试图，text 发 ping（docs/22 §6）。 */
export type ProbeRole = 'vision' | 'text' | 'multimodal'

/**
 * 1x1 红色 PNG（base64，69 字节，模块内嵌常量）：IHDR 1x1 8bit truecolor，
 * IDAT 解压 = [0,255,0,0]（filter 0 + RGB 255,0,0）。smoke 用例锚定该语义。
 */
export const PROBE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC' as const

/**
 * 连接测试辅助（识别配置 configTest 的底层）：text 角色发 'ping' 纯文本；
 * vision/multimodal 角色附 1x1 红色 PNG data URL + 一词描述指令。
 * 返回与 chatCompletion 同构的结果（ok/latencyMs/usage/错误分类）。
 */
export async function probeConfig(config: ChatClientConfig, role: ProbeRole): Promise<ChatCompletionResult> {
  const messages: readonly ChatMessage[] =
    role === 'text'
      ? [{ role: 'user', content: 'ping' }]
      : [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Describe this image in one word.' },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${PROBE_PNG_BASE64}` } },
            ],
          },
        ]
  return chatCompletion(config, messages)
}
