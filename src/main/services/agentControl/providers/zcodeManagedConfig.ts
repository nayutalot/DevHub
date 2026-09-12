/**
 * zcodeManagedConfig.ts — zcode 托管面配置源（T2 批 docs/briefs/t2-zcode-managed.md；
 * T2e 批 docs/briefs/t2e-config-inject.md 改版：env 注入 → CLI 配置文件注入）。
 *
 * 事实链（Z1 侦察 REPORT Q2 + T2e schema 侦察，静态/活体双证）：
 * - 独立 zcode CLI 必须自行提供模型 provider 配置（缺失 → 配置加载期即报
 *   model_config_missing）；桌面登录（~/.zcode/v2/credentials.json）不自动供 CLI 使用；
 * - **CLI 官方推荐机制 = `~/.zcode/cli/config.json`**（无头失败 stderr 自述
 *   「Create ~/.zcode/cli/config.json with an explicit model provider」）；bundle 静态
 *   证实顶层 zod `.passthrough()`（额外键容忍，合并保留用户字段安全）：
 *   `provider?: record(id, {kind?: 'anthropic'|'openai'|'openai-compatible', name?,
 *   options?: {apiKey?, baseURL?, apiKeyRequired?, …}, models?: record(modelId, …)})`
 *   + `model?: "provider/model" | {main?, lite?}`；官方 coding-plan 写入器
 *   （patchCodingPlanProvider/atomicWriteJson）即此形态（tmp+rename+0600 原子写）；
 * - 活体验证（T2e probe，假 home + USERPROFILE 重定向，零推理零网络）：无 config →
 *   model_config_missing（负对照）；按上述 schema 写入 dummy provider →
 *   app-server session/create 成功（正照，baseURL 为 .invalid 域零出网）。
 *
 * 本批改版（设计级消除污点链）：托管密钥不再进 spawn env（T2d 的
 * buildManagedSpawnEnv/buildZcodeCliEnv/<PROVIDER>_API_KEY 注入面全部退役），
 * 改为 spawn 前 ensureZcodeCliConfig 原子 upsert `~/.zcode/cli/config.json`；
 * spawn env 回归 process.env 透传（零密钥）。
 *
 * 配置来源（绝不读 ~/.zcode/v2/credentials.json——任务书红线）：
 * - settings 键 `zcode_managed_model`（值 = 完整 "provider/model" 串；缺行/空 =
 *   停用，llm_review 双键「默认空 = 停用绝不半开」先例）；
 * - ApiHub zcode **活动档案**（readCurrent 反推 matchedProfileId）——baseURL /
 *   apiKeyPlain / kind / providerId 取自档案；
 * - 档案缺失或键空 = 结构化 unconfigured（reason 零凭据），caps 保持 observed。
 *
 * 红线：apiKeyPlain 仅内存中转（解密瞬间 → cli config 原子写瞬间），绝不入日志/
 * 审计/错误文案；已存在文件**合并保留用户既有字段**（只 upsert provider.<model 前缀>
 * 条目 + model 主选），tmp+rename 原子写、幂等；写失败/读失败/损坏 JSON → 结构化
 * reason 绝不半写；本模块零日志、零 console。
 *
 * electron-free；services 纯 Node 可加载（KeyCrypto 未注入时 = plaintextKeyCrypto
 * 降级默认，与 keyStore 契约一致）。
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getSetting } from '../../settingsService.ts'
import { getKeyCrypto } from '../../apihub/keyStore.ts'
import { readCurrent, resolveHomeDir } from '../../apihub/adapters.ts'
import { decryptProfileKey, getProfile, listProfileViews } from '../../apihub/profileStore.ts'

/** settings 键名（主控定案 #1）。 */
export const ZCODE_MANAGED_MODEL_SETTING_KEY = 'zcode_managed_model'

/**
 * 活动档案快照（ready=true 才允许写 CLI 配置；apiKeyPlain 仅内存字段，调用方
 * 用毕即弃——绝不持久化到 DevHub 侧、绝不 toString 进任何日志/审计/错误文案；
 * 唯一去处 = 用户 CLI 配置文件本身，CLI 官方配置面）。
 */
