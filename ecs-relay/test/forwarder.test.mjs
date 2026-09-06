/**
 * test/forwarder.test.mjs — 中继编排集成测试：配对全流程/命令排队/幂等/过期/扇出/sync/轮换/踢线。
 * 全部走 127.0.0.1 随机高端口（端口 0 = OS 分配），绝不占 8746-8755。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bootRelay, TestWsClient, sleep, waitFor, randomHex32, setupWorld, pairDevice, rid, sha256hex } from './helpers.mjs'

// ---- 配对 --------------------------------------------------------------------

test('配对全流程：register_pairing → pair → pair_accepted → Token 重连（docs/18 §9.1）', async (t) => {
  const world = await setupWorld(t)
  const paired = await pairDevice(world)
  assert.equal(typeof paired.ecsDeviceId, 'number')
  assert.ok(paired.hello.sequence >= 0)
})

test('码错 → error PAIRING_INVALID_CODE（业务错误不断连）；无活跃码同码', async (t) => {
  const world = await setupWorld(t)
  const bare = new TestWsClient()
  await bare.connect(world.port, '/relay/device')
  await bare.recvFrame()
  bare.send({ type: 'pair', requestId: rid(), code: 'ZZZZZZZZ', deviceName: 'X', platform: 'android' })
  const errFrame = await bare.recvFrame()
  assert.equal(errFrame.type, 'error')
  assert.equal(errFrame.code, 'PAIRING_INVALID_CODE')
  bare.destroy()

  // 无活跃码
  const bare2 = new TestWsClient()
  await bare2.connect(world.port, '/relay/device')
  await bare2.recvFrame()
  bare2.send({ type: 'pair', requestId: rid(), code: 'A3K7M9XY', deviceName: 'X', platform: 'android' })
  const err2 = await bare2.recvFrame()
  assert.equal(err2.code, 'PAIRING_INVALID_CODE')
  bare2.destroy()
})

test('裸连接发非 pair 帧 → error + close 1002（docs/18 §2/§3.16）', async (t) => {
  const world = await setupWorld(t)
  const bare = new TestWsClient()
  await bare.connect(world.port, '/relay/device')
  await bare.recvFrame()
  bare.send({ type: 'heartbeat', ts: 1 })
  const err = await bare.recvFrame()
  assert.equal(err.type, 'error')
  const close = await bare.recvClose()
  assert.equal(close.code, 1002)
})

test('裸连接超时未 pair → close 1000 pair required（docs/18 §2：10s 内）', async (t) => {
  const world = await setupWorld(t, { RELAY_BARE_PAIR_TIMEOUT_SEC: '1' })
  const bare = new TestWsClient()
  await bare.connect(world.port, '/relay/device')
  await bare.recvFrame()
  const close = await bare.recvClose(3000)
  assert.equal(close.code, 1000)
  assert.match(close.reason, /pair required/)
})

test('未知帧类型（已鉴权）→ error 帧 + close 1002', async (t) => {
  const world = await setupWorld(t)
  const { device } = await pairDevice(world)
  device.send({ type: 'no_such_frame', requestId: rid() })
  const err = await device.recvFrame()
  assert.equal(err.type, 'error')
  assert.equal(err.code, 'BAD_PAYLOAD')
  const close = await device.recvClose()
  assert.equal(close.code, 1002)
})

// ---- 数据帧中继 ----------------------------------------------------------------

test('agent_list 中继：ECS 内部 requestId 路由，回宿回显原 requestId（docs/18 §3.4）', async (t) => {
  const world = await setupWorld(t)
  const { device } = await pairDevice(world)
  device.send({ type: 'agent_list', requestId: 'dev-req-1' })
  const relayed = await world.host.recvFrame()
  assert.equal(relayed.type, 'agent_list')
  assert.notEqual(relayed.requestId, 'dev-req-1', 'ECS 重写 requestId 防跨设备碰撞（内部路由）')
  world.host.send({ type: 'agent_list', requestId: relayed.requestId, providers: [{ id: 'codex' }] })
  const response = await device.recvFrame()
  assert.equal(response.type, 'agent_list')
  assert.equal(response.requestId, 'dev-req-1')
  assert.deepEqual(response.providers, [{ id: 'codex' }])
})

test('host 离线时数据帧请求 → error RELAY_UPSTREAM_OFFLINE（retryable）', async (t) => {
  const world = await setupWorld(t)
  const { device } = await pairDevice(world)
  world.host.destroy()
  await sleep(100)
  device.send({ type: 'agent_list', requestId: 'dev-req-2' })
  const err = await device.recvFrame()
  assert.equal(err.type, 'error')
  assert.equal(err.code, 'RELAY_UPSTREAM_OFFLINE')
  assert.equal(err.retryable, true)
})

test('session_list 响应注入 stale:false（docs/18 §3.5）', async (t) => {
  const world = await setupWorld(t)
  const { device } = await pairDevice(world)
  device.send({ type: 'session_list', requestId: 'dev-req-3', query: { providerId: 'codex' } })
  const relayed = await world.host.recvFrame()
  assert.deepEqual(relayed.query, { providerId: 'codex' })
  world.host.send({ type: 'session_list', requestId: relayed.requestId, sessions: [{ id: 337 }] })
  const response = await device.recvFrame()
  assert.equal(response.stale, false)
  assert.deepEqual(response.sessions, [{ id: 337 }])
})

// ---- 命令面 --------------------------------------------------------------------

test('host 离线：command 排队受理（queued:true）→ host 重连按序投递 → ack/result 回流', async (t) => {
  const world = await setupWorld(t)
  const { device } = await pairDevice(world)
  world.host.destroy()
  await sleep(100)

  const commandFrame = {
    type: 'command',
    requestId: 'dev-cmd-1',
    idempotencyKey: 'idem-1',
    sessionId: 337,
    action: 'send_message',
    payload: { text: '继续' },
    auth: { token: 'e2e-token-plain', ts: Math.floor(Date.now() / 1000), nonce: randomHex32() },
    createdAt: Math.floor(Date.now() / 1000),
  }
  device.send(commandFrame)
  const queuedAck = await device.recvFrame()
  assert.equal(queuedAck.type, 'command_ack')
  assert.equal(queuedAck.status, 'accepted')
  assert.equal(queuedAck.queued, true)
  assert.equal(queuedAck.idempotencyKey, 'idem-1')

  // host 重连 → 恢复序②：排队命令按 requested_at 序投递（内存帧原样含 auth）
  const host2 = new TestWsClient()
  await host2.connect(world.port, '/relay/host', { Authorization: `Bearer ${world.credential}` })
  await host2.recvFrame() // hello
  const delivered = await host2.recvFrame()
  assert.deepEqual(delivered, commandFrame, '排队命令帧原样投递（auth 仅内存过境）')

  host2.send({ type: 'command_ack', requestId: 'dev-cmd-1', idempotencyKey: 'idem-1', commandId: 'cmd-1', status: 'accepted' })
  const ack = await device.recvFrame()
  assert.equal(ack.type, 'command_ack')
  assert.equal(ack.commandId, 'cmd-1')
  assert.equal(ack.queued, undefined, '真受理回执不带 queued')

  host2.send({ type: 'command_result', commandId: 'cmd-1', idempotencyKey: 'idem-1', sessionId: 337, action: 'send_message', status: 'executed', errorCode: null, timestamp: 1757000100 })
  const result = await device.recvFrame()
  assert.equal(result.type, 'command_result')
  assert.equal(result.status, 'executed')
})

test('命令幂等：排队态同 key 重试 → 同一 queued 应答；同 key 异 payload → COMMAND_KEY_CONFLICT', async (t) => {
  const world = await setupWorld(t)
  const { device } = await pairDevice(world)
  world.host.destroy()
  await sleep(100)
  const base = { type: 'command', requestId: 'dev-cmd-2', idempotencyKey: 'idem-2', sessionId: 337, action: 'send_message', payload: { text: 'a' }, auth: { token: 't', ts: 1, nonce: 'n' }, createdAt: 1 }
  device.send(base)
  const ack1 = await device.recvFrame()
  assert.equal(ack1.queued, true)
  device.send({ ...base, requestId: 'dev-cmd-2-retry' })
  const ack2 = await device.recvFrame()
  assert.equal(ack2.queued, true)
  device.send({ ...base, requestId: 'dev-cmd-3', payload: { text: 'different' } })
  const conflict = await device.recvFrame()
  assert.equal(conflict.type, 'command_ack')
  assert.equal(conflict.status, 'rejected')
  assert.equal(conflict.errorCode, 'COMMAND_KEY_CONFLICT')
})

test('同 key 重试返回原结果（终态后重试，docs/14 §B.5 语义）', async (t) => {
  const world = await setupWorld(t)
  const { device } = await pairDevice(world)
  const base = { type: 'command', requestId: 'dev-cmd-4', idempotencyKey: 'idem-4', sessionId: 337, action: 'pause', auth: { token: 't', ts: 1, nonce: 'n' }, createdAt: 1 }
  device.send(base)
  const relayed = await world.host.recvFrame()
  void relayed
  world.host.send({ type: 'command_result', commandId: 'cmd-4', idempotencyKey: 'idem-4', sessionId: 337, action: 'pause', status: 'executed', errorCode: null, timestamp: 100 })
  const result = await device.recvFrame()
  assert.equal(result.status, 'executed')
  device.send({ ...base, requestId: 'dev-cmd-4-retry' })
  const replay = await device.recvFrame()
  assert.equal(replay.type, 'command_result')
  assert.equal(replay.commandId, 'cmd-4')
})

test('排队上限（每设备）→ error RELAY_QUEUE_FULL（docs/18 §3.9）', async (t) => {
  const world = await setupWorld(t, { RELAY_QUEUE_LIMIT_PER_DEVICE: '1' })
  const { device } = await pairDevice(world)
  world.host.destroy()
  await sleep(100)
  device.send({ type: 'command', requestId: 'q1', idempotencyKey: 'k1', sessionId: 1, action: 'pause', auth: { token: 't', ts: 1, nonce: 'n1' }, createdAt: 1 })
  const ack1 = await device.recvFrame()
  assert.equal(ack1.queued, true)
  device.send({ type: 'command', requestId: 'q2', idempotencyKey: 'k2', sessionId: 1, action: 'pause', auth: { token: 't', ts: 1, nonce: 'n2' }, createdAt: 1 })
  const full = await device.recvFrame()
  assert.equal(full.type, 'error')
  assert.equal(full.code, 'RELAY_QUEUE_FULL')
})

test('排队 TTL 过期 → expired + error COMMAND_EXPIRED 回流（docs/18 §5.2）', async (t) => {
  const world = await setupWorld(t, { RELAY_COMMAND_TTL_SEC: '2' })
  const { device } = await pairDevice(world)
  world.host.destroy()
  await sleep(100)
  device.send({ type: 'command', requestId: 'exp-1', idempotencyKey: 'ek1', sessionId: 1, action: 'pause', auth: { token: 't', ts: 1, nonce: 'n' }, createdAt: 1 })
  const ack = await device.recvFrame()
  assert.equal(ack.queued, true)
  const expired = await device.recvFrame(6000)
  assert.equal(expired.type, 'error')
  assert.equal(expired.code, 'COMMAND_EXPIRED')
  // host 上线后不投递已过期命令
  const host2 = new TestWsClient()
  await host2.connect(world.port, '/relay/host', { Authorization: `Bearer ${world.credential}` })
  await host2.recvFrame() // hello
  await assert.rejects(
    () => host2.recv(600),
    (err) => /timeout/.test(err.message),
    '过期命令不投递',
  )
})

test('host 在线：command 原样中继 → command_ack rejected（errorCode 透传）', async (t) => {
  const world = await setupWorld(t)
  const { device } = await pairDevice(world)
  device.send({ type: 'command', requestId: 'cmd-on-1', idempotencyKey: 'kon1', sessionId: 337, action: 'approve', payload: { decision: 'allow' }, auth: { token: 't', ts: 1, nonce: 'n' }, createdAt: 1 })
  const relayed = await world.host.recvFrame()
  assert.equal(relayed.action, 'approve', 'approve 纯透传（ECS 不理解语义，docs/20 §2.2）')
  world.host.send({ type: 'command_ack', requestId: 'cmd-on-1', idempotencyKey: 'kon1', commandId: 'cmd-9', status: 'rejected', errorCode: 'AGENT_CAPABILITY_MISSING' })
  const ack = await device.recvFrame()
  assert.equal(ack.status, 'rejected')
  assert.equal(ack.errorCode, 'AGENT_CAPABILITY_MISSING')
})

test('A⑥ 修 1：僵尸窗口排队态重发 → 立即 queued:true + 武装帧保留（host 重连重投）', async (t) => {
  const world = await setupWorld(t)
  const { device } = await pairDevice(world)
  // A⑤ 确定性复现手法：destroy 后立即首发+重发，不等 hostOnline 翻转
  world.host.destroy()
  const base = { type: 'command', requestId: 'zx-1', idempotencyKey: 'zx-key', sessionId: 1, action: 'pause', auth: { token: 't', ts: 1, nonce: 'n1' }, createdAt: 1 }
  device.send({ ...base })
  device.send({ ...base, requestId: 'zx-1-retry', auth: { ...base.auth, nonce: 'n2' } })
  // 重发必须立即获得 queued:true 回执（修复前：武装帧被删 + 无任何 ack → 石沉大海）
  let ack = null
  for (let i = 0; i < 4 && ack === null; i += 1) {
    const f = await device.recvFrame(3000)
    if (f.type === 'command_ack' && f.idempotencyKey === 'zx-key') ack = f
  }
  assert.equal(ack?.status, 'accepted', '重发 → accepted')
  assert.equal(ack?.queued, true, '重发 → 立即 queued:true（同步回执）')
  // 武装帧保留（僵尸写兜底：真送达由 host 回执清武装）
  assert.equal(world.handle.forwarder.debugQueuedMemoryCount(), 1, '排队态重发不删除武装帧')
  const host2 = new TestWsClient()
  await host2.connect(world.port, '/relay/host', { Authorization: `Bearer ${world.credential}` })
  await host2.recvFrame() // hello
  let delivered = null
  for (let i = 0; i < 4 && delivered === null; i += 1) {
    const f = await host2.recvFrame(5000)
    if (f.type === 'command' && f.idempotencyKey === 'zx-key') delivered = f
  }
  assert.notEqual(delivered, null, 'host 重连 → 武装帧重投（完整帧含 auth）')
  host2.send({ type: 'command_ack', requestId: delivered.requestId, idempotencyKey: 'zx-key', commandId: 'cmd-zx', status: 'accepted' })
  let realAck = null
  for (let i = 0; i < 4 && realAck === null; i += 1) {
    const f = await device.recvFrame(3000)
    if (f.type === 'command_ack' && f.commandId === 'cmd-zx') realAck = f
  }
  assert.notEqual(realAck, null, 'host 真回执回流设备（accepted 不带 queued）')
  assert.equal(realAck.queued, undefined)
})

// ---- 事件/sync/heartbeat ---------------------------------------------------------

test('event 扇出：deviceId 填充 + 缓存幂等；sync_request 补发 + ACK 中继', async (t) => {
  const world = await setupWorld(t)
  const { device, ecsDeviceId } = await pairDevice(world)
  const ev = (seq, eventId) => ({
    type: 'event', sequence: seq, eventId, provider: 'codex', sessionId: 337,
    eventType: 'session.waiting_input', timestamp: 1757000000 + seq,
    summary: 's', payload: { sessionId: 337 }, requiresUserAction: true,
  })
  world.host.send(ev(1, 'ev-1'))
  const fanout = await device.recvFrame()
  assert.equal(fanout.type, 'event')
  assert.equal(fanout.deviceId, ecsDeviceId, 'ECS 扇出填充 deviceId')
  assert.equal(fanout.requiresUserAction, true)
  // 同 seq 重发（回填）零重复扇出
  world.host.send(ev(1, 'ev-1'))
  world.host.send(ev(2, 'ev-2'))
  const second = await device.recvFrame()
  assert.equal(second.sequence, 2, '重复 sequence 不重复扇出')

  device.send({ type: 'sync_request', requestId: 'sync-1', after: 0 })
  const hostSync = await world.host.recvFrame()
  assert.equal(hostSync.type, 'sync_request')
  assert.equal(hostSync.after, 0)
  assert.equal(hostSync.deviceId, ecsDeviceId, 'E→H 仅 ACK 部分中继（带 deviceId）')
  const syncResponse = await device.recvFrame()
  assert.equal(syncResponse.type, 'sync_response')
  assert.equal(syncResponse.hasMore, false)
  assert.equal(syncResponse.hasGaps, false)
  assert.deepEqual(syncResponse.events.map((e) => e.sequence), [1, 2])
  assert.equal(syncResponse.events[0].eventType, 'session.waiting_input')

  device.send({ type: 'heartbeat', ts: 1, lastAckedSeq: 2, tokenVersion: 1 })
  const hb = await device.recvFrame()
  assert.equal(hb.type, 'heartbeat')
  assert.equal(hb.upstream, 'connected')
  assert.equal(hb.queuedCommands, 0)
})

test('hasGaps：缓存洞显式标注（绝不静默跳号，docs/18 §6.3）', async (t) => {
  const world = await setupWorld(t)
  const { device } = await pairDevice(world)
  const ev = (seq) => ({ type: 'event', sequence: seq, eventId: `g-${seq}`, provider: 'codex', eventType: 'message.appended', timestamp: seq, payload: {}, requiresUserAction: false })
  world.host.send(ev(1))
  await device.recvFrame()
  world.host.send(ev(3))
  await device.recvFrame()
  // after=1：范围 (1,3] 缺 seq 2 → hasGaps true，页只含 seq 3
  device.send({ type: 'sync_request', requestId: 'sync-2', after: 1 })
  await world.host.recvFrame()
  const response = await device.recvFrame()
  assert.equal(response.hasGaps, true)
  assert.deepEqual(response.events.map((e) => e.sequence), [3])
})

test('device heartbeat 降级信标：host 断开 → upstream:disconnected', async (t) => {
  const world = await setupWorld(t)
  const { device } = await pairDevice(world)
  world.host.destroy()
  await sleep(100)
  device.send({ type: 'heartbeat', ts: 1, lastAckedSeq: 0, tokenVersion: 1 })
  const hb = await device.recvFrame()
  assert.equal(hb.upstream, 'disconnected', '降级信标（docs/18 §3.13）')
})

// ---- host heartbeat 活性触点（C6b 修：relay_hosts.last_seen_at 心跳刷新） --------

/** 独立连接读 relay_hosts.last_seen_at（WAL 只读快照；与既有测试读库惯例同款）。 */
async function readHostLastSeen(world) {
  const { Store } = await import('../src/store.ts')
  const store = new Store({ path: world.config.dbPath })
  const row = store.get('SELECT last_seen_at FROM relay_hosts WHERE id = ?', world.hostId)
  store.close()
  return row?.last_seen_at
}

