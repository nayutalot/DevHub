/**
 * tools/services.ts — devhub.services.list / devhub.services.inspect（docs/08 §6.5/§6.6）。
 *
 * 归因铁律（§6.6）：归因不到必须显式 'unknown'（resolvedProject 同理），禁止猜测；
 * 本期只读最近一次 services 快照，refresh 能力为 Phase B 候选（docs/08 §16 backlog）。
 */

import { z } from 'zod'
import { findByPort, listServices } from '../../services/servicesService.ts'
import { relativeTime, unknownableName } from '../projection.ts'
import { defineTool } from '../toolkit.ts'
import type { ToolDefinition } from '../toolkit.ts'

/** docs/08 §6.6 固定归因链描述。 */
const ATTRIBUTION_CHAIN = 'port→pid→process→origin→project'

const list: ToolDefinition = defineTool(
  'devhub.services.list',
  'List the most recent services snapshot (port/process/origin/project attribution), optionally filtered by port or projectId. Freshness: reflects the last services refresh, not a live probe.',
  {
    port: z.number().int().min(0).max(65535).optional(),
    projectId: z.number().int().positive().optional(),
  },
  async (args) => {
    const rows = listServices({ port: args.port, projectId: args.projectId })
    const services = rows.map((row) => ({ ...row, project: unknownableName(row.projectName) }))
    const lines = services
      .slice(0, 20)
      .map(
        (row) =>
          `- :${row.port} ${row.processName ?? 'unknown process'} (${row.origin}, pid ${row.pid ?? '—'}) → project: ${row.project}, last seen ${relativeTime(row.lastSeenAt)}`,
      )
    if (services.length > 20) lines.push(`- … ${services.length - 20} more row(s)`)
    return {
      data: { services, count: services.length },
      summary: `${services.length} service row(s) in the last snapshot.\n${lines.join('\n')}`,
    }
  },
)

const inspect: ToolDefinition = defineTool(
  'devhub.services.inspect',
  'Inspect a single port from the most recent services snapshot: full attribution chain port→pid→process→origin→project. Unattributed entries are explicitly "unknown" — never guessed. Empty result means no record in the last snapshot.',
  { port: z.number().int().min(1).max(65535) },
  async (args) => {
    const rows = findByPort(args.port)
    const entries = rows.map((row) => ({
      port: row.port,
      pid: row.pid,
      processName: row.processName,
      commandLine: row.commandLine,
      origin: row.origin,
      projectId: row.projectId,
      projectName: row.projectName,
      project: unknownableName(row.projectName),
      lastSeenAt: row.lastSeenAt,
    }))

    const attributedIds = new Set(rows.filter((row) => row.projectId !== undefined).map((row) => row.projectId))
    let resolvedProject = 'unknown'
    if (attributedIds.size === 1) {
      const hit = rows.find((row) => row.projectId !== undefined)
      resolvedProject = unknownableName(hit?.projectName)
    }

    let snapshotAt: number | null = null
    for (const row of rows) {
      if (row.lastSeenAt !== undefined && (snapshotAt === null || row.lastSeenAt > snapshotAt)) {
        snapshotAt = row.lastSeenAt
      }
    }

    const data: Record<string, unknown> = {
      port: args.port,
      attributionChain: ATTRIBUTION_CHAIN,
      entries,
      resolvedProject,
      snapshotAt,
    }
    if (entries.length === 0) {
      data.note = 'no record in last services snapshot'
    }

    const lines = entries.map(
      (entry) => `- :${entry.port} → pid ${entry.pid ?? '—'} → ${entry.processName ?? 'unknown process'} (${entry.origin}) → project: ${entry.project}`,
    )
    const summary =
      entries.length === 0
        ? `Port ${args.port}: no record in the last DevHub services snapshot (snapshotAt: ${snapshotAt === null ? 'n/a' : snapshotAt}).`
        : `Port ${args.port} attribution (resolved project: ${resolvedProject}):\n${lines.join('\n')}`
    return { data, summary }
  },
)

export const serviceTools: ToolDefinition[] = [list, inspect]