export interface ZcodeManagedConfigSnapshot {
  ready: boolean
  /** 结构化 unconfigured 原因（零凭据、零 baseUrl 全值——静态字面量 + 字段名）。 */
  reason?: string
  /** settings 键值（完整 "provider/model" 串；非凭据，可入 evidence）。 */
  model?: string
  /** ApiHub zcode 活动档案 baseURL。 */
  baseUrl?: string
  /** 档案 kind（zcode 适配器 fieldDefs 取值 'anthropic'；CLI schema 枚举成员）。 */
  kind?: string
  /** 档案 providerId（与 model 串 provider 前缀做一致性守卫，防静默错配）。 */
  providerId?: string
  /** 档案 key 明文（仅内存中转；绝不入日志/审计/错误/DevHub 侧落盘）。 */
  apiKeyPlain?: string
}

/** settings 模型键读取（trim 后空串 = 停用；缺行 = 空串）。 */
export function zcodeManagedModelSetting(): string {
  return (getSetting(ZCODE_MANAGED_MODEL_SETTING_KEY) ?? '').trim()
}

/**
 * CLI 配置注入计划（纯数据；zcodeCliConfigPlanOf 产出，ensureZcodeCliConfig 消费）。
 * providerKey = model 串的 provider 前缀——CLI 的 provider 匹配键正是它
 * （enrichModelTarget 按 `provider[model 前缀]` 查条目），绝不取档案 providerId
 * （两者由一致性守卫强制相等）。
 */
export interface ZcodeCliConfigPlan {
  /** provider 条目键（= model 串前缀；CLI enrichModelTarget 匹配键）。 */
  providerKey: string
  /** model 串 model 段（第一个 '/' 之后）。 */
  modelId: string
  /** 档案 kind（缺省 'anthropic'，CLI schema 枚举成员）。 */
  kind: string
  /** 档案 baseURL（写 provider.<key>.options.baseURL）。 */
  baseURL: string
  /** 档案 key 明文（仅内存中转；唯一去处 = CLI 配置文件本身）。 */
  apiKeyPlain: string
  /** 完整 "provider/model" 串（写 model 主选）。 */
  modelRef: string
}

/** zcodeCliConfigPlanOf 结果（结构化拒绝面：reason 零凭据）。 */
export type ZcodeCliConfigPlanResult =
  | { ok: true; plan: ZcodeCliConfigPlan }
  | { ok: false; reason: string }

/**
 * 快照 → CLI 配置注入计划（纯函数，结构化拒绝，绝不抛）：
 * - model 串必须 provider 限定（含非首非尾 '/'，与 CLI isProviderQualifiedModelRef
 *   同判——bundle k_r：`idx>0 && idx<len-1`）；
 * - model 串 provider 前缀 ≠ 档案 providerId（非空时）→ 拒绝（防静默错配：CLI 按
 *   前缀查 provider 条目，错配 = 条目不被消费 = 请求发往默认端点）；
 * - baseURL/key 空（ready 快照本不该出现，防御性兜底）→ 拒绝。
 */
