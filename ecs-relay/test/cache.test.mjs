/**
 * test/cache.test.mjs — 事件缓存单测：幂等插入/hasGaps/TTL 72h/容量两级淘汰（docs/19 §5.4）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Store, ensureSchema, SCHEMA_DIR } from '../src/store.ts'
import { EventCache } from '../src/cache.ts'
import { loadConfig } from '../src/config.ts'

function setup(overrides = {}) {
  const store = new Store({ path: ':memory:' })
  ensureSchema(store, SCHEMA_DIR)
  const config = loadConfig({
    RELAY_CACHE_SOFT_ROWS: String(overrides.softRows ?? 10),
    RELAY_CACHE_HARD_ROWS: String(overrides.hardRows ?? 20),
    RELAY_CACHE_PAYLOAD_TTL_HOURS: String(overrides.payloadTtlHours ?? 72),
    RELAY_CACHE_ROW_TTL_DAYS: String(overrides.rowTtlDays ?? 7),
  })
  const cache = new EventCache(store, config)
  return { store, cache, config }
}

function ev(cache, sequence, overrides = {}) {
  return cache.insert({
    sequence,
    eventId: overrides.eventId ?? `ev-${sequence}`,
    type: overrides.type ?? 'message.appended',
    provider: overrides.provider ?? 'codex',
    sessionId: overrides.sessionId !== undefined ? overrides.sessionId : 337,
    summary: overrides.summary ?? null,
    payloadJson: overrides.payloadJson ?? JSON.stringify({ n: sequence }),
    requiresUserAction: overrides.requiresUserAction ?? false,
    createdAt: overrides.createdAt ?? 1000 + sequence,
  })
}

test('幂等插入：同 sequence 重发零重复；同 sequence 异 eventId 忽略（host 权威）', () => {
  const { cache, store } = setup()
  assert.equal(ev(cache, 5).inserted, true)
  assert.equal(ev(cache, 5).inserted, false)
  assert.equal(ev(cache, 5, { eventId: 'ev-OTHER' }).inserted, false)
  assert.equal(store.get('SELECT COUNT(*) AS n FROM relay_events').n, 1)
  assert.equal(cache.maxSequence(), 5)
})

test('payload > 4KB → 只落元数据（payload_json NULL），转发不受影响', () => {
  const { cache } = setup()
  const big = JSON.stringify({ blob: 'x'.repeat(5 * 1024) })
  const res = ev(cache, 9, { payloadJson: big })
  assert.equal(res.inserted, true)
  const row = cache.bySequence(9)
  assert.equal(row.payload_json, null)
  assert.equal(row.type, 'message.appended')
})

test('pageSince 升序分页 + hasGaps（缺号/元数据行都算洞，绝不静默跳号）', () => {
  const { cache } = setup()
  for (const s of [1, 2, 3, 5, 6]) ev(cache, s) // 4 缺号
  const page = cache.pageSince(0, 100)
  assert.deepEqual(page.map((r) => r.sequence), [1, 2, 3, 5, 6])
  assert.equal(cache.hasGapsBetween(0, 6), true)
  assert.equal(cache.hasGapsBetween(6, 6), false)
  // 元数据行（payload 已淘汰）同样构成补发洞
  const { store, cache: cache2 } = setup()
  for (const s of [10, 11]) ev(cache2, s)
  store.run('UPDATE relay_events SET payload_json = NULL WHERE sequence = 10')
  assert.deepEqual(cache2.pageSince(9, 100).map((r) => r.sequence), [11])
  assert.equal(cache2.hasGapsBetween(9, 11), true)
})

function seedDevices(store, n) {
  const ids = []
  for (let i = 0; i < n; i += 1) {
    const now = Math.floor(Date.now() / 1000)
    const r = store.run(
      'INSERT INTO relay_devices (win_device_id, device_name, platform, token_hash, token_version, status, paired_at, updated_at) VALUES (?, ?, ?, ?, 1, \'active\', ?, ?)',
      null,
      `dev-${i}`,
      'android',
      `hash-${i}-${Math.random()}`,
      now,
      now,
    )
    ids.push(Number(r.lastInsertRowid))
  }
  return ids
}

test('TTL 淘汰两级：全 ack + 72h → 删 payload；元数据行 7 天后整行删', () => {
  const { store, cache } = setup({ payloadTtlHours: 72, rowTtlDays: 7 })
  seedDevices(store, 2)
  const nowSec = 10_000_000
  const futureBase = nowSec + 8 * 86400 // 推进后的时钟基点（第 7 天行删除窗口用）
  ev(cache, 1, { createdAt: nowSec - 73 * 3600 })
  ev(cache, 2, { createdAt: futureBase - 3600 }) // 在推进时钟下仍新鲜
  // 设备 A ack 到 1，设备 B 未 ack → 不是全 ack → payload 保留
  store.run('INSERT INTO relay_event_acks (device_id, acked_through, updated_at) VALUES (1, 1, ?)', nowSec)
  cache.evict(nowSec)
  assert.notEqual(cache.bySequence(1).payload_json, null)
  // 设备 B 也 ack → 全 ack 且超 72h → payload 删、行留
  store.run('INSERT INTO relay_event_acks (device_id, acked_through, updated_at) VALUES (2, 1, ?)', nowSec)
  cache.evict(nowSec)
  assert.equal(cache.bySequence(1).payload_json, null)
  assert.notEqual(cache.bySequence(1), undefined) // 元数据行保留供 hasGaps
  // 7 天后整行删
  cache.evict(futureBase)
  assert.equal(cache.bySequence(1), undefined)
  assert.notEqual(cache.bySequence(2), undefined) // 新鲜事件不受影响
})

test('容量两级淘汰：先删已全 ack 最旧（不碰未 ack）→ 全未 ack 时强制删最旧行（硬限不突破）', () => {
  const { store, cache } = setup({ softRows: 3, hardRows: 8 })
  const nowSec = 20_000_000
  const evicted = []
  // 场景 1：设备 1 ack 到 3，行 1..5 超 soft=3 → 只删已全 ack 的最旧 2 行（1、2），未 ack 的 3 保留
  seedDevices(store, 1)
  for (const s of [1, 2, 3, 4, 5]) ev(cache, s, { createdAt: nowSec + s })
  store.run('INSERT INTO relay_event_acks (device_id, acked_through, updated_at) VALUES (1, 3, ?)', nowSec)
  cache.evict(nowSec, (stage, count) => evicted.push({ stage, count }))
  let size = cache.size()
  assert.ok(size.rows <= 3, `软限后行数 ${size.rows} 应 ≤3`)
  assert.deepEqual(evicted, [{ stage: 'capacity_acked', count: 2 }])
  assert.equal(cache.bySequence(1), undefined)
  assert.equal(cache.bySequence(2), undefined)
  assert.notEqual(cache.bySequence(3), undefined, '未 ack 行在第一阶段保留')

  // 场景 2：全部未 ack（无 ack 行）→ 第一阶段无受害者 → 强制删最旧行
  for (const s of [6, 7]) ev(cache, s, { createdAt: nowSec + s })
  cache.evict(nowSec, (stage, count) => evicted.push({ stage, count }))
  size = cache.size()
  assert.ok(size.rows <= 3, `强制删后行数 ${size.rows} 应 ≤3`)
  assert.ok(evicted.some((e) => e.stage === 'capacity_forced'), '第二阶段 capacity_forced 触发')
  assert.equal(cache.bySequence(3), undefined, '强制删含未 ack 最旧行（relay_cache_evicted → hasGaps 语义）')
  assert.notEqual(cache.bySequence(7), undefined, '最旧行优先删，最新保留')
})

test('容量淘汰审计（onEvicted）覆盖 relay_cache_evicted 语义入参', () => {
  const { store, cache } = setup({ softRows: 2, hardRows: 3 })
  seedDevices(store, 1)
  for (const s of [1, 2, 3, 4]) ev(cache, s, { createdAt: 30_000_000 + s })
  const events = []
  cache.evict(30_000_000, (stage, count) => events.push({ stage, count }))
  assert.ok(events.length >= 1)
  assert.ok(events[0].count >= 1)
})

test('session_ref 定位串（provider:sessionId；无 sessionId → NULL）', () => {
  const { store, cache } = setup()
  ev(cache, 20, { sessionId: 337, provider: 'codex' })
  ev(cache, 21, { sessionId: null })
  assert.equal(cache.bySequence(20).session_ref, 'codex:337')
  assert.equal(cache.bySequence(21).session_ref, null)
})
