/**
 * docker.ts — Docker 只读探测 adapter（docs/02 §1/§4，约束 #19/#26）。
 *
 * - "CLI 在、daemon 不在"是常态而非异常：dockerInfo 以结构化 DockerStatus 表达，
 *   绝不 throw；listContainers 在 daemon 不通时返回空数组（配合 DockerStatus 判断）；
 * - format 字符串（'{{json .}}'）为静态字面量，出现在 args 数组中，无任何拼接。
 */

import { run } from '../core/exec.ts'
import type { ContainerPortMapping, ContainerRecord, DockerImageInfo, DockerStatus } from '../../shared/types.ts'

// ---------------------------------------------------------------------------
// 内部小工具
// ---------------------------------------------------------------------------

/** stderr/stdout 摘要（剥 NUL、取首行、截断），用于降级 reason。
 * Step 8c F4：上限 200 → 2000。200 字符恰好在 docker daemon 报错中部截断出悬垂
 * "…"，且 UI 侧已有 line-clamp + Show more（ExpandableText）负责折叠展示，
 * 数据层应保留足够全文供展开查看。 */
function summarize(text: string): string {
  const firstLine = text
    .replace(/\u0000/g, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  const line = firstLine ?? ''
  return line.length > 2000 ? `${line.slice(0, 2000)}…` : line
}

function asVersionString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

// ---------------------------------------------------------------------------
// docker version
// ---------------------------------------------------------------------------

/** `--format` 静态字面量：整段 client/server 状态 JSON。 */
const DOCKER_VERSION_FORMAT = '{{json .}}'

interface DockerVersionJson {
  Client?: { Version?: unknown }
  Server?: { Version?: unknown }
}

/**
 * Docker 可用性探测：
 *  - CLI 缺失（spawn ENOENT，code=-1）        → { cliAvailable:false }
 *  - CLI 在、daemon 不通（非零退出 / Server:null）→ { cliAvailable:true, daemonAvailable:false, reason }
 *  - 全通                                      → { cliAvailable:true, daemonAvailable:true, serverVersion }
 */
export async function dockerInfo(): Promise<DockerStatus> {
  const res = await run('docker', ['version', '--format', DOCKER_VERSION_FORMAT])
  if (res.timedOut) {
    return { cliAvailable: true, daemonAvailable: false, reason: 'docker version timed out' }
  }
  if (res.code === -1) {
    // exec 内核约定：spawn 失败（如 ENOENT）映射 code=-1
    return { cliAvailable: false, daemonAvailable: false, reason: 'docker CLI not found or failed to start' }
  }
  if (res.code !== 0) {
    const reason = summarize(res.stderr) || summarize(res.stdout)
    return {
      cliAvailable: true,
      daemonAvailable: false,
      reason: reason.length > 0 ? reason : `docker version exited with ${res.code}`,
    }
  }

  let parsed: DockerVersionJson | null = null
  try {
    parsed = JSON.parse(res.stdout) as DockerVersionJson
  } catch {
    parsed = null
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { cliAvailable: true, daemonAvailable: false, reason: 'docker version output was not valid JSON' }
  }

  const clientVersion = asVersionString(parsed.Client?.Version)
  const serverVersion = asVersionString(parsed.Server?.Version)
  if (serverVersion === undefined) {
    const reason = summarize(res.stderr)
    return {
      cliAvailable: true,
      daemonAvailable: false,
      clientVersion,
      reason: reason.length > 0 ? reason : 'docker daemon unreachable (server section absent)',
    }
  }
  return { cliAvailable: true, daemonAvailable: true, clientVersion, serverVersion }
}

// ---------------------------------------------------------------------------
// docker ps -a
// ---------------------------------------------------------------------------

/** `--format` 静态字面量：每行一个容器的 JSON 对象。 */
const DOCKER_PS_FORMAT = '{{json .}}'

/**
 * 解析 Ports 字段：`0.0.0.0:5432->5432/tcp, :::5432->5432/tcp` → hostPort/container/proto；
 * 仅暴露未映射的 `5432/tcp` 无 host 侧，跳过；IPv6 重复映射去重。
 */
function parsePorts(field: string): ContainerPortMapping[] {
  const mappings: ContainerPortMapping[] = []
  const seen = new Set<string>()
  for (const part of field.split(',')) {
    const m = part.trim().match(/:(\d+)->(\d+)\/(tcp|udp)/i)
    if (m === null) continue
    const proto = m[3].toLowerCase() === 'udp' ? 'udp' : 'tcp'
    const key = `${m[1]}:${m[2]}:${proto}`
    if (seen.has(key)) continue
    seen.add(key)
    const host = Number.parseInt(m[1], 10)
    const container = Number.parseInt(m[2], 10)
    if (!Number.isFinite(host) || !Number.isFinite(container)) continue
    mappings.push({ host, container, proto })
  }
  return mappings
}

/**
 * 解析 docker ps json 的 Labels 字段：`"k1=v1,k2=v2"` → 键值表。
 * 归因依赖 com.docker.compose.project（Service 层使用）；无 label 时返回 undefined。
 */
function parseLabels(field: string): Record<string, string> | undefined {
  if (field.trim().length === 0) return undefined
  const labels: Record<string, string> = {}
  for (const part of field.split(',')) {
    const idx = part.indexOf('=')
    if (idx <= 0) continue
    const key = part.slice(0, idx).trim()
    const value = part.slice(idx + 1).trim()
    if (key.length === 0) continue
    labels[key] = value
  }
  return Object.keys(labels).length > 0 ? labels : undefined
}

/**
 * 全部容器（含停止）：`docker ps -a --format '{{json .}}'` 逐行 JSON 解析。
 * daemon 不通 / CLI 缺失 / 超时 → 空数组（是否降级由调用方结合 dockerInfo 判断）。
 * 返回记录尚未落库：id=0，createdAt/updatedAt 为探测时刻（unix 秒）。
 */
export async function listContainers(): Promise<ContainerRecord[]> {
  const res = await run('docker', ['ps', '-a', '--format', DOCKER_PS_FORMAT])
  if (res.code !== 0 || res.timedOut) return []

  const nowSec = Math.floor(Date.now() / 1000)
  const records: ContainerRecord[] = []
  for (const rawLine of res.stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue // 单行损坏只跳过该行（约束 #25）
    }
    const dockerId = asVersionString(obj.ID)
    const name = asVersionString(obj.Names)
    if (dockerId === undefined || name === undefined) continue
    records.push({
      id: 0,
      dockerId,
      name,
      image: asVersionString(obj.Image),
      state: asVersionString(obj.State),
      ports: parsePorts(asVersionString(obj.Ports) ?? ''),
      labels: parseLabels(asVersionString(obj.Labels) ?? ''),
      createdAt: nowSec,
      updatedAt: nowSec,
    })
  }
  return records
}