export function zcodeCliConfigPlanOf(snapshot: ZcodeManagedConfigSnapshot): ZcodeCliConfigPlanResult {
  const model = (snapshot.model ?? '').trim()
  const slash = model.indexOf('/')
  if (!(slash > 0 && slash < model.length - 1)) {
    return { ok: false, reason: `settings key ${ZCODE_MANAGED_MODEL_SETTING_KEY} is not a provider-qualified "provider/model" ref (cli config not written)` }
  }
  const providerKey = model.slice(0, slash)
  const modelId = model.slice(slash + 1)
  const providerId = (snapshot.providerId ?? '').trim()
  if (providerId.length > 0 && providerId !== providerKey) {
    return {
      ok: false,
      reason: `settings model provider prefix "${providerKey}" does not match active profile providerId "${providerId}" (cli config not written)`,
    }
  }
  const baseURL = (snapshot.baseUrl ?? '').trim()
  if (baseURL.length === 0) {
    return { ok: false, reason: 'active ApiHub zcode profile baseURL is empty (cli config not written)' }
  }
  const apiKeyPlain = snapshot.apiKeyPlain ?? ''
  if (apiKeyPlain.length === 0) {
    return { ok: false, reason: 'active ApiHub zcode profile key is empty (cli config not written)' }
  }
  const kind = (snapshot.kind ?? 'anthropic').trim()
  return {
    ok: true,
    plan: {
      providerKey,
      modelId,
      kind: kind.length > 0 ? kind : 'anthropic',
      baseURL,
      apiKeyPlain,
      modelRef: model,
    },
  }
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
  const kind = (profile.fields['kind'] ?? 'anthropic').trim()
  return {
    ready: true,
    model,
    baseUrl,
    kind: kind.length > 0 ? kind : 'anthropic',
    ...(providerId.length > 0 ? { providerId } : {}),
    apiKeyPlain,
  }
}

// ---------------------------------------------------------------------------
// CLI 配置注入（T2e 批核心：spawn 前原子 upsert ~/.zcode/cli/config.json）
// ---------------------------------------------------------------------------

/** ensureZcodeCliConfig 依赖注入缝（smoke 夹具隔离；缺省走真实 home + 原子文件写）。 */
export interface EnsureZcodeCliConfigDeps {
  /** home 目录（缺省 resolveHomeDir：explicit → APIHUB_HOME → homedir）。 */
  homeDir?: string
  /** CLI 配置文件全路径覆盖（最高优先；缺省 `<home>/.zcode/cli/config.json`）。 */
  configFile?: string
  /** 读现有文件（null = 不存在；抛错 = 读取失败 → 结构化拒绝不写）。 */
  readFile?: (filePath: string) => string | null
  /** 写文件（收到最终全文；缺省实现 tmp+rename 原子写，注入方可自定）。 */
  writeFile?: (filePath: string, text: string) => void
}

/** ensureZcodeCliConfig 结果（wrote=false = 内容已满足幂等跳过）。 */
export interface EnsureZcodeCliConfigResult {
  ok: boolean
  /** 目标文件路径（读/写阶段即有；零凭据，可入 evidence）。 */
  path?: string
  /** 结构化失败原因（零凭据：静态字面量 + 字段名 + fs 错误消息）。 */
  reason?: string
  /** 本次是否实际写盘（false = 幂等跳过或未到写阶段）。 */
  wrote?: boolean
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT'
}

/** 默认读：ENOENT → null（视为不存在）；其余错误抛给调用方结构化拒绝。 */
function defaultReadCliConfig(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf8')
  } catch (err) {
    if (isEnoent(err)) return null
    throw err
  }
}

/**
 * 默认写（原子）：父目录 mkdir recursive → 同目录 tmp（`.tmp-<pid>-<ts>` 后缀，
 * 与 apihubService 既有惯例同形）→ rename。任一步失败清理 tmp 后原样抛
 * （调用方折叠为结构化 reason）——绝不半写。
 */
function defaultWriteCliConfig(filePath: string, text: string): void {
  mkdirSync(dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
  try {
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, filePath)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      /* 清理失败不掩盖原错误 */
    }
    throw err
  }
}

/**
 * spawn 前置：把托管模型配置原子 upsert 进用户 CLI 配置文件（CLI 官方推荐机制）。
 *
 * 合并语义（红线：保留用户既有字段）：
 * - 顶层展开保留（passthrough schema，额外键原样保留）；
 * - `provider.<plan.providerKey>` 条目合并（用户既有 kind/options/models 键保留，
 *   仅 upsert kind / options.baseURL / options.apiKey / options.apiKeyRequired=true /
 *   models.<modelId>）；
 * - `model` 主选：既有为对象 → 只换 `main`（保留 lite 等，官方
 *   patchMainModelSelection 同语义）；既有为字符串/缺失 → 整体置 plan.modelRef
 *   （模型主选切换语义）。
 *
 * 幂等：合并结果与现有内容语义等价 → 跳过写盘（wrote=false）。
 * 失败面（全部结构化 reason、绝不半写、绝不覆盖）：未就绪快照 / 计划拒绝 /
 * 读失败（非 ENOENT）/ 损坏或非对象 JSON（拒绝覆盖用户文件）/ 写失败。
 * 零日志零审计；apiKeyPlain 唯一去处 = 目标配置文件内容本身。
 */
