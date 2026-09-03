/**
 * resources/dashboard.ts — devhub://dashboard（docs/08 §7）。
 *
 * 四组计数 + Recent projects + warnings（severity 前缀）；数据与 UI Dashboard 同源。
 */

import { dashboardSummary } from '../../services/dashboardService.ts'
import { mdSource, mdTable, relativeTime, sanitizeFreeText } from '../projection.ts'

export async function renderDashboard(): Promise<string> {
  const summary = await dashboardSummary()

  const counters = mdTable(
    ['counter', 'value'],
    [
      ['projects', String(summary.projectCount)],
      ['dirty repositories', String(summary.dirtyRepoCount)],
      ['docker containers running/total', `${summary.dockerRunning}/${summary.dockerTotal}`],
      ['services seen recently', String(summary.serviceCount)],
    ],
  )

  const recent = mdTable(
    ['project', 'path', 'last opened'],
    summary.recentProjects.map((p) => [p.name, p.winPath ?? p.wslPath ?? '—', relativeTime(p.lastOpenedAt)]),
  )

  const warnings =
    summary.warnings.length > 0
      ? summary.warnings
          .map((w) => `- [${w.severity.toUpperCase()}] ${sanitizeFreeText(w.title) ?? ''}${w.detail !== undefined ? ` — ${sanitizeFreeText(w.detail)}` : ''}`)
          .join('\n')
      : '- none'

  return [
    '# DevHub dashboard',
    '',
    mdSource(),
    '',
    '## Counters',
    '',
    counters,
    '',
    `## WSL: ${summary.wslStatus.available ? `available (${summary.wslStatus.distros.join(', ') || 'no distros'})` : `unavailable — ${sanitizeFreeText(summary.wslStatus.detail) ?? 'unknown'}`}`,
    '',
    '## Recent projects',
    '',
    recent,
    '',
    '## Warnings',
    '',
    warnings,
    '',
  ].join('\n')
}
