/**
 * resources/environment.ts — devhub://environment（docs/08 §7）。
 *
 * DB detect 快照（environments + environment_tools）+ 实时 doctor：
 * Windows 与各 WSL 发行版的工具版本表（tool/version/path/state）、
 * PATH 首位 Python 提示、Docker daemon 状态行、[WARNING]/[ERROR]/[INFO] 诊断行。
 */

import { listEnvironmentSnapshots, runDoctor } from '../../services/environmentService.ts'
import { dockerStatus } from '../../services/dockerService.ts'
import type { EnvironmentWithTools } from '../../../shared/types.ts'
import { mdCell, mdSource, mdTable, sanitizeFreeText, truncateText } from '../projection.ts'

/** 'windows' → 'Windows'；'wsl:Ubuntu' → 'WSL: Ubuntu'（表格标题形态）。 */
function displayEnvName(name: string): string {
  if (name === 'windows') return 'Windows'
  if (name.startsWith('wsl:')) return `WSL: ${name.slice(4)}`
  return name
}

function environmentSection(env: EnvironmentWithTools): string {
  const pythons = env.tools.filter((tool) => tool.tool === 'python' && tool.state === 'installed')
  const rows = env.tools.map((tool) => {
    const nameCell =
      env.name === 'windows' && pythons.length > 0 && tool === pythons[0] ? `${tool.tool} (PATH-first)` : tool.tool
    return [mdCell(nameCell), mdCell(tool.version), mdCell(tool.path), mdCell(tool.state)]
  })
  const pythonNote =
    env.name === 'windows' && pythons.length >= 2
      ? `Multiple Python versions installed; PATH resolves to ${pythons[0].version ?? 'unknown'} (${pythons[0].path ?? 'unknown path'}).`
      : ''

  return [
    `## ${displayEnvName(env.name)}`,
    '',
    mdSource(env.detectedAt),
    '',
    mdTable(['tool', 'version', 'path', 'state'], rows),
    pythonNote.length > 0 ? `\n${pythonNote}` : '',
  ].join('\n')
}

export async function renderEnvironment(): Promise<string> {
  const [snapshots, doctor, docker] = await Promise.all([listEnvironmentSnapshots(), runDoctor(), dockerStatus()])

  const snapshotSections =
    snapshots.length > 0
      ? snapshots.map(environmentSection).join('\n\n')
      : 'No environment snapshot yet — run the `devhub.environment.detect` tool first, then re-read this resource.'

  const dockerLine =
    docker.available === true
      ? `Docker daemon available (client ${docker.clientVersion ?? '?'}, server ${docker.serverVersion ?? '?'})`
      : `Docker: daemon unreachable (${truncateText(sanitizeFreeText(docker.reason) ?? 'unknown reason')})`

  const doctorLines =
    doctor.checks.length > 0
      ? doctor.checks
          .map(
            (check) =>
              `- [${check.severity.toUpperCase()}] ${sanitizeFreeText(check.title) ?? ''}${check.detail !== undefined ? ` — ${sanitizeFreeText(check.detail)}` : ''}`,
          )
          .join('\n')
      : '- no findings'

  return [
    '# DevHub environment',
    '',
    snapshotSections,
    '',
    '## Docker',
    '',
    mdSource(),
    '',
    dockerLine,
    '',
    '## Doctor',
    '',
    mdSource(),
    '',
    doctorLines,
    '',
  ].join('\n')
}
