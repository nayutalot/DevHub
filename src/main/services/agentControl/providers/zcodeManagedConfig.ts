/**
 * zcodeManagedConfig.ts — zcode 托管面配置源（T2 批，docs/briefs/t2-zcode-managed.md
 * 主控定案 #1：env 注入源 = ApiHub zcode 活动档案 + settings 模型键）。
 *
 * 事实链（Z1 侦察 REPORT Q1「模型配置前置条件（关键）」行，活体 run3 实证）：
 * - 独立 zcode CLI 必须自行提供模型 provider 配置（缺失 → model_config_missing）；
 *   桌面登录（~/.zcode/v2/credentials.json）**不**自动供 CLI 使用；
 * - env 引导已活体验证：`ZCODE_MODEL="provider/model"` + `ZCODE_BASE_URL` +
 *   `ZCODE_API_KEY`（+`<PROVIDER>_API_KEY`），dummy 值即跑通 session/create（零网络）。
 *
 * 配置来源（绝不读 ~/.zcode/v2/credentials.json——任务书红线）：
 * - settings 键 `zcode_managed_model`（zcodeManagedModelSetting；值 = 完整
 *   "provider/model" 串；缺行/空 = 停用，llm_review 双键「默认空 = 停用绝不半开」先例）；
 * - ApiHub zcode **活动档案**（readCurrent 反推 matchedProfileId；激活态不落库）——
 *   baseURL / apiKeyPlain / kind / providerId 取自档案；
 * - 档案缺失或键空 = 结构化 unconfigured（reason 零凭据），caps 保持 observed。
 *
 * 红线：apiKeyPlain 仅内存中转（解密瞬间 → spawn env 拼装瞬间），绝不入日志/
 * 审计/错误/落盘；本模块零日志、零 console、零 fs 凭据读取。
 *
 * electron-free；services 纯 Node 可加载（KeyCrypto 未注入时 = plaintextKeyCrypto
 * 降级默认，与 keyStore 契约一致）。
 */

import { getSetting } from '../../settingsService.ts'
import { getKeyCrypto } from '../../apihub/keyStore.ts'
import { readCurrent, resolveHomeDir } from '../../apihub/adapters.ts'
import { decryptProfileKey, getProfile, listProfileViews } from '../../apihub/profileStore.ts'

/** settings 键名（主控定案 #1）。 */
export const ZCODE_MANAGED_MODEL_SETTING_KEY = 'zcode_managed_model'

/**
 * 活动档案快照（ready=true 才允许 spawn；apiKeyPlain 仅内存字段，调用方
 * 用毕即弃——绝不持久化、绝不 toString 进任何日志/审计/错误文案）。
 */
export interface ZcodeManagedConfigSnapshot {
  ready: boolean
  /** 结构化 unconfigured 原因（零凭据、零 baseUrl 全值——静态字面量 + 字段名）。 */
  reason?: string
  /** settings 键值（完整 "provider/model" 串；非凭据，可入 evidence）。 */
  model?: string
  /** ApiHub zcode 活动档案 baseURL。 */
  baseUrl?: string
  /** 档案 kind（zcode 适配器 fieldDefs 实测取值 'anthropic'；仅就绪判定用，Z1 证据无对应 env 键——不注入）。 */
  kind?: string
  /** 档案 providerId（派生 <PROVIDER>_API_KEY env 键名用）。 */
  providerId?: string
  /** 档案 key 明文（仅内存中转；绝不入日志/审计/错误/落盘）。 */
  apiKeyPlain?: string
  /** 派生的 provider 专属 env 键名（如 'BIGMODEL_API_KEY'；Z1 证据 +`<PROVIDER>_API_KEY`）。 */
  envProviderKeyName?: string
}

/** settings 模型键读取（trim 后空串 = 停用；缺行 = 空串）。 */
export function zcodeManagedModelSetting(): string {
  return (getSetting(ZCODE_MANAGED_MODEL_SETTING_KEY) ?? '').trim()
}

/**
 * providerId → env 键名（纯函数）：非字母数字折叠为下划线、大写、补 `_API_KEY`。
 * 'bigmodel' → 'BIGMODEL_API_KEY'；'open-router' → 'OPEN_ROUTER_API_KEY'；
 * 数字开头（罕见）前置下划线保证合法 env 名；空/畸形 providerId → null（不注入该键）。
 */
export function providerIdToEnvKeyName(providerId: string): string | null {
  const trimmed = providerId.trim()
  if (trimmed.length === 0) return null
  let name = trimmed.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()
  if (/^[0-9]/.test(name)) name = `_${name}`
  return `${name}_API_KEY`
}