export async function ensureZcodeCliConfig(
  snapshot: ZcodeManagedConfigSnapshot,
  deps: EnsureZcodeCliConfigDeps = {},
): Promise<EnsureZcodeCliConfigResult> {
  if (!snapshot.ready) {
    return { ok: false, reason: snapshot.reason ?? 'zcode managed snapshot not ready (cli config not written)' }
  }
  const planned = zcodeCliConfigPlanOf(snapshot)
  if (!planned.ok) {
    return { ok: false, reason: planned.reason }
  }
  const plan = planned.plan
  const filePath =
    deps.configFile ??
    join(resolveHomeDir(deps.homeDir), '.zcode', 'cli', 'config.json')
  let existingText: string | null
  try {
    existingText = deps.readFile !== undefined ? deps.readFile(filePath) : defaultReadCliConfig(filePath)
  } catch (err) {
    return { ok: false, path: filePath, reason: `cli config read failed: ${errMessage(err)}` }
  }
  let existing: Record<string, unknown> = {}
  if (existingText !== null && existingText.trim().length > 0) {
    try {
      const parsed: unknown = JSON.parse(existingText)
      if (!isRecord(parsed)) throw new Error('top level is not a JSON object')
      existing = parsed
    } catch (err) {
      return {
        ok: false,
        path: filePath,
        reason: `cli config parse failed (existing file is not valid JSON; refusing to overwrite): ${errMessage(err)}`,
      }
    }
  }
  // 合并（只 upsert 本批键；用户既有字段全保留）
  const existingProvider = isRecord(existing['provider']) ? existing['provider'] : {}
  const existingEntryRaw = existingProvider[plan.providerKey]
  const existingEntry = isRecord(existingEntryRaw) ? existingEntryRaw : {}
  const existingOptionsRaw = existingEntry['options']
  const existingOptions = isRecord(existingOptionsRaw) ? existingOptionsRaw : {}
  const existingModelsRaw = existingEntry['models']
  const existingModels = isRecord(existingModelsRaw) ? existingModelsRaw : {}
  const existingModelEntryRaw = existingModels[plan.modelId]
  const existingModelEntry = isRecord(existingModelEntryRaw) ? existingModelEntryRaw : {}
  const entryNext: Record<string, unknown> = {
    ...existingEntry,
    kind: plan.kind,
    options: {
      ...existingOptions,
      baseURL: plan.baseURL,
      apiKey: plan.apiKeyPlain,
      apiKeyRequired: true,
    },
    models: {
      ...existingModels,
      [plan.modelId]: { ...existingModelEntry, name: plan.modelId },
    },
  }
  const existingModel = existing['model']
  const modelNext = isRecord(existingModel) ? { ...existingModel, main: plan.modelRef } : plan.modelRef
  const next: Record<string, unknown> = {
    ...existing,
    provider: { ...existingProvider, [plan.providerKey]: entryNext },
    model: modelNext,
  }
  // 幂等：语义等价（键序归一后全等）→ 跳过写盘
  if (existingText !== null && JSON.stringify(next) === JSON.stringify(existing)) {
    return { ok: true, path: filePath, wrote: false }
  }
  const nextText = `${JSON.stringify(next, null, 2)}\n`
  try {
    if (deps.writeFile !== undefined) deps.writeFile(filePath, nextText)
    else defaultWriteCliConfig(filePath, nextText)
  } catch (err) {
    return { ok: false, path: filePath, reason: `cli config write failed: ${errMessage(err)}` }
  }
  return { ok: true, path: filePath, wrote: true }
}
