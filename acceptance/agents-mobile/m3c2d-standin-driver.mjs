#!/usr/bin/env node
/**
 * m3c2d-standin-driver.mjs — M3-C2d R-B4/R-B6 协议对等设备腿驱动（acceptance fixture）。
 *
 * 子命令：
 *   pair           裸连接 pair → pair_accepted(v1) → Bearer v1 重连 → hello（token 存临时文件）
 *   rest-faces     REST 面：合法（预期 503 RELAY_UPSTREAM_TIMEOUT）→ 同 nonce 重放（预期 401）
 *                  → 窗外 ts（预期 401）
 *   command-queued host 离线期发命令帧 → 预期 command_ack{queued:true}
 *   await-result   重连等待 command_result（R-B6 host 恢复投递回流）
 *
 * 红线：deviceToken 只入内存与 %TEMP% 临时文件（mode 600），绝不打印、绝不入仓。
 */
import fs from 'node:fs'
import tls from 'node:tls'
import crypto from 'node:crypto'

const HOST = '59.110.149.11'
const PORT = 443
const DEVICE_PATH = '/relay/device'
const CA_PEM = fs.readFileSync('C:/Users/sakuya/AppData/Local/DevHub/relay/ca.pem', 'utf8')
const CODE_FILE = process.env.M3C2D_CODE_FILE ?? 'C:/Users/sakuya/AppData/Local/Temp/m3c2d_code.txt'
const TOKEN_FILE = 'C:/Users/sakuya/AppData/Local/Temp/m3c2d_standin_token.tmp'
const OUT_FILE = process.env.M3C2D_OUT ?? 'F:/Active_Project/DevHub/acceptance/agents-mobile/m3c2d-standin-driver-evidence.json'

const cmd = process.argv[2] ?? ''
const evidence = { cmd, startedAt: new Date().toISOString(), steps: [], frames: [] }
const log = (step, ok, extra = {}) => {
  evidence.steps.push({ step, ok, ts: Date.now(), ...extra })
  console.log(`[${ok ? 'OK' : 'ERR'}] ${step}${Object.keys(extra).length ? ' ' + JSON.stringify(extra) : ''}`)
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
    socket.setTimeout(15000, () => { socket.destroy(); reject(new Error(`timeout (${label})`)) })
    let buf = Buffer.alloc(0)
    let upgraded = false
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      if (!upgraded) {
        const idx = buf.indexOf('\r\n\r\n')
        if (idx < 0) return
        const head = buf.slice(0, idx).toString('utf8')
        buf = buf.slice(idx + 4)
        const status = head.split('\r\n')[0]
        if (!/ 101 /.test(status)) { socket.destroy(); reject(new Error(`upgrade rejected: ${status}`)); return }
        upgraded = true
        socket.setTimeout(0)
        resolve({
          socket,
          sendText: (obj) => sendFrame(socket, Buffer.from(JSON.stringify(obj), 'utf8')),
          close: (code = 1000, reason = 'client done') => sendClose(socket, code, reason),
        })
      }
      for (;;) {
        const f = parseFrame(buf)
        if (!f) break
        buf = buf.slice(f.total)
        if (f.opcode === 0x9) sendFrame(socket, f.payload, 0xA)
        else if (f.opcode === 0x8) { socket.end(); break }
        else if (f.opcode === 0x1) socket.emit('frame', JSON.parse(f.payload.toString('utf8')))
      }
    })
  })
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

function sendClose(socket, code, reason) {
  const payload = Buffer.alloc(2 + Buffer.byteLength(reason))
  payload.writeUInt16BE(code, 0)
  payload.write(reason, 2)
  try { sendFrame(socket, payload, 0x8) } catch { /* ignore */ }
  socket.end()
}

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

function awaitFrame(ws, type, timeoutMs, captureAll = null) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.socket.removeListener('frame', onFrame); reject(new Error(`timeout awaiting ${type}`)) }, timeoutMs)
    function onFrame(frame) {
      if (captureAll) captureAll.push(redactFrame(frame))
      if (frame.type === type) { clearTimeout(timer); ws.socket.removeListener('frame', onFrame); resolve(frame) }
    }
    ws.socket.on('frame', onFrame)
  })
}

