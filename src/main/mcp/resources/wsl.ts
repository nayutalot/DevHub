/**
 * resources/wsl.ts — devhub://wsl（docs/08 §7）。
 *
 * WSL 可用性 + 发行版表：name/version/state/default/工具摘要（快照标注）。
 */

import { wslDistributions, wslStatusInfo } from '../../services/wslService.ts'
import { mdSource, mdTable, sanitizeFreeText, truncateText } from '../projection.ts'

export async function renderWsl(): Promise<string> {
  const status = await wslStatusInfo()

  if (status.available === false) {
    return [
      '# DevHub WSL',
      '',
      mdSource(),
      '',
      `WSL: unavailable — ${truncateText(sanitizeFreeText(status.detail) ?? 'unknown reason')}`,
      '',
    ].join('\n')
  }

  const info = await wslDistributions()
  const rows = info.distributions.map((distro) => [
    distro.name,
    distro.version,
    distro.state,
    distro.isDefault === true ? 'yes' : 'no',
    distro.tools === null
      ? 'no tool snapshot (run devhub.environment.detect)'
      : `${distro.tools.filter((tool) => tool.state === 'installed').length} installed (snapshot at ${distro.snapshotAt ?? 'n/a'})`,
  ])

  return [
    '# DevHub WSL',
    '',
    mdSource(),
    '',
    'WSL: available',
    '',
    mdTable(['distribution', 'version', 'state', 'default', 'tools'], rows),
    '',
  ].join('\n')
}
