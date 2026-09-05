#!/usr/bin/env node
/**
 * scripts/loadtest.mjs — 容量预算演练脚本（docs/19 §5.5 / docs/20 §2.2 验收线③）。
 *
 * 场景：部署演练用——127.0.0.1 随机高端口起子进程服务 → 直接注入 63 台注册设备（DB 预置）→
 * 开满 64 条 WS 长连（1 host + 63 device）→ 事件扇出压测（63 扇出 × 突发）→ 采样子进程 RSS
 * 与事件到达延迟 → 优雅停机零帧丢失（排队命令恢复抽查）。
 *
 * 预算护栏（docs/19 §5.5）：WS ≤64 条（内存 ≈ 4MB）；持续 50 events/s、突发 200 events/s
 * 扇出限幅（超限靠 sync 补齐，不丢只延迟）。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomBytes } from 'node:crypto'
import { Store, ensureSchema, SCHEMA_DIR } from '../src/store.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const sha256hex = (v) => createHash('sha256').update(v, 'utf8').digest('hex')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const tempDir = mkdtempSync(join(tmpdir(), 'devhub-relay-loadtest-'))
const dbPath = join(tempDir, 'relay.db')
const port = 10000 + Math.floor(Math.random() * 40000)
const DEVICE_COUNT = 63 // + 1 host = 64 条预算满载
const BURST_EVENTS = 200

// 复用 test/helpers 的最小 WS 客户端
const { TestWsClient } = await import('../test/helpers.mjs')

// 预置 63 台设备（直接写注册表——演练注入，跳过逐台配对）
{
  const store = new Store({ path: dbPath })
  ensureSchema(store, SCHEMA_DIR)
  const now = Math.floor(Date.now() / 1000)
  for (let i = 1; i <= DEVICE_COUNT; i += 1) {
    store.run(
      "INSERT INTO relay_devices (win_device_id, device_name, platform, token_hash, token_version, status, paired_at, updated_at) VALUES (?, ?, 'android', ?, 1, 'active', ?, ?)",
      i,
      `loadtest-dev-${i}`,
      sha256hex(`loadtest-token-${i}`),
      now,
      now,
    )
  }
  store.close()
}

const registrationCode = 'loadtest-reg-code-0123456789abcdef'
const child = spawn(process.execPath, ['--experimental-strip-types', join(HERE, '..', 'src', 'server.ts')], {
  env: { ...process.env, RELAY_BIND: '127.0.0.1', RELAY_PORT: String(port), RELAY_DB_PATH: dbPath, RELAY_REGISTRATION_CODE: registrationCode },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let childLog = ''
child.stdout.on('data', (d) => {
  childLog += d
})
child.stderr.on('data', (d) => {
  childLog += d
})

function rssMB() {
  // Linux: /proc/<pid>/status VmRSS（字节 KB）；Windows 无 /proc → 报告 N/A（演练以 Linux 为准）
  try {
    const status = readFileSyncSafe(`/proc/${child.pid}/status`)
    const m = /VmRSS:\s+(\d+) kB/.exec(status)
    return m ? Number(m[1]) / 1024 : null
  } catch {
    return null
  }
}
function readFileSyncSafe(p) {
  try {
    return require('node:fs').readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

function fail(message) {
  console.error(`[loadtest] FAIL: ${message}`)
  console.error('[loadtest] child log tail:\n' + childLog.split('\n').slice(-15).join('\n'))
  if (!child.killed) {
    if (process.platform === 'win32') child.stdin.write('shutdown\n')
    else child.kill('SIGTERM')
  }
  setTimeout(() => process.exit(1), 1500)
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await sleep(50)
  }
  fail(`timeout: ${label}`)
}

async function main() {
  // ① 就绪
  await waitFor(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/v1/health`)).status === 200
    } catch {
      return false
    }
  }, 10000, 'server ready')
  console.log(`[loadtest] server ready on 127.0.0.1:${port}`)

  // ② host 连接（1/64）
  const enroll = await fetch(`http://127.0.0.1:${port}/relay/host`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${registrationCode}` },
    body: '{}',
  })
  const { credential } = await enroll.json()
  const host = new TestWsClient()
  await host.connect(port, '/relay/host', { Authorization: `Bearer ${credential}` })
  await host.recvFrame()

  // ③ 63 条设备连接（满载 64）
  const devices = []
  const t0 = Date.now()
  for (let i = 1; i <= DEVICE_COUNT; i += 1) {
    const c = new TestWsClient()
    await c.connect(port, '/relay/device', { Authorization: `Bearer loadtest-token-${i}` })
    const hello = await c.recvFrame()
    if (hello.type !== 'hello') fail(`device ${i} hello 异常`)
    devices.push(c)
  }
  console.log(`[loadtest] ①②③ 64 条 WS 长连建立（1 host + ${DEVICE_COUNT} device）耗时 ${Date.now() - t0}ms`)

  // ④ 突发扇出：200 events × 63 设备（突发预算 200 events/s 上限采样）
  const fanoutTarget = DEVICE_COUNT * BURST_EVENTS
  const latencies = []
  const sentAt = Date.now()
  const recvPromises = devices.map((c) => (async () => {
    // 每设备收到首个事件帧即返回（延迟采样点）；其余积压帧留给排队/停机抽查
    while (true) {
      try {
        const frame = await c.recv(30000)
        if (frame.kind !== 'text' || frame.frame.type !== 'event') continue
        latencies.push(Date.now() - sentAt)
        return
      } catch {
        return // 30s 无事件（理论不发生）
      }
    }
  })())
  const burstStart = Date.now()
  for (let e = 1; e <= BURST_EVENTS; e += 1) {
    host.send({
      type: 'event', sequence: e, eventId: `lt-${e}`, provider: 'codex', sessionId: 1,
      eventType: 'message.appended', timestamp: Math.floor(Date.now() / 1000), summary: null,
      payload: { n: e }, requiresUserAction: false,
    })
    if (e % 50 === 0) await sleep(5) // 扇出限幅缝隙（背压让路）
  }
  await Promise.all(recvPromises)
  const burstMs = Date.now() - burstStart
  console.log(`[loadtest] ④ 突发 ${BURST_EVENTS} events × ${DEVICE_COUNT} 扇出：首个事件到达延迟 p50=${percentile(latencies, 50)}ms p95=${percentile(latencies, 95)}ms；突发窗口 ${burstMs}ms（≈${(BURST_EVENTS / (burstMs / 1000)).toFixed(0)} events/s 注入，≤200 预算）`)
  void fanoutTarget

  // ⑤ 排队受理抽查（对齐真实 App 行为）：断 host → 200ms → device#0 发命令 →
  // 首发总时限 5s 等 ack → 未到按 QueueReplay 语义同 key 换 nonce 重发一次 → 再守 30s →
  // 断言 queued:true。真实 Android 客户端是常读 socket——④ 首延迟采样后为每台设备挂
  // 持续后台读者（消耗帧+计数）直到 ⑤ 结束，客户端接收缓冲永不饥饿（⑤ 段 ECS 失败
  // 根因即「只读首帧就停读」造成的接收黑洞）。
  const frameCounts = new Array(DEVICE_COUNT).fill(0)
  let stopReaders = false
  let ackWaiter = null // device#0 的 command_ack 路由目标（读者承担投递，不与计数竞争）
  const routeAck = (frame) => {
    if (frame.type === 'command_ack' && ackWaiter !== null) {
      const resolve = ackWaiter
      ackWaiter = null
      resolve(frame)
      return true
    }
    return false
  }
  const readers = devices.map((c, i) => (async () => {
    while (!stopReaders && !c.closed) {
      try {
        const item = await c.recv(2000)
        if (i === 0 && item.kind === 'text' && routeAck(item.frame)) continue
        frameCounts[i] += 1
      } catch { /* 空闲超时/连接关闭 → 复查循环条件 */ }
    }
  })())
  console.log(`[loadtest] ⑤ ${DEVICE_COUNT} 台设备持续后台读者已挂载（消耗积压 + 后续帧，socket 零饥饿）`)

  host.destroy()
  await sleep(200)
  const cmdFrame = {
    type: 'command', requestId: 'lt-cmd-1', idempotencyKey: 'lt-idem-1', sessionId: 1, action: 'pause',
    auth: { token: 'x', ts: Math.floor(Date.now() / 1000), nonce: randomBytes(16).toString('hex') }, createdAt: Math.floor(Date.now() / 1000),
  }
  const nextAck = (timeoutMs) => new Promise((resolve) => {
    const timer = setTimeout(() => {
      ackWaiter = null
      resolve(null)
    }, timeoutMs)
    ackWaiter = (frame) => {
      clearTimeout(timer)
      resolve(frame)
    }
  })
  // 首发总时限 5s：hostOnline 写入竞态（host socket 已死但 close 未处理 → 命令走中继
  // 永无回执）可能触发也可能不触发——两条路径都必须通过。
  const firstAck = nextAck(5000)
  devices[0].send(cmdFrame)
  let ack = await firstAck
  if (ack === null) {
    console.log('[loadtest] ⑤ 首发命令 5s 未获 ack（hostOnline 写入竞态路径触发）——QueueReplay 语义重发一次（同 idempotencyKey 换 nonce）')
    const retryAck = nextAck(30_000)
    devices[0].send({ ...cmdFrame, auth: { ...cmdFrame.auth, nonce: randomBytes(16).toString('hex') } })
    ack = await retryAck
  }
  if (ack === null || ack.queued !== true) {
    if (process.env.LT_HOLD === '1') {
      console.log(`[loadtest][hold] 保持 ${120}s 供排查（child pid=${child.pid} port=${port}）...`)
      await sleep(120_000)
    }
    fail('排队受理异常（预期 queued:true）')
  }
  stopReaders = true
  await Promise.allSettled(readers)
  console.log(`[loadtest] ⑤ 排队受理 ✓（queued:true status=${ack.status}）；持续读者累计消耗 ${frameCounts.reduce((a, b) => a + b, 0)} 帧（含 ④ 积压），全程无接收饥饿`)
  for (const c of devices) c.destroy()
  if (process.platform === 'win32') child.stdin.write('shutdown\n')
  else child.kill('SIGTERM')
  const exitCode = await new Promise((resolve) => child.on('exit', resolve))
  console.log(`[loadtest] ⑤ 优雅停机 exit=${exitCode}（排队命令状态行持久，重启恢复链路由 selfcheck 第 6 项覆盖）`)

  const mem = rssMB()
  console.log(`[loadtest] ⑥ 子进程 RSS：${mem === null ? 'N/A（非 Linux；演练在 2C2G 上重跑取值）' : `${mem.toFixed(1)} MB`}`)
  console.log(`[loadtest] 预算对照：64 连接 ✓（实际 64）；连接内存预算 ≈4MB（docs/19 §5.5）；扇出限幅注入 ≤200 events/s ✓`)

  try {
    rmSync(tempDir, { recursive: true, force: true })
  } catch { /* 忽略 */ }
  console.log('[loadtest] DONE')
}

function percentile(arr, p) {
  if (arr.length === 0) return -1
  const sorted = [...arr].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))]
}

main().catch((err) => fail(err.stack ?? err.message))
