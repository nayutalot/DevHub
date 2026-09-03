/**
 * traySummary.ts — 托盘「查看 Agent 摘要」tooltip 文案纯函数（AC5，docs/12 §10）。
 *
 * 输入 = agentControlService.getAgentSummaryCounts()（真实库投影），输出 = 托盘
 * tooltip / 菜单项摘要文案。抽成纯函数以供 smoke 四态输入输出断言（交付物 7）；
 * electron-free：零 electron import。
 */

import type { AgentSummaryCounts } from './agentControlService.ts'

/**
 * 摘要文案四态（有监控/无监控 × 有会话/无会话 都有确定输出）：
 * - 无会话 + 监控开：`DevHub — Agents: no sessions (monitoring on)`
 * - 无会话 + 监控关：`DevHub — Agents: no sessions (monitoring off)`
 * - 有会话 + 监控开：`DevHub — Agents: <active>/<total> active · <w> waiting input · <a> approval`
 *   （waiting/approval 为 0 的段省略；两个计数都为 0 时只保留 active 段）
 * - 有会话 + 监控关：`DevHub — Agents: <active>/<total> active (monitoring off)`
 */
export function agentSummaryText(counts: AgentSummaryCounts): string {
  const head = 'DevHub — Agents:'
  if (counts.totalSessions === 0) {
    return `${head} no sessions (monitoring ${counts.monitorEnabled ? 'on' : 'off'})`
  }
  const activePart = `${counts.activeSessions}/${counts.totalSessions} active`
  if (!counts.monitorEnabled) {
    return `${head} ${activePart} (monitoring off)`
  }
  const parts: string[] = [activePart]
  if (counts.waitingInput > 0) parts.push(`${counts.waitingInput} waiting input`)
  if (counts.approvalRequired > 0) parts.push(`${counts.approvalRequired} approval`)
  return `${head} ${parts.join(' · ')}`
}