/** 独立连接把 last_seen_at 回拨 1h（模拟陈旧值，规避同秒相等闪断的确定性手法）。 */
async function backdateHostLastSeen(world) {
  const { Store } = await import('../src/store.ts')
  const store = new Store({ path: world.config.dbPath })
  const stale = Math.floor(Date.now() / 1000) - 3600
  store.run('UPDATE relay_hosts SET last_seen_at = ? WHERE id = ?', stale, world.hostId)
  store.close()
  return stale
}

test('host heartbeat 刷新 relay_hosts.last_seen_at（C6b 修：admit 后心跳帧即活性触点）', async (t) => {
  const world = await setupWorld(t)
  const stale = await backdateHostLastSeen(world)
  world.host.send({ type: 'heartbeat', ts: 1 })
  assert.equal((await world.host.recvFrame()).type, 'heartbeat')
  const after = await readHostLastSeen(world)
  assert.ok(after !== undefined && after > stale, `心跳刷新 last_seen：${stale} → ${after}（修复前滞留 admit 值）`)
  assert.ok(after >= Math.floor(Date.now() / 1000) - 5, '刷新值 ≈ now（非陈旧残留）')
})

test('host heartbeat 第二帧也刷新 last_seen_at（每帧心跳均触点，非仅首帧生效）', async (t) => {
  const world = await setupWorld(t)
  // 第一帧心跳（admit 后首帧）正常往返
  world.host.send({ type: 'heartbeat', ts: 1 })
  assert.equal((await world.host.recvFrame()).type, 'heartbeat')
  // 回拨后第二帧必须同样刷新——排除「仅第一帧/仅 admit 生效」回归形态
  const stale = await backdateHostLastSeen(world)
  world.host.send({ type: 'heartbeat', ts: 2 })
  assert.equal((await world.host.recvFrame()).type, 'heartbeat')
  const after = await readHostLastSeen(world)
  assert.ok(after !== undefined && after > stale, `第二帧心跳同样刷新：${stale} → ${after}`)
  assert.ok(after >= Math.floor(Date.now() / 1000) - 5, '刷新值 ≈ now')
})

