/**
 * profileStore.ts — apihub_profiles CRUD（docs/09 §3.4，S3 批次）。
 *
 * - encrypted_blob = JSON envelope 的 UTF-8 字节：{ v:1, sealed, fields, plainStore? }；
 *   key 全值只在 seal/解密瞬间存在于内存（docs/09 §6.5 红线），sealed 是注入
 *   KeyCrypto 的密文（safeStorage/DPAPI 或 smoke 的 base64 降级形态）；
 * - needs_rekey=1 的档案（S1 导入的老 DPAPI 占位）：读取时尝试用当前 KeyCrypto
 *   解密重加密（成功才覆盖 blob + 清零标记；失败保持 1 并如实回 null 掩码，
 *   绝不猜测、绝不伪造可用性，docs/09 §6.2）；
 * - name 全局 UNIQUE（migration 003）；激活态不落库（apihub:current 反推）。
 * 全部 SQL 字面量 + 参数绑定（约束 #11）。
 */

import { getDatabase } from '../../db/index.ts'
import type { ApiHubAdapterId, ApiHubProfileView } from '../../../shared/types.ts'
import { ServiceError, nowSec } from '../internal.ts'
import { maskKey, type KeyCrypto } from './keyStore.ts'

const ENVELOPE_VERSION = 1 as const

export interface ApiHubProfileRow {
  id: number
  name: string
  provider: ApiHubAdapterId
  fields: Record<string, string>
  sealed: string
  plainStore: boolean
  needsRekey: boolean
  createdAt: number
  updatedAt: number
}

interface Envelope {
  v: number
  sealed: string
  fields: Record<string, string>
  plainStore?: boolean
}

function decodeEnvelope(raw: unknown): Envelope | null {
  if (!(raw instanceof Uint8Array) && typeof raw !== 'string') return null
  try {
    const text = raw instanceof Uint8Array ? Buffer.from(raw).toString('utf8') : raw
    const parsed = JSON.parse(text) as Partial<Envelope>
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
      fields: { ...(parsed.fields as Record<string, string>) },
      ...(parsed.plainStore === true ? { plainStore: true as const } : {}),
    }
  } catch {
    return null
  }
}

interface DbRow {
  id: number
  name: string
  provider: string
  encrypted_blob: Uint8Array | string | null
  needs_rekey: number
  created_at: number
  updated_at: number
}

