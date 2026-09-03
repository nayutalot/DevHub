/**
 * tools/docker.ts — devhub.docker.status / devhub.docker.containers（docs/08 §6.7/§6.8）。
 */

import { dockerContainers, dockerStatus } from '../../services/dockerService.ts'
import { defineNoArgTool } from '../toolkit.ts'
import type { ToolDefinition } from '../toolkit.ts'

const status: ToolDefinition = defineNoArgTool(
  'devhub.docker.status',
  'Docker availability: CLI and daemon levels plus client/server versions. Daemon unavailability is a normal condition reported as a structured result (available:false + reason), not an error.',
  async () => {
    const info = await dockerStatus()
    const summary =
      info.available === true
        ? `Docker available — client ${info.clientVersion ?? '?'}, server ${info.serverVersion ?? '?'}`
        : `Docker unavailable — ${info.reason ?? 'unknown reason'} (cli: ${info.cliAvailable ? 'present' : 'missing'}, daemon: ${info.daemonAvailable ? 'reachable' : 'unreachable'})`
    return { data: info, summary }
  },
)

const containers: ToolDefinition = defineNoArgTool(
  'devhub.docker.containers',
  'List all Docker containers (live probe) with port mappings and project attribution. Unattributed containers are explicitly project "unknown" — never guessed. Daemon unavailability returns a structured empty result.',
  async () => {
    const info = await dockerContainers()
    const lines = info.containers.map((container) => {
      const ports = container.ports.map((port) => `${port.host}->${port.container}/${port.proto}`).join(', ')
      return `- ${container.name} (${container.image ?? '—'}) ${container.state ?? '?'} — ports: ${ports.length > 0 ? ports : '—'} — project: ${container.project}`
    })
    const summary =
      info.available === false
        ? `Docker unavailable — ${info.reason ?? 'unknown reason'}; container list empty.`
        : `${info.containers.length} container(s).\n${lines.join('\n')}`
    return { data: info, summary }
  },
)

export const dockerTools: ToolDefinition[] = [status, containers]
