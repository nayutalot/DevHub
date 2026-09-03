// 占用进程检测与结束（Windows）。
// S5 批次自 ArchiveKeeper `main/services/procGuard.ts` 移植（docs/10 §6.2），
// 外部命令全部经 core/exec.run()（约束 #7/#8：argv 数组 + shell:false）：
// - 检测：PowerShell 静态字面量查 Win32_Process（pid/name/exe/cmdline 一次取全，
//   相比 adapters/windows.ts 的 tasklist 快照多了 ExecutablePath/CommandLine 两列，
//   供「进程是否引用项目路径」判定；模式与 adapter 的 PROCESS_DETAILS_SCRIPT 一致）；
// - 过滤：可执行路径或命令行包含项目路径（带边界防 DemoWeb 误伤 DemoWeb2），
//   排除 DevHub 自身进程树，上限 30 条；
// - 探测：目录 rename 到同级临时名再改回（probeDirMovable）——被 CWD/句柄锁定即失败；
// - 结束：仅在用户确认后调用（CONFIRM_REQUIRED）：taskkill /PID <pid> /T 温和
//   → 2.5s 存活则 /T /F 强制 → 仍失败列入 failed 清单。参数数组经 exec。
import * as fsp from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { run } from '../../core/exec.ts'

export interface RawProc {
  pid: number
  name: string
  exe: string
  cmd: string
}

export interface Occupier {
  pid: number
  name: string
  /** 命令行（截断展示） */
  cmd: string
}

function normDir(p: string): string {
  return p.toLowerCase().replace(/\//g, '\\').replace(/[\\/]+$/, '')
}

/**
 * 系统全部进程快照（一次 CIM 查询）；失败返回空。
 * 脚本为静态字面量（约束 #12），无任何动态值注入。
 */
const PROCESS_SNAPSHOT_SCRIPT =
  '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' +
  'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress'

export async function listProcesses(): Promise<RawProc[]> {
  if (process.platform !== 'win32') return []
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PROCESS_SNAPSHOT_SCRIPT], {
    timeoutMs: 20_000,
  })
  if (r.code !== 0 || r.timedOut) return []
  try {
    const parsed: unknown = JSON.parse(r.stdout)
    const arr = Array.isArray(parsed) ? parsed : [parsed]
    const out: RawProc[] = []
    for (const x of arr) {
      if (typeof x !== 'object' || x === null) continue
      const p = x as { ProcessId?: unknown; Name?: unknown; ExecutablePath?: unknown; CommandLine?: unknown }
      const pid = typeof p.ProcessId === 'number' ? p.ProcessId : Number.parseInt(String(p.ProcessId ?? ''), 10)
      if (!Number.isSafeInteger(pid) || pid <= 0) continue
      out.push({
        pid,
        name: String(p.Name ?? ''),
        exe: String(p.ExecutablePath ?? ''),
        cmd: String(p.CommandLine ?? ''),
      })
    }
    return out
  } catch {
    return []
  }
}

/**
 * 从进程快照中筛选占用者：可执行路径或命令行包含项目路径（带边界，
 * 避免 DemoWeb 误伤 DemoWeb2）；排除本应用自身与其子进程（同 exe）。
 */
export function findOccupiers(procs: RawProc[], projectPath: string): Occupier[] {
  const target = normDir(projectPath)
  const selfExe = normDir(process.execPath)
  const out: Occupier[] = []
  for (const p of procs) {
    if (p.pid === process.pid) continue
    if (p.exe.length > 0 && (normDir(p.exe) === selfExe || normDir(p.exe).startsWith(`${selfExe}\\`))) continue
    const hay = normDir(`${p.exe}\n${p.cmd}`)
    let idx = hay.indexOf(target)
    let hit = false
    while (idx >= 0) {
      const after = hay.charCodeAt(idx + target.length)
      // 边界：路径后跟分隔符/引号/空白/结尾才算命中，防同前缀目录误伤
      // （数字/小写字母/下划线跟随 = 更长路径名，非命中）
      if (Number.isNaN(after) || (!(after >= 48 && after <= 57) && !(after >= 97 && after <= 122) && after !== 95)) {
        hit = true
        break
      }
      idx = hay.indexOf(target, idx + 1)
    }
    if (hit) out.push({ pid: p.pid, name: p.name, cmd: p.cmd.slice(0, 160) })
  }
  return out.slice(0, 30)
}

/** 查找占用某项目路径的进程（组合：快照 + 过滤）。 */
export async function findOccupiersForPath(projectPath: string): Promise<Occupier[]> {
  return findOccupiers(await listProcesses(), projectPath)
}

/**
 * 目录可移动性探测：rename 到同级临时名再改回。
 * Windows 下目录是某进程 CWD 或内有未共享删除的句柄时 rename 失败。
 */
export async function probeDirMovable(dir: string): Promise<boolean> {
  const probe = `${dir}.__movable_${randomUUID().slice(0, 8)}__`
  try {
    await fsp.rename(dir, probe)
  } catch {
    return false
  }
  try {
    await fsp.rename(probe, dir)
    return true
  } catch (e) {
    // 极端情况：改回失败，尽力恢复并显式报错
    await fsp.rename(probe, dir).catch(() => {})
    throw new Error(`占用探测异常（${(e as NodeJS.ErrnoException).code ?? String(e)}），已尝试恢复目录`)
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM' // 无权限但存在
  }
}

async function waitGone(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  return !isAlive(pid)
}

/**
 * 结束进程（仅在用户勾选 occupiers / 传 killPids 且 confirmed 后由编排层调用）：
 * 先温和 taskkill /T（GUI 程序可正常关闭），2.5s 后仍存活则 /T /F 强制。
 * 返回成功/失败清单。
 */
export async function killOccupierPids(pids: number[], onLog?: (msg: string) => void): Promise<{ killed: number[]; failed: number[] }> {
  const killed: number[] = []
  const failed: number[] = []
  for (const pid of pids) {
    if (!isAlive(pid)) {
      killed.push(pid)
      continue
    }
    await run('taskkill', ['/PID', String(pid), '/T'], { timeoutMs: 8000 })
    if (await waitGone(pid, 2500)) {
      killed.push(pid)
      onLog?.(`已结束进程 ${pid}`)
      continue
    }
    await run('taskkill', ['/PID', String(pid), '/T', '/F'], { timeoutMs: 8000 })
    if (await waitGone(pid, 3000)) {
      killed.push(pid)
      onLog?.(`已强制结束进程 ${pid}`)
    } else {
      failed.push(pid)
      onLog?.(`进程 ${pid} 无法结束（可能需要管理员权限或属于系统）`)
    }
  }
  return { killed, failed }
}
