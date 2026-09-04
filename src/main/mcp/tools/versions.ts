/**
 * tools/versions.ts — devhub.versions.list（docs/09 §10 MCP 只读扩展）。
 *
 * 只读口径：versionService.listTargets() = 版本目录常量（8 目标）+ version_targets
 * 快照表合并（纯库读）。**绝不 live-check**：未检测过如实显示 unknown + lastCheckedAt
 * null，检测刷新只发生在 DevHub UI / IPC versions:check（变更编排不进 MCP）。
 * catalog 无凭据面（channel 仅为 "npm: <pkg>" / "winget: <id>" 类目录文本），如实投影。
 */

import { listTargets } from '../../services/versionCenter/versionService.ts'
import { defineNoArgTool } from '../toolkit.ts'
import type { ToolDefinition } from '../toolkit.ts'

const list: ToolDefinition = defineNoArgTool(
  'devhub.versions.list',
  'Version center snapshot for the 8 catalog targets: installed/latest version and state (up-to-date/upgradable/unknown/check-failed/detect-only) from the last recorded check. Never performs a live check — "unknown" means not checked yet; refresh happens from the DevHub UI.',
  async () => {
    const { targets } = listTargets()
    const lines = targets.map((t) => {
      const checked = t.lastCheckedAt !== null ? `checked at ${t.lastCheckedAt}` : 'never checked'
      const note = t.note !== undefined ? ` — ${t.note}` : ''
      return `- ${t.name} [${t.id}] (${t.channel}) — installed: ${t.installed ?? '—'}, latest: ${t.latest ?? '—'}, state: ${t.state} (${checked})${note}`
    })
    const upgradable = targets.filter((t) => t.state === 'upgradable')
    const headline =
      upgradable.length > 0
        ? `${targets.length} version target(s), ${upgradable.length} upgradable: ${upgradable.map((t) => t.id).join(', ')}.`
        : `${targets.length} version target(s), none upgradable.`
    return {
      data: { targets, count: targets.length },
      summary: `${headline} Snapshot only — no live check was performed.\n${lines.join('\n')}`,
    }
  },
)

export const versionTools: ToolDefinition[] = [list]
