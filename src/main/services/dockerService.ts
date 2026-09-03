/**
 * dockerService.ts — Docker 编排（docs/08 §4 缺口 1、§6.7/§6.8；S4 扩展 docs/09 §8.1/§9）。
 *
 * 只读编排：包 adapter.dockerInfo / adapter.listContainers / adapter.listImages，
 * 容器归因复用 scanService.matchProjectForContainer（不重复探测逻辑）。
 * S4 变更编排（docs/09 §8.1「同一 service 扩展动作函数与镜像列表」）：containerAction
 * （CONFIRM_REQUIRED 两段式，exec 经 core/exec.run 字面量 args）+ containerLogs
 * （只读拉取，tail ≤500 / 文本 64KB 截断）+ dockerOverview（单次探测三合一投影）。
 * "daemon 不可用"是常态而非异常（docs/02 §4）：一律结构化降级，不 throw（约束 #25/#26）。
 */

import { run } from '../core/exec.ts'
import { dockerInfo, listContainers, listImages } from '../adapters/docker.ts'
import type {
  ContainerPortMapping,
  DockerActionName,
  DockerActionResult,
  DockerActionStart,
  DockerImagesInfo,
  DockerLogsResult,
  DockerOverviewContainer,
  DockerOverviewResult,
} from '../../shared/types.ts'
import { getDatabase } from '../db/index.ts'
import { ServiceError } from './internal.ts'
import { matchProjectForContainer, upsertContainer } from './scanService.ts'

/** devhub.docker.status 出参（docs/08 §6.7）。containers 恒为空表（实时列表归 containers 工具）。 */
export interface DockerStatusInfo {
  /** available = cliAvailable && daemonAvailable。 */
  available: boolean
  cliAvailable: boolean
  daemonAvailable: boolean
  clientVersion?: string
  serverVersion?: string
  reason?: string
  containers: never[]
}

/** devhub.docker.containers 行：归因不到 project → 字面量 'unknown'（docs/08 §6.8）。 */
export interface DockerContainerEntry {
  dockerId: string
  name: string
  image?: string
  state?: string
  ports: ContainerPortMapping[]
  project: string
}

export interface DockerContainersInfo {
  available: boolean
  reason?: string
  containers: DockerContainerEntry[]
}

/** docker status：包 adapter.dockerInfo，加 available 布尔与空 containers 占位。 */
export async function dockerStatus(): Promise<DockerStatusInfo> {
  const info = await dockerInfo()
  return {
    available: info.cliAvailable && info.daemonAvailable,
    cliAvailable: info.cliAvailable,
    daemonAvailable: info.daemonAvailable,
    clientVersion: info.clientVersion,
    serverVersion: info.serverVersion,
    reason: info.reason,
    containers: [],
  }
}

/**
 * 容器实时列表 + project 归因投影。
 * daemon 不可用 → { available:false, reason, containers:[] } 结构化降级；
 * 归因不到 → project 显式 'unknown'，禁止就近猜测（docs/08 §6.6/§6.8）。
 */
export async function dockerContainers(): Promise<DockerContainersInfo> {
  const info = await dockerInfo()
  if (!info.daemonAvailable) {
    return {
      available: false,
      reason: info.reason ?? 'docker daemon unavailable',
      containers: [],
    }
  }

  const db = getDatabase()
  const [containers, projectRows] = await Promise.all([
    listContainers(),
    Promise.resolve(db.prepare('SELECT id, name FROM projects').all() as { id: number; name: string }[]),
  ])

  const containersList: DockerContainerEntry[] = containers.map((container) => {
    const match = matchProjectForContainer(container, projectRows)
    return {
      dockerId: container.dockerId,
      name: container.name,
      image: container.image,
      state: container.state,
      ports: container.ports,
      project: match !== null ? match.name : 'unknown',
    }
  })
  return { available: true, containers: containersList }
}

// ---------------------------------------------------------------------------
// S4：镜像 / 总览 / 容器动作 / 日志（docs/09 §8.1/§9）
// ---------------------------------------------------------------------------

/** 动作与查询类命令统一超时（stop 默认宽限 10s、restart 冷容器可能更慢，放宽到 60s）。 */
export const DOCKER_ACTION_TIMEOUT_MS = 60_000
/** logs 读取超时（tail ≤500 文本应秒回；放宽到 30s 覆盖冷启动）。 */
export const DOCKER_LOGS_TIMEOUT_MS = 30_000
/** logs tail 上限（docs/09 §9 + 任务书：>500 截到 500）。 */
export const DOCKER_LOGS_TAIL_MAX = 500
/** 缺省 tail 行数（老实现同款）。 */
export const DOCKER_LOGS_TAIL_DEFAULT = 200
/** logs 文本上限：超限截断并置 truncated=true（提示调小 tail）。 */
export const DOCKER_LOGS_TEXT_LIMIT = 64 * 1024

