/**
 * tools/git.ts — devhub.git.status（docs/08 §6.11）。
 *
 * path 白名单：自由路径仅在此 tool 的可选 path 出现，且必须命中已知项目
 * winPath/wslPath（归一化比对），禁止任意路径探测（docs/08 §10.2）。
 */

import { z } from 'zod'
import { gitStatusForProject } from '../../services/gitService.ts'
import { defineTool } from '../toolkit.ts'
import type { ToolDefinition } from '../toolkit.ts'

const status: ToolDefinition = defineTool(
  'devhub.git.status',
  'Live git status for one DevHub project: branch, upstream, ahead/behind, HEAD sha, remote URL and working-tree classification (modified vs untracked counts). Optional "path" must match a known project path (whitelist) — arbitrary path probing is rejected. A non-repository target is a structured result, not an error.',
  {
    projectId: z.number().int().positive(),
    path: z.string().min(1).optional(),
  },
  async (args) => {
    const result = await gitStatusForProject(args.projectId, args.path)
    const lines = [
      `Git status for "${result.project}" (id ${result.projectId}) at ${result.path}:`,
      result.notAGitRepository === true
        ? '- not a git repository'
        : `- branch: ${result.repository?.branch ?? '?'}${result.repository?.upstream !== undefined ? ` (upstream: ${result.repository.upstream})` : ''} — ahead ${result.repository?.ahead ?? 0}, behind ${result.repository?.behind ?? 0}`,
    ]
    if (result.repository?.headSha !== undefined) lines.push(`- head: ${result.repository.headSha}`)
    if (result.repository?.remoteUrl !== undefined) lines.push(`- remote: ${result.repository.remoteUrl}`)
    if (result.notAGitRepository !== true) {
      lines.push(
        `- working tree: ${result.workingTree.clean ? 'clean' : 'dirty'} — modified: ${result.workingTree.modifiedCount}, untracked: ${result.workingTree.untrackedCount}`,
      )
    }
    return { data: result, summary: lines.join('\n') }
  },
)

export const gitTools: ToolDefinition[] = [status]
