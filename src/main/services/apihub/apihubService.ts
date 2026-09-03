/**
 * apihubService.ts — ApiHub 编排（S3 批次，docs/09 §6/§9）。
 *
 * 职责：适配器目录 / readCurrent 脱敏读 / 档案 CRUD（经注入 KeyCrypto seal）/
 * 两段式切换（CONFIRM_REQUIRED：impacts 预览 → confirmed 执行）。
 *
 * 切换骨架（老实现原样移植，docs/09 §6.3）：
 *   预检目标进程（tasklist 经 core/exec）→ 确认后（可选 killPids 终止，须与
 *   impacts 列出的 pid 一致）→ 逐目标文件备份（.bak_<stamp>）→ 临时文件 + rename
 *   原子写 → 重读校验 → 任一失败按备份逆序整体回滚 → 结构化逐文件结果。
 *
 * 红线：key 明文只存在于内存与目标配置文件；返回值/日志只回 maskKey 尾 4 位。
 * homeDir / KeyCrypto / 进程探测 / 时钟全部可注入（smoke 夹具隔离，真实
 * ~/.claude、~/.codex 等零改动）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { run } from '../../core/exec.ts'
import type {
  ApiHubAdapterEntry,
  ApiHubAdapterId,
  ApiHubCurrentResult,
  ApiHubFileResult,
  ApiHubProfilesResult,
  ApiHubProfileView,
  ApiHubSaveProfileResult,
  ApiHubSwitchImpacts,
  ApiHubSwitchResult,
  ApiHubSwitchStart,
} from '../../../shared/types.ts'
import { ServiceError } from '../internal.ts'
import { getKeyCrypto, maskKey, type KeyCrypto } from './keyStore.ts'
import {
  adapterEntries,
  adapterPaths,
  backupSuffix,
  fileExists,
  findAdapter,
  kimiCompositeKey,
  prepareWrites,
  readCurrent,
  resolveHomeDir,
  validateHubFields,
  verifyWrites,
} from './adapters.ts'
import {
  decryptProfileKey,
  getProfile,
  listProfileViews,
  removeProfile,
  upsertProfile,
} from './profileStore.ts'

/** service 可注入依赖（smoke / 测试用；缺省走 APIHUB_HOME 或真实 home + 全局 KeyCrypto）。 */
export interface ApiHubDeps {
  homeDir?: string
  crypto?: KeyCrypto
  now?: () => Date
  /** 进程探测注入（缺省 tasklist 真实探测）。 */
  probeProcesses?: (names: string[]) => Promise<{ pid: number; name: string }[]>
}

function depsOf(deps?: ApiHubDeps): Required<Pick<ApiHubDeps, 'homeDir'>> & ApiHubDeps {
  return { homeDir: resolveHomeDir(deps?.homeDir), ...(deps ?? {}) }
}

function cryptoOf(deps?: ApiHubDeps): KeyCrypto {
  return deps?.crypto ?? getKeyCrypto()
}

// ---------------------------------------------------------------------------
// 进程探测（tasklist 经 core/exec；Windows adapter 同款字面量参数模式）
// ---------------------------------------------------------------------------

/** 解析 tasklist CSV 行；字段均带引号，容错不平衡引号/空行（与 windows adapter 同款）。 */
function parseCsvLine(line: string): string[] | null {
  const trimmed = line.trim()
  if (trimmed.length === 0) return null
  const fields = trimmed.match(/"((?:[^"]|"")*)"/g)
  if (fields === null) return null
  return fields.map((f) => f.slice(1, -1).replace(/""/g, '"'))
}

/** 按进程名（大小写不敏感）列出运行中的进程（tasklist /FI 字面量参数，15s 超时）。 */
export async function findRunningProcesses(names: readonly string[]): Promise<{ pid: number; name: string }[]> {
  const hits: { pid: number; name: string }[] = []
  const seen = new Set<number>()
  for (const target of names) {
    const res = await run('tasklist', ['/FI', `IMAGENAME eq ${target}`, '/FO', 'CSV', '/NH'], { timeoutMs: 15_000 })
    if (res.code !== 0 || res.timedOut) continue
    for (const line of res.stdout.split(/\r?\n/)) {
      const fields = parseCsvLine(line)
      if (fields === null || fields.length < 2) continue
      if (fields[0].toLowerCase() !== target.toLowerCase()) continue
      const pid = Number.parseInt(fields[1], 10)
      if (!Number.isFinite(pid) || seen.has(pid)) continue
      seen.add(pid)
      hits.push({ pid, name: fields[0] })
    }
  }
  return hits
}

async function probe(deps: ApiHubDeps | undefined, names: string[]): Promise<{ pid: number; name: string }[]> {
  if (deps?.probeProcesses !== undefined) return deps.probeProcesses(names)
  if (names.length === 0) return []
  return findRunningProcesses(names)
}

