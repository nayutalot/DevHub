/**
 * skills/wslBridge.ts — 经 core/exec 调用 wsl.exe 与 WSL companion CLI（skm）
 * （docs/09 §2 模块映射：Skill-Manager src/main/wslBridge.ts 的 DevHub 归宿）。
 *
 * 铁律适配（docs/00 约束 #7/#8/#12）：
 *  - 全部外部命令经 core/exec.ts 的 run()（参数数组 + 强制超时 + 结构化结果）；
 *  - bash -c 脚本正文只放静态字面量；动态值（路径等）经 WSLENV 环境变量传入
 *    子进程（wsl.exe 按其进程环境里的 WSLENV 白名单转发给 WSL 侧），与 DevHub
 *    PowerShell 侧 $env:DH_TARGET 同一模式；
 *  - companion 子命令参数（skill/agent 名等短标识符）经 shellSingleQuote 注入，
 *    并在 Service 层先做白名单字符集校验。
 *
 * 防御性处理保留老实现语义：UTF-16 空字节清洗、BOM 剥离、wsl.exe 告警文本里
 * 提取 JSON；exec 内核按 BOM 解码 UTF-16LE。
 */

import { run } from '../../core/exec.ts'

export interface WslRaw {
  ok: boolean
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
}

export interface WslResult extends WslRaw {
  parsed?: unknown
  parseError?: string
}

/** 去掉 UTF-16 空字节与 BOM（wsl.exe 无 BOM 的 UTF-16 输出由 exec 兜底解码会有噪点，这里统一清洗） */
export function cleanWslOutput(s: string): string {
  return String(s ?? '')
    .replace(/\0/g, '')
    .replace(/^\uFEFF/, '')
}

/** 从可能带告警噪声的输出中提取第一个完整 JSON 对象 */
export function extractJson<T = unknown>(text: string): T | null {
  const clean = cleanWslOutput(text)
  const start = clean.indexOf('{')
  if (start < 0) return null
  const end = clean.lastIndexOf('}')
  if (end <= start) return null
  try {
    return JSON.parse(clean.slice(start, end + 1)) as T
  } catch {
    return null
  }
}

/**
 * bash -c 内的动态值一律经 WSLENV 环境变量传入；本函数生成配套 env：
 * vars 里的每个键都会进入 WSLENV 白名单（Win → WSL 方向）。
 */
export function wslEnvPassthrough(vars: Record<string, string>): NodeJS.ProcessEnv {
  return { ...process.env, WSLENV: Object.keys(vars).join(':'), ...vars }
}

/** bash 单引号转义（companion 子命令参数专用；调用方先做字符集校验） */
export function shellSingleQuote(a: string): string {
  return /^[\w./=:-]+$/.test(a) ? a : `'` + a.replace(/'/g, `'\\''`) + `'`
}

/** WSL 侧路径白名单校验（进 bash -c 静态脚本前的最后防线；违规直接拒绝） */
export function isSafeWslPath(p: string): boolean {
  return /^\/[\w.\-/]+$/.test(p)
}

/**
 * 异步执行 `wsl.exe -d <distro> -e bash -c <script>`（经 exec 内核，约束 #7-#10）。
 * script 必须是静态字面量 + $DH_* 环境变量引用；动态值走 options.env（WSLENV）。
 */
export async function wslBash(distro: string, script: string, timeoutMs = 120_000, env?: NodeJS.ProcessEnv): Promise<WslRaw> {
  const res = await run('wsl.exe', ['-d', distro, '-e', 'bash', '-c', script], { timeoutMs, env })
  return {
    ok: res.code === 0 && !res.timedOut,
    code: res.code,
    stdout: cleanWslOutput(res.stdout),
    stderr: cleanWslOutput(res.stderr) + (res.timedOut ? `wsl.exe 超时（${timeoutMs}ms），已终止子进程` : ''),
    timedOut: res.timedOut,
  }
}

/** companion 入口：与 WSL_VAULT 常量保持一致（wslVault.ts）。 */
export const COMPANION_ENTRY = '/root/skill-vault/bin/skm.mjs'

/**
 * 调用 companion 子命令并解析 --json 输出。
 * 子命令名/参数经 shellSingleQuote 注入静态模板（参数值由 Service 层先行校验）。
 */
export async function runCompanion(distro: string, args: readonly string[], timeoutMs = 120_000): Promise<WslResult> {
  const quoted = args.map(shellSingleQuote).join(' ')
  const script = `node ${COMPANION_ENTRY} ${quoted} --json`.trim()
  const r = await wslBash(distro, script, timeoutMs)
  const parsed = extractJson(r.stdout)
  return {
    ...r,
    ...(parsed !== null && parsed !== undefined ? { parsed } : {}),
    ...(parsed === null || parsed === undefined
      ? { parseError: `无法从 companion 输出解析 JSON: ${(r.stdout || r.stderr).slice(0, 300)}` }
      : {}),
  }
}
