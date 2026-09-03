/**
 * wsl.ts — WSL 只读探测 adapter（docs/02 §1，约束 #19）。
 *
 * - 发行版列表：`wsl.exe -l -v`（UTF-16LE 已由 core/exec 按 BOM 解码）；
 * - 工具链：单次 `wsl.exe -d <distro> -e sh -c '<literal>'`（-e 绕过 Windows 侧
 *   参数二次处理；脚本为静态字面量，distro 只进 args 数组，约束 #8/#12）；
 * - 端口：单次 `wsl.exe -d <distro> -e sh -c 'ss -tlnp ... || netstat -tlnp ...'`；
 * - /proc 概要（S4）：单次 `sh -c` 复合读取 meminfo/loadavg/df/uptime（readDistroStats）；
 * - wslPathForWinPath：纯函数路径换算，无任何 I/O。
 *
 * 预期性不可用（未装 WSL / 无发行版 / 发行版名错误）一律结构化降级，禁止 throw（约束 #25）。
 */

import { run } from '../core/exec.ts'
import type { EnvironmentToolInfo, WslDistro, WslDistroStats, WslPortEntry, WslStatus } from '../../shared/types.ts'

/** WSL 冷启动可能需要数秒，放宽到 30s（约束 #9 允许显式放宽）。 */
const WSL_TIMEOUT_MS = 30_000

/** 从 wsl.exe 输出中取第一条可读行（剥 NUL，UTF-16 无 BOM 时由 exec 兜底 utf8 会有噪点）。 */
function firstReadableLine(text: string): string | undefined {
  const line = text
    .replace(/\u0000/g, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  return line !== undefined && line.length > 0 ? line : undefined
}

// ---------------------------------------------------------------------------
// 发行版列表
// ---------------------------------------------------------------------------

interface WslDistroProbe {
  available: boolean
  distros: WslDistro[]
  reason?: string
}

/** 解析 `wsl.exe -l -v` 输出：NAME/STATE/VERSION 三列 + 默认发行版 `*` 标记。 */
function parseWslList(stdout: string): WslDistro[] {
  const distros: WslDistro[] = []
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.replace(/\u0000/g, '').trim()
    if (line.length === 0) continue
    if (/^NAME\s+STATE\s+VERSION/i.test(line)) continue // 表头
    let body = line
    let isDefault = false
    if (body.startsWith('*')) {
      isDefault = true
      body = body.slice(1).trim()
    }
    const tokens = body.split(/\s+/)
    if (tokens.length < 3) continue
    distros.push({ name: tokens[0], state: tokens[1], version: tokens[2], isDefault })
  }
  return distros
}

async function probeDistros(): Promise<WslDistroProbe> {
  const res = await run('wsl.exe', ['-l', '-v'], { timeoutMs: WSL_TIMEOUT_MS })
  if (res.timedOut) {
    return { available: false, distros: [], reason: 'wsl.exe -l -v timed out' }
  }
  if (res.code !== 0) {
    const detail = firstReadableLine(res.stderr) ?? firstReadableLine(res.stdout)
    return {
      available: false,
      distros: [],
      reason: detail !== undefined ? `wsl.exe failed: ${detail}` : `wsl.exe -l -v exited with ${res.code}`,
    }
  }
  const distros = parseWslList(res.stdout)
  if (distros.length === 0) {
    return { available: true, distros: [], reason: 'WSL reachable but no distribution installed' }
  }
  return { available: true, distros }
}

/**
 * 发行版列表；未装 WSL / 无发行版 → 空数组。
 * 结构化原因经 wslStatus() 获取（保持本函数签名为纯列表）。
 */
export async function listDistros(): Promise<WslDistro[]> {
  return (await probeDistros()).distros
}

/** WSL 可用性摘要（dashboard:summary 的 wslStatus 数据源）。 */
export async function wslStatus(): Promise<WslStatus> {
  const probe = await probeDistros()
  return {
    available: probe.available,
    distros: probe.distros.map((d) => d.name),
    detail: probe.reason,
  }
}

// ---------------------------------------------------------------------------
// WSL 内工具链（单次 sh -c 静态脚本）
// ---------------------------------------------------------------------------

/**
 * 静态字面量：依次探测 node/npm/python3/git/cmake/gcc/docker，
 * 每项输出 `key|version|path` 行，缺失输出 `key|missing|`；本地解析。
 */
const WSL_TOOLS_SCRIPT =
  'for t in node npm python3 git cmake gcc docker; do ' +
  'p=$(command -v "$t" 2>/dev/null); ' +
  'if [ -n "$p" ]; then v=$("$t" --version 2>/dev/null | head -n 1); echo "$t|$v|$p"; ' +
  'else echo "$t|missing|"; fi; done'

