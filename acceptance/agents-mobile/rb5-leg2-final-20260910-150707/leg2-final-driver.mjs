#!/usr/bin/env node
// leg2-final-driver.mjs — J 批 R-B5 腿2 单点补验驱动（acceptance fixture）。
// 适配 rb5-rb8-20260910-112842/rb5rb8-standin-driver.mjs（D 批先例，同构 helper）。
//
// 子命令：
//   pair             裸连接 pair → pair_accepted(v1) → Bearer 重连 → hello（token 存临时文件 0600）
//   spawn-leg2       REST /v1/agents 触发常驻能力重验（门前置）→ WS command spawn_session
//                    （payload {providerId:'codex', task:'Reply with just OK'}）→ command_ack
//                    → ≤120s（自发送起）内 command_result(executed) + REST messages 出现
//                    role=assistant 非空内容 → 断言（R-B5 腿2 后半：真实推理回流）
//   messages <sid>   REST /v1/sessions/{sid}/messages 单会话取证
//   revoke-reconnect hello → WS command revoke_device → disconnect(revoked) → 旧 token
//                    重连 → 预期 401 DEVICE_REVOKED（本测试设备双端撤销清理）
//
// 红线：deviceToken/pairing code 只入内存与 %TEMP%（mode 600），绝不打印、绝不入仓；
//       帧快照 deviceToken/newToken/auth.token 一律 <redacted>。ECS 只读 + 本测试设备自撤销。
import fs from 'node:fs'
import tls from 'node:tls'
import crypto from 'node:crypto'

const HOST = '59.110.149.11'
const PORT = 443
const DEVICE_PATH = '/relay/device'
const CA_PEM = fs.readFileSync('C:/Users/sakuya/AppData/Local/DevHub/relay/ca.pem', 'utf8')
const CODE_FILE = 'C:/Users/sakuya/AppData/Local/Temp/rb5-leg2-final/pairing_code.txt'
const TOKEN_FILE = 'C:/Users/sakuya/AppData/Local/Temp/rb5-leg2-final/standin_token.tmp'
const OUT_DIR = 'F:/Active_Project/DevHub/acceptance/agents-mobile/rb5-leg2-final-20260910-150707'
const BACKFLOW_WINDOW_MS = 120_000

const cmd = process.argv[2] ?? ''
const evidence = { cmd, startedAt: new Date().toISOString(), steps: [], frames: [] }
const log = (step, ok, extra = {}) => {
  evidence.steps.push({ step, ok, ts: Date.now(), ...extra })
  console.log(`[${ok ? 'OK' : 'ERR'}] ${step}${Object.keys(extra).length ? ' ' + JSON.stringify(extra) : ''}`)
}

function finish() {
  evidence.finishedAt = new Date().toISOString()
  fs.writeFileSync(`${OUT_DIR}/leg2-${cmd}-evidence.json`, JSON.stringify(evidence, null, 2))
  const allOk = evidence.steps.every((s) => s.ok)
  console.log(allOk ? 'DRIVER_RESULT: PASS' : 'DRIVER_RESULT: PARTIAL')
  process.exit(allOk ? 0 : 1)
}

// ---------------- WebSocket minimal client（client→server 强制 mask） ----------------
function parseFrame(buf) {
  if (buf.length < 2) return null
  const opcode = buf[0] & 0x0f
  const masked = (buf[1] & 0x80) !== 0
  let len = buf[1] & 0x7f
  let off = 2
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4 }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); off = 10 }
  const maskKey = masked ? buf.slice(off, off + 4) : null
  if (masked) off += 4
  if (buf.length < off + len) return null
  const payload = Buffer.from(buf.slice(off, off + len))
  if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4]
  return { opcode, payload, total: off + len }
}

function sendFrame(socket, payload, opcode = 0x1) {
  const mask = crypto.randomBytes(4)
  const len = payload.length
  let head
  if (len < 126) head = Buffer.from([0x80 | opcode, 0x80 | len])
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 0x80 | 126; head.writeUInt16BE(len, 2) }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(len), 2) }
  const masked = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]))
  socket.write(Buffer.concat([head, mask, masked]))
}

