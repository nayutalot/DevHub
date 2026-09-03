/**
 * projectService.ts — 项目 CRUD / 打开 / 单项目重扫（docs/04 projects channels）。
 *
 * - remove 按显式清理 + FK 组合：resources 行（project/repository）显式删除
 *   （resources 无指向 projects 的 FK，relationships 对 resources CASCADE），
 *   projects 行删除触发 repositories CASCADE、services/containers.project_id SET NULL
 *   （docs/03 DDL 实际 FK 策略）；
 * - open 类全部经 exec.launchViaStartProcess（约束 #12），成功后 UPDATE last_opened_at；
 * - rescan(id) 单项目重跑 git + docker 关联；缺省 id 走 scanService.startScan 全量。
 */

import { existsSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { launchViaStartProcess } from '../core/exec.ts'
import type { LaunchKind } from '../core/exec.ts'
import { detectProjectMarkers } from '../adapters/fs.ts'
import { dockerInfo, listContainers } from '../adapters/docker.ts'
import { wslPathForWinPath } from '../adapters/wsl.ts'
import { getDatabase } from '../db/index.ts'
import type {
  ContainerPortMapping,
  ContainerRecord,
  EnvironmentWithTools,
  NotAvailablePlaceholder,
  ProjectDetail,
  ProjectRelationshipEdge,
  ProjectsAddPayload,
  ProjectsUpdatePayload,
  ProjectSummary,
  Repository,
  ScanStatusType,
  ServiceRow,
} from '../../shared/types.ts'
import { dbVal, errorMessage, finishScanRow, insertScanRow, nowSec, ServiceError, slugify, uniqueSlug } from './internal.ts'
import { deleteResource, registerResource, relate, relateProjectLocatedInWindows } from './resourceGraph.ts'
import { probeAndUpsertRepository, matchProjectForContainer, startScan, upsertContainer } from './scanService.ts'
import { loadEnvironmentWithTools } from './environmentService.ts'
import { listServices } from './servicesService.ts'

interface ProjectDbRow {
  id: number
  name: string
  slug: string
  description: string | null
  win_path: string | null
  wsl_path: string | null
  runtime_hint: string | null
  last_opened_at: number | null
  created_at: number
  updated_at: number
}

interface ProjectRowWithRepoStats extends ProjectDbRow {
  repo_count: number
  dirty_count: number
}

// ---------------------------------------------------------------------------
// 内部查询
// ---------------------------------------------------------------------------

function getProjectRow(db: DatabaseSync, id: number): ProjectDbRow {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectDbRow | undefined
  if (row === undefined) {
    throw new ServiceError('NOT_FOUND', `project ${id} not found`)
  }
  return row
}

function toSummary(row: ProjectRowWithRepoStats): ProjectSummary {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    winPath: row.win_path ?? undefined,
    wslPath: row.wsl_path ?? undefined,
    runtimeHint: row.runtime_hint ?? undefined,
    lastOpenedAt: row.last_opened_at ?? undefined,
    updatedAt: row.updated_at,
    hasGit: Number(row.repo_count) > 0,
    dirtyCount: Number(row.dirty_count),
  }
}

// 全静态语句字面量（约束 #11：SQL 文本零拼接/零插值，全部取值走 ? 绑定）
const LIST_PROJECTS_SQL =
  'SELECT p.*, COUNT(r.id) AS repo_count, COALESCE(SUM(r.is_dirty), 0) AS dirty_count FROM projects p LEFT JOIN repositories r ON r.project_id = p.id GROUP BY p.id ORDER BY COALESCE(p.last_opened_at, p.updated_at) DESC, p.id DESC'
const GET_PROJECT_SUMMARY_SQL =
  'SELECT p.*, COUNT(r.id) AS repo_count, COALESCE(SUM(r.is_dirty), 0) AS dirty_count FROM projects p LEFT JOIN repositories r ON r.project_id = p.id WHERE p.id = ? GROUP BY p.id'

function getProjectSummaryById(db: DatabaseSync, id: number): ProjectSummary {
  const row = db.prepare(GET_PROJECT_SUMMARY_SQL).get(id) as ProjectRowWithRepoStats | undefined
  if (row === undefined) {
    throw new ServiceError('NOT_FOUND', `project ${id} not found`)
  }
  return toSummary(row)
}

