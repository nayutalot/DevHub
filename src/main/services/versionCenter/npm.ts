/**
 * npm.ts — npm 通道（老 versionCenter/npm.ts 移植，docs/09 §7.1）。
 *
 * 已装版本 = `npm ls -g --depth=0 --json`；最新版 = `npm view <pkg> version`；
 * 更新 = `npm install -g <pkg>@latest`（pkg 全部来自内置 catalog 常量，无注入面）。
 * 全部命令经 core/exec.run()（约束 #7-#10）：npm 在 Windows 上通常是 npm.cmd shim
 * （Node 直接 spawn .cmd 会 EINVAL）→ 统一经 cmd.exe /d /s /c 执行，参数数组无 shell 拼接。
 *
 * GUI 启动的应用继承的 PATH 可能缺少 npm 所在目录 → 执行前先解析 npm.cmd 绝对路径：
 * where.exe npm.cmd（唯一来源，结果经投毒收口校验）；
 * 失败给出明确错误（绝不带着乱码报 check-failed）。
 */
import path from 'node:path'
import { run } from '../../core/exec.ts'
import type { ExecResult } from '../../../shared/types.ts'

export const NPM_CHECK_TIMEOUT_MS = 90_000
/** where.exe 解析超时（快命令，独立于检查超时） */
export const NPM_WHERE_TIMEOUT_MS = 15_000

/** npm.cmd 全部解析失败时的明确错误文案 */
export const NPM_NOT_FOUND_ERROR = '未找到 npm.cmd（where.exe 解析失败），请确认 Node.js 安装'

export interface NpmDeps {
  timeoutMs?: number
}

/**
 * npm.cmd 解析结果的统一收口校验（PATH 投毒防线）：where.exe 命中必须是
 * 绝对路径且 basename 恰为 npm.cmd，否则视为不可信并丢弃。
 */
function isTrustedNpmCmdPath(p: string): boolean {
  return path.isAbsolute(p) && path.basename(p).toLowerCase() === 'npm.cmd'
}

/**
 * 解析 npm.cmd 绝对路径（仅 where.exe 单一来源）：输出经 isTrustedNpmCmdPath
 * 收口（绝对路径 + basename=npm.cmd，防 PATH 投毒）。
 * 历史注记：原有 %ProgramFiles%/%APPDATA% env 候选回退已于 2026-09-04 移除
 * （安全扫描器对该「env→path→fs」白名单构造持续误报为 path-traversal 且不可
 * 安抚；where.exe 为本机实测主路径）。where.exe 失灵的机器 → 结构化
 * NPM_NOT_FOUND 降级，不崩。恢复回退需先在安全钩子侧为该构造加白。
 */
export async function resolveNpmCmdPath(deps: NpmDeps = {}): Promise<string | null> {
  void deps
  const r = await run('where.exe', ['npm.cmd'], { timeoutMs: NPM_WHERE_TIMEOUT_MS })
  if (r.code === 0 && !r.timedOut) {
    const first = r.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean)
    if (first !== undefined && isTrustedNpmCmdPath(first)) return first
  }
  return null
}

/**
 * 经 cmd.exe /d /s /c 执行参数数组（chcp 65001 前缀让 cmd 侧先切 UTF-8，避免中文系统
 * OEM 代码页输出按 UTF-8 解码乱码掩盖真实错误）。绝对路径含空格时必须走参数数组
 * 而非单行字符串（cmd /s 引号剥离语义）。
 */
export function runViaCmd(args: readonly string[], timeoutMs: number, cwd?: string): Promise<ExecResult> {
  return run('cmd.exe', ['/d', '/s', '/c', 'chcp', '65001', '>nul', '&&', ...args], {
    timeoutMs,
    ...(cwd !== undefined ? { cwd } : {}),
  })
}

/** 解析失败的统一错误（调用方直接作为 check-failed 的 note） */
function notFound(): { error: string } {
  return { error: NPM_NOT_FOUND_ERROR }
}

/** 解析 npm ls -g --json 的 dependencies → Map<包名, 版本>；非 JSON（npm 报错文本）→ 空表 */
export function parseNpmLsDependencies(stdout: string): Map<string, string> {
  const map = new Map<string, string>()
  try {
    const parsed = JSON.parse(stdout) as { dependencies?: Record<string, { version?: string }> }
    for (const [name, info] of Object.entries(parsed.dependencies ?? {})) {
      if (info !== null && typeof info.version === 'string') map.set(name, info.version)
    }
  } catch {
    /* 保持空表 */
  }
  return map
}

/** npm view <pkg> version 输出可能混有告警行 → 取最后一个版本形行 */
export function parseNpmViewVersion(stdout: string): string | null {
  const lines = String(stdout ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^v?\d+(?:\.\d+)+$/.test(lines[i])) return lines[i]
  }
  return null
}

function isNpmLsJson(stdout: string): boolean {
  try {
    const p: unknown = JSON.parse(stdout)
    return typeof p === 'object' && p !== null
  } catch {
    return false
  }
}

/** npm ls -g：成功（含空 dependencies）返回 map；npm 不可用/报错返回 error */
export async function npmInstalled(deps: NpmDeps = {}): Promise<{ map: Map<string, string> } | { error: string }> {
  const npm = await resolveNpmCmdPath(deps)
  if (npm === null) return notFound()
  const r = await runViaCmd([npm, 'ls', '-g', '--depth=0', '--json'], deps.timeoutMs ?? NPM_CHECK_TIMEOUT_MS)
  if (isNpmLsJson(r.stdout)) return { map: parseNpmLsDependencies(r.stdout) }
  return { error: `npm ls -g 失败: ${(r.stderr || r.stdout || '无输出').slice(0, 200)}` }
}

/** npm view <pkg> version：读用户现有 npm 配置查最新版 */
export async function npmLatest(pkg: string, deps: NpmDeps = {}): Promise<{ version?: string; error?: string }> {
  const npm = await resolveNpmCmdPath(deps)
  if (npm === null) return notFound()
  const r = await runViaCmd([npm, 'view', pkg, 'version'], deps.timeoutMs ?? NPM_CHECK_TIMEOUT_MS)
  const v = parseNpmViewVersion(r.stdout)
  if (v !== null) return { version: v }
  return { error: `npm view 失败: ${(r.stderr || r.stdout || '无输出').slice(0, 200)}` }
}

/** 更新参数：npm install -g <pkg>@latest（catalog 常量 pkg，无注入面；由 runViaCmd 通道执行）。 */
export function npmUpgradeArgs(pkg: string): string[] {
  return ['install', '-g', `${pkg}@latest`, '--no-audit', '--no-fund']
}
