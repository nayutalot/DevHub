/**
 * resources/docker.ts — devhub://docker（docs/08 §7）。
 *
 * daemon 状态行（不可用 → `Docker: daemon unreachable (<reason截断>)`）+
 * 容器表：name/image/state/ports/project。
 */

import { dockerContainers, dockerStatus } from '../../services/dockerService.ts'
import { mdSource, mdTable, sanitizeFreeText, truncateText } from '../projection.ts'

export async function renderDocker(): Promise<string> {
  const status = await dockerStatus()

  if (status.available === false) {
    const reason = truncateText(sanitizeFreeText(status.reason) ?? 'unknown reason')
    return ['# DevHub docker', '', mdSource(), '', `Docker: daemon unreachable (${reason})`, ''].join('\n')
  }

  const containersInfo = await dockerContainers()
  const rows = containersInfo.containers.map((container) => [
    container.name,
    container.image ?? '—',
    container.state ?? '—',
    container.ports.map((port) => `${port.host}->${port.container}/${port.proto}`).join(', '),
    container.project,
  ])

  return [
    '# DevHub docker',
    '',
    mdSource(),
    '',
    `Docker daemon available (client ${status.clientVersion ?? '?'}, server ${status.serverVersion ?? '?'})`,
    '',
    mdTable(['name', 'image', 'state', 'ports', 'project'], rows),
    '',
  ].join('\n')
}
