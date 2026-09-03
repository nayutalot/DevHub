/**
 * windows.ts — Windows 只读探测 adapter（docs/02 §1，约束 #19）。
 *
 * - 进程：tasklist /FO CSV /NH（argv 数组，name/PID/内存）；
 * - 端口：netstat -ano -p tcp（LISTENING 行 → port/pid/address）；
 * - 进程明细：PowerShell Get-CimInstance Win32_Process，脚本为静态字面量，
 *   pid 列表经 $env:DH_PIDS 传入（约束 #12）；
 * - 工具链：where.exe 定位 → PowerShell `& $env:DH_TOOL --version` 静态字面量测版本；
 *   python 按真实 PATH 顺序逐个解释器测版本（暴露 3.9/3.13 并存）。
 *
 * 所有命令经 core/exec run()；预期性不可用一律结构化降级，禁止 throw（约束 #25）。
 */

import { run } from '../core/exec.ts'
import type { EnvironmentToolInfo, PortEntry, ProcessDetail, WinProcess } from '../../shared/types.ts'

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

/** 把原始命令输出截断为可入库/可展示的摘要长度。 */
function truncate(text: string, max = 300): string {
  const oneLine = text.replace(/\r/g, '').replace(/\u0000/g, '').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
}

/** 解析 tasklist CSV 行；字段均带引号，容错不平衡引号/空行。 */
function parseCsvLine(line: string): string[] | null {
  const trimmed = line.trim()
  if (trimmed.length === 0) return null
  const fields = trimmed.match(/"((?:[^"]|"")*)"/g)
  if (fields === null) return null
  return fields.map((f) => f.slice(1, -1).replace(/""/g, '"'))
}

// ---------------------------------------------------------------------------
// 进程列表（tasklist）
// ---------------------------------------------------------------------------

/** Windows 进程快照；命令失败/超时 → 空数组。 */
export async function listWindowsProcesses(): Promise<WinProcess[]> {
  const res = await run('tasklist', ['/FO', 'CSV', '/NH'])
  if (res.code !== 0 || res.timedOut) return []
  const processes: WinProcess[] = []
  for (const line of res.stdout.split(/\r?\n/)) {
    const fields = parseCsvLine(line)
    // 列序："Image Name","PID","Session Name","Session#","Mem Usage"
    if (fields === null || fields.length < 5) continue
    const pid = Number.parseInt(fields[1], 10)
    if (!Number.isFinite(pid)) continue
    const memMatch = fields[4].match(/^([\d,]+)\s*K$/i)
    processes.push({
      name: fields[0],
      pid,
      memKb: memMatch !== null ? Number.parseInt(memMatch[1].replace(/,/g, ''), 10) : undefined,
    })
  }
  return processes
}

// ---------------------------------------------------------------------------
// TCP 监听端口（netstat）
// ---------------------------------------------------------------------------

/**
 * 本机 TCP LISTENING 端口（IPv4/IPv6 都收；0.0.0.0 / 127.0.0.1 / [::] 都是本地监听）。
 * 命令失败/超时 → 空数组。
 */
export async function listListeningPorts(): Promise<PortEntry[]> {
  const res = await run('netstat', ['-ano', '-p', 'tcp'])
  if (res.code !== 0 || res.timedOut) return []
  const entries: PortEntry[] = []
  const seen = new Set<string>()
  for (const line of res.stdout.split(/\r?\n/)) {
    const tokens = line.trim().split(/\s+/)
    // 形态：TCP  <local>  <foreign>  LISTENING  <pid>
    if (tokens.length < 5 || tokens[0] !== 'TCP' || tokens[3] !== 'LISTENING') continue
    const local = tokens[1]
    const colon = local.lastIndexOf(':')
    if (colon < 0) continue
    const port = Number.parseInt(local.slice(colon + 1), 10)
    const pid = Number.parseInt(tokens[tokens.length - 1], 10)
    if (!Number.isFinite(port) || !Number.isFinite(pid)) continue
    const key = `${local}|${pid}`
    if (seen.has(key)) continue
    seen.add(key)
    entries.push({ port, pid, address: local.slice(0, colon) })
  }
  return entries
}

