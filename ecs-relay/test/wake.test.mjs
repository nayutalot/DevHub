/**
 * test/wake.test.mjs — RemoteWake（RW0，docs/18 §3.17）：wake_host/wake_result 帧集成测试。
 * 零真实 SSH 零网络执行：WakeRunner 全注入（fake），spawn 参数数组精确断言；
 * 映射/脱敏纯函数单测（exec_failed stderrSummary 截断+脱敏红线）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mapRunToStatus, redactStderrSummary } from '../src/wake.ts'
import { bootRelay, setupWorld, pairDevice, waitFor, sleep, rid, TestWsClient } from './helpers.mjs'

// 开面 env（命令指向不存在的 fake 二进制——runner 已注入 fake，绝不真跑）；
// 多余空白/尾随空白用于断言 argv 切分（参数数组、零 shell）。
const ENABLED_ENV = {
  WAKE_ENABLED: '1',
  WAKE_COMMAND: 'fake-ssh  fake-pi-alias wake-windows ',
  WAKE_COOLDOWN_S: '15',
}

/** fake runner：记录调用（argv/options）并返回预置结果。 */
function fakeRunner(result = { code: 0, stdout: '', stderr: '', timedOut: false }) {
  const calls = []
  const fn = async (argv, options) => {
    calls.push({ argv, options })
    return { ...result }
  }
  fn.calls = calls
  return fn
}

/** 独立只读连接读 wake 审计行（relay_audit 同表，category='wake'）。 */
function wakeAuditRows(dbPath) {
  const db = new DatabaseSync(dbPath)
  try {
    return db.prepare("SELECT action, device_id, outcome, detail_json FROM relay_audit WHERE category = 'wake' ORDER BY id ASC").all()
  } finally {
    db.close()
  }
}

/** 开面 + 配对 + 断开 host 腿（桌面离线 = wake 帧的主用例）。 */
async function wakeOfflineWorld(t, envOverrides = {}, runner) {
  const world = await setupWorld(t, { ...ENABLED_ENV, ...envOverrides }, { wakeRunner: runner })
  const paired = await pairDevice(world)
  world.host.destroy()
  await waitFor(() => world.handle.forwarder.hostOnline === false)
  return { world, paired, device: paired.device }
}

// ---- 纯函数 --------------------------------------------------------------------

test('mapRunToStatus：exit 0=sent / timedOut=timeout / 其余=exec_failed（docs/18 §3.17 全量枚举）', () => {
  assert.equal(mapRunToStatus({ code: 0, stdout: '', stderr: '', timedOut: false }), 'sent')
  assert.equal(mapRunToStatus({ code: null, stdout: '', stderr: '', timedOut: true }), 'timeout')
  assert.equal(mapRunToStatus({ code: 255, stdout: '', stderr: 'ssh: connect to host 127.0.0.1 port 2222: Connection refused', timedOut: false }), 'exec_failed')
  assert.equal(mapRunToStatus({ code: 127, stdout: '', stderr: 'wake-windows: command not found', timedOut: false }), 'exec_failed')
  assert.equal(mapRunToStatus({ code: 1, stdout: '', stderr: '', timedOut: false }), 'exec_failed')
  assert.equal(mapRunToStatus({ code: null, stdout: '', stderr: '', timedOut: false }), 'exec_failed')
})

test('redactStderrSummary：秘密样长串脱敏 + 200 字符截断 + 空白归一（红线：帧面零 key/token）', () => {
  // SSH 指纹尾（43+ base64 字符）→ <redacted>
  assert.equal(
    redactStderrSummary('offering public key: SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEF'),
    'offering public key: SHA256:<redacted>',
  )
  // 公钥 blob（AAAA…）→ <redacted>，原文绝不外泄
  const withBlob = redactStderrSummary('debug1: Offering public key: ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI7fakefakefakefakefakefakefakefakefake root@host')
  assert.ok(!withBlob.includes('AAAAC3Nza'), '公钥 blob 必须脱敏')
  assert.ok(withBlob.includes('<redacted>'))
  // 截断：>200 字符（非秘密样串——redaction 先行，含 32+ 连续字符的输入会先被 <redacted> 替换）
  const long = redactStderrSummary('word '.repeat(120).trim())
  assert.equal(long.length, 201)
  assert.ok(long.endsWith('…'))
  // 空白归一
  assert.equal(redactStderrSummary('a\n\n  b'), 'a b')
})

// ---- 帧集成（device leg）-------------------------------------------------------