// ---------------------------------------------------------------------------
// 适配器目录 / 当前读取 / 档案 CRUD
// ---------------------------------------------------------------------------

/** apihub:adapters：7 适配器目录（可用 / N/A 徽章 + 目标文件 + 预检进程）。 */
export function listAdapters(deps?: ApiHubDeps): ApiHubAdapterEntry[] {
  return adapterEntries(depsOf(deps).homeDir)
}

/** apihub:current：readCurrent 脱敏视图（N/A 适配器返回结构化 unavailable）。 */
export async function currentAdapter(adapterId: ApiHubAdapterId, deps?: ApiHubDeps): Promise<ApiHubCurrentResult> {
  const home = depsOf(deps).homeDir
  const crypto = cryptoOf(deps)
  const profiles = await listProfileViews(adapterId, crypto)
  return readCurrent(adapterId, home, profiles)
}

/** apihub:profiles：脱敏清单 + readCurrent 反推的 activeId。 */
export async function listProfiles(adapterId: ApiHubAdapterId, deps?: ApiHubDeps): Promise<ApiHubProfilesResult> {
  const home = depsOf(deps).homeDir
  const crypto = cryptoOf(deps)
  const profiles = await listProfileViews(adapterId, crypto)
  const current = readCurrent(adapterId, home, profiles)
  return { profiles, activeId: current.matchedProfileId }
}

/** apihub:saveProfile：字段校验 → seal 入库 → 脱敏视图（key 明文仅本次 payload）。 */
export async function saveProfile(
  input: { adapterId: ApiHubAdapterId; id?: number; name: string; fields: Record<string, string> },
  apiKeyPlain: string | undefined,
  deps?: ApiHubDeps,
): Promise<ApiHubSaveProfileResult> {
  const crypto = cryptoOf(deps)
  const info = findAdapter(input.adapterId)
  if (!info.needsKey && apiKeyPlain !== undefined && apiKeyPlain.trim().length > 0) {
    throw new ServiceError('BAD_PAYLOAD', `${info.label} 不需要 API Key`)
  }
  const validation = validateHubFields(input.adapterId, input.fields)
  if (validation !== null) throw new ServiceError('BAD_PAYLOAD', validation)
  if (info.needsKey && input.id === undefined && (apiKeyPlain === undefined || apiKeyPlain.trim().length === 0)) {
    throw new ServiceError('BAD_PAYLOAD', 'API Key 不能为空')
  }
  const profile = await upsertProfile(input, apiKeyPlain, crypto)
  return { profile }
}

/** apihub:deleteProfile。 */
export function deleteProfile(adapterId: ApiHubAdapterId, id: number): { deleted: boolean } {
  findAdapter(adapterId)
  return removeProfile(adapterId, id)
}

// ---------------------------------------------------------------------------
// 两段式切换
// ---------------------------------------------------------------------------

/** 切换 impacts：将写入的文件 + 检测到的运行中进程（zcode 预检）。 */
export async function switchImpacts(adapterId: ApiHubAdapterId, _profileId: number, deps?: ApiHubDeps): Promise<ApiHubSwitchImpacts> {
  const home = depsOf(deps).homeDir
  const files = adapterPaths(adapterId, home)
  const names = findAdapter(adapterId).available ? (adapterEntries(home).find((a) => a.id === adapterId)?.processNames ?? []) : []
  const processes = await probe(deps, names)
  return {
    files,
    processes,
    ...(adapterId === 'zcode' ? { warning: '重启 ZCode 后生效；若选中键形态派生有误，请在 ZCode 模型设置中核对' } : {}),
  }
}

/** kill 单个 pid（taskkill /T /F 经 core/exec；仅允许 impacts 探测过的 pid）。 */
async function killProcess(pid: number): Promise<void> {
  await run('taskkill', ['/pid', String(pid), '/t', '/f'], { timeoutMs: 15_000 })
}

/**
 * 一键切换（CONFIRM_REQUIRED 两段式）：
 * - 不带 confirmed：返回 { confirmRequired:true, impacts }（文件清单 + 运行中进程），不执行；
 * - confirmed：needs_rekey 档案拒绝（KEY_UNAVAILABLE 语义走 DEGRADED）→ 可选终止 impacts 内
 *   pid → 逐文件备份 → 原子写 → 重读校验 → 失败回滚 → { files[], backupFiles, warning? }。
 */