function redactFrame(frame) {
  const clone = { ...frame }
  for (const k of ['deviceToken', 'newToken']) {
    if (typeof clone[k] === 'string') clone[k] = `<${clone[k].length}b>`
  }
  if (clone.auth && typeof clone.auth === 'object') clone.auth = { ...clone.auth, token: `<redacted>` }
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
      let code = null
      try { code = JSON.parse(body)?.error?.code ?? null } catch { /* html body */ }
      resolve({ status, code })
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

async function main() {
  if (cmd === 'pair') {
    const code = fs.readFileSync(CODE_FILE, 'utf8').trim()
    if (!/^[0-9A-Z]{8}$/.test(code)) { log('code_shape', false); process.exit(2) }
    const bare = await wsConnect({ label: 'bare' })
    log('bare_ws_101', true)
    const t0 = Date.now()
    bare.sendText({ type: 'pair', requestId: crypto.randomUUID(), code, deviceName: 'm3c2d-standin', platform: 'android', clientVersion: '1.0.0' })
    const accepted = await awaitFrame(bare, 'pair_accepted', 20000)
    const token1 = String(accepted.deviceToken ?? '')
    if (!token1) { log('pair_no_token', false); process.exit(3) }
    fs.writeFileSync(TOKEN_FILE, token1, { mode: 0o600 })
    log('pair_accepted', true, { deviceId: accepted.deviceId, tokenVersion: accepted.tokenVersion, ms: Date.now() - t0 })
    evidence.pairAccepted = { deviceId: accepted.deviceId, tokenVersion: accepted.tokenVersion }
    bare.close()
    // Bearer v1 重连（grace 窗内即为 ECS 有效凭据）
    const ws1 = await wsConnect({ bearer: token1, label: 'v1' })
    log('v1_ws_101', true)
    const hello = await awaitFrame(ws1, 'hello', 10000)
    log('v1_hello', true, { sequence: hello.sequence, upstream: hello.upstream, heartbeatSec: hello.heartbeatSec })
    evidence.hello = { sequence: hello.sequence, upstream: hello.upstream }
    ws1.close()
  } else if (cmd === 'rest-faces') {
    const token = await loadToken()
    const now = Math.floor(Date.now() / 1000)
    const n1 = crypto.randomUUID()
    const legit = await restGet('/v1/agents', token, now, n1)
    log('rest_legit', true, { status: legit.status, code: legit.code })
    const replay = await restGet('/v1/agents', token, now, n1)
    log('rest_replay_same_nonce', replay.status === 401, { status: replay.status, code: replay.code })
    const stale = await restGet('/v1/agents', token, now - 3600, crypto.randomUUID())
    log('rest_stale_ts', stale.status === 401, { status: stale.status, code: stale.code })
    evidence.faces = { legit: { status: legit.status, code: legit.code }, replay: { status: replay.status, code: replay.code }, stale: { status: stale.status, code: stale.code } }
  } else if (cmd === 'command-queued') {
    const token = await loadToken()
    const ws = await wsConnect({ bearer: token, label: 'v1-cmd' })
    await awaitFrame(ws, 'hello', 10000)
    const idem = crypto.randomUUID()
    const reqId = crypto.randomUUID()
    evidence.idempotencyKey = idem
    fs.writeFileSync(TOKEN_FILE + '.idem', idem, { mode: 0o600 })
    const seen = []
    ws.sendText({
      type: 'command', requestId: reqId, idempotencyKey: idem,
      sessionId: 506, action: 'send_message', payload: { text: 'm3c2d r-b6 queued probe' },
      auth: { token, ts: Math.floor(Date.now() / 1000), nonce: crypto.randomUUID() },
      createdAt: Math.floor(Date.now() / 1000),
    })
    evidence.frames.push({ sent: 'command', idempotencyKey: idem, sessionId: 506 })
    try {
      const ack = await awaitFrame(ws, 'command_ack', 20000, seen)
      log('command_ack', true, { status: ack.status, queued: ack.queued === true, errorCode: ack.errorCode ?? null })
      evidence.ack = { status: ack.status, queued: ack.queued === true, errorCode: ack.errorCode ?? null }
    } catch (err) {
      log('command_ack', false, { err: String(err.message), seen: seen.length })
    }
    ws.close()
  } else if (cmd === 'await-result') {
    const token = await loadToken()
    const idem = fs.readFileSync(TOKEN_FILE + '.idem', 'utf8').trim()
    const ws = await wsConnect({ bearer: token, label: 'v1-result' })
    const seen = []
    await awaitFrame(ws, 'hello', 10000, seen)
    log('v1_hello', true, {})
    try {
      // 先 ping 一次心跳触发 ECS 侧投递水位
      ws.sendText({ type: 'heartbeat', ts: Math.floor(Date.now() / 1000), lastAckedSeq: 0, tokenVersion: 1 })
      const result = await awaitFrame(ws, 'command_result', 90000, seen)
      log('command_result', true, { status: result.status, action: result.action, errorCode: result.errorCode ?? null, idemMatch: result.idempotencyKey === idem })
      evidence.result = { status: result.status, action: result.action, errorCode: result.errorCode ?? null }
    } catch (err) {
      log('command_result', false, { err: String(err.message) })
    }
    evidence.framesSeen = seen
    ws.close()
  } else {
    console.error('usage: driver.mjs pair|rest-faces|command-queued|await-result')
    process.exit(1)
  }
  evidence.finishedAt = new Date().toISOString()
  fs.writeFileSync(OUT_FILE, JSON.stringify(evidence, null, 2))
  const allOk = evidence.steps.every((s) => s.ok)
  console.log(allOk ? 'DRIVER_RESULT: PASS' : 'DRIVER_RESULT: PARTIAL')
}

main().catch((err) => {
  log('fatal', false, { err: String((err && err.message) ?? err) })
  fs.writeFileSync(OUT_FILE, JSON.stringify(evidence, null, 2))
  process.exit(1)
})