// ---------------------------------------------------------------------------
// 进程明细（PowerShell Get-CimInstance Win32_Process）
// ---------------------------------------------------------------------------

/**
 * 静态字面量（约束 #12）：pid 列表 JSON 经 $env:DH_PIDS 传入，
 * 命中的进程输出压缩 JSON（pid/name/commandLine/executablePath）。
 */
const PROCESS_DETAILS_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  'try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }',
  '$ids = @()',
  'try { $ids = @((ConvertFrom-Json -InputObject $env:DH_PIDS)) } catch { exit 1 }',
  'Get-CimInstance -ClassName Win32_Process | Where-Object { $ids -contains [int]$_.ProcessId } | ' +
    'ForEach-Object { [PSCustomObject]@{ pid = [int]$_.ProcessId; name = $_.Name; commandLine = $_.CommandLine; executablePath = $_.ExecutablePath } } | ' +
    'ConvertTo-Json -Compress -Depth 3',
].join('; ')

/**
 * 按 pid 批量取进程明细（name / commandLine / executablePath）。
 * 失败 / 超时 / 输出不可解析 → 空 Map（调用方以 pid 对不上号处理）。
 */
export async function getProcessDetails(pidList: number[]): Promise<Map<number, ProcessDetail>> {
  const result = new Map<number, ProcessDetail>()
  const unique = [...new Set(pidList.filter((p) => Number.isFinite(p) && p > 0))]
  if (unique.length === 0) return result

  const res = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PROCESS_DETAILS_SCRIPT], {
    env: { ...process.env, DH_PIDS: JSON.stringify(unique) },
  })
  if (res.code !== 0 || res.timedOut) return result
  const text = res.stdout.trim()
  if (text.length === 0) return result

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return result
  }
  // 单个命中时 PowerShell 输出对象而非数组，归一化
  const rows: unknown[] = Array.isArray(parsed) ? parsed : [parsed]
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const rec = row as { pid?: unknown; name?: unknown; commandLine?: unknown; executablePath?: unknown }
    const pid = typeof rec.pid === 'number' ? rec.pid : Number.parseInt(String(rec.pid ?? ''), 10)
    if (!Number.isFinite(pid)) continue
    result.set(pid, {
      pid,
      name: typeof rec.name === 'string' ? rec.name : '',
      commandLine: typeof rec.commandLine === 'string' && rec.commandLine.length > 0 ? rec.commandLine : undefined,
      executablePath:
        typeof rec.executablePath === 'string' && rec.executablePath.length > 0 ? rec.executablePath : undefined,
    })
  }
  return result
}

// ---------------------------------------------------------------------------
// 工具链探测（where.exe + PowerShell 静态字面量测版本）
// ---------------------------------------------------------------------------

/** 静态字面量（约束 #12）：目标可执行文件路径经 $env:DH_TOOL 传入，& 调用其 --version。 */
const TOOL_VERSION_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  'try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }',
  '$out = ""; $code = 0',
  'try { $out = & $env:DH_TOOL --version 2>&1 | Out-String; if ($null -ne $LASTEXITCODE) { $code = $LASTEXITCODE } } catch { $out = $_.Exception.Message; $code = 1 }',
  'Write-Output $out.Trim()',
  'exit $code',
].join('; ')

interface ToolSpec {
  /** 入库/展示用工具名。 */
  tool: string
  /** where.exe 查找名（静态字面量）。 */
  lookup: string
  /** 主查找名缺失时的回退查找名（gcc → clang）。 */
  fallback?: string
  /** where 命中多行时逐个探测（python 多版本并存）。 */
  allPaths?: boolean
}

const TOOL_SPECS: readonly ToolSpec[] = [
  { tool: 'node', lookup: 'node' },
  { tool: 'npm', lookup: 'npm' },
  { tool: 'pnpm', lookup: 'pnpm' },
  { tool: 'python', lookup: 'python', allPaths: true },
  { tool: 'git', lookup: 'git' },
  { tool: 'docker', lookup: 'docker' },
  { tool: 'cmake', lookup: 'cmake' },
  { tool: 'gcc', lookup: 'gcc', fallback: 'clang' },
  { tool: 'vscode', lookup: 'code' },
]

