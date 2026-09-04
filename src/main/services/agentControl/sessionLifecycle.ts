/**
 * sessionLifecycle.ts — R3 会话归档/删除（ux 整改批 A）。
 *
 * L3 写函数（约束 #20：写库经 Service 层；本模块即 agentControl 域 L3 的会话
 * 生命周期切面，与 agentControlService 解耦为独立文件）。
 *
 * 红线（任务书 §2 R3 / §3.3）：
 * - 删除/归档**只动 DevHub 本地投影行**；~/.zcode、~/.claude 等源文件零触碰
 *   （本模块零 fs import，物理上不可能触源）。
 * - 删除级联清理：agent_sessions 行 + 该会话（含其子会话链）的 messages /
 *   session 域 events / event_deliveries / session 资源节点与边，单事务完成；
 *   remote_commands.session_id 由 FK ON DELETE SET NULL 自动解绑（行保留）。
 *   「未确认事件绝不删除」不变式（docs/12 §6 裁决 5）针对事件管线运行期路径
 *   （eventPipeline/agentControlService 零 DELETE，smoke 静态断言继续成立）；
 *   用户显式发起的会话删除是任务书 §2 R3 明文裁决的例外，形态对齐
 *   scripts/cleanup-zcode-subagent-sessions.mjs 先例（fix-zcode-subagent-142 用例锁过）。
 * - 删除父会话连带其子会话（R2 父子链下孤儿子会话将永久不可达，连带清理防悬挂）。
 *
 * electron-free；一切 SQL 参数绑定（约束 #11）；错误一律 ServiceError（约束 #14）。
 */

import { getDatabase } from '../../db/index.ts'
import { nowSec } from '../internal.ts'
import { ServiceError } from '../internal.ts'
import { recordSecurityAudit } from './agentControlService.ts'

/** 会话行（删除/归档的存在性判定 + 审计归因所需最小列）。 */
interface LifecycleSessionRow {
  id: number
  provider_id: number
  native_id: string
  archived_at: number | null
}

function readLifecycleSessionRow(sessionId: number): LifecycleSessionRow {
  const row = getDatabase()
    .prepare('SELECT id, provider_id, native_id, archived_at FROM agent_sessions WHERE id = ?')
    .get(sessionId) as LifecycleSessionRow | undefined
  if (row === undefined) {
    throw new ServiceError('NOT_FOUND', `agent session ${sessionId} not found`)
  }
  return row
}

/**
 * 归档（幂等）：已归档返回既有 archivedAt（不刷新）；未归档落 archived_at=now。
 * 只动本投影行；源文件零触碰。返回当前 archivedAt 真值。
 */
export function archiveSession(sessionId: number): { sessionId: number; archived: true; archivedAt: number } {
  const row = readLifecycleSessionRow(sessionId)
  const db = getDatabase()
  if (row.archived_at !== null) {
    return { sessionId: row.id, archived: true, archivedAt: row.archived_at }
  }
  const now = nowSec()
  db.prepare('UPDATE agent_sessions SET archived_at = ?, updated_at = ? WHERE id = ?').run(now, now, row.id)
  recordSecurityAudit('session', 'session_archived', null, 'success', JSON.stringify({ sessionId: row.id, nativeId: row.native_id }))
  return { sessionId: row.id, archived: true, archivedAt: now }
}

/** 取消归档（幂等）：archived_at → NULL；未归档原样返回。 */
export function unarchiveSession(sessionId: number): { sessionId: number; archived: false } {
  const row = readLifecycleSessionRow(sessionId)
  const db = getDatabase()
  if (row.archived_at !== null) {
    db.prepare('UPDATE agent_sessions SET archived_at = NULL, updated_at = ? WHERE id = ?').run(nowSec(), row.id)
    recordSecurityAudit('session', 'session_unarchived', null, 'success', JSON.stringify({ sessionId: row.id, nativeId: row.native_id }))
  }
  return { sessionId: row.id, archived: false }
}

/** 删除计数（审计与响应投影；零内容、零路径——只有行数）。 */
export interface SessionDeleteCounts {
  sessions: number
  messages: number
  events: number
  deliveries: number
  resources: number
  relationships: number
}