// ---- 轮换与撤销 -----------------------------------------------------------------

test('token_rotation：注册表 hash 同步 + E→D 转发；宽限窗内新旧 Token 均 200（docs/18 §3.14/§9.4）', async (t) => {
  const world = await setupWorld(t)
  const oldToken = `devtok-${randomHex32()}`
  const { device } = await pairDevice(world, { deviceToken: oldToken })
  const newToken = `devtok-new-${randomHex32()}`
  world.host.send({ type: 'token_rotation', requestId: 'rot-1', deviceId: 12, newToken, tokenVersion: 2, reason: 'post-pairing' })
  const rotation = await device.recvFrame()
  assert.equal(rotation.type, 'token_rotation')
  assert.equal(rotation.newToken, newToken)
  assert.equal(rotation.tokenVersion, 2)
  const device2 = new TestWsClient()
  await device2.connect(world.port, '/relay/device', { Authorization: `Bearer ${newToken}` })
  const hello = await device2.recvFrame()
  assert.equal(hello.type, 'hello')
  device2.destroy()
  // 宽限三态②（docs/18 §9.4「300s 宽限内旧 Token 仍可连」；窗外 401 见短窗专项用例）
  const device3 = new TestWsClient()
  await device3.connect(world.port, '/relay/device', { Authorization: `Bearer ${oldToken}` })
  const helloOld = await device3.recvFrame()
  assert.equal(helloOld.type, 'hello')
  device3.destroy()
  device.destroy()
})

