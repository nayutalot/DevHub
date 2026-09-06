/**
 * rest.ts — REST 面（docs/18 §7 端点表：鉴权/防重放/限流/中继编排）。
 *
 * - 五端点（v1 范围裁决，docs/18 §7.1）：/v1/health（无鉴权）+ /v1/agents、/v1/sessions、
 *   /v1/sessions/{id}、/v1/sessions/{id}/messages（Bearer + 防重放 + 限流，docs/18 §7.4 同参 docs/14 §B.4）；
 * - 响应 JSON 形状与 docs/14 §B.1 逐字段一致（中继 = host 响应原样内嵌回传）；
 * - 降级（docs/18 §7.3）：host 断开 → agents/{id}/messages 503 RELAY_UPSTREAM_OFFLINE；
 *   /v1/sessions 列表 → 200 + X-DevHub-Stale: true（缓存元数据投影，缺失字段缺省绝不构造）；
 * - 写动作 → 405 RELAY_REST_READONLY（docs/18 §7.2）；错误统一 {error:{code,message}}（docs/18 §8.1）。
 * - ECS 校验通过后中继不重放 X-DevHub-* 头给 host（docs/18 §7.4：host 腿信任边界 = Relay 凭据）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Store } from './store.ts'
import type { Audit } from './audit.ts'
import type { EventCache } from './cache.ts'
import type { RelayConfig } from './config.ts'
import type { Forwarder } from './forwarder.ts'
import type { RateLimits, ReplayGuard } from './auth.ts'
import { authenticateDeviceToken, readBearerHeaderValue } from './auth.ts'
import { RelayError, errorBody } from './errors.ts'

export interface RestDeps {
  store: Store
  audit: Audit
  cache: EventCache
  config: RelayConfig
  forwarder: Forwarder
  rateLimits: RateLimits
  replayGuard: ReplayGuard
  startedAtMs: number
  version: string
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  if (res.headersSent) return
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...extraHeaders,
  })
  res.end(payload)
}

/** 读取响应帧字段（unknown 先行，避免直接断言）。 */
function field(frame: unknown, name: string): unknown {
  if (typeof frame !== 'object' || frame === null) return undefined
  return (frame as Record<string, unknown>)[name]
}

function sendError(res: ServerResponse, err: RelayError, requestId?: string): void {
  const headers: Record<string, string> = {}
  if (err.code === 'AUTH_RATE_LIMITED' || err.retryAfterSec !== undefined) {
    headers['Retry-After'] = String(Math.max(1, err.retryAfterSec ?? 60))
  }
  void requestId
  sendJson(res, err.httpStatus, errorBody(err.code, err.message), headers)
}

/** 查询参数正整数校验（≤200，docs/14 §B.1 messages 语义逐字复用）。 */
function boundedIntParam(params: URLSearchParams, name: string, max: number): number | null {
  const raw = params.get(name)
  if (raw === null) return null
  if (!/^\d{1,6}$/.test(raw)) {
    throw new RelayError('BAD_PAYLOAD', `query parameter ${name} must be a positive integer`)
  }
  const value = Number.parseInt(raw, 10)
  if (value < 1 || value > max) {
    throw new RelayError('BAD_PAYLOAD', `query parameter ${name} must be between 1 and ${max}`)
  }
  return value
}

function cursorParam(params: URLSearchParams, name: string): number | null {
  const raw = params.get(name)
  if (raw === null) return null
  if (!/^\d{1,12}$/.test(raw)) {
    throw new RelayError('BAD_PAYLOAD', `query parameter ${name} must be a non-negative integer cursor`)
  }
  return Number.parseInt(raw, 10)
}

/** stale 降级投影（docs/18 §7.3：缓存元数据，缺失字段缺省，绝不构造猜测值）。 */
function staleSessionsProjection(cache: EventCache, store: Store): Array<Record<string, unknown>> {
  void cache
  const rows = store.all<{ session_ref: string; provider: string | null; last: number }>(
    'SELECT session_ref, provider, MAX(created_at) AS last FROM relay_events WHERE session_ref IS NOT NULL GROUP BY session_ref ORDER BY last DESC LIMIT 100',
  )
  return rows.map((row) => {
    const idx = row.session_ref.lastIndexOf(':')
    const provider = row.provider ?? row.session_ref.slice(0, idx)
    const sessionId = Number.parseInt(row.session_ref.slice(idx + 1), 10)
    return {
      ...(Number.isSafeInteger(sessionId) ? { id: sessionId } : {}),
      providerId: provider,
      providerKey: provider,
      lastActivityAt: row.last,
      stale: true,
    }
  })
}

