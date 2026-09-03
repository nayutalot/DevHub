/**
 * native.ts — native 通道（kimi/grok：自带更新器，docs/09 §7.1）。
 *
 * 已装版本 = `<bin> --version` 首行原始文本（前缀噪声由 versionCompare 在比较时剥离）；
 * 更新 = `<bin> update`（其自带更新器负责探测并更新，用户点按钮即视为同意，UI 文案注明
 * 「调用其自带更新器」）。bin 实测为 .exe，但也兼容 .cmd/.bat shim（shim 经 cmd.exe 执行，
 * 仍走 core/exec.run() 参数数组）。
 * homeDir 可注入（APIHUB_HOME 或 service 参数），smoke 夹具隔离用。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { run } from '../../core/exec.ts'
import type { ExecResult } from '../../../shared/types.ts'
import { runViaCmd } from './npm.ts'

export const NATIVE_CHECK_TIMEOUT_MS = 90_000
export const NATIVE_UPDATE_TIMEOUT_MS = 20 * 60_000

/** 解析自带更新器可执行文件：支持 ~ 开头路径（homeDir 可注入）；依次探测无后缀/.exe/.cmd/.bat */
export function resolveNativeBin(binPath: string, homeDir?: string): string | null {
  const home = homeDir !== undefined && homeDir.trim().length > 0 ? homeDir : (process.env.APIHUB_HOME ?? os.homedir())
  const full = binPath.startsWith('~') ? path.join(home, binPath.slice(1)) : binPath
  for (const c of [full, `${full}.exe`, `${full}.cmd`, `${full}.bat`]) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c
    } catch {
      /* 探测失败继续下一个候选 */
    }
  }
  return null
}

function runNative(bin: string, args: string[], timeoutMs: number): Promise<ExecResult> {
  const lower = bin.toLowerCase()
  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
    // shim 经 cmd.exe 单行执行（引号语义可预期；仍为 core/exec 唯一出口）
    return runViaCmd([bin, ...args], timeoutMs)
  }
  return run(bin, args, { timeoutMs })
}

/** `--version` 首行非空文本（原样返回，比较时再剥离前缀） */
export function firstVersionLine(stdout: string): string | null {
  return (
    String(stdout ?? '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) ?? null
  )
}

export async function nativeInstalledVersion(
  binPath: string,
  deps: { timeoutMs?: number; homeDir?: string } = {},
): Promise<{ version?: string; error?: string }> {
  const bin = resolveNativeBin(binPath, deps.homeDir)
  if (bin === null) return { error: `未找到自带更新器可执行文件: ${binPath}` }
  const r = await runNative(bin, ['--version'], deps.timeoutMs ?? NATIVE_CHECK_TIMEOUT_MS)
  const version = firstVersionLine(r.stdout)
  if (version !== null) return { version }
  return { error: `${path.basename(bin)} --version 无版本输出: ${(r.stderr || `退出码 ${r.code}`).slice(0, 200)}` }
}

/** 更新命令（`<bin> update`）：返回经 core/exec 通道执行的 command/args，供 job 状态机启动。 */
export function nativeUpdateCommand(bin: string): { command: string; args: string[] } {
  const lower = bin.toLowerCase()
  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
    // cmd.exe 通道：与 runViaCmd 同款前缀（chcp UTF-8），bin 绝对路径作首参数
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', 'chcp', '65001', '>nul', '&&', bin, 'update'] }
  }
  return { command: bin, args: ['update'] }
}
