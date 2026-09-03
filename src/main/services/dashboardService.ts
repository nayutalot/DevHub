/**
 * dashboardService.ts — dashboard:summary 汇总（docs/04）。
 *
 * 数字与 DB 联查严格一致；docker/wsl 实时探测（daemon 不可用 → 0/0 + warning）；
 * warnings = DoctorCheck 中 severity 为 warning/error 的子集 + dirty 数量提示，
 * 一律使用统一三态 DashboardWarning（Step 5 裁决修订 #1：info / warning / error）。
 */

import type { DatabaseSync } from 'node:sqlite'
import { dockerInfo, listContainers } from '../adapters/docker.ts'
import { wslStatus } from '../adapters/wsl.ts'
import { getDatabase } from '../db/index.ts'
import type { DashboardSummary, DashboardWarning } from '../../shared/types.ts'
import { nowSec } from './internal.ts'
import { runDoctor } from './environmentService.ts'
import { listProjects } from './projectService.ts'
import { SERVICE_RECENCY_SECONDS } from './servicesService.ts'

function scalar(db: DatabaseSync, sql: string, ...params: (string | number)[]): number {
  const row = db.prepare(sql).get(...params) as { c: number } | undefined
  return Number(row?.c ?? 0)
}

export async function dashboardSummary(): Promise<DashboardSummary> {
  const db = getDatabase()
  const projectCount = scalar(db, 'SELECT COUNT(*) AS c FROM projects')
  const dirtyRepoCount = scalar(db, 'SELECT COUNT(*) AS c FROM repositories WHERE is_dirty = 1')
  const serviceCount = scalar(
    db,
    'SELECT COUNT(*) AS c FROM services WHERE last_seen_at >= ?',
    nowSec() - SERVICE_RECENCY_SECONDS,
  )

  // docker 实时探测：daemon 不可用 → 0/0（结构化降级，UI 显示 daemon unreachable）
  let dockerRunning = 0
  let dockerTotal = 0
  const docker = await dockerInfo()
  if (docker.daemonAvailable) {
    try {
      const containers = await listContainers()
      dockerTotal = containers.length
      dockerRunning = containers.filter((c) => c.state === 'running').length
    } catch {
      // 容器列表瞬时失败降级为 0/0（约束 #25/#26）
    }
  }

  const wsl = await wslStatus()
  // F5（Step 8c）：Recent 面板必须能显示相对时间。项目从未打开过时 last_opened_at
  // 为 NULL，回退 updated_at（与列表排序 COALESCE 语义一致）。仅影响 dashboard:summary
  // 的投影；projects:get 的 "Last opened" 仍保持真实打开时间语义。
  const recentProjects = listProjects()
    .slice(0, 5)
    .map((p) => (p.lastOpenedAt !== undefined ? p : { ...p, lastOpenedAt: p.updatedAt }))

  // warnings：doctor 的 warning/error 子集（含 docker daemon down）+ dirty 数量提示
  const doctor = await runDoctor()
  const warnings: DashboardWarning[] = doctor.checks
    .filter((check) => check.severity === 'warning' || check.severity === 'error')
    .map((check) => ({ severity: check.severity, title: check.title, detail: check.detail }))
  if (dirtyRepoCount > 0) {
    warnings.push({
      severity: 'info',
      title: `${dirtyRepoCount} dirty repositories`,
      detail: 'Git working trees contain uncommitted changes.',
    })
  }

  return {
    projectCount,
    dirtyRepoCount,
    dockerRunning,
    dockerTotal,
    wslStatus: wsl,
    serviceCount,
    recentProjects,
    warnings,
  }
}