test('未配置 WAKE_ENABLED → wake_result disabled（零 spawn；业务级不断连；审计 denied）', async (t) => {
  const runner = fakeRunner()
  const world = await setupWorld(t, {}, { wakeRunner: runner })
  const { device } = await pairDevice(world)
  device.send({ type: 'wake_host', requestId: 'w-disabled' })
  const res = await device.recvFrame()
  assert.equal(res.type, 'wake_result')
  assert.equal(res.requestId, 'w-disabled')
  assert.equal(res.status, 'disabled')
  assert.equal(res.latencyMs, undefined)
  assert.equal(runner.calls.length, 0, 'disabled 面零 spawn')
  // 审计：category=wake / denied / status=disabled
  const rows = wakeAuditRows(world.config.dbPath)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].outcome, 'denied')
  assert.equal(JSON.parse(rows[0].detail_json).status, 'disabled')
  // 连接仍活（业务级错误不断连，docs/18 §3.16）
  device.send({ type: 'heartbeat', ts: 1 })
  assert.equal((await device.recvFrame()).type, 'heartbeat')
})

test('host leg 在线快路径 → already_on 零执行（桌面在线不是 wake 的用例）', async (t) => {
  const runner = fakeRunner()
  const world = await setupWorld(t, ENABLED_ENV, { wakeRunner: runner })
  const { device } = await pairDevice(world)
  device.send({ type: 'wake_host', requestId: 'w-on' })
  const res = await device.recvFrame()
  assert.equal(res.status, 'already_on')
  assert.equal(res.latencyMs, undefined)
  assert.equal(runner.calls.length, 0, '快路径零 spawn')
  assert.equal(JSON.parse(wakeAuditRows(world.config.dbPath).at(-1).detail_json).status, 'already_on')
})

test('桌面离线主用例：exit 0 → sent + latencyMs；argv 参数数组精确切分 + 15s 超时参数；审计 success 零 argv/stderr', async (t) => {
  const runner = fakeRunner({ code: 0, stdout: '', stderr: '', timedOut: false })
  const { world, paired, device } = await wakeOfflineWorld(t, {}, runner)
  device.send({ type: 'wake_host', requestId: 'w-sent' })
  const res = await device.recvFrame()
  assert.equal(res.type, 'wake_result')
  assert.equal(res.requestId, 'w-sent')
  assert.equal(res.status, 'sent')
  assert.equal(typeof res.latencyMs, 'number')
  assert.equal(res.stderrSummary, undefined)
  // 参数数组精确（WAKE_COMMAND 空白切分；零 shell、零拼接面）
  assert.equal(runner.calls.length, 1)
  assert.deepEqual(runner.calls[0].argv, ['fake-ssh', 'fake-pi-alias', 'wake-windows'])
  assert.deepEqual(runner.calls[0].options, { timeoutMs: 15000 })
  // 审计行：deviceId 关联 + success + detail 仅结果/计数字段（约束 #13 同款）
  const rows = wakeAuditRows(world.config.dbPath)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].action, 'wake_attempt')
  assert.equal(rows[0].device_id, paired.ecsDeviceId)
  assert.equal(rows[0].outcome, 'success')
  const detail = JSON.parse(rows[0].detail_json)
  assert.equal(detail.status, 'sent')
  assert.equal(typeof detail.latencyMs, 'number')
  assert.equal(detail.argv, undefined)
  assert.equal(detail.stderr, undefined)
})

test('exit≠0 → exec_failed + stderrSummary 截断+脱敏；超时 → timeout；失败审计 error 且零 stderr', async (t) => {
  const cases = [
    {
      name: '连接拒绝',
      result: { code: 255, stdout: '', stderr: 'ssh: connect to host 127.0.0.1 port 2222: Connection refused', timedOut: false },
      want: 'exec_failed',
      wantSummary: 'ssh: connect to host 127.0.0.1 port 2222: Connection refused',
    },
    {
      name: 'stderr 含指纹样秘密',
      result: { code: 1, stdout: '', stderr: 'offering public key: SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEF', timedOut: false },
      want: 'exec_failed',
      wantSummary: 'offering public key: SHA256:<redacted>',
    },
    {
      name: '进程超时',
      result: { code: null, stdout: '', stderr: '', timedOut: true },
      want: 'timeout',
      wantSummary: undefined,
    },
  ]
  for (const [i, c] of cases.entries()) {
    const runner = fakeRunner(c.result)
    const { world, device } = await wakeOfflineWorld(t, {}, runner)
    device.send({ type: 'wake_host', requestId: `w-err-${i}` })
    const res = await device.recvFrame()
    assert.equal(res.status, c.want, `case ${c.name}`)
    assert.equal(typeof res.latencyMs, 'number', `case ${c.name}`)
    assert.equal(res.stderrSummary, c.wantSummary, `case ${c.name}`)
    const row = wakeAuditRows(world.config.dbPath).at(-1)
    assert.equal(row.outcome, c.want === 'sent' ? 'success' : 'error', `case ${c.name}`)
    const detail = JSON.parse(row.detail_json)
    assert.equal(detail.status, c.want, `case ${c.name}`)
    assert.equal(detail.stderr, undefined, `case ${c.name}：审计面零 stderr`)
  }
})