// ---------------------------------------------------------------------------
// projects:list / projects:get
// ---------------------------------------------------------------------------

export function listProjects(): ProjectSummary[] {
  const db = getDatabase()
  const rows = db.prepare(LIST_PROJECTS_SQL).all() as unknown as ProjectRowWithRepoStats[]
  return rows.map(toSummary)
}

// ---------------------------------------------------------------------------
// M2（docs/08 §4 缺口 4、§6.3）：projects.list 的 MCP 增强投影
// ---------------------------------------------------------------------------

/** git 摘要（repositories 联查；无仓库时 hasGit:false，其余字段缺省）。 */
export interface McpProjectGitSummary {
  hasGit: boolean
  branch?: string
  ahead?: number
  behind?: number
  dirtyCount: number
  /** repositories.last_status_at（最近一次 git 探测，docs/08 §6.3 的 lastScanAt 口径）。 */
  lastScanAt?: number
}

/**
 * projects.list 的 MCP 增强投影行（docs/08 §6.3 字段表）。
 * 类型定义在本 Service（而非 shared/types）：MCP 专属输出形态不进 IPC contract，
 * runtime 依赖单向（mcp → service），mcp 侧仅 `import type` 引用。
 */
export interface McpProjectSummary {
  id: number
  name: string
  slug: string
  winPath?: string
  wslPath?: string
  runtimeHint?: string
  /** docs/05 `project located_in environment` 边反查（无环境边时 null）。 */
  environment: { id: number; name: string } | null
  git: McpProjectGitSummary
  /** containers 按 project_id 联查计数。 */
  docker: { containersTotal: number; containersRunning: number }
  lastOpenedAt?: number
  updatedAt: number
}

// 全静态语句字面量（约束 #11：SQL 文本零拼接/零插值，全部取值走 ? 绑定）
const MCP_REPOS_SQL =
  'SELECT project_id, branch, ahead, behind, is_dirty, last_status_at FROM repositories ORDER BY project_id, id'
const MCP_CONTAINERS_SQL = 'SELECT project_id, state FROM containers WHERE project_id IS NOT NULL'
const MCP_ENV_EDGES_SQL = `
  SELECT rs.ref_id AS project_id, rt.ref_id AS env_id, rt.display_name AS env_name
  FROM relationships rel
  JOIN resources rs ON rs.id = rel.source_resource_id
  JOIN resources rt ON rt.id = rel.target_resource_id
  WHERE rs.resource_type = 'project' AND rt.resource_type = 'environment' AND rel.relation_type = 'located_in'
  ORDER BY rs.ref_id, env_id`

/**
 * MCP projects.list 增强投影：基线 = listProjects()，联查 repositories /
 * containers / located_in 边补齐 git 摘要、docker 计数与环境标识。
 * 单项目任一增强字段缺失（无仓库/无容器/无边）→ 空值或缺省，不阻塞整表返回。
 */
export function listMcpSummaries(): McpProjectSummary[] {
  const db = getDatabase()
  const base = listProjects()

  const reposByProject = new Map<number, { branch: string | null; ahead: number; behind: number; dirty: number; lastScanAt: number | null }>()
  const repoRows = db.prepare(MCP_REPOS_SQL).all() as unknown as {
    project_id: number
    branch: string | null
    ahead: number
    behind: number
    is_dirty: number
    last_status_at: number | null
  }[]
  for (const r of repoRows) {
    const agg = reposByProject.get(r.project_id)
    if (agg === undefined) {
      reposByProject.set(r.project_id, {
        branch: r.branch,
        ahead: r.ahead,
        behind: r.behind,
        dirty: r.is_dirty === 1 ? 1 : 0,
        lastScanAt: r.last_status_at,
      })
    } else {
      // 多仓库项目：dirty 计数累加，branch/ahead/behind 取首条（id 序）
      agg.dirty += r.is_dirty === 1 ? 1 : 0
    }
  }

  const dockerByProject = new Map<number, { total: number; running: number }>()
  const containerRows = db.prepare(MCP_CONTAINERS_SQL).all() as unknown as { project_id: number | null; state: string | null }[]
  for (const c of containerRows) {
    if (c.project_id === null) continue
    const agg = dockerByProject.get(c.project_id) ?? { total: 0, running: 0 }
    agg.total += 1
    if (c.state === 'running') agg.running += 1
    dockerByProject.set(c.project_id, agg)
  }

  const envByProject = new Map<number, { id: number; name: string }>()
  const edgeRows = db.prepare(MCP_ENV_EDGES_SQL).all() as unknown as { project_id: number; env_id: number; env_name: string }[]
  for (const e of edgeRows) {
    if (!envByProject.has(e.project_id)) {
      envByProject.set(e.project_id, { id: e.env_id, name: e.env_name })
    }
  }

  return base.map((p) => {
    const repo = reposByProject.get(p.id)
    const dockerCounts = dockerByProject.get(p.id) ?? { total: 0, running: 0 }
    return {
      id: p.id,
      name: p.name,
      slug: p.slug,
      winPath: p.winPath,
      wslPath: p.wslPath,
      runtimeHint: p.runtimeHint,
      environment: envByProject.get(p.id) ?? null,
      git: {
        hasGit: repo !== undefined,
        branch: repo?.branch ?? undefined,
        ahead: repo?.ahead,
        behind: repo?.behind,
        dirtyCount: repo?.dirty ?? 0,
        lastScanAt: repo?.lastScanAt ?? undefined,
      },
      docker: { containersTotal: dockerCounts.total, containersRunning: dockerCounts.running },
      lastOpenedAt: p.lastOpenedAt,
      updatedAt: p.updatedAt ?? 0,
    }
  })
}