/** where.exe 定位；失败/超时 → 空数组。 */
async function whereTool(lookup: string): Promise<string[]> {
  const res = await run('where.exe', [lookup])
  if (res.code !== 0 || res.timedOut) return []
  return res.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
}

/**
 * where.exe 可能返回多行（无扩展名 sh 包装、.cmd、.exe 并存）；
 * Windows 下按 .exe > .cmd/.bat > 其他 优先取第一个可用者。
 */
function pickBestPath(paths: string[]): string | null {
  let best: string | null = null
  let bestScore = 0
  for (const p of paths) {
    const lower = p.toLowerCase()
    const score = lower.endsWith('.exe') ? 3 : lower.endsWith('.cmd') || lower.endsWith('.bat') ? 2 : 1
    if (score > bestScore) {
      best = p
      bestScore = score
    }
  }
  return best
}

/** python 多路径：只保留真实解释器（.exe），保持 PATH 顺序（PATH 首位在前）。 */
function expandInterpreterPaths(paths: string[]): string[] {
  const exes = paths.filter((p) => p.toLowerCase().endsWith('.exe'))
  return exes.length > 0 ? exes : paths
}

/** 从 --version 输出提取主版本号（首个 x.y[.z…] 语义段）。 */
function versionFromOutput(raw: string): string | undefined {
  const m = raw.match(/\d+(\.\d+)+/)
  return m !== null ? m[0] : undefined
}

function makeTool(
  tool: string,
  path: string | undefined,
  state: EnvironmentToolInfo['state'],
  rawVersion: string | undefined,
): EnvironmentToolInfo {
  return {
    tool,
    version: rawVersion !== undefined ? versionFromOutput(rawVersion) : undefined,
    path,
    state,
    rawVersion,
  }
}

/** 单个可执行文件的 --version 探测（PowerShell 静态字面量，$env:DH_TOOL 传路径）。 */
async function probeVersion(executablePath: string): Promise<{ ok: boolean; raw: string | undefined }> {
  const res = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', TOOL_VERSION_SCRIPT], {
    env: { ...process.env, DH_TOOL: executablePath },
  })
  const raw = truncate(res.stdout.length > 0 ? res.stdout : res.stderr)
  if (res.timedOut) return { ok: false, raw: raw.length > 0 ? raw : 'version probe timed out' }
  if (res.code !== 0) return { ok: false, raw: raw.length > 0 ? raw : `exit ${res.code}` }
  if (raw.length === 0) return { ok: false, raw: 'empty --version output' }
  return { ok: true, raw }
}

/**
 * Windows 工具链探测：node/npm/pnpm/python/git/docker/cmake/gcc(clang)/vscode。
 * 每个工具独立容错：单项失败只影响自身条目（state='error' / 'missing'），不拖垮整表。
 * 注意：python 命中多个解释器时返回多条 tool='python' 条目（按 PATH 顺序），
 * Service 层落库时负责消歧（docs/01 基线：3.9 与 3.13 并存）。
 */
export async function detectWindowsTools(): Promise<EnvironmentToolInfo[]> {
  const tools: EnvironmentToolInfo[] = []
  for (const spec of TOOL_SPECS) {
    let toolName = spec.tool
    let paths = await whereTool(spec.lookup)
    if (paths.length === 0 && spec.fallback !== undefined) {
      toolName = spec.fallback
      paths = await whereTool(spec.fallback)
    }
    if (paths.length === 0) {
      tools.push(makeTool(toolName, undefined, 'missing', undefined))
      continue
    }

    const targets = spec.allPaths === true ? expandInterpreterPaths(paths) : [pickBestPath(paths)]
    for (const target of targets) {
      if (target === null) {
        tools.push(makeTool(toolName, undefined, 'error', undefined))
        continue
      }
      try {
        const probe = await probeVersion(target)
        tools.push(makeTool(toolName, target, probe.ok ? 'installed' : 'error', probe.raw))
      } catch {
        // 单项容错（约束 #25）：探测异常只记 error 条目
        tools.push(makeTool(toolName, target, 'error', undefined))
      }
    }
  }
  return tools
}
