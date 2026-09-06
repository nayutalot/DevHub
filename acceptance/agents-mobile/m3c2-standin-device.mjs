#!/usr/bin/env node
/**
 * m3c2-standin-device.mjs — M3-C2 R-B2 协议对等设备腿客户端（acceptance fixture）。
 *
 * 背景：App 侧（main=973eeb3）未实现 relay 模式 WS pair 帧 pairing 传输（docs/19 §7.1
 * 「UI 复用现 Pairing 页，仅传输层换」未落地——PairingScreen 仅 REST claim 本地网关）。
 * 本脚本以 docs/18 §3.2/§3.3 协议对等客户端身份，走公网 wss://59.110.149.11/relay/device
 * 完成：裸连接 pair → pair_accepted(v1) → 立即 Bearer 重连 → hello → token_rotation(v2,
 * reason=post-pairing) → v2 重连 → heartbeat(tokenVersion=2) → REST /v1/agents 200。
 *
 * 红线：deviceToken 只入内存与 %TEMP% 临时文件，绝不打印、绝不入仓。
 * ECS 零改动；Windows 侧只读观测。
 */
import fs from 'node:fs'
import tls from 'node:tls'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'

const HOST = '59.110.149.11'
const PORT = 443
const DEVICE_PATH = '/relay/device'
const CA_PEM = fs.readFileSync('C:/Users/sakuya/AppData/Local/DevHub/relay/ca.pem', 'utf8')
const CODE_FILE = process.env.M3C2_CODE_FILE ?? 'C:/Users/sakuya/AppData/Local/Temp/m3c2_pairing_code.txt'
const TOKEN1_FILE = 'C:/Users/sakuya/AppData/Local/Temp/m3c2_token1.tmp'
const TOKEN2_FILE = 'C:/Users/sakuya/AppData/Local/Temp/m3c2_token2.tmp'
const OUT_FILE = process.env.M3C2_OUT ?? 'F:/Active_Project/DevHub/acceptance/agents-mobile/m3c2-08-standin-pair-evidence.json'

const evidence = { startedAt: new Date().toISOString(), host: HOST, steps: [], frames: [] }
const log = (step, ok, extra = {}) => {
  evidence.steps.push({ step, ok, ts: Date.now(), ...extra })
  console.log(`[${ok ? 'OK' : 'ERR'}] ${step}${Object.keys(extra).length ? ' ' + JSON.stringify(extra) : ''}`)
}

// ---------------------------------------------------------------------------
// RFC6455 minimal client over tls.Socket（client→server 帧强制 mask）
// ---------------------------------------------------------------------------

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
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      if (!upgraded) {
        const idx = buf.indexOf('\r\n\r\n')
        if (idx < 0) return
        const head = buf.slice(0, idx).toString('utf8')
        buf = buf.slice(idx + 4)
        const status = head.split('\r\n')[0]
        if (!/ 101 /.test(status)) {
          socket.destroy()
          reject(Object.assign(new Error(`upgrade rejected: ${status}`), { label, status }))
          return
        }
        upgraded = true
        socket.setTimeout(0)
        resolve({
          socket,
          sendText: (obj) => sendFrame(socket, Buffer.from(JSON.stringify(obj), 'utf8')),
          close: (code = 1000, reason = 'client done') => sendClose(socket, code, reason),
        })
      }
      // parse server frames from buf
      for (;;) {
        const f = parseFrame(buf)
        if (!f) break
        buf = buf.slice(f.total)
        if (f.opcode === 0x9) sendFrame(socket, f.payload, 0xA) // ping → pong
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

/** 等待指定类型帧（带超时）；期间收到的其他帧记入 evidence。 */
function awaitFrame(ws, type, timeoutMs, record = true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.socket.removeListener('frame', onFrame)
      reject(new Error(`timeout awaiting frame ${type}`))
    }, timeoutMs)
    function onFrame(frame) {
      if (record && frame.type && frame.type !== type) {
        evidence.frames.push({ awaited: type, got: redactFrame(frame) })
      }
      if (frame.type === type) {
        clearTimeout(timer)
        ws.socket.removeListener('frame', onFrame)
        resolve(frame)
      }
    }
    ws.socket.on('frame', onFrame)
  })
}

/** 帧脱敏：pair_accepted/token_rotation 的 token 只留形状。 */
function redactFrame(frame) {
  const clone = { ...frame }
  if (typeof clone.deviceToken === 'string') clone.deviceToken = `<${clone.deviceToken.length}b sha256/…>`
  if (typeof clone.newToken === 'string') clone.newToken = `<${clone.newToken.length}b sha256/…>`
  return clone
}

function httpGetAgents(bearer) {
  return new Promise((resolve, reject) => {
    const nonce = crypto.randomUUID()
    const ts = Math.floor(Date.now() / 1000)
    const socket = tls.connect({ host: HOST, port: PORT, ca: CA_PEM, rejectUnauthorized: true }, () => {
      socket.write(
        `GET /v1/agents HTTP/1.1\r\nHost: ${HOST}\r\nAuthorization: Bearer ${bearer}\r\n` +
        `X-DevHub-Timestamp: ${ts}\r\nX-DevHub-Nonce: ${nonce}\r\nConnection: close\r\n\r\n`,
      )
    })
    let buf = Buffer.alloc(0)
    socket.on('data', (c) => { buf = Buffer.concat([buf, c]) })
    socket.on('close', () => {
      const head = buf.toString('utf8').split('\r\n\r\n')[0] ?? ''
      const status = Number((head.split('\r\n')[0].match(/ (\d{3}) /) ?? [])[1] ?? 0)
      resolve({ status, head })
    })
    socket.on('error', reject)
    socket.setTimeout(15000, () => { socket.destroy(); reject(new Error('http timeout')) })
  })
}