function toRepository(row: {
  id: number
  project_id: number
  remote_url: string | null
  branch: string | null
  head_sha: string | null
  is_dirty: number
  ahead: number
  behind: number
  last_status_at: number | null
  created_at: number
  updated_at: number
}): Repository {
  return {
    id: row.id,
    projectId: row.project_id,
    remoteUrl: row.remote_url ?? undefined,
    branch: row.branch ?? undefined,
    headSha: row.head_sha ?? undefined,
    isDirty: row.is_dirty === 1,
    ahead: row.ahead,
    behind: row.behind,
    lastStatusAt: row.last_status_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function parsePortsJson(raw: string | null): ContainerPortMapping[] {
  if (raw === null || raw.length === 0) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as ContainerPortMapping[]) : []
  } catch {
    return []
  }
}

/** docs/08 §6.4：三张 001 已建但无 service 实现的表（skills/mcp_servers/archives）统一占位。 */
const NOT_AVAILABLE: NotAvailablePlaceholder = { notAvailable: true, reason: 'TABLE_EXISTS_NO_SERVICE' }

/**
 * 项目详情：project + repositories + 关联 containers + 关联 services + located_in 环境
 * + relationships 资源关系边 + 三张已建表（skills/mcp_servers/archives）的显式占位
 * （docs/08 §6.4：不猜测、不返回空数组冒充实现）。
 */
export function getProject(id: number): ProjectDetail {
  const db = getDatabase()
  const row = getProjectRow(db, id)

  const repositories = (db.prepare('SELECT * FROM repositories WHERE project_id = ? ORDER BY id').all(id) as Parameters<typeof toRepository>[0][]).map(
    toRepository,
  )

  const containerRows = db
    .prepare('SELECT * FROM containers WHERE project_id = ? ORDER BY id')
    .all(id) as {
    id: number
    docker_id: string
    name: string
    image: string | null
    state: string | null
    ports_json: string | null
    project_id: number | null
    created_at: number
    updated_at: number
  }[]
  const containers: ContainerRecord[] = containerRows.map((row) => ({
    id: row.id,
    dockerId: row.docker_id,
    name: row.name,
    image: row.image ?? undefined,
    state: row.state ?? undefined,
    ports: parsePortsJson(row.ports_json),
    projectId: row.project_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }))

  const services: ServiceRow[] = listServices({ projectId: id })
  const environments = listProjectEnvironments(db, id)
  const relationships = listProjectRelationships(db, id)

  return {
    ...toSummary({ ...row, repo_count: repositories.length, dirty_count: repositories.filter((r) => r.isDirty).length }),
    description: row.description ?? undefined,
    repositories,
    containers,
    services,
    environments,
    skills: NOT_AVAILABLE,
    mcpServers: NOT_AVAILABLE,
    archives: NOT_AVAILABLE,
    relationships,
  }
}

/**
 * 项目资源关系边列表（docs/05）：以 project 资源节点为一端的全部 relationships 行，
 * 联查对端 resources 投影为 { relation, direction, resourceType, refId, displayName }。
 */
