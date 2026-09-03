/**
 * skills/sync.ts — 双侧同步编排（docs/09 §2；Skill-Manager src/main/sync.ts 归宿）：
 * 1. Windows: add -A → (有 diff) commit "devhub sync <ISO>" → push origin main
 * 2. WSL    : companion sync（add -A → commit → pull --rebase origin main → push origin main）
 * 3. Windows: pull origin main
 * 冲突原样收集进 conflicts，绝不 force；git 不可用/裸仓缺失经调用方前置校验与
 * 结构化降级（expected unavailability 绝不 throw）。
 */

import type { SkillSyncStep } from '../../../shared/types.ts'
import { gitRun } from './execGit.ts'
import { runCompanion } from './wslBridge.ts'

export interface SyncOutcome {
  steps: SkillSyncStep[]
  conflicts: string[]
}

/** companion sync 超时（WSL 冷启动 + git 网络回环，放宽到 180s；约束 #9 显式放宽）。 */
const SYNC_COMPANION_TIMEOUT_MS = 180_000

function detail(r: { stdout: string; stderr: string }): string {
  return (r.stderr || r.stdout || '').trim().slice(-600)
}

export async function syncAll(vaultPath: string, distro: string): Promise<SyncOutcome> {
  const steps: SkillSyncStep[] = []
  const conflicts: string[] = []

  const record = (side: 'windows' | 'wsl', cmd: string, r: { ok: boolean; stdout: string; stderr: string }): void => {
    steps.push({ side, cmd, ok: r.ok, detail: detail(r) })
  }

  // ---- 1. Windows ----
  let r = await gitRun(vaultPath, ['add', '-A'])
  record('windows', 'git add -A', r)
  const st = await gitRun(vaultPath, ['status', '--porcelain'])
  if (st.stdout.trim().length > 0) {
    r = await gitRun(vaultPath, ['commit', '-m', `devhub sync ${new Date().toISOString()}`])
    record('windows', 'git commit', r)
    if (!r.ok) conflicts.push(`windows commit 失败:\n${detail(r)}`)
  } else {
    steps.push({ side: 'windows', cmd: 'git status（无变更，跳过 commit）', ok: true, detail: 'clean' })
  }
  r = await gitRun(vaultPath, ['push', 'origin', 'main'])
  record('windows', 'git push origin main', r)
  if (!r.ok) conflicts.push(`windows push 失败:\n${detail(r)}`)

  // ---- 2. WSL（companion sync）----
  const c = await runCompanion(distro, ['sync'], SYNC_COMPANION_TIMEOUT_MS)
  const p = c.parsed as { ok?: boolean; steps?: { cmd: string; ok: boolean; detail?: string }[]; conflicts?: string[] } | undefined
  if (c.ok && p !== null && typeof p === 'object') {
    for (const s of p.steps ?? []) {
      steps.push({ side: 'wsl', cmd: s.cmd, ok: s.ok, detail: (s.detail ?? '').slice(-600) })
    }
    for (const cf of p.conflicts ?? []) conflicts.push(`wsl: ${cf}`)
  } else {
    const d = (c.stderr || c.parseError || 'companion 调用失败').slice(-600)
    steps.push({ side: 'wsl', cmd: 'skm sync', ok: false, detail: d })
    conflicts.push(`wsl companion 调用失败: ${d}`)
  }

  // ---- 3. Windows pull ----
  r = await gitRun(vaultPath, ['pull', 'origin', 'main'])
  record('windows', 'git pull origin main', r)
  if (!r.ok) conflicts.push(`windows pull 失败:\n${detail(r)}`)

  return { steps, conflicts }
}