// ---------------------------------------------------------------------------
// docker images（S4：只读探测扩展，docs/09 §8.1；镜像不落库，瞬时读）
// ---------------------------------------------------------------------------

/** `--format` 静态字面量：每行一个镜像的 JSON 对象。 */
const DOCKER_IMAGES_FORMAT = '{{json .}}'

interface DockerImageJson {
  Repository?: unknown
  Tag?: unknown
  ID?: unknown
  Size?: unknown
  CreatedAt?: unknown
  CreatedSince?: unknown
}

/**
 * 全部镜像：`docker images --format '{{json .}}'` 逐行 JSON 解析。
 * daemon 不通 / CLI 缺失 / 超时 → 空数组（是否降级由调用方结合 dockerInfo 判断）。
 * created 取 CreatedSince（人类可读）并回退 CreatedAt；悬空镜像 repository 为 `<none>` 原样保留。
 */
export async function listImages(): Promise<DockerImageInfo[]> {
  const res = await run('docker', ['images', '--format', DOCKER_IMAGES_FORMAT])
  if (res.code !== 0 || res.timedOut) return []

  const images: DockerImageInfo[] = []
  for (const rawLine of res.stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    let obj: DockerImageJson
    try {
      obj = JSON.parse(line) as DockerImageJson
    } catch {
      continue // 单行损坏只跳过该行（约束 #25）
    }
    const imageId = asVersionString(obj.ID)
    if (imageId === undefined) continue
    const createdSince = asVersionString(obj.CreatedSince)
    const createdAt = asVersionString(obj.CreatedAt)
    images.push({
      repository: asVersionString(obj.Repository) ?? '<none>',
      tag: asVersionString(obj.Tag) ?? '<none>',
      imageId,
      size: asVersionString(obj.Size) ?? '',
      createdAt: createdSince ?? createdAt ?? '',
    })
  }
  return images
}