/**
 * 读 zcode 托管面配置快照（每字段的不可用都结构化返回，绝不抛、绝不半就绪）：
 * 1. settings 键空 → unconfigured（停用语义）；
 * 2. ApiHub zcode 活动档案不存在（readCurrent matchedProfileId=null）→ unconfigured；
 * 3. 档案密钥不可解（needs_rekey 未解/损坏）→ unconfigured；
 * 4. 档案 baseURL 空 → unconfigured；
 * 全部就绪 → ready 快照（kind 就绪判定不含强制——档案字段校验已由 ApiHub saveProfile
 * 的 validateHubFields 保证非空，缺省 kind 按 zcode 适配器缺省 'anthropic' 容忍）。
 */
export async function readZcodeManagedConfig(deps?: { homeDir?: string }): Promise<ZcodeManagedConfigSnapshot> {
  const model = zcodeManagedModelSetting()
  if (model.length === 0) {
    return { ready: false, reason: `settings key ${ZCODE_MANAGED_MODEL_SETTING_KEY} is empty (managed face disabled by default)` }
  }
  // home 解析归位 ApiHub 既有边界（adapters.resolveHomeDir：explicit → APIHUB_HOME →
  // homedir，与 apihubService depsOf 同源）；deps.homeDir 注入缝保留（smoke 夹具覆盖）。
  const home = resolveHomeDir(deps?.homeDir)
  const crypto = getKeyCrypto()
  let profiles: Awaited<ReturnType<typeof listProfileViews>>
  try {
    profiles = await listProfileViews('zcode', crypto)
  } catch {
    return { ready: false, reason: 'ApiHub zcode profiles unreadable (db error)' }
  }
  let activeId: number | null
  try {
    activeId = readCurrent('zcode', home, profiles).matchedProfileId
  } catch {
    return { ready: false, reason: 'ApiHub zcode readCurrent failed' }
  }
  if (activeId === null) {
    return { ready: false, reason: 'no active ApiHub zcode profile (readCurrent matched none)' }
  }
  let profile: Awaited<ReturnType<typeof getProfile>>
  try {
    profile = await getProfile('zcode', activeId)
  } catch {
    return { ready: false, reason: 'active ApiHub zcode profile unreadable' }
  }
  let apiKeyPlain: string | null
  try {
    apiKeyPlain = await decryptProfileKey(profile, crypto)
  } catch {
    apiKeyPlain = null
  }
  if (apiKeyPlain === null || apiKeyPlain.length === 0) {
    return { ready: false, reason: 'active ApiHub zcode profile key unavailable (decrypt failed)' }
  }
  const baseUrl = (profile.fields['baseURL'] ?? '').trim()
  if (baseUrl.length === 0) {
    return { ready: false, reason: 'active ApiHub zcode profile baseURL is empty' }
  }
  const providerId = (profile.fields['providerId'] ?? '').trim()
  const envProviderKeyName = providerIdToEnvKeyName(providerId)
  const kind = (profile.fields['kind'] ?? 'anthropic').trim()
  return {
    ready: true,
    model,
    baseUrl,
    kind: kind.length > 0 ? kind : 'anthropic',
    ...(providerId.length > 0 ? { providerId } : {}),
    apiKeyPlain,
    ...(envProviderKeyName !== null ? { envProviderKeyName } : {}),
  }
}

/**
 * spawn env 拼装（纯函数，主控定案 #1；Z1 活体 run3 形态）：
 * - `ZCODE_MODEL` = settings 键值（完整 "provider/model" 串）；
 * - `ZCODE_BASE_URL` = 活动档案 baseURL；
 * - `ZCODE_API_KEY` = 活动档案 apiKeyPlain（仅内存中转）；
 * - `<PROVIDER>_API_KEY` = 同值（Z1 证据的 provider 专属键；键名派生自档案 providerId）。
 * kind 不注入（Z1 证据无对应 env 键，绝不猜）。快照未就绪 → 原样返回副本（防御：
 * 调用方必须在 ready 前置判定之后才调用）。
 * 值域只进返回的 env 对象（spawn 瞬间消费）；本函数零日志零持久化。
 */
export function buildManagedSpawnEnv(
  snapshot: ZcodeManagedConfigSnapshot,
  baseEnv: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv }
  if (!snapshot.ready) return env
  env['ZCODE_MODEL'] = snapshot.model ?? ''
  env['ZCODE_BASE_URL'] = snapshot.baseUrl ?? ''
  env['ZCODE_API_KEY'] = snapshot.apiKeyPlain ?? ''
  if (snapshot.envProviderKeyName !== undefined && snapshot.envProviderKeyName.length > 0) {
    env[snapshot.envProviderKeyName] = snapshot.apiKeyPlain ?? ''
  }
  return env
}
