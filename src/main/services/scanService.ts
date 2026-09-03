/**
 * scanService.ts — 全量扫描编排（docs/02 §4，docs/04 scan channels，约束 #25/#26）。
 *
 * 流程：settings.scan_root → fs.discoverProjects → 逐项目 upsert projects →
 * 对含 .git 标记的项目并发 git 探测（上限 4，单项 try/catch）→ upsert repositories →
 * docker 可用则 upsert containers 并按容器名前缀 / compose label 关联项目 →
 * 同步登记 resources/relationships（docs/05）→ scans 行 running→done/cancelled/failed。
 *
 * 取消：模块级令牌，各阶段边界检查；已启动的 git 探测允许跑完当次（不硬杀）。
 * 防重入：running 期间再次 startScan 直接返回当前状态（docs/04 §3 幂等规则）。
 */

import type { DatabaseSync } from 'node:sqlite'
import { discoverProjects } from '../adapters/fs.ts'
import { gitHead, gitRemote, gitStatus } from '../adapters/git.ts'
import { dockerInfo, listContainers } from '../adapters/docker.ts'
import { getDatabase } from '../db/index.ts'
import type { ContainerRecord, DiscoveredProject, ScanKind, ScanStatus, ScanStatusType } from '../../shared/types.ts'
import { dbVal, errorMessage, finishScanRow, insertScanRow, nowSec, readScanRow, ServiceError, slugify, uniqueSlug } from './internal.ts'
import { getSetting } from './settingsService.ts'
import { registerResource, relate, relateProjectLocatedInWindows } from './resourceGraph.ts'

/** git 探测并发上限（父任务裁决值）。 */
const GIT_PROBE_CONCURRENCY = 4
const DEFAULT_SCAN_ROOT = 'F:\\Active_Project'
/** docker ps json 中标记 compose 项目名的 label key。 */
export const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project'

// ---------------------------------------------------------------------------
// 模块级扫描状态：同一时刻至多一个 running 扫描（docs/04 §3）
// ---------------------------------------------------------------------------

let activeScanId: number | null = null
let cancelRequested = false

function isCancelled(): boolean {
  return cancelRequested
}

interface ProjectRef {
  id: number
  name: string
}

interface PersistedProject extends ProjectRef {
  discovered: DiscoveredProject
}

// ---------------------------------------------------------------------------
// 对外 API（对应 scan:start / scan:status / scan:cancel）
// ---------------------------------------------------------------------------

/**
 * 启动全量扫描并等待其结束，返回最终 ScanStatus。
 * 已有 running 扫描时不重入，直接返回当前扫描状态（幂等）。
 */
export async function startScan(kind: ScanKind = 'full'): Promise<ScanStatus> {
  if (activeScanId !== null) {
    return readScanStatus(activeScanId)
  }
  const db = getDatabase()
  failStaleRunningScans(db)
  const rootPath = getSetting('scan_root') ?? DEFAULT_SCAN_ROOT
  const scanId = insertScanRow(db, kind, rootPath)
  activeScanId = scanId
  cancelRequested = false
  try {
    await runScan(db, scanId, rootPath)
  } finally {
    activeScanId = null
  }
  return readScanStatus(scanId)
}

/** 最近一次（或指定 id 的）扫描状态。无任何扫描记录 → NOT_FOUND。 */
export function scanStatus(scanId?: number): ScanStatus {
  if (scanId !== undefined) {
    return rowToScanStatus(readScanRow(getDatabase(), scanId))
  }
  const row = getDatabase().prepare('SELECT * FROM scans ORDER BY id DESC LIMIT 1').get() as ScanRow | undefined
  if (row === undefined) {
    throw new ServiceError('NOT_FOUND', 'no scan has been recorded yet')
  }
  return rowToScanStatus(row)
}

/** 请求取消当前扫描；无 running 扫描 → { cancelled:false }。 */
export function cancelScan(): { cancelled: boolean } {
  if (activeScanId === null) {
    return { cancelled: false }
  }
  cancelRequested = true
  return { cancelled: true }
}

/** 当前是否有 running 扫描（gateway / dashboard 可选消费）。 */
export function isScanRunning(): boolean {
  return activeScanId !== null
}

// ---------------------------------------------------------------------------
// 扫描编排主体
// ---------------------------------------------------------------------------

