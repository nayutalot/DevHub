// m3c8a-fixture-inject.mjs — M3-C8a R-B6 app-off 复验夹具（C7b/C2e 先例同模式）。
//
// 作用：向桌面 agent_events 注入 3 条 synthetic 事件（sequence = MAX(id)+1..+3，
// delivery_state='pending'），供常驻重启后 hello-watermark 回填推送 ECS relay_events，
// 再由 App 重连补发消费。判据=补发零丢失（sequence 连续）+ event_ack 落盘 + held 消化。
//
// 纪律（m3c7b-orphan-revoke.mjs 同）：
//   - SQL 全参数绑定（约束 #11）；绝不动态拼接值；
//   - 快照零凭据；幂等：按 event_id 前缀 m3c8a 已存在即零触碰；
//   - 只 INSERT agent_events + event_deliveries（镜像 recordEvent 落库语义），
//     零删行、零 schema 变更、零 remote_devices 触碰；
//   - 前置：DevHub.exe 已退出（DB WAL 无活跃写者）。
//
// 运行：node acceptance/agents-mobile/m3c8a-fixture-inject.mjs [--dry-run]

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

const FIXTURE_COUNT = 3
const MARK = 'm3c8a'
const DATA_DIR_NAME = 'DevHub'
const dryRun = process.argv.includes('--dry-run')

function resolveDbPath() {
  if (process.env.DEVHUB_HOME) return join(process.env.DEVHUB_HOME, 'devhub.db')
  if (process.platform === 'win32' && process.env.APPDATA) {
    return join(process.env.APPDATA, DATA_DIR_NAME, 'devhub.db')
  }
  return join(homedir(), '.config', DATA_DIR_NAME, 'devhub.db')
}

const dbPath = resolveDbPath()
if (!existsSync(dbPath)) {
  console.error(JSON.stringify({ error: 'db not found', dbPath }))
  process.exit(2)
}

const db = new DatabaseSync(dbPath)
db.exec('PRAGMA busy_timeout = 5000')

const maxRow = db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM agent_events').get()
const base = Number(maxRow.m)
const now = Math.floor(Date.now() / 1000)

// deriveEventId 同形（eventPipeline.ts:70）：providerKey:nativeId:eventType:sha256[:16]
function deriveEventId(providerKey, nativeId, eventType, fingerprintSource) {
  const hash = createHash('sha256').update(fingerprintSource, 'utf8').digest('hex')
  return `${providerKey}:${nativeId}:${eventType}:${hash.slice(0, 16)}`
}

const before = db
  .prepare("SELECT COUNT(*) AS n FROM agent_events WHERE event_id LIKE ? || '%'")
  .get(`${MARK}:`)

const inserted = []
if (!dryRun) {
  const insertEvent = db.prepare(
    'INSERT INTO agent_events (provider_id, session_id, event_type, event_id, payload_json, summary, delivery_state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
  const activeDevices = db.prepare("SELECT id FROM remote_devices WHERE status = 'active'").all()
  const insertDelivery = db.prepare(
    "INSERT OR IGNORE INTO event_deliveries (event_id, device_id, status, created_at) VALUES (?, ?, 'pending', ?)",
  )
  for (let i = 1; i <= FIXTURE_COUNT; i++) {
    const nativeId = `synthetic-${now}-${i}`
    const payload = JSON.stringify({ synthetic: true, batch: 'm3c8a', fixture: i, status: 'running', to: 'running' })
    const eventId = deriveEventId(MARK, nativeId, 'session.status_changed', payload + ':' + randomUUID())
    const dup = db.prepare('SELECT id FROM agent_events WHERE event_id = ?').get(eventId)
    if (dup !== undefined) continue // 幂等：重放零触碰
    const info = insertEvent.run(null, null, 'session.status_changed', eventId, payload, `[${MARK} synthetic] app-off catchup fixture #${i}/${FIXTURE_COUNT}`, 'pending', now)
    const sequence = Number(info.lastInsertRowid)
    let deliveries = 0
    for (const d of activeDevices) {
      deliveries += Number(insertDelivery.run(sequence, Number(d.id), now).changes)
    }
    inserted.push({ sequence, eventId, deliveries })
  }
}

const after = db
  .prepare("SELECT COUNT(*) AS n FROM agent_events WHERE event_id LIKE ? || '%'")
  .get(`${MARK}:`)

console.log(
  JSON.stringify(
    {
      batch: 'm3c8a',
      dbPath,
      dryRun,
      baseMaxId: base,
      fixturesBefore: Number(before.n),
      fixturesAfter: Number(after.n),
      inserted,
      note: 'synthetic 夹具：delivery_state=pending（镜像 recordEvent），summary 带 m3c8a synthetic 标记；零凭据',
    },
    null,
    1,
  ),
)
db.close()