function listProjectRelationships(db: DatabaseSync, projectId: number): ProjectRelationshipEdge[] {
  const projectResourceId = db
    .prepare("SELECT id FROM resources WHERE resource_type = 'project' AND ref_id = ?")
    .get(projectId) as { id: number } | undefined
  if (projectResourceId === undefined) return []

  const rows = db
    .prepare(
      `SELECT rel.relation_type, rel.source_resource_id,
              rs.resource_type AS source_type, rs.ref_id AS source_ref, rs.display_name AS source_name,
              rt.resource_type AS target_type, rt.ref_id AS target_ref, rt.display_name AS target_name
       FROM relationships rel
       JOIN resources rs ON rs.id = rel.source_resource_id
       JOIN resources rt ON rt.id = rel.target_resource_id
       WHERE rel.source_resource_id = ? OR rel.target_resource_id = ?
       ORDER BY rel.id`,
    )
    .all(projectResourceId.id, projectResourceId.id) as {
    relation_type: string
    source_resource_id: number
    source_type: string
    source_ref: number
    source_name: string
    target_type: string
    target_ref: number
    target_name: string
  }[]

  const edges: ProjectRelationshipEdge[] = []
  for (const r of rows) {
    if (r.relation_type !== 'uses' && r.relation_type !== 'contains' && r.relation_type !== 'depends_on' && r.relation_type !== 'located_in') {
      continue
    }
    if (r.source_resource_id === projectResourceId.id) {
      edges.push({ relation: r.relation_type, direction: 'outgoing', resourceType: r.target_type, refId: r.target_ref, displayName: r.target_name })
    } else {
      edges.push({ relation: r.relation_type, direction: 'incoming', resourceType: r.source_type, refId: r.source_ref, displayName: r.source_name })
    }
  }
  return edges
}

/** 经 resource graph 反查项目 located_in 的环境，并带出各自工具链。 */
function listProjectEnvironments(db: DatabaseSync, projectId: number): EnvironmentWithTools[] {
  const envRows = db
    .prepare(
      `SELECT e.id FROM environments e
       WHERE e.id IN (
         SELECT rt.ref_id FROM relationships rel
         JOIN resources rs ON rs.id = rel.source_resource_id
         JOIN resources rt ON rt.id = rel.target_resource_id
         WHERE rs.resource_type = 'project' AND rs.ref_id = ? AND rt.resource_type = 'environment'
       ) ORDER BY e.id`,
    )
    .all(projectId) as { id: number }[]
  return envRows.map((row) => loadEnvironmentWithTools(db, row.id))
}

// ---------------------------------------------------------------------------
// projects:add / projects:update / projects:remove
// ---------------------------------------------------------------------------

function assertDirectoryExists(path: string, label: string): void {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new ServiceError('NOT_FOUND', `${label} does not exist or is not a directory: ${path}`)
  }
}

