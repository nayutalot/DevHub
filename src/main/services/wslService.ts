/**
 * wslService.ts — WSL 编排（docs/08 §4 缺口 2、§6.9/§6.10，决策 D2 数据源分层；
 * S4 扩展 docs/09 §8.2/§9：terminate/boot/systemInfo）。
 *
 * 分层（D2）：发行版 name/version/state/isDefault 是易变运行时状态，DB 未落库
 * （docs/03 environments 表无此列）→ 实时 adapter 探测；tools 工具摘要与
 * snapshotAt 来自 DB 最近 detect 快照（environments kind='wsl' + environment_tools，
 * 按 `wsl:<name>` 命名对齐）。探测不到的字段显式 null，绝不猜测。
 * 不可用一律结构化降级，不 throw（约束 #25/#26）。
 *
 * S4 铁律（docs/09 §8.2）：绝不为了取数而启动已停止的发行版 —— /proc 概要只对
 * Running 且非 docker-desktop 系探测；terminate 为 CONFIRM_REQUIRED 两段式
 * （impacts = 该发行版当前监听 TCP 端口，复用 adapter.wslListeningSockets）；
 * boot 无害直接执行（`wsl.exe -d <distro> -e true` 幂等唤醒，distro 走 args 数组）。
 * 夜间#1 批次：shutdownAll 两段式（docs/09 §8.2 CONFIRM_REQUIRED + 二次确认文案；
 * `wsl.exe --shutdown` VM 级全停，impacts = 全部发行版清单；列表探测只读，
 * 绝不唤醒已停发行版）。
 */

import { run } from '../core/exec.ts'
import {
  listDistros,
  readDistroStats,
  wslListeningSockets,
  wslStatus as probeWslStatus,
} from '../adapters/wsl.ts'
import type {
  EnvironmentToolInfo,
  WslActionImpacts,
  WslActionName,
  WslActionResult,
  WslActionStart,
  WslDistro,
  WslDistroStatView,
  WslDistroStatsResult,
  WslPortEntry,
  WslShutdownAllImpacts,
  WslShutdownAllResult,
  WslShutdownAllStart,
  WslStatus,
} from '../../shared/types.ts'
import { getDatabase } from '../db/index.ts'
import { ServiceError, errorMessage, nowSec } from './internal.ts'
import { loadEnvironmentWithTools } from './environmentService.ts'

/** wsl.exe 管理类动作（--terminate）超时（冷启动可达数秒）。 */
export const WSL_ACTION_TIMEOUT_MS = 30_000
/** boot（wsl -d … -e true）冷启动放宽到 60s。 */
export const WSL_BOOT_TIMEOUT_MS = 60_000

/** devhub.wsl.status 出参（docs/08 §6.9）：包 adapter.wslStatus。 */
export type WslStatusInfo = WslStatus

/** 单发行版投影：tools/snapshotAt 无快照时为 null（不猜测），运行时字段如实。 */
export interface WslDistributionInfo {
  name: string
  version: string
  state: string
  isDefault?: boolean
  tools: EnvironmentToolInfo[] | null
  snapshotAt: number | null
}

export interface WslDistributionsInfo {
  available: boolean
  reason?: string
  distributions: WslDistributionInfo[]
  /** DB 是否存在任何 wsl detect 快照。 */
  toolSnapshot: 'available' | 'missing'
  hint?: string
}

/** wsl status：包 adapter.wslStatus（dashboard:summary 同源）。 */
export async function wslStatusInfo(): Promise<WslStatusInfo> {
  return probeWslStatus()
}

/** DB 最近 detect 快照：`wsl:<distro>` 环境名 → { snapshotAt, tools }。 */
function loadWslToolSnapshots(): Map<string, { snapshotAt: number; tools: EnvironmentToolInfo[] }> {
  const db = getDatabase()
  const snapshots = new Map<string, { snapshotAt: number; tools: EnvironmentToolInfo[] }>()
  const envRows = db.prepare("SELECT id, name FROM environments WHERE kind = 'wsl' ORDER BY id").all() as {
    id: number
    name: string
  }[]
  for (const env of envRows) {
    try {
      const full = loadEnvironmentWithTools(db, env.id)
      snapshots.set(full.name, { snapshotAt: full.detectedAt, tools: full.tools })
    } catch {
      // 单行读取失败跳过（约束 #25），不影响其余快照
    }
  }
  return snapshots
}

