/**
 * adapters.ts — ApiHub 适配器目录与 glue（老 apihub/index.ts 移植，docs/09 §6.4）。
 *
 * - 7 个适配器 id 枚举完整：5 个可用（claude-cli / codex / grok / kimi / zcode）
 *   + 2 个 N/A（claude-desktop / deepseek，available:false 保留枚举完整性）；
 * - 各适配器的目标文件清单 / 读 / 写 glue / 重读校验照老实现；
 * - homeDir 可注入（APIHUB_HOME 环境变量或 service deps 参数），smoke 全部走夹具目录，
 *   真实 ~/.claude、~/.codex 等在测试路径下零改动；
 * - 红线：readCurrent 只回掩码（尾 4 位 + 长度），绝无 key 全值。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ApiHubAdapterEntry, ApiHubAdapterId, ApiHubAdapterInfo, ApiHubCurrentResult } from '../../../shared/types.ts'
import {
  backupStamp,
  parseKimiConfigDisplay,
  thinkingEnabledOf,
} from './tomlEdit.ts'
import type { KimiApplyFields } from './transforms.ts'
import {
  claudeApplyEnv,
  claudeParseEnv,
  claudeVerify,
  codexApplyAuth,
  codexApplyConfig,
  codexParseAuth,
  codexParseConfig,
  codexVerify,
  grokApply,
  grokParse,
  grokVerify,
  kimiApplyConfig,
  kimiVerify,
  zcodeApplyConfig,
  zcodeApplySetting,
  zcodeDeriveSelectedForm,
  zcodeParse,
  zcodeVerify,
} from './transforms.ts'

// ---------------------------------------------------------------------------
// home 目录解析（写入目标根；支持 APIHUB_HOME 覆盖与显式注入，smoke 夹具隔离用）
// ---------------------------------------------------------------------------

export function resolveHomeDir(explicit?: string): string {
  if (explicit !== undefined && explicit.trim().length > 0) return explicit
  const env = process.env.APIHUB_HOME
  if (env !== undefined && env.trim().length > 0) return env
  return os.homedir()
}

// ---------------------------------------------------------------------------
// zcode 托管 CLI spawn env 拼装（T2d 批自 zcodeManagedConfig.buildManagedSpawnEnv
// 归位：解密 key → env 键的汇流点落在本适配器 glue 文件内，与 resolveHomeDir
// 同款既有边界；消除跨文件污点误报，语义逐字节不变）
// ---------------------------------------------------------------------------

/**
 * zcode CLI spawn env 拼装（纯函数，T2 批 buildManagedSpawnEnv 的本体迁移）：
 * - `ZCODE_MODEL` = model（settings 键值，完整 "provider/model" 串）；
 * - `ZCODE_BASE_URL` = baseUrl（活动档案 baseURL）；
 * - `ZCODE_API_KEY` = apiKeyPlain（档案 key 明文，仅内存中转）；
 * - `providerEnvKeyName` 非空 → 该键 = apiKeyPlain（Z1 证据的 `<PROVIDER>_API_KEY`
 *   provider 专属键；键名由调用方自档案 providerId 派生）。
 * base env 其余键原样保留；值域只进返回的 env 对象（spawn 瞬间消费）；
 * 本函数零日志零持久化（令牌三零红线）。
 */
export function buildZcodeCliEnv(
  baseEnv: NodeJS.ProcessEnv,
  model: string,
  baseUrl: string,
  apiKeyPlain: string,
  providerEnvKeyName?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv }
  env['ZCODE_MODEL'] = model
  env['ZCODE_BASE_URL'] = baseUrl
  env['ZCODE_API_KEY'] = apiKeyPlain
  if (providerEnvKeyName !== undefined && providerEnvKeyName.length > 0) {
    env[providerEnvKeyName] = apiKeyPlain
  }
  return env
}

// ---------------------------------------------------------------------------
// 目标文件清单（docs/09 §6.4 表格）
// ---------------------------------------------------------------------------

export function adapterPaths(adapterId: ApiHubAdapterId, homeDir: string): string[] {
  switch (adapterId) {
    case 'claude-cli':
      return [path.join(homeDir, '.claude', 'settings.json')]
    case 'codex':
      return [path.join(homeDir, '.codex', 'auth.json'), path.join(homeDir, '.codex', 'config.toml')]
    case 'grok':
      return [path.join(homeDir, '.grok', 'config.toml')]
    case 'kimi':
      return [path.join(homeDir, '.kimi-code', 'config.toml')]
    case 'zcode':
      return [path.join(homeDir, '.zcode', 'v2', 'config.json'), path.join(homeDir, '.zcode', 'v2', 'setting.json')]
    default:
      return []
  }
}