test('token_rotation 300s 宽限三态：窗内旧 200 / 窗外 401 / 新恒 200 + 宽限连接清扫（docs/18 §3.14，M3-C3b 修1）', async (t) => {
  const world = await setupWorld(t, { RELAY_ROTATION_GRACE_SEC: '2' })
  const oldToken = `devtok-old-${randomHex32()}`
  const { device } = await pairDevice(world, { deviceToken: oldToken })
  const newToken = `devtok-new-${randomHex32()}`
  world.host.send({ type: 'token_rotation', requestId: 'rot-grace-1', deviceId: 12, newToken, tokenVersion: 2, reason: 'post-pairing' })
  const rotation = await device.recvFrame()
  assert.equal(rotation.type, 'token_rotation')

  // ① 新 token 恒 200（注册表主哈希已切换）
  const withNew = new TestWsClient()
  await withNew.connect(world.port, '/relay/device', { Authorization: `Bearer ${newToken}` })
  assert.equal((await withNew.recvFrame()).type, 'hello')

  // ② 窗内旧 token → 200（grace 准入，audit device 类目）
  const graceConn = new TestWsClient()
  await graceConn.connect(world.port, '/relay/device', { Authorization: `Bearer ${oldToken}` })
  assert.equal((await graceConn.recvFrame()).type, 'hello')

  // ③ 窗口过期：宽限连接先收 disconnect{superseded}（§3.15 E→D 合法 reason）再关闭；
  //    旧 token 重连 401 RELAY_DEVICE_UNKNOWN → 重配对路径（审计 grace_expired 落库）
  const kick = await graceConn.recvFrame(6000)
  assert.equal(kick.type, 'disconnect')
  assert.equal(kick.reason, 'superseded')
  const close = await graceConn.recvClose(3000)
  assert.equal(close.code, 1000)
  const rejected = await TestWsClient.readUpgradeRejection(world.port, '/relay/device', { Authorization: `Bearer ${oldToken}` })
  assert.equal(rejected.statusLine.includes('401'), true)
  assert.equal(rejected.body.error.code, 'RELAY_DEVICE_UNKNOWN')

  // ④ 窗外新 token 仍 200（维持新 Token 生效，无回滚位）
  const withNew2 = new TestWsClient()
  await withNew2.connect(world.port, '/relay/device', { Authorization: `Bearer ${newToken}` })
  assert.equal((await withNew2.recvFrame()).type, 'hello')
  withNew.destroy()
  withNew2.destroy()
  device.destroy()

  // 审计：admitted / expired / closed 三动作落 device 类目（零凭据 detail）
  const { Store } = await import('../src/store.ts')
  const store = new Store({ path: world.config.dbPath })
  const actions = store.all("SELECT action FROM relay_audit WHERE action LIKE 'token_rotation_grace%'").map((r) => r.action)
  store.close()
  assert.equal(actions.includes('token_rotation_grace_admitted'), true, '宽限准入审计')
  assert.equal(actions.includes('token_rotation_grace_expired'), true, '宽限过期拒绝审计（docs/18 §3.14 结果落库）')
  assert.equal(actions.includes('token_rotation_grace_closed'), true, '宽限连接清扫审计')
})

