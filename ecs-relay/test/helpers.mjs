/**
 * test/helpers.mjs — 测试辅助：随机高端口起服（绝不占 8746-8755、绝不 0.0.0.0）、
 * 自研最小 RFC6455 测试客户端（客户端帧必掩码——R1 relayClient 的行为镜像）。
 */
import net from 'node:net'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../src/config.ts'
import { startRelayServer } from '../src/server.ts'

process.setMaxListeners(60)

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export function randomToken() {
  return crypto.randomBytes(32).toString('base64url')
}

export function randomHex32() {
  return crypto.randomBytes(16).toString('hex')
}

export const sha256hex = (v) => createHash('sha256').update(v, 'utf8').digest('hex')

export const rid = () => `${randomHex32()}-${randomHex32()}`

/** 起服 + 注册 host + host WS 连接（集成测试共用世界）。 */
export async function setupWorld(t, overrides = {}) {
  const world = await bootRelay(t, overrides)
  const enrollRes = await fetch(`http://127.0.0.1:${world.port}/relay/host`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${world.config.registrationCode}` },
    body: JSON.stringify({ hostName: 'test-host' }),
  })
  assert.equal(enrollRes.status, 201, 'host enroll 应成功')
  const enrolled = await enrollRes.json()
  const host = new TestWsClient()
  await host.connect(world.port, '/relay/host', { Authorization: `Bearer ${enrolled.credential}` })
  const hello = await host.recvFrame()
  assert.equal(hello.type, 'hello')
  assert.equal(hello.hostId, enrolled.hostId)
  assert.equal(hello.upstream, 'connected')
  assert.equal(hello.heartbeatSec, 30)
  return { ...world, credential: enrolled.credential, hostId: enrolled.hostId, host, hello }
}

/** 配对一台设备：register_pairing → 裸连接 pair → pair_accepted → 带 Token 重连。 */
export async function pairDevice(world, { code = 'A3K7M9XY', deviceToken = `devtok-${randomHex32()}`, winDeviceId = 12 } = {}) {
  world.host.send({ type: 'register_pairing', requestId: rid(), pairingId: 'pair-' + randomHex32(), codeHash: sha256hex(code), expiresAt: Math.floor(Date.now() / 1000) + 300 })
  const regAck = await world.host.recvFrame()
  assert.equal(regAck.type, 'register_pairing_ack')
  assert.equal(regAck.accepted, true)

  const bare = new TestWsClient()
  await bare.connect(world.port, '/relay/device')
  const bareHello = await bare.recvFrame()
  assert.equal(bareHello.type, 'hello')
  assert.equal(bareHello.deviceId, undefined, '裸连接 hello 缺省 deviceId（docs/18 §3.1）')

  bare.send({ type: 'pair', requestId: rid(), code, deviceName: 'Pixel 8', platform: 'android', clientVersion: '1.0.0' })
  const pairRelayed = await world.host.recvFrame()
  assert.equal(pairRelayed.type, 'pair')
  assert.equal(pairRelayed.code, undefined, '明文码绝不出 device leg（docs/18 §3.2）')
  assert.equal(pairRelayed.platform, 'android')

  world.host.send({
    type: 'pair_accepted',
    requestId: pairRelayed.requestId,
    ecsDeviceId: pairRelayed.ecsDeviceId,
    device: { deviceId: winDeviceId, deviceName: 'Pixel 8', platform: 'android', tokenVersion: 1 },
    deviceToken,
    gatewayName: 'devhub-gateway',
  })
  const accepted = await bare.recvFrame()
  assert.equal(accepted.type, 'pair_accepted')
  assert.equal(accepted.deviceId, winDeviceId)
  assert.equal(accepted.deviceToken, deviceToken)

  // 带 Token 重连（鉴权连接）。C7a 修①后 pair_accepted 不再即刻关闭裸连接（保留
  // pair 冲刷短窗等待同秒 token_rotation），裸连接关闭改由 Bearer 准入即触
  // （admit 收口 pair 窗）——先重连再断言关闭，语义不变（close 1000）、零窗等。
  const device = new TestWsClient()
  await device.connect(world.port, '/relay/device', { Authorization: `Bearer ${deviceToken}` })
  const hello = await device.recvFrame()
  assert.equal(hello.type, 'hello')
  assert.equal(hello.deviceId, pairRelayed.ecsDeviceId, 'hello.deviceId = ECS 注册表 id（docs/18 §3.1）')

  const closeInfo = await bare.recvClose()
  assert.equal(closeInfo.code, 1000)
  return { bare, device, deviceToken, ecsDeviceId: pairRelayed.ecsDeviceId, winDeviceId, accepted, hello }
}

/**
 * 起一个 127.0.0.1 随机端口实例（端口 0 = OS 分配，天然段外）。
 * overrides 直接映射 env 名（loadConfig 语义）。
 */
export async function bootRelay(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'relay-test-'))
  const env = {
    RELAY_BIND: '127.0.0.1',
    RELAY_PORT: '0',
    RELAY_DB_PATH: join(dir, 'relay.db'),
    RELAY_REGISTRATION_CODE: overrides.RELAY_REGISTRATION_CODE ?? 'reg-test-code-0123456789abcdef',
    ...overrides,
  }
  const config = loadConfig(env)
  const handle = startRelayServer({ config, dbPath: config.dbPath })
  await waitFor(() => handle.server.listening === true)
  await waitFor(() => handle.port > 0)
  if (t !== null && typeof t?.after === 'function') {
    t.after(() => handle.close())
  }
  return { handle, port: handle.port, config }
}

export async function waitFor(predicate, timeoutMs = 5000, stepMs = 20) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(stepMs)
  }
  throw new Error('waitFor timeout')
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// 最小 RFC6455 测试客户端（客户端帧必掩码；服务端帧不掩码解析）
// ---------------------------------------------------------------------------

export class TestWsClient {
  constructor() {
    this.socket = null
    this.buffer = Buffer.alloc(0)
    this.queue = []
    this.waiters = []
    this.closedInfo = null
    this.closed = false
    this.connectError = null
  }

  async connect(port, path, headers = {}, host = '127.0.0.1') {
    const key = crypto.randomBytes(16).toString('base64')
    await new Promise((resolve, reject) => {
      this.socket = net.connect(port, host, resolve)
      this.socket.once('error', reject)
    })
    const headerLines = [
      `GET ${path} HTTP/1.1`,
      `Host: ${host}:${port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
    ].join('\r\n') + '\r\n\r\n'
    const handshake = await new Promise((resolve, reject) => {
      let buf = Buffer.alloc(0)
      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk])
        const idx = buf.indexOf('\r\n\r\n')
        if (idx >= 0) {
          this.socket.off('data', onData)
          resolve({ head: buf.slice(0, idx).toString('utf8'), rest: buf.slice(idx + 4) })
        }
      }
      this.socket.on('data', onData)
      this.socket.write(headerLines)
      setTimeout(() => reject(new Error('ws handshake timeout')), 5000).unref()
    })
    this.statusLine = handshake.head.split('\r\n')[0]
    this.responseHead = handshake.head
    if (!handshake.head.startsWith('HTTP/1.1 101')) {
      const err = new Error(`upgrade rejected: ${this.statusLine}`)
      err.httpHead = handshake.head
      this.socket.destroy()
      throw err
    }
    this.buffer = handshake.rest
    this.socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk])
      this.drain()
    })
    this.socket.on('close', () => {
      this.closed = true
      this.drain()
    })
    this.socket.on('error', (err) => {
      this.connectError = err
      this.closed = true
      this.drain()
    })
    this.drain() // 101 响应与首帧（hello）可能同块到达——立即处理残包
    return handshake
  }

  /** HTTP 拒绝升级响应读取（非 101 场景先行抓取，供断言错误码形态）。 */
  static async readUpgradeRejection(port, path, headers = {}, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, host, () => {
        const key = crypto.randomBytes(16).toString('base64')
        const headerLines = [
          `GET ${path} HTTP/1.1`,
          `Host: ${host}:${port}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
        ].join('\r\n') + '\r\n\r\n'
        socket.write(headerLines)
      })
      let buf = Buffer.alloc(0)
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk])
        const idx = buf.indexOf('\r\n\r\n')
        if (idx >= 0) {
          const head = buf.slice(0, idx).toString('utf8')
          const body = buf.slice(idx + 4).toString('utf8')
          socket.destroy()
          resolve({ statusLine: head.split('\r\n')[0], head, body: body.trim() ? JSON.parse(body) : null })
        }
      })
      socket.once('error', reject)
      setTimeout(() => reject(new Error('rejection read timeout')), 5000).unref()
    })
  }

  drain() {
    while (true) {
      const frame = this.tryParse()
      if (frame === null) break
      if (frame.opcode === 0x8) {
        // close：code + reason
        const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : null
        const reason = frame.payload.length > 2 ? frame.payload.slice(2).toString('utf8') : ''
        this.closedInfo = { code, reason }
        this.push({ kind: 'close', code, reason })
        continue
      }
      if (frame.opcode === 0x9) {
        this.sendRaw(encodeClientFrame(0xa, frame.payload)) // pong
        continue
      }
      if (frame.opcode === 0xa) continue // pong
      if (frame.opcode === 0x1) {
        this.push({ kind: 'text', frame: JSON.parse(frame.payload.toString('utf8')) })
      }
    }
  }

  tryParse() {
    const buf = this.buffer
    if (buf.length < 2) return null
    const opcode = buf[0] & 0x0f
    let length = buf[1] & 0x7f
    let offset = 2
    if (length === 126) {
      if (buf.length < offset + 2) return null
      length = buf.readUInt16BE(offset)
      offset += 2
    } else if (length === 127) {
      if (buf.length < offset + 8) return null
      length = Number(buf.readBigUInt64BE(offset))
      offset += 8
    }
    if (buf.length < offset + length) return null
    const payload = Buffer.from(buf.subarray(offset, offset + length))
    this.buffer = buf.subarray(offset + length)
    return { opcode, payload, fin: (buf[0] & 0x80) !== 0 }
  }

  push(item) {
    const waiter = this.waiters.shift()
    if (waiter !== undefined) waiter.resolve(item)
    else this.queue.push(item)
  }

  /** 收下一帧（默认跳过 close 前的文本帧队列语义：返回 {kind, frame} 或 {kind:'close'}）。 */
  async recv(timeoutMs = 5000) {
    if (this.queue.length > 0) return this.queue.shift()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // A⑥ 修复：必须以 timer 身份摘除本 waiter——此前比较 w.resolve === resolve
        // （包装箭头 ≠ 裸 resolve）恒 false，超时 waiter 永远滞留队头，后续 push 把帧
        // 喂给已 reject 的死 waiter（resolve 成 no-op）→ 帧被静默吞掉（loadtest ⑤
        // ECS 路径 ack 消失的根因：reader 超时循环 2-3 次后即形成死 waiter 队头）。
        const idx = this.waiters.findIndex((w) => w.timer === timer)
        if (idx >= 0) this.waiters.splice(idx, 1)
        reject(new Error(`recv timeout (closed=${this.closed} closeInfo=${JSON.stringify(this.closedInfo)})`))
      }, timeoutMs)
      const waiter = {
        resolve: (item) => {
          clearTimeout(timer)
          resolve(item)
        },
        timer,
      }
      this.waiters.push(waiter)
    })
  }

  /** 收下一帧并断言 kind=text。 */
  async recvFrame(timeoutMs = 5000) {
    const item = await this.recv(timeoutMs)
    if (item.kind !== 'text') throw new Error(`expected text frame, got ${item.kind}: ${JSON.stringify(item)}`)
    return item.frame
  }

  async recvClose(timeoutMs = 5000) {
    if (this.closedInfo !== null) return this.closedInfo
    const item = await this.recv(timeoutMs)
    if (item.kind !== 'close') throw new Error(`expected close, got ${item.kind}: ${JSON.stringify(item)}`)
    return item
  }

  send(obj) {
    this.sendRaw(encodeClientFrame(0x1, Buffer.from(JSON.stringify(obj), 'utf8')))
  }

  sendRaw(buf) {
    if (this.socket !== null && !this.socket.destroyed) this.socket.write(buf)
  }

  destroy() {
    if (this.socket !== null) this.socket.destroy()
    this.closed = true
  }
}

/** 客户端帧编码（必掩码，RFC 6455 §5.1）。 */
export function encodeClientFrame(opcode, payload) {
  const mask = crypto.randomBytes(4)
  const masked = Buffer.from(payload)
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4]
  const first = 0x80 | opcode
  if (payload.length < 126) {
    const header = Buffer.alloc(6)
    header[0] = first
    header[1] = 0x80 | payload.length
    mask.copy(header, 2)
    return Buffer.concat([header, masked])
  }
  if (payload.length <= 0xffff) {
    const header = Buffer.alloc(4)
    header[0] = first
    header[1] = 0x80 | 126
    header.writeUInt16BE(payload.length, 2)
    return Buffer.concat([header, mask, masked])
  }
  const header = Buffer.alloc(10)
  header[0] = first
  header[1] = 0x80 | 127
  header.writeBigUInt64BE(BigInt(payload.length), 2)
  return Buffer.concat([header, mask, masked])
}

export { WS_GUID }

// ---------------------------------------------------------------------------
// REST 调用辅助（合法防重放头默认带上）
// ---------------------------------------------------------------------------

export async function restFetch(port, path, { method = 'GET', token = null, nonce = null, ts = null, extraHeaders = {}, body = null } = {}) {
  const headers = { ...extraHeaders }
  if (token !== null) headers.Authorization = `Bearer ${token}`
  if (ts !== null) headers['X-DevHub-Timestamp'] = String(ts)
  if (nonce !== null) headers['X-DevHub-Nonce'] = nonce
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body),
  })
  let json = null
  try {
    json = await res.json()
  } catch {
    /* 非 JSON 响应（理论不出现） */
  }
  return { status: res.status, headers: res.headers, json }
}

export function replayHeaders() {
  return { ts: Math.floor(Date.now() / 1000), nonce: randomHex32() }
}