/**
 * 发行版列表（实时 state/version/isDefault）+ DB 工具摘要快照（docs/08 §6.10）。
 * WSL 不可用 → { available:false, reason, distributions:[] }；
 * 从未 detect 过 → toolSnapshot:'missing' + hint（运行时状态仍如实给出）。
 */
export async function wslDistributions(): Promise<WslDistributionsInfo> {
  const status = await probeWslStatus()
  if (!status.available) {
    const snapshots = loadWslToolSnapshots()
    return {
      available: false,
      reason: status.detail ?? 'wsl.exe could not be probed',
      distributions: [],
      toolSnapshot: snapshots.size > 0 ? 'available' : 'missing',
      hint: snapshots.size > 0 ? undefined : 'run devhub.environment.detect to build the tool snapshot',
    }
  }

  const snapshots = loadWslToolSnapshots()
  const allDistros = await listDistros()

  const distributions: WslDistributionInfo[] = allDistros.map((distro) => {
    const snapshot = snapshots.get(`wsl:${distro.name}`)
    return {
      name: distro.name,
      version: distro.version,
      state: distro.state,
      isDefault: distro.isDefault,
      tools: snapshot !== undefined ? snapshot.tools : null,
      snapshotAt: snapshot !== undefined ? snapshot.snapshotAt : null,
    }
  })

  return {
    available: true,
    distributions,
    toolSnapshot: snapshots.size > 0 ? 'available' : 'missing',
    hint: snapshots.size > 0 ? undefined : 'run devhub.environment.detect to build the tool snapshot',
  }
}

// ---------------------------------------------------------------------------
// S4：WSL 概要（/proc 类）与动作（docs/09 §8.2/§9）
// ---------------------------------------------------------------------------

/** docker-desktop 系发行版由 Docker Desktop 管理：不取数、不动作，只显示状态。 */
function isDockerDesktopDistro(name: string): boolean {
  return name.toLowerCase().startsWith('docker-desktop')
}

/**
 * 已知发行版名列表（网关侧 distro 白名单校验的数据源，versions:update 的
 * catalog 白名单同款模式）。wsl.exe 不可达 → 空数组（此时任何 distro 都会被
 * 白名单拒绝，结构化 BAD_PAYLOAD，语义安全）。
 */
export async function knownDistroNames(): Promise<string[]> {
  try {
    return (await listDistros()).map((d) => d.name)
  } catch {
    return []
  }
}

function statViewOf(
  distro: WslDistro,
  stats: WslDistroStatView['stats'],
  reason?: string,
): WslDistroStatView {
  return {
    name: distro.name,
    state: distro.state,
    version: distro.version,
    isDefault: distro.isDefault,
    managedByDocker: isDockerDesktopDistro(distro.name),
    stats,
    reason,
  }
}

/** 仅 Running 且非 docker-desktop 系才读 /proc；其余显式 null + 结构化 reason（绝不硬造）。 */
async function distroStatView(distro: WslDistro): Promise<WslDistroStatView> {
  if (isDockerDesktopDistro(distro.name)) {
    return statViewOf(distro, null, 'managed by Docker Desktop; stats are not probed')
  }
  if (distro.state.toLowerCase() !== 'running') {
    return statViewOf(distro, null, `distro is ${distro.state}; not probed to avoid starting it`)
  }
  try {
    return statViewOf(distro, await readDistroStats(distro.name))
  } catch (err) {
    return statViewOf(distro, null, `stats probe failed: ${errorMessage(err)}`)
  }
}

/**
 * 单发行版概要（wslSystemInfo，docs/09 §8.2 wsl:distroStats 单查形态）：
 * uptime/mem 等取自一次 /proc 复合读取；探测不到 → stats=null + reason，绝不猜测。
 */
export async function wslSystemInfo(distro: string): Promise<WslDistroStatView> {
  const all = await listDistros()
  const hit = all.find((d) => d.name === distro)
  if (hit === undefined) {
    throw new ServiceError('NOT_FOUND', `distro not found: ${distro}`)
  }
  return distroStatView(hit)
}

