/**
 * skills/wslScan.ts — WSL 侧 companion 扫描 + 缓存降级（两阶段扫描的第二阶段；
 * Skill-Manager src/main/wslScan.ts 归宿）。
 * companion 不可达/超时（20s）时回落缓存文件，绝不阻塞、绝不白屏；
 * 缓存命中时 stale=true，由 UI 标注「缓存时间」并提供重试。
 */

import fs from 'node:fs'
import path from 'node:path'
import type { SkillMeta, SkillsScanWslResult, WslSkillsScanPayload } from '../../../shared/types.ts'
import { runCompanion } from './wslBridge.ts'

/** skills:scanWsl 的 companion 超时上限（老实现同值 20s，全程异步不冻结事件循环）。 */
export const SCAN_WSL_TIMEOUT_MS = 20_000

/** 缓存新鲜度阈值（超过即标记 stale，UI 标注；companion 扫描成功会重写时间戳）。 */
export const WSL_CACHE_STALE_MS = 10 * 60 * 1000

/** 读缓存：形状校验（ts 数字 + agents/skills 数组），任何异常按无缓存处理 */
export function readWslScanCache(file: string): WslSkillsScanPayload | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<WslSkillsScanPayload>
    if (typeof raw.ts !== 'number' || !Array.isArray(raw.agents) || !Array.isArray(raw.skills)) return null
    return { ts: raw.ts, agents: raw.agents as WslSkillsScanPayload['agents'], skills: raw.skills as SkillMeta[] }
  } catch {
    return null
  }
}

/** 写缓存（临时文件 + rename 原子替换）；失败静默（缓存属加速手段，不致命） */
export function writeWslScanCache(file: string, payload: WslSkillsScanPayload): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8')
    fs.renameSync(tmp, file)
  } catch {
    /* 缓存写入失败可忽略 */
  }
}

/**
 * 第二阶段：调 companion scan（20s 超时）。
 * 成功 → 写缓存并返回 { report, stale:false }；
 * 失败/超时 → 读缓存，命中返回 { report: cached, stale:true, reason }，未命中 { report:null, stale:false, reason }。
 */
export async function runWslScan(distro: string, cacheFile: string): Promise<SkillsScanWslResult> {
  const c = await runCompanion(distro, ['scan'], SCAN_WSL_TIMEOUT_MS)
  const p = c.parsed as { ok?: boolean; skills?: SkillMeta[]; agents?: WslSkillsScanPayload['agents'] } | undefined
  if (c.ok && p !== undefined && p !== null && typeof p === 'object' && p.ok === true && Array.isArray(p.agents)) {
    const payload: WslSkillsScanPayload = {
      ts: Date.now(),
      agents: p.agents,
      skills: Array.isArray(p.skills) ? p.skills : [],
    }
    writeWslScanCache(cacheFile, payload)
    return { report: payload, stale: false }
  }
  const reason = `WSL companion 不可达: ${(c.parseError || c.stderr || c.stdout || '无输出').slice(0, 200)}`
  const cached = readWslScanCache(cacheFile)
  if (cached !== null) return { report: cached, stale: true, reason }
  return { report: null, stale: false, reason }
}