// ---- C7a 轮换投递两腿（裸 pair 窗冲刷 + 重连补偿，零新帧） -------------------------

/** 手工配对流前半（register_pairing → pair → pair_accepted 到达裸连接；不重连不留窗）。 */
async function pairAcceptedOnBare(world, { code = 'A3K7M9XY', deviceToken, winDeviceId = 12 } = {}) {
  world.host.send({ type: 'register_pairing', requestId: rid(), pairingId: 'pair-' + randomHex32(), codeHash: sha256hex(code), expiresAt: Math.floor(Date.now() / 1000) + 300 })
  const regAck = await world.host.recvFrame()
  assert.equal(regAck.type, 'register_pairing_ack')
  const bare = new TestWsClient()
  await bare.connect(world.port, '/relay/device')
  await bare.recvFrame() // hello
  bare.send({ type: 'pair', requestId: rid(), code, deviceName: 'Pixel 8', platform: 'android' })
  const pairRelayed = await world.host.recvFrame()
  assert.equal(pairRelayed.type, 'pair')
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
  return { bare, ecsDeviceId: pairRelayed.ecsDeviceId }
}

test('C7a 修①裸 pair 窗冲刷：pair_accepted 后同窗 token_rotation 经裸 pair 腿关闭前投递（C2d 缺口#10）', async (t) => {
  const world = await setupWorld(t)
  const oldToken = `devtok-${randomHex32()}`
  const { bare } = await pairAcceptedOnBare(world, { deviceToken: oldToken })
  // C2d 场景：pair_accepted 发出同秒 pairingBridge 轮换（裸连接仍在冲刷窗内）
  const newToken = `devtok-new-${randomHex32()}`
  world.host.send({ type: 'token_rotation', requestId: 'rot-flush-1', deviceId: 12, newToken, tokenVersion: 2, reason: 'post-pairing' })
  const flushed = await bare.recvFrame()
  assert.equal(flushed.type, 'token_rotation', '轮换帧经裸 pair 腿冲刷投递（修复前静默丢弃）')
  assert.equal(flushed.newToken, newToken)
  assert.equal(flushed.tokenVersion, 2)
  const close = await bare.recvClose()
  assert.equal(close.code, 1000, '冲刷后裸连接收口（引导新凭据重连）')
  // 注册表已切换：新凭据可连
  const withNew = new TestWsClient()
  await withNew.connect(world.port, '/relay/device', { Authorization: `Bearer ${newToken}` })
  assert.equal((await withNew.recvFrame()).type, 'hello')
  withNew.destroy()
  // 审计可追溯：source=pair-window
  const { Store } = await import('../src/store.ts')
  const store = new Store({ path: world.config.dbPath })
  const row = store.get("SELECT detail_json FROM relay_audit WHERE action = 'token_rotation_flushed' ORDER BY id DESC")
  store.close()
  assert.notEqual(row, undefined, '冲刷审计落库')
  assert.equal(row.detail_json.includes('"source":"pair-window"'), true, '审计记 source=pair-window')
})