const writeToken = (file, token) => { fs.writeFileSync(file, token, { mode: 0o600 }) }

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const code = fs.readFileSync(CODE_FILE, 'utf8').trim()
  if (!/^[0-9A-Z]{8}$/.test(code)) { log('code_file_shape', false); process.exit(2) }
  log('code_loaded', true, { len: code.length })

  // ① 裸连接 pair（docs/18 §3.2：未带 Authorization = 裸 pair 连接，首帧必须 pair）
  const bare = await wsConnect({ label: 'bare' })
  log('bare_ws_101', true)
  const requestId = crypto.randomUUID()
  bare.sendText({ type: 'pair', requestId, code, deviceName: 'm3c2-standin-client', platform: 'android', clientVersion: '1.0.0' })
  evidence.frames.push({ sent: 'pair', requestIdShape: requestId.slice(0, 8) + '…', codeShape: `<8 chars>` })
  const accepted = await awaitFrame(bare, 'pair_accepted', 20000)
  const token1 = String(accepted.deviceToken ?? '')
  if (!token1) { log('pair_accepted_no_token', false); process.exit(3) }
  writeToken(TOKEN1_FILE, token1)
  log('pair_accepted', true, {
    deviceId: accepted.deviceId,
    tokenVersion: accepted.tokenVersion,
    heartbeatSec: accepted.heartbeatSec,
    tokenLen: token1.length,
  })
  evidence.pairAccepted = redactFrame(accepted)
  bare.close()

  // ② 立即以 v1 重连（抢在 post-pairing token_rotation 到 ECS 注册表之前）
  let ws1
  try {
    ws1 = await wsConnect({ bearer: token1, label: 'v1' })
    log('v1_ws_101', true)
  } catch (err) {
    log('v1_ws_101', false, { err: err.message })
    process.exit(4)
  }
  const hello1 = await awaitFrame(ws1, 'hello', 10000)
  log('v1_hello', true, { sequence: hello1.sequence, upstream: hello1.upstream, heartbeatSec: hello1.heartbeatSec })
  ws1.sendText({ type: 'heartbeat', ts: Math.floor(Date.now() / 1000), lastAckedSeq: 0, tokenVersion: accepted.tokenVersion })
  evidence.frames.push({ sent: 'heartbeat', tokenVersion: 1 })

  // ③ 等 token_rotation（post-pairing 自动轮换，docs/18 §3.14 / docs/19 §4.5）
  let rotation = null
  try {
    rotation = await awaitFrame(ws1, 'token_rotation', 20000)
  } catch { /* 超时不判死：轮换帧可能已先行更新注册表 */ }
  let token2 = token1
  if (rotation) {
    token2 = String(rotation.newToken ?? '')
    writeToken(TOKEN2_FILE, token2)
    log('token_rotation_received', true, { tokenVersion: rotation.tokenVersion, reason: rotation.reason, deviceId: rotation.deviceId, tokenLen: token2.length })
    evidence.tokenRotation = { tokenVersion: rotation.tokenVersion, reason: rotation.reason, deviceId: rotation.deviceId }
  } else {
    log('token_rotation_not_received', false, { note: 'v1 continues; rotation may have landed before reconnect' })
  }
  ws1.close()

  // ④ v2 重连 + heartbeat 携 tokenVersion=2（确认信道）+ 保活观察
  const ws2 = await wsConnect({ bearer: token2, label: 'v2' })
  log('v2_ws_101', true)
  const hello2 = await awaitFrame(ws2, 'hello', 10000)
  log('v2_hello', true, { sequence: hello2.sequence, upstream: hello2.upstream })
  ws2.sendText({ type: 'heartbeat', ts: Math.floor(Date.now() / 1000), lastAckedSeq: 0, tokenVersion: rotation ? rotation.tokenVersion : 1 })
  evidence.frames.push({ sent: 'heartbeat', tokenVersion: rotation ? rotation.tokenVersion : 1 })
  const hbBack = await awaitFrame(ws2, 'heartbeat', 10000).catch(() => null)
  if (hbBack) log('v2_heartbeat_ack', true, { upstream: hbBack.upstream, queuedCommands: hbBack.queuedCommands ?? null })

  // ⑤ REST 面：/v1/agents 带 v2 token + ts/nonce → 200
  const agents = await httpGetAgents(token2)
  log('rest_agents_v2', agents.status === 200, { httpStatus: agents.status })

  evidence.finishedAt = new Date().toISOString()
  evidence.restAgentsStatus = agents.status
  fs.writeFileSync(OUT_FILE, JSON.stringify(evidence, null, 2))
  log('evidence_written', true, { file: OUT_FILE })
  const allOk = evidence.steps.every((s) => s.ok)
  console.log(allOk ? 'STANDIN_RESULT: PASS' : 'STANDIN_RESULT: PARTIAL')
  process.exit(allOk ? 0 : 1)
}

main().catch((err) => {
  log('fatal', false, { err: String((err && err.message) ?? err) })
  fs.writeFileSync(OUT_FILE, JSON.stringify(evidence, null, 2))
  process.exit(1)
})