async function runScan(db: DatabaseSync, scanId: number, rootPath: string): Promise<void> {
  const errors: string[] = []
  let foundCount = 0
  let finalStatus: ScanStatusType = 'done'

  try {
    // 阶段 1：项目发现 + projects 落库（单项失败只记 error_summary）
    const discovered = await discoverProjects(rootPath)
    const persisted: PersistedProject[] = []
    for (const item of discovered) {
      try {
        const row = upsertProject(db, item)
        persisted.push(row)
        // docs/05：每个入库项目登记资源节点；windows 环境行存在则补 located_in 边
        relateProjectLocatedInWindows(db, registerResource(db, 'project', row.id, row.name))
      } catch (err) {
        errors.push(`project ${item.name}: ${errorMessage(err)}`)
      }
    }
    foundCount = persisted.length

    if (isCancelled()) {
      finishScanRow(db, scanId, 'cancelled', foundCount, errors)
      return
    }

    // 阶段 2：git 探测（并发上限 4，单项 try/catch，不拖垮整体）
    const gitTargets = persisted.filter((p) => p.discovered.markers.includes('.git'))
    await mapWithLimit(gitTargets, GIT_PROBE_CONCURRENCY, async (target) => {
      try {
        await probeAndUpsertRepository(db, target.id, target.name, target.discovered.winPath)
      } catch (err) {
        errors.push(`git ${target.name}: ${errorMessage(err)}`)
      }
    })

    if (isCancelled()) {
      finishScanRow(db, scanId, 'cancelled', foundCount, errors)
      return
    }

    // 阶段 3：docker 容器同步 + 项目关联（daemon 不可用是常态而非异常，docs/02 §4）
    try {
      const info = await dockerInfo()
      if (info.daemonAvailable) {
        const containers = await listContainers()
        for (const container of containers) {
          if (isCancelled()) break
          try {
            associateContainer(db, container, persisted)
          } catch (err) {
            errors.push(`container ${container.name}: ${errorMessage(err)}`)
          }
        }
      } else if (info.cliAvailable) {
        errors.push(`docker daemon unavailable: ${info.reason ?? 'unknown reason'}`)
      } else {
        errors.push('docker CLI not found; container sync skipped')
      }
    } catch (err) {
      errors.push(`docker: ${errorMessage(err)}`)
    }

    if (finalStatus === 'done' && isCancelled()) {
      finalStatus = 'cancelled'
    }
  } catch (err) {
    // 阶段级失败（如发现阶段异常）：整体 failed，但不丢已累积的 error_summary
    finalStatus = 'failed'
    errors.push(`scan: ${errorMessage(err)}`)
  }

  finishScanRow(db, scanId, finalStatus, foundCount, errors)
}

// ---------------------------------------------------------------------------
// projects / repositories 落库
// ---------------------------------------------------------------------------