// ---- 限速 -----------------------------------------------------------------------

test('冷却窗：窗内第二次 → rate_limited + retryAfterMs（零 spawn）；窗过后放行', async (t) => {
  const runner = fakeRunner({ code: 0, stdout: '', stderr: '', timedOut: false })
  const { world, device } = await wakeOfflineWorld(t, { WAKE_COOLDOWN_S: '1' }, runner)
  device.send({ type: 'wake_host', requestId: 'w-1' })
  assert.equal((await device.recvFrame()).status, 'sent')
  device.send({ type: 'wake_host', requestId: 'w-2' })
  const second = await device.recvFrame()
  assert.equal(second.status, 'rate_limited')
  assert.ok(second.retryAfterMs > 0 && second.retryAfterMs <= 1000, `retryAfterMs 在窗内：${second.retryAfterMs}`)
  assert.equal(second.latencyMs, undefined)
  assert.equal(runner.calls.length, 1, '限速路径零 spawn')
  // 审计 denied + retryAfterMs
  const deniedRow = wakeAuditRows(world.config.dbPath).at(-1)
  assert.equal(deniedRow.outcome, 'denied')
  assert.equal(JSON.parse(deniedRow.detail_json).status, 'rate_limited')
  // 冷却窗过后放行（WAKE_COOLDOWN_S=1 → 1s 后）
  await sleep(1100)
  device.send({ type: 'wake_host', requestId: 'w-3' })
  assert.equal((await device.recvFrame()).status, 'sent')
  assert.equal(runner.calls.length, 2)
})

test('冷却窗按设备独立：dev1 触发后 dev2 立即仍 sent（docs/18 §3.17 每设备语义）', async (t) => {
  const runner = fakeRunner({ code: 0, stdout: '', stderr: '', timedOut: false })
  const world = await setupWorld(t, ENABLED_ENV, { wakeRunner: runner })
  const d1 = await pairDevice(world)
  const d2 = await pairDevice(world)
  world.host.destroy()
  await waitFor(() => world.handle.forwarder.hostOnline === false)
  d1.device.send({ type: 'wake_host', requestId: 'w-a' })
  assert.equal((await d1.device.recvFrame()).status, 'sent')
  d2.device.send({ type: 'wake_host', requestId: 'w-b' })
  assert.equal((await d2.device.recvFrame()).status, 'sent')
  assert.equal(runner.calls.length, 2, '两设备各自放行')
  assert.equal(world.handle.forwarder.wake.debugAttemptCount(), 2)
})

// ---- 接线边界 -------------------------------------------------------------------

test('wake_host 缺 requestId → error BAD_PAYLOAD（业务级，不断连，零 spawn）', async (t) => {
  const runner = fakeRunner()
  const { device } = await wakeOfflineWorld(t, {}, runner)
  device.send({ type: 'wake_host' })
  const err = await device.recvFrame()
  assert.equal(err.type, 'error')
  assert.equal(err.code, 'BAD_PAYLOAD')
  assert.equal(runner.calls.length, 0)
  device.send({ type: 'heartbeat', ts: 1 })
  assert.equal((await device.recvFrame()).type, 'heartbeat')
})

test('裸连接发 wake_host → error + close 1002（未鉴权面首帧必须 pair，docs/18 §2）', async (t) => {
  const world = await setupWorld(t, ENABLED_ENV, { wakeRunner: fakeRunner() })
  const bare = new TestWsClient()
  await bare.connect(world.port, '/relay/device')
  await bare.recvFrame()
  bare.send({ type: 'wake_host', requestId: rid() })
  const err = await bare.recvFrame()
  assert.equal(err.type, 'error')
  const close = await bare.recvClose()
  assert.equal(close.code, 1002)
})

test('host 腿发 wake_host → 未知帧处理（audit + error，不断连；wake 仅 device leg）', async (t) => {
  const world = await setupWorld(t, ENABLED_ENV, { wakeRunner: fakeRunner() })
  world.host.send({ type: 'wake_host', requestId: rid() })
  const res = await world.host.recvFrame()
  assert.equal(res.type, 'error')
  assert.equal(res.code, 'BAD_PAYLOAD')
  world.host.send({ type: 'heartbeat', ts: Math.floor(Date.now() / 1000) })
  assert.equal((await world.host.recvFrame()).type, 'heartbeat')
})
