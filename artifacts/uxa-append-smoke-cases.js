// 一次性脚本：向 scripts/smoke.mjs 追加 ux 批 A 的 7 个新用例（append-only）。
// 运行：node artifacts/uxa-append-smoke-cases.js（追加后本脚本保留作审计痕迹）。
import { readFileSync, writeFileSync } from 'node:fs'

const p = 'scripts/smoke.mjs'
const s = readFileSync(p, 'utf8')

const newCases = String.raw`
  // ------------------------------------------------------------------
  // ux 整改批 A（docs/17 §6 批次 A / §2 R1-R6/R8/R10；append-only 接续）。
  // 注：涉及「最新版本」的既有断言按 AC2 先例（docs/13 §3 授权的同一模式）
  // 就地更新 4→5，逐条已在批次报告单列，等母智能体裁决。
  // ------------------------------------------------------------------

  // 143. migration 005：全新库 user_version=5、新列/新索引齐全；v4 库升级路径
  //      保数据；幂等重跑；migrate.ts case-5 字面量注册（未注册版本显式抛错）
  registerCase('uxa-143: migration 005 — fresh db at user_version 5 with parent_session_id/archived_at/segments_json columns + parent index; hand-built v4 db upgrades preserving rows; idempotent re-run; setUserVersionLiteral case-5 literal registered (unknown version throws)', async () => {
    const { mkdtempSync, readFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const migrateMod = await import(new URL('../src/main/db/migrate.ts', import.meta.url).href)

    // -- 全新库：一次迁到 5；005 新列 + 索引存在
    const dir = mkdtempSync(join(tmpdir(), 'devhub-uxa-143-'))
    const db = dbModule.openDatabase(join(dir, 'fresh.db'))
    try {
      const applied = dbModule.migrate(db)
      assert.equal(applied, 5, '001..005 applied on fresh db')
      assert.equal(Number(db.prepare('PRAGMA user_version').get().user_version), 5, 'user_version = 5')
      const sessionCols = db.prepare('PRAGMA table_info(agent_sessions)').all().map((c) => c.name)
      assert.ok(sessionCols.includes('parent_session_id'), 'agent_sessions.parent_session_id present')
      assert.ok(sessionCols.includes('archived_at'), 'agent_sessions.archived_at present')
      const messageCols = db.prepare('PRAGMA table_info(agent_messages)').all().map((c) => c.name)
      assert.ok(messageCols.includes('segments_json'), 'agent_messages.segments_json present')
      const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = 'idx_agent_sessions_parent'").all()
      assert.equal(indexes.length, 1, 'idx_agent_sessions_parent index created')
      const appliedAgain = dbModule.migrate(db)
      assert.equal(appliedAgain, 0, 'second migrate run applies nothing (idempotent)')
    } finally {
      db.close()
    }

    // -- 手工构造 v4 库（001..004 SQL + 手动 user_version=4）→ migrate 仅应用 005，数据保留
    const dir2 = mkdtempSync(join(tmpdir(), 'devhub-uxa-143-v4-'))
    const db2 = dbModule.openDatabase(join(dir2, 'v4.db'))
    try {
      for (const f of ['001_init.sql', '002_env_tools_unique.sql', '003_merge_legacy.sql', '004_agent_control.sql']) {
        db2.exec(readFileSync(new URL('../src/main/db/migrations/' + f, import.meta.url), 'utf8'))
      }
      db2.exec('PRAGMA user_version = 4') // 约束 #11 唯一例外；构造 v4 状态用
      const now = Math.floor(Date.now() / 1000)
      db2.prepare("INSERT INTO agent_providers (provider, display_name, created_at, updated_at) VALUES ('zcode', 'ZCode', ?, ?)").run(now, now)
      db2.prepare("INSERT INTO agent_sessions (provider_id, native_id, session_mode, status, created_at, updated_at) VALUES (1, 'sess_v4_keep', 'observed', 'running', ?, ?)").run(now, now)
      const applied = dbModule.migrate(db2)
      assert.equal(applied, 1, 'only 005 applies to the v4 library')
      assert.equal(Number(db2.prepare('PRAGMA user_version').get().user_version), 5, 'v4 upgraded to 5')
      const row = db2.prepare("SELECT native_id, parent_session_id, archived_at FROM agent_sessions WHERE native_id = 'sess_v4_keep'").get()
      assert.ok(row !== undefined, 'v4 session row survived the upgrade')
      assert.equal(row.parent_session_id, null, 'parent_session_id NULL for pre-005 rows')
      assert.equal(row.archived_at, null, 'archived_at NULL for pre-005 rows')
    } finally {
      db2.close()
    }

    // -- migrate.ts 字面量注册：case 5 生效；未注册版本显式抛错（T2 负向护栏延续）
    {
      const { mkdtempSync: mk2 } = await import('node:fs')
      const dir3 = mk2(join(tmpdir(), 'devhub-uxa-143-lit-'))
      const db3 = dbModule.openDatabase(join(dir3, 'lit.db'))
      try {
        migrateMod.setUserVersionLiteral(db3, 5)
        assert.equal(Number(db3.prepare('PRAGMA user_version').get().user_version), 5, 'case-5 literal statement works')
        assert.throws(() => migrateMod.setUserVersionLiteral(db3, 6), /no literal user_version statement/, 'unregistered version throws')
      } finally {
        db3.close()
      }
    }
  })

  // 144. R1/R8：zcode part 结构 → segments 投影（text/reasoning/tool 映射）；
  //      R8 plugin:// 标签化（segments 展示路径零原始 URI，contentRedacted 保留
  //      原文）；thinking 段脱敏；contentRedacted 向后兼容（仍只聚合 text 正文）；
  //      claude 转录 thinking 块 → thinking 段；损坏 segments_json 缺省不猜
  registerCase('uxa-144: R1/R8 segments projection — zcode part types map to text/thinking/toolInvocation segments, plugin:// labeled as short tag in segments but preserved in contentRedacted, thinking content redacted, corrupted segments_json degrades to no segments (never guesses), claude transcript thinking block maps to thinking segment, flat contentRedacted unchanged', async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { DatabaseSync } = await import('node:sqlite')
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const svc = await import(new URL('../src/main/services/agentControl/agentControlService.ts', import.meta.url).href)
    const zcodeMod = await import(new URL('../src/main/services/agentControl/providers/zcodeProvider.ts', import.meta.url).href)

    const dir = mkdtempSync(join(tmpdir(), 'devhub-uxa-144-'))
    const dbPath = join(dir, 'db.sqlite')
    const fdb = new DatabaseSync(dbPath)
    fdb.exec(
      CREATE TABLE session (id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, task_type TEXT);
      CREATE TABLE message (id TEXT, session_id TEXT, data TEXT, sequence INTEGER, time_created INTEGER);
      CREATE TABLE tool_usage (id TEXT, session_id TEXT, tool_name TEXT, approval_status TEXT, status TEXT, started_at INTEGER, completed_at INTEGER);
      CREATE TABLE part (id TEXT, message_id TEXT, data TEXT, sequence INTEGER);
    )
    const nowMs = 1788537360124
    fdb.prepare("INSERT INTO session (id, directory, title, time_created, time_updated, task_type) VALUES ('sess_uxa_seg', 'C:/ws/demo', 'Seg session', ?, ?, 'interactive')").run(nowMs, nowMs + 1000)
    fdb.prepare("INSERT INTO message (id, session_id, data, sequence, time_created) VALUES ('msg_seg_1', 'sess_uxa_seg', ?, 0, ?)").run(
      JSON.stringify({ role: 'assistant', time: { created: nowMs } }), nowMs)
    // parts：reasoning（含密钥形态文本）+ text（含 plugin:// markdown 引用）+ tool
    fdb.prepare("INSERT INTO part (id, message_id, data, sequence) VALUES ('p1', 'msg_seg_1', ?, 0)").run(
      JSON.stringify({ type: 'reasoning', text: 'thinking token=uxathinksecret42 about the problem' }))
    fdb.prepare("INSERT INTO part (id, message_id, data, sequence) VALUES ('p2', 'msg_seg_1', ?, 1)").run(
      JSON.stringify({ type: 'text', text: 'start [Android 模拟器](plugin://android-emulator@zcode-plugins-official) now' }))
    fdb.prepare("INSERT INTO part (id, message_id, data, sequence) VALUES ('p3', 'msg_seg_1', ?, 2)").run(
      JSON.stringify({ type: 'tool', title: 'Bash', state: { status: 'running', input: { command: 'ls -la' }, description: 'list files' } }))
    fdb.close()

    await makeTempHome('devhub-uxa-144-')
    const db = dbModule.getDatabase()
    try {
      const provider = zcodeMod.createZcodeProvider({ zcodeDbPath: dbPath, tasksIndexPath: join(dir, 'absent.sqlite'), snapshotRoot: join(dir, 'snaps') })
      const page = await provider.readMessages({ providerId: 'zcode', nativeId: 'sess_uxa_seg' })
      assert.equal(page.messages.length, 1, 'one message projected')
      const msg = page.messages[0]
      // contentRedacted 向后兼容：仍只聚合 type=text 正文；保留原始 URI（兼容字段）
      assert.ok(msg.contentRedacted.includes('plugin://android-emulator@zcode-plugins-official'), 'contentRedacted keeps raw plugin URI (compat)')
      assert.ok(!msg.contentRedacted.includes('thinking'), 'contentRedacted unchanged: no reasoning text (flat text-parts only)')
      // segments：text/thinking/toolInvocation 三段；R8 标签化 + 脱敏
      assert.ok(Array.isArray(msg.segments) && msg.segments.length === 3, 'three segments, got ' + JSON.stringify(msg.segments && msg.segments.map((x) => x.kind)))
      const seg0 = msg.segments[0]
      const seg1 = msg.segments[1]
      const seg2 = msg.segments[2]
      assert.equal(seg0.kind, 'text')
      assert.ok(seg0.content.includes('[插件] Android 模拟器'), 'link form labeled: ' + seg0.content)
      assert.ok(!seg0.content.includes('plugin://'), 'segments display path never carries raw plugin:// URI (R8)')
      assert.equal(seg1.kind, 'thinking')
      assert.ok(seg1.content.includes('token=***'), 'thinking content redacted (token=***)')
      assert.ok(!seg1.content.includes('uxathinksecret42'), 'no plaintext secret in thinking segment')
      assert.equal(seg2.kind, 'toolInvocation')
      assert.equal(seg2.label, 'Bash', 'toolInvocation label from part.title')
      assert.ok(seg2.content.includes('list files'), 'toolInvocation content from description')

      // 落库 → listAgentMessages 回读（segments_json 往返）
      const now = Math.floor(Date.now() / 1000)
      db.prepare("INSERT INTO agent_providers (provider, display_name, created_at, updated_at) VALUES ('zcode', 'ZCode', ?, ?)").run(now, now)
      const persisted = svc.persistMessage('zcode', 'sess_uxa_seg', msg)
      assert.ok(persisted.recorded, 'message persisted')
      const listed = svc.listAgentMessages({ sessionId: persisted.sessionId, last: 10 })
      assert.equal(listed.items.length, 1)
      assert.equal(listed.items[0].segments.length, 3, 'segments round-trip via segments_json')
      assert.equal(listed.items[0].segments[1].kind, 'thinking', 'thinking segment survives persistence')

      // 损坏 segments_json → 缺省 segments（绝不猜）
      db.prepare('UPDATE agent_messages SET segments_json = ? WHERE native_msg_id = ?').run('not-json{', 'msg_seg_1')
      const degraded = svc.listAgentMessages({ sessionId: persisted.sessionId, last: 10 })
      assert.ok(!('segments' in degraded.items[0]), 'corrupted segments_json degrades to no segments')

      // claude 转录（真机块形 {type:'thinking',thinking:string}）→ thinking 段
      const { writeFileSync, mkdirSync: mkd } = await import('node:fs')
      const claudeHome = join(dir, 'claude-home')
      mkd(join(claudeHome, 'projects', 'F--uxa-fixture'), { recursive: true })
      const transcript = join(claudeHome, 'projects', 'F--uxa-fixture', 'uxa-seg-claude.jsonl')
      writeFileSync(transcript, [
        JSON.stringify({ type: 'user', uuid: 'cu1', timestamp: '2026-09-04T10:00:00Z', message: { role: 'user', content: 'hello claude' } }),
        JSON.stringify({ type: 'assistant', uuid: 'ca1', timestamp: '2026-09-04T10:00:05Z', message: { role: 'assistant', content: [
          { type: 'thinking', thinking: 'claude thinking token=uxaclaudethink77 deep' },
          { type: 'text', text: 'answer [技能](skill://pdf-tools) ready' },
        ] } }),
      ].join('\n') + '\n')
      const claudeMod = await import(new URL('../src/main/services/agentControl/providers/claudeProvider.ts', import.meta.url).href)
      const claude = claudeMod.createClaudeProvider({ claudeHome, claudeCmd: 'definitely-not-invoked' })
      const cPage = await claude.readMessages({ providerId: 'claude-code', nativeId: 'uxa-seg-claude' })
      assert.equal(cPage.messages.length, 2, 'claude transcript lines projected')
      const cMsg = cPage.messages[1]
      assert.ok(cMsg.segments !== undefined && cMsg.segments.length === 2, 'claude assistant message has thinking+text segments')
      assert.equal(cMsg.segments[0].kind, 'thinking')
      assert.ok(cMsg.segments[0].content.includes('token=***'), 'claude thinking segment redacted')
      assert.ok(!cMsg.segments[0].content.includes('uxaclaudethink77'), 'no plaintext claude secret')
      assert.equal(cMsg.segments[1].kind, 'text')
      assert.ok(cMsg.segments[1].content.includes('[技能] pdf-tools'), 'skill link labeled: ' + cMsg.segments[1].content)
      assert.ok(!cMsg.segments[1].content.includes('skill://'), 'no raw skill:// in segments')
    } finally {
      svc.stopAllAgentControlRuntime()
      dbModule.closeDatabase()
    }
  })

  // 145. R10：messages 尾部取数（last/before + prevAfter 游标；after 正向不变；
  //      last/after/before 互斥 → BAD_PAYLOAD；nextAfter 语义不变）
  registerCase('uxa-145: R10 tail pagination — last=3 returns newest 3 ASC + prevAfter cursor, before=prevAfter walks older pages ASC until exhausted, after forward semantics unchanged, after/last/before mutually exclusive BAD_PAYLOAD', async () => {
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const handlers = await import(new URL('../src/main/ipc/handlers.ts', import.meta.url).href)
    const svc = await import(new URL('../src/main/services/agentControl/agentControlService.ts', import.meta.url).href)

    await makeTempHome('devhub-uxa-145-')
    try {
      const db = dbModule.getDatabase()
      const now = Math.floor(Date.now() / 1000)
      db.prepare("INSERT INTO agent_providers (provider, display_name, created_at, updated_at) VALUES ('codex', 'Codex', ?, ?)").run(now, now)
      const info = db.prepare("INSERT INTO agent_sessions (provider_id, native_id, session_mode, status, created_at, updated_at) VALUES (1, 'sess_tail', 'observed', 'running', ?, ?)").run(now, now)
      const sessionId = Number(info.lastInsertRowid)
      for (let i = 1; i <= 10; i++) {
        db.prepare("INSERT INTO agent_messages (session_id, native_msg_id, role, content_redacted, occurred_at, created_at) VALUES (?, ?, 'user', ?, ?, ?)").run(
          sessionId, 'tail-' + i, 'message ' + i, now - 100 + i, now)
      }
      const registry = handlers.createHandlerRegistry({ appVersion: 'uxa-smoke' })
      const dispatch = (channel, payload) => handlers.dispatchGatewayRequest(registry, { channel, payload })

      // last=3 → 最新 3 条 ASC + prevAfter
      const tail = await dispatch('agents:messages', { sessionId, last: 3 })
      assert.deepEqual(tail.data.items.map((m) => m.id), [8, 9, 10], 'last=3 returns newest three ASC')
      assert.equal(tail.data.prevAfter, 8, 'prevAfter = oldest id of the page')
      assert.ok(!('nextAfter' in tail.data), 'no nextAfter on tail path')

      // before=prevAfter 续拉更早页；耗尽后无 prevAfter
      const older = await dispatch('agents:messages', { sessionId, before: tail.data.prevAfter, limit: 5 })
      assert.deepEqual(older.data.items.map((m) => m.id), [3, 4, 5, 6, 7], 'before page ASC')
      assert.equal(older.data.prevAfter, 3, 'prevAfter walks to oldest')
      const oldest = await dispatch('agents:messages', { sessionId, before: older.data.prevAfter, limit: 5 })
      assert.deepEqual(oldest.data.items.map((m) => m.id), [1, 2], 'final page')
      assert.ok(!('prevAfter' in oldest.data), 'no prevAfter when exhausted')

      // after 正向语义不变
      const fwd = await dispatch('agents:messages', { sessionId, after: 8, limit: 10 })
      assert.deepEqual(fwd.data.items.map((m) => m.id), [9, 10], 'after forward unchanged')
      assert.ok(!('nextAfter' in fwd.data), 'nextAfter only when page full')

      // 互斥 → BAD_PAYLOAD
      for (const bad of [{ sessionId, last: 3, after: 2 }, { sessionId, last: 3, before: 2 }, { sessionId, after: 2, before: 2 }]) {
        const res = await dispatch('agents:messages', bad)
        assert.equal(res.ok, false, 'mutually exclusive params rejected: ' + JSON.stringify(bad))
        assert.equal(res.error.code, 'BAD_PAYLOAD')
      }
      // last 页大小语义：limit 同时给定时二者取小
      const capped = await dispatch('agents:messages', { sessionId, last: 500, limit: 4 })
      assert.equal(capped.data.items.length, 4, 'last capped by limit (page size semantics)')
    } finally {
      svc.stopAllAgentControlRuntime()
      dbModule.closeDatabase()
    }
  })

  // 146. R3：archive/unarchive 幂等 + DELETE 级联清理（子会话链连带；消息/事件/
  //      deliveries/资源边清零；remote_commands FK SET NULL 解绑；源文件零触碰
  //      ——物理只读断言；审计落库；重删 NOT_FOUND）
  registerCase('uxa-146: R3 archive/unarchive idempotent + delete cascades child chain (messages/events/deliveries/resources/relationships cleaned, remote_commands detached via FK, source fixture byte-identical), audit rows written, re-delete NOT_FOUND', async () => {
    const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const svc = await import(new URL('../src/main/services/agentControl/agentControlService.ts', import.meta.url).href)
    const lifecycle = await import(new URL('../src/main/services/agentControl/sessionLifecycle.ts', import.meta.url).href)

    await makeTempHome('devhub-uxa-146-')
    const db = dbModule.getDatabase()
    // 源文件零触碰的物理证据：临时"源转录"文件，删除后逐字节比对
    const sourceFixture = join(tmpdir(), 'devhub-uxa-146-src.jsonl')
    writeFileSync(sourceFixture, 'native transcript bytes -- never touched by devhub\n')
    try {
      const now = Math.floor(Date.now() / 1000)
      db.prepare("INSERT INTO agent_providers (provider, display_name, created_at, updated_at) VALUES ('zcode', 'ZCode', ?, ?)").run(now, now)
      db.prepare("INSERT INTO remote_devices (device_name, platform, token_hash, paired_at, created_at, updated_at) VALUES ('d', 'android', 'deadbeef', ?, ?, ?)").run(now, now, now)
      const insSession = db.prepare("INSERT INTO agent_sessions (provider_id, native_id, session_mode, status, created_at, updated_at) VALUES (1, ?, 'observed', 'running', ?, ?)")
      const mainId = Number(insSession.run('sess_arch_main', now, now).lastInsertRowid)
      const childId = Number(db.prepare("INSERT INTO agent_sessions (provider_id, native_id, session_mode, status, parent_session_id, created_at, updated_at) VALUES (1, 'sess_arch_child', 'observed', 'running', ?, ?, ?)").run(mainId, now, now).lastInsertRowid)
      assert.ok(childId > 0)
      for (const sid of [mainId, childId]) {
        db.prepare("INSERT INTO agent_messages (session_id, native_msg_id, role, content_redacted, created_at) VALUES (?, ?, 'user', 'm', ?)").run(sid, 'm-' + sid, now)
        db.prepare("INSERT INTO agent_events (provider_id, session_id, event_type, event_id, payload_json, delivery_state, created_at) VALUES (1, ?, 'message.appended', ?, '{}', 'pending', ?)").run(sid, 'ev-' + sid, now)
      }
      const eventIds = db.prepare('SELECT id FROM agent_events ORDER BY id').all().map((r) => r.id)
      for (const eid of eventIds) {
        db.prepare("INSERT INTO event_deliveries (event_id, device_id, status, created_at) VALUES (?, 1, 'pending', ?)").run(eid, now)
      }
      db.prepare("INSERT INTO resources (resource_type, ref_id, display_name, created_at, updated_at) VALUES ('session', ?, 'zcode:main', ?, ?)").run(mainId, now, now)
      const agentRes = Number(db.prepare("INSERT INTO resources (resource_type, ref_id, display_name, created_at, updated_at) VALUES ('agent', 1, 'zcode', ?, ?)").run(now, now).lastInsertRowid)
      const sessionRes = Number(db.prepare("SELECT id FROM resources WHERE resource_type = 'session' AND ref_id = ?").get(mainId).id)
      db.prepare("INSERT INTO relationships (source_resource_id, target_resource_id, relation_type, created_at) VALUES (?, ?, 'exposes', ?)").run(agentRes, sessionRes, now)
      db.prepare("INSERT INTO remote_commands (command_id, idempotency_key, session_id, action, status, expires_at, created_at) VALUES ('cmd-uxa-146', 'key-146', ?, 'reply', 'executed', ?, ?)").run(mainId, now + 600, now)

      // 归档：幂等（重复归档不刷新时间戳）
      const a1 = lifecycle.archiveSession(mainId)
      assert.equal(a1.archived, true)
      assert.ok(typeof a1.archivedAt === 'number')
      const a2 = lifecycle.archiveSession(mainId)
      assert.equal(a2.archivedAt, a1.archivedAt, 're-archive keeps the original archivedAt (idempotent)')
      assert.ok(db.prepare('SELECT archived_at FROM agent_sessions WHERE id = ?').get(mainId).archived_at !== null)
      // 取消归档：幂等
      assert.deepEqual(lifecycle.unarchiveSession(mainId), { sessionId: mainId, archived: false })
      assert.deepEqual(lifecycle.unarchiveSession(mainId), { sessionId: mainId, archived: false }, 'unarchive idempotent')
      assert.equal(db.prepare('SELECT archived_at FROM agent_sessions WHERE id = ?').get(mainId).archived_at, null)

      // 删除主会话 → 子会话连带级联；源文件逐字节不变
      const del = lifecycle.deleteSession(mainId)
      assert.equal(del.deleted, true)
      assert.equal(del.removed.sessions, 2, 'main + child sessions deleted')
      assert.equal(del.removed.messages, 2, 'both sessions messages deleted')
      assert.equal(del.removed.events, 2, 'session-scoped events deleted')
      assert.equal(del.removed.deliveries, 2, 'deliveries of deleted events deleted')
      assert.equal(del.removed.resources, 1, 'main session resource node deleted')
      assert.equal(db.prepare('SELECT COUNT(*) c FROM agent_sessions').get().c, 0, 'no session rows remain')
      assert.equal(db.prepare('SELECT COUNT(*) c FROM agent_messages').get().c, 0, 'no messages remain')
      assert.equal(db.prepare('SELECT COUNT(*) c FROM agent_events').get().c, 0, 'no session-scoped events remain')
      assert.equal(db.prepare('SELECT COUNT(*) c FROM event_deliveries').get().c, 0, 'no deliveries remain')
      assert.equal(db.prepare("SELECT COUNT(*) c FROM resources WHERE resource_type = 'session'").get().c, 0, 'session resource nodes gone')
      assert.equal(db.prepare('SELECT COUNT(*) c FROM relationships').get().c, 0, 'edges gone')
      const cmd = db.prepare("SELECT session_id FROM remote_commands WHERE command_id = 'cmd-uxa-146'").get()
      assert.equal(cmd.session_id, null, 'remote_commands detached (row kept)')
      // 源文件零触碰（红线物理证据）
      assert.equal(readFileSync(sourceFixture, 'utf8'), 'native transcript bytes -- never touched by devhub\n', 'source file byte-identical after delete')
      // 重删 → NOT_FOUND（结构化错误 code）
      let notFound = null
      try { lifecycle.deleteSession(mainId) } catch (e) { notFound = e }
      assert.ok(notFound !== null && notFound.code === 'NOT_FOUND', 're-delete structured NOT_FOUND')
      // 审计
      const actions = db.prepare("SELECT action FROM security_audit_logs WHERE category = 'session' ORDER BY id").all().map((r) => r.action)
      assert.deepEqual(actions, ['session_archived', 'session_unarchived', 'session_deleted'], 'session lifecycle audited: ' + JSON.stringify(actions))
    } finally {
      svc.stopAllAgentControlRuntime()
      dbModule.closeDatabase()
    }
  })

  // 147. R2：zcode 父子链端到端（fixture 带 parent_id 列）——子会话快照落库、
  //      默认列表隐藏、parentId= 过滤、sessionDetail childSessions、子会话消息
  //      可见、父不可解析的子会话仍排除；REST 面同构验证（含 includeArchived）。
  //      R4：providerKey/providerLabel 投影。
  registerCase('uxa-147: R2/R4 parent chain end-to-end — zcode fixture with parent_id imports children via parentNativeSessionId (unresolvable-parent children stay excluded), default list keeps main only, parentId= filter returns children, sessionDetail carries childSessions + providerKey/providerLabel, child messages visible, REST surface isomorphic', async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { DatabaseSync } = await import('node:sqlite')
    const dbModule = await import(new URL('../src/main/db/index.ts', import.meta.url).href)
    const svc = await import(new URL('../src/main/services/agentControl/agentControlService.ts', import.meta.url).href)
    const zcodeMod = await import(new URL('../src/main/services/agentControl/providers/zcodeProvider.ts', import.meta.url).href)

    const dir = mkdtempSync(join(tmpdir(), 'devhub-uxa-147-'))
    const dbPath = join(dir, 'db.sqlite')
    const fdb = new DatabaseSync(dbPath)
    fdb.exec(
      CREATE TABLE session (id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, task_type TEXT, parent_id TEXT);
      CREATE TABLE message (id TEXT, session_id TEXT, data TEXT, sequence INTEGER, time_created INTEGER);
      CREATE TABLE tool_usage (id TEXT, session_id TEXT, tool_name TEXT, approval_status TEXT, status TEXT, started_at INTEGER, completed_at INTEGER);
      CREATE TABLE part (id TEXT, message_id TEXT, data TEXT, sequence INTEGER);
    )
    const nowMs = 1788537360124
    const ins = fdb.prepare('INSERT INTO session (id, directory, title, time_created, time_updated, task_type, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    ins.run('sess_uxa_parent', 'C:/ws/demo', 'Parent session', nowMs, nowMs + 9000, 'interactive', null)
    ins.run('sess_subagent_agent_u147a', 'C:/ws/demo', 'child A', nowMs + 1000, nowMs + 2000, 'subagent_child', 'sess_uxa_parent')
    ins.run('sess_subagent_agent_u147b', 'C:/ws/demo', 'child B', nowMs + 3000, nowMs + 4000, 'subagent_child', 'sess_uxa_parent')
    ins.run('sess_subagent_agent_u147x', 'C:/ws/demo', 'orphan child', nowMs + 5000, nowMs + 6000, 'subagent_child', null)
    fdb.prepare("INSERT INTO message (id, session_id, data, sequence, time_created) VALUES ('m-child-a', 'sess_subagent_agent_u147a', ?, 0, ?)").run(
      JSON.stringify({ role: 'user', time: { created: nowMs + 1500 } }), nowMs + 1500)
    fdb.prepare("INSERT INTO part (id, message_id, data, sequence) VALUES ('mp1', 'm-child-a', ?, 0)").run(
      JSON.stringify({ type: 'text', text: 'child A message body' }))
    fdb.close()

    const m = await gwCaseSetup('devhub-uxa-147-')
    const db = m.dbModule.getDatabase()
    try {
      // 夹具 zcode provider 落库（refreshProviderSessions 全量路径）
      const provider = zcodeMod.createZcodeProvider({ zcodeDbPath: dbPath, tasksIndexPath: join(dir, 'absent.sqlite'), snapshotRoot: join(dir, 'snaps') })
      for (const pid of ['codex', 'claude-code', 'kimi', 'deepseek']) svc.setProviderOverride(pid, stubAgentProvider(pid))
      svc.setProviderOverride('zcode', provider)
      svc.ensureAgentProviderRows()
      await svc.refreshProviderSessions('zcode', true)
      // 子会话消息（子会话行已存在 → persistMessage 可直接投影）
      const childPage = await provider.readMessages({ providerId: 'zcode', nativeId: 'sess_subagent_agent_u147a' })
      assert.equal(childPage.messages.length, 1, 'child message projected at provider level')
      const persisted = svc.persistMessage('zcode', 'sess_subagent_agent_u147a', childPage.messages[0])
      assert.ok(persisted.recorded, 'child message persisted into L3')

      // 默认列表：只有主会话（父不可解析的 orphan 也不出现）
      const defaultList = svc.listAgentSessions({})
      assert.deepEqual(defaultList.sessions.map((s) => s.nativeId).sort(), ['sess_uxa_parent'], 'default list = main sessions only')
      // R4：providerKey/providerLabel 投影
      assert.equal(defaultList.sessions[0].providerKey, 'zcode', 'providerKey projected')
      assert.equal(defaultList.sessions[0].providerLabel, 'ZCode', 'providerLabel projected')
      // 库复核：父链落库 + orphan 排除
      const parentRow = db.prepare("SELECT id FROM agent_sessions WHERE native_id = 'sess_uxa_parent'").get()
      const childRows = db.prepare("SELECT id, parent_session_id FROM agent_sessions WHERE native_id LIKE 'sess\\_subagent\\_agent\\_u147%' ESCAPE '\\'").all()
      assert.equal(childRows.length, 2, 'two resolvable-parent children imported')
      assert.ok(childRows.every((r) => r.parent_session_id === parentRow.id), 'children linked to parent row')
      const orphan = db.prepare("SELECT COUNT(*) c FROM agent_sessions WHERE native_id = 'sess_subagent_agent_u147x'").get()
      assert.equal(orphan.c, 0, 'unresolvable-parent child stays excluded (never guesses parent)')

      // parentId= 过滤：子会话页（含已结束）
      const children = svc.listAgentSessions({ parentId: parentRow.id })
      assert.deepEqual(children.sessions.map((s) => s.nativeId).sort(), ['sess_subagent_agent_u147a', 'sess_subagent_agent_u147b'], 'parentId filter returns the two children')

      // sessionDetail：childSessions + providerKey/providerLabel；子会话消息可见
      const detail = svc.getAgentSessionDetail(parentRow.id)
      assert.ok(Array.isArray(detail.session.childSessions) && detail.session.childSessions.length === 2, 'childSessions present in detail view')
      assert.ok(detail.session.childSessions.every((c) => c.providerKey === 'zcode'), 'child sessions carry provider identity too')
      const childDetail = svc.getAgentSessionDetail(detail.session.childSessions[0].id)
      assert.ok(!('childSessions' in childDetail.session), 'childless session omits childSessions field')
      const childMsgs = svc.listAgentMessages({ sessionId: detail.session.childSessions[0].id })
      assert.equal(childMsgs.items.length, 1, 'child session messages visible')

      // REST 同构：默认隐藏子会话/归档可见性/childSessions
      await startGatewayEnabled(m)
      const dev = await pairViaHttp(8746, 'uxa-147-phone')
      const rAll = await gwRequest(8746, 'GET', '/v1/sessions', { token: dev.token, headers: replayHeaders() })
      assert.equal(rAll.json.sessions.length, 1, 'REST default list hides children')
      assert.equal(rAll.json.sessions[0].providerLabel, 'ZCode', 'REST providerLabel projected')
      const rKids = await gwRequest(8746, 'GET', '/v1/sessions?parentId=' + parentRow.id, { token: dev.token, headers: replayHeaders() })
      assert.equal(rKids.json.sessions.length, 2, 'REST parentId filter works')
      const rDetail = await gwRequest(8746, 'GET', '/v1/sessions/' + parentRow.id, { token: dev.token, headers: replayHeaders() })
      assert.deepEqual(Object.keys(rDetail.json).sort(), ['capabilities', 'session'], 'detail top-level shape unchanged')
      assert.equal(rDetail.json.session.childSessions.length, 2, 'REST detail carries childSessions')
      // 归档 + includeArchived（R3 端到端最小面）
      const lifecycle = await import(new URL('../src/main/services/agentControl/sessionLifecycle.ts', import.meta.url).href)
      lifecycle.archiveSession(parentRow.id)
      const rArchived = await gwRequest(8746, 'GET', '/v1/sessions', { token: dev.token, headers: replayHeaders() })
      assert.equal(rArchived.json.sessions.length, 0, 'archived session hidden by default (R3)')
      const rInc = await gwRequest(8746, 'GET', '/v1/sessions?includeArchived=1', { token: dev.token, headers: replayHeaders() })
      assert.equal(rInc.json.sessions.length, 1, 'includeArchived=1 reveals archived session')
      assert.ok(rInc.json.sessions[0].archivedAt > 0, 'archivedAt projected')
      // REST messages 尾部取数（R10 端到端最小面）
      lifecycle.unarchiveSession(parentRow.id)
      const rTail = await gwRequest(8746, 'GET', '/v1/sessions/' + detail.session.childSessions[0].id + '/messages?last=5', { token: dev.token, headers: replayHeaders() })
      assert.equal(rTail.status, 200)
      assert.equal(rTail.json.items.length, 1, 'REST last= tail works')
      assert.ok(!('sourceRef' in rTail.json.items[0]), 'REST items never carry sourceRef')
    } finally {
      await gwCaseTeardown(m)
    }
  })

  // 148. R6：POST /v1/providers/{providerId}/sessions —— managed 门（managed→202、
  //      observed→403 COMMAND_NOT_EXECUTABLE、未验证→403 AGENT_CAPABILITY_MISSING、
  //      未知 provider→404、空 task→400）；幂等（同 key 原结果 / 异 payload 409）；
  //      四件套（无 Token 401）；command.result 事件 + 审计；数字 id 形态受理。
  registerCase('uxa-148: R6 managed-session spawn endpoint — managed gate (202 with sessionId/nativeId, observed 403 COMMAND_NOT_EXECUTABLE, unverified 403 AGENT_CAPABILITY_MISSING, unknown 404, empty task 400), idempotency (same key replays original, different payload 409 COMMAND_KEY_CONFLICT), bearer required 401, command.result event + audit trail, numeric provider id accepted', async () => {
    const m = await gwCaseSetup('devhub-uxa-148-')
    const db = m.dbModule.getDatabase()
    try {
      await startGatewayEnabled(m)
      const dev = await pairViaHttp(8746, 'uxa-148-phone')
      const now = Math.floor(Date.now() / 1000)
      // codex 行：managed 能力（已验证）；zcode 行：observed（已验证）；kimi：过期能力
      const capsManaged = JSON.stringify({ mode: 'managed', granted: ['reply', 'pause', 'resume'], verifiedAt: now, evidence: 'fixture managed' })
      const capsObserved = JSON.stringify({ mode: 'observed', granted: [], verifiedAt: now, evidence: 'fixture observed' })
      const capsStale = JSON.stringify({ mode: 'managed', granted: ['reply'], verifiedAt: now - 400, evidence: 'stale fixture' })
      db.prepare("INSERT INTO agent_providers (provider, display_name, installed, health, capabilities_json, created_at, updated_at) VALUES ('codex', 'Codex', 1, 'ok', ?, ?, ?)").run(capsManaged, now, now)
      db.prepare("INSERT INTO agent_providers (provider, display_name, installed, health, capabilities_json, created_at, updated_at) VALUES ('zcode', 'ZCode', 1, 'ok', ?, ?, ?)").run(capsObserved, now, now)
      db.prepare("INSERT INTO agent_providers (provider, display_name, installed, health, capabilities_json, created_at, updated_at) VALUES ('kimi', 'Kimi Code', 1, 'ok', ?, ?, ?)").run(capsStale, now, now)
      // 托管启动夹具：经 sink 落快照（managed），返回 ok
      const startedTasks = []
      const spawnStub = (id) => ({
        ...stubAgentProvider(id),
        probeHealth: async () => ({ installed: true, health: 'ok' }),
        getCapabilities: async () => ({ mode: 'managed', granted: ['reply'], verifiedAt: now, evidence: 'fixture managed' }),
        startManagedSession: async (task, sink) => {
          startedTasks.push(task)
          sink.onSessionDiscovered?.(id, { nativeId: 'managed-' + id + '-1', mode: 'managed', lastActivityAt: now })
          return { ok: true, nativeId: 'managed-' + id + '-1', detail: 'fixture managed start' }
        },
      })
      m.svc.setProviderOverride('codex', spawnStub('codex'))
      m.svc.setProviderOverride('zcode', spawnStub('zcode'))

      const post = (path, body, opts = {}) => gwRequest(8746, 'POST', path, {
        body,
        token: opts.token === undefined ? dev.token : opts.token,
        headers: replayHeaders(),
      })

      // managed provider（业务键形态）→ 202 {commandId, status, sessionId, nativeId}
      const r1 = await post('/v1/providers/codex/sessions', { task: 'do the fixture turn', idempotencyKey: 'uxa-148-key-1' })
      assert.equal(r1.status, 202, 'managed spawn -> 202, got ' + r1.status + ' ' + r1.raw)
      assert.equal(r1.json.status, 'executed', 'synchronous managed start executes')
      assert.match(r1.json.commandId, /^cmd-/, 'commandId shape')
      assert.equal(r1.json.nativeId, 'managed-codex-1', 'nativeId returned')
      assert.ok(typeof r1.json.sessionId === 'number' && r1.json.sessionId > 0, 'sessionId resolved from the L3 upsert')
      assert.deepEqual(startedTasks, ['do the fixture turn'], 'provider received the task verbatim')
      // 会话行 managed + running；remote_commands 终态；审计与事件
      const sessRow = db.prepare('SELECT session_mode, status FROM agent_sessions WHERE id = ?').get(r1.json.sessionId)
      assert.equal(sessRow.session_mode, 'managed', 'session row lands as managed')
      assert.equal(sessRow.status, 'running', 'session advances to running')
      const cmdRow = db.prepare('SELECT action, status, result_json FROM remote_commands WHERE command_id = ?').get(r1.json.commandId)
      assert.equal(cmdRow.action, 'spawn', 'remote_commands action = spawn')
      assert.equal(cmdRow.status, 'executed', 'command row executed')
      assert.ok(cmdRow.result_json.includes('"sessionId"'), 'result_json carries sessionId for idempotent replay')
      const ev = db.prepare("SELECT event_type FROM agent_events WHERE event_type = 'command.result' ORDER BY id DESC LIMIT 1").get()
      assert.ok(ev !== undefined, 'command.result event recorded')
      const auditActions = db.prepare("SELECT action FROM security_audit_logs WHERE category = 'command' ORDER BY id").all().map((r) => r.action)
      assert.ok(auditActions.includes('command_accepted') && auditActions.includes('command_executed'), 'audit trail: ' + JSON.stringify(auditActions))

      // 同 key 重试 → 原命令原结果（不重复执行）
      const beforeCount = db.prepare('SELECT COUNT(*) c FROM agent_sessions').get().c
      const rRetry = await post('/v1/providers/codex/sessions', { task: 'do the fixture turn', idempotencyKey: 'uxa-148-key-1' })
      assert.equal(rRetry.status, 202)
      assert.equal(rRetry.json.commandId, r1.json.commandId, 'same key replays original commandId')
      assert.equal(rRetry.json.sessionId, r1.json.sessionId, 'same key replays original sessionId')
      assert.equal(startedTasks.length, 1, 'provider NOT invoked twice (idempotent)')
      assert.equal(db.prepare('SELECT COUNT(*) c FROM agent_sessions').get().c, beforeCount, 'no duplicate session rows')

      // 同 key 异 payload → 409 COMMAND_KEY_CONFLICT
      const rConflict = await post('/v1/providers/codex/sessions', { task: 'different task', idempotencyKey: 'uxa-148-key-1' })
      assert.equal(rConflict.status, 409)
      assert.equal(rConflict.json.error.code, 'COMMAND_KEY_CONFLICT')

      // observed provider → 403 COMMAND_NOT_EXECUTABLE
      const rObserved = await post('/v1/providers/zcode/sessions', { task: 'nope' })
      assert.equal(rObserved.status, 403, 'observed provider refused')
      assert.equal(rObserved.json.error.code, 'COMMAND_NOT_EXECUTABLE', 'COMMAND_NOT_EXECUTABLE for non-managed')
      // 能力过期 → 403 AGENT_CAPABILITY_MISSING
      const rStale = await post('/v1/providers/kimi/sessions', { task: 'nope' })
      assert.equal(rStale.status, 403)
      assert.equal(rStale.json.error.code, 'AGENT_CAPABILITY_MISSING', 'stale capabilities refused')
      // 未知 provider → 404；空 task → 400；无 Token → 401
      const rUnknown = await post('/v1/providers/nope/sessions', { task: 'x' })
      assert.equal(rUnknown.status, 404, 'unknown provider NOT_FOUND')
      const rEmpty = await post('/v1/providers/codex/sessions', { task: '  ' })
      assert.equal(rEmpty.status, 400, 'blank task BAD_PAYLOAD')
      assert.equal(rEmpty.json.error.code, 'BAD_PAYLOAD')
      const rNoAuth = await gwRequest(8746, 'POST', '/v1/providers/codex/sessions', { body: { task: 'x' }, headers: replayHeaders() })
      assert.equal(rNoAuth.status, 401, 'bearer required (four-piece security)')
      // 数字 id 形态受理
      const codexRowId = db.prepare("SELECT id FROM agent_providers WHERE provider = 'codex'").get().id
      const rNumeric = await post('/v1/providers/' + codexRowId + '/sessions', { task: 'numeric id form', idempotencyKey: 'uxa-148-key-2' })
      assert.equal(rNumeric.status, 202, 'numeric provider id accepted, got ' + rNumeric.status + ' ' + rNumeric.raw)
      assert.equal(rNumeric.json.nativeId, 'managed-codex-1', 'same underlying nativeId')
    } finally {
      await gwCaseTeardown(m)
    }
  })

  // 149. R5/R5.1：自适应刷新节流纯函数（活跃 3s / 空闲 15s / 窗口边界）+
  //      延迟打点纯面（percentile / recordLatencySample / latencySnapshot / reset；
  //      环形封顶；负值折叠；零内容记录）
  registerCase('uxa-149: R5 adaptive refresh throttle pure function (active 3s / idle 15s / window boundaries) + R5.1 latency stats surface (percentile math, sample recording with negative clamp, ring cap, snapshot shape, reset)', async () => {
    const svc = await import(new URL('../src/main/services/agentControl/agentControlService.ts', import.meta.url).href)
    const lat = await import(new URL('../src/main/services/agentControl/latencyStats.ts', import.meta.url).href)

    // 自适应节流：纯函数契约
    assert.equal(svc.SESSIONS_REFRESH_ACTIVE_SEC, 3, 'active interval 3s (task-book 2-5s window)')
    assert.equal(svc.SESSIONS_REFRESH_IDLE_SEC, 15, 'idle interval stays 15s')
    assert.equal(svc.PROVIDER_ACTIVE_WINDOW_SEC, 300, 'activity window 5 minutes')
    const now = 1_800_000_000
    assert.equal(svc.sessionsRefreshIntervalSec(now, now - 299), 3, 'recently active -> fast 3s')
    assert.equal(svc.sessionsRefreshIntervalSec(now, now - 300), 3, 'exactly at window boundary -> fast (<=)')
    assert.equal(svc.sessionsRefreshIntervalSec(now, now - 301), 15, 'just past window -> idle 15s')
    assert.equal(svc.sessionsRefreshIntervalSec(now, null), 15, 'no activity evidence -> idle 15s')
    assert.equal(svc.sessionsRefreshIntervalSec(now, 0), 15, 'zero activity -> idle 15s')
    assert.equal(svc.sessionsRefreshIntervalSec(now, now + 5), 3, 'future timestamp (clock skew) still within window')

    // 延迟打点：percentile 纯数学
    assert.equal(lat.percentile([], 50), 0, 'empty -> 0')
    assert.equal(lat.percentile([7], 95), 7, 'single sample')
    assert.equal(lat.percentile([1, 2, 3, 4], 50), 2, 'p50 of [1..4]')
    assert.equal(lat.percentile([1, 2, 3, 4], 100), 4, 'p100 = max')
    assert.equal(lat.percentile([10, 1, 5], 50), 5, 'unsorted input tolerated (sorted internally)')

    lat.resetLatencyStats()
    let snap = lat.latencySnapshot()
    assert.deepEqual(snap['source-to-db'], { count: 0, p50Ms: 0, p95Ms: 0, maxMs: 0, lastMs: 0 }, 'zeroed snapshot shape')
    for (let i = 1; i <= 100; i++) lat.recordLatencySample('source-to-db', i)
    lat.recordLatencySample('source-to-db', -50) // 负值折叠 0
    lat.recordLatencySample('db-to-ws', 250)
    snap = lat.latencySnapshot()
    assert.equal(snap['source-to-db'].count, 101, 'count includes clamped sample')
    assert.equal(snap['source-to-db'].p95Ms, 96, 'p95 of 1..100 = 96')
    assert.equal(snap['source-to-db'].maxMs, 100, 'max tracked')
    assert.equal(snap['source-to-db'].lastMs, 0, 'last = clamped 0')
    assert.equal(snap['db-to-ws'].count, 1, 'stages tracked independently')
    assert.equal(snap['db-to-ws'].p50Ms, 250, 'single db-to-ws sample')
    // 环形封顶
    for (let i = 0; i < 1000; i++) lat.recordLatencySample('db-to-ws', i)
    snap = lat.latencySnapshot()
    assert.equal(snap['db-to-ws'].count, 1001, 'total count keeps accumulating')
    assert.ok(snap['db-to-ws'].p50Ms > 400, 'ring keeps only the latest window (p50=' + snap['db-to-ws'].p50Ms + ')')
    lat.resetLatencyStats()
    assert.equal(lat.latencySnapshot()['source-to-db'].count, 0, 'reset clears everything')
  })
`

const anchor = '  await run()\n}'
if (s.count === undefined) {
  const n = s.split(anchor).length - 1
  if (n !== 1) throw new Error('anchor match count ' + n)
}
const out = s.replace(anchor, newCases.split('\x01').join('`') + '\n  await run()\n}')
writeFileSync(p, out)
console.log('7 new smoke cases appended')