/** 从 `--version` 首行提取主版本号。 */
function versionFromLine(line: string): string | undefined {
  const m = line.match(/\d+(\.\d+)+/)
  return m !== null ? m[0] : undefined
}

/**
 * 指定发行版内的工具链；发行版不可达 / 超时 → 空数组（结构化降级）。
 * 注意：对已停止的发行版探测会将其启动（wsl 语义），属探测必需。
 */
export async function detectWslTools(distro: string): Promise<EnvironmentToolInfo[]> {
  const res = await run('wsl.exe', ['-d', distro, '-e', 'sh', '-c', WSL_TOOLS_SCRIPT], {
    timeoutMs: WSL_TIMEOUT_MS,
  })
  if (res.code !== 0 || res.timedOut) return []

  const tools: EnvironmentToolInfo[] = []
  for (const rawLine of res.stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    // key|version|path；version 理论上不含 '|'，仍按首尾切分容错
    const parts = line.split('|')
    if (parts.length < 2) continue
    const name = parts[0].trim()
    const path = parts[parts.length - 1].trim()
    const versionLine = parts.slice(1, -1).join('|').trim()
    if (name.length === 0) continue

    if (versionLine === 'missing' || versionLine.length === 0) {
      tools.push({ tool: name, state: versionLine === 'missing' ? 'missing' : 'error', path: path.length > 0 ? path : undefined })
      continue
    }
    tools.push({
      tool: name,
      version: versionFromLine(versionLine),
      path: path.length > 0 ? path : undefined,
      state: 'installed',
      rawVersion: versionLine,
    })
  }
  return tools
}

// ---------------------------------------------------------------------------
// WSL 内监听端口
// ---------------------------------------------------------------------------

/** 静态字面量：优先 ss（procps/iproute2），回退 netstat；无权限看 pid 时输出缺 users/pid 段。 */
const WSL_SOCKETS_SCRIPT = 'ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null'

/**
 * 发行版内 TCP LISTENING 条目；无权限查看进程信息时 pid/processName 为 null。
 * 发行版不可达 / 超时 → 空数组。
 */
export async function wslListeningSockets(distro: string): Promise<WslPortEntry[]> {
  const res = await run('wsl.exe', ['-d', distro, '-e', 'sh', '-c', WSL_SOCKETS_SCRIPT], {
    timeoutMs: WSL_TIMEOUT_MS,
  })
  if (res.code !== 0 || res.timedOut) return []

  const entries: WslPortEntry[] = []
  for (const rawLine of res.stdout.split(/\r?\n/)) {
    const tokens = rawLine.trim().split(/\s+/)
    if (tokens.length < 5) continue

    let local = ''
    let processPart = ''
    if (tokens[0] === 'LISTEN') {
      // ss 格式：LISTEN 0 4096 127.0.0.53%lo:53 0.0.0.0:* users:(("name",pid=119,fd=15))
      local = tokens[3]
      processPart = tokens.slice(5).join(' ')
    } else if ((tokens[0] === 'tcp' || tokens[0] === 'tcp6') && tokens.length > 5 && tokens[5] === 'LISTEN') {
      // netstat 格式：tcp 0 0 127.0.0.1:53 0.0.0.0:* LISTEN 1234/dnsmasq
      local = tokens[3]
      processPart = tokens.length > 6 ? tokens[6] : ''
    } else {
      continue // 表头（State/Recv-Q…、Netid/…）与非监听行
    }

    const colon = local.lastIndexOf(':')
    if (colon < 0) continue
    const port = Number.parseInt(local.slice(colon + 1), 10)
    if (!Number.isFinite(port)) continue

    // ss: pid=119 / "systemd-resolve"；netstat: 1234/dnsmasq
    const ssPid = processPart.match(/pid=(\d+)/)
    const quotedName = processPart.match(/"([^"]+)"/)
    const netPair = processPart.match(/^(\d+)\/(.+)$/)
    const pid = ssPid !== null ? Number.parseInt(ssPid[1], 10) : netPair !== null ? Number.parseInt(netPair[1], 10) : null
    const processName =
      quotedName !== null ? quotedName[1] : netPair !== null ? netPair[2].trim() : null

    entries.push({ port, address: local.slice(0, colon), pid, processName })
  }
  return entries
}

// ---------------------------------------------------------------------------
// 发行版内 /proc 复合指标（S4：只读探测扩展，docs/09 §8.2；原 wslmon distroStats 移植）
// ---------------------------------------------------------------------------