function wsConnect({ bearer = null, label = '' }) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64')
    const headers = [
      `GET ${DEVICE_PATH} HTTP/1.1`,
      `Host: ${HOST}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
    ]
    if (bearer) headers.push(`Authorization: Bearer ${bearer}`)
    headers.push('', '')
    const socket = tls.connect(
      { host: HOST, port: PORT, ca: CA_PEM, servername: undefined, rejectUnauthorized: true },
      () => socket.write(headers.join('\r\n')),
    )
    socket.on('error', (err) => reject(Object.assign(err, { label })))
    socket.setTimeout(15000, () => {
      socket.destroy()
      reject(new Error(`timeout waiting upgrade/handshake (${label})`))
    })
    let buf = Buffer.alloc(0)
    let upgraded = false
    const seenFrames = []
    socket.on('data', (c) => {
      buf = Buffer.concat([buf, c])
      if (!upgraded) {
        const idx = buf.indexOf('\r\n\r\n')
        if (idx === -1) return
        const head = buf.slice(0, idx).toString('utf8')
        buf = buf.slice(idx + 4)
        const status = head.split('\r\n')[0]
        if (!/ 101 /.test(status)) { socket.destroy(); reject(new Error(`upgrade rejected: ${status}`)); return }
        upgraded = true
        socket.setTimeout(0)
        resolve({
          socket,
          seen: seenFrames,
          sendText: (obj) => sendFrame(socket, Buffer.from(JSON.stringify(obj), 'utf8')),
          close: (code = 1000, reason = 'client done') => {
            const payload = Buffer.alloc(2 + Buffer.byteLength(reason))
            payload.writeUInt16BE(code, 0)
            payload.write(reason, 2)
            try { sendFrame(socket, payload, 0x8) } catch { /* ignore */ }
            socket.end()
          },
        })
      }
      for (;;) {
        const f = parseFrame(buf)
        if (!f) break
        buf = buf.slice(f.total)
        if (f.opcode === 0x9) sendFrame(socket, f.payload, 0xA)
        else if (f.opcode === 0x8) { socket.end(); break }
        else if (f.opcode === 0x1) { const parsed = JSON.parse(f.payload.toString('utf8')); seenFrames.push(parsed); socket.emit('frame', parsed) }
      }
    })
  })
}

function awaitFrame(ws, type, timeoutMs, captureAll = null) {
  return new Promise((resolve, reject) => {
    const backlog = ws.seen ?? []
    const hit = backlog.find((f) => f.type === type)
    if (hit) {
      if (captureAll) for (const f of backlog) if (!captureAll.includes(f)) captureAll.push(redactFrame(f))
      resolve(hit)
      return
    }
    const timer = setTimeout(() => { ws.socket.removeListener('frame', onFrame); reject(new Error(`timeout awaiting ${type}`)) }, timeoutMs)
    function onFrame(frame) {
      if (captureAll) captureAll.push(redactFrame(frame))
      if (frame.type === type) { clearTimeout(timer); ws.socket.removeListener('frame', onFrame); resolve(frame) }
    }
    ws.socket.on('frame', onFrame)
  })
}

function rawUpgradeStatus({ bearer = null, label = '' }) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64')
    const headers = [
      `GET ${DEVICE_PATH} HTTP/1.1`,
      `Host: ${HOST}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
    ]
    if (bearer) headers.push(`Authorization: Bearer ${bearer}`)
    headers.push('Connection: close', '', '')
    const socket = tls.connect({ host: HOST, port: PORT, ca: CA_PEM, servername: undefined, rejectUnauthorized: true }, () => {
      socket.write(headers.join('\r\n'))
    })
    let buf = Buffer.alloc(0)
    socket.on('data', (c) => { buf = Buffer.concat([buf, c]) })
    socket.on('close', () => {
      const raw = buf.toString('utf8')
      const head = raw.split('\r\n\r\n')[0] ?? ''
      const status = head.split('\r\n')[0]
      const body = raw.split('\r\n\r\n').slice(1).join('\r\n\r\n')
      let code = null
      try { code = JSON.parse(body)?.error?.code ?? null } catch { /* non-json */ }
      resolve({ status, code })
    })
    socket.on('error', reject)
    socket.setTimeout(15000, () => { socket.destroy(); reject(new Error(`timeout (${label})`)) })
  })
}

