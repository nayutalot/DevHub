/**
 * servicesService.ts — 端口归因（Services 模块核心，docs/04 services channels，docs/05 规则 3）。
 *
 * 三源合并：
 *  - windows：netstat LISTENING（仅本地监听地址）→ pid 去重 → Win32_Process 明细；
 *  - wsl：每个真实发行版 ss/netstat -tlnp（pid 可能为 null，无权限读进程时）；
 *  - docker：daemon 可用时容器 hostPort 映射（processName=容器名，commandLine=image）。
 *
 * 项目归因链 port → process → environment → project：
 *  - windows/wsl 源：commandLine / executablePath 包含项目 win_path / wsl_path
 *    （大小写不敏感、正反斜杠归一）；
 *  - docker 源：compose label `com.docker.compose.project` 或容器名前缀匹配项目名；
 *  - 归因不到 → project_id = null。
 *
 * services upsert 业务键 (port, origin, pid)：存在则更新 last_seen_at 与字段，
 * 不存在插入；本次未见的旧记录保留 last_seen_at 原值（UI 按 last_seen 排序）。
 */

import type { DatabaseSync } from 'node:sqlite'
import { getProcessDetails, listListeningPorts } from '../adapters/windows.ts'
import { listDistros, wslListeningSockets } from '../adapters/wsl.ts'
import { dockerInfo, listContainers } from '../adapters/docker.ts'
import { getDatabase } from '../db/index.ts'
import { logger } from '../core/logger.ts'
import type { ServiceRecord, ServiceRow } from '../../shared/types.ts'
import { errorMessage, finishScanRow, insertScanRow, normalizePathKey, nowSec } from './internal.ts'
import { findResourceId, registerResource, relate } from './resourceGraph.ts'
import { COMPOSE_PROJECT_LABEL } from './scanService.ts'

/** 仅这些地址上的 LISTENING 视为本地监听（docs/04 services 语义）。 */
const LOCAL_LISTEN_ADDRESSES: ReadonlySet<string> = new Set([
  '0.0.0.0',
  '127.0.0.1',
  '::',
  '::1',
  '[::]',
  '[::1]',
  'localhost',
])

/** dashboard.serviceCount 的“近期仍在”窗口。 */
export const SERVICE_RECENCY_SECONDS = 15 * 60

// ---------------------------------------------------------------------------
// 三源采集
// ---------------------------------------------------------------------------

interface PendingService {
  port: number
  protocol: 'tcp' | 'udp'
  pid: number | null
  processName: string | null
  commandLine: string | null
  executablePath: string | null
  origin: 'windows' | 'wsl' | 'docker'
  /** wsl 源的发行版名（located_in 边定位用）；其他源 null。 */
  distro: string | null
  /** docker 源容器 labels（compose 归因用）。 */
  labels: Record<string, string> | null
}

async function collectWindowsServices(pending: PendingService[], seen: Set<string>): Promise<void> {
  try {
    const entries = (await listListeningPorts()).filter((entry) => LOCAL_LISTEN_ADDRESSES.has(entry.address))
    const details = await getProcessDetails(entries.map((entry) => entry.pid))
    for (const entry of entries) {
      const key = `windows|${entry.port}|${entry.pid}`
      if (seen.has(key)) continue
      seen.add(key)
      const detail = details.get(entry.pid)
      pending.push({
        port: entry.port,
        protocol: 'tcp',
        pid: entry.pid,
        processName: detail?.name ?? null,
        commandLine: detail?.commandLine ?? null,
        executablePath: detail?.executablePath ?? null,
        origin: 'windows',
        distro: null,
        labels: null,
      })
    }
  } catch (err) {
    logger.warn(`services: windows source degraded: ${errorMessage(err)}`)
  }
}

async function collectWslServices(pending: PendingService[], seen: Set<string>): Promise<void> {
  try {
    const distros = await listDistros()
    for (const distro of distros) {
      if (distro.name.toLowerCase().startsWith('docker-desktop')) continue
      let sockets: Awaited<ReturnType<typeof wslListeningSockets>> = []
      try {
        sockets = await wslListeningSockets(distro.name)
      } catch (err) {
        logger.warn(`services: wsl ${distro.name} sockets degraded: ${errorMessage(err)}`)
        continue
      }
      for (const socket of sockets) {
        const key = `wsl|${distro.name}|${socket.port}|${socket.pid ?? 'x'}|${socket.processName ?? ''}`
        if (seen.has(key)) continue
        seen.add(key)
        pending.push({
          port: socket.port,
          protocol: 'tcp',
          pid: socket.pid,
          processName: socket.processName,
          commandLine: null,
          executablePath: null,
          origin: 'wsl',
          distro: distro.name,
          labels: null,
        })
      }
    }
  } catch (err) {
    logger.warn(`services: wsl source degraded: ${errorMessage(err)}`)
  }
}

