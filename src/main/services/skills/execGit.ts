/**
 * skills/execGit.ts — vault 内 git 操作的唯一形态（docs/09 §11.1）。
 *
 * 一律经 core/exec.ts 的 run()（约束 #7-#10）：参数数组、无 shell、强制超时、
 * 结构化结果；GIT_TERMINAL_PROMPT=0 防交互挂起，LC_ALL=C 稳定输出解析。
 * push/pull 仅指向本地裸仓 origin（零远端原则，docs/09 §1）。
 */

import { run } from '../../core/exec.ts'

export interface GitOutcome {
  ok: boolean
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
}

/** 在 cwd 下执行 git 子命令；spawn 失败（git 未安装）→ ok:false 结构化结果，绝不 throw。 */
export async function gitRun(cwd: string, args: string[], timeoutMs = 120_000): Promise<GitOutcome> {
  const res = await run('git', args, {
    cwd,
    timeoutMs,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  })
  return {
    ok: res.code === 0 && !res.timedOut,
    code: res.code,
    stdout: res.stdout,
    stderr: res.stderr,
    timedOut: res.timedOut,
  }
}

/** git 不可用探测：`git --version` 走不通（ENOENT/超时）即视为缺失。 */
export async function gitAvailable(): Promise<boolean> {
  const r = await gitRun('.', ['--version'], 10_000)
  return r.ok
}
