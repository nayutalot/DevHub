/**
 * test/rest.test.mjs — REST 面集成测试（docs/18 §7 端点表/§7.3 降级/§7.4 鉴权防线/§8 错误映射）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { restFetch, setupWorld, pairDevice, sleep, randomHex32 } from './helpers.mjs'

function replay() {
  return { ts: Math.floor(Date.now() / 1000), nonce: randomHex32() + randomHex32() }
}

/** 发起 REST 请求并在请求期间以 host 身份回帧（同步完成中继往返）。 */
async function restFetchViaHost(world, token, path, responseFields, method = 'GET') {
  const h = replay()
  const pending = world.host.recvFrame()
  const resPromise = restFetch(world.port, path, { token, ...h, method })
  const relayed = await pending
  world.host.send({ type: relayed.type, requestId: relayed.requestId, ...responseFields })
  const result = await resPromise
  return { ...result, relayed }
}

test('GET /v1/health：无鉴权活性 + upstream 信标（docs/18 §7.1）', async (t) => {
  const world = await setupWorld(t)
  const { status, json } = await restFetch(world.port, '/v1/health')
  assert.equal(status, 200)
  assert.equal(json.ok, true)
  assert.equal(json.name, 'devhub-relay')
  assert.equal(json.version, '1.0.0')
  assert.equal(typeof json.uptimeSec, 'number')
  assert.equal(typeof json.uptime, 'number')
  assert.deepEqual(json.upstream, { connected: true })
})

test('鉴权防线：缺 Bearer / 未知设备 / 防重放缺头 / 重放 nonce → 401 系（docs/18 §7.4/§8.2）', async (t) => {
  const world = await setupWorld(t)
  const { status: s1, json: j1 } = await restFetch(world.port, '/v1/agents')
  assert.equal(s1, 401)
  assert.equal(j1.error.code, 'AUTH_INVALID_TOKEN')

  const { status: s2, json: j2 } = await restFetch(world.port, '/v1/agents', { token: 'no-such-token' })
  assert.equal(s2, 401)
  assert.equal(j2.error.code, 'RELAY_DEVICE_UNKNOWN')

  const paired = await pairDevice(world)
  const h = replay()
  const { status: s3, json: j3 } = await restFetch(world.port, '/v1/agents', { token: paired.deviceToken })
  assert.equal(s3, 401)
  assert.equal(j3.error.code, 'AUTH_REPLAYED', '受保护请求必须带防重放两头')

  const nonce = randomHex32() + randomHex32()
  // 首次合法请求（登记 nonce；host 侧应答完成中继往返，避免等待 10s 帧超时）
  const h2 = { ts: Math.floor(Date.now() / 1000), nonce }
  const pendingOnce = world.host.recvFrame()
  const resOnce = restFetch(world.port, '/v1/agents', { token: paired.deviceToken, ...h2 })
  const relayedOnce = await pendingOnce
  world.host.send({ type: 'agent_list', requestId: relayedOnce.requestId, providers: [] })
  await resOnce
  const { status: s4, json: j4 } = await restFetch(world.port, '/v1/agents', { token: paired.deviceToken, ts: h2.ts, nonce })
  assert.equal(s4, 401)
  assert.equal(j4.error.code, 'AUTH_REPLAYED', 'nonce 10min LRU 去重')

  const { status: s5, json: j5 } = await restFetch(world.port, '/v1/agents', { token: paired.deviceToken, ts: Math.floor(Date.now() / 1000) - 400, nonce: randomHex32() + randomHex32() })
  assert.equal(s5, 401)
  assert.equal(j5.error.code, 'AUTH_REPLAYED', '±300s 窗外')
})

test('GET /v1/agents：host 在线 → 中继回传 providers（docs/14 §B.1 同形状）', async (t) => {
  const world = await setupWorld(t)
  const { deviceToken } = await pairDevice(world)
  const result = await restFetchViaHost(world, deviceToken, '/v1/agents', {
    providers: [{ id: 'codex', displayName: 'Codex', health: 'ok' }],
  })
  assert.equal(result.status, 200)
  assert.deepEqual(result.json, { providers: [{ id: 'codex', displayName: 'Codex', health: 'ok' }] })
})

test('GET /v1/sessions：host 在线 → 200 sessions；host 离线 → 200 + X-DevHub-Stale: true（缓存投影）', async (t) => {
  const world = await setupWorld(t)
  const { deviceToken } = await pairDevice(world)
  const ok = await restFetchViaHost(world, deviceToken, '/v1/sessions?providerId=codex&limit=50', { sessions: [{ id: 337, status: 'waiting_input' }] })
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.json, { sessions: [{ id: 337, status: 'waiting_input' }], stale: false })
  assert.equal(ok.relayed.query.providerId, 'codex')

  // 离线 + 缓存事件（session_ref 投影）
  world.host.send({ type: 'event', sequence: 1, eventId: 's-1', provider: 'codex', sessionId: 337, eventType: 'session.status_changed', timestamp: 1757000000, summary: 'x', payload: {}, requiresUserAction: false })
  await sleep(50)
  world.host.destroy()
  await sleep(100)
  const stale = await restFetch(world.port, '/v1/sessions', { token: deviceToken, ...replay() })
  assert.equal(stale.status, 200)
  assert.equal(stale.headers.get('x-devhub-stale'), 'true')
  assert.equal(stale.json.stale, true)
  assert.equal(stale.json.sessions.length, 1)
  assert.equal(stale.json.sessions[0].id, 337)
  assert.equal(stale.json.sessions[0].providerId, 'codex')
  assert.equal(stale.json.sessions[0].status, undefined, '缺失字段缺省（绝不构造猜测值）')
})

