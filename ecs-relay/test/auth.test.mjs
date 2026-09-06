/**
 * test/auth.test.mjs — 鉴权/防重放/限流三件套单测（auth.ts 蓝本语义等价性）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Store, ensureSchema, SCHEMA_DIR } from '../src/store.ts'
import { RelayError } from '../src/errors.ts'
import { RateLimits, ReplayGuard, authenticateDeviceToken, authenticateHostCredential, constantTimeEquals, readBearerHeaderValue, sha256Hex } from '../src/auth.ts'

function memoryStore() {
  const store = new Store({ path: ':memory:' })
  ensureSchema(store, SCHEMA_DIR)
  return store
}

function seedDevice(store, overrides = {}) {
  const row = {
    deviceName: 'Pixel 8',
    platform: 'android',
    tokenHash: sha256Hex('tok-' + Math.random()),
    tokenVersion: 1,
    status: 'active',
    ...overrides,
  }
  const now = Math.floor(Date.now() / 1000)
  const result = store.run(
    'INSERT INTO relay_devices (win_device_id, device_name, platform, token_hash, token_version, status, paired_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    null,
    row.deviceName,
    row.platform,
    row.tokenHash,
    row.tokenVersion,
    row.status,
    now,
    now,
  )
  return { id: Number(result.lastInsertRowid), ...row }
}

function seedHost(store, overrides = {}) {
  const row = { hostName: 'home-pc', credentialHash: sha256Hex('cred-' + Math.random()), status: 'active', ...overrides }
  const now = Math.floor(Date.now() / 1000)
  const result = store.run(
    'INSERT INTO relay_hosts (host_name, credential_hash, status, enrolled_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    row.hostName,
    row.credentialHash,
    row.status,
    now,
    now,
  )
  return { id: Number(result.lastInsertRowid), ...row }
}

// ---- Bearer 头解析（蓝本语义） -------------------------------------------------

test('readBearerHeaderValue：合法/非法形态', () => {
  assert.equal(readBearerHeaderValue('Bearer abc'), 'abc')
  assert.equal(readBearerHeaderValue('bearer\tabc'), 'abc')
  assert.equal(readBearerHeaderValue('Bearer  abc  '), 'abc')
  assert.equal(readBearerHeaderValue('Basic abc'), null)
  assert.equal(readBearerHeaderValue('Bearer'), null)
  assert.equal(readBearerHeaderValue('Bearer '), null)
  assert.equal(readBearerHeaderValue(undefined), null)
  assert.equal(readBearerHeaderValue(['Bearer x']), null)
})

// ---- L1 设备注册表校验 ---------------------------------------------------------

test('authenticateDeviceToken：缺失头 → AUTH_INVALID_TOKEN', () => {
  const store = memoryStore()
  assert.throws(() => authenticateDeviceToken(store, null), (err) => err instanceof RelayError && err.code === 'AUTH_INVALID_TOKEN')
})

test('authenticateDeviceToken：未注册 → RELAY_DEVICE_UNKNOWN（docs/18 §8.2 新码）', () => {
  const store = memoryStore()
  assert.throws(() => authenticateDeviceToken(store, 'no-such-token'), (err) => err.code === 'RELAY_DEVICE_UNKNOWN')
})

test('authenticateDeviceToken：撤销 → DEVICE_REVOKED（撤销即拒）', () => {
  const store = memoryStore()
  const dev = seedDevice(store, { status: 'revoked' })
  const token = 'tok-' + Math.random()
  // 直接以已知哈希重置
  store.run('UPDATE relay_devices SET token_hash = ? WHERE id = ?', sha256Hex(token), dev.id)
  assert.throws(() => authenticateDeviceToken(store, token), (err) => err.code === 'DEVICE_REVOKED')
})

test('authenticateDeviceToken：活跃设备通过并投影字段', () => {
  const store = memoryStore()
  const token = 'tok-ok-123'
  const dev = seedDevice(store, { tokenHash: sha256Hex(token), tokenVersion: 3 })
  const device = authenticateDeviceToken(store, token)
  assert.equal(device.id, dev.id)
  assert.equal(device.deviceName, 'Pixel 8')
  assert.equal(device.tokenVersion, 3)
  assert.equal(device.viaGrace, false)
})

// ---- token_rotation 宽限三态（docs/18 §3.14，M3-C3b 修1；集成面见 forwarder.test.mjs） ----

function seedGrace(store, deviceId, oldTokenHash, expiresInSec) {
  store.run(
    'UPDATE relay_devices SET grace_token_hash = ?, grace_expires_at = ? WHERE id = ?',
    oldTokenHash,
    Math.floor(Date.now() / 1000) + expiresInSec,
    deviceId,
  )
}

test('authenticateDeviceToken：宽限窗内旧凭据 → 200（viaGrace=true，docs/18 §3.14）', () => {
  const store = memoryStore()
  const dev = seedDevice(store, { tokenHash: sha256Hex('tok-new') })
  seedGrace(store, dev.id, sha256Hex('tok-old'), 300)
  const device = authenticateDeviceToken(store, 'tok-old')
  assert.equal(device.id, dev.id)
  assert.equal(device.viaGrace, true)
  assert.equal(device.tokenVersion, dev.tokenVersion)
})

test('authenticateDeviceToken：宽限窗外旧凭据 → 401 RELAY_DEVICE_UNKNOWN（重配对路径）', () => {
  const store = memoryStore()
  const dev = seedDevice(store, { tokenHash: sha256Hex('tok-new') })
  seedGrace(store, dev.id, sha256Hex('tok-old'), -1)
  assert.throws(() => authenticateDeviceToken(store, 'tok-old'), (err) => err.code === 'RELAY_DEVICE_UNKNOWN')
  // 新凭据不受影响（维持新 Token 生效，无回滚位）
  assert.equal(authenticateDeviceToken(store, 'tok-new').viaGrace, false)
})

test('authenticateDeviceToken：宽限窗内但已撤销 → DEVICE_REVOKED（撤销即拒优先）', () => {
  const store = memoryStore()
  const dev = seedDevice(store, { tokenHash: sha256Hex('tok-new'), status: 'revoked' })
  seedGrace(store, dev.id, sha256Hex('tok-old'), 300)
  assert.throws(() => authenticateDeviceToken(store, 'tok-old'), (err) => err.code === 'DEVICE_REVOKED')
})

test('authenticateDeviceToken：存量单哈希行（grace 列 NULL）行为不变（0002 迁移兼容）', () => {
  const store = memoryStore()
  const token = 'tok-legacy'
  seedDevice(store, { tokenHash: sha256Hex(token) })
  assert.equal(authenticateDeviceToken(store, token).viaGrace, false)
  assert.throws(() => authenticateDeviceToken(store, 'tok-other'), (err) => err.code === 'RELAY_DEVICE_UNKNOWN')
})

test('constantTimeEquals：等长比较 + 异长安全', () => {
  const h = sha256Hex('x')
  assert.equal(constantTimeEquals(h, h), true)
  assert.equal(constantTimeEquals(h, sha256Hex('y')), false)
  assert.equal(constantTimeEquals(h, 'ab'), false)
})

// ---- L2 主机凭据校验 -----------------------------------------------------------

test('authenticateHostCredential：未知 → RELAY_HOST_UNKNOWN；撤销 → DEVICE_REVOKED；活跃通过', () => {
  const store = memoryStore()
  assert.throws(() => authenticateHostCredential(store, 'no-such-cred'), (err) => err.code === 'RELAY_HOST_UNKNOWN')
  assert.throws(() => authenticateHostCredential(store, null), (err) => err.code === 'AUTH_INVALID_TOKEN')
  const cred = 'cred-ok'
  const host = seedHost(store, { credentialHash: sha256Hex(cred) })
  const authed = authenticateHostCredential(store, cred)
  assert.equal(authed.id, host.id)
  store.run("UPDATE relay_hosts SET status='revoked' WHERE id = ?", host.id)
  assert.throws(() => authenticateHostCredential(store, cred), (err) => err.code === 'DEVICE_REVOKED')
})

// ---- 防重放（±300s + nonce LRU 10min） ------------------------------------------

test('ReplayGuard：缺头/窗外/重放 → AUTH_REPLAYED；合法通过', () => {
  const guard = new ReplayGuard()
  const nowMs = Date.now()
  assert.throws(() => guard.check({ timestamp: undefined, nonce: randomNonce() }, nowMs), (err) => err.code === 'AUTH_REPLAYED')
  assert.throws(() => guard.check({ timestamp: '999', nonce: randomNonce() }, nowMs), (err) => err.code === 'AUTH_REPLAYED')
  const outside = Math.floor(nowMs / 1000) - 301
  assert.throws(() => guard.check({ timestamp: String(outside), nonce: randomNonce() }, nowMs), (err) => err.code === 'AUTH_REPLAYED')
  const nonce = randomNonce()
  guard.check({ timestamp: String(Math.floor(nowMs / 1000)), nonce }, nowMs)
  assert.throws(() => guard.check({ timestamp: String(Math.floor(nowMs / 1000)), nonce }, nowMs), (err) => err.code === 'AUTH_REPLAYED')
  guard.check({ timestamp: String(Math.floor(nowMs / 1000)), nonce: randomNonce() }, nowMs)
})

function randomNonce() {
  return 'nonce-' + Math.random().toString(36).slice(2) + '1234567890'
}

test('ReplayGuard：nonce 10min LRU 过期后可复用（逐项独立判过期）', () => {
  const guard = new ReplayGuard()
  const nonce = randomNonce()
  const baseMs = 1_700_000_000_000 // ms；对应 unix 秒 1_700_000_000
  guard.check({ timestamp: '1700000000', nonce }, baseMs)
  // 10min+ 后同一 nonce 可再次登记（时钟注入缝；时间戳同步前移以保持 ±300s 窗内）
  guard.check({ timestamp: '1700000660', nonce }, baseMs + 11 * 60 * 1000)
})

// ---- 限流三件套（同参 docs/14 §B.4） ---------------------------------------------

test('鉴权失败限流：同源 5 次/60s → 第 5 次即满 + Retry-After', () => {
  const limits = new RateLimits()
  const now = 1_000_000
  for (let i = 0; i < 4; i += 1) {
    assert.equal(limits.recordAuthFailure('1.2.3.4', now), false)
  }
  assert.equal(limits.recordAuthFailure('1.2.3.4', now), true)
  assert.equal(limits.isAuthFailureLimited('1.2.3.4', now + 30_000), true)
  assert.ok(limits.authFailureRetryAfterSec('1.2.3.4', now + 30_000) > 0)
  // 窗口滑出后解除
  assert.equal(limits.isAuthFailureLimited('1.2.3.4', now + 61_000), false)
  // 其他源不受影响
  assert.equal(limits.isAuthFailureLimited('5.6.7.8', now), false)
})

test('常规请求限流：120 次/min/设备（第 120 次放行、第 121 次起 429——AC6 off-by-one 语义）', () => {
  const limits = new RateLimits()
  const now = 2_000_000
  for (let i = 0; i < 120; i += 1) {
    assert.equal(limits.recordDeviceRequest(7, now), false, `第 ${i + 1} 次应放行`)
  }
  assert.equal(limits.recordDeviceRequest(7, now), true)
  assert.ok(limits.deviceRequestRetryAfterSec(7, now) >= 0)
})

test('claim 限流：5 次/5min/源（尝试即计数含成功）', () => {
  const limits = new RateLimits()
  const now = 3_000_000
  for (let i = 0; i < 5; i += 1) {
    limits.recordClaimAttempt('9.9.9.9', now)
  }
  assert.equal(limits.recordClaimAttempt('9.9.9.9', now), true)
  assert.ok(limits.claimRetryAfterSec('9.9.9.9', now) > 0)
})
