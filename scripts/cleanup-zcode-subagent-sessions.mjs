#!/usr/bin/env node
// cleanup-zcode-subagent-sessions.mjs — zcode 子会话真库清污（一次性 ops 脚本，幂等）。
//
// 背景（用户报障：Agents 视图出现大量子智能体会话）：zcodeProvider 旧版 listSessions
// 全量摄取 ~/.zcode/cli/db/db.sqlite 的 session 表，未过滤子智能体会话——真库
// agent_sessions(provider=zcode) 被 141 行 sess_subagent_agent_* 子会话污染。
// 源头修复（zcodeProvider isZcodeSubagentSession 双保险过滤）落地后，本脚本清理
// DevHub 真库中已摄入的污染数据。
//
// 判据（DevHub 库侧只有 native_id 可用——agent_sessions 无 task_type 列，真库
// 没有 ZCode 的 schema）：native_id 前缀 'sess_subagent_agent_' 且 provider='zcode'。
// 双重限定 provider='zcode'：其他 provider（codex/claude-code/kimi/deepseek）即使
// 理论上出现同形 id 也绝不动。
//
// 连带清理（会话域）：
//   - agent_messages（FK CASCADE 自动；显式删更稳并计数）
//   - agent_events 中 session_id ∈ 集合的**会话域事件**（session.started /
//     session.status_changed / session.waiting_input / session.finished /
//     message.appended）；provider.health_changed 与 command.result 不动
//   - event_deliveries（随事件 FK CASCADE；显式删并计数）
//   - resources 中 resource_type='session' 且 ref_id ∈ 集合的节点
//     （agentControlService.registerSessionResources 的登记形态：UNIQUE(resource_type, ref_id)）；
//     relationships 中触及这些节点的边（FK CASCADE；显式删并计数）
//   - remote_commands.session_id 为 FK ON DELETE SET NULL：删除会话行时由 SQLite
//     自动置 NULL（只统计报告，不删指令流水）
//
// 裁决依据（偏差注记）：迁移裁决 5 的「未确认（非 acked）事件绝不删除」规则在本
// 脚本**让位于错误摄取数据清理**——这些子会话本身就不该被 provider 摄入（源头
// 缺陷），其事件对远程设备无任何交付价值；保留只会让设备在补发窗口持续收到无效
// 事件。仅清除「会话域」事件，provider.health_changed / command.result 等非会话域
// 行不受影响；agent_events 的 AUTOINCREMENT sequence 单调语义不受删除影响
// （sqlite_sequence 只增不减，裁决 5 原意保持）。
//
// 铁律：
//   - 除本脚本定义的清理 DELETE 外，对真库**零其他写操作**（dry-run 模式纯只读）。
//   - 全部 SQL 参数绑定（约束 #11）；IN 集合分批（每批 500）。
//   - 幂等：删除按集合一次成型，重复运行第二遍找到 0 行、计数全零、结果一致。
//   - 不打印消息内容/会话标题等投影数据（只出 id 与计数），绝不静默。
//
// 运行：
//   node scripts/cleanup-zcode-subagent-sessions.mjs            # dry-run 预览（默认）
//   node scripts/cleanup-zcode-subagent-sessions.mjs --apply    # 执行清理
//   受 DEVHUB_HOME 影响（与 migrate-legacy.mjs 同款门面）；smoke 经
//   runZcodeSubagentCleanup({ db, apply }) 注入夹具库句柄调用。

import { pathToFileURL } from 'node:url'

// DevHub DB 门面（尊重 DEVHUB_HOME；首次 getDatabase 会自动跑完 migration 001–004）。
const dbUrl = new URL('../src/main/db/index.ts', import.meta.url)
const { getDatabase, closeDatabase } = await import(dbUrl.href)

/** 会话域事件类型全集（provider.health_changed / command.result 明确不在列）。 */
const SESSION_SCOPED_EVENT_TYPES = [
  'session.started',
  'session.status_changed',
  'session.waiting_input',
  'session.finished',
  'message.appended',
]

const SUBAGENT_PREFIX = 'sess_subagent_agent_'
const CHUNK = 500

/** 分批参数绑定的 IN 子句集合查询（约束 #11：一切 SQL 参数绑定）。 */
function selectInChunks(db, sqlPrefix, values, rowMapper) {
  const out = []
  for (let i = 0; i < values.length; i += CHUNK) {
    const slice = values.slice(i, i + CHUNK)
    const placeholders = slice.map(() => '?').join(', ')
    const rows = db.prepare(`${sqlPrefix} (${placeholders})`).all(...slice)
    for (const row of rows) out.push(rowMapper(row))
  }
  return out
}

/** 分批参数绑定的 IN 子句 DELETE，返回删除行数。 */
function deleteInChunks(db, sqlPrefix, values) {
  let changes = 0
  for (let i = 0; i < values.length; i += CHUNK) {
    const slice = values.slice(i, i + CHUNK)
    if (slice.length === 0) continue
    const placeholders = slice.map(() => '?').join(', ')
    const info = db.prepare(`${sqlPrefix} (${placeholders})`).run(...slice)
    changes += Number(info.changes)
  }
  return changes
}

