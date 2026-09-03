/**
 * tools/wsl.ts — devhub.wsl.status / devhub.wsl.distributions（docs/08 §6.9/§6.10，决策 D2）。
 */

import { wslDistributions, wslStatusInfo } from '../../services/wslService.ts'
import { defineNoArgTool } from '../toolkit.ts'
import type { ToolDefinition } from '../toolkit.ts'

const status: ToolDefinition = defineNoArgTool(
  'devhub.wsl.status',
  'WSL availability summary: whether wsl.exe is reachable and which distribution names exist. Unavailability is a structured result, not an error.',
  async () => {
    const info = await wslStatusInfo()
    const summary =
      info.available === true
        ? `WSL available — distros: ${info.distros.length > 0 ? info.distros.join(', ') : '(none installed)'}`
        : `WSL unavailable — ${info.detail ?? 'wsl.exe could not be probed'}`
    return { data: info, summary }
  },
)

const distributions: ToolDefinition = defineNoArgTool(
  'devhub.wsl.distributions',
  'Every WSL distribution with live state/version/default flags plus per-distro tool summaries from the latest DevHub detect snapshot. Unprobed fields are null, never guessed; a missing snapshot is reported via toolSnapshot:"missing" with a hint.',
  async () => {
    const info = await wslDistributions()
    const lines = info.distributions.map((distro) => {
      const tools =
        distro.tools === null
          ? 'no tool snapshot'
          : `${distro.tools.filter((tool) => tool.state === 'installed').length} installed tools (snapshot at ${distro.snapshotAt ?? 'n/a'})`
      return `- ${distro.name} (WSL ${distro.version}, ${distro.state}${distro.isDefault === true ? ', default' : ''}) — ${tools}`
    })
    const snapshotNote = info.toolSnapshot === 'missing' ? ` ${info.hint ?? ''}` : ''
    const summary =
      info.available === false
        ? `WSL unavailable — ${info.reason ?? 'unknown reason'}.`
        : `${info.distributions.length} distribution(s).${snapshotNote}\n${lines.join('\n')}`
    return { data: info, summary }
  },
)

export const wslTools: ToolDefinition[] = [status, distributions]
