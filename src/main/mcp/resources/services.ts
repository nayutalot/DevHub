/**
 * resources/services.ts — devhub://services（docs/08 §7）。
 *
 * 端口表：port / process / origin / project（归因不到显式 unknown）/ lastSeen 相对时间；
 * 附数据时效声明（最近一次快照，非实时）。
 */

import { listServices } from '../../services/servicesService.ts'
import { mdCell, mdSource, mdTable, relativeTime } from '../projection.ts'
import { unknownableName } from '../projection.ts'

export async function renderServices(): Promise<string> {
  const rows0 = await Promise.resolve(listServices())

  const rows = rows0.map((row) => [
    String(row.port),
    mdCell(row.processName),
    mdCell(row.commandLine),
    row.origin,
    unknownableName(row.projectName),
    relativeTime(row.lastSeenAt),
  ])

  return [
    '# DevHub services',
    '',
    mdSource(),
    '',
    mdTable(['port', 'process', 'command line', 'origin', 'project', 'last seen'], rows),
    '',
    'Data freshness: this table reflects the most recent DevHub services snapshot, not a live probe. Run a services refresh from the DevHub UI for fresh attribution, then re-read.',
    '',
  ].join('\n')
}
