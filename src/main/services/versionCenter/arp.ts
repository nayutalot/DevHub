/**
 * arp.ts — ARP 注册表只读检测通道（老 versionCenter/arp.ts 移植）。
 *
 * 用 reg query <root> /s 全量枚举三处 Uninstall 键（HKLM 64位 / HKLM WOW6432Node /
 * HKCU），按 HKEY_ 行分块解析 DisplayName / DisplayVersion。只读探测，
 * 无升级通道（DeepSeek Harness installRoot 缺失时的回退展示用）。
 */
import { run } from '../../core/exec.ts'

export const ARP_CHECK_TIMEOUT_MS = 90_000

export const ARP_QUERY_TARGETS = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
] as const

export interface ArpBlock {
  key: string
  displayName?: string
  displayVersion?: string
}

/** 解析 reg query /s 输出：HKEY_ 开头行开新块，块内抓 DisplayName / DisplayVersion（大小写不敏感） */
export function parseArpBlocks(out: string): ArpBlock[] {
  const blocks: ArpBlock[] = []
  let cur: ArpBlock | null = null
  for (const raw of String(out ?? '').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    if (/^HKEY_/i.test(line)) {
      if (cur !== null) blocks.push(cur)
      cur = { key: line }
      continue
    }
    if (cur === null) continue
    const nameM = line.match(/^\s*DisplayName\s+REG_[A-Z_]+\s+(.*)$/i)
    if (nameM !== null) {
      cur.displayName = nameM[1].trim()
      continue
    }
    const verM = line.match(/^\s*DisplayVersion\s+REG_[A-Z_]+\s+(.*)$/i)
    if (verM !== null) cur.displayVersion = verM[1].trim()
  }
  if (cur !== null) blocks.push(cur)
  return blocks
}

/** 三处根键并行枚举，返回首个命中条目；version 缺省 = 找到条目但无 DisplayVersion 或未找到；error = 全部 reg 查询失败 */
export async function arpInstalledVersion(displayName: string, deps: { timeoutMs?: number } = {}): Promise<{ version?: string; error?: string }> {
  const results = await Promise.all(
    ARP_QUERY_TARGETS.map((key) => run('reg', ['query', key, '/s'], { timeoutMs: deps.timeoutMs ?? ARP_CHECK_TIMEOUT_MS })),
  )
  let sawQueryError = false
  for (const r of results) {
    if (r.stdout.trim().length === 0) {
      if (r.code !== 0) sawQueryError = true
      continue
    }
    const hit = parseArpBlocks(r.stdout).find((b) => b.displayName !== undefined && b.displayName.toLowerCase().includes(displayName.toLowerCase()))
    if (hit !== undefined) return hit.displayVersion !== undefined ? { version: hit.displayVersion } : {}
  }
  return sawQueryError ? { error: 'reg query 全部失败，无法读取 ARP 注册表' } : {}
}
