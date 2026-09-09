/**
 * resourceGraph.ts — resources / relationships 写入助手（docs/05，约束 #20/#22）。
 *
 * 落实 docs/05 的建边规则：具体表写入后由 Service 层同步登记资源节点
 * （UNIQUE(resource_type, ref_id) 冲突时更新 display_name）并按需建有向边
 * （同一 source/target/relation_type 幂等）。所有 SQL 参数绑定（约束 #11）。
 */

import type { DatabaseSync } from 'node:sqlite'
import { nowSec } from './internal.ts'

/**
 * AC2 批次扩值（docs/13 §5，表结构零改动：resources/relationships 列本就是 TEXT +
 * 注释枚举）：'agent' | 'session' | 'device' 资源节点与 'monitors' | 'exposes' |
 * 'controls' 关系边。本批只扩类型；具体登记函数（L3 写 agent 域新表与
 * remote_devices 表后同步建节点/建边）在 AC3 接线（约束 #20/#22）。语义：
 *   monitors  = agent → session（managed/attached 主动监控）
 *   exposes   = agent → session（observed 被动发现）
 *   controls  = device → session（首条 executed 指令时建边，docs/15 §5）
 */
export type ResourceType =
  | 'project'
  | 'repository'
  | 'environment'
  | 'service'
  | 'container'
  | 'agent'
  | 'session'
  | 'device'
  | 'contest' // CP1 批次（ContestPin，docs/22 §2.3）：比赛资源节点，关联 Project 复用 'uses' 边（source=contest, target=project）
export type RelationType = 'uses' | 'contains' | 'depends_on' | 'located_in' | 'monitors' | 'exposes' | 'controls'

interface ResourceIdRow {
  id: number
}

interface ResourceNameRow {
  id: number
  display_name: string
}

/**
 * 登记资源节点：已存在（UNIQUE(resource_type, ref_id) 冲突）时更新 display_name
 * 并返回既有 id；否则插入并返回新 id。
 */
export function registerResource(
  db: DatabaseSync,
  resourceType: ResourceType,
  refId: number,
  displayName: string,
): number {
  const existing = db
    .prepare('SELECT id, display_name FROM resources WHERE resource_type = ? AND ref_id = ?')
    .get(resourceType, refId) as ResourceNameRow | undefined
  if (existing !== undefined) {
    if (existing.display_name !== displayName) {
      db.prepare('UPDATE resources SET display_name = ?, updated_at = ? WHERE id = ?').run(
        displayName,
        nowSec(),
        existing.id,
      )
    }
    return existing.id
  }
  const result = db
    .prepare('INSERT INTO resources (resource_type, ref_id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(resourceType, refId, displayName, nowSec(), nowSec())
  return Number(result.lastInsertRowid)
}

/** 查询资源节点 id；未登记 → null。 */
export function findResourceId(db: DatabaseSync, resourceType: ResourceType, refId: number): number | null {
  const row = db
    .prepare('SELECT id FROM resources WHERE resource_type = ? AND ref_id = ?')
    .get(resourceType, refId) as ResourceIdRow | undefined
  return row !== undefined ? row.id : null
}

/**
 * 建有向边 source → target（relation_type）。同一 (source, target, relation_type)
 * 已存在时幂等忽略（INSERT OR IGNORE + UNIQUE 约束，docs/05 §1）。
 */
export function relate(db: DatabaseSync, sourceResourceId: number, targetResourceId: number, relationType: RelationType): void {
  if (sourceResourceId === targetResourceId) return
  db.prepare(
    'INSERT OR IGNORE INTO relationships (source_resource_id, target_resource_id, relation_type, created_at) VALUES (?, ?, ?, ?)',
  ).run(sourceResourceId, targetResourceId, relationType, nowSec())
}

/** 删除资源节点；关系边经 FK ON DELETE CASCADE 一并清理（docs/05 §2 删除语义）。 */
export function deleteResource(db: DatabaseSync, resourceType: ResourceType, refId: number): void {
  db.prepare('DELETE FROM resources WHERE resource_type = ? AND ref_id = ?').run(resourceType, refId)
}

/**
 * docs/05 §3 规则 2：项目有 win_path → `project located_in environment('windows')`。
 * environments 表尚无 windows 行（未跑过 environment:detect）时静默跳过，
 * 不凭空登记环境资源（资源节点必须锚定具体表行）。
 */
export function relateProjectLocatedInWindows(db: DatabaseSync, projectResourceId: number): void {
  const winEnv = db.prepare("SELECT id FROM environments WHERE name = 'windows'").get() as
    | ResourceIdRow
    | undefined
  if (winEnv === undefined) return
  relate(db, projectResourceId, registerResource(db, 'environment', winEnv.id, 'windows'), 'located_in')
}
