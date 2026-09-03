/**
 * git.ts — Git 只读探测 adapter（docs/02 §1，约束 #19）。
 *
 * - 所有命令经 core/exec run()：参数数组、无 shell、默认 15s 超时（约束 #7/#8/#9）；
 * - 只读子命令（status / remote / rev-parse），不修改任何仓库状态；
 * - 预期性不可用（目录非仓库、git 缺失、超时等）一律降级为 null，
 *   不向上抛异常（约束 #25，编程性错误除外）。
 */

import { run } from '../core/exec.ts'
import type { GitRepoStatus } from '../../shared/types.ts'

/**
 * 解析 `git status --porcelain=v1 --branch` 首行：
 *   ## main                     （无上游）
 *   ## main...origin/main       （有上游）
 *   ## main...origin/main [ahead 1, behind 2]
 *   ## HEAD (no branch)         （detached HEAD）
 */
function parseBranchLine(line: string): {
  branch: string
  upstream?: string
  ahead: number
  behind: number
} | null {
  if (!line.startsWith('## ')) return null
  const body = line.slice(3)

  let ahead = 0
  let behind = 0
  const meta = body.match(/\[([^[\]]*)\]$/)
  let refPart = body
  if (meta !== null) {
    refPart = body.slice(0, meta.index)
    const aheadMatch = meta[1].match(/ahead (\d+)/)
    if (aheadMatch !== null) ahead = Number.parseInt(aheadMatch[1], 10)
    const behindMatch = meta[1].match(/behind (\d+)/)
    if (behindMatch !== null) behind = Number.parseInt(behindMatch[1], 10)
  }

  refPart = refPart.trim()
  if (refPart.startsWith('HEAD')) {
    return { branch: 'HEAD', ahead, behind }
  }
  const [branchRaw, upstreamRaw] = refPart.split('...')
  const branch = branchRaw.trim()
  if (branch.length === 0) return null
  const upstream = upstreamRaw !== undefined && upstreamRaw.trim().length > 0 ? upstreamRaw.trim() : undefined
  return { branch, upstream, ahead, behind }
}

/**
 * 仓库状态：分支、ahead/behind、dirty 文件数。
 * 非零退出（非仓库 / git 缺失）或超时 → null。
 */
export async function gitStatus(repoPath: string): Promise<GitRepoStatus | null> {
  const res = await run('git', ['-C', repoPath, 'status', '--porcelain=v1', '--branch'])
  if (res.code !== 0 || res.timedOut) return null
  const lines = res.stdout.split(/\r?\n/).filter((l) => l.trim().length > 0)
  if (lines.length === 0) return null
  const head = parseBranchLine(lines[0])
  if (head === null) return null
  return {
    branch: head.branch,
    upstream: head.upstream,
    ahead: head.ahead,
    behind: head.behind,
    dirtyCount: lines.length - 1,
  }
}

/** origin remote URL；无 remote / 非仓库 / 失败 → null。 */
export async function gitRemote(repoPath: string): Promise<string | null> {
  const res = await run('git', ['-C', repoPath, 'remote', 'get-url', 'origin'])
  if (res.code !== 0 || res.timedOut) return null
  const value = res.stdout.trim()
  return value.length > 0 ? value : null
}

/** HEAD commit sha（40 位十六进制）；空仓库 / 非仓库 / 失败 → null。 */
export async function gitHead(repoPath: string): Promise<string | null> {
  const res = await run('git', ['-C', repoPath, 'rev-parse', 'HEAD'])
  if (res.code !== 0 || res.timedOut) return null
  const value = res.stdout.trim()
  return /^[0-9a-f]{40}$/i.test(value) ? value : null
}

// ---------------------------------------------------------------------------
// M2（docs/08 §6.11）：porcelain 逐行分类的细分状态（modified / untracked 计数）
// ---------------------------------------------------------------------------

/** gitStatusDetailed 的判别结果：ok / 非仓库 / git 缺失 / 超时四态。 */
export type GitDetailedStatus =
  | {
      kind: 'ok'
      branch: string
      upstream?: string
      ahead: number
      behind: number
      /** porcelain 正文行分类计数：`?? ` 行 → untracked，其余 → modified。 */
      modifiedCount: number
      untrackedCount: number
    }
  | { kind: 'not_a_repository' }
  | { kind: 'unavailable'; reason: 'git-missing' | 'timeout'; detail: string }

/**
 * `git status --porcelain=v1 --branch` 的细分解析：
 *  - 超时 / spawn 失败（git 缺失）→ unavailable（区分 reason，Service 层折叠 EXEC_*）；
 *  - 非零退出（非仓库等）→ not_a_repository；
 *  - 成功 → parseBranchLine 解析分支行 + 正文行二分类计数。
 * 全部命令经 exec 内核参数数组（约束 #7/#8/#9）。
 */
export async function gitStatusDetailed(repoPath: string): Promise<GitDetailedStatus> {
  const res = await run('git', ['-C', repoPath, 'status', '--porcelain=v1', '--branch'])
  if (res.timedOut) {
    return { kind: 'unavailable', reason: 'timeout', detail: `git status timed out for ${repoPath}` }
  }
  if (res.code === -1) {
    // exec 内核约定：spawn 失败（如 ENOENT）映射 code=-1
    return { kind: 'unavailable', reason: 'git-missing', detail: res.stderr }
  }
  if (res.code !== 0) return { kind: 'not_a_repository' }

  const lines = res.stdout.split(/\r?\n/).filter((l) => l.trim().length > 0)
  if (lines.length === 0) return { kind: 'not_a_repository' }
  const head = parseBranchLine(lines[0])
  if (head === null) return { kind: 'not_a_repository' }

  let modifiedCount = 0
  let untrackedCount = 0
  for (const line of lines.slice(1)) {
    if (line.startsWith('?? ')) untrackedCount += 1
    else modifiedCount += 1
  }
  return {
    kind: 'ok',
    branch: head.branch,
    upstream: head.upstream,
    ahead: head.ahead,
    behind: head.behind,
    modifiedCount,
    untrackedCount,
  }
}