export async function switchProfile(
  adapterId: ApiHubAdapterId,
  profileId: number,
  confirmed?: boolean,
  deps?: ApiHubDeps & { killPids?: number[] },
): Promise<ApiHubSwitchStart | ApiHubSwitchResult> {
  const info = findAdapter(adapterId)
  if (!info.available) {
    throw new ServiceError('BAD_PAYLOAD', `该适配器不支持切换: ${adapterId}（${info.naReason ?? 'N/A'}）`)
  }
  const home = depsOf(deps).homeDir
  const crypto = cryptoOf(deps)
  const now = deps?.now ?? (() => new Date())

  const impacts = await switchImpacts(adapterId, profileId, deps)
  if (confirmed !== true) {
    return { confirmRequired: true, impacts }
  }

  const profile = await getProfile(adapterId, profileId)
  if (profile.needsRekey) {
    throw new ServiceError('DEGRADED', `档案「${profile.name}」的密钥待重加密/重录（needs_rekey），禁止切换；请编辑档案重新录入 API Key`)
  }
  const apiKeyPlain = await decryptProfileKey(profile, crypto)
  if (apiKeyPlain === null) {
    throw new ServiceError('DEGRADED', `档案「${profile.name}」的密钥无法解密（密钥不可用），请编辑档案重新录入 API Key`)
  }

  // 可选终止：killPids 必须与 impacts 探测到的 pid 完全对得上（再次确认 + 明确 pid 列表）
  const killPids = deps?.killPids ?? []
  if (killPids.length > 0) {
    const known = new Set(impacts.processes.map((p) => p.pid))
    for (const pid of killPids) {
      if (!known.has(pid)) {
        throw new ServiceError('BAD_PAYLOAD', `killPids 中的 pid ${pid} 不在预检结果内（拒绝终止未确认的进程）`)
      }
    }
    for (const pid of killPids) await killProcess(pid)
  }

  // 1) 组装写入
  const writes = prepareWrites(adapterId, home, profile.fields, apiKeyPlain)

  // 2) 备份（已存在才备份）
  const suffix = backupSuffix(now())
  const backupFiles: string[] = []
  const existed: string[] = []
  for (const w of writes) {
    if (fileExists(w.path)) {
      existed.push(w.path)
      const backup = w.path + suffix
      fs.copyFileSync(w.path, backup)
      backupFiles.push(backup)
    }
  }

  // 3+4) 原子写（tmp + rename）→ 重读校验；任一步失败按备份回滚已写文件后返回
  // 结构化失败结果（逐文件 written/rolledBack，UI 失败文件标红 + 已回滚提示）。
  const files: ApiHubFileResult[] = []
  const rollbackAll = (reason: string): ApiHubSwitchResult => {
    for (let i = 0; i < writes.length; i++) {
      const w = writes[i]
      try {
        if (existed.includes(w.path)) {
          // 先解只读（Windows 上目标文件只读会导致恢复拷贝失败），再按备份恢复
          try {
            fs.chmodSync(w.path, 0o666)
          } catch {
            /* 尽力而为：解只读失败时恢复拷贝的错误照常上报 */
          }
          fs.copyFileSync(backupFiles[i], w.path)
          files.push({ path: w.path, written: true, rolledBack: true })
        } else {
          if (fs.existsSync(w.path)) fs.unlinkSync(w.path)
          files.push({ path: w.path, written: false, rolledBack: false })
        }
      } catch (rollbackErr) {
        files.push({
          path: w.path,
          written: true,
          rolledBack: false,
          error: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
        })
      }
    }
    return { files, backupFiles, failed: true, error: reason }
  }

  const tmpFiles: string[] = []
  try {
    for (const w of writes) {
      fs.mkdirSync(path.dirname(w.path), { recursive: true })
      const tmp = w.path + '.tmp-' + process.pid + '-' + Date.now()
      tmpFiles.push(tmp)
      fs.writeFileSync(tmp, w.next, 'utf8')
      fs.renameSync(tmp, w.path)
    }
  } catch (err) {
    for (const tmp of tmpFiles) {
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
      } catch {
        /* 清理失败不掩盖原错误 */
      }
    }
    return rollbackAll('写入目标文件失败: ' + (err instanceof Error ? err.message : String(err)))
  }

  try {
    verifyWrites(adapterId, home, profile.fields, apiKeyPlain)
  } catch (err) {
    return rollbackAll(err instanceof Error ? err.message : String(err))
  }

  // 5) 成功：逐文件结构化结果（written=true / rolledBack=false）
  const written: ApiHubFileResult[] = writes.map((w) => ({ path: w.path, written: true, rolledBack: false }))
  return {
    files: written,
    backupFiles,
    ...(adapterId === 'zcode' ? { warning: '重启 ZCode 后生效；若选中键形态派生有误，请在 ZCode 模型设置中核对' } : {}),
  }
}

/** 开发辅助：maskKey 行为自检（返回值只有 mask 形态，绝不含全值）。 */
export function maskTest(sample: string): { tail: string; len: number } {
  return maskKey(sample)
}

// re-export 供 handlers / smoke 使用
export { kimiCompositeKey, listProfileViews }
export type { ApiHubProfileView }
