/**
 * gitService.ts — Git 状态只读编排（docs/08 §4 缺口 3、§6.11）。
 *
 * - MCP devhub.git.status 的唯一实现：projectId 必须存在（NOT_FOUND）；
 * - 可选 path 白名单（docs/08 §10.2）：path 先经 normalizePathKey 归一
 *   （大小写 / 正反斜杠 / 尾分隔符），再与 projects 表任一 win_path / wsl_path
 *   完全比对，未命中 → BAD_PAYLOAD 结构化拒绝，禁止任意路径探测；
 * - 细分探测走 adapter.gitStatusDetailed（M2 增补的只读 porcelain 分类），
 *   headSha / remoteUrl 沿用 gitHead / gitRemote best-effort；MCP 不直接调 adapter。
 */

import { gitHead, gitRemote, gitStatusDetailed } from '../adapters/git.ts'
import { getDatabase } from '../db/index.ts'
import { normalizePathKey, nowSec, ServiceError } from './internal.ts'

/** devhub.git.status 出参（docs/08 §6.11）。 */
export interface GitRepositoryStatus {
  branch: string
  upstream?: string
  ahead: number
  behind: number
  headSha?: string
  remoteUrl?: string
}

export interface GitWorkingTree {
  clean: boolean
  modifiedCount: number
  untrackedCount: number
}

export interface GitStatusForProjectResult {
  projectId: number
  project: string
  path: string
  repository?: GitRepositoryStatus
  workingTree: GitWorkingTree
  notAGitRepository?: true
  checkedAt: number
}

interface ProjectRow {
  id: number
  name: string
  win_path: string | null
  wsl_path: string | null
}

interface ProjectPathRow {
  win_path: string | null
  wsl_path: string | null
}

/**
 * 项目 Git 状态：path 白名单校验（或缺省取项目自身路径）→ 细分 porcelain 探测 →
 * 结构化投影。git 缺失 → EXEC_FAILED、超时 → EXEC_TIMEOUT（结构化错误，isError）；
 * 目标非仓库 → notAGitRepository:true（不是错误）。
 */
export async function gitStatusForProject(projectId: number, path?: string): Promise<GitStatusForProjectResult> {
  const db = getDatabase()
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as ProjectRow | undefined
  if (row === undefined) {
    throw new ServiceError('NOT_FOUND', `project ${projectId} not found`)
  }

  let target: string | null
  if (path !== undefined) {
    // 白名单：归一化后必须与任一已知项目的 win_path / wsl_path 完全相等（docs/08 §6.11）
    const key = normalizePathKey(path)
    const known = db.prepare('SELECT win_path, wsl_path FROM projects').all() as unknown as ProjectPathRow[]
    const hit = known.some(
      (p) =>
        (p.win_path !== null && normalizePathKey(p.win_path) === key) ||
        (p.wsl_path !== null && normalizePathKey(p.wsl_path) === key),
    )
    if (!hit) {
      throw new ServiceError('BAD_PAYLOAD', 'path is not a project path tracked by DevHub (whitelist miss)')
    }
    target = path
  } else {
    target = row.win_path ?? row.wsl_path
  }
  if (target === null || target.length === 0) {
    throw new ServiceError('BAD_PAYLOAD', `project "${row.name}" has no path to probe`)
  }

  const detailed = await gitStatusDetailed(target)
  if (detailed.kind === 'unavailable') {
    if (detailed.reason === 'timeout') {
      throw new ServiceError('EXEC_TIMEOUT', 'git status timed out')
    }
    throw new ServiceError('EXEC_FAILED', 'git executable was not found or failed to start')
  }

  const checkedAt = nowSec()
  if (detailed.kind === 'not_a_repository') {
    return {
      projectId,
      project: row.name,
      path: target,
      workingTree: { clean: true, modifiedCount: 0, untrackedCount: 0 },
      notAGitRepository: true,
      checkedAt,
    }
  }

  // remote / head best-effort：单独失败不阻塞分支与工作树数据
  const [head, remote] = await Promise.all([gitHead(target), gitRemote(target)])
  return {
    projectId,
    project: row.name,
    path: target,
    repository: {
      branch: detailed.branch,
      upstream: detailed.upstream,
      ahead: detailed.ahead,
      behind: detailed.behind,
      headSha: head ?? undefined,
      remoteUrl: remote ?? undefined,
    },
    workingTree: {
      clean: detailed.modifiedCount + detailed.untrackedCount === 0,
      modifiedCount: detailed.modifiedCount,
      untrackedCount: detailed.untrackedCount,
    },
    checkedAt,
  }
}