function redactFrame(frame) {
  const clone = { ...frame }
  for (const k of ['deviceToken', 'newToken']) {
    if (typeof clone[k] === 'string') clone[k] = `<${clone[k].length}b>`
  }
  if (clone.auth && typeof clone.auth === 'object') clone.auth = { ...clone.auth, token: '<redacted>' }
  return clone
}

function restGet(path, bearer, ts, nonce) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: HOST, port: PORT, ca: CA_PEM, rejectUnauthorized: true }, () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: ${HOST}\r\nAuthorization: Bearer ${bearer}\r\n` +
        `X-DevHub-Timestamp: ${ts}\r\nX-DevHub-Nonce: ${nonce}\r\nConnection: close\r\n\r\n`)
    })
    let buf = Buffer.alloc(0)
    socket.on('data', (c) => { buf = Buffer.concat([buf, c]) })
    socket.on('close', () => {
      const raw = buf.toString('utf8')
      const head = raw.split('\r\n\r\n')[0] ?? ''
      const status = Number((head.split('\r\n')[0].match(/ (\d{3}) /) ?? [])[1] ?? 0)
      const body = raw.split('\r\n\r\n').slice(1).join('\r\n\r\n')
      let json = null
      try { json = JSON.parse(body) } catch { /* non-json */ }
      resolve({ status, json })
    })
    socket.on('error', reject)
    socket.setTimeout(35000, () => { socket.destroy(); reject(new Error('http timeout')) })
  })
}

async function loadToken() {
  const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim()
  if (!token) throw new Error('empty token file')
  return token
}

function summarizeMessages(json) {
  const items = json?.items ?? []
  return items.map((m) => ({
    role: m.role ?? null,
    kind: m.kind ?? null,
    head: String(m.content ?? m.text ?? '').slice(0, 160),
    chars: String(m.content ?? m.text ?? '').length,
    at: m.createdAt ?? m.at ?? null,
  }))
}

async function main() {
  if (cmd === 'pair') {
    const code = fs.readFileSync(CODE_FILE, 'utf8').trim()
    if (!/^[0-9A-Z]{8}$/.test(code)) { log('code_shape', false); process.exit(2) }
    evidence.pairingCodeShape = `${code.length}ch`
    const bare = await wsConnect({ label: 'bare' })
    log('bare_ws_101', true)
    const bareSeen = []
    const bareHello = await awaitFrame(bare, 'hello', 10000, bareSeen)
    log('bare_hello', true, { sequence: bareHello.sequence, upstream: bareHello.upstream })
    const t0 = Date.now()
    bare.sendText({ type: 'pair', requestId: crypto.randomUUID(), code, deviceName: 'rb5-leg2-final-standin', platform: 'android', clientVersion: '1.0.0' })
    const pairRelayedSeen = []
    const accepted = await awaitFrame(bare, 'pair_accepted', 20000, pairRelayedSeen)
    const token1 = String(accepted.deviceToken ?? '')
    if (!token1) { log('pair_no_token', false); finish() }
    fs.writeFileSync(TOKEN_FILE, token1, { mode: 0o600 })
    log('pair_accepted', true, { ecsDeviceId: accepted.ecsDeviceId ?? null, deviceId: accepted.deviceId ?? null, tokenVersion: accepted.tokenVersion, ms: Date.now() - t0 })
    evidence.pairAccepted = { ecsDeviceId: accepted.ecsDeviceId ?? null, deviceId: accepted.deviceId ?? null, tokenVersion: accepted.tokenVersion }
    try {
      const rot = await awaitFrame(bare, 'token_rotation', 4000)
      const token2 = String(rot.newToken ?? '')
      if (token2) { fs.writeFileSync(TOKEN_FILE, token2, { mode: 0o600 }); log('token_rotation_v2', true, { tokenVersion: rot.tokenVersion, reason: rot.reason ?? null }) }
    } catch { log('token_rotation_absent', true, { note: 'pair leg quiet after accepted; keep v1 (grace)' }) }
    bare.close()
    const ws1 = await wsConnect({ bearer: fs.readFileSync(TOKEN_FILE, 'utf8').trim(), label: 'v1' })
    log('v1_ws_101', true)
    const hello = await awaitFrame(ws1, 'hello', 10000)
    log('v1_hello', true, { sequence: hello.sequence, upstream: hello.upstream, heartbeatSec: hello.heartbeatSec ?? null })
    evidence.hello = { sequence: hello.sequence, upstream: hello.upstream }
    ws1.close()
    finish()
  } else if (cmd === 'spawn-leg2') {
    const token = await loadToken()
    // ① 门前置：REST /v1/agents（host-leg）→ 常驻 probeWiredProviders → codex 能力重验
    const agents = await restGet('/v1/agents', token, Math.floor(Date.now() / 1000), crypto.randomUUID())
    const codexRow = (agents.json?.providers ?? []).find((p) => /codex/i.test(p.provider ?? p.providerKey ?? ''))
    log('rest_agents_probe', agents.status === 200, {
      status: agents.status,
      codexMode: codexRow?.mode ?? codexRow?.capabilities?.mode ?? null,
      providerKeys: (agents.json?.providers ?? []).map((p) => p.provider ?? p.providerKey ?? null),
    })
    evidence.agentsProbe = { status: agents.status, codexMode: codexRow?.mode ?? codexRow?.capabilities?.mode ?? null }
    // 前置仅为触发能力重验（504=host-leg 探测超时；能力新鲜度已由库面预检确认），
    // 非判据组成——失败不阻断 spawn（配额纪律：不因探测面失败消耗推理配额）。
    if (agents.status !== 200) log('agents_probe_soft_fail', true, { note: 'continue; capability freshness pre-checked via DB read' })
    // ② WS 连接 + spawn_session
    const ws = await wsConnect({ bearer: token, label: 'v1-spawn' })
    const seen = []
    const hello = await awaitFrame(ws, 'hello', 10000, seen)
    log('v1_hello', true, { sequence: hello.sequence, upstream: hello.upstream })
    const idem = crypto.randomUUID()
    const reqId = crypto.randomUUID()
    evidence.idempotencyKey = idem
    const t0 = Date.now()
    ws.sendText({
      type: 'command', requestId: reqId, idempotencyKey: idem,
      action: 'spawn_session', payload: { providerId: 'codex', task: 'Reply with just OK' },
      auth: { token, ts: Math.floor(Date.now() / 1000), nonce: crypto.randomUUID() },
      createdAt: Math.floor(Date.now() / 1000),
    })
    evidence.frames.push({ sent: 'command', action: 'spawn_session', payload: { providerId: 'codex', task: 'Reply with just OK' }, idempotencyKey: idem, sentAt: new Date(t0).toISOString() })
    // ③ command_ack（≤20s）
    let ack = null
    try {
      ack = await awaitFrame(ws, 'command_ack', 20000, seen)
      log('command_ack', true, { status: ack.status, errorCode: ack.errorCode ?? null, ms: Date.now() - t0 })
    } catch (err) {
      log('command_ack', false, { err: String(err.message), seen: seen.length })
    }
    // ④ command_result（≤120s 总窗）
    let result = null
    try {
      const remainMs = Math.max(BACKFLOW_WINDOW_MS - (Date.now() - t0), 5000)
      result = await awaitFrame(ws, 'command_result', remainMs, seen)
      log('command_result', true, { action: result.action, status: result.status, sessionId: result.sessionId ?? null, errorCode: result.errorCode ?? null, ms: Date.now() - t0 })
    } catch (err) {
      log('command_result', false, { err: String(err.message), seen: seen.length })
    }
    evidence.ack = ack ? { status: ack.status, errorCode: ack.errorCode ?? null, requestId: ack.requestId ?? null } : null
    evidence.result = result ? { action: result.action, status: result.status, sessionId: result.sessionId ?? null, errorCode: result.errorCode ?? null, ms: Date.now() - t0 } : null
    const sessionId = result?.sessionId ?? null
    // ⑤ 真实推理回流断言：REST messages 轮询至 assistant 非空（≤120s 总窗）
    let assistantHit = null
    let pollLog = []
    if (typeof sessionId === 'number' && sessionId > 0) {
      while (Date.now() - t0 < BACKFLOW_WINDOW_MS) {
        await new Promise((r) => setTimeout(r, 3000))
        const r = await restGet(`/v1/sessions/${sessionId}/messages?last=20`, token, Math.floor(Date.now() / 1000), crypto.randomUUID())
        const items = summarizeMessages(r.json)
        pollLog.push({ at: Date.now() - t0, status: r.status, count: items.length })
        const hit = items.find((m) => m.role === 'assistant' && m.chars > 0)
        if (hit) { assistantHit = { ...hit, ms: Date.now() - t0 }; break }
      }
      if (assistantHit) log('assistant_backflow', true, { sessionId, ms: assistantHit.ms, chars: assistantHit.chars, head: assistantHit.head })
      else log('assistant_backflow', false, { sessionId, polls: pollLog.length, windowMs: BACKFLOW_WINDOW_MS })
    } else {
      log('assistant_backflow', false, { note: 'no sessionId in command_result' })
    }
    evidence.backflow = { sessionId, assistantHit, polls: pollLog, windowMs: BACKFLOW_WINDOW_MS }
    evidence.framesSeen = seen.filter((f) => f.type !== 'heartbeat')
    evidence.frameTypesSeen = seen.map((f) => f.type)
    ws.close()
    // ⑥ 断言汇总（判据：accepted + executed + 真实 assistant 非空，全在 120s 窗内）
    const pass = ack?.status === 'accepted' && result?.status === 'executed' && assistantHit !== null
    evidence.verdict = pass ? 'PASS' : 'FAIL'
    log('LEG2_VERDICT', pass, { ack: ack?.status ?? null, result: result?.status ?? null, assistantMs: assistantHit?.ms ?? null })
    finish()
  } else if (cmd === 'messages') {
    const token = await loadToken()
    const sid = Number(process.argv[3] ?? 0)
    if (!Number.isSafeInteger(sid) || sid <= 0) { console.error('usage: messages <sessionId>'); process.exit(1) }
    const r = await restGet(`/v1/sessions/${sid}/messages?last=20`, token, Math.floor(Date.now() / 1000), crypto.randomUUID())
    const items = summarizeMessages(r.json)
    log(`messages_${sid}`, r.status === 200, { status: r.status, count: items.length })
    evidence.messages = items
    finish()
  } else if (cmd === 'revoke-reconnect') {
    const token = await loadToken()
    const ws = await wsConnect({ bearer: token, label: 'v1-revoke' })
    const seen = []
    const hello = await awaitFrame(ws, 'hello', 10000, seen)
    log('v1_hello', true, { sequence: hello.sequence, upstream: hello.upstream })
    const idem = crypto.randomUUID()
    const t0 = Date.now()
    ws.sendText({
      type: 'command', requestId: crypto.randomUUID(), idempotencyKey: idem,
      action: 'revoke_device', payload: {},
      auth: { token, ts: Math.floor(Date.now() / 1000), nonce: crypto.randomUUID() },
      createdAt: Math.floor(Date.now() / 1000),
    })
    evidence.frames.push({ sent: 'command', idempotencyKey: idem, action: 'revoke_device' })
    const disconnect = await awaitFrame(ws, 'disconnect', 20000, seen)
    log('disconnect_revoked', disconnect.reason === 'revoked', { reason: disconnect.reason, ms: Date.now() - t0 })
    evidence.disconnect = { reason: disconnect.reason, ms: Date.now() - t0 }
    try { ws.close() } catch { /* already closing */ }
    const t1 = Date.now()
    const rej = await rawUpgradeStatus({ bearer: token, label: 'reconnect' })
    const revokedFace = /401/.test(rej.status) && rej.code === 'DEVICE_REVOKED'
    log('reconnect_401', revokedFace, { status: rej.status, code: rej.code, ms: Date.now() - t1 })
    evidence.reconnect = { status: rej.status, code: rej.code, ms: Date.now() - t1, revokedFace }
    evidence.framesSeen = seen
    finish()
  } else {
    console.error('usage: leg2-final-driver.mjs pair|spawn-leg2|messages <sid>|revoke-reconnect')
    process.exit(1)
  }
}

main().catch((err) => {
  log('fatal', false, { err: String((err && err.message) ?? err) })
  try { finish() } catch { process.exit(1) }
})