/** 切换预检的进程名（docs/09 §6.3：zcode 运行中切换可能被其覆盖）。 */
const ADAPTER_PROCESS_NAMES: Partial<Record<ApiHubAdapterId, string[]>> = {
  zcode: ['ZCode.exe'],
}

// ---------------------------------------------------------------------------
// 目录（CATALOG，老 API_HUB_CATALOG 原样移植）
// ---------------------------------------------------------------------------

const CC_SWITCH_NOTE = '与 CC Switch 管理同一配置，两边切换会互相覆盖，建议统一入口'

export const API_HUB_CATALOG: ApiHubAdapterInfo[] = [
  {
    id: 'claude-cli',
    label: 'Claude Code CLI',
    available: true,
    notes: ['写入 ~/.claude/settings.json 的 env 两键，其余内容零改动', '对新会话生效', CC_SWITCH_NOTE],
    needsKey: true,
    fieldDefs: [{ key: 'baseUrl', label: 'Base URL', placeholder: 'https://api.example.com' }],
  },
  {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    available: false,
    naReason: '写入目标未能定位（CC Switch 经其本地网关实现），为避免写错文件暂不支持',
    notes: [CC_SWITCH_NOTE],
    needsKey: false,
    fieldDefs: [],
  },
  {
    id: 'codex',
    label: 'Codex',
    available: true,
    notes: ['双文件写入：auth.json 的 OPENAI_API_KEY + config.toml 的 model_provider 与 provider 块', '对新会话生效', CC_SWITCH_NOTE],
    needsKey: true,
    fieldDefs: [
      { key: 'providerId', label: 'Provider ID', placeholder: '小写字母/数字/连字符' },
      { key: 'baseUrl', label: 'Base URL', placeholder: 'https://api.example.com/v1' },
      { key: 'wireApi', label: 'Wire API', kind: 'select', options: ['responses', 'chat'] },
    ],
  },
  {
    id: 'grok',
    label: 'Grok Build CLI',
    available: true,
    notes: ['写入 ~/.grok/config.toml 的 [models] default 与 [model."…"] 块，其余段零改动', '对新会话生效', CC_SWITCH_NOTE],
    needsKey: true,
    fieldDefs: [
      { key: 'modelId', label: '模型 ID', placeholder: '如 grok-4.6' },
      { key: 'baseUrl', label: 'Base URL', placeholder: 'https://api.example.com/v1' },
      { key: 'name', label: '显示名', placeholder: '可选' },
      { key: 'apiBackend', label: 'API Backend', kind: 'select', options: ['responses', 'chat'] },
      { key: 'contextWindow', label: '上下文窗口', placeholder: '如 500000' },
    ],
  },
  {
    id: 'kimi',
    label: 'Kimi Code CLI',
    available: true,
    notes: [
      '写入 ~/.kimi-code/config.toml 的 providers / models / default_model / thinking 块，其余段零改动',
      '对新会话生效',
      CC_SWITCH_NOTE,
    ],
    needsKey: true,
    fieldDefs: [
      { key: 'providerId', label: 'Provider ID', placeholder: '小写字母/数字/连字符，写入 [providers.xxx]' },
      { key: 'modelId', label: '模型 ID', placeholder: '如 kimi-k3' },
      { key: 'baseUrl', label: 'Base URL', placeholder: 'https://…/v1' },
      { key: 'type', label: 'Type', kind: 'select', options: ['openai', 'anthropic'] },
      { key: 'modelDisplay', label: '显示名', placeholder: '可选，默认同模型 ID' },
      { key: 'maxContext', label: '上下文窗口', placeholder: '如 131072' },
      { key: 'capabilities', label: 'Capabilities', placeholder: '逗号分隔，如 thinking, tool_use' },
      { key: 'thinkingEnabled', label: 'Thinking', kind: 'select', options: ['true', 'false'] },
    ],
  },
  {
    id: 'zcode',
    label: 'ZCode',
    available: true,
    notes: [
      '双文件写入：v2/config.json 的 provider 条目 + v2/setting.json 的当前选中键',
      'ZCode 运行中切换可能被其覆盖，建议退出后切换、重启 ZCode 生效',
      CC_SWITCH_NOTE,
    ],
    needsKey: true,
    fieldDefs: [
      { key: 'providerId', label: 'Provider ID', placeholder: '小写字母/数字/连字符' },
      { key: 'providerName', label: '供应商名称', placeholder: '显示用名称' },
      { key: 'baseURL', label: 'Base URL', placeholder: 'https://…/api/anthropic' },
      { key: 'kind', label: 'Kind', kind: 'select', options: ['anthropic'] },
      { key: 'selectedKeyForm', label: '选中键形态（留空自动派生）', advanced: true, placeholder: 'coding-plan:builtin:<id>' },
    ],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek Harness',
    available: false,
    naReason: 'Chrome PWA 应用，账户认证在云端，无本地 API 配置可切换',
    notes: [],
    needsKey: false,
    fieldDefs: [],
  },
]

