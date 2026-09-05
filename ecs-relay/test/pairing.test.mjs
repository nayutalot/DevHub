/**
 * test/pairing.test.mjs — 配对码语义单测（docs/18 §3.2 校验归属表：TTL/一次性/失败 5 次作废/单活跃码）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Store, ensureSchema, SCHEMA_DIR } from '../src/store.ts'
import { RateLimits } from '../src/auth.ts'
import { claimPairing, registerPairing, findPendingDevice } from '../src/pairing.ts'

const sha256 = (v) => createHash('sha256').update(v, 'utf8').digest('hex')

function setup() {
  const store = new Store({ path: ':memory:' })
  ensureSchema(store, SCHEMA_DIR)
  const rateLimits = new RateLimits()
  const auditEntries = []
  const audit = { write: (entry) => auditEntries.push(entry) }
  return { store, rateLimits, audit, auditEntries }
}

function register(store, pairingId, code, nowSec, ttlSec = 300) {
  return registerPairing(store, { pairingId, codeHash: sha256(code), expiresAt: nowSec + ttlSec }, nowSec, ttlSec)
}

function claim(ctx, code, { source = '10.0.0.1', nowMs = Date.now() } = {}) {
  return claimPairing(ctx.store, { code, deviceName: 'Pixel 8', platform: 'android' }, source, ctx.rateLimits, ctx.audit, nowMs)
}

test('成功 claim：码一次性 + pending 设备行（token_version=0 占位）', () => {
  const ctx = setup()
  register(ctx.store, 'pair-1', 'A3K7M9XY', 1000)
  const result = claim(ctx, 'A3K7M9XY', { nowMs: 1100_000 })
  assert.equal(result.pairingId, 'pair-1')
  assert.equal(result.platform, 'android')
  const pending = findPendingDevice(ctx.store, result.ecsDeviceId)
  assert.notEqual(pending, null)
  assert.equal(pending.device_name, 'Pixel 8')
  // 码即失效（used）→ 二次 claim 拒绝
  assert.throws(() => claim(ctx, 'A3K7M9XY', { nowMs: 1200_000 }), (err) => err.code === 'PAIRING_INVALID_CODE')
  const codeRow = ctx.store.get("SELECT status FROM pairing_codes WHERE pairing_id = 'pair-1'")
  assert.equal(codeRow.status, 'used')
})

test('码错 → PAIRING_INVALID_CODE；失败 5 次（跨源累计）→ PAIRING_CODE_VOIDED', () => {
  const ctx = setup()
  register(ctx.store, 'pair-2', 'A3K7M9XY', 1000)
  // claim 限流按源计数——用不同源注入 5 次失败（前 4 次 INVALID，第 5 次作废）
  for (let i = 0; i < 4; i += 1) {
    assert.throws(
      () => claim(ctx, 'XXXXXXXX', { source: `10.0.0.${i}`, nowMs: 1100_000 + i * 1000 }),
      (err) => err.code === 'PAIRING_INVALID_CODE',
    )
  }
  // 第 5 次失败 → 码作废（voided）
  assert.throws(() => claim(ctx, 'XXXXXXXX', { source: '10.0.0.9', nowMs: 1140_000 }), (err) => err.code === 'PAIRING_CODE_VOIDED')
  // 作废后连正确码也拒绝（PAIRING_CODE_VOIDED）
  assert.throws(() => claim(ctx, 'A3K7M9XY', { source: '10.0.0.8', nowMs: 1150_000 }), (err) => err.code === 'PAIRING_CODE_VOIDED')
  const row = ctx.store.get("SELECT fail_count, status FROM pairing_codes WHERE pairing_id = 'pair-2'")
  assert.equal(row.status, 'voided')
  assert.ok(row.fail_count >= 5)
})

test('TTL 300s 过期 → PAIRING_CODE_EXPIRED（码置 expired）', () => {
  const ctx = setup()
  register(ctx.store, 'pair-3', 'B3K7M9XY', 1000)
  assert.throws(() => claim(ctx, 'B3K7M9XY', { nowMs: 1301_000 }), (err) => err.code === 'PAIRING_CODE_EXPIRED')
  const row = ctx.store.get("SELECT status FROM pairing_codes WHERE pairing_id = 'pair-3'")
  assert.equal(row.status, 'expired')
})

test('新码废旧码（单活跃码）：旧码 → PAIRING_CODE_VOIDED', () => {
  const ctx = setup()
  register(ctx.store, 'pair-4a', 'C3K7M9XY', 1000)
  register(ctx.store, 'pair-4b', 'D3K7M9XY', 1100)
  assert.throws(() => claim(ctx, 'C3K7M9XY', { nowMs: 1200_000 }), (err) => err.code === 'PAIRING_CODE_VOIDED')
  const result = claim(ctx, 'D3K7M9XY', { nowMs: 1200_000 })
  assert.equal(result.pairingId, 'pair-4b')
  // 同一时刻至多 1 活跃码
  const activeCount = ctx.store.get("SELECT COUNT(*) AS n FROM pairing_codes WHERE status = 'active'").n
  assert.equal(activeCount, 0)
})

test('claim 限流 5 次/5min/源（AUTH_RATE_LIMITED，docs/18 §3.2）', () => {
  const ctx = setup()
  register(ctx.store, 'pair-5', 'E3K7M9XY', 1000)
  for (let i = 0; i < 5; i += 1) {
    try {
      claim(ctx, 'WRONGCODE', { source: '10.9.9.9', nowMs: 1100_000 })
    } catch {
      /* 失败尝试也计数 */
    }
  }
  assert.throws(() => claim(ctx, 'E3K7M9XY', { source: '10.9.9.9', nowMs: 1150_000 }), (err) => err.code === 'AUTH_RATE_LIMITED')
  // 其他源不受影响
  const ok = claim(ctx, 'E3K7M9XY', { source: '10.8.8.8', nowMs: 1150_000 })
  assert.equal(ok.pairingId, 'pair-5')
})

test('platform 强制 android（BAD_PAYLOAD）；无活跃码 → PAIRING_INVALID_CODE', () => {
  const ctx = setup()
  assert.throws(
    () => claimPairing(ctx.store, { code: 'E3K7M9XY', deviceName: 'X', platform: 'ios' }, 's', ctx.rateLimits, ctx.audit),
    (err) => err.code === 'BAD_PAYLOAD',
  )
  assert.throws(
    () => claimPairing(ctx.store, { code: 'E3K7M9XY', deviceName: 'X', platform: 'android' }, 's', ctx.rateLimits, ctx.audit),
    (err) => err.code === 'PAIRING_INVALID_CODE',
  )
})

test('registerPairing：codeHash 必须 sha256 hex；expiresAt 上限 = TTL 300s 截断', () => {
  const ctx = setup()
  assert.throws(
    () => registerPairing(ctx.store, { pairingId: 'p', codeHash: 'nothex', expiresAt: 100 }, 10, 300),
    (err) => err.code === 'BAD_PAYLOAD',
  )
  const reg = register(ctx.store, 'pair-6', 'F3K7M9XY', 1000, 300)
  // host 侧给 expiresAt 超过 TTL 也被截断到 now+300
  const reg2 = registerPairing(ctx.store, { pairingId: 'pair-7', codeHash: sha256('G3K7M9XY'), expiresAt: 1000 + 99999 }, 1000, 300)
  assert.equal(reg2.expiresAt, 1300)
  assert.equal(reg.pairingId, 'pair-6')
})
