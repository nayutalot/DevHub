/**
 * tools/dashboard.ts — devhub.dashboard.summary（docs/08 §6.12）。
 *
 * 直接复用 dashboardService.dashboardSummary()，不得另算一套：
 * 数字口径与 Electron UI Dashboard 强一致（docs/08 §6.12）。
 */

import { dashboardSummary } from '../../services/dashboardService.ts'
import { defineNoArgTool } from '../toolkit.ts'
import type { ToolDefinition } from '../toolkit.ts'

const summary: ToolDefinition = defineNoArgTool(
  'devhub.dashboard.summary',
  'The DevHub dashboard summary — exactly the numbers the Electron UI Dashboard shows: project count, dirty repositories, docker running/total, WSL status, recent services count, recent projects and warnings.',
  async () => {
    const data = await dashboardSummary()
    const lines = [
      `- projects: ${data.projectCount}`,
      `- dirty repositories: ${data.dirtyRepoCount}`,
      `- docker containers: ${data.dockerRunning}/${data.dockerTotal} running`,
      `- wsl: ${data.wslStatus.available ? `available (${data.wslStatus.distros.join(', ') || 'no distros'})` : `unavailable (${data.wslStatus.detail ?? 'unknown'})`}`,
      `- services (recent window): ${data.serviceCount}`,
      `- recent projects: ${data.recentProjects.map((p) => p.name).join(', ') || '—'}`,
      `- warnings: ${data.warnings.length}`,
    ]
    return { data, summary: `Dashboard summary:\n${lines.join('\n')}` }
  },
)

export const dashboardTools: ToolDefinition[] = [summary]