export function findAdapter(id: ApiHubAdapterId): ApiHubAdapterInfo {
  const info = API_HUB_CATALOG.find((a) => a.id === id)
  if (info === undefined) throw new Error('未知适配器: ' + id)
  return info
}

/** 运行时适配器 id 白名单判定（IPC 层校验用，provider 枚举白名单）。 */
export function isAdapterId(v: unknown): v is ApiHubAdapterId {
  return typeof v === 'string' && API_HUB_CATALOG.some((a) => a.id === v)
}

/** apihub:adapters 行：catalog + 当前 home 的目标文件 + 预检进程。 */
export function adapterEntries(homeDir: string): ApiHubAdapterEntry[] {
  return API_HUB_CATALOG.map((info) => ({
    ...info,
    targetPaths: adapterPaths(info.id, homeDir),
    processNames: ADAPTER_PROCESS_NAMES[info.id] ?? [],
  }))
}

// ---------------------------------------------------------------------------
// 字段校验（老 validateHubFields 原样移植）
// ---------------------------------------------------------------------------

function isProviderId(s: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(s)
}

export function validateHubFields(adapterId: ApiHubAdapterId, fields: Record<string, string>): string | null {
  const nonEmpty = (k: string): boolean => Boolean((fields[k] ?? '').trim())
  switch (adapterId) {
    case 'claude-cli':
      if (!nonEmpty('baseUrl')) return 'Base URL 不能为空'
      if (!fields.baseUrl.trim().startsWith('http://') && !fields.baseUrl.trim().startsWith('https://'))
        return 'Base URL 必须以 http(s):// 开头'
      break
    case 'codex':
      if (!isProviderId(fields.providerId ?? '')) return 'Provider ID 只允许小写字母/数字/连字符'
      if (!nonEmpty('baseUrl')) return 'Base URL 不能为空'
      if (fields.wireApi !== 'responses' && fields.wireApi !== 'chat') return 'wireApi 只能是 responses 或 chat'
      break
    case 'grok': {
      if (!nonEmpty('modelId')) return '模型 ID 不能为空'
      if (!nonEmpty('baseUrl')) return 'Base URL 不能为空'
      if (!/^\d+$/.test((fields.contextWindow ?? '').trim())) return '上下文窗口必须是正整数'
      if (fields.apiBackend !== 'responses' && fields.apiBackend !== 'chat') return 'apiBackend 只能是 responses 或 chat'
      break
    }
    case 'kimi': {
      if (!isProviderId(fields.providerId ?? '')) return 'Provider ID 只允许小写字母/数字/连字符'
      if (!nonEmpty('modelId')) return '模型 ID 不能为空'
      if (!nonEmpty('baseUrl')) return 'Base URL 不能为空'
      if (!fields.baseUrl.trim().startsWith('http://') && !fields.baseUrl.trim().startsWith('https://'))
        return 'Base URL 必须以 http(s):// 开头'
      const t = (fields.type ?? '').trim()
      if (t.length > 0 && t !== 'openai' && t !== 'anthropic') return 'type 只能是 openai 或 anthropic'
      const mc = (fields.maxContext ?? '').trim()
      if (mc.length > 0 && !/^\d+$/.test(mc)) return '上下文窗口必须是正整数'
      const th = (fields.thinkingEnabled ?? '').trim()
      if (th.length > 0 && th !== 'true' && th !== 'false') return 'Thinking 只能是 true 或 false'
      break
    }
    case 'zcode':
      if (!isProviderId(fields.providerId ?? '')) return 'Provider ID 只允许小写字母/数字/连字符'
      if (!nonEmpty('providerName')) return '供应商名称不能为空'
      if (!nonEmpty('baseURL')) return 'Base URL 不能为空'
      break
    default:
      break
  }
  return null
}

