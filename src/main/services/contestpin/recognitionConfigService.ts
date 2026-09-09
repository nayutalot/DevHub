/**
 * recognitionConfigService.ts — ContestPin 识别配置 CRUD / 掩码视图 / 连接测试
 * （CP3a 批次，docs/22 §6 + 任务书 §2.2）。
 *
 * - electron-free 纯 Node 模块（db 经 getDatabase() 单例，DEVHUB_HOME 驱动），
 *   smoke 可在系统 Node 下直测；SQL 全参数绑定（约束 #11）；结构化 ServiceError
 *   （约束 #14）。
 * - **密钥体系复用（不自建）**：key_sealed 直接经 getKeyCrypto()（apihub
 *   keyStore 注入位；生产 = safeStorage/DPAPI 由 keyStoreWire 启动注入，不可用
 *   即拒绝；smoke 默认 plaintextKeyCrypto 仅夹具）。envelope 形状照抄
 *   apihub/profileStore：{ v:1, sealed, fields, plainStore? }（TEXT 列存 envelope
 *   JSON 字符串；sealed = KeyCrypto.encrypt(明文 key)）。明文只在 seal/解密瞬间
 *   存在于内存，结果不落任何日志/缓存；Renderer 只见掩码（maskKey 尾 4 位+长度，
 *   全项目唯一脱敏出口）。
 * - **掩码视图红线**：listConfigs/saveConfig 返回 apiKeyTail/apiKeyLen/apiKeySet，
 *   绝不含明文或 sealed；不可解密如实回 null 掩码（apiKeySet 仍 true——key 在，
 *   只是读不出），绝不伪造可用性。
 * - **空 key 语义**（密码框约定先例 ApiHubView）：编辑时空串/undefined = 保持
 *   既有；新建时空 = 无鉴权端点，key_sealed 允许 NULL 保存。
 * - 连接测试 testConfig：解密 → probeConfig（text 发 ping；vision/multimodal 发
 *   1x1 红 PNG，见 openaiClient）→ 落 last_test_at/last_test_ok/
 *   last_test_usage_json（仅实测 usage 才写 JSON，'unknown'/失败一律 NULL）→
 *   返回测试结果与分类文案（鉴权失败/限流/超时/网络错误/格式错误/图片不支持/
 *   HTTP 状态；IMAGE_UNSUPPORTED 按服务端错误摘要含 image/multimodal 字样派生，
 *   不可判归 HTTP_ERROR/BAD_RESPONSE 原样带简短摘要）。
 * - 独立于 apihub_profiles（后者语义 = 切换写外部文件）；本模块绝不触碰
 *   apihub:switch 与 ZCode/Codex 活动配置（docs/22 §6 隔离裁决）。
 */

import { getDatabase } from '../../db/index.ts'
import { logger } from '../../core/logger.ts'
import { ServiceError, nowSec } from '../internal.ts'
import { getKeyCrypto, maskKey, type KeyCrypto } from '../apihub/keyStore.ts'
import { probeConfig, type ChatFailure } from './openaiClient.ts'
import type {
  RecognitionConfigDeletePayload,
  RecognitionConfigDeleteResult,
  RecognitionConfigDeleteStart,
  RecognitionConfigListResult,
  RecognitionConfigRole,
  RecognitionConfigSavePayload,
  RecognitionConfigView,
  RecognitionTestErrorKind,
  RecognitionTestResult,
} from '../../../shared/types.ts'

/** envelope 版本（与 profileStore 对齐；迁移/重构时按 v 识别旧形态）。 */
const ENVELOPE_VERSION = 1 as const

/** key_sealed 的 envelope（照抄 profileStore 形状：v/sealed/fields/plainStore）。 */
interface ConfigKeyEnvelope {
  v: number
  sealed: string
  fields: Record<string, string>
  plainStore?: boolean
}

const CONFIG_ROLES: readonly RecognitionConfigRole[] = ['vision', 'text', 'multimodal']

/** role 白名单判定（handlers 侧 BAD_PAYLOAD 校验用，apihub isAdapterId 先例）。 */
export function isRecognitionConfigRole(value: unknown): value is RecognitionConfigRole {
  return typeof value === 'string' && (CONFIG_ROLES as readonly string[]).includes(value)
}

// ---------------------------------------------------------------------------
// envelope 编解码 / seal-unseal（明文只在瞬间存在于内存）
// ---------------------------------------------------------------------------

function decodeKeyEnvelope(raw: unknown): ConfigKeyEnvelope | null {
  if (typeof raw !== 'string' && !(raw instanceof Uint8Array)) return null
  try {
    const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')
    const parsed = JSON.parse(text) as Partial<ConfigKeyEnvelope>
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      parsed.v !== ENVELOPE_VERSION ||
      typeof parsed.sealed !== 'string' ||
      parsed.sealed.length === 0 ||
      typeof parsed.fields !== 'object' ||
      parsed.fields === null
    ) {
      return null
    }
    return {
      v: ENVELOPE_VERSION,
      sealed: parsed.sealed,
      fields: {},
      ...(parsed.plainStore === true ? { plainStore: true as const } : {}),
    }
  } catch {
    return null
  }
}

