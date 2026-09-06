#!/usr/bin/env node
/**
 * m3c3a-stub-gateway.mjs — M3-C3a 验收夹具：本地模式 mini-Gateway 桩（REST + WS /v1/events）。
 *
 * 用途（acceptance fixture，绝不入库凭据、绝不触碰真实桌面数据）：
 * - local 模式 App 联调：POST /v1/pairing/claim（任意 8 位码即签发夹具 token）→
 *   GET /v1/agents / /v1/sessions / /v1/sessions/:id / messages / devices / diagnostics；
 * - WS /v1/events：hello（带 Bearer 升级即收）+ sync/ack 容忍；
 * - POST /__emit：触发一条 session_started 事件帧（并让该会话出现在 /v1/sessions 投影），
 *   服务端记录 emit 的 unix-ms 时间戳 → 与 UI 出现时间对照测「事件→UI 延迟」（R5.3）。
 *
 * 用法：node m3c3a-stub-gateway.mjs [port]   （缺省 18746；模拟器经 10.0.2.2 访问）
 * 红线：夹具 token 固定字符串（非机密）；只监听本机回环。
 */
import http from 'node:http'
import crypto from 'node:crypto'

const PORT = Number(process.argv[2] ?? 18746)
const TOKEN = 'm3c3a-fixture-token-not-secret'
const sessions = new Map() // id -> projection row
let nextSessionId = 9100
let nextSeq = 1
const wsClients = new Set()

const json = (res, code, body) => {
  const buf = Buffer.from(JSON.stringify(body))
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': buf.length })
  res.end(buf)
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const p = url.pathname
  // 测量打点：/v1/sessions 拉取时间（emit t0 与首个后续 GET 的差 = 事件→UI 数据刷新延迟）
  if (p === '/v1/sessions') console.log(`[get] /v1/sessions atMs=${Date.now()}`)
  if (p === '/v1/health') return json(res, 200, { ok: true, name: 'm3c3a-stub', version: '0.0.1', uptimeSec: Math.floor(process.uptime()) })
  if (p === '/v1/pairing/claim') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}')
      const id = 3300 + (nextSessionId % 7)
      console.log(`[claim] code=${parsed.code} -> deviceId=${id} atMs=${Date.now()}`)
      json(res, 200, { deviceId: id, token: TOKEN, tokenVersion: 1, gatewayName: 'm3c3a-stub' })
    })
    return
  }
  if (p === '/v1/agents') {
    return json(res, 200, {
      providers: [
        { id: 1, providerKey: 'codex', displayName: 'Codex', health: 'ok', capabilities: { mode: 'managed', granted: ['reply', 'pause', 'resume'], verifiedAt: 1757000000, evidence: 'stub' } },
      ],
    })
  }
  if (p === '/v1/sessions') {
    // 投影键名对齐 docs/14 §B.1（App parseSession 读 startedAt/lastActivityAt/endedAt）
    const rows = [...sessions.values()].map((r) => ({
      ...r,
      startedAt: r.startedAtSec,
      lastActivityAt: r.lastActivityAtSec,
      endedAt: r.endedAtSec,
    }))
    return json(res, 200, { sessions: rows })
  }
  const detailMatch = p.match(/^\/v1\/sessions\/(\d+)$/)
  if (detailMatch) {
    const id = Number(detailMatch[1])
    const row = sessions.get(id)
    if (!row) return json(res, 404, { error: { code: 'NOT_FOUND', message: 'no such session' } })
    const view = { ...row, startedAt: row.startedAtSec, lastActivityAt: row.lastActivityAtSec, endedAt: row.endedAtSec }
    return json(res, 200, {
      session: view,
      capabilities: { mode: 'managed', granted: ['reply', 'pause', 'resume'], verifiedAt: 1757000000, evidence: 'stub' },
      childSessions: [],
    })
  }
  if (/^\/v1\/sessions\/\d+\/messages$/.test(p)) return json(res, 200, { items: [], prevAfter: null })
  if (p === '/v1/devices') {
    return json(res, 200, { devices: [{ id: 3300, deviceName: 'stub-device', platform: 'android', status: 'online', pairedAt: Math.floor(Date.now() / 1000), lastSeenAt: Math.floor(Date.now() / 1000), tokenVersion: 1 }] })
  }
  if (p === '/v1/diagnostics') {
    return json(res, 200, { providers: [], gateway: { enabled: true, running: true, port: PORT, actualPort: PORT, activeDevices: wsClients.size } })
  }
  // 自撤销（DeviceScreen 撤销本设备）：夹具无状态，直接 204
  if (req.method === 'DELETE' && /^\/v1\/devices\/\d+$/.test(p)) {
    console.log(`[revoke] ${p} atMs=${Date.now()}`)
    res.writeHead(204).end()
    return
  }

  // —— 测量触发面：emit 事件 + 会话投影同时出现（模拟桌面事件流）——
  if (p === '/__emit') {
    const seq = nextSeq++
    const sessionId = nextSessionId++
    const title = `M3C3A-PROBE-${Date.now()}`
    sessions.set(sessionId, {
      id: sessionId, providerId: 1, nativeId: `stub-${sessionId}`, sessionMode: 'managed',
      title, status: 'running', statusDetail: null, startedAtSec: Math.floor(Date.now() / 1000),
      lastActivityAtSec: Math.floor(Date.now() / 1000), endedAtSec: null, stale: false,
      providerKey: 'codex', providerLabel: 'Codex', archived: false, parentSessionId: null,
    })
    const event = {
      type: 'event', seq, eventId: crypto.randomUUID(), eventType: 'session_started',
      sessionId, summary: title, createdAt: Math.floor(Date.now() / 1000),
      payload: { sessionId, status: 'running' },
    }
    const frame = JSON.stringify(event)
    for (const ws of wsClients) ws.write(rfc6455TextFrame(frame))
    console.log(`[emit] t0=${Date.now()} seq=${seq} sessionId=${sessionId} title=${title} clients=${wsClients.size}`)
    return json(res, 200, { t0: Date.now(), seq, sessionId, title })
  }

  json(res, 404, { error: { code: 'NOT_FOUND', message: p } })
})

// —— RFC6455 最小服务端帧（服务端→客户端不掩码）——
function rfc6455TextFrame(text) {
  const payload = Buffer.from(text, 'utf8')
  const len = payload.length
  let head
  if (len < 126) head = Buffer.from([0x81, len])
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(len, 2) }
  else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2) }
  return Buffer.concat([head, payload])
}

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key']
  if (!key) return socket.destroy()
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  )
  wsClients.add(socket)
  console.log(`[ws] upgrade ok atMs=${Date.now()} clients=${wsClients.size}`)
  // hello 服务端首帧（docs/14 §B.2）
  socket.write(rfc6455TextFrame(JSON.stringify({ type: 'hello', sequence: nextSeq - 1, device: 3300, heartbeatSec: 30 })))
  let buf = Buffer.alloc(0)
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk])
    // 只做长度头解析以丢弃客户端帧（sync/ack/ping 容忍），零业务处理
    if (buf.length >= 2) {
      const len = buf[1] & 0x7f
      const off = 2 + 4 + len // 客户端帧必掩码（4B mask key）
      if (buf.length >= off) buf = buf.slice(off)
    }
  })
  socket.on('close', () => { wsClients.delete(socket); console.log(`[ws] close clients=${wsClients.size}`) })
  socket.on('error', () => { wsClients.delete(socket) })
})

server.listen(PORT, '127.0.0.1', () => console.log(`m3c3a-stub-gateway listening on 127.0.0.1:${PORT}`))
