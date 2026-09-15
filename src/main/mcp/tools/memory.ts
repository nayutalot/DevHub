/**
 * tools/memory.ts — 记忆域知识图谱 MCP 工具面（MEM 批次，docs/briefs/mem-mcp.md）。
 *
 * 10 个工具，命名对齐 `devhub.<域>.<动作>`；动作名与原型
 * @modelcontextprotocol/server-memory 的九工具逐一同名（snake_case 保真），
 * 外加本批完善点 import_jsonl（一次性导入原型 JSONL 记忆文件）：
 *   读三类 READ_ONLY：read_graph / search_nodes / open_nodes
 *   写六类+导入 SAFE ：create_entities / create_relations / add_observations /
 *                      delete_entities / delete_observations / delete_relations /
 *                      import_jsonl
 *   （docs/08 §9 Phase B 首批启用——域特定结构化写入，非 §9.4 红线的万能执行
 *     接口；权限分类见 permissions.ts）
 *
 * - zod 入参形状与原型逐字段对齐（entities[{name,entityType,observations[]}] /
 *   relations[{from,to,relationType}] / observations[{entityName,contents[]}] /
 *   deletions[{entityName,observations[]}] / query / names / entityNames /
 *   import 的 path）；strict 拒绝未知键（docs/08 §10.1）。
 * - import_jsonl 的 JSONL 路径由调用参数显式给出，DevHub 零硬编码用户路径；
 *   工具只读该文件、逐行解析、逐条走 create 语义入库，绝不写回原文件。
 * - 九操作语义权威 = services/memoryGraphService.ts（原型 dist/index.js 逐一对齐）。
 */

import { z } from 'zod'
import {
  addMemoryObservations,
  createMemoryEntities,
  createMemoryRelations,
  deleteMemoryEntities,
  deleteMemoryObservations,
  deleteMemoryRelations,
  importMemoryJsonl,
  openMemoryNodes,
  readMemoryGraph,
  searchMemoryNodes,
} from '../../services/memoryGraphService.ts'
import { defineNoArgTool, defineTool } from '../toolkit.ts'
import type { ToolDefinition } from '../toolkit.ts'

/** 原型 EntitySchema 形状：{ name, entityType, observations[] }。 */
const entityInput = z.object({
  name: z.string().describe('The name of the entity'),
  entityType: z.string().describe('The type of the entity'),
  observations: z.array(z.string()).describe('An array of observation contents associated with the entity'),
})

/** 原型 RelationSchema 形状：{ from, to, relationType }（主动语态）。 */
const relationInput = z.object({
  from: z.string().describe('The name of the entity where the relation starts'),
  to: z.string().describe('The name of the entity where the relation ends'),
  relationType: z.string().describe('The type of the relation'),
})

/** 图投影共用摘要：实体带观察行数，关系带三元组。 */
function graphSummary(entities: { name: string; observations: string[] }[], relations: { from: string; to: string; relationType: string }[]): string {
  if (entities.length === 0 && relations.length === 0) return 'Knowledge graph is empty (no entities, no relations).'
  const entityLines = entities.map((e) => `- ${e.name} (${e.observations.length} observation(s))`)
  const relationLines = relations.map((r) => `- ${r.from} —[${r.relationType}]→ ${r.to}`)
  return [
    `${entities.length} entit(y/ies), ${relations.length} relation(s).`,
    entityLines.length > 0 ? `Entities:\n${entityLines.join('\n')}` : '',
    relationLines.length > 0 ? `Relations:\n${relationLines.join('\n')}` : '',
  ]
    .filter((part) => part !== '')
    .join('\n')
}

const createEntities: ToolDefinition = defineTool(
  'devhub.memory.create_entities',
  'Create multiple new entities in the knowledge graph. Entities whose name already exists are skipped entirely (idempotent, observations included); returns only the newly created entities.',
  {
    entities: z.array(entityInput).describe('An array of entities to create'),
  },
  async (args) => {
    const created = createMemoryEntities(args.entities)
    return {
      data: { entities: created, createdCount: created.length },
      summary:
        created.length === 0
          ? `No new entities created (${args.entities.length} input(s) already existed).`
          : `Created ${created.length} entit(y/ies):\n${created.map((e) => `- ${e.name} (${e.entityType}, ${e.observations.length} observation(s))`).join('\n')}`,
    }
  },
)

const createRelations: ToolDefinition = defineTool(
  'devhub.memory.create_relations',
  'Create multiple new relations between entities in the knowledge graph. Relations should be in active voice. Exact (from, to, relationType) duplicates are skipped; the source entity ("from") must exist, the target ("to") may reference an entity that does not exist yet.',
  {
    relations: z.array(relationInput).describe('An array of relations to create'),
  },
  async (args) => {
    const created = createMemoryRelations(args.relations)
    return {
      data: { relations: created, createdCount: created.length },
      summary:
        created.length === 0
          ? `No new relations created (${args.relations.length} input(s) already existed).`
          : `Created ${created.length} relation(s):\n${created.map((r) => `- ${r.from} —[${r.relationType}]→ ${r.to}`).join('\n')}`,
    }
  },
)