function encodeKeyEnvelope(sealed: string, crypto: KeyCrypto): string {
  const envelope: ConfigKeyEnvelope = {
    v: ENVELOPE_VERSION,
    sealed,
    fields: {},
    ...(crypto.plainStore === true ? { plainStore: true as const } : {}),
  }
  return JSON.stringify(envelope)
}

/** seal：明文 key → KeyCrypto.encrypt → envelope JSON（TEXT 列存储形态）。 */
async function sealKey(plain: string, crypto: KeyCrypto): Promise<string> {
  return encodeKeyEnvelope(await crypto.encrypt(plain), crypto)
}

/**
 * unseal：envelope → 明文 key（仅调用瞬间存在于内存；结果绝不落日志/缓存）。
 * - plainStore envelope（plaintext 夹具形态）：base64 直解，不走 crypto.decrypt；
 * - 任何失败（非法 envelope / 解密异常）返回 null，绝不猜测、绝不伪造可用性。
 */
async function unsealKey(raw: unknown, crypto: KeyCrypto): Promise<string | null> {
  const envelope = decodeKeyEnvelope(raw)
  if (envelope === null) return null
  if (envelope.plainStore === true) {
    try {
      return Buffer.from(envelope.sealed, 'base64').toString('utf8')
    } catch {
      return null
    }
  }
  try {
    return await crypto.decrypt(envelope.sealed)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 行投影（掩码视图）
// ---------------------------------------------------------------------------

interface ConfigRow {
  id: number
  name: string
  role: string
  base_url: string
  model: string
  key_sealed: string | Uint8Array | null
  timeout_ms: number | null
  last_test_at: number | null
  last_test_ok: number | null
  last_test_usage_json: string | null
  created_at: number
  updated_at: number
}

/** 解析 last_test_usage_json（非法/非对象一律 null，脏数据不上抛）。 */
function parseStoredUsage(raw: string | null): Record<string, unknown> | null {
  if (raw === null || raw.trim().length === 0) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}

/** 行 → 掩码视图。解密只为取掩码（瞬间）；不可解 → tail/len null + apiKeySet 仍如实。 */
async function toView(row: ConfigRow, crypto: KeyCrypto): Promise<RecognitionConfigView> {
  const plain = row.key_sealed === null ? null : await unsealKey(row.key_sealed, crypto)
  const masked = plain !== null ? maskKey(plain) : null
  return {
    id: Number(row.id),
    name: row.name,
    role: row.role as RecognitionConfigRole,
    baseUrl: row.base_url,
    model: row.model,
    apiKeyTail: masked === null ? null : masked.tail,
    apiKeyLen: masked === null ? null : masked.len,
    apiKeySet: row.key_sealed !== null,
    timeoutMs: row.timeout_ms === null ? null : Number(row.timeout_ms),
    lastTestAt: row.last_test_at === null ? null : Number(row.last_test_at),
    lastTestOk: row.last_test_ok === null ? null : Number(row.last_test_ok) === 1,
    lastTestUsage: parseStoredUsage(row.last_test_usage_json),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function getConfigRow(id: number): ConfigRow {
  const row = getDatabase().prepare('SELECT * FROM contestpin_configs WHERE id = ?').get(id) as unknown as ConfigRow | undefined
  if (row === undefined) {
    throw new ServiceError('NOT_FOUND', `识别配置 ${id} not found`)
  }
  return row
}

// ---------------------------------------------------------------------------
// 校验（本地实现，勿跨域耦合 overlayStateService）
// ---------------------------------------------------------------------------

/** baseUrl 校验：仅 http/https 绝对 URL（validateExternalUrl 风格本地实现），返回规范化串。 */
function validateConfigBaseUrl(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    throw new ServiceError('BAD_PAYLOAD', '识别配置 baseUrl 必须为非空 http(s) URL')
  }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new ServiceError('BAD_PAYLOAD', '识别配置 baseUrl 必须为绝对 http(s) URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ServiceError('BAD_PAYLOAD', `识别配置 baseUrl 仅允许 http/https（got scheme: ${parsed.protocol}）`)
  }
  return parsed.toString()
}

function requireNonEmpty(value: string, field: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    throw new ServiceError('BAD_PAYLOAD', `识别配置 ${field} 必填且不能为空白`)
  }
  return trimmed
}

function validateTimeoutMs(value: number | null | undefined, configId: number | undefined): number | null | undefined {
  if (value === undefined) return configId === undefined ? null : undefined
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new ServiceError('BAD_PAYLOAD', '识别配置 timeoutMs 必须为正整数毫秒或 null')
  }
  return value
}

function assertNameRoleFree(name: string, role: RecognitionConfigRole, excludeId: number | undefined): void {
  const db = getDatabase()
  const dup =
    excludeId === undefined
      ? (db.prepare('SELECT id FROM contestpin_configs WHERE name = ? AND role = ?').get(name, role) as unknown as { id: number } | undefined)
      : (db.prepare('SELECT id FROM contestpin_configs WHERE name = ? AND role = ? AND id <> ?').get(name, role, excludeId) as unknown as { id: number } | undefined)
  if (dup !== undefined) {
    // UNIQUE(name, role) 预检（profileStore 同款 DB_ERROR + 可读文案）
    throw new ServiceError('DB_ERROR', `识别配置已存在: ${name}（${role}）——同名同角色唯一，请换名或编辑既有配置`)
  }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/** 掩码清单（按 role, name 排序；解密仅取掩码瞬间，绝不回明文/sealed）。 */
export async function listConfigs(): Promise<RecognitionConfigListResult> {
  const crypto = getKeyCrypto()
  const rows = getDatabase()
    .prepare('SELECT * FROM contestpin_configs ORDER BY role, name')
    .all() as unknown as ConfigRow[]
  const configs: RecognitionConfigView[] = []
  for (const row of rows) {
    configs.push(await toView(row, crypto))
  }
  return { configs }
}

/**
 * 新建/编辑识别配置。apiKey 空串/undefined = 保持既有（编辑；ApiHubView 密码框
 * 留空不改约定）；新建空 key = 无鉴权端点（key_sealed NULL）。UNIQUE(name,role)
 * 冲突 → DB_ERROR。返回掩码视图。
 */
export async function saveConfig(payload: RecognitionConfigSavePayload): Promise<RecognitionConfigView> {
  const name = requireNonEmpty(payload.name, 'name')
  if (!isRecognitionConfigRole(payload.role)) {
    throw new ServiceError('BAD_PAYLOAD', '识别配置 role 必须为 vision | text | multimodal')
  }
  const role = payload.role
  const baseUrl = validateConfigBaseUrl(payload.baseUrl)
  const model = requireNonEmpty(payload.model, 'model')
  const crypto = getKeyCrypto()
  const db = getDatabase()
  const now = nowSec()
  // 密码框约定：apiKey 空串/undefined = 不改 key；非空白 = 重录 key（trim 后 seal）
  const newPlainKey = payload.apiKey !== undefined && payload.apiKey.trim().length > 0 ? payload.apiKey.trim() : undefined

  if (payload.id !== undefined) {
    const existing = getConfigRow(payload.id) // 不存在 → NOT_FOUND
    const timeoutMs = validateTimeoutMs(payload.timeoutMs, payload.id)
    assertNameRoleFree(name, role, payload.id)
    // newPlainKey undefined = 保持既有 key_sealed（可能为 NULL = 无鉴权端点）
    const keySealed = newPlainKey !== undefined ? await sealKey(newPlainKey, crypto) : (existing.key_sealed as string | null)
    db.prepare(
      'UPDATE contestpin_configs SET name = ?, role = ?, base_url = ?, model = ?, key_sealed = ?, timeout_ms = ?, updated_at = ? WHERE id = ?',
    ).run(
      name,
      role,
      baseUrl,
      model,
      keySealed,
      timeoutMs === undefined ? existing.timeout_ms : timeoutMs,
      now,
      payload.id,
    )
    logger.info(`contestpin config saved (edit): id=${payload.id} role=${role}`)
    return toView(getConfigRow(payload.id), crypto)
  }

  const timeoutMs = validateTimeoutMs(payload.timeoutMs, undefined)
  assertNameRoleFree(name, role, undefined)
  // 新建不带 key = 无鉴权端点（key_sealed NULL 允许保存，docs/22 §6）
  const keySealed = newPlainKey !== undefined ? await sealKey(newPlainKey, crypto) : null
  const result = db
    .prepare(
      'INSERT INTO contestpin_configs (name, role, base_url, model, key_sealed, timeout_ms, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(name, role, baseUrl, model, keySealed, timeoutMs === undefined ? null : timeoutMs, now, now)
  const id = Number(result.lastInsertRowid)
  logger.info(`contestpin config saved (create): id=${id} role=${role} withKey=${newPlainKey !== undefined}`)
  return toView(getConfigRow(id), crypto)
}

/**
 * 删除识别配置（CONFIRM_REQUIRED 两段式，docker:action / contest:delete 先例）：
 * 缺省 confirmed → { confirmRequired:true, impacts:{ importJobs } }（引用该配置
 * 的 contest_import_jobs 计数，直接 COUNT）；confirmed → 删除行（jobs 侧 FK
 * ON DELETE SET NULL，任务行保留、引用置空）→ { removed:true }。
 */
export function deleteConfig(payload: RecognitionConfigDeletePayload): RecognitionConfigDeleteStart | RecognitionConfigDeleteResult {
  const db = getDatabase()
  const row = getConfigRow(payload.id) // 不存在 → NOT_FOUND（两段式前后一致）
  if (payload.confirmed !== true) {
    const jobs = db
      .prepare('SELECT COUNT(*) AS c FROM contest_import_jobs WHERE vision_config_id = ? OR text_config_id = ?')
      .get(row.id, row.id) as unknown as { c: number }
    return { confirmRequired: true, impacts: { importJobs: Number(jobs.c) } }
  }
  db.prepare('DELETE FROM contestpin_configs WHERE id = ?').run(row.id)
  logger.info(`contestpin config deleted: id=${row.id} role=${row.role}`)
  return { confirmRequired: undefined, removed: true }
}

// ---------------------------------------------------------------------------
// 连接测试（解密 → probeConfig → 落 last_test_* → 分类文案）
// ---------------------------------------------------------------------------

/**
 * 测试失败分类 + 中文文案：IMAGE_UNSUPPORTED 按服务端错误摘要含 image/multimodal
 * 字样从 HTTP_ERROR/BAD_RESPONSE 派生；不可判归原分类并原样带简短摘要。
 */
function classifyTestFailure(failure: ChatFailure): { kind: RecognitionTestErrorKind; message: string } {
  const lower = failure.message.toLowerCase()
  if ((failure.kind === 'HTTP_ERROR' || failure.kind === 'BAD_RESPONSE') && (lower.includes('image') || lower.includes('multimodal'))) {
    return { kind: 'IMAGE_UNSUPPORTED', message: `图片不支持：${failure.message}` }
  }
  switch (failure.kind) {
    case 'AUTH':
      return { kind: 'AUTH', message: `鉴权失败：${failure.message}` }
    case 'RATE_LIMIT':
      return { kind: 'RATE_LIMIT', message: `触发限流：${failure.message}` }
    case 'TIMEOUT':
      return { kind: 'TIMEOUT', message: `连接测试超时：${failure.message}` }
    case 'NETWORK':
      return { kind: 'NETWORK', message: `网络错误：${failure.message}` }
    case 'BAD_RESPONSE':
      return { kind: 'BAD_RESPONSE', message: `响应格式错误：${failure.message}` }
    case 'HTTP_ERROR':
      return { kind: 'HTTP_ERROR', message: failure.message }
  }
}

/**
 * 连接测试：解密（getKeyCrypto，明文仅内存瞬间）→ probeConfig（按角色发
 * ping / 1x1 红 PNG）→ 落 last_test_at/last_test_ok/last_test_usage_json
 * （仅实测 usage 才写 JSON；'unknown' 与失败一律 NULL）→ 返回测试结果。
 */
export async function testConfig(id: number): Promise<RecognitionTestResult> {
  const row = getConfigRow(id)
  const crypto = getKeyCrypto()
  let apiKey: string | undefined
  if (row.key_sealed !== null) {
    const plain = await unsealKey(row.key_sealed, crypto)
    if (plain === null) {
      throw new ServiceError('DB_ERROR', `识别配置 ${id} 的密钥不可解密（系统密钥环境变更或数据损坏），请重新录入 API Key`)
    }
    apiKey = plain
  }
  const probed = await probeConfig(
    {
      baseUrl: row.base_url,
      model: row.model,
      ...(apiKey !== undefined && apiKey.length > 0 ? { apiKey } : {}),
      ...(row.timeout_ms !== null ? { timeoutMs: Number(row.timeout_ms) } : {}),
    },
    row.role as RecognitionConfigRole,
  )
  const now = nowSec()
  const db = getDatabase()
  if (probed.ok) {
    // 仅真实返回才写实测 usage；'unknown' 落 NULL（绝不把"未返回"伪装成实测）
    const usageJson = probed.usage === 'unknown' ? null : JSON.stringify(probed.usage)
    db.prepare('UPDATE contestpin_configs SET last_test_at = ?, last_test_ok = 1, last_test_usage_json = ?, updated_at = ? WHERE id = ?').run(
      now,
      usageJson,
      now,
      row.id,
    )
    return { ok: true, latencyMs: probed.latencyMs, usage: probed.usage }
  }
  db.prepare('UPDATE contestpin_configs SET last_test_at = ?, last_test_ok = 0, last_test_usage_json = NULL, updated_at = ? WHERE id = ?').run(
    now,
    now,
    row.id,
  )
  const classified = classifyTestFailure(probed.failure)
  return { ok: false, latencyMs: probed.latencyMs, usage: 'unknown', error: classified }
}