/**
 * 发行版概要批量形态：缺省全部已知发行版；带 distro 只返回该发行版（仍为数组形态）。
 * WSL 不可用 → { available:false, reason, distros:[] } 结构化降级。
 * 并行取数但绝不启动已停止的发行版（distroStatView 内部先看 state）。
 */
export async function wslDistroStatsSummary(distro?: string): Promise<WslDistroStatsResult> {
  const sampledAt = nowSec()
  const status = await probeWslStatus()
  if (!status.available) {
    return {
      available: false,
      reason: status.detail ?? 'wsl.exe could not be probed',
      sampledAt,
      distros: [],
    }
  }
  const all = await listDistros()
  const targets = distro !== undefined ? all.filter((d) => d.name === distro) : all
  const views = await Promise.all(
    targets.map(async (d) => {
      try {
        return await distroStatView(d)
      } catch (err) {
        return statViewOf(d, null, `stats probe failed: ${errorMessage(err)}`)
      }
    }),
  )
  return { available: true, sampledAt, distros: views }
}

/** terminate 影响面：该发行版当前监听 TCP 端口（Running 才探测；Stopped 如实标注 no-op）。 */
async function terminateImpacts(distro: WslDistro): Promise<WslActionImpacts> {
  let listeningPorts: WslPortEntry[] = []
  let note: string | undefined
  if (distro.state.toLowerCase() !== 'running') {
    note = `distro is ${distro.state}; terminate would be a no-op`
  } else {
    try {
      listeningPorts = await wslListeningSockets(distro.name)
      if (listeningPorts.length === 0) note = 'no listening TCP ports observed in this distro'
    } catch (err) {
      note = `listening port probe failed (${errorMessage(err)}); impacts incomplete`
    }
  }
  return { distro: distro.name, state: distro.state, listeningPorts, note }
}

/**
 * shutdownAll 参数构造（纯函数，smoke 断言 argv；夜间#1 批次，docs/09 §8.2）。
 * `wsl.exe --shutdown` = 整个 WSL VM 级关停：全部发行版（含 docker-desktop 系）一并停止。
 */
export function shutdownAllArgs(): string[] {
  return ['--shutdown']
}

/**
 * shutdownAll 两段式（docs/09 §8.2 CONFIRM_REQUIRED + 二次确认文案，夜间#1 批次）：
 *  - 未带 confirmed → { confirmRequired, impacts }（将停的全部发行版清单 + docker-desktop
 *    系单列 + VM 级关停 note），绝不执行；
 *  - confirmed → `wsl.exe --shutdown`（exec 字面量 args）；
 *  - 语义 = 全停：只读列表探测（`wsl.exe -l -v` 不启动任何发行版），绝不唤醒已停发行版；
 *  - wsl.exe 不可达 → { ok:false, error: reason } 结构化降级，绝不 throw。
 */
export async function wslShutdownAll(confirmed?: boolean): Promise<WslShutdownAllStart | WslShutdownAllResult> {
  let all: WslDistro[]
  try {
    all = await listDistros()
  } catch (err) {
    return {
      ok: false,
      action: 'shutdownAll',
      runningBefore: 0,
      totalBefore: 0,
      error: `wsl.exe could not be probed: ${errorMessage(err)}`,
    }
  }

  const runningBefore = all.filter((d) => d.state.toLowerCase() === 'running').length
  if (confirmed !== true) {
    const dockerDesktopDistros = all.filter((d) => isDockerDesktopDistro(d.name)).map((d) => d.name)
    const impacts: WslShutdownAllImpacts = {
      distros: all.map((d) => ({ name: d.name, state: d.state })),
      dockerDesktopDistros,
      note:
        `wsl.exe --shutdown stops the whole WSL VM: all ${all.length} distro(s) listed above (${runningBefore} running)` +
        (dockerDesktopDistros.length > 0
          ? `, including docker-desktop distro(s) ${dockerDesktopDistros.join(', ')} managed by Docker Desktop`
          : '') +
        '; stopped distros are NOT booted by this action',
    }
    return { confirmRequired: true, action: 'shutdownAll' as const, impacts }
  }

  const res = await run('wsl.exe', shutdownAllArgs(), {
    timeoutMs: WSL_ACTION_TIMEOUT_MS,
    env: { ...process.env, WSL_UTF8: '1' },
  })
  const detail = (res.stderr || res.stdout || '').replace(/\u0000/g, '').trim().slice(0, 300)
  if (res.code !== 0 || res.timedOut) {
    return {
      ok: false,
      action: 'shutdownAll',
      runningBefore,
      totalBefore: all.length,
      error:
        detail.length > 0
          ? detail
          : res.timedOut
            ? `wsl --shutdown timed out after ${WSL_ACTION_TIMEOUT_MS}ms`
            : `wsl --shutdown exited with ${res.code}`,
    }
  }
  return {
    ok: true,
    action: 'shutdownAll',
    runningBefore,
    totalBefore: all.length,
    detail: detail.length > 0 ? detail : `WSL shut down (${runningBefore} running distro(s) stopped)`,
  }
}