/** projects upsert：UNIQUE(name) 冲突即更新路径与 runtime_hint（父任务裁决）。 */
function upsertProject(db: DatabaseSync, discovered: DiscoveredProject): PersistedProject {
  const now = nowSec()
  const existing = db.prepare('SELECT id FROM projects WHERE name = ?').get(discovered.name) as
    | { id: number }
    | undefined
  if (existing !== undefined) {
    db.prepare('UPDATE projects SET win_path = ?, wsl_path = ?, runtime_hint = ?, updated_at = ? WHERE id = ?').run(
      discovered.winPath,
      discovered.wslPath,
      discovered.runtimeHint,
      now,
      existing.id,
    )
    return { id: existing.id, name: discovered.name, discovered }
  }
  const slug = uniqueSlug(db, slugify(discovered.name))
  const result = db
    .prepare(
      'INSERT INTO projects (name, slug, win_path, wsl_path, runtime_hint, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(discovered.name, slug, discovered.winPath, discovered.wslPath, discovered.runtimeHint, now, now)
  return { id: Number(result.lastInsertRowid), name: discovered.name, discovered }
}

/**
 * git 探测 + repositories upsert + `project contains repository` 边。
 * status 失败（非仓库 / git 缺失 / 超时）→ throw，由调用方记入 error_summary。
 * remote / head 为 best-effort：单独失败不阻塞分支与 dirty 数据落库。
 */
export async function probeAndUpsertRepository(
  db: DatabaseSync,
  projectId: number,
  projectName: string,
  winPath: string,
): Promise<void> {
  const status = await gitStatus(winPath)
  if (status === null) {
    throw new Error('git status unavailable (not a repository, git missing, or timed out)')
  }
  const [remote, head] = await Promise.all([gitRemote(winPath), gitHead(winPath)])
  const now = nowSec()
  const isDirty = status.dirtyCount > 0 ? 1 : 0

  const existing = db.prepare('SELECT id FROM repositories WHERE project_id = ?').get(projectId) as
    | { id: number }
    | undefined
  let repoId: number
  if (existing !== undefined) {
    db.prepare(
      'UPDATE repositories SET remote_url = ?, branch = ?, head_sha = ?, is_dirty = ?, ahead = ?, behind = ?, last_status_at = ?, updated_at = ? WHERE id = ?',
    ).run(dbVal(remote), status.branch, dbVal(head), isDirty, status.ahead, status.behind, now, now, existing.id)
    repoId = existing.id
  } else {
    const result = db
      .prepare(
        'INSERT INTO repositories (project_id, remote_url, branch, head_sha, is_dirty, ahead, behind, last_status_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(projectId, dbVal(remote), status.branch, dbVal(head), isDirty, status.ahead, status.behind, now, now, now)
    repoId = Number(result.lastInsertRowid)
  }

  const projectResourceId = registerResource(db, 'project', projectId, projectName)
  const repoResourceId = registerResource(db, 'repository', repoId, `${projectName} (${status.branch})`)
  relate(db, projectResourceId, repoResourceId, 'contains')
}

// ---------------------------------------------------------------------------
// containers 落库与项目关联
// ---------------------------------------------------------------------------

/**
 * 容器 → 项目匹配：优先 compose label `com.docker.compose.project` 精确等于项目名，
 * 其次容器名前缀（compose 命名约定 `<project>-<service>-<n>`）或完全同名。
 * 匹配不到 → null（project_id 落 null，docs/05 规则 4）。
 */
export function matchProjectForContainer(
  container: ContainerRecord,
  projects: readonly ProjectRef[],
): ProjectRef | null {
  const labelProject = container.labels?.[COMPOSE_PROJECT_LABEL]
  if (typeof labelProject === 'string' && labelProject.length > 0) {
    const byLabel = projects.find((p) => p.name === labelProject)
    if (byLabel !== undefined) return byLabel
  }
  for (const project of projects) {
    if (container.name === project.name || container.name.startsWith(`${project.name}-`)) {
      return project
    }
  }
  return null
}

/** containers upsert（业务键 docker_id），project_id 写本次匹配值（可为 null）。返回容器表 id。 */
export function upsertContainer(db: DatabaseSync, container: ContainerRecord, projectId: number | null): number {
  const now = nowSec()
  const existing = db.prepare('SELECT id FROM containers WHERE docker_id = ?').get(container.dockerId) as
    | { id: number }
    | undefined
  if (existing !== undefined) {
    db.prepare(
      'UPDATE containers SET name = ?, image = ?, state = ?, ports_json = ?, project_id = ?, updated_at = ? WHERE id = ?',
    ).run(container.name, dbVal(container.image), dbVal(container.state), JSON.stringify(container.ports), projectId, now, existing.id)
    return existing.id
  }
  const result = db
    .prepare(
      'INSERT INTO containers (docker_id, name, image, state, ports_json, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(container.dockerId, container.name, dbVal(container.image), dbVal(container.state), JSON.stringify(container.ports), projectId, now, now)
  return Number(result.lastInsertRowid)
}

/** 扫描期容器关联：upsert + 登记资源 + 命中项目时补 `project uses container` 边。 */
function associateContainer(db: DatabaseSync, container: ContainerRecord, projects: readonly PersistedProject[]): void {
  const match = matchProjectForContainer(container, projects)
  const containerId = upsertContainer(db, container, match !== null ? match.id : null)
  const containerResourceId = registerResource(db, 'container', containerId, container.name)
  if (match !== null) {
    relate(db, registerResource(db, 'project', match.id, match.name), containerResourceId, 'uses')
  }
}

// ---------------------------------------------------------------------------
// scans 行工具
// ---------------------------------------------------------------------------

interface ScanRow {
  id: number
  kind: string
  root_path: string | null
  started_at: number
  finished_at: number | null
  status: string
  found_count: number
  error_summary: string | null
}

function rowToScanStatus(row: ScanRow): ScanStatus {
  return {
    scanId: row.id,
    kind: row.kind as ScanKind,
    rootPath: row.root_path ?? undefined,
    status: row.status as ScanStatusType,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    foundCount: row.found_count,
    errorSummary: row.error_summary ?? undefined,
  }
}

function readScanStatus(scanId: number): ScanStatus {
  return rowToScanStatus(readScanRow(getDatabase(), scanId))
}

/** 上次进程中断留下的 running 行标记为 failed（保证 scans 行生命周期完整，docs/02 §4）。 */
function failStaleRunningScans(db: DatabaseSync): void {
  db.prepare(
    "UPDATE scans SET status = 'failed', finished_at = ?, error_summary = COALESCE(error_summary, '') || 'interrupted: superseded by a new scan' WHERE status = 'running'",
  ).run(nowSec())
}

// ---------------------------------------------------------------------------
// 并发工具
// ---------------------------------------------------------------------------

/** 固定并发上限的 map；单项异常由 worker 自行 try/catch（约束 #25）。 */
async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  const runners: Promise<void>[] = []
  const runnerCount = Math.max(1, Math.min(limit, items.length))
  for (let i = 0; i < runnerCount; i += 1) {
    runners.push(
      (async () => {
        while (true) {
          const index = cursor
          cursor += 1
          if (index >= items.length) return
          results[index] = await worker(items[index])
        }
      })(),
    )
  }
  await Promise.all(runners)
  return results
}