/**
 * 执行一轮清污（dry-run 只盘点不删除）。幂等：第二遍 subagent 会话集合为空，
 * 全部计数为 0。返回结构化报告（绝不含消息内容等投影数据）。
 */
export function runZcodeSubagentCleanup({ db = getDatabase(), apply = false } = {}) {
  const report = {
    apply,
    providerFound: false,
    sessionsScanned: 0,
    zcodeSessionsTotal: 0,
    subagentSessions: [], // { id, native_id }
    mainSessionsKept: 0,
    counts: { sessions: 0, messages: 0, events: 0, deliveries: 0, resources: 0, relationships: 0, remoteCommandsDetached: 0 },
  }

  const provider = db.prepare("SELECT id FROM agent_providers WHERE provider = 'zcode'").get()
  if (provider === undefined) {
    return report
  }
  report.providerFound = true

  // 1) 找污染集合：provider=zcode 且 native_id 前缀命中（双保险里的前缀判据——
  //    DevHub 库无 task_type 列，前缀判据在库侧即完备）。
  //    `_` 是 LIKE 通配符必须逐字转义（与 provider 侧 ZCODE_SUBAGENT_ID_LIKE_PATTERN
  //    同形；ESCAPE '\\' 子句才真正生效，杜绝 sess?subagent?agent?* 形态过匹配）。
  const prefixPattern = `${SUBAGENT_PREFIX.replaceAll('_', '\\_')}%`
  const subRows = db
    .prepare(
      "SELECT id, native_id FROM agent_sessions WHERE provider_id = ? AND native_id LIKE ? ESCAPE '\\' ORDER BY id",
    )
    .all(provider.id, prefixPattern)
  report.subagentSessions = subRows.map((r) => ({ id: Number(r.id), nativeId: String(r.native_id) }))
  const totalRow = db.prepare('SELECT COUNT(*) AS c FROM agent_sessions WHERE provider_id = ?').get(provider.id)
  report.zcodeSessionsTotal = Number(totalRow.c)
  report.mainSessionsKept = report.zcodeSessionsTotal - report.subagentSessions.length
  report.sessionsScanned = report.zcodeSessionsTotal

  if (report.subagentSessions.length === 0) {
    return report // 幂等空转：已清洁
  }

  const sessionIds = report.subagentSessions.map((s) => s.id)

  // 2) 连带盘点（只读 SELECT）
  const messageIdsCount = selectInChunks(
    db,
    'SELECT COUNT(*) AS c FROM agent_messages WHERE session_id IN',
    sessionIds,
    (r) => Number(r.c),
  ).reduce((a, b) => a + b, 0)

  // 会话域事件：session 集合 × event_type 白名单双重限定（provider.health_changed /
  // command.result 明确排除，绝不多删）
  const scopedEventIds = []
  const eventTypePlaceholders = SESSION_SCOPED_EVENT_TYPES.map(() => '?').join(', ')
  for (let i = 0; i < sessionIds.length; i += CHUNK) {
    const slice = sessionIds.slice(i, i + CHUNK)
    const ph = slice.map(() => '?').join(', ')
    const rows = db
      .prepare(
        `SELECT id FROM agent_events WHERE session_id IN (${ph}) AND event_type IN (${eventTypePlaceholders})`,
      )
      .all(...slice, ...SESSION_SCOPED_EVENT_TYPES)
    for (const r of rows) scopedEventIds.push(Number(r.id))
  }
  const deliveryCount = scopedEventIds.length
    ? selectInChunks(db, 'SELECT COUNT(*) AS c FROM event_deliveries WHERE event_id IN', scopedEventIds, (r) => Number(r.c)).reduce((a, b) => a + b, 0)
    : 0

  const resourceIds = selectInChunks(
    db,
    "SELECT id FROM resources WHERE resource_type = 'session' AND ref_id IN",
    sessionIds,
    (r) => Number(r.id),
  )
  const relationshipCount = resourceIds.length
    ? selectInChunks(
        db,
        'SELECT COUNT(*) AS c FROM relationships WHERE source_resource_id IN',
        resourceIds,
        (r) => Number(r.c),
      ).reduce((a, b) => a + b, 0) +
      selectInChunks(
        db,
        'SELECT COUNT(*) AS c FROM relationships WHERE target_resource_id IN',
        resourceIds,
        (r) => Number(r.c),
      ).reduce((a, b) => a + b, 0)
    : 0

  // remote_commands.session_id FK ON DELETE SET NULL：预览将被解绑的指令行数
  const remoteCommandsDetached = selectInChunks(
    db,
    'SELECT COUNT(*) AS c FROM remote_commands WHERE session_id IN',
    sessionIds,
    (r) => Number(r.c),
  ).reduce((a, b) => a + b, 0)

  report.counts = {
    sessions: report.subagentSessions.length,
    messages: messageIdsCount,
    events: scopedEventIds.length,
    deliveries: deliveryCount,
    resources: resourceIds.length,
    relationships: relationshipCount,
    remoteCommandsDetached,
  }

  if (!apply) {
    report.wouldDeleteNativeIds = report.subagentSessions.slice(0, 20).map((s) => s.nativeId)
    report.truncatedNativeIdList = report.subagentSessions.length > 20
    return report
  }

  // 3) 事务内删除（顺序：子表 → 父表；显式删 FK 子表更稳，不依赖 PRAGMA 状态）
  db.exec('BEGIN IMMEDIATE')
  try {
    // 3a. event_deliveries（事件投递状态；先于事件行删）
    report.counts.deliveries = scopedEventIds.length
      ? deleteInChunks(db, 'DELETE FROM event_deliveries WHERE event_id IN', scopedEventIds)
      : 0
    // 3b. agent_events（仅会话域事件；provider.health_changed / command.result 不动）
    let eventsDeleted = 0
    for (let i = 0; i < sessionIds.length; i += CHUNK) {
      const slice = sessionIds.slice(i, i + CHUNK)
      const ph = slice.map(() => '?').join(', ')
      const info = db
        .prepare(
          `DELETE FROM agent_events WHERE session_id IN (${ph}) AND event_type IN (${eventTypePlaceholders})`,
        )
        .run(...slice, ...SESSION_SCOPED_EVENT_TYPES)
      eventsDeleted += Number(info.changes)
    }
    report.counts.events = eventsDeleted
    // 3c. agent_messages（显式删更稳；FK CASCADE 本会自动）
    report.counts.messages = deleteInChunks(db, 'DELETE FROM agent_messages WHERE session_id IN', sessionIds)
    // 3d. relationships（触及 session 资源节点的边；显式删并计数）
    report.counts.relationships = 0
    if (resourceIds.length > 0) {
      report.counts.relationships += deleteInChunks(db, 'DELETE FROM relationships WHERE source_resource_id IN', resourceIds)
      report.counts.relationships += deleteInChunks(db, 'DELETE FROM relationships WHERE target_resource_id IN', resourceIds)
    }
    // 3e. resources（session 资源节点）
    report.counts.resources = resourceIds.length
      ? deleteInChunks(db, "DELETE FROM resources WHERE resource_type = 'session' AND ref_id IN", sessionIds)
      : 0
    // 3f. agent_sessions（污染行本体；remote_commands.session_id 由 FK SET NULL 解绑）
    {
      const info = db
        .prepare("DELETE FROM agent_sessions WHERE provider_id = ? AND native_id LIKE ? ESCAPE '\\'")
        .run(provider.id, prefixPattern)
      report.counts.sessions = Number(info.changes)
    }
    db.exec('COMMIT')
  } catch (e) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* 已回滚/连接断开 */
    }
    throw e
  }
  return report
}

