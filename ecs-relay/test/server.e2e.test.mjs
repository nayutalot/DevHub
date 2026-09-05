/**
 * test/server.e2e.test.mjs — 服务装配 e2e：host 注册面/upgrade 鉴权/优雅停机（启动冒烟等价）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bootRelay, TestWsClient, setupWorld, sleep } from './helpers.mjs'

test('host 注册面：未配置注册码 → 404（注册面关闭）；错码 → 401；对码 → 201 凭据', async (t) => {
  const world = await bootRelay(t, { RELAY_REGISTRATION_CODE: '' })
  const closed = await fetch(`http://127.0.0.1:${world.port}/relay/host`, { method: 'POST' })
  assert.equal(closed.status, 404)
  void closed

  const world2 = await setupWorld(t)
  const bad = await fetch(`http://127.0.0.1:${world2.port}/relay/host`, {
    method: 'POST',
    headers: { Authorization: 'Bearer wrong-code-000' },
    body: '{}',
  })
  assert.equal(bad.status, 401)
  const badJson = await bad.json()
  assert.equal(badJson.error.code, 'AUTH_INVALID_TOKEN')
})

test('host WS upgrade：凭据缺失/无效 → 401 拒绝升级（错误 JSON 形态，docs/18 §2）', async (t) => {
  const world = await setupWorld(t)
  const missing = await TestWsClient.readUpgradeRejection(world.port, '/relay/host', {})
  assert.equal(missing.statusLine.includes('401'), true)
  assert.equal(missing.body.error.code, 'AUTH_INVALID_TOKEN')
  const unknown = await TestWsClient.readUpgradeRejection(world.port, '/relay/host', { Authorization: 'Bearer no-such-cred' })
  assert.equal(unknown.body.error.code, 'RELAY_HOST_UNKNOWN')
})

test('device WS upgrade：无效 Token → 401 RELAY_DEVICE_UNKNOWN（docs/18 §8.2）', async (t) => {
  const world = await setupWorld(t)
  const rejected = await TestWsClient.readUpgradeRejection(world.port, '/relay/device', { Authorization: 'Bearer bad-token' })
  assert.equal(rejected.statusLine.includes('401'), true)
  assert.equal(rejected.body.error.code, 'RELAY_DEVICE_UNKNOWN')
})

test('优雅停机：close() 排空连接 + 二次 close 幂等（冒烟：裸进程起→health→停）', async (t) => {
  const world = await setupWorld(t)
  const health = await fetch(`http://127.0.0.1:${world.port}/v1/health`)
  assert.equal(health.status, 200)
  const device = new TestWsClient()
  await device.connect(world.port, '/relay/device')
  await device.recvFrame() // hello（裸连接）
  await world.handle.close()
  const closeInfo = await device.recvClose(3000)
  assert.equal(closeInfo.code, 1000)
  await world.handle.close() // 幂等
  // 停机后 health 不再可达
  await assert.rejects(() => fetch(`http://127.0.0.1:${world.port}/v1/health`))
})

test('多 host 连接滚动重启不互踢（docs/18 §2）', async (t) => {
  const world = await setupWorld(t)
  const host2 = new TestWsClient()
  await host2.connect(world.port, '/relay/host', { Authorization: `Bearer ${world.credential}` })
  const hello2 = await host2.recvFrame()
  assert.equal(hello2.type, 'hello')
  // 原 host 连接仍可用（发 register_pairing 有 ack 即证）
  world.host.send({ type: 'register_pairing', requestId: 'roll-1', pairingId: 'pair-roll', codeHash: 'a'.repeat(64), expiresAt: Math.floor(Date.now() / 1000) + 300 })
  const ack = await world.host.recvFrame()
  assert.equal(ack.type, 'register_pairing_ack')
  host2.destroy()
})