/**
 * WSL 变更动作编排（docs/09 §8.2/§9 wsl:action）：
 *  - terminate：CONFIRM_REQUIRED 两段式 —— 未带 confirmed 返回 { confirmRequired, impacts }
 *    （列出监听端口），绝不执行；confirmed 才发 `wsl.exe --terminate <distro>`；
 *  - boot：无害幂等（`wsl.exe -d <distro> -e true`），直接执行（任务书：boot 不需确认）；
 *  - distro 不在已知列表 / docker-desktop 系 → ServiceError（BAD_PAYLOAD / NOT_FOUND）。
 * wsl.exe 输出按 UTF-16 噪声清洗（剥 NUL）后截断为摘要。
 */
export async function wslAction(
  distro: string,
  action: WslActionName,
  confirmed?: boolean,
): Promise<WslActionStart | WslActionResult> {
  const all = await listDistros()
  const hit = all.find((d) => d.name === distro)
  if (hit === undefined) {
    throw new ServiceError('NOT_FOUND', `distro not found: ${distro}`)
  }
  if (isDockerDesktopDistro(distro)) {
    throw new ServiceError('BAD_PAYLOAD', `distro ${distro} is managed by Docker Desktop; terminate/boot are refused`)
  }

  if (action === 'boot') {
    const res = await run('wsl.exe', ['-d', distro, '-e', 'true'], {
      timeoutMs: WSL_BOOT_TIMEOUT_MS,
      env: { ...process.env, WSL_UTF8: '1' },
    })
    const detail = (res.stderr || res.stdout || '').replace(/\u0000/g, '').trim().slice(0, 300)
    if (res.code !== 0 || res.timedOut) {
      return {
        ok: false,
        distro,
        action,
        error:
          detail.length > 0
            ? detail
            : res.timedOut
              ? `wsl boot timed out after ${WSL_BOOT_TIMEOUT_MS}ms`
              : `wsl boot exited with ${res.code}`,
      }
    }
    return { ok: true, distro, action, detail: detail.length > 0 ? detail : `distro ${distro} is running` }
  }

  // terminate：两段式（impacts 探测对 Running 发行版是只读的，不改变状态）
  if (confirmed !== true) {
    return { confirmRequired: true, impacts: await terminateImpacts(hit) }
  }
  const res = await run('wsl.exe', ['--terminate', distro], {
    timeoutMs: WSL_ACTION_TIMEOUT_MS,
    env: { ...process.env, WSL_UTF8: '1' },
  })
  const detail = (res.stderr || res.stdout || '').replace(/\u0000/g, '').trim().slice(0, 300)
  if (res.code !== 0 || res.timedOut) {
    return {
      ok: false,
      distro,
      action,
      error:
        detail.length > 0
          ? detail
          : res.timedOut
            ? `wsl --terminate timed out after ${WSL_ACTION_TIMEOUT_MS}ms`
            : `wsl --terminate exited with ${res.code}`,
    }
  }
  return { ok: true, distro, action, detail: detail.length > 0 ? detail : `distro ${distro} terminated` }
}