/** 容器动作参数构造（纯函数，smoke 断言 argv；动作名由类型/网关枚举收口，绝不拼 shell）。 */
export function containerActionArgs(action: DockerActionName, name: string): string[] {
  switch (action) {
    case 'start':
      return ['start', name]
    case 'stop':
      return ['stop', name]
    case 'restart':
      return ['restart', name]
  }
}

/**
 * tail 收口：缺省 200；>500 截到 500（docs/09 §9 语义，非拒绝）；
 * 非整数/负数由网关 BAD_PAYLOAD 拒绝，不会进入本函数。
 */
export function clampLogsTail(tail: number | undefined): number {
  const base = tail ?? DOCKER_LOGS_TAIL_DEFAULT
  return Math.min(Math.max(0, Math.floor(base)), DOCKER_LOGS_TAIL_MAX)
}

/** logs 参数构造（纯函数，smoke 断言 argv；stdout/stderr 由 docker CLI 自行合并）。 */
export function containerLogsArgs(name: string, tail: number, since?: number): string[] {
  const args = ['logs', '--tail', String(tail)]
  if (since !== undefined) args.push('--since', `${since}s`)
  args.push(name)
  return args
}

/** dockerInfo → 投影 status（available = cli && daemon）。 */
function projectStatus(info: Awaited<ReturnType<typeof dockerInfo>>): DockerOverviewResult['status'] {
  return {
    available: info.cliAvailable && info.daemonAvailable,
    cliAvailable: info.cliAvailable,
    daemonAvailable: info.daemonAvailable,
    clientVersion: info.clientVersion,
    serverVersion: info.serverVersion,
    reason: info.reason,
  }
}

/** 镜像列表 + 简要统计（count / 悬空镜像数）；daemon 不可用 → 结构化降级。 */
export async function dockerImages(): Promise<DockerImagesInfo> {
  const info = await dockerInfo()
  if (!info.daemonAvailable) {
    return {
      available: false,
      reason: info.reason ?? 'docker daemon unavailable',
      images: [],
      count: 0,
      danglingCount: 0,
    }
  }
  const images = await listImages()
  return {
    available: true,
    images,
    count: images.length,
    danglingCount: images.filter((image) => image.repository === '<none>').length,
  }
}

/**
 * docker:overview（docs/09 §9）：info + containers + images 单次探测三合一。
 * daemon 不可用 → status.available=false + 空容器表 + images 结构化降级（约束 #26）。
 */
export async function dockerOverview(): Promise<DockerOverviewResult> {
  const info = await dockerInfo()
  const status = projectStatus(info)
  if (!info.daemonAvailable) {
    return {
      status,
      containers: [],
      images: {
        available: false,
        reason: info.reason ?? 'docker daemon unavailable',
        images: [],
        count: 0,
        danglingCount: 0,
      },
    }
  }

  const db = getDatabase()
  const [containers, projectRows, images] = await Promise.all([
    listContainers(),
    Promise.resolve(db.prepare('SELECT id, name FROM projects').all() as { id: number; name: string }[]),
    listImages(),
  ])

  const entries: DockerOverviewContainer[] = containers.map((container) => {
    const match = matchProjectForContainer(container, projectRows)
    return {
      dockerId: container.dockerId,
      name: container.name,
      image: container.image,
      state: container.state,
      ports: container.ports,
      project: match !== null ? match.name : 'unknown',
    }
  })

  return {
    status,
    containers: entries,
    images: {
      available: true,
      images,
      count: images.length,
      danglingCount: images.filter((image) => image.repository === '<none>').length,
    },
  }
}

/** 按 name 或 dockerId 前缀定位容器（ID 前缀匹配 docker 惯例；name 精确优先）。 */
function findContainer<T extends { name: string; dockerId: string }>(rows: readonly T[], target: string): T | undefined {
  return (
    rows.find((row) => row.name === target) ??
    rows.find((row) => row.dockerId === target || (target.length >= 4 && row.dockerId.startsWith(target)))
  )
}

/**
 * 容器动作（start/stop/restart，docs/09 §8.1/§8.3 CONFIRM_REQUIRED）：
 *  - daemon 不可用 → { ok:false, degraded:true, error: reason } 结构化降级，绝不 throw；
 *  - 容器不存在 → ServiceError('NOT_FOUND')（网关折叠为 error envelope）；
 *  - 未带 confirmed → { confirmRequired:true, impacts }（容器现状 + 发布端口 + 关联项目）；
 *  - confirmed 执行（exec 字面量 args）→ 成功后刷新 containers 缓存（scanService.upsertContainer）。
 */
