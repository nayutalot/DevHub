#!/usr/bin/env node
/**
 * selfcheck.mjs — devhub-relay 部署自检脚本（docs/19 §5.7，G11 的 ECS 侧补偿）。
 *
 * 清单（docs/19 §5.7 逐项）：
 *   1. 帧编解码一致性（docs/18 全表 16 帧 fixture 逐帧 round-trip）
 *   2. 配对全流程（register_pairing → pair → pair_accepted → Token 重连）
 *   3. 命令排队/过期（queued:true / TTL 过期 COMMAND_EXPIRED 回流）
 *   4. 缓存淘汰与 hasGaps（TTL 72h + 容量两级 + 缓存洞显式标注）
 *   5. 限流三态（鉴权失败 5/60s、常规 120/min、claim 5/5min）
 *   6. 重启后排队命令恢复（SIGTERM → 同库重启 → 设备补发 → host 上线投递）
 *   7. 红线断言（DB/日志/审计抽样零 Token 明文/零码明文/零凭据明文）
 *
 * 独立验证：不进 DevHub 仓门禁（docs/20 §5），部署时与版本升级后必跑，结果人工留存。
 * 用法：node --experimental-strip-types src/selfcheck.mjs（或 npm run selfcheck）
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { Store, ensureSchema, SCHEMA_DIR } from './store.ts'
import { RelayConnection } from './ws.ts'
import { EventCache } from './cache.ts'
import { loadConfig } from './config.ts'
import { RateLimits } from './auth.ts'
import { checkCertificateExpiry } from './certCheck.mjs'

const sha256hex = (v) => createHash('sha256').update(v, 'utf8').digest('hex')
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const FIXTURE = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'frames.json'), 'utf8'))

const results = []
let currentStep = ''
function step(name) {
  currentStep = name
  process.stdout.write(`\n== ${name}\n`)
}
function ok(item) {
  results.push({ step: currentStep, item, pass: true })
  console.log(`  [PASS] ${item}`)
}
function fail(item, detail = '') {
  results.push({ step: currentStep, item, pass: false })
  console.log(`  [FAIL] ${item}${detail ? ` — ${detail}` : ''}`)
}
function assert(cond, item, detail = '') {
  if (cond) ok(item)
  else fail(item, detail)
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}
async function waitFor(fn, timeoutMs = 8000, label = 'condition') {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return true
    await sleep(50)
  }
  throw new Error(`waitFor timeout: ${label}`)
}

// ---------------------------------------------------------------------------
// 通用最小 WS 客户端（与 test/helpers.mjs 同构；客户端帧必掩码）
// ---------------------------------------------------------------------------
import net from 'node:net'
import crypto from 'node:crypto'

function encodeClientFrame(opcode, payload) {
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
  const header = Buffer.alloc(4)
  header[0] = first
  header[1] = 0x80 | 126
  header.writeUInt16BE(payload.length, 2)
  return Buffer.concat([header, mask, masked])
}

class WsClient {
  constructor() {
    this.buffer = Buffer.alloc(0)
    this.queue = []
    this.waiters = []
    this.closedInfo = null
  }
  async connect(port, path, headers = {}) {
    const key = crypto.randomBytes(16).toString('base64')
    await new Promise((resolve, reject) => {
      this.socket = net.connect(port, '127.0.0.1', resolve)
      this.socket.once('error', reject)
    })
    const req = [
      `GET ${path} HTTP/1.1`,
      'Host: 127.0.0.1',
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
      this.socket.write(req)
      setTimeout(() => reject(new Error('handshake timeout')), 5000).unref()
    })
    this.statusLine = handshake.head.split('\r\n')[0]
    if (!handshake.head.startsWith('HTTP/1.1 101')) throw new Error(`upgrade rejected: ${this.statusLine}`)
    this.buffer = handshake.rest
    this.socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk])
      this.drain()
    })
    this.socket.on('close', () => {
      this.closedInfo = this.closedInfo ?? { code: null, reason: 'socket closed' }
      this.drain()
    })
    this.socket.on('error', () => {
      this.closedInfo = this.closedInfo ?? { code: null, reason: 'socket error' }
      this.drain()
    })
    this.drain()
  }
  drain() {
    while (true) {
      const frame = this.tryParse()
      if (frame === null) break
      if (frame.opcode === 0x8) {
        const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : null
        this.closedInfo = { code, reason: frame.payload.length > 2 ? frame.payload.slice(2).toString('utf8') : '' }
        this.push({ kind: 'close', ...this.closedInfo })
        continue
      }
      if (frame.opcode === 0x9) {
        this.sendRaw(encodeClientFrame(0xa, frame.payload))
        continue
      }
      if (frame.opcode === 0x1) this.push({ kind: 'text', frame: JSON.parse(frame.payload.toString('utf8')) })
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
    return { opcode, payload }
  }
  push(item) {
    const waiter = this.waiters.shift()
    if (waiter !== undefined) waiter.fn(item)
    else this.queue.push(item)
  }
  recv(timeoutMs = 5000) {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift())
    return new Promise((resolve, reject) => {
      // A⑥ 修复：超时必须摘除本 waiter（此前超时回调永久滞留数组，后续 push 喂给已
      // reject 的死回调 = 帧被静默吞掉——与 test/helpers.mjs 同源的等待者泄漏病）。
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.timer === timer)
        if (idx >= 0) this.waiters.splice(idx, 1)
        reject(new Error('recv timeout'))
      }, timeoutMs)
      this.waiters.push({
        timer,
        fn: (item) => {
          clearTimeout(timer)
          resolve(item)
        },
      })
    })
  }
  async recvFrame(timeoutMs = 5000) {
    const item = await this.recv(timeoutMs)
    if (item.kind !== 'text') throw new Error(`expected text frame: ${JSON.stringify(item)}`)
    return item.frame
  }
  send(obj) {
    this.sendRaw(encodeClientFrame(0x1, Buffer.from(JSON.stringify(obj), 'utf8')))
  }
  sendRaw(buf) {
    if (this.socket && !this.socket.destroyed) this.socket.write(buf)
  }
  destroy() {
    if (this.socket) this.socket.destroy()
  }
}

const rid = () => crypto.randomBytes(16).toString('hex')

// ---------------------------------------------------------------------------
// 子进程服务管理
// ---------------------------------------------------------------------------
function startServerChild(env, logSink) {
  const child = spawn(process.execPath, ['--experimental-strip-types', join(HERE, 'server.ts')], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => logSink.push(d.toString('utf8')))
  child.stderr.on('data', (d) => logSink.push(d.toString('utf8')))
  return child
}

/** 优雅停机：POSIX 用 SIGTERM（systemd 路径）；Windows 用 stdin 'shutdown' 指令缝（同一停机路径）。 */
function gracefulStop(child) {
  if (process.platform === 'win32') child.stdin.write('shutdown\n')
  else child.kill('SIGTERM')
}

