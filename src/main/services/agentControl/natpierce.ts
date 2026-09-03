/**
 * natpierce.ts — NatPierce 隧道配置投影（docs/15 §8 边界的 AC8 落地，docs/16 §1
 * AC8 行「NatPierce 隧道透传验证（用户自备凭据，外置配置）」）。
 *
 * 边界（docs/15 §8，零改动引用）：
 * - 只传输不替代鉴权：投影只回答「隧道配置了吗/通了吗」，绝不改变任何安全决策；
 * - 凭据外置：endpoint/account/token 只来自环境变量（NATPIERCE_ENDPOINT /
 *   NATPIERCE_ACCOUNT / NATPIERCE_TOKEN），不入仓库、不入 settings 表、不入日志；
 *   本模块读取后只产出 configured/reachable 布尔与引导文案，值本身零投影。
 * - DevHub 不启动、不安装、不修改 NatPierce；reachable 为一次出站健康探测。
 *   出站 host 来自用户外置配置（用户显式行为的延伸，docs/15 §9 表 NatPierce 行
 *   豁免场景）；协议仅允许 http/https。
 *
 * 形状纪律：三者全未配置时返回与 AC2 契约逐字节一致的 `{ configured: false }`
 * （smoke ac2-87 deepEqual 锁定；未配置态的引导 = Agents 视图静态文案 +
 * docs/natpierce-setup.md）。部分配置 → configured:false + hint（只含变量名，
 * 不含值）；齐备 → configured:true + reachable（60s 缓存）。
 *
 * electron-free：零 electron import；fetch 为 Node 全局。
 */

import type { GatewayNatPierceStatus } from '../../../shared/types.ts'
import { nowSec } from '../internal.ts'

/** 外置配置环境变量名（docs/15 §8「环境变量或密钥服务」的环境变量形态）。 */
export const NATPIERCE_ENV_KEYS = ['NATPIERCE_ENDPOINT', 'NATPIERCE_ACCOUNT', 'NATPIERCE_TOKEN'] as const

export interface NatPierceConfig {
  endpoint: string | null
  account: string | null
  token: string | null
}

/** 读取外置配置（trim；空串视同未配置）。只返回原始值给探测/齐备性判定，绝不投影。 */
export function readNatPierceConfig(env: NodeJS.ProcessEnv = process.env): NatPierceConfig {
  const read = (key: string): string | null => {
    const raw = env[key]
    return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null
  }
  return {
    endpoint: read('NATPIERCE_ENDPOINT'),
    account: read('NATPIERCE_ACCOUNT'),
    token: read('NATPIERCE_TOKEN'),
  }
}

/** 引导文案：只列缺失变量名 + 文档指引，绝不包含任何配置值（docs/15 §6 红线）。 */
export function natpierceHintFor(missing: readonly string[]): string {
  return `NatPierce tunnel not fully configured: missing env ${missing.join(', ')} — see docs/natpierce-setup.md (credentials stay external: never in repo, settings, or logs)`
}

/** reachable 探测超时（隧道健康探测必须短促，绝不拖慢 gatewayStatus 投影）。 */
const REACHABLE_PROBE_TIMEOUT_MS = 3_000
/** reachable 结果缓存（gatewayStatus 每 ~2s 被轮询；出站探测按 60s 节流）。 */
const REACHABLE_CACHE_TTL_SEC = 60

let reachableCache: { endpoint: string; at: number; value: boolean } | null = null

/** smoke/测试复位（进程内多次隔离场景；生产不调用）。 */
export function resetNatPierceProbeCache(): void {
  reachableCache = null
}

/**
 * 一次出站健康探测：GET <endpoint>，任意 HTTP 响应（任意状态码）= 可达。
 * 协议白名单 http/https；host 来自用户外置配置（docs/15 §9 豁免场景——用户
 * 显式行为的延伸，且隧道连接本就由用户自己的 NatPierce 进程发起）。
 * 任何错误/超时/非法 URL → false（结构化布尔，绝不抛）。
 */
export async function probeNatPierceReachable(endpoint: string, timeoutMs = REACHABLE_PROBE_TIMEOUT_MS): Promise<boolean> {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url, { signal: controller.signal, redirect: 'manual' })
      return res.status > 0
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return false
  }
}

function missingKeys(cfg: NatPierceConfig): string[] {
  const missing: string[] = []
  if (cfg.endpoint === null) missing.push('NATPIERCE_ENDPOINT')
  if (cfg.account === null) missing.push('NATPIERCE_ACCOUNT')
  if (cfg.token === null) missing.push('NATPIERCE_TOKEN')
  return missing
}

/**
 * 同步投影（agents:gatewayStatus 每 ~2s 轮询面）：齐备性 + 缓存的 reachable。
 * 三者全缺 → `{ configured: false }`（AC2 契约形状逐字节保持）；部分缺 →
 * + hint；齐备 → configured:true（reachable 仅在缓存新鲜时携带）。
 */
export function computeNatPierceStatus(cfg: NatPierceConfig = readNatPierceConfig()): GatewayNatPierceStatus {
  const missing = missingKeys(cfg)
  if (missing.length === NATPIERCE_ENV_KEYS.length) return { configured: false }
  if (missing.length > 0) return { configured: false, hint: natpierceHintFor(missing) }
  const status: GatewayNatPierceStatus = { configured: true }
  if (
    reachableCache !== null &&
    cfg.endpoint !== null &&
    reachableCache.endpoint === cfg.endpoint &&
    nowSec() - reachableCache.at <= REACHABLE_CACHE_TTL_SEC
  ) {
    status.reachable = reachableCache.value
  }
  return status
}

/**
 * 异步刷新（agents:diagnostics / REST /v1/diagnostics 面）：endpoint 已配置时
 * 做一次节流探测（60s 缓存）后返回投影；部分配置态同样携带 reachable
 * （用户能先看到「隧道端点通不通」，再补齐凭据）。未配置 endpoint 时零出站。
 */
export async function refreshNatPierceStatus(cfg: NatPierceConfig = readNatPierceConfig()): Promise<GatewayNatPierceStatus> {
  const missing = missingKeys(cfg)
  if (missing.length === NATPIERCE_ENV_KEYS.length) return { configured: false }
  if (cfg.endpoint !== null) {
    const cacheFresh = reachableCache !== null && reachableCache.endpoint === cfg.endpoint && nowSec() - reachableCache.at <= REACHABLE_CACHE_TTL_SEC
    if (!cacheFresh) {
      const value = await probeNatPierceReachable(cfg.endpoint)
      reachableCache = { endpoint: cfg.endpoint, at: nowSec(), value }
    }
    const status = computeNatPierceStatus(cfg)
    status.reachable = reachableCache !== null && reachableCache.endpoint === cfg.endpoint ? reachableCache.value : false
    return status
  }
  return computeNatPierceStatus(cfg)
}