export async function containerAction(
  name: string,
  action: DockerActionName,
  confirmed?: boolean,
): Promise<DockerActionStart | DockerActionResult> {
  const target = name.trim()
  const info = await dockerInfo()
  if (!info.daemonAvailable) {
    return {
      ok: false,
      name: target,
      action,
      degraded: true,
      error: info.reason ?? 'docker daemon unavailable',
    }
  }

  const db = getDatabase()
  const containers = await listContainers()
  const hit = findContainer(containers, target)
  if (hit === undefined) {
    throw new ServiceError('NOT_FOUND', `container not found: ${target}`)
  }

  if (confirmed !== true) {
    const projectRows = db.prepare('SELECT id, name FROM projects').all() as { id: number; name: string }[]
    const match = matchProjectForContainer(hit, projectRows)
    const ports: ContainerPortMapping[] = hit.ports
    const note =
      action === 'start'
        ? 'starting will publish the mapped host ports again'
        : `${action} makes the published host ports ${ports.length > 0 ? ports.map((p) => p.host).join(', ') : '—'} unavailable while stopped`
    return {
      confirmRequired: true,
      impacts: {
        name: hit.name,
        image: hit.image,
        state: hit.state,
        ports,
        project: match !== null ? match.name : undefined,
        note,
      },
    }
  }

  // 执行用容器真名（用户输入可能是 id 前缀），docker CLI 输出常走 stderr
  const res = await run('docker', containerActionArgs(action, hit.name), { timeoutMs: DOCKER_ACTION_TIMEOUT_MS })
  const detail = (res.stderr || res.stdout || '').trim().slice(0, 300)
  if (res.code !== 0 || res.timedOut) {
    const reason =
      detail.length > 0
        ? detail
        : res.timedOut
          ? `docker ${action} timed out after ${DOCKER_ACTION_TIMEOUT_MS}ms`
          : `docker ${action} exited with ${res.code}`
    return { ok: false, name: hit.name, action, error: reason }
  }

  // 完成后刷新 containers 缓存（沿用 scanService upsert 逻辑；失败不影响动作结果）
  try {
    const fresh = await listContainers()
    const row = fresh.find((c) => c.dockerId === hit.dockerId)
    if (row !== undefined) {
      const projectRows = db.prepare('SELECT id, name FROM projects').all() as { id: number; name: string }[]
      const match = matchProjectForContainer(row, projectRows)
      upsertContainer(db, row, match !== null ? match.id : null)
    }
  } catch {
    // 缓存刷新失败仅跳过（约束 #25），下次全量扫描会再对齐
  }

  return { ok: true, name: hit.name, action, detail: detail.length > 0 ? detail : `container ${hit.name} ${action}ed` }
}

/**
 * 容器日志只读拉取（docs/09 §9 docker:logs）：
 *  - daemon 不可用 → { ok:false, text:'', error: reason } 结构化降级；
 *  - `docker logs --tail <n> [--since <s>s] <name>`（n ≤ 500，超时 30s）；
 *  - stdout/stderr 合并（docker 常把日志写 stderr）；超 64KB 截断并置 truncated。
 */
export async function containerLogs(
  name: string,
  opts: { tail?: number; since?: number } = {},
): Promise<DockerLogsResult> {
  const target = name.trim()
  const tail = clampLogsTail(opts.tail)
  const info = await dockerInfo()
  if (!info.daemonAvailable) {
    return { ok: false, name: target, tail, text: '', error: info.reason ?? 'docker daemon unavailable' }
  }

  const res = await run('docker', containerLogsArgs(target, tail, opts.since), {
    timeoutMs: DOCKER_LOGS_TIMEOUT_MS,
  })
  const raw = [res.stdout, res.stderr]
    .filter((s) => s.trim().length > 0)
    .join('\n')
    .trimEnd()

  if (res.code !== 0 || res.timedOut) {
    const error =
      res.timedOut
        ? `docker logs timed out after ${DOCKER_LOGS_TIMEOUT_MS}ms`
        : (res.stderr || res.stdout || `docker logs exited with ${res.code}`).trim().slice(0, 300)
    return { ok: false, name: target, tail, text: raw.slice(0, DOCKER_LOGS_TEXT_LIMIT), error }
  }
  if (raw.length > DOCKER_LOGS_TEXT_LIMIT) {
    return { ok: true, name: target, tail, text: raw.slice(0, DOCKER_LOGS_TEXT_LIMIT), truncated: true }
  }
  return { ok: true, name: target, tail, text: raw }
}