async function collectDockerServices(pending: PendingService[], seen: Set<string>): Promise<void> {
  try {
    const info = await dockerInfo()
    if (!info.daemonAvailable) return // 结构化降级：无 daemon 即无 docker 源（docs/02 §4）
    const containers = await listContainers()
    for (const container of containers) {
      if (container.state !== 'running') continue
      for (const mapping of container.ports) {
        const key = `docker|${container.dockerId}|${mapping.host}|${mapping.container}|${mapping.proto}`
        if (seen.has(key)) continue
        seen.add(key)
        pending.push({
          port: mapping.host,
          protocol: mapping.proto,
          pid: null,
          processName: container.name,
          commandLine: container.image ?? null,
          executablePath: null,
          origin: 'docker',
          distro: null,
          labels: container.labels ?? null,
        })
      }
    }
  } catch (err) {
    logger.warn(`services: docker source degraded: ${errorMessage(err)}`)
  }
}

// ---------------------------------------------------------------------------
// 项目归因
// ---------------------------------------------------------------------------

interface ProjectRef {
  id: number
  name: string
  win_path: string | null
  wsl_path: string | null
}

/** 大小写不敏感 + 反斜杠归一 + 去尾分隔符：共享实现见 internal.ts（docs/08 §10.3）。 */

function attributeProject(pending: PendingService, projects: readonly ProjectRef[]): number | null {
  if (pending.origin === 'docker') {
    const labelProject = pending.labels?.[COMPOSE_PROJECT_LABEL]
    if (typeof labelProject === 'string' && labelProject.length > 0) {
      const byLabel = projects.find((p) => p.name === labelProject)
      if (byLabel !== undefined) return byLabel.id
    }
    if (pending.processName !== null) {
      for (const project of projects) {
        if (pending.processName === project.name || pending.processName.startsWith(`${project.name}-`)) {
          return project.id
        }
      }
    }
    return null
  }

  const haystacks: string[] = []
  if (pending.commandLine !== null) haystacks.push(pending.commandLine)
  if (pending.executablePath !== null) haystacks.push(pending.executablePath)
  if (haystacks.length === 0) return null
  const haystack = haystacks.map((h) => normalizePathKey(h)).join('\n')

  for (const project of projects) {
    if (pending.origin === 'windows' && project.win_path !== null) {
      if (haystack.includes(normalizePathKey(project.win_path))) return project.id
    }
    if (pending.origin === 'wsl' && project.wsl_path !== null) {
      if (haystack.includes(normalizePathKey(project.wsl_path))) return project.id
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// services upsert + 资源图
// ---------------------------------------------------------------------------

function locateEnvironmentResourceId(db: DatabaseSync, pending: PendingService): number | null {
  let envName: string | null = null
  if (pending.origin === 'windows') {
    envName = 'windows'
  } else if (pending.origin === 'wsl' && pending.distro !== null) {
    envName = `wsl:${pending.distro}`
  }
  if (envName === null) return null
  const envRow = db.prepare('SELECT id FROM environments WHERE name = ?').get(envName) as { id: number } | undefined
  if (envRow === undefined) return null
  return findResourceId(db, 'environment', envRow.id)
}

interface ServiceDbRow {
  id: number
  port: number
  protocol: string
  pid: number | null
  process_name: string | null
  command_line: string | null
  working_dir: string | null
  origin: string
  project_id: number | null
  first_seen_at: number
  last_seen_at: number
}

function upsertService(db: DatabaseSync, pending: PendingService, projects: readonly ProjectRef[], now: number): ServiceRecord {
  const projectId = attributeProject(pending, projects)

  const existing =
    pending.pid === null
      ? (db.prepare('SELECT id, first_seen_at FROM services WHERE port = ? AND origin = ? AND pid IS NULL').get(pending.port, pending.origin) as
          | { id: number; first_seen_at: number }
          | undefined)
      : (db.prepare('SELECT id, first_seen_at FROM services WHERE port = ? AND origin = ? AND pid = ?').get(pending.port, pending.origin, pending.pid) as
          | { id: number; first_seen_at: number }
          | undefined)

  let id: number
  let firstSeenAt: number
  if (existing !== undefined) {
    db.prepare('UPDATE services SET process_name = ?, command_line = ?, working_dir = ?, project_id = ?, last_seen_at = ? WHERE id = ?').run(
      pending.processName,
      pending.commandLine,
      null,
      projectId,
      now,
      existing.id,
    )
    id = existing.id
    firstSeenAt = existing.first_seen_at
  } else {
    const result = db
      .prepare(
        'INSERT INTO services (port, protocol, pid, process_name, command_line, working_dir, origin, project_id, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(pending.port, pending.protocol, pending.pid, pending.processName, pending.commandLine, null, pending.origin, projectId, now, now)
    id = Number(result.lastInsertRowid)
    firstSeenAt = now
  }

  // docs/05 规则 3：service located_in environment(origin)；归因成功补 project uses service
  const serviceResourceId = registerResource(db, 'service', id, `${pending.processName ?? 'unknown'}:${pending.port}`)
  const envResourceId = locateEnvironmentResourceId(db, pending)
  if (envResourceId !== null) {
    relate(db, serviceResourceId, envResourceId, 'located_in')
  }
  if (projectId !== null) {
    const project = projects.find((p) => p.id === projectId)
    relate(db, registerResource(db, 'project', projectId, project?.name ?? `project:${projectId}`), serviceResourceId, 'uses')
  }

  return {
    id,
    port: pending.port,
    protocol: pending.protocol,
    pid: pending.pid ?? undefined,
    processName: pending.processName ?? undefined,
    commandLine: pending.commandLine ?? undefined,
    origin: pending.origin,
    projectId: projectId ?? undefined,
    firstSeenAt,
    lastSeenAt: now,
  }
}

// ---------------------------------------------------------------------------
// 对外 API（对应 services:refresh / services:list）
// ---------------------------------------------------------------------------

/** 三源采集 + 归因落库；返回本轮写入/更新的记录。同时写一条 kind='services' 的扫描行。 */
export async function refreshServices(): Promise<ServiceRecord[]> {
  const db = getDatabase()
  const pending: PendingService[] = []
  const seen = new Set<string>()
  await Promise.all([collectWindowsServices(pending, seen), collectWslServices(pending, seen)])

  // docker 源依赖 daemon 状态，单独串行（同为 docker CLI 探测，避免并发打爆）
  await collectDockerServices(pending, seen)

  const projects = db.prepare('SELECT id, name, win_path, wsl_path FROM projects').all() as unknown as ProjectRef[]
  const now = nowSec()

  const records: ServiceRecord[] = []
  for (const item of pending) {
    try {
      records.push(upsertService(db, item, projects, now))
    } catch (err) {
      logger.warn(`services: upsert failed for port ${item.port} (${item.origin}): ${errorMessage(err)}`)
    }
  }

  // docs/04 services:refresh → scanId 语义：留下 kind='services' 的扫描生命周期行
  const scanId = insertScanRow(db, 'services', null)
  finishScanRow(db, scanId, 'done', records.length, [])

  return records
}

function rowToServiceRow(row: ServiceDbRow, projectName: string | null): ServiceRow {
  return {
    id: row.id,
    port: row.port,
    protocol: row.protocol as ServiceRow['protocol'],
    pid: row.pid ?? undefined,
    processName: row.process_name ?? undefined,
    commandLine: row.command_line ?? undefined,
    workingDir: row.working_dir ?? undefined,
    origin: row.origin as ServiceRow['origin'],
    projectId: row.project_id ?? undefined,
    projectName: projectName ?? undefined,
    lastSeenAt: row.last_seen_at,
  }
}

export interface ServicesFilter {
  port?: number
  projectId?: number
}

// 全静态语句字面量（约束 #11：SQL 文本零拼接/零插值，全部取值走 ? 绑定）
const LIST_SERVICES_ALL_SQL =
  'SELECT s.*, p.name AS project_name FROM services s LEFT JOIN projects p ON p.id = s.project_id ORDER BY s.last_seen_at DESC, s.id DESC'
const LIST_SERVICES_BY_PORT_SQL =
  'SELECT s.*, p.name AS project_name FROM services s LEFT JOIN projects p ON p.id = s.project_id WHERE s.port = ? ORDER BY s.last_seen_at DESC, s.id DESC'
const LIST_SERVICES_BY_PROJECT_SQL =
  'SELECT s.*, p.name AS project_name FROM services s LEFT JOIN projects p ON p.id = s.project_id WHERE s.project_id = ? ORDER BY s.last_seen_at DESC, s.id DESC'
const LIST_SERVICES_BY_PORT_AND_PROJECT_SQL =
  'SELECT s.*, p.name AS project_name FROM services s LEFT JOIN projects p ON p.id = s.project_id WHERE s.port = ? AND s.project_id = ? ORDER BY s.last_seen_at DESC, s.id DESC'

/** 从 DB 读取（含 project 联查 name），按 last_seen 倒序。 */
export function listServices(filter?: ServicesFilter): ServiceRow[] {
  const db = getDatabase()
  const port = filter?.port
  const projectId = filter?.projectId
  let rows: (ServiceDbRow & { project_name: string | null })[]
  if (port !== undefined && projectId !== undefined) {
    rows = db.prepare(LIST_SERVICES_BY_PORT_AND_PROJECT_SQL).all(port, projectId) as unknown as typeof rows
  } else if (port !== undefined) {
    rows = db.prepare(LIST_SERVICES_BY_PORT_SQL).all(port) as unknown as typeof rows
  } else if (projectId !== undefined) {
    rows = db.prepare(LIST_SERVICES_BY_PROJECT_SQL).all(projectId) as unknown as typeof rows
  } else {
    rows = db.prepare(LIST_SERVICES_ALL_SQL).all() as unknown as typeof rows
  }
  return rows.map((row) => rowToServiceRow(row, row.project_name))
}

/**
 * findByPort 便捷查询（devhub.services.inspect 的数据源，docs/08 §6.6）。
 * 归因铁律：project_id 为 NULL 的行 → projectId/projectName 为 undefined，
 * MCP 投影层规整为字面量 'unknown'，Service 层绝不就近挑一个项目填充。
 * snapshotAt 口径 = 命中行 max(lastSeenAt)（ServiceRow.lastSeenAt，M2 增补）。
 */
export function findByPort(port: number): ServiceRow[] {
  return listServices({ port })
}