export async function addProject(payload: ProjectsAddPayload): Promise<ProjectSummary> {
  const db = getDatabase()

  const winPath = payload.winPath?.trim() ?? ''
  if (winPath.length === 0) {
    throw new ServiceError('DB_ERROR', 'projects:add requires winPath')
  }
  assertDirectoryExists(winPath, 'winPath')

  const name = payload.name?.trim() ?? ''
  const resolvedName = name.length > 0 ? name : basename(winPath)
  const nameConflict = db.prepare('SELECT id FROM projects WHERE name = ?').get(resolvedName) as
    | { id: number }
    | undefined
  if (nameConflict !== undefined) {
    throw new ServiceError('DB_ERROR', `project name already exists: ${resolvedName}`)
  }

  const markers = detectProjectMarkers(winPath)
  const runtimeHint = payload.runtimeHint ?? markers?.runtimeHint
  const wslPath = payload.wslPath ?? wslPathForWinPath(winPath)
  const now = nowSec()

  const slug = uniqueSlug(db, slugify(resolvedName))
  const result = db
    .prepare(
      'INSERT INTO projects (name, slug, description, win_path, wsl_path, runtime_hint, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(resolvedName, slug, dbVal(payload.description), winPath, dbVal(wslPath), dbVal(runtimeHint), now, now)
  const projectId = Number(result.lastInsertRowid)

  // 探测 git 仓库标记 → repositories 行 + contains 边（best-effort，失败不回滚项目行）
  if (markers !== null && markers.markers.includes('.git')) {
    try {
      await probeAndUpsertRepository(db, projectId, resolvedName, winPath)
    } catch {
      // git 不可用/非仓库时静默跳过：项目行已落库，下次扫描/重扫会补齐
    }
  }
  // docs/05 规则 2：项目登记时按 win_path 补 `project located_in environment('windows')`（环境行存在才建）
  relateProjectLocatedInWindows(db, registerResource(db, 'project', projectId, resolvedName))

  return getProjectSummaryById(db, projectId)
}

export function updateProject(payload: ProjectsUpdatePayload): ProjectSummary {
  const db = getDatabase()
  const row = getProjectRow(db, payload.id)

  let name = row.name
  let slug = row.slug
  const incomingName = payload.name?.trim() ?? ''
  if (incomingName.length > 0 && incomingName !== row.name) {
    const conflict = db.prepare('SELECT id FROM projects WHERE name = ? AND id != ?').get(incomingName, row.id) as
      | { id: number }
      | undefined
    if (conflict !== undefined) {
      throw new ServiceError('DB_ERROR', `project name already exists: ${incomingName}`)
    }
    name = incomingName
    slug = uniqueSlug(db, slugify(name), row.id)
  }

  const description = payload.description !== undefined ? payload.description : row.description

  let winPath = row.win_path
  if (payload.winPath !== undefined) {
    const trimmed = payload.winPath.trim()
    if (trimmed.length === 0) {
      throw new ServiceError('DB_ERROR', 'winPath cannot be empty')
    }
    assertDirectoryExists(trimmed, 'winPath')
    winPath = trimmed
  }
  const wslPath = payload.wslPath !== undefined ? payload.wslPath : row.wsl_path
  if (winPath === null && wslPath === null) {
    throw new ServiceError('DB_ERROR', 'project must keep winPath or wslPath (docs/03 CHECK constraint)')
  }
  const runtimeHint = payload.runtimeHint !== undefined ? payload.runtimeHint : row.runtime_hint

  db.prepare(
    'UPDATE projects SET name = ?, slug = ?, description = ?, win_path = ?, wsl_path = ?, runtime_hint = ?, updated_at = ? WHERE id = ?',
  ).run(name, slug, dbVal(description), winPath, dbVal(wslPath), dbVal(runtimeHint), nowSec(), row.id)

  if (name !== row.name) {
    registerResource(db, 'project', row.id, name) // 同步资源节点 display_name
  }
  return getProjectSummaryById(db, row.id)
}

export function removeProject(id: number): { removed: boolean } {
  const db = getDatabase()
  getProjectRow(db, id) // NOT_FOUND guard

  // 孤儿关系边清理：显式删除 project / repository 资源节点，
  // 以其为端点的 relationships 行经 FK ON DELETE CASCADE 一并消失（docs/05 §2）
  const repoIds = (db.prepare('SELECT id FROM repositories WHERE project_id = ?').all(id) as { id: number }[]).map((r) => r.id)
  for (const repoId of repoIds) {
    deleteResource(db, 'repository', repoId)
  }
  deleteResource(db, 'project', id)

  // repositories 行 CASCADE；services / containers.project_id SET NULL（docs/03 DDL）
  db.prepare('DELETE FROM projects WHERE id = ?').run(id)
  return { removed: true }
}

// ---------------------------------------------------------------------------
// projects:rescan
// ---------------------------------------------------------------------------

/** 缺省 id → 全量重扫（scan:start 语义）；指定 id → 单项目 git + docker 关联重跑。 */
export async function rescanProjects(projectId?: number): Promise<{ scanId: number }> {
  if (projectId === undefined) {
    const status = await startScan('full')
    return { scanId: status.scanId }
  }

  const db = getDatabase()
  const row = getProjectRow(db, projectId)
  const scanId = insertScanRow(db, 'projects', row.win_path)
  const errors: string[] = []
  let finalStatus: ScanStatusType = 'done'
  try {
    await rescanSingleProject(db, row, errors)
  } catch (err) {
    finalStatus = 'failed'
    errors.push(errorMessage(err))
  }
  finishScanRow(db, scanId, finalStatus, 1, errors)
  return { scanId }
}

async function rescanSingleProject(db: DatabaseSync, row: ProjectDbRow, errors: string[]): Promise<void> {
  // 1) git 重探
  if (row.win_path !== null) {
    const markers = detectProjectMarkers(row.win_path)
    if (markers !== null && markers.markers.includes('.git')) {
      try {
        await probeAndUpsertRepository(db, row.id, row.name, row.win_path)
      } catch (err) {
        errors.push(`git ${row.name}: ${errorMessage(err)}`)
      }
    } else {
      // .git 已被移除：清理 repository 行与 contains 边
      const repoIds = (db.prepare('SELECT id FROM repositories WHERE project_id = ?').all(row.id) as { id: number }[]).map((r) => r.id)
      for (const repoId of repoIds) deleteResource(db, 'repository', repoId)
      db.prepare('DELETE FROM repositories WHERE project_id = ?').run(row.id)
    }
  }

  // 2) docker 关联重跑：先清空本项目关联，再按 label/前缀重挂
  const info = await dockerInfo()
  if (!info.daemonAvailable) {
    errors.push(`docker daemon unavailable: ${info.reason ?? 'unknown reason'}`)
    return
  }
  const containers = await listContainers()
  db.prepare('UPDATE containers SET project_id = NULL, updated_at = ? WHERE project_id = ?').run(nowSec(), row.id)
  db.prepare(
    "DELETE FROM relationships WHERE relation_type = 'uses' AND source_resource_id = ? AND target_resource_id IN (SELECT id FROM resources WHERE resource_type = 'container')",
  ).run(registerResource(db, 'project', row.id, row.name))

  const projectRef = [{ id: row.id, name: row.name }]
  for (const container of containers) {
    const match = matchProjectForContainer(container, projectRef)
    if (match === null) continue
    try {
      const containerId = upsertContainer(db, container, row.id)
      relate(db, registerResource(db, 'project', row.id, row.name), registerResource(db, 'container', containerId, container.name), 'uses')
    } catch (err) {
      errors.push(`container ${container.name}: ${errorMessage(err)}`)
    }
  }
}

// ---------------------------------------------------------------------------
// 打开类（projects:openFolder / openVSCode / openTerminal / openWSL）
// ---------------------------------------------------------------------------

/** /mnt/f/a/b → F:\a\b（openFolder 在缺 win_path 时反向换算）。 */
export function winPathFromWslPath(wslPath: string | null): string | null {
  if (wslPath === null) return null
  const m = wslPath.match(/^\/mnt\/([A-Za-z])\/(.*)$/)
  if (m === null) return null
  const rest = m[2].replace(/\/+$/, '')
  const drive = `${m[1].toUpperCase()}:\\`
  return rest.length > 0 ? `${drive}${rest.replace(/\//g, '\\')}` : drive
}

/**
 * 打开项目：folder/vscode/terminal 用 winPath（可经 { wsl:true } 强制走 wslPath），
 * wsl 用 wslPath（缺省由 winPath 推导）。成功打开后 UPDATE last_opened_at。
 */
export async function openProject(
  kind: LaunchKind,
  projectId: number,
  options?: { wsl?: boolean },
): Promise<{ opened: true }> {
  const db = getDatabase()
  const row = getProjectRow(db, projectId)

  let target: string | null
  if (kind === 'wsl' || options?.wsl === true) {
    target = row.wsl_path ?? wslPathForWinPath(row.win_path ?? '')
  } else {
    target = row.win_path ?? winPathFromWslPath(row.wsl_path)
  }
  if (target === null || target.length === 0) {
    throw new ServiceError('NOT_FOUND', `project "${row.name}" has no suitable path for "${kind}" open`)
  }

  // 打开类执行前校验目标存在（docs/04 §3）；wsl 侧 /mnt 路径无法从 Windows 校验，跳过
  const isWslPath = target.startsWith('/mnt/')
  if (!isWslPath && !existsSync(target)) {
    throw new ServiceError('NOT_FOUND', `open target does not exist: ${target}`)
  }

  const result = await launchViaStartProcess(kind, target)
  if (result.timedOut || result.code !== 0) {
    throw new ServiceError(
      'EXEC_FAILED',
      `failed to open ${kind} for project "${row.name}": exit ${result.code}${result.stderr.length > 0 ? ` (${result.stderr.slice(0, 200)})` : ''}`,
    )
  }

  db.prepare('UPDATE projects SET last_opened_at = ?, updated_at = ? WHERE id = ?').run(nowSec(), nowSec(), row.id)
  return { opened: true }
}