async function serverReady(port) {
  return waitFor(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/health`)
      return res.status === 200
    } catch {
      return false
    }
  }, 10000, 'server health')
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const tempDir = mkdtempSync(join(tmpdir(), 'devhub-relay-selfcheck-'))
const dbPath = join(tempDir, 'relay.db')
const registrationCode = 'selfcheck-reg-code-0123456789abcdef'
const deviceToken = `selfcheck-devtok-${crypto.randomBytes(16).toString('hex')}`
const pairingCode = 'S3LFCH0K' // 夹具码（8 位形态；明文仅存内存用于红线断言）
const newToken = `selfcheck-rotated-${crypto.randomBytes(16).toString('hex')}`
const hostCredential = { value: null }
const logs = []

try {
  // ===========================================================================
  step('1. 帧编解码一致性（docs/18 全表 16 帧 fixture round-trip）')
  {
    assert(FIXTURE.frames.length === 16, 'fixture 覆盖 16 帧全表')
    let samples = 0
    let allOk = true
    const fakeSocket = { chunks: [], write(p) { this.chunks.push(Buffer.from(p)) }, destroy() {}, on() {} }
    for (const entry of FIXTURE.frames) {
      for (const sample of entry.samples) {
        samples += 1
        const received = []
        const conn = new RelayConnection(
          { side: 'device', bare: true, remoteIp: '127.0.0.1' },
          fakeSocket,
          { onText: (_c, text) => received.push(JSON.parse(text)), onClosed: () => {} },
          60000,
          5000,
        )
        conn.feed(encodeClientFrame(0x1, Buffer.from(JSON.stringify(sample.frame), 'utf8')))
        if (received.length !== 1 || JSON.stringify(received[0]) !== JSON.stringify(sample.frame)) {
          allOk = false
          fail(`帧 ${entry.no} ${entry.type}[${sample.leg}] round-trip`)
        }
      }
    }
    assert(allOk, `全部 ${samples} 个帧样例 round-trip 一致（掩码客户端帧 → 服务端解析）`)
  }

  // ===========================================================================
  step('2. 配对全流程（register_pairing → pair → pair_accepted → Token 重连）')
  {
    const port = 10000 + Math.floor(Math.random() * 40000)
    const env = {
      RELAY_BIND: '127.0.0.1',
      RELAY_PORT: String(port),
      RELAY_DB_PATH: dbPath,
      RELAY_REGISTRATION_CODE: registrationCode,
    }
    globalThis.selfcheckPort = port
    globalThis.selfcheckEnv = env
    let child = startServerChild(env, logs)
    await serverReady(port)
    ok('裸进程启动 → /v1/health 200（随机高端口 127.0.0.1）')

    // host 注册 + 连接
    const enrollRes = await fetch(`http://127.0.0.1:${port}/relay/host`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${registrationCode}` },
      body: JSON.stringify({ hostName: 'selfcheck-host' }),
    })
    assert(enrollRes.status === 201, '一次性注册码 → Relay 凭据换发（docs/19 §2.2）')
    hostCredential.value = (await enrollRes.json()).credential

    const host = new WsClient()
    await host.connect(port, '/relay/host', { Authorization: `Bearer ${hostCredential.value}` })
    const hostHello = await host.recvFrame()
    assert(hostHello.type === 'hello' && typeof hostHello.hostId === 'number', 'host leg hello 首帧（hostId/heartbeatSec/relayVersion/upstream）')

    // 配对
    host.send({ type: 'register_pairing', requestId: rid(), pairingId: 'pair-selfcheck-1', codeHash: sha256hex(pairingCode), expiresAt: Math.floor(Date.now() / 1000) + 300 })
    const regAck = await host.recvFrame()
    assert(regAck.type === 'register_pairing_ack' && regAck.accepted === true, 'register_pairing → ack（docs/19 §4.5）')

    const bare = new WsClient()
    await bare.connect(port, '/relay/device')
    const bareHello = await bare.recvFrame()
    assert(bareHello.type === 'hello' && bareHello.deviceId === undefined, '裸连接 hello 缺省 deviceId（docs/18 §3.1）')
    bare.send({ type: 'pair', requestId: rid(), code: pairingCode, deviceName: 'Selfcheck Pixel', platform: 'android', clientVersion: '1.0.0' })
    const pairRelayed = await host.recvFrame()
    assert(pairRelayed.type === 'pair' && pairRelayed.code === undefined && typeof pairRelayed.ecsDeviceId === 'number', 'pair 中继 E→H（明文码不出 device leg）')

    host.send({
      type: 'pair_accepted',
      requestId: pairRelayed.requestId,
      ecsDeviceId: pairRelayed.ecsDeviceId,
      device: { deviceId: 101, deviceName: 'Selfcheck Pixel', platform: 'android', tokenVersion: 1 },
      deviceToken,
      gatewayName: 'devhub-gateway',
    })
    const accepted = await bare.recvFrame()
    assert(accepted.type === 'pair_accepted' && accepted.deviceToken === deviceToken && accepted.deviceId === 101, 'pair_accepted E→D（Token 一次性过境）')

    // C7a 修①后 pair_accepted 不再即刻关闭裸连接（保留 pair 冲刷短窗等待同秒
    // token_rotation），裸连接关闭改由 Bearer 准入即触（admit 收口 pair 窗）——
    // 先重连再断言关闭，close 1000 语义不变、零窗等。
    const device = new WsClient()
    await device.connect(port, '/relay/device', { Authorization: `Bearer ${deviceToken}` })
    const deviceHello = await device.recvFrame()
    assert(deviceHello.type === 'hello' && deviceHello.deviceId === pairRelayed.ecsDeviceId, 'Bearer 重连 hello（ECS 注册表 id）')
    assert(deviceHello.upstream === 'connected', 'hello.upstream = connected（host leg 在线）')

    const bareClose = await bare.recv()
    assert(bareClose.kind === 'close' && bareClose.code === 1000, '配对完成裸连接关闭（引导 Bearer 重连）')

    // 事件扇出 + REST 中继（数据面）
    host.send({ type: 'event', sequence: 100, eventId: 'selfcheck-ev-100', provider: 'codex', sessionId: 7, eventType: 'session.waiting_input', timestamp: Math.floor(Date.now() / 1000), summary: 'selfcheck', payload: { sessionId: 7 }, requiresUserAction: true })
    const fanout = await device.recvFrame()
    assert(fanout.type === 'event' && fanout.eventId === 'selfcheck-ev-100' && fanout.requiresUserAction === true, 'event 扇出 E→D（deviceId 填充 + requiresUserAction）')

    const pendingAgents = host.recvFrame()
    const ts = Math.floor(Date.now() / 1000)
    const nonce = crypto.randomBytes(16).toString('hex')
    const agentsResPromise = fetch(`http://127.0.0.1:${port}/v1/agents`, { headers: { Authorization: `Bearer ${deviceToken}`, 'X-DevHub-Timestamp': String(ts), 'X-DevHub-Nonce': nonce } })
    const relayedAgents = await pendingAgents
    host.send({ type: 'agent_list', requestId: relayedAgents.requestId, providers: [{ id: 'codex', displayName: 'Codex', health: 'ok' }] })
    const agentsRes = await agentsResPromise
    const agentsJson = await agentsRes.json()
    assert(agentsRes.status === 200 && agentsJson.providers?.[0]?.id === 'codex', 'REST /v1/agents 中继往返（docs/18 §7.1）')

    // 限流三态（鉴权失败 5/60s → 429；含 401 形态与 Retry-After）
    let lastStatus = 0
    let lastCode = ''
    for (let i = 0; i < 7; i += 1) {
      const res = await fetch(`http://127.0.0.1:${port}/v1/agents`, { headers: { Authorization: 'Bearer bad-token' } })
      lastStatus = res.status
      lastCode = (await res.json()).error?.code ?? ''
      if (lastStatus === 429) break
    }
    assert(lastStatus === 429 && lastCode === 'AUTH_RATE_LIMITED', '鉴权失败限流：5 次/60s/源 → 429 AUTH_RATE_LIMITED（限流三态①）')

    globalThis.selfcheckHost = host
    globalThis.selfcheckDevice = device

    // 命令排队（host 离线 → queued:true）
    host.destroy()
    await sleep(300)
    const queuedCommand = {
      type: 'command', requestId: 'selfcheck-cmd-1', idempotencyKey: 'selfcheck-idem-1', sessionId: 7,
      action: 'send_message', payload: { text: 'selfcheck' }, auth: { token: deviceToken, ts, nonce: crypto.randomBytes(16).toString('hex') },
      createdAt: Math.floor(Date.now() / 1000),
    }
    device.send(queuedCommand)
    const queuedAck = await device.recvFrame()
    assert(queuedAck.type === 'command_ack' && queuedAck.queued === true && queuedAck.status === 'accepted', 'host 离线 command → queued:true（docs/18 §3.9）')

    // ===========================================================================
    step('6. 重启后排队命令恢复（SIGTERM → 同库重启 → 设备补发 → host 上线投递）')
    {
      const before = Date.now()
      gracefulStop(child)
      const exitCode = await new Promise((resolve) => child.on('exit', (code) => resolve(code)))
      assert(exitCode === 0, `SIGTERM 优雅停机 exit 0（${Date.now() - before}ms 内排空）`)
      const shutdownFrame = await device.recv()
      assert(shutdownFrame.kind === 'text' && shutdownFrame.frame.type === 'disconnect' && shutdownFrame.frame.reason === 'server_shutdown', '优雅停机先发 disconnect{server_shutdown}（docs/18 §3.15）')

      child = startServerChild(env, logs)
      await serverReady(port)
      ok('同库重启（relay_devices/pairing_codes/relay_commands 状态保留）')

      const device2 = new WsClient()
      await device2.connect(port, '/relay/device', { Authorization: `Bearer ${deviceToken}` })
      await device2.recvFrame() // hello
      // 设备补发（QueueReplay，docs/18 §3.8：重连后按序补发，幂等键同）
      device2.send({ ...queuedCommand })
      const reAck = await device2.recvFrame()
      assert(reAck.type === 'command_ack' && reAck.queued === true, '重启后补发命令 → 幂等 queued 应答（状态行持久）')

      const host2 = new WsClient()
      await host2.connect(port, '/relay/host', { Authorization: `Bearer ${hostCredential.value}` })
      await host2.recvFrame() // hello
      const delivered = await host2.recvFrame()
      assert(
        delivered.type === 'command' && delivered.idempotencyKey === 'selfcheck-idem-1' && delivered.auth?.token === deviceToken,
        'host 上线 → 排队命令按 requested_at 序投递（完整帧含 auth，内存过境）',
      )
      host2.send({ type: 'command_ack', requestId: delivered.requestId, idempotencyKey: 'selfcheck-idem-1', commandId: 'cmd-sc-1', status: 'accepted' })
      const ack = await device2.recvFrame()
      assert(ack.type === 'command_ack' && ack.commandId === 'cmd-sc-1', 'command_ack 回流设备（幂等行回填 command_id）')
      globalThis.selfcheckDevice = device2
      globalThis.selfcheckHost = host2
    }

    // ===========================================================================
    step('9. 僵尸窗口重发回执（A⑥ 修 1：重发 → 立即 queued:true + 武装帧保留重投）')
    {
      // A⑤ 确定性复现手法：destroy 后立即首发+重发，不等 hostOnline 翻转。
      globalThis.selfcheckHost.destroy() // 无 close 帧——僵尸窗口起点
      const liveKey = 'selfcheck-idem-live'
      const base = {
        type: 'command', requestId: 'selfcheck-live-1', idempotencyKey: liveKey, sessionId: 7,
        action: 'pause', auth: { token: deviceToken, ts: Math.floor(Date.now() / 1000), nonce: crypto.randomBytes(16).toString('hex') },
        createdAt: Math.floor(Date.now() / 1000),
      }
      // 首发：僵尸写（armed+中继、无 ack）或排队受理（queued ack）——两态均合法
      globalThis.selfcheckDevice.send({ ...base })
      // 重发（QueueReplay，docs/18 §3.8：同 key 换 requestId/nonce）→ 必须立即获得 queued:true
      const resendAt = Date.now()
      globalThis.selfcheckDevice.send({ ...base, requestId: 'selfcheck-live-1-retry', auth: { ...base.auth, nonce: crypto.randomBytes(16).toString('hex') } })
      let liveAck = null
      for (let i = 0; i < 4 && liveAck === null; i += 1) {
        const f = await globalThis.selfcheckDevice.recvFrame(3000)
        if (f.type === 'command_ack' && f.idempotencyKey === liveKey) liveAck = f
      }
      assert(liveAck !== null && liveAck.status === 'accepted' && liveAck.queued === true, `重发 → 同步 queued:true 回执（等待 ${Date.now() - resendAt}ms；A⑤「重发石沉大海」根因修复）`)

      // 武装帧保留：host 重连 → 排队命令重投（僵尸写兜底；真回执才清武装）
      const hostL2 = new WsClient()
      await hostL2.connect(port, '/relay/host', { Authorization: `Bearer ${hostCredential.value}` })
      await hostL2.recvFrame() // hello
      let delivered = null
      for (let i = 0; i < 4 && delivered === null; i += 1) {
        const f = await hostL2.recvFrame(5000)
        if (f.type === 'command' && f.idempotencyKey === liveKey) delivered = f
      }
      assert(delivered !== null && delivered.auth?.token === deviceToken, '武装帧保留：host 重连 → 僵尸写命令重投（完整帧含 auth）')
      hostL2.send({ type: 'command_ack', requestId: delivered.requestId, idempotencyKey: liveKey, commandId: 'cmd-sc-live', status: 'accepted' })
      let liveRealAck = null
      for (let i = 0; i < 4 && liveRealAck === null; i += 1) {
        const f = await globalThis.selfcheckDevice.recvFrame(3000)
        if (f.type === 'command_ack' && f.commandId === 'cmd-sc-live') liveRealAck = f
      }
      assert(liveRealAck !== null && liveRealAck.queued === undefined, 'host 真回执回流设备（accepted 不带 queued）')
      globalThis.selfcheckHost = hostL2
    }

    // ===========================================================================
    step('3. 命令过期（queued TTL → expired + COMMAND_EXPIRED 回流）')
    {
      globalThis.selfcheckHost.destroy()
      await sleep(300)
      globalThis.selfcheckDevice.send({
        type: 'command', requestId: 'selfcheck-cmd-exp', idempotencyKey: 'selfcheck-idem-exp', sessionId: 7,
        action: 'pause', auth: { token: deviceToken, ts: Math.floor(Date.now() / 1000), nonce: crypto.randomBytes(16).toString('hex') },
        createdAt: Math.floor(Date.now() / 1000),
      })
      const qAck = await globalThis.selfcheckDevice.recvFrame()
      assert(qAck.queued === true, '排队受理（queued:true）')
      // 默认 TTL 300s 太长——改由专用短 TTL 实例验证（见步骤 3b），此处仅验证排队受理
      ok('排队受理与 queued 应答（短 TTL 过期见 3b）')
    }

    // ===========================================================================
    step('10. TCP keepalive 活跃性（A⑥ 修 2：host 死亡 → 零流量 → upstream.connected ≤15s 翻转）')
    {
      const hostK = new WsClient()
      await hostK.connect(port, '/relay/host', { Authorization: `Bearer ${hostCredential.value}` })
      await hostK.recvFrame() // hello
      hostK.destroy() // 无 close 帧；此后该连接零流量（health 轮询走独立 HTTP 短连接）
      const t0 = Date.now()
      let flipped = false
      while (Date.now() - t0 < 15000) {
        try {
          const body = await (await fetch(`http://127.0.0.1:${port}/v1/health`)).json()
          if (body.upstream?.connected === false) {
            flipped = true
            break
          }
        } catch {
          /* health 瞬时不可用 → 继续轮询 */
        }
        await sleep(100)
      }
      const elapsed = Date.now() - t0
      assert(flipped, `upstream.connected 翻转耗时 ${elapsed}ms ≤15000ms（keepalive initialDelay 5s；A⑤ 修复前空闲循环 ≥15s 不翻转）`)
    }

    // ===========================================================================
    step('7a. 红线断言（DB/日志/审计抽样零凭据）')
    {
      const dbBytes = readFileSync(dbPath)
      const dbText = dbBytes.toString('latin1')
      const logText = logs.join('')
      const secrets = [
        ['端到端 Token 明文', deviceToken],
        ['配对码明文', pairingCode],
        ['Relay 凭据明文', hostCredential.value],
        ['注册码明文', registrationCode],
        ['轮换新 Token 明文', newToken],
      ]
      for (const [name, secret] of secrets) {
        if (secret === null) continue
        assert(!dbText.includes(secret), `relay.db 不含 ${name}`)
        assert(!logText.includes(secret), `进程日志不含 ${name}`)
      }
      // 审计表抽样（经独立只读连接）
      const auditStore = new Store({ path: dbPath })
      const auditRows = auditStore.all('SELECT category, action, detail_json FROM relay_audit ORDER BY id DESC LIMIT 200')
      const auditText = JSON.stringify(auditRows)
      for (const [name, secret] of secrets) {
        if (secret === null) continue
        assert(!auditText.includes(secret), `relay_audit.detail 不含 ${name}`)
      }
      const hasExpectedActions = auditRows.some((r) => r.action === 'pairing_claimed')
        && auditRows.some((r) => r.action === 'host_enrolled')
        && auditRows.some((r) => r.action === 'relay_started')
      assert(hasExpectedActions, '审计目录抽样：pairing_claimed/host_enrolled/relay_started 落库（docs/19 §5.3）')
      auditStore.close()
    }

    // 优雅收尾（会话 A）
    globalThis.selfcheckDevice.destroy()
    gracefulStop(child)
    await new Promise((resolve) => child.on('exit', resolve))
    ok('会话 A 收尾（优雅停机）')

    // ===========================================================================
    step('3b. 命令过期（短 TTL 专用实例：TTL 3s / sweep 1s）')
    {
      const port2 = 10000 + Math.floor(Math.random() * 40000)
      // 同库重启（设备/主机注册表保留），仅改端口与命令 TTL
      const env2 = { ...globalThis.selfcheckEnv, RELAY_PORT: String(port2), RELAY_COMMAND_TTL_SEC: '3' }
      const logsB = []
      const childB = startServerChild(env2, logsB)
      await serverReady(port2)
      const hostB = new WsClient()
      await hostB.connect(port2, '/relay/host', { Authorization: `Bearer ${hostCredential.value}` })
      await hostB.recvFrame()
      hostB.destroy()
      await sleep(300)
      const deviceB = new WsClient()
      await deviceB.connect(port2, '/relay/device', { Authorization: `Bearer ${deviceToken}` })
      await deviceB.recvFrame()
      deviceB.send({
        type: 'command', requestId: 'sc-exp-1', idempotencyKey: 'sc-idem-exp', sessionId: 7,
        action: 'pause', auth: { token: deviceToken, ts: Math.floor(Date.now() / 1000), nonce: crypto.randomBytes(16).toString('hex') }, createdAt: Math.floor(Date.now() / 1000),
      })
      const qAck = await deviceB.recvFrame()
      assert(qAck.queued === true, '短 TTL 实例排队受理')
      const expired = await deviceB.recvFrame(8000)
      assert(expired.type === 'error' && expired.code === 'COMMAND_EXPIRED', 'TTL 过期 → error COMMAND_EXPIRED 回流（docs/18 §5.2）')
      deviceB.destroy()
      gracefulStop(childB)
      await new Promise((resolve) => childB.on('exit', resolve))
      ok('短 TTL 实例收尾')
    }

    // ===========================================================================
    step('11. token 轮换宽限三态 + disconnect 单一语义（docs/18 §3.14/§3.15，M3-C3b 修1/修2）')
    {
      const port3 = 10000 + Math.floor(Math.random() * 40000)
      // 同库（win_device_id=101 设备行保留）；专用短宽限实例（300s → 2s，sweep 500ms）
      const env3 = { ...globalThis.selfcheckEnv, RELAY_PORT: String(port3), RELAY_ROTATION_GRACE_SEC: '2' }
      const logsC = []
      const childC = startServerChild(env3, logsC)
      await serverReady(port3)
      const hostC = new WsClient()
      await hostC.connect(port3, '/relay/host', { Authorization: `Bearer ${hostCredential.value}` })
      await hostC.recvFrame() // hello
      const deviceC = new WsClient()
      await deviceC.connect(port3, '/relay/device', { Authorization: `Bearer ${deviceToken}` })
      await deviceC.recvFrame() // hello

      // ① rotation 受理：E→D 转发 + 旧哈希转宽限（宽限三态基线）
      hostC.send({ type: 'token_rotation', requestId: 'sc-rot-1', deviceId: 101, newToken, tokenVersion: 2, reason: 'post-pairing' })
      const rotation = await deviceC.recvFrame(5000)
      assert(rotation.type === 'token_rotation' && rotation.tokenVersion === 2, 'token_rotation 受理 + E→D 转发（docs/18 §3.14）')

      // ② 宽限窗内旧凭据 → 200（grace 准入）
      const graceConn = new WsClient()
      await graceConn.connect(port3, '/relay/device', { Authorization: `Bearer ${deviceToken}` })
      const graceHello = await graceConn.recvFrame()
      assert(graceHello.type === 'hello', '宽限窗内旧 Token → 200（docs/18 §9.4「宽限内旧 Token 仍可连」）')

      // ③ 新凭据 → 200（恒定）
      const withNew = new WsClient()
      await withNew.connect(port3, '/relay/device', { Authorization: `Bearer ${newToken}` })
      const newHello = await withNew.recvFrame()
      assert(newHello.type === 'hello', '新 Token → 200（注册表主哈希已切换）')
      withNew.destroy()

      // ④ 窗口过期：宽限连接先收 disconnect{superseded} 再关闭（docs/18 §3.14 + §3.15 reason 枚举）
      const kicked = await graceConn.recv(8000)
      assert(kicked.kind === 'text' && kicked.frame.type === 'disconnect' && kicked.frame.reason === 'superseded', '宽限过期 → 宽限连接收 disconnect{superseded}（README 偏离单 #11）')
      const graceClose = await graceConn.recv(3000)
      assert(graceClose.kind === 'close' && graceClose.code === 1000, '宽限连接 close 1000')

      // ⑤ 窗外旧凭据 → 401（重配对路径）
      let rejectedHead = ''
      try {
        const late = new WsClient()
        await late.connect(port3, '/relay/device', { Authorization: `Bearer ${deviceToken}` })
        late.destroy()
      } catch (err) {
        rejectedHead = String(err.httpHead ?? err.message)
      }
      assert(rejectedHead.includes('401'), '宽限窗外旧 Token → 401 RELAY_DEVICE_UNKNOWN（重配对路径，docs/18 §3.14）')

      // ⑥ disconnect 单一语义：deviceId= ECS 行 id（非任何 win_device_id）→ 不兜底不错位
      const auditStore = new Store({ path: dbPath })
      const deviceRow = auditStore.get("SELECT id, win_device_id FROM relay_devices WHERE win_device_id = 101 AND status = 'active'")
      auditStore.close()
      assert(deviceRow !== undefined, '设备行定位（win_device_id=101）')
      const deviceD = new WsClient()
      await deviceD.connect(port3, '/relay/device', { Authorization: `Bearer ${newToken}` })
      await deviceD.recvFrame() // hello
      hostC.send({ type: 'disconnect', deviceId: deviceRow.id, reason: 'revoked' })
      await sleep(300)
      deviceD.send({ type: 'heartbeat', ts: Math.floor(Date.now() / 1000), lastAckedSeq: 0, tokenVersion: 2 })
      const alive = await deviceD.recvFrame(3000)
      assert(alive.type === 'heartbeat', `disconnect{deviceId:${deviceRow.id}}（ECS 行 id，非 win_device_id）不兜底错位：连接存活（C2 #6 回归）`)
      deviceD.destroy()

      // ⑦ 审计落库（device 类目：grace/admitted/expired/closed/mismatch，零凭据）
      const auditStore2 = new Store({ path: dbPath })
      const graceAudit = auditStore2.all("SELECT action, outcome FROM relay_audit WHERE action IN ('token_rotation_grace_admitted','token_rotation_grace_expired','token_rotation_grace_closed','device_disconnect_mismatch','token_rotation_route_mismatch')")
      const mismatch = auditStore2.all("SELECT detail_json FROM relay_audit WHERE action = 'device_disconnect_mismatch'")
      auditStore2.close()
      assert(graceAudit.some((r) => r.action === 'token_rotation_grace_admitted'), '宽限准入审计落库（device 类目）')
      assert(graceAudit.some((r) => r.action === 'token_rotation_grace_expired' && r.outcome === 'denied'), '宽限过期拒绝审计落库（docs/18 §3.14「结果审计落库」）')
      assert(graceAudit.some((r) => r.action === 'token_rotation_grace_closed'), '宽限连接清扫审计落库')
      assert(mismatch.some((r) => r.detail_json.includes(`"deviceId":${deviceRow.id}`)), 'disconnect 未命中审计 mismatch（C2 #6）')

      deviceC.destroy()
      hostC.destroy()
      gracefulStop(childC)
      await new Promise((resolve) => childC.on('exit', resolve))
      ok('宽限/单一语义专用实例收尾')
    }

    // ===========================================================================
    step('4. 缓存淘汰与 hasGaps（进程内验证：TTL 72h + 容量两级 + 缓存洞）')
    {
      const store = new Store({ path: ':memory:' })
      ensureSchema(store, SCHEMA_DIR)
      const config = loadConfig({ RELAY_CACHE_SOFT_ROWS: '5', RELAY_CACHE_HARD_ROWS: '8', RELAY_CACHE_PAYLOAD_TTL_HOURS: '72', RELAY_CACHE_ROW_TTL_DAYS: '7' })
      const cache = new EventCache(store, config)
      const nowSec = 50_000_000
      store.run("INSERT INTO relay_devices (win_device_id, device_name, platform, token_hash, token_version, status, paired_at, updated_at) VALUES (NULL,'d','android','h',1,'active',?,?)", nowSec, nowSec)
      for (const s of [1, 2, 3, 4, 5, 6]) {
        cache.insert({ sequence: s, eventId: `e-${s}`, type: 'message.appended', provider: 'codex', sessionId: 1, summary: null, payloadJson: '{}', requiresUserAction: false, createdAt: nowSec + s })
      }
      store.run('INSERT INTO relay_event_acks (device_id, acked_through, updated_at) VALUES (1, 2, ?)', nowSec)
      const evicted = []
      cache.evict(nowSec, (stage, count) => evicted.push({ stage, count }))
      assert(cache.size().rows <= 5 && evicted.some((e) => e.stage === 'capacity_acked'), '容量软限触发：先删已全 ack 最旧行（审计回调 capacity_acked）')
      for (const s of [7, 8, 9, 10]) cache.insert({ sequence: s, eventId: `e-${s}`, type: 'message.appended', provider: 'codex', sessionId: 1, summary: null, payloadJson: '{}', requiresUserAction: false, createdAt: nowSec + s })
      cache.evict(nowSec, (stage, count) => evicted.push({ stage, count }))
      assert(evicted.some((e) => e.stage === 'capacity_forced') && cache.size().rows <= 5, '仍超软限 → 强制删最旧行含未 ack（relay_cache_evicted → hasGaps 语义）')
      cache.insert({ sequence: 100, eventId: 'e-100', type: 'message.appended', provider: 'codex', sessionId: 1, summary: null, payloadJson: '{}', requiresUserAction: false, createdAt: nowSec - 73 * 3600 })
      store.run('UPDATE relay_event_acks SET acked_through = 100 WHERE device_id = 1')
      cache.evict(nowSec)
      assert(cache.bySequence(100).payload_json === null && cache.bySequence(100) !== undefined, 'TTL 72h：全 ack → 删 payload 保元数据（供 hasGaps）')
      cache.insert({ sequence: 101, eventId: 'e-101', type: 'message.appended', provider: 'codex', sessionId: 1, summary: null, payloadJson: '{}', requiresUserAction: false, createdAt: nowSec })
      store.run('UPDATE relay_event_acks SET acked_through = 101 WHERE device_id = 1')
      store.run('DELETE FROM relay_events WHERE sequence = 99') // 制造洞（99 本不存在——直接用区间判定）
      assert(cache.hasGapsBetween(100, 101) === false, '连续区间无洞')
      cache.insert({ sequence: 103, eventId: 'e-103', type: 'message.appended', provider: 'codex', sessionId: 1, summary: null, payloadJson: '{}', requiresUserAction: false, createdAt: nowSec })
      store.run('UPDATE relay_event_acks SET acked_through = 103 WHERE device_id = 1')
      assert(cache.hasGapsBetween(101, 103) === true, '缺号区间 hasGaps=true（绝不静默跳号）')
      store.close()
    }

    // ===========================================================================
    step('5. 限流三件套（进程内窗口验证：三件套参数同参 docs/14 §B.4）')
    {
      const limits = new RateLimits()
      const now = 9_000_000
      for (let i = 0; i < 4; i += 1) limits.recordAuthFailure('src-a', now)
      assert(limits.recordAuthFailure('src-a', now) === true && limits.isAuthFailureLimited('src-a', now + 1000) === true, '①鉴权失败 5 次/60s/源 → 窗口内拒绝')
      assert(limits.isAuthFailureLimited('src-a', now + 61_000) === false, '①窗口滑出解除（Retry-After 可计算）')
      let hit = false
      for (let i = 0; i < 121; i += 1) if (limits.recordDeviceRequest(1, now)) hit = true
      assert(hit, '②常规 120 次/min/设备 → 第 121 次起 429（off-by-one 语义）')
      for (let i = 0; i < 5; i += 1) limits.recordClaimAttempt('src-b', now)
      assert(limits.recordClaimAttempt('src-b', now) === true, '③claim 5 次/5min/源（尝试即计数含成功）')
    }

    // ===========================================================================
    step('容量预算护栏（docs/19 §5.5）')
    {
      const prodConfig = loadConfig({})
      assert(prodConfig.bind === '127.0.0.1' && prodConfig.port === 8443, '部署默认：绑定 127.0.0.1:8443（TLS 在反代终结）')
      assert(prodConfig.maxWsConnections === 64, 'WS 长连接预算 ≤64（超限告警不拒服务）')
      assert(prodConfig.pairingTtlSec === 300 && prodConfig.commandTtlSec === 300, '配对码/命令 TTL 300s')
      assert(prodConfig.queueLimitPerDevice === 100 && prodConfig.queueLimitGlobal === 1000, '命令排队上限 100/设备、1000/全局')
      assert(prodConfig.cacheSoftRows === 25000 && prodConfig.cacheHardRows === 50000, '缓存软/硬上限 25k/50k 行')
      assert(prodConfig.cachePayloadTtlSec === 72 * 3600, '缓存 payload TTL 72h')
    }

  // ===========================================================================
  step('证书剩余有效期（A⑥ 修 3 / P0a 证书日历：RELAY_CERT_PATH，默认 /etc/devhub-relay/tls/server.crt）')
  {
    const cert = checkCertificateExpiry()
    if (cert.status === 'skip') {
      console.log(`  [SKIP] ${cert.message}`)
      results.push({ step: currentStep, item: '证书剩余有效期（证书文件不存在 → 跳过）', pass: true, skip: true })
    } else if (cert.status === 'fail') {
      console.log(`  !!! ${cert.message}`)
      fail('证书剩余有效期 ≥14 天', cert.message)
    } else {
      ok(cert.message)
    }
  }
  }

  // ===========================================================================
  // 汇总
  console.log('\n' + '='.repeat(72))
  const failed = results.filter((r) => !r.pass)
  const skipped = results.filter((r) => r.skip === true)
  for (const stepName of [...new Set(results.map((r) => r.step))]) {
    const items = results.filter((r) => r.step === stepName)
    const bad = items.filter((r) => !r.pass).length
    console.log(`${bad === 0 ? 'PASS' : 'FAIL'}  ${stepName}  (${items.length - bad}/${items.length})`)
  }
  console.log('='.repeat(72))
  const counted = results.length - skipped.length
  const passLine = `selfcheck: ${counted - failed.length}/${counted} checks passed` + (skipped.length > 0 ? `（另 SKIP ${skipped.length} 项，不计入通过/失败）` : '')
  console.log(passLine)
  if (skipped.length > 0) {
    for (const s of skipped) console.log(`  - [SKIP] ${s.item}`)
  }
  if (failed.length > 0) {
    console.log('FAILED ITEMS:')
    for (const f of failed) console.log(`  - [${f.step}] ${f.item}`)
    process.exitCode = 1
  } else {
    console.log('selfcheck: ALL GREEN（docs/19 §5.7 清单全过）')
  }
} finally {
  try {
    rmSync(tempDir, { recursive: true, force: true })
  } catch {
    /* Windows 下 DB 句柄延迟释放——临时目录留给系统清理 */
  }
}