test('C7a 修①时序：pair 窗内无 token_rotation → 窗到期裸连接按原语义关闭（1000）', async (t) => {
  const world = await setupWorld(t, { RELAY_PAIR_ROTATION_FLUSH_SEC: '1' })
  const { bare } = await pairAcceptedOnBare(world, { deviceToken: `devtok-${randomHex32()}` })
  const close = await bare.recvClose(3000)
  assert.equal(close.code, 1000, '无轮换 → 窗到期关闭（原「配对完成」收口语义）')
  assert.match(close.reason, /pairing complete/)
})

test('C7a 修①收口：Bearer 准入即触发 pair 窗收口（不待窗到期残留裸连接）', async (t) => {
  const world = await setupWorld(t)
  const deviceToken = `devtok-${randomHex32()}`
  const { bare } = await pairAcceptedOnBare(world, { deviceToken })
  const device = new TestWsClient()
  await device.connect(world.port, '/relay/device', { Authorization: `Bearer ${deviceToken}` })
  assert.equal((await device.recvFrame()).type, 'hello')
  const close = await bare.recvClose(3000)
  assert.equal(close.code, 1000, '设备重连 → pair 腿即退役')
  device.destroy()
})

test('C7a 修②重连补偿：漏投轮换 + grace 窗内旧 Token 重连 → admit 后补投当前 token_rotation', async (t) => {
  const world = await setupWorld(t, { RELAY_ROTATION_GRACE_SEC: '4' })
  const oldToken = `devtok-old-${randomHex32()}`
  const { device } = await pairDevice(world, { deviceToken: oldToken })
  device.destroy()
  await sleep(100)
  // 设备离线期间轮换（漏投：无任何已注册连接可投）→ 补偿登记
  const newToken = `devtok-new-${randomHex32()}`
  world.host.send({ type: 'token_rotation', requestId: 'rot-comp-1', deviceId: 12, newToken, tokenVersion: 2, reason: 'post-pairing' })
  await sleep(200)
  assert.equal(world.handle.forwarder.debugPendingRotationCount(), 1, '漏投登记入补偿表')
  // grace 窗内旧凭据重连 → hello 后立即补投
  const graceConn = new TestWsClient()
  await graceConn.connect(world.port, '/relay/device', { Authorization: `Bearer ${oldToken}` })
  assert.equal((await graceConn.recvFrame()).type, 'hello')
  const comp = await graceConn.recvFrame()
  assert.equal(comp.type, 'token_rotation', 'admit 后补投 token_rotation(当前 token)')
  assert.equal(comp.newToken, newToken)
  assert.equal(comp.tokenVersion, 2)
  // 设备切换新凭据 → 准入正常 + 补偿登记清空（正信号撤销登记）
  const withNew = new TestWsClient()
  await withNew.connect(world.port, '/relay/device', { Authorization: `Bearer ${newToken}` })
  assert.equal((await withNew.recvFrame()).type, 'hello')
  withNew.destroy()
  graceConn.destroy()
  assert.equal(world.handle.forwarder.debugPendingRotationCount(), 0, '新凭据准入清补偿登记')
  // 审计可追溯：source=compensation
  const { Store } = await import('../src/store.ts')
  const store = new Store({ path: world.config.dbPath })
  const row = store.get("SELECT detail_json FROM relay_audit WHERE action = 'token_rotation_flushed' AND detail_json LIKE '%compensation%' ORDER BY id DESC")
  store.close()
  assert.notEqual(row, undefined, '补偿审计落库且记 source=compensation')
})