function rowToProfile(row: DbRow): ApiHubProfileRow | null {
  const envelope = decodeEnvelope(row.encrypted_blob)
  if (envelope === null) return null
  return {
    id: Number(row.id),
    name: row.name,
    provider: row.provider as ApiHubAdapterId,
    fields: envelope.fields,
    sealed: envelope.sealed,
    plainStore: envelope.plainStore === true,
    needsRekey: Number(row.needs_rekey) === 1,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function listRows(provider: ApiHubAdapterId | undefined): DbRow[] {
  const db = getDatabase()
  const rows =
    provider === undefined
      ? (db.prepare('SELECT * FROM apihub_profiles ORDER BY provider, name').all() as unknown as DbRow[])
      : (db.prepare('SELECT * FROM apihub_profiles WHERE provider = ? ORDER BY name').all(provider) as unknown as DbRow[])
  return rows
}

/**
 * 尝试解密 sealed → 明文（仅主进程内存瞬间）。
 * - plainStore 档案（老数据 base64 即明文，docs/09 §6.2）：直接 base64 还原，不走 crypto；
 * - needs_rekey 档案解密成功时立即用当前 KeyCrypto 重加密回写（needs_rekey → 0；
 *   成功前不删旧 blob —— 失败路径不触碰 DB）；
 * - 解密失败返回 null，绝不猜测、绝不伪造可用性。
 */
async function sealedToPlain(profile: ApiHubProfileRow, crypto: KeyCrypto): Promise<string | null> {
  let plain: string | null = null
  if (profile.plainStore) {
    try {
      plain = Buffer.from(profile.sealed, 'base64').toString('utf8')
    } catch {
      return null
    }
  } else {
    try {
      plain = await crypto.decrypt(profile.sealed)
    } catch {
      return null
    }
  }
  if (profile.needsRekey) {
    // S3 迁移流程（docs/09 §6.2）：解密成功 → 立即用 DevHub KeyCrypto 重加密入库
    try {
      const resealed = await crypto.encrypt(plain)
      const db = getDatabase()
      const envelope: Envelope = {
        v: ENVELOPE_VERSION,
        sealed: resealed,
        fields: profile.fields,
        ...(crypto.plainStore === true ? { plainStore: true as const } : {}),
      }
      db.prepare('UPDATE apihub_profiles SET encrypted_blob = ?, needs_rekey = 0, updated_at = ? WHERE id = ?').run(
        Buffer.from(JSON.stringify(envelope), 'utf8'),
        nowSec(),
        profile.id,
      )
    } catch {
      // 重加密失败：保持 needs_rekey=1 与旧 blob 不动（明文仅存在于本次内存瞬间）
    }
  }
  return plain
}

/** 档案 → 脱敏视图（解密仅取掩码；不可解如实回 null，不抛、不伪造）。 */
async function toView(profile: ApiHubProfileRow, crypto: KeyCrypto): Promise<ApiHubProfileView> {
  const plain = await sealedToPlain(profile, crypto)
  const masked: { tail: string | null; len: number | null } =
    plain !== null ? { tail: maskKey(plain).tail, len: maskKey(plain).len } : { tail: null, len: null }
  return {
    id: profile.id,
    provider: profile.provider,
    name: profile.name,
    fields: { ...profile.fields },
    apiKeyTail: masked.tail,
    apiKeyLen: masked.len,
    plainStore: profile.plainStore,
    needsRekey: profile.needsRekey,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  }
}

/** 某适配器（或全部）档案的脱敏清单。 */
export async function listProfileViews(provider: ApiHubAdapterId | undefined, crypto: KeyCrypto): Promise<ApiHubProfileView[]> {
  const views: ApiHubProfileView[] = []
  for (const row of listRows(provider)) {
    const profile = rowToProfile(row)
    if (profile === null) continue
    views.push(await toView(profile, crypto))
  }
  return views
}

/** 单条档案（provider + id 定位）；不存在 → NOT_FOUND。 */
export async function getProfile(provider: ApiHubAdapterId, id: number): Promise<ApiHubProfileRow> {
  const db = getDatabase()
  const row = db.prepare('SELECT * FROM apihub_profiles WHERE provider = ? AND id = ?').get(provider, id) as unknown as DbRow | undefined
  if (row === undefined) throw new ServiceError('NOT_FOUND', `profile ${id} not found for adapter ${provider}`)
  const profile = rowToProfile(row)
  if (profile === null) throw new ServiceError('DB_ERROR', `profile ${id} blob is unreadable (needs manual fix)`)
  return profile
}

/** 取档案的 key 明文（仅主进程切换/写文件瞬间；不可解返回 null，绝不伪造）。 */
export async function decryptProfileKey(profile: ApiHubProfileRow, crypto: KeyCrypto): Promise<string | null> {
  return sealedToPlain(profile, crypto)
}

export interface UpsertProfileInput {
  adapterId: ApiHubAdapterId
  id?: number
  name: string
  fields: Record<string, string>
}

/**
 * 新增/编辑档案。apiKeyPlain 非空 → seal 入库（并清 needs_rekey）；为空且是编辑 →
 * 保留原 blob（编辑时留空 = 不改动 key）。编辑 needs_rekey 档案且不带新 key：blob 原样保留、
 * 标记不清零（仍禁止切换）。返回脱敏视图。
 */
export async function upsertProfile(
  input: UpsertProfileInput,
  apiKeyPlain: string | undefined,
  crypto: KeyCrypto,
): Promise<ApiHubProfileView> {
  if (input.name.trim().length === 0) throw new ServiceError('BAD_PAYLOAD', '档案名不能为空')
  const db = getDatabase()
  const now = nowSec()

  if (input.id !== undefined) {
    const existing = await getProfile(input.adapterId, input.id) // 存在性校验（不存在 → NOT_FOUND）
    if (apiKeyPlain !== undefined && apiKeyPlain.trim().length > 0) {
      const sealed = await crypto.encrypt(apiKeyPlain)
      const envelope: Envelope = {
        v: ENVELOPE_VERSION,
        sealed,
        fields: input.fields,
        ...(crypto.plainStore === true ? { plainStore: true as const } : {}),
      }
      db.prepare('UPDATE apihub_profiles SET name = ?, encrypted_blob = ?, needs_rekey = 0, updated_at = ? WHERE id = ?').run(
        input.name.trim(),
        Buffer.from(JSON.stringify(envelope), 'utf8'),
        now,
        input.id,
      )
    } else {
      // 编辑不带 key：保留原 sealed（老实现同语义），fields/name 用新值重写 envelope；
      // needs_rekey 保持不变（密钥本身未重录，不得自证已重加密）
      const envelope: Envelope = {
        v: ENVELOPE_VERSION,
        sealed: existing.sealed,
        fields: input.fields,
        ...(existing.plainStore ? { plainStore: true as const } : {}),
      }
      db.prepare('UPDATE apihub_profiles SET name = ?, encrypted_blob = ?, updated_at = ? WHERE id = ?').run(
        input.name.trim(),
        Buffer.from(JSON.stringify(envelope), 'utf8'),
        now,
        input.id,
      )
    }
    const updated = await getProfile(input.adapterId, input.id)
    return toView(updated, crypto)
  }

  // 新增：name 全局 UNIQUE（docs/09 §3.4），冲突给出结构化错误（S1 导入器已按 <provider>/<name> 去重）
  const dup = db.prepare('SELECT id FROM apihub_profiles WHERE name = ?').get(input.name.trim())
  if (dup !== undefined) {
    throw new ServiceError('DB_ERROR', `档案名已存在: ${input.name.trim()}（全局唯一，请换名或编辑既有档案）`)
  }
  if (apiKeyPlain === undefined || apiKeyPlain.trim().length === 0) {
    throw new ServiceError('BAD_PAYLOAD', '新增档案必须提供 apiKeyPlain')
  }
  const sealed = await crypto.encrypt(apiKeyPlain)
  const envelope: Envelope = {
    v: ENVELOPE_VERSION,
    sealed,
    fields: input.fields,
    ...(crypto.plainStore === true ? { plainStore: true as const } : {}),
  }
  const result = db
    .prepare(
      'INSERT INTO apihub_profiles (name, provider, encrypted_blob, needs_rekey, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)',
    )
    .run(input.name.trim(), input.adapterId, Buffer.from(JSON.stringify(envelope), 'utf8'), now, now)
  const created = await getProfile(input.adapterId, Number(result.lastInsertRowid))
  return toView(created, crypto)
}

/** 删除档案（provider + id 定位，防误删其它 provider 的同名 id）。 */
export function removeProfile(provider: ApiHubAdapterId, id: number): { deleted: boolean } {
  const db = getDatabase()
  const result = db.prepare('DELETE FROM apihub_profiles WHERE provider = ? AND id = ?').run(provider, id)
  return { deleted: Number(result.changes) > 0 }
}