/**
 * 删除会话（连带子会话链；单事务；只动本地投影）：
 * 1. 收集目标集 = 本会话 ∪ 全部后代（parent_session_id BFS 到不动点）；
 * 2. 顺序：event_deliveries → agent_events（会话域）→ agent_messages →
 *    relationships（session 资源边）→ resources（session 节点）→ agent_sessions；
 * 3. remote_commands 由 FK SET NULL 自动解绑；security_audit_logs 不携带会话外键。
 * 会话不存在 → NOT_FOUND。
 */
export function deleteSession(sessionId: number): { sessionId: number; deleted: true; removed: SessionDeleteCounts } {
  const row = readLifecycleSessionRow(sessionId)
  const db = getDatabase()

  // 1) 目标集：本会话 + 全部后代（BFS）
  const targetIds: number[] = [row.id]
  const frontier: number[] = [row.id]
  while (frontier.length > 0) {
    const placeholders = frontier.map(() => '?').join(', ')
    const children = db
      .prepare(`SELECT id FROM agent_sessions WHERE parent_session_id IN (${placeholders})`)
      .all(...frontier) as Array<{ id: number }>
    frontier.length = 0
    for (const child of children) {
      if (!targetIds.includes(child.id)) {
        targetIds.push(child.id)
        frontier.push(child.id)
      }
    }
  }

  const idsPlaceholders = targetIds.map(() => '?').join(', ')
  const eventIds = (
    db.prepare(`SELECT id FROM agent_events WHERE session_id IN (${idsPlaceholders})`).all(...targetIds) as Array<{
      id: number
    }>
  ).map((r) => r.id)

  db.exec('BEGIN IMMEDIATE')
  const counts: SessionDeleteCounts = { sessions: 0, messages: 0, events: 0, deliveries: 0, resources: 0, relationships: 0 }
  try {
    // 2a. event_deliveries（先于事件行）
    if (eventIds.length > 0) {
      for (let i = 0; i < eventIds.length; i += 500) {
        const slice = eventIds.slice(i, i + 500)
        const ph = slice.map(() => '?').join(', ')
        counts.deliveries += Number(db.prepare(`DELETE FROM event_deliveries WHERE event_id IN (${ph})`).run(...slice).changes)
      }
    }
    // 2b. agent_events（会话域；provider 域事件不携带 session_id，天然不受影响）
    {
      const info = db.prepare(`DELETE FROM agent_events WHERE session_id IN (${idsPlaceholders})`).run(...targetIds)
      counts.events = Number(info.changes)
    }
    // 2c. agent_messages（FK CASCADE 兜底，仍显式计数）
    {
      const info = db.prepare(`DELETE FROM agent_messages WHERE session_id IN (${idsPlaceholders})`).run(...targetIds)
      counts.messages = Number(info.changes)
    }
    // 2d/2e. session 资源节点与边
    const resourceIds = (
      db
        .prepare(`SELECT id FROM resources WHERE resource_type = 'session' AND ref_id IN (${idsPlaceholders})`)
        .all(...targetIds) as Array<{ id: number }>
    ).map((r) => r.id)
    if (resourceIds.length > 0) {
      const resPh = resourceIds.map(() => '?').join(', ')
      counts.relationships += Number(db.prepare(`DELETE FROM relationships WHERE source_resource_id IN (${resPh})`).run(...resourceIds).changes)
      counts.relationships += Number(db.prepare(`DELETE FROM relationships WHERE target_resource_id IN (${resPh})`).run(...resourceIds).changes)
      counts.resources = Number(
        db.prepare(`DELETE FROM resources WHERE resource_type = 'session' AND id IN (${resPh})`).run(...resourceIds).changes,
      )
    }
    // 2f. 会话行本体（子会话连带）
    {
      const info = db.prepare(`DELETE FROM agent_sessions WHERE id IN (${idsPlaceholders})`).run(...targetIds)
      counts.sessions = Number(info.changes)
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw new ServiceError('DB_ERROR', `session delete failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 审计（零凭据/零路径；counts 为纯行数）
  recordSecurityAudit(
    'session',
    'session_deleted',
    null,
    'success',
    JSON.stringify({ sessionId: row.id, providerId: row.provider_id, nativeId: row.native_id, cascade: counts }),
  )
  return { sessionId: row.id, deleted: true, removed: counts }
}