// ---------------------------------------------------------------------------
// 适配器 glue：组装写入（ PreparedWrite = 目标文件 + 完整新文本 ）
// ---------------------------------------------------------------------------

export interface PreparedWrite {
  path: string
  next: string
}

function readTextIfExists(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

export function fileExists(file: string): boolean {
  try {
    return fs.existsSync(file)
  } catch {
    return false
  }
}

/** apihub fields Record → kimi 规范字段（缺省值：type=openai、maxContext=131072、display 同模型 ID、thinking=true）。 */
export function kimiFieldsOf(fields: Record<string, string>): KimiApplyFields {
  const modelId = (fields.modelId ?? '').trim()
  const maxContext = Number((fields.maxContext ?? '').trim())
  return {
    providerId: (fields.providerId ?? '').trim(),
    modelId,
    baseUrl: (fields.baseUrl ?? '').trim(),
    type: (fields.type ?? '').trim().length > 0 ? (fields.type ?? '').trim() : 'openai',
    modelDisplay: (fields.modelDisplay ?? '').trim().length > 0 ? (fields.modelDisplay ?? '').trim() : modelId,
    maxContext: Number.isFinite(maxContext) && maxContext > 0 ? Math.trunc(maxContext) : 131072,
    capabilities: (fields.capabilities ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    thinkingEnabled: (fields.thinkingEnabled ?? '').trim() !== 'false',
  }
}

/** 按适配器组装全部目标文件的新文本（不含写盘动作）。 */
export function prepareWrites(
  adapterId: ApiHubAdapterId,
  homeDir: string,
  fields: Record<string, string>,
  apiKeyPlain: string,
): PreparedWrite[] {
  const paths = adapterPaths(adapterId, homeDir)
  switch (adapterId) {
    case 'claude-cli':
      return [{ path: paths[0], next: claudeApplyEnv(readTextIfExists(paths[0]), fields.baseUrl.trim(), apiKeyPlain) }]
    case 'codex':
      return [
        { path: paths[0], next: codexApplyAuth(readTextIfExists(paths[0]), apiKeyPlain) },
        {
          path: paths[1],
          next: codexApplyConfig(readTextIfExists(paths[1]), fields.providerId.trim(), fields.baseUrl.trim(), fields.wireApi.trim()),
        },
      ]
    case 'grok':
      return [
        {
          path: paths[0],
          next: grokApply(
            readTextIfExists(paths[0]),
            {
              modelId: fields.modelId.trim(),
              baseUrl: fields.baseUrl.trim(),
              name: (fields.name ?? '').trim().length > 0 ? (fields.name ?? '').trim() : fields.modelId.trim(),
              apiBackend: fields.apiBackend === 'chat' ? 'chat' : 'responses',
              contextWindow: Number((fields.contextWindow ?? '0').trim()),
            },
            apiKeyPlain,
          ),
        },
      ]
    case 'kimi':
      return [{ path: paths[0], next: kimiApplyConfig(readTextIfExists(paths[0]), kimiFieldsOf(fields), apiKeyPlain) }]
    case 'zcode': {
      const knownForms = zcodeParse(readTextIfExists(paths[0]), readTextIfExists(paths[1])).knownForms
      const selectedValue = (fields.selectedKeyForm ?? '').trim().length > 0 ? (fields.selectedKeyForm ?? '').trim() : zcodeDeriveSelectedForm(knownForms, fields.providerId.trim())
      return [
        {
          path: paths[0],
          next: zcodeApplyConfig(
            readTextIfExists(paths[0]),
            {
              providerId: fields.providerId.trim(),
              providerName: fields.providerName.trim(),
              baseURL: fields.baseURL.trim(),
              kind: (fields.kind ?? 'anthropic').trim(),
            },
            apiKeyPlain,
          ),
        },
        { path: paths[1], next: zcodeApplySetting(readTextIfExists(paths[1]), selectedValue) },
      ]
    }
    default:
      return []
  }
}

/** 重读校验：按适配器调 transforms 的 verify 系列（任一不一致抛错，调用方回滚）。 */
export function verifyWrites(
  adapterId: ApiHubAdapterId,
  homeDir: string,
  fields: Record<string, string>,
  apiKeyPlain: string,
): void {
  const paths = adapterPaths(adapterId, homeDir)
  if (adapterId === 'claude-cli') {
    claudeVerify(readTextIfExists(paths[0]), fields.baseUrl.trim(), apiKeyPlain)
    return
  }
  if (adapterId === 'codex') {
    codexVerify(readTextIfExists(paths[0]), readTextIfExists(paths[1]), fields.providerId.trim(), fields.baseUrl.trim(), apiKeyPlain)
    return
  }
  if (adapterId === 'grok') {
    grokVerify(readTextIfExists(paths[0]), { modelId: fields.modelId.trim(), baseUrl: fields.baseUrl.trim() }, apiKeyPlain)
    return
  }
  if (adapterId === 'kimi') {
    kimiVerify(readTextIfExists(paths[0]), kimiFieldsOf(fields), apiKeyPlain)
    return
  }
  if (adapterId === 'zcode') {
    const configText = readTextIfExists(paths[0])
    const settingText = readTextIfExists(paths[1])
    const known = zcodeParse(configText, settingText).knownForms
    const selectedValue = (fields.selectedKeyForm ?? '').trim().length > 0 ? (fields.selectedKeyForm ?? '').trim() : zcodeDeriveSelectedForm(known, fields.providerId.trim())
    zcodeVerify(configText, settingText, fields.providerId.trim(), fields.baseURL.trim(), selectedValue, apiKeyPlain)
  }
}

// ---------------------------------------------------------------------------
// 当前状态读取（脱敏）
// ---------------------------------------------------------------------------

/** 顶层/节内 TOML 字符串值提取（读取 api_key 等全值专用；结果只进内存瞬间路径） */
export function tomlStringValue(text: string, sectionInner: string | null, key: string): string | null {
  let header: string | null = null
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim()
    if (!t) continue
    if (t.startsWith('[') && t.endsWith(']')) {
      header = t.slice(1, -1).trim()
      continue
    }
    const eq = t.indexOf('=')
    if (eq <= 0) continue
    const k = t.slice(0, eq).trim()
    if (k !== key) continue
    if (header !== sectionInner) continue
    const v = t.slice(eq + 1).trim()
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1)
    return null
  }
  return null
}