test('C7a 修②不误发：在线直投成功的轮换，其后 grace 准入连接不收补偿帧（§11 三态基线保持）', async (t) => {
  const world = await setupWorld(t, { RELAY_ROTATION_GRACE_SEC: '4' })
  const oldToken = `devtok-old-${randomHex32()}`
  const { device } = await pairDevice(world, { deviceToken: oldToken })
  const newToken = `devtok-new-${randomHex32()}`
  world.host.send({ type: 'token_rotation', requestId: 'rot-online-1', deviceId: 12, newToken, tokenVersion: 2, reason: 'post-pairing' })
  const rotation = await device.recvFrame()
  assert.equal(rotation.type, 'token_rotation', '在线直投（契约路径）')
  assert.equal(world.handle.forwarder.debugPendingRotationCount(), 0, '直投成功不入补偿表')
  // 同设备另一连接以旧凭据窗内准入（§11 ②形态）：只收 hello，绝无补偿帧
  const graceConn = new TestWsClient()
  await graceConn.connect(world.port, '/relay/device', { Authorization: `Bearer ${oldToken}` })
  assert.equal((await graceConn.recvFrame()).type, 'hello')
  await assert.rejects(() => graceConn.recv(600), /recv timeout/, '零补偿误发（否则 §11 断言次序被打破）')
  graceConn.destroy()
  device.destroy()
})

test('C7a 修②红线：grace 窗外旧 Token 仍 401 RELAY_DEVICE_UNKNOWN、补偿绝不越窗（不动摇）', async (t) => {
  const world = await setupWorld(t, { RELAY_ROTATION_GRACE_SEC: '2' })
  const oldToken = `devtok-old-${randomHex32()}`
  const { device } = await pairDevice(world, { deviceToken: oldToken })
  device.destroy()
  await sleep(100)
  const newToken = `devtok-new-${randomHex32()}`
  world.host.send({ type: 'token_rotation', requestId: 'rot-late-1', deviceId: 12, newToken, tokenVersion: 2, reason: 'post-pairing' })
  await sleep(200)
  assert.equal(world.handle.forwarder.debugPendingRotationCount(), 1, '漏投已登记（窗内时点）')
  // 窗过期后：旧凭据 401（重配对路径），补偿不越窗复活旧凭据
  await sleep(2200)
  const rejected = await TestWsClient.readUpgradeRejection(world.port, '/relay/device', { Authorization: `Bearer ${oldToken}` })
  assert.equal(rejected.statusLine.includes('401'), true, '窗外旧 Token → 401')
  assert.equal(rejected.body.error.code, 'RELAY_DEVICE_UNKNOWN')
  // 补偿登记随窗过期清扫（明文帧不越窗存活；grace 2s → sweep 500ms）
  await waitFor(() => world.handle.forwarder.debugPendingRotationCount() === 0, 2000, 50)
  assert.equal(world.handle.forwarder.debugPendingRotationCount(), 0, '窗过期 → 补偿登记清扫（明文帧零越窗）')
  // 新凭据不受影响
  const withNew = new TestWsClient()
  await withNew.connect(world.port, '/relay/device', { Authorization: `Bearer ${newToken}` })
  assert.equal((await withNew.recvFrame()).type, 'hello')
  withNew.destroy()
})

test('token_rotation/disconnect deviceId 单一语义：win_device_id 未命中不按行 id 兜底（重叠 id 回归，M3-C3b 修2）', async (t) => {
  const world = await setupWorld(t)
  // 两平面 id 重叠构造：设备 A win_device_id=12 → ECS 行 id=1；设备 B win_device_id=1 → ECS 行 id=2
  const a = await pairDevice(world, { deviceToken: `devtok-A-${randomHex32()}`, winDeviceId: 12, code: 'A3K7M9XY' })
  const b = await pairDevice(world, { deviceToken: `devtok-B-${randomHex32()}`, winDeviceId: 1, code: 'B7Q2M4XA' })
  assert.equal(a.ecsDeviceId, 1)
  assert.equal(b.ecsDeviceId, 2)

  // disconnect{deviceId:1} → 契约 deviceId = Windows 侧 id：路由到 B（win_device_id=1），
  // 绝不触碰 ECS 行 id=1（A）——修复前按行 id 兜底曾致撤销错位（C2 #6 实测）
  world.host.send({ type: 'disconnect', deviceId: 1, reason: 'revoked' })
  const kick = await b.device.recvFrame()
  assert.equal(kick.type, 'disconnect')
  assert.equal(kick.reason, 'revoked')
  await b.device.recvClose()
  // A 连接不受影响（心跳往返即存活证明）
  a.device.send({ type: 'heartbeat', ts: 1, lastAckedSeq: 0, tokenVersion: 1 })
  assert.equal((await a.device.recvFrame()).type, 'heartbeat')

  const { Store } = await import('../src/store.ts')
  const readDb = () => {
    const store = new Store({ path: world.config.dbPath })
    const rows = store.all('SELECT id, win_device_id, status FROM relay_devices ORDER BY id')
    store.close()
    return rows
  }
  let rows = readDb()
  assert.equal(rows.find((r) => r.id === 1)?.status, 'active', 'ECS 行 id=1（win=12）未被错位撤销')
  assert.equal(rows.find((r) => r.id === 2)?.status, 'revoked', 'win_device_id=1 的行被正确撤销')

  // 未命中（无任何 win_device_id=3 的行）→ 丢弃 + 审计 mismatch；ECS 行 id=3 若存在也绝不兜底
  const c = await pairDevice(world, { deviceToken: `devtok-C-${randomHex32()}`, winDeviceId: 2, code: 'C9R4N6XB' })
  assert.equal(c.ecsDeviceId, 3)
  world.host.send({ type: 'disconnect', deviceId: 3, reason: 'revoked' })
  await sleep(200)
  c.device.send({ type: 'heartbeat', ts: 1, lastAckedSeq: 0, tokenVersion: 1 })
  assert.equal((await c.device.recvFrame()).type, 'heartbeat', '行 id 兜底不复存在：ECS 行 id=3 连接存活')
  rows = readDb()
  assert.equal(rows.find((r) => r.id === 3)?.status, 'active', 'ECS 行 id=3（win=2）未被错位撤销')

  // token_rotation 同一语义：deviceId 未命中 → NOT_FOUND + 审计 mismatch，注册表零改动
  const cToken = `devtok-C-rot-${randomHex32()}`
  world.host.send({ type: 'token_rotation', requestId: 'rot-miss-1', deviceId: 3, newToken: cToken, tokenVersion: 9, reason: 'post-pairing' })
  const rotErr = await world.host.recvFrame()
  assert.equal(rotErr.type, 'error')
  assert.equal(rotErr.code, 'NOT_FOUND')
  const c2 = new TestWsClient()
  await c2.connect(world.port, '/relay/device', { Authorization: `Bearer ${c.deviceToken}` })
  assert.equal((await c2.recvFrame()).type, 'hello', '错位轮换未发生：C 原 token 仍有效')
  c2.destroy()

  const auditStore = new Store({ path: world.config.dbPath })
  const auditActions = auditStore.all("SELECT action, detail_json FROM relay_audit WHERE action LIKE '%mismatch%' ORDER BY id")
  auditStore.close()
  assert.equal(auditActions.some((r) => r.action === 'device_disconnect_mismatch' && r.detail_json.includes('"deviceId":3')), true, 'disconnect 未命中审计 mismatch')
  assert.equal(auditActions.some((r) => r.action === 'token_rotation_route_mismatch' && r.detail_json.includes('"deviceId":3')), true, 'rotation 未命中审计 mismatch')
  c.device.destroy()
  a.device.destroy()
})

