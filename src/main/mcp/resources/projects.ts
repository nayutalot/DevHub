/**
 * resources/projects.ts — devhub://projects（docs/08 §7）。
 *
 * 项目表：name / path / runtime / git 分支+dirty / 容器 running/total / 最近打开。
 * 数据来自 listMcpSummaries()（§6.3 投影）。
 */

import { listMcpSummaries } from '../../services/projectService.ts'
import { mdSource, mdTable, relativeTime } from '../projection.ts'

export async function renderProjects(): Promise<string> {
  const projects = await Promise.resolve(listMcpSummaries())

  const rows = projects.map((p) => [
    `${p.name} [${p.slug}]`,
    p.winPath ?? p.wslPath ?? '—',
    p.runtimeHint ?? '—',
    p.environment !== null ? p.environment.name : '—',
    p.git.hasGit
      ? `${p.git.branch ?? '?'}${p.git.dirtyCount > 0 ? ` (dirty: ${p.git.dirtyCount})` : ' (clean)'} — scan at ${p.git.lastScanAt ?? 'n/a'}`
      : 'no git',
    `${p.docker.containersRunning}/${p.docker.containersTotal}`,
    relativeTime(p.lastOpenedAt),
  ])

  return [
    '# DevHub projects',
    '',
    mdSource(),
    '',
    mdTable(['project', 'path', 'runtime', 'environment', 'git', 'docker running/total', 'last opened'], rows),
    '',
  ].join('\n')
}