/** 静态字面量：一次 wsl 调用全拿 meminfo + loadavg + df -h / + uptime（老实现 DISTRO_STATS_CMD 原样移植）。 */
export const WSL_DISTRO_STATS_SCRIPT = 'cat /proc/meminfo; cat /proc/loadavg; df -h /; cat /proc/uptime'

function parseKbField(line: string): number | null {
  const m = line.match(/:\s+(\d+)\s+kB/i)
  return m !== null ? Number(m[1]) : null
}

/**
 * 复合输出解析：取不到的项为 null（部分输出 / 命令半途失败都不硬造数值）。
 * 行形态：`MemTotal: … kB` / loadavg 三列 + 分数段 / `df -h /` 数据行 / uptime 双浮点列。
 */
export function parseDistroStats(out: string): WslDistroStats {
  const stats: WslDistroStats = {
    memTotalKb: null,
    memFreeKb: null,
    memAvailKb: null,
    load1: null,
    diskTotal: null,
    diskUsed: null,
    diskAvail: null,
    diskPct: null,
    uptimeSec: null,
  }
  for (const rawLine of out.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    if (/^MemTotal:/i.test(line)) stats.memTotalKb = parseKbField(line)
    else if (/^MemFree:/i.test(line)) stats.memFreeKb = parseKbField(line)
    else if (/^MemAvailable:/i.test(line)) stats.memAvailKb = parseKbField(line)
    else if (/^\d+(?:\.\d+)?\s+\d+(?:\.\d+)?\s+\d+(?:\.\d+)?\s+\d+\/\d+\s+\d+/.test(line)) {
      // loadavg：0.00 0.01 0.00 1/363 1340
      const t = line.split(/\s+/)
      stats.load1 = Number(t[0])
    } else if (/^\S+\s+[\d.]+[KMGTP]?\s+[\d.]+[KMGTP]?\s+[\d.]+[KMGTP]?\s+\d+%\s+\/$/.test(line)) {
      // df -h / 数据行：/dev/sdd 1007G 20G 936G 3% /
      const t = line.split(/\s+/)
      stats.diskTotal = t[1]
      stats.diskUsed = t[2]
      stats.diskAvail = t[3]
      stats.diskPct = Number(String(t[4]).replace('%', ''))
    } else if (/^\d+(?:\.\d+)?\s+\d+(?:\.\d+)?$/.test(line)) {
      // uptime：6660.90 159823.94（两列浮点；loadavg 行含 `/` 已在前命中，不冲突）
      const t = line.split(/\s+/)
      stats.uptimeSec = Math.round(Number(t[0]))
    }
  }
  return stats
}

/**
 * 发行版内一次复合读取（meminfo/loadavg/df/uptime）。
 * 发行版不可达 / 超时 → 全 null 的 stats（不 throw；是否可探测由调用方先看 state）。
 * 注意：wsl -d 对已停止的发行版会将其启动 —— 调用方（Service 层）必须先确认
 * state = Running 再调用（docs/09 §8.2「绝不为了取数而启动已停止的发行版」）。
 */
export async function readDistroStats(distro: string): Promise<WslDistroStats> {
  const res = await run('wsl.exe', ['-d', distro, '-e', 'sh', '-c', WSL_DISTRO_STATS_SCRIPT], {
    timeoutMs: WSL_TIMEOUT_MS,
  })
  if (res.code !== 0 || res.timedOut) {
    return {
      memTotalKb: null,
      memFreeKb: null,
      memAvailKb: null,
      load1: null,
      diskTotal: null,
      diskUsed: null,
      diskAvail: null,
      diskPct: null,
      uptimeSec: null,
    }
  }
  return parseDistroStats(res.stdout)
}

// ---------------------------------------------------------------------------
// 路径换算（纯函数）
// ---------------------------------------------------------------------------

/**
 * Windows 路径 → WSL 路径：`F:\\Active_Project\\X` → `/mnt/f/Active_Project/X`。
 * 小写盘符、反斜杠转正斜杠、去掉结尾分隔符；非盘符路径（UNC 等）原样返回。
 */
export function wslPathForWinPath(winPath: string): string {
  const m = winPath.match(/^([A-Za-z]):[\\/](.*)$/)
  if (m === null) return winPath
  const rest = m[2].replace(/\\/g, '/').replace(/\/+$/, '')
  return rest.length > 0 ? `/mnt/${m[1].toLowerCase()}/${rest}` : `/mnt/${m[1].toLowerCase()}`
}