const addObservations: ToolDefinition = defineTool(
  'devhub.memory.add_observations',
  'Add new observations to existing entities in the knowledge graph. Duplicate observation contents are skipped; every named entity must exist (missing entity is a structured NOT_FOUND error).',
  {
    observations: z
      .array(
        z.object({
          entityName: z.string().describe('The name of the entity to add the observations to'),
          contents: z.array(z.string()).describe('An array of observation contents to add'),
        }),
      )
      .describe('An array of observation additions, per entity'),
  },
  async (args) => {
    const results = addMemoryObservations(args.observations)
    const total = results.reduce((sum, r) => sum + r.addedObservations.length, 0)
    return {
      data: { results, addedCount: total },
      summary:
        total === 0
          ? 'No new observations added (all contents already present).'
          : `Added ${total} observation(s):\n${results.map((r) => `- ${r.entityName}: ${r.addedObservations.length} new`).join('\n')}`,
    }
  },
)

const deleteEntities: ToolDefinition = defineTool(
  'devhub.memory.delete_entities',
  'Delete multiple entities and their associated observations and relations (both directions) from the knowledge graph. Names that do not exist are silently ignored (idempotent).',
  {
    entityNames: z.array(z.string()).describe('An array of entity names to delete'),
  },
  async (args) => {
    const result = deleteMemoryEntities(args.entityNames)
    return {
      data: { success: true, deletedEntities: result.deleted, relationsRemoved: result.relationsRemoved },
      summary:
        result.deleted === 0
          ? `No entities deleted (${args.entityNames.length} name(s) not found).`
          : `Deleted ${result.deleted} entit(y/ies) and ${result.relationsRemoved} dangling relation(s) pointing at them (observations cascaded).`,
    }
  },
)

const deleteObservations: ToolDefinition = defineTool(
  'devhub.memory.delete_observations',
  'Delete specific observations from entities in the knowledge graph. Missing entities or contents are silently ignored (idempotent).',
  {
    deletions: z
      .array(
        z.object({
          entityName: z.string().describe('The name of the entity containing the observations'),
          observations: z.array(z.string()).describe('An array of observations to delete'),
        }),
      )
      .describe('An array of observation deletions, per entity'),
  },
  async (args) => {
    const result = deleteMemoryObservations(args.deletions)
    return {
      data: { success: true, removed: result.removed },
      summary: `Deleted ${result.removed} observation(s).`,
    }
  },
)

const deleteRelations: ToolDefinition = defineTool(
  'devhub.memory.delete_relations',
  'Delete multiple relations from the knowledge graph by their exact (from, to, relationType) triple. Missing triples are silently ignored (idempotent).',
  {
    relations: z.array(relationInput).describe('An array of relations to delete'),
  },
  async (args) => {
    const result = deleteMemoryRelations(args.relations)
    return {
      data: { success: true, removed: result.removed },
      summary: `Deleted ${result.removed} relation(s).`,
    }
  },
)

const readGraph: ToolDefinition = defineNoArgTool(
  'devhub.memory.read_graph',
  'Read the entire knowledge graph: all entities (with their observations) and all relations.',
  async () => {
    const graph = readMemoryGraph()
    return {
      data: { entities: graph.entities, relations: graph.relations, entityCount: graph.entities.length, relationCount: graph.relations.length },
      summary: graphSummary(graph.entities, graph.relations),
    }
  },
)

const searchNodes: ToolDefinition = defineTool(
  'devhub.memory.search_nodes',
  'Search for nodes in the knowledge graph based on a query. Case-insensitive substring match against entity names, entity types and observation contents; relations with at least one matched endpoint are included so connections to nodes outside the result set stay discoverable.',
  {
    query: z.string().describe('The search query to match against entity names, types, and observation content'),
  },
  async (args) => {
    const graph = searchMemoryNodes(args.query)
    return {
      data: { entities: graph.entities, relations: graph.relations, entityCount: graph.entities.length, relationCount: graph.relations.length },
      summary: `Search "${args.query}": ${graphSummary(graph.entities, graph.relations)}`,
    }
  },
)

const openNodes: ToolDefinition = defineTool(
  'devhub.memory.open_nodes',
  'Open specific nodes in the knowledge graph by their exact names, together with every relation that has at least one endpoint among them. Unknown names are silently ignored.',
  {
    names: z.array(z.string()).describe('An array of entity names to retrieve'),
  },
  async (args) => {
    const graph = openMemoryNodes(args.names)
    return {
      data: { entities: graph.entities, relations: graph.relations, entityCount: graph.entities.length, relationCount: graph.relations.length },
      summary: `Opened ${args.names.length} name(s): ${graphSummary(graph.entities, graph.relations)}`,
    }
  },
)

const importJsonl: ToolDefinition = defineTool(
  'devhub.memory.import_jsonl',
  'One-shot import of a prototype @modelcontextprotocol/server-memory JSONL memory file ({"type":"entity"...} / {"type":"relation"...} lines). The file path is provided by the caller (DevHub hard-codes no user paths); the file is read-only, lines are applied with create semantics (idempotent, dedup) in a single transaction, and import counts are returned. Malformed lines and relations whose source entity is unknown abort the import atomically.',
  {
    path: z.string().describe('Absolute path to the prototype memory JSONL file to import'),
  },
  async (args) => {
    const result = importMemoryJsonl(args.path)
    return {
      data: result,
      summary: `Imported ${result.file}: ${result.totalLines} line(s) → ${result.entitiesCreated}/${result.entityLines} entities created, ${result.relationsCreated}/${result.relationLines} relations created (duplicates skipped).`,
    }
  },
)

/** 10 个记忆域工具（注册顺序稳定 = tools/list 输出确定）。 */
export const memoryTools: ToolDefinition[] = [
  createEntities,
  createRelations,
  addObservations,
  deleteEntities,
  deleteObservations,
  deleteRelations,
  readGraph,
  searchNodes,
  openNodes,
  importJsonl,
]