test('GET /v1/sessions/{id}：在线 200 {session, capabilities}；离线 503；未知 404', async (t) => {
  const world = await setupWorld(t)
  const { deviceToken } = await pairDevice(world)
  const ok = await restFetchViaHost(world, deviceToken, '/v1/sessions/337', { sessions: [{ id: 337 }], capabilities: { mode: 'managed' } })
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.json, { session: { id: 337 }, capabilities: { mode: 'managed' } })

  const missing = await restFetchViaHost(world, deviceToken, '/v1/sessions/999', { sessions: [] })
  assert.equal(missing.status, 404)
  assert.equal(missing.json.error.code, 'NOT_FOUND')

  world.host.destroy()
  await sleep(100)
  const offline = await restFetch(world.port, '/v1/sessions/337', { token: deviceToken, ...replay() })
  assert.equal(offline.status, 503)
  assert.equal(offline.json.error.code, 'RELAY_UPSTREAM_OFFLINE')
})

test('GET /v1/sessions/{id}/messages：after/last/before 互斥 → 400 BAD_PAYLOAD（ux A R10）', async (t) => {
  const world = await setupWorld(t)
  const { deviceToken } = await pairDevice(world)
  const bad = await restFetch(world.port, '/v1/sessions/337/messages?after=5&last=10', { token: deviceToken, ...replay() })
  assert.equal(bad.status, 400)
  assert.equal(bad.json.error.code, 'BAD_PAYLOAD')

  const ok = await restFetchViaHost(world, deviceToken, '/v1/sessions/337/messages?last=200', { items: [{ id: 9001, role: 'assistant', contentRedacted: 'x' }], prevAfter: 8800 })
  assert.equal(ok.status, 200)
  assert.equal(ok.json.items.length, 1)
  assert.equal(ok.json.prevAfter, 8800)
  assert.equal(ok.relayed.last, 200)
  assert.equal(JSON.stringify(ok.relayed).includes('sourceRef'), false, '绝无 sourceRef')

  const badLimit = await restFetch(world.port, '/v1/sessions/337/messages?limit=500', { token: deviceToken, ...replay() })
  assert.equal(badLimit.status, 400)
})

test('写动作 → 405 RELAY_REST_READONLY（docs/18 §7.2）', async (t) => {
  const world = await setupWorld(t)
  const { deviceToken } = await pairDevice(world)
  const post = await restFetch(world.port, '/v1/agents', { method: 'POST', token: deviceToken, ...replay() })
  assert.equal(post.status, 405)
  assert.equal(post.json.error.code, 'RELAY_REST_READONLY')
  const del = await restFetch(world.port, '/v1/sessions/337', { method: 'DELETE', token: deviceToken, ...replay() })
  assert.equal(del.status, 405)
})

test('限流三态（REST 面）：常规 120/min/设备 → 第 121 次 429；鉴权失败 5 次/60s/源 → 429（docs/18 §7.4）', async (t) => {
  const world = await setupWorld(t)
  const { deviceToken } = await pairDevice(world)
  world.host.destroy() // 路由层 503 但请求仍计入限流
  await sleep(100)
  let lastStatus = 0
  for (let i = 0; i < 121; i += 1) {
    const res = await restFetch(world.port, '/v1/sessions', { token: deviceToken, ...replay() })
    lastStatus = res.status
    if (res.status === 429) break
  }
  assert.equal(lastStatus, 429)
  const limited = await restFetch(world.port, '/v1/sessions', { token: deviceToken, ...replay() })
  assert.equal(limited.status, 429)
  assert.equal(limited.json.error.code, 'AUTH_RATE_LIMITED')
  assert.ok(limited.headers.get('retry-after') !== null)
})

test('鉴权失败限流：同源 5 次坏 Token 后，好 Token 也 429', async (t) => {
  const world = await setupWorld(t)
  const { deviceToken } = await pairDevice(world)
  for (let i = 0; i < 5; i += 1) {
    await restFetch(world.port, '/v1/agents', { token: `bad-${i}` })
  }
  const res = await restFetch(world.port, '/v1/agents', { token: deviceToken, ...replay() })
  assert.equal(res.status, 429)
  assert.equal(res.json.error.code, 'AUTH_RATE_LIMITED')
})

test('未知端点 → 404 NOT_FOUND', async (t) => {
  const world = await setupWorld(t)
  const { deviceToken } = await pairDevice(world)
  const res = await restFetch(world.port, '/v1/no-such', { token: deviceToken, ...replay() })
  assert.equal(res.status, 404)
  assert.equal(res.json.error.code, 'NOT_FOUND')
})