/** REST 请求入口（server.ts 挂载于 node:http request 事件）。 */
export async function handleRestRequest(req: IncomingMessage, res: ServerResponse, deps: RestDeps): Promise<void> {
  const { store, audit, config, forwarder, rateLimits, replayGuard } = deps
  let url: URL
  try {
    url = new URL(req.url ?? '/', 'http://relay.internal')
  } catch {
    sendJson(res, 400, errorBody('BAD_PAYLOAD', 'malformed request URL'))
    return
  }
  const method = (req.method ?? 'GET').toUpperCase()
  const pathname = url.pathname
  const sourceKey = rateLimits.sourceKey(req.socket.remoteAddress)
  const nowMs = Date.now()

  // ---- GET /v1/health（无鉴权活性；防重放豁免，docs/18 §7.1） --------------------
  if (method === 'GET' && pathname === '/v1/health') {
    sendJson(res, 200, {
      ok: true,
      name: 'devhub-relay',
      version: deps.version,
      uptimeSec: Math.floor((nowMs - deps.startedAtMs) / 1000),
      uptime: (nowMs - deps.startedAtMs) / 1000,
      upstream: { connected: forwarder.hostOnline },
    })
    return
  }

  try {
    // ---- 写动作一律 405（docs/18 §7.2：写面走 WS command；REST 只读） -------------
    if (method !== 'GET') {
      audit.write({ category: 'auth', action: 'auth_failed', outcome: 'denied', detail: { scope: 'rest_method', method } })
      throw new RelayError('RELAY_REST_READONLY', 'this action must go through the WS command face (docs/18 §7.2)')
    }

    // ---- 设备鉴权（L1 注册表校验，docs/19 §2.1） ---------------------------------
    if (rateLimits.isAuthFailureLimited(sourceKey, nowMs)) {
      const retryAfterSec = Math.max(1, rateLimits.authFailureRetryAfterSec(sourceKey, nowMs))
      audit.write({ category: 'auth', action: 'rate_limited', outcome: 'denied', detail: { scope: 'auth_failure', source: 'rest' } })
      throw new RelayError('AUTH_RATE_LIMITED', 'auth failure rate limited (5 failures / 60s per source); retry later', retryAfterSec)
    }
    let device
    try {
      device = authenticateDeviceToken(store, readBearerHeaderValue(req.headers.authorization), audit)
    } catch (err) {
      if (err instanceof RelayError && err.code !== 'DEVICE_REVOKED') {
        rateLimits.recordAuthFailure(sourceKey, nowMs)
        audit.write({ category: 'auth', action: 'auth_failed', outcome: 'denied', detail: { scope: 'rest', code: err.code } })
      } else if (err instanceof RelayError) {
        audit.write({ category: 'device', action: 'device_revoked', outcome: 'denied', detail: { scope: 'rest', deviceId: null, code: err.code } })
      }
      throw err
    }

    // ---- 防重放（±300s + nonce LRU 10min；docs/18 §7.4，health 已豁免） -----------
    try {
      replayGuard.check(
        { timestamp: req.headers['x-devhub-timestamp'], nonce: req.headers['x-devhub-nonce'] },
        nowMs,
      )
    } catch (err) {
      if (err instanceof RelayError) {
        audit.write({ category: 'auth', action: 'replay_rejected', outcome: 'denied', deviceId: device.id, detail: { scope: 'rest' } })
      }
      throw err
    }

    // ---- 常规限流（120 次/min/设备，docs/18 §7.4） --------------------------------
    if (rateLimits.recordDeviceRequest(device.id, nowMs)) {
      const retryAfterSec = Math.max(1, rateLimits.deviceRequestRetryAfterSec(device.id, nowMs))
      audit.write({ category: 'auth', action: 'rate_limited', outcome: 'denied', deviceId: device.id, detail: { scope: 'device_request' } })
      throw new RelayError('AUTH_RATE_LIMITED', 'device request rate limited (120 requests / min); retry later', retryAfterSec)
    }

    const timeoutMs = config.relayResponseTimeoutMs

    // ---- GET /v1/agents ---------------------------------------------------------
    if (pathname === '/v1/agents') {
      const response = await forwarder.requestHost({ type: 'agent_list' }, timeoutMs)
      const providers = field(response, 'providers')
      sendJson(res, 200, { providers: Array.isArray(providers) ? providers : [] })
      return
    }

    // ---- GET /v1/sessions（host 离线 → stale 降级，docs/18 §7.3） ------------------
    if (pathname === '/v1/sessions') {
      if (!forwarder.hostOnline) {
        sendJson(
          res,
          200,
          { sessions: staleSessionsProjection(deps.cache, store), stale: true },
          { 'X-DevHub-Stale': 'true' },
        )
        return
      }
      const query: Record<string, unknown> = {}
      for (const key of ['providerId', 'status', 'parentId']) {
        const value = url.searchParams.get(key)
        if (value !== null) query[key] = value
      }
      const limit = boundedIntParam(url.searchParams, 'limit', 200)
      if (limit !== null) query.limit = limit
      if (url.searchParams.get('includeArchived') !== null) query.includeArchived = url.searchParams.get('includeArchived')
      const response = await forwarder.requestHost({ type: 'session_list', query }, timeoutMs)
      const sessions = field(response, 'sessions')
      sendJson(res, 200, { sessions: Array.isArray(sessions) ? sessions : [], stale: false })
      return
    }

    // ---- GET /v1/sessions/{id} --------------------------------------------------
    const sessionDetailMatch = /^\/v1\/sessions\/(\d+)$/.exec(pathname)
    if (sessionDetailMatch !== null) {
      if (!forwarder.hostOnline) throw new RelayError('RELAY_UPSTREAM_OFFLINE', 'host offline; try again later', 30)
      const sessionId = Number.parseInt(sessionDetailMatch[1], 10)
      const response = await forwarder.requestHost({ type: 'session_list', query: { sessionId } }, timeoutMs)
      if (response === null) throw new RelayError('INTERNAL', 'host returned an empty response')
      const sessions = field(response, 'sessions')
      if (!Array.isArray(sessions) || sessions.length === 0) throw new RelayError('NOT_FOUND', `session ${sessionId} not found`)
      sendJson(res, 200, {
        session: sessions[0],
        capabilities: field(response, 'capabilities') ?? null,
      })
      return
    }

    // ---- GET /v1/sessions/{id}/messages（after/last/before 互斥 → BAD_PAYLOAD） ---
    const messagesMatch = /^\/v1\/sessions\/(\d+)\/messages$/.exec(pathname)
    if (messagesMatch !== null) {
      if (!forwarder.hostOnline) throw new RelayError('RELAY_UPSTREAM_OFFLINE', 'host offline; try again later', 30)
      const after = cursorParam(url.searchParams, 'after')
      const before = cursorParam(url.searchParams, 'before')
      const last = boundedIntParam(url.searchParams, 'last', 200)
      const given = [after !== null, before !== null, last !== null].filter(Boolean).length
      if (given > 1) {
        // ux A R10（docs/14 §B.1 逐字复用）
        throw new RelayError('BAD_PAYLOAD', 'query parameters after/last/before are mutually exclusive (docs/14 §B.1)')
      }
      const limit = boundedIntParam(url.searchParams, 'limit', 200)
      const frame: { type: string; [key: string]: unknown } = {
        type: 'message',
        sessionId: Number.parseInt(messagesMatch[1], 10),
      }
      if (after !== null) frame.after = after
      if (before !== null) frame.before = before
      if (last !== null) frame.last = last
      if (limit !== null) frame.limit = limit
      const response = await forwarder.requestHost(frame, timeoutMs)
      if (response === null) throw new RelayError('INTERNAL', 'host returned an empty response')
      const items = field(response, 'items')
      const body: Record<string, unknown> = { items: Array.isArray(items) ? items : [] }
      if (field(response, 'nextAfter') !== undefined) body.nextAfter = field(response, 'nextAfter')
      if (field(response, 'prevAfter') !== undefined) body.prevAfter = field(response, 'prevAfter')
      sendJson(res, 200, body)
      return
    }

    throw new RelayError('NOT_FOUND', `no such REST endpoint: ${method} ${pathname}`)
  } catch (err) {
    if (err instanceof RelayError) {
      sendError(res, err)
      return
    }
    audit.write({ category: 'relay', action: 'rest_internal_error', outcome: 'error', detail: { path: pathname } })
    sendJson(res, 500, errorBody('INTERNAL', 'relay internal error'))
  }
}
