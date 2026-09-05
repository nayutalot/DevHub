/**
 * test/forwarder.test.mjs — 中继编排集成测试：配对全流程/命令排队/幂等/过期/扇出/sync/轮换/踢线。
 * 全部走 127.0.0.1 随机高端口（端口 0 = OS 分配），绝不占 8746-8755。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bootRelay, TestWsClient, sleep, randomHex32, setupWorld, pairDevice, rid } from './helpers.mjs'

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

// ---- 轮换与撤销 -----------------------------------------------------------------

test('token_rotation：注册表 hash 同步 + E→D 转发；新 Token 生效旧 Token 401（docs/18 §3.14）', async (t) => {
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
  const rejected = await TestWsClient.readUpgradeRejection(world.port, '/relay/device', { Authorization: `Bearer ${oldToken}` })
  assert.equal(rejected.statusLine.includes('401'), true)
  assert.equal(rejected.body.error.code, 'RELAY_DEVICE_UNKNOWN')
  device.destroy()
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