/** JSON 对象里按点路径取字符串值（如 env.ANTHROPIC_AUTH_TOKEN）；缺失返回 null */
export function jsonStringByPath(text: string, segments: string[]): string | null {
  let obj: Record<string, unknown>
  try {
    const v: unknown = JSON.parse(text)
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
    obj = v as Record<string, unknown>
  } catch {
    return null
  }
  let cur: unknown = obj
  for (const seg of segments) {
    if (typeof cur !== 'object' || cur === null || Array.isArray(cur)) return null
    cur = (cur as Record<string, unknown>)[seg]
  }
  return typeof cur === 'string' ? cur : null
}

export function hostLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}

/** kimi 档案的复合模型键 "<providerId>/<modelId>"（与 config.toml 的 default_model 同形）。 */
export function kimiCompositeKey(fields: Record<string, string>): string {
  return (fields.providerId ?? '').trim() + '/' + (fields.modelId ?? '').trim()
}

/**
 * 从 selectedKey 形态反向解析 providerId。providerId 本身可含冒号（真机如 builtin:bigmodel-coding-plan），
 * 故优先按『已知 providerId 结尾』匹配（selected === id 或以 ':' + id 结尾），退而求其次取最后一个 ':' 之后段。
 */
export function selectedProviderId(selected: string | null, providerIds: string[]): string | null {
  if (selected === null) return null
  const hit = providerIds.find((id) => selected === id || selected.endsWith(':' + id))
  if (hit !== undefined) return hit
  const idx = selected.lastIndexOf(':')
  return idx >= 0 ? selected.slice(idx + 1) : selected
}

/**
 * readCurrent：读目标文件当前内容 → 脱敏视图 + 按内容反推命中档案 id（激活态不落库）。
 * 命中判定与档案 fields 的对应键比较（baseUrl / providerId / modelId / providerId）。
 */