function printReport(report) {
  console.log('=== zcode subagent sessions cleanup ===')
  console.log(`mode: ${report.apply ? 'APPLY (deletes executed)' : 'DRY-RUN (preview only; re-run with --apply)'}`)
  if (!report.providerFound) {
    console.log('agent_providers has no zcode row: nothing to do')
    return
  }
  console.log(`agent_sessions(provider=zcode): total=${report.zcodeSessionsTotal} subagent=${report.subagentSessions.length} main_kept=${report.mainSessionsKept}`)
  if (report.apply) {
    console.log(
      `deleted: sessions=${report.counts.sessions} messages=${report.counts.messages} events(session-scoped)=${report.counts.events} ` +
        `event_deliveries=${report.counts.deliveries} resources(session nodes)=${report.counts.resources} relationships(edges)=${report.counts.relationships} ` +
        `remote_commands detached(SET NULL, not deleted)=${report.counts.remoteCommandsDetached}`,
    )
    if (report.subagentSessions.length === 0) {
      console.log('nothing to delete (already clean; idempotent no-op)')
    }
  } else {
    console.log(
      `would delete: sessions=${report.counts.sessions} messages=${report.counts.messages} events(session-scoped)=${report.counts.events} ` +
        `event_deliveries=${report.counts.deliveries} resources(session nodes)=${report.counts.resources} relationships(edges)=${report.counts.relationships} ` +
        `remote_commands to detach(SET NULL, not deleted)=${report.counts.remoteCommandsDetached}`,
    )
    const sample = report.wouldDeleteNativeIds ?? []
    for (const nid of sample) console.log(`  - ${nid}`)
    if (report.truncatedNativeIdList) console.log(`  ... (${report.counts.sessions - sample.length} more)`)
    console.log('rule check: every listed native_id must carry the sess_subagent_agent_ prefix; abort if anything else appears')
  }
}

function isEntrypoint() {
  if (!process.argv[1]) return false
  return import.meta.url === pathToFileURL(process.argv[1]).href
}

// CLI 入口（smoke 经 import 复用 runZcodeSubagentCleanup，不会触发本分支）
if (isEntrypoint()) {
  const apply = process.argv.includes('--apply')
  if (process.argv.includes('--dry-run')) {
    // 显式 --dry-run：与默认一致（默认即为 dry-run，双写防止误操作）
  }
  try {
    const report = runZcodeSubagentCleanup({ apply })
    printReport(report)
  } finally {
    closeDatabase()
  }
}
