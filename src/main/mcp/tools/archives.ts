/**
 * tools/archives.ts — devhub.archives.list（docs/09 §10 MCP 只读扩展，docs/10 §8）。
 *
 * 只读口径：archiveService.archiveHistory(limit) = archive_runs 最近 N 条
 * （缺省 20，上限 100；>100 由 zod 拒绝为 BAD_PAYLOAD，与 IPC archive:history
 * 同一口径——IPC 处 BAD_PAYLOAD、MCP 处 zod → BAD_PAYLOAD，语义等价）。
 * 投影字段与 IPC 同构（oldPath/newPath 为归档事实路径，脱敏/截断由 server 层
 * sanitizeDeep 红线统一执行）。
 */

import { z } from 'zod'
import { archiveHistory } from '../../services/archiveService.ts'
import { relativeTime } from '../projection.ts'
import { defineTool } from '../toolkit.ts'
import type { ToolDefinition } from '../toolkit.ts'

/** MCP 侧缺省条数（任务规格：默认 20；服务层上限 ARCHIVE_HISTORY_LIMIT=100）。 */
const ARCHIVES_LIST_DEFAULT_LIMIT = 20

const list: ToolDefinition = defineTool(
  'devhub.archives.list',
  'Recent project-archive runs, most recent first: project, old/new location, status (running/done/failed/rolled-back), fixed/external file counts, residual references and undo availability. Optional "limit" defaults to 20 and is capped at 100.',
  {
    limit: z.number().int().positive().max(100).optional(),
  },
  async (args) => {
    const result = archiveHistory(args.limit ?? ARCHIVES_LIST_DEFAULT_LIMIT)
    const lines = result.runs.map((r) => {
      const finished = r.finishedAt !== null ? `finished ${relativeTime(r.finishedAt)}` : 'still running'
      const undo = r.undoEntries !== null ? `, undo: ${r.undoEntries} file(s)` : ''
      return `- #${r.id} ${r.projectName} — ${r.oldPath} → ${r.newPath} — ${r.status} (${finished}, fixed ${r.fixedFiles}, external ${r.externalFiles}${undo})`
    })
    return {
      data: { runs: result.runs, count: result.runs.length },
      summary:
        result.runs.length === 0
          ? 'No archive runs recorded yet.'
          : `${result.runs.length} archive run(s), most recent first:\n${lines.join('\n')}`,
    }
  },
)

export const archiveTools: ToolDefinition[] = [list]