export function readCurrent(
  adapterId: ApiHubAdapterId,
  homeDir: string,
  profiles: { id: number; fields: Record<string, string> }[],
): ApiHubCurrentResult {
  const info = findAdapter(adapterId)
  const paths = adapterPaths(adapterId, homeDir)
  const notAvailable = (): ApiHubCurrentResult => ({
    adapterId,
    available: false,
    ...(info.naReason !== undefined ? { naReason: info.naReason } : {}),
    configPaths: [],
    baseUrl: null,
    apiKeyTail: null,
    apiKeyLen: null,
    detail: {},
    matchedProfileId: null,
  })
  if (!info.available) return notAvailable()

  const base: ApiHubCurrentResult = {
    adapterId,
    available: true,
    configPaths: paths,
    baseUrl: null,
    apiKeyTail: null,
    apiKeyLen: null,
    detail: {},
    matchedProfileId: null,
  }
  if (adapterId === 'claude-cli') {
    const d = claudeParseEnv(readTextIfExists(paths[0]))
    base.baseUrl = d.baseUrl
    base.apiKeyTail = d.keyTail
    base.apiKeyLen = d.keyLen
    base.matchedProfileId = (profiles.find((p) => p.fields.baseUrl === d.baseUrl) ?? { id: null }).id ?? null
    return base
  }
  if (adapterId === 'codex') {
    const auth = codexParseAuth(readTextIfExists(paths[0]))
    const cfg = codexParseConfig(readTextIfExists(paths[1]))
    base.baseUrl = cfg.baseUrl
    base.apiKeyTail = auth.keyTail
    base.apiKeyLen = auth.keyLen
    base.detail.modelProvider = cfg.modelProvider ?? '（未设置）'
    base.detail.wireApi = cfg.wireApi ?? '（未设置）'
    base.matchedProfileId =
      (profiles.find((p) => p.fields.providerId === cfg.modelProvider && p.fields.baseUrl === cfg.baseUrl) ?? { id: null }).id ?? null
    return base
  }
  if (adapterId === 'grok') {
    const d = grokParse(readTextIfExists(paths[0]))
    base.baseUrl = d.baseUrl
    base.apiKeyTail = d.keyTail
    base.apiKeyLen = d.keyLen
    base.detail.defaultModel = d.defaultModel ?? '（未设置）'
    base.detail.apiBackend = d.apiBackend ?? '（未设置）'
    base.detail.contextWindow = d.contextWindow === null ? '（未设置）' : String(d.contextWindow)
    base.matchedProfileId = (profiles.find((p) => p.fields.modelId === d.defaultModel) ?? { id: null }).id ?? null
    return base
  }
  if (adapterId === 'kimi') {
    const text = readTextIfExists(paths[0])
    const d = parseKimiConfigDisplay(text)
    const model = d.models.find((m) => m.id === d.defaultModel)
    const prov = d.providers.find((p) => p.id === model?.provider)
    base.baseUrl = prov?.baseUrl ?? null
    base.apiKeyTail = prov?.apiKeyTail ?? null
    base.apiKeyLen = prov?.apiKeyLen ?? null
    base.detail.defaultModel = d.defaultModel ?? '（未设置）'
    base.detail.thinking = thinkingEnabledOf(text) ? 'true' : 'false'
    if (model !== undefined) {
      base.detail.modelDisplay = model.displayName ?? model.model ?? '（未设置）'
      base.detail.maxContext = model.maxContext === undefined ? '（未设置）' : String(model.maxContext)
      if (model.capabilities !== undefined && model.capabilities.length > 0) base.detail.capabilities = model.capabilities.join(', ')
    }
    base.matchedProfileId =
      (profiles.find((p) => kimiCompositeKey(p.fields) === d.defaultModel) ?? { id: null }).id ?? null
    return base
  }
  // zcode
  const d = zcodeParse(readTextIfExists(paths[0]), readTextIfExists(paths[1]))
  const selectedId = selectedProviderId(d.selected, d.providers.map((p) => p.id))
  const current = d.providers.find((p) => p.id === selectedId)
  base.baseUrl = current?.baseURL ?? null
  base.apiKeyTail = current?.keyTail ?? null
  base.apiKeyLen = current?.keyLen ?? null
  base.detail.selected = d.selected ?? '（未设置）'
  base.detail.providers = String(d.providers.length) + ' 条（' + d.providers.map((p) => p.id + (p.enabled ? '✓' : '✗')).join(', ') + '）'
  base.matchedProfileId = (profiles.find((p) => p.fields.providerId === selectedId) ?? { id: null }).id ?? null
  return base
}

/** 备份文件名后缀（.bak_<stamp>，与老实现惯例一致）。 */
export function backupSuffix(d: Date): string {
  return '.bak_' + backupStamp(d)
}
