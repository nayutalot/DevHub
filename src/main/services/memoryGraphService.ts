/**
 * memoryGraphService.ts — 记忆域知识图谱存储层（MEM 批次，docs/briefs/mem-mcp.md）。
 *
 * - 语义权威 = 官方 @modelcontextprotocol/server-memory dist/index.js（本机只读参考，
 *   零触碰）：九操作逐一对齐——create 幂等跳过已存在 / observations 去重 /
 *   relations 三元组去重 / delete 级联 / search 实体名+类型+观察内容子串匹配返回
 *   匹配邻域 / read_graph 全量 / open_nodes 精确点名。
 * - 存储替代原型的 JSONL 文件全量重写：SQLite 三表（009_memory_graph.sql）+
 *   prepared statements + WAL 事务（BEGIN IMMEDIATE … COMMIT/ROLLBACK）。
 * - electron-free 纯 Node 模块（db 经 getDatabase() 单例，DEVHUB_HOME 驱动），
 *   smoke 可在系统 Node 下直测；SQL 全参数绑定（约束 #11）；结构化 ServiceError
 *   （约束 #14）；只有 Service 层写库（约束 #20）。
 * - 与原型的一处显式偏差（任务书 schema 裁决）：memory_relations.from_name 对
 *   entities 有 FK（ON DELETE CASCADE），指向不存在实体的 from 侧关系以 NOT_FOUND
 *   拒绝（对应原型 add_observations 对缺失实体的 throw 风格）；to_name 无 FK——
 *   原型允许关系指向未建实体，语义保真。
 */

import { readFileSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { getDatabase } from '../db/index.ts'
import { logger } from '../core/logger.ts'
import { nowSec, ServiceError } from './internal.ts'

// ---------------------------------------------------------------------------
// 领域类型（与原型 loadGraph 的图形状逐字段同名：name/entityType/observations、
// from/to/relationType；DB 列为 snake_case，行投影处映射）
// ---------------------------------------------------------------------------

export interface MemoryEntityInput {
  name: string
  entityType: string
  observations: readonly string[]
}

export interface MemoryRelationInput {
  from: string
  to: string
  relationType: string
}

export interface MemoryObservationInput {
  entityName: string
  contents: readonly string[]
}

export interface MemoryEntity {
  name: string
  entityType: string
  observations: string[]
}

export interface MemoryRelation {
  from: string
  to: string
  relationType: string
}

export interface MemoryGraph {
  entities: MemoryEntity[]
  relations: MemoryRelation[]
}

export interface MemoryObservationResult {
  entityName: string
  addedObservations: string[]
}

export interface MemoryImportResult {
  file: string
  totalLines: number
  entityLines: number
  relationLines: number
  entitiesCreated: number
  relationsCreated: number
}

interface EntityRow {
  name: string
  entity_type: string
}

interface ObservationRow {
  entity_name: string
  content: string
}

interface RelationRow {
  from_name: string
  to_name: string
  relation_type: string
}

// ---------------------------------------------------------------------------
// 内部助手
// ---------------------------------------------------------------------------

/** 写事务模板：BEGIN IMMEDIATE → body → COMMIT；异常 ROLLBACK 后原样上抛。 */
function withWriteTransaction<T>(db: DatabaseSync, body: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = body()
    db.exec('COMMIT')
    return result
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

/** 全量实体投影（含各自观察；与原型 readGraph 的 entities 形状一致）。 */
function loadAllEntities(db: DatabaseSync): MemoryEntity[] {
  const entityRows = db
    .prepare('SELECT name, entity_type FROM memory_entities ORDER BY created_at, name')
    .all() as unknown as EntityRow[]
  const observationRows = db
    .prepare('SELECT entity_name, content FROM memory_observations ORDER BY created_at, content')
    .all() as unknown as ObservationRow[]
  const byEntity = new Map<string, string[]>()
  for (const row of observationRows) {
    const list = byEntity.get(row.entity_name)
    if (list === undefined) byEntity.set(row.entity_name, [row.content])
    else list.push(row.content)
  }
  return entityRows.map((row) => ({
    name: row.name,
    entityType: row.entity_type,
    observations: byEntity.get(row.name) ?? [],
  }))
}

/** 全量关系投影（与原型 readGraph 的 relations 形状一致）。 */
function loadAllRelations(db: DatabaseSync): MemoryRelation[] {
  const rows = db
    .prepare('SELECT from_name, to_name, relation_type FROM memory_relations ORDER BY created_at, from_name, to_name, relation_type')
    .all() as unknown as RelationRow[]
  return rows.map((row) => ({ from: row.from_name, to: row.to_name, relationType: row.relation_type }))
}

/**
 * 原型 searchNodes 的匹配判定，逐表达式对齐（dist/index.js L177-179）：
 * 实体名 / 实体类型 / 任一观察内容 的大小写不敏感子串匹配
 * （JS 侧 toLowerCase：SQLite lower() 仅 ASCII 折叠，原型语义按 Unicode 折叠）。
 */
function matchesQuery(entity: MemoryEntity, needle: string): boolean {
  const query = needle.toLowerCase()
  return (
    entity.name.toLowerCase().includes(query) ||
    entity.entityType.toLowerCase().includes(query) ||
    entity.observations.some((o) => o.toLowerCase().includes(query))
  )
}

/**
 * 邻域闭合（原型 searchNodes/openNodes 同款，dist/index.js L184/L201）：
 * 保留至少一个端点落在给定实体名集合内的关系——让调用方能发现与结果集相连、
 * 本身不在结果集内的节点。
 */
function neighborhood(relations: readonly MemoryRelation[], names: ReadonlySet<string>): MemoryRelation[] {
  return relations.filter((r) => names.has(r.from) || names.has(r.to))
}

// ---------------------------------------------------------------------------
// 九操作（顺序与原型 dist/index.js 的方法顺序一致）
// ---------------------------------------------------------------------------

/**
 * createEntities（原型 L117-123）：按 name 判重，已存在实体整条跳过
 * （含其 observations——原型 push 的是过滤后的完整新实体），返回实际新建的实体。
 */
export function createMemoryEntities(inputs: readonly MemoryEntityInput[]): MemoryEntity[] {
  const db = getDatabase()
  const now = nowSec()
  return withWriteTransaction(db, () => {
    const exists = db.prepare('SELECT 1 FROM memory_entities WHERE name = ?')
    const insertEntity = db.prepare('INSERT INTO memory_entities (name, entity_type, created_at) VALUES (?, ?, ?)')
    const insertObservation = db.prepare(
      'INSERT OR IGNORE INTO memory_observations (entity_name, content, created_at) VALUES (?, ?, ?)',
    )
    const created: MemoryEntity[] = []
    for (const input of inputs) {
      if (exists.get(input.name) !== undefined) continue
      insertEntity.run(input.name, input.entityType, now)
      for (const content of input.observations) {
        insertObservation.run(input.name, content, now)
      }
      created.push({ name: input.name, entityType: input.entityType, observations: [...input.observations] })
    }
    return created
  })
}

/**
 * createRelations（原型 L125-131）：按 (from,to,relationType) 三元组判重跳过，
 * 返回实际新建的关系。原型不做存在性校验；本表 from_name 有 FK（任务书 schema
 * 裁决，见文件头），from 缺失 → NOT_FOUND（对应原型 add_observations 的
 * "Entity with name X not found" 抛错风格）；to 允许指向未建实体。
 */
export function createMemoryRelations(inputs: readonly MemoryRelationInput[]): MemoryRelation[] {
  const db = getDatabase()
  const now = nowSec()
  return withWriteTransaction(db, () => {
    const entityExists = db.prepare('SELECT 1 FROM memory_entities WHERE name = ?')
    const relationExists = db.prepare(
      'SELECT 1 FROM memory_relations WHERE from_name = ? AND to_name = ? AND relation_type = ?',
    )
    const insert = db.prepare(
      'INSERT OR IGNORE INTO memory_relations (from_name, to_name, relation_type, created_at) VALUES (?, ?, ?, ?)',
    )
    const created: MemoryRelation[] = []
    for (const input of inputs) {
      if (entityExists.get(input.from) === undefined) {
        throw new ServiceError('NOT_FOUND', `Entity with name ${input.from} not found`)
      }
      if (relationExists.get(input.from, input.to, input.relationType) !== undefined) continue
      insert.run(input.from, input.to, input.relationType, now)
      created.push({ from: input.from, to: input.to, relationType: input.relationType })
    }
    return created
  })
}

/**
 * addObservations（原型 L133-146）：实体缺失 → NOT_FOUND（消息逐字对齐原型）；
 * contents 与既有观察判重，只追加新内容；按入参顺序逐条返回各实体的实际新增。
 */
export function addMemoryObservations(inputs: readonly MemoryObservationInput[]): MemoryObservationResult[] {
  const db = getDatabase()
  const now = nowSec()
  return withWriteTransaction(db, () => {
    const entityExists = db.prepare('SELECT 1 FROM memory_entities WHERE name = ?')
    const observationExists = db.prepare('SELECT 1 FROM memory_observations WHERE entity_name = ? AND content = ?')
    const insert = db.prepare('INSERT OR IGNORE INTO memory_observations (entity_name, content, created_at) VALUES (?, ?, ?)')
    const results: MemoryObservationResult[] = []
    for (const input of inputs) {
      if (entityExists.get(input.entityName) === undefined) {
        throw new ServiceError('NOT_FOUND', `Entity with name ${input.entityName} not found`)
      }
      const added: string[] = []
      for (const content of input.contents) {
        if (observationExists.get(input.entityName, content) !== undefined) continue
        insert.run(input.entityName, content, now)
        added.push(content)
      }
      results.push({ entityName: input.entityName, addedObservations: added })
    }
    return results
  })
}

/**
 * deleteEntities（原型 L147-152）：删实体本身 + 两侧关系（from 侧由 FK 级联、
 * to 侧显式 DELETE；观察随实体 FK 级联）。缺失的名字静默跳过（原型 filter 语义）。
 */
export function deleteMemoryEntities(names: readonly string[]): { deleted: number; relationsRemoved: number } {
  const db = getDatabase()
  return withWriteTransaction(db, () => {
    const deleteToSide = db.prepare('DELETE FROM memory_relations WHERE to_name = ?')
    const deleteEntity = db.prepare('DELETE FROM memory_entities WHERE name = ?')
    let deleted = 0
    let relationsRemoved = 0
    for (const name of names) {
      relationsRemoved += Number(deleteToSide.run(name).changes)
      deleted += Number(deleteEntity.run(name).changes)
    }
    return { deleted, relationsRemoved }
  })
}

/**
 * deleteObservations（原型 L154-162）：实体缺失静默跳过（原型 if (entity) 语义）；
 * 只删给定的观察内容。返回实际移除的行数。
 */
export function deleteMemoryObservations(
  deletions: readonly { entityName: string; observations: readonly string[] }[],
): { removed: number } {
  const db = getDatabase()
  return withWriteTransaction(db, () => {
    const remove = db.prepare('DELETE FROM memory_observations WHERE entity_name = ? AND content = ?')
    let removed = 0
    for (const deletion of deletions) {
      for (const content of deletion.observations) {
        removed += Number(remove.run(deletion.entityName, content).changes)
      }
    }
    return { removed }
  })
}

/**
 * deleteRelations（原型 L164-169）：按 (from,to,relationType) 三元组精确删除；
 * 不存在的关系静默跳过（原型 filter 语义）。返回实际移除的行数。
 */
export function deleteMemoryRelations(relations: readonly MemoryRelationInput[]): { removed: number } {
  const db = getDatabase()
  return withWriteTransaction(db, () => {
    const remove = db.prepare('DELETE FROM memory_relations WHERE from_name = ? AND to_name = ? AND relation_type = ?')
    let removed = 0
    for (const relation of relations) {
      removed += Number(remove.run(relation.from, relation.to, relation.relationType).changes)
    }
    return { removed }
  })
}

/** readGraph（原型 L170-172）：全量 {entities, relations}。 */
export function readMemoryGraph(): MemoryGraph {
  const db = getDatabase()
  return { entities: loadAllEntities(db), relations: loadAllRelations(db) }
}

/**
 * searchNodes（原型 L174-190）：实体名/类型/观察内容的 case-insensitive 子串
 * 匹配筛实体，再对命中集合做关系邻域闭合（单端点命中即保留）。
 */
export function searchMemoryNodes(query: string): MemoryGraph {
  const db = getDatabase()
  const entities = loadAllEntities(db).filter((entity) => matchesQuery(entity, query))
  const names = new Set(entities.map((e) => e.name))
  return { entities, relations: neighborhood(loadAllRelations(db), names) }
}

/**
 * openNodes（原型 L192-207）：按名字精确点名（case-sensitive，SQL BINARY 比对
 * 与原型 includes 同语义）；命中集合做关系邻域闭合（单端点命中即保留——
 * 关系可指向未建实体，邻域可能带出图外节点，原型注释明示这是有意行为）。
 */
export function openMemoryNodes(names: readonly string[]): MemoryGraph {
  const db = getDatabase()
  const wanted = new Set(names)
  const entities = loadAllEntities(db).filter((entity) => wanted.has(entity.name))
  const matched = new Set(entities.map((e) => e.name))
  return { entities, relations: neighborhood(loadAllRelations(db), matched) }
}

// ---------------------------------------------------------------------------
// import_jsonl：一次性导入原型 server-memory 的 JSONL 记忆文件（本批完善点）
// ---------------------------------------------------------------------------

/** 原型 JSONL 行形状（dist/index.js loadGraph L56-73 只认这两类 type）。 */
interface JsonlEntityLine {
  type: 'entity'
  name: string
  entityType: string
  observations: string[]
}

interface JsonlRelationLine {
  type: 'relation'
  from: string
  to: string
  relationType: string
}

/** 导入内建 create 语义直接复用九操作（同事务内同库句柄，幂等与去重天然一致）。 */
export function importMemoryJsonl(filePath: string): MemoryImportResult {
  const raw = readFileSync(filePath, 'utf8')
  const lines = raw.split('\n').filter((line) => line.trim() !== '')

  const entities: MemoryEntityInput[] = []
  const relations: MemoryRelationInput[] = []
  lines.forEach((line, index) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (err) {
      throw new ServiceError(
        'BAD_PAYLOAD',
        `line ${index + 1}: not valid JSON (${err instanceof Error ? err.message : String(err)})`,
      )
    }
    const item = parsed as { type?: unknown }
    if (item.type === 'entity') {
      const e = parsed as Partial<JsonlEntityLine>
      if (typeof e.name !== 'string' || typeof e.entityType !== 'string' || !Array.isArray(e.observations)) {
        throw new ServiceError('BAD_PAYLOAD', `line ${index + 1}: entity line requires name, entityType, observations`)
      }
      entities.push({ name: e.name, entityType: e.entityType, observations: e.observations.filter((o): o is string => typeof o === 'string') })
      return
    }
    if (item.type === 'relation') {
      const r = parsed as Partial<JsonlRelationLine>
      if (typeof r.from !== 'string' || typeof r.to !== 'string' || typeof r.relationType !== 'string') {
        throw new ServiceError('BAD_PAYLOAD', `line ${index + 1}: relation line requires from, to, relationType`)
      }
      relations.push({ from: r.from, to: r.to, relationType: r.relationType })
      return
    }
    throw new ServiceError('BAD_PAYLOAD', `line ${index + 1}: unknown item type (expected "entity" or "relation")`)
  })

  const db = getDatabase()
  const result = withWriteTransaction(db, () => {
    const entityExists = db.prepare('SELECT 1 FROM memory_entities WHERE name = ?')
    const insertEntity = db.prepare('INSERT INTO memory_entities (name, entity_type, created_at) VALUES (?, ?, ?)')
    const insertObservation = db.prepare(
      'INSERT OR IGNORE INTO memory_observations (entity_name, content, created_at) VALUES (?, ?, ?)',
    )
    const now = nowSec()
    let entitiesCreated = 0
    // 两遍导入：实体先行，关系后行——原型文件中 relation 行可出现在其实体行之前
    // （逐行 append 的历史顺序不保证 entity→relation），先建实体再建关系与
    // create 语义等价且满足 from 侧 FK。
    for (const entity of entities) {
      if (entityExists.get(entity.name) !== undefined) continue
      insertEntity.run(entity.name, entity.entityType, now)
      for (const content of entity.observations) {
        insertObservation.run(entity.name, content, now)
      }
      entitiesCreated += 1
    }
    const relationExists = db.prepare(
      'SELECT 1 FROM memory_relations WHERE from_name = ? AND to_name = ? AND relation_type = ?',
    )
    const insertRelation = db.prepare(
      'INSERT OR IGNORE INTO memory_relations (from_name, to_name, relation_type, created_at) VALUES (?, ?, ?, ?)',
    )
    let relationsCreated = 0
    for (const relation of relations) {
      if (entityExists.get(relation.from) === undefined) {
        throw new ServiceError('NOT_FOUND', `Entity with name ${relation.from} not found`)
      }
      if (relationExists.get(relation.from, relation.to, relation.relationType) !== undefined) continue
      insertRelation.run(relation.from, relation.to, relation.relationType, now)
      relationsCreated += 1
    }
    return { entitiesCreated, relationsCreated }
  })

  const summary: MemoryImportResult = {
    file: filePath,
    totalLines: lines.length,
    entityLines: entities.length,
    relationLines: relations.length,
    ...result,
  }
  logger.info(
    `memory import: ${filePath} → ${summary.entitiesCreated} entities + ${summary.relationsCreated} relations created (${summary.totalLines} lines)`,
  )
  return summary
}