test('token_rotation 缺 deviceId → BAD_PAYLOAD（路由缺口显式拒绝，见 README 偏离单）', async (t) => {
  const world = await setupWorld(t)
  await pairDevice(world)
  world.host.send({ type: 'token_rotation', requestId: 'rot-2', newToken: 'x-new-token-value-000', tokenVersion: 2, reason: 'post-pairing' })
  const err = await world.host.recvFrame()
  assert.equal(err.type, 'error')
  assert.equal(err.code, 'BAD_PAYLOAD')
})

test('disconnect(revoked)：定点踢线 + 重连 401 DEVICE_REVOKED（docs/18 §3.15/§9.5）', async (t) => {
  const world = await setupWorld(t)
  const { device, deviceToken } = await pairDevice(world)
  world.host.send({ type: 'disconnect', deviceId: 12, reason: 'revoked' })
  const kick = await device.recvFrame()
  assert.equal(kick.type, 'disconnect')
  assert.equal(kick.reason, 'revoked')
  const close = await device.recvClose()
  assert.equal(close.code, 1000)
  const rejected = await TestWsClient.readUpgradeRejection(world.port, '/relay/device', { Authorization: `Bearer ${deviceToken}` })
  assert.equal(rejected.body.error.code, 'DEVICE_REVOKED')
})

test('优雅停机：disconnect(server_shutdown) 先行 + 排队命令状态行持久（重启恢复基础）', async (t) => {
  const world = await setupWorld(t)
  const { device } = await pairDevice(world)
  world.host.destroy()
  await sleep(100)
  device.send({ type: 'command', requestId: 'sd-1', idempotencyKey: 'sdk1', sessionId: 1, action: 'pause', auth: { token: 't', ts: 1, nonce: 'n' }, createdAt: 1 })
  const ack = await device.recvFrame()
  assert.equal(ack.queued, true)
  await world.handle.close()
  const closeInfo = await device.recvClose(3000)
  assert.equal(closeInfo.code, 1000)
  const { Store, ensureSchema, SCHEMA_DIR } = await import('../src/store.ts')
  const store = new Store({ path: world.config.dbPath })
  ensureSchema(store, SCHEMA_DIR)
  const row = store.get("SELECT status FROM relay_commands WHERE idempotency_key = 'sdk1'")
  assert.equal(row.status, 'queued', '排队命令状态行持久（重启恢复语义）')
  store.close()
})

test('升级路径不存在 → 404 拒绝升级', async (t) => {
  const world = await setupWorld(t)
  const rejected = await TestWsClient.readUpgradeRejection(world.port, '/relay/other', {})
  assert.equal(rejected.statusLine.includes('404'), true)
})

test('bootRelay 冒烟（端口段外 + 绑定回环）', async (t) => {
  const world = await bootRelay(t)
  assert.ok(world.port > 10000, `随机高端口（实测 ${world.port}），绝不占 8746-8755`)
  assert.notEqual([8746, 8747, 8748, 8749, 8750, 8751, 8752, 8753, 8754, 8755].includes(world.port), true)
})

test('A⑥ 回归：recv 超时循环不泄漏死 waiter（帧绝不被静默吞掉）', async (t) => {
  const world = await setupWorld(t)
  const { device } = await pairDevice(world)
  // 制造 3 次 recv 超时（修复前：每次超时泄漏一个已 reject 的死 waiter 滞留队头，
  // 下一帧 push 喂给死 waiter = 静默吞帧——loadtest ⑤ ECS 路径 ack 消失的根因）
  for (let i = 0; i < 3; i += 1) {
    await assert.rejects(() => device.recv(30), /recv timeout/)
  }
  device.send({ type: 'heartbeat', ts: 1, lastAckedSeq: 0, tokenVersion: 1 })
  const hb = await device.recvFrame(3000)
  assert.equal(hb.type, 'heartbeat')
  assert.equal(hb.upstream, 'connected')
  assert.equal(device.waiters.length, 0, '无泄漏残留 waiter（修复前残留 3 个死 waiter）')
})
