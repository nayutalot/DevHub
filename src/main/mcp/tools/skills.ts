/**
 * tools/skills.ts — devhub.skills.list（docs/09 §10 MCP 只读扩展）。
 *
 * 只读口径（docs/09 §1 元数据读库 / 物理状态读盘）：
 * - skills 镜像来自 skillService.listSkills()（SQLite 唯一事实源，纯库读）；
 * - agents + 链接状态汇总来自 skillService.agentScans()（Windows fs 实测 /
 *   WSL companion 缓存投影 + skill_links 缓存回写，与 IPC skills:agents 同一函数，
 *   绝不在 MCP 层另算一套探测）；
 * - 投影红线：agent 摘要刻意省略 skillsDir/agentsDir/agentFiles 等本机路径与
 *   文件清单字段（vault 外路径不外泄；skills 无凭据面），companion 态只取
 *   probe/available/stale/reason —— stale 标注如实透传，绝不猜测实时态。
 */

import { z } from 'zod'
import { agentScans, listSkills } from '../../services/skillService.ts'
import { defineTool } from '../toolkit.ts'
import type { ToolDefinition } from '../toolkit.ts'
import type { SkillAgentScanView } from '../../../shared/types.ts'

/** SkillAgentScanView → MCP 摘要投影（刻意省略本机路径/文件清单字段，docs/09 §10）。 */
function agentSummary(agent: SkillAgentScanView): {
  id: number
  name: string
  platform: 'windows' | 'linux'
  enabled: boolean
  include: string[]
  probe: SkillAgentScanView['probe']
  available: boolean
  stale?: true
  reason?: string
  links: Record<string, SkillAgentScanView['links'][string]>
  counts: SkillAgentScanView['counts']
} {
  return {
    id: agent.id,
    name: agent.name,
    platform: agent.platform,
    enabled: agent.enabled,
    include: agent.include,
    probe: agent.probe,
    available: agent.available,
    ...(agent.stale === true ? { stale: true as const } : {}),
    ...(agent.reason !== undefined ? { reason: agent.reason } : {}),
    links: agent.links,
    counts: agent.counts,
  }
}

const list: ToolDefinition = defineTool(
  'devhub.skills.list',
  'Skill vault mirror and agent link overview: skill rows (name/description/vault-relative path/updated) from the DevHub database plus per-agent link-state summaries (five-state counts, per-skill link states, stale flag for WSL companion-cache snapshots). Read-only; out-of-vault local paths are deliberately not projected.',
  {
    limit: z.number().int().positive().optional(),
  },
  async (args) => {
    const listResult = listSkills()
    const agentsResult = await agentScans()
    const skills = args.limit !== undefined ? listResult.skills.slice(0, args.limit) : listResult.skills
    const agents = agentsResult.agents.map(agentSummary)
    const staleAgents = agents.filter((a) => a.stale === true).length
    const lines = skills.map((s) => `- ${s.name}${s.description.length > 0 ? ` — ${s.description}` : ''}`)
    const agentLines = agents.map((a) => {
      const c = a.counts
      const state = a.available
        ? `linked ${c.linked}, missing ${c.missing}, wrong-target ${c.wrongTarget}, real-dir ${c.realDir}, vault-missing ${c.vaultMissing}`
        : (a.reason ?? 'unavailable')
      return `- ${a.name} (${a.platform}${a.enabled ? '' : ', disabled'}, probe: ${a.probe}${a.stale === true ? ', stale' : ''}) — ${state}`
    })
    const summary = [
      `${listResult.skills.length} skill(s) in the vault mirror${args.limit !== undefined && args.limit < listResult.skills.length ? ` (showing first ${skills.length})` : ''}.`,
      ...lines,
      `${agents.length} agent(s)${staleAgents > 0 ? ` (${staleAgents} with stale companion snapshot)` : ''}:`,
      ...agentLines,
    ].join('\n')
    return {
      data: {
        count: listResult.skills.length,
        ...(args.limit !== undefined ? { returned: skills.length } : {}),
        skills,
        agents,
        agentCount: agents.length,
      },
      summary,
    }
  },
)

export const skillTools: ToolDefinition[] = [list]
