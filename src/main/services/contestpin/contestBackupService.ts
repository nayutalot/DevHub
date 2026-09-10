/**
 * contestBackupService.ts — ContestPin 备份恢复（CP6 收官批，docs/22 §9）。
 *
 * - **导出**（contestpin:backupExport，READ_ONLY 库面——产物落用户选择目录，
 *   exportPack 同款先例）：目标目录 `manifest.json`（contests/nodes/reminders/
 *   materials 元数据，**结构性不含 contestpin_configs.key_sealed 与任何凭据**——
 *   本模块只读 contests/contest_nodes/contest_reminders/contest_materials 四表，
 *   识别配置表结构性不出现在导出面）+ `materials/` 附件夹按 sha256 命名复制
 *   （同 sha EEXIST 跳过 = 天然去重/断点续传，中断重跑幂等）；manifest 最后写
 *   （临时名 + rename 原子落位，不留半成品）；目标目录已有 manifest →
 *   `BACKUP_EXISTS` 结构化拒绝不覆盖（用户重选目录，诚实面）。
 * - **导入**（contestpin:backupImport，变更面）：manifest 解析 → 形状校验
 *   （未知字段容忍并 flag）→ 材料 sha256 对账（库已有 sha 复用；备份夹读文件
 *   重算哈希核对，缺文件/哈希不符如实 flag **降级不带病导入**）→ 全部赛事作为
 *   **一份 manual_pack 草稿**（与 CP3b/CP5 同一条 ensureValidatedDraft →
 *   validateDraftContests 单一权威校验）走既有草稿核对界面——每比赛相似检测
 *   按 name+year 既有逻辑，用户逐项确认/合并/另建。**绝不直写 contests/
 *   contest_nodes 生产行，绝不静默覆盖**（confirmDraft 复用，不设第二条落库
 *   路径）。提醒规则/状态/归档/备注/完成态为导出元数据，导入以 flag 如实告知
 *   （提醒挂节点 id、属库内自增跨库不可移植——绝不静默重建）。
 *
 * electron-free 纯 Node 模块（db 经 getDatabase()，DEVHUB_HOME 驱动）；SQL 全
 * 参数绑定（约束 #11）；结构化 ServiceError（约束 #14）；零凭据零网络零 spawn。
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { getDatabase } from '../../db/index.ts'
import { logger } from '../../core/logger.ts'
import { nowSec, ServiceError } from '../internal.ts'
import { LIMIT_CEILINGS, materialsDir, restoreMaterialFromBackup } from './materialService.ts'
import { ensureValidatedDraft, listImportJobs } from './importPipeline.ts'
import type {
  ContestAgentJobView,
  ContestBackupExportPayload,
  ContestBackupExportResult,
  ContestBackupImportPayload,
  ContestBackupImportResult,
  ContestNodeKind,
  ContestNodePrecision,
  ImportContestDraft,
  ImportDraftView,
  ImportFlag,
  ImportNodeDraft,
} from '../../../shared/types.ts'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** manifest.json 大小上限（纯元数据 JSON；20MB 足够千赛级，防病态文件）。 */
const MANIFEST_MAX_BYTES = 20 * 1024 * 1024
/** manifest 结构身份与版本（版本化 JSON：导入端未知字段忽略并 flag，docs/22 §9.1）。 */
const BACKUP_KIND = 'contestpin-backup'
const BACKUP_VERSION = 1

// ---------------------------------------------------------------------------
// manifest 内部形状（导出产物 = 本形状；导入端按此校验 + 未知字段容忍）
// ---------------------------------------------------------------------------

interface ManifestMaterial {
  sha256: string
  /** 备份夹内文件名（`<sha256><ext>`，与库内 stored_path 同名——sha256 命名天然去重）。 */
  fileName: string
  originalName: string
  kind: 'pdf' | 'image' | 'other'
  sizeBytes: number | null
}

interface ManifestNode {
  kind: string
  label: string
  precision: string
  /** unix 秒（库内原值）；tbd → null。 */
  startAt: number | null
  endAt: number | null
  tz: string
  rawText: string | null
  done: boolean
  doneAt: number | null
  source: string
}

interface ManifestReminder {
  /** 所属节点定位（kind+label；节点 id 属库内自增，跨库不可移植）。 */
  nodeKind: string
  nodeLabel: string
  offsetKind: string
  offsetValue: number
  channel: string
  enabled: boolean
}

interface ManifestContest {
  name: string
  year: number | null
  edition: string | null
  organizer: string | null
  note: string | null
  status: string
  archived: boolean
  officialSite: string | null
  signupUrl: string | null
  submitUrl: string | null
  /** 该比赛关联材料（sha256 引用，内容在 materials/ 夹）。 */
  materialShas: string[]
  nodes: ManifestNode[]
  reminders: ManifestReminder[]
}

interface BackupManifest {
  kind: string
  version: number
  exportedAt: number
  /** 来源库名义标识（零本机路径、零凭据）。 */
  source: { app: string; module: string }
  counts: { contests: number; nodes: number; reminders: number; materials: number }
  contests: ManifestContest[]
  materials: ManifestMaterial[]
}

interface ContestDbRow {
  id: number
  name: string
  year: number | null
  edition: string | null
  organizer: string | null
  note: string | null
  status: string
  archived: number
  official_site: string | null
  signup_url: string | null
  submit_url: string | null
}

interface NodeDbRow {
  id: number
  kind: string
  label: string
  start_at: number | null
  end_at: number | null
  tz: string
  precision: string
  raw_text: string | null
  done: number
  done_at: number | null
  source: string
}

interface ReminderDbRow {
  node_id: number
  offset_kind: string
  offset_value: number
  channel: string
  enabled: number
}

interface MaterialDbRow {
  id: number
  sha256: string
  original_name: string
  stored_path: string
  size_bytes: number | null
  kind: string
}

function badRequest(face: string, detail: string): ServiceError {
  return new ServiceError('BAD_PAYLOAD', `backup${face}: ${detail}`)
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

// ---------------------------------------------------------------------------
// contestpin:backupExport（READ_ONLY 库面；产物 manifest + materials/）
// ---------------------------------------------------------------------------

/**
 * 全库备份导出：contests（含归档）+ 节点 + 提醒规则 + 关联材料元数据 →
 * manifest.json；材料内容按 sha256 命名复制到 materials/。已存在 manifest →
 * BACKUP_EXISTS 拒绝；材料同 sha 跳过（幂等可重跑）；manifest 临时名 + rename
 * 原子落位（中断不留半成品 manifest）。库内材料文件缺失/哈希不符时该材料不进
 * manifest 并计入日志（manifest 只收自洽条目，绝不编造内容）。
 */
export async function exportBackup(payload: ContestBackupExportPayload): Promise<ContestBackupExportResult> {
  if (typeof payload.destDir !== 'string' || payload.destDir.trim().length === 0) {
    throw badRequest('Export', 'destDir is required')
  }
  if (!isAbsolute(payload.destDir)) {
    throw badRequest('Export', 'destDir must be an absolute path')
  }
  const destDir = payload.destDir.trim()
  const db = getDatabase()

  // ---- 拒绝覆盖：任何复制动作发生前先查 manifest（诚实面）----
  const manifestPath = join(destDir, 'manifest.json')
  let existing: Buffer | null = null
  try {
    existing = await readFile(manifestPath)
  } catch {
    existing = null
  }
  if (existing !== null) {
    throw new ServiceError('BACKUP_EXISTS', `目标目录已存在 manifest.json，拒绝覆盖（请改用其他目录或先清理）：${destDir}`)
  }

  // ---- 读库（四表只读；识别配置表结构性不在导出面——零凭据红线）----
  const contestRows = db.prepare('SELECT * FROM contests ORDER BY id').all() as unknown as ContestDbRow[]
  const materialBySha = new Map<string, MaterialDbRow>()
  const manifestContests: ManifestContest[] = []
  let nodeTotal = 0
  let reminderTotal = 0

  for (const c of contestRows) {
    const nodes = db
      .prepare('SELECT * FROM contest_nodes WHERE contest_id = ? ORDER BY (start_at IS NULL), start_at, id')
      .all(c.id) as unknown as NodeDbRow[]
    const reminders = db
      .prepare('SELECT r.* FROM contest_reminders r JOIN contest_nodes n ON n.id = r.node_id WHERE n.contest_id = ? ORDER BY r.id')
      .all(c.id) as unknown as ReminderDbRow[]
    const materialShas = (
      db
        .prepare(
          'SELECT DISTINCT m.sha256 FROM contest_materials m JOIN contest_import_jobs j ON j.material_id = m.id WHERE j.contest_id = ? ORDER BY m.sha256',
        )
        .all(c.id) as unknown as { sha256: string }[]
    ).map((r) => r.sha256)
    for (const sha of materialShas) {
      if (materialBySha.has(sha)) continue
      const row = db
        .prepare('SELECT id, sha256, original_name, stored_path, size_bytes, kind FROM contest_materials WHERE sha256 = ?')
        .get(sha) as MaterialDbRow | undefined
      if (row !== undefined) materialBySha.set(sha, row)
    }
    const nodeById = new Map(nodes.map((n) => [n.id, n]))
    manifestContests.push({
      name: c.name,
      year: c.year === null ? null : Number(c.year),
      edition: c.edition,
      organizer: c.organizer,
      note: c.note,
      status: c.status,
      archived: c.archived === 1,
      officialSite: c.official_site,
      signupUrl: c.signup_url,
      submitUrl: c.submit_url,
      materialShas,
      nodes: nodes.map((n) => ({
        kind: n.kind,
        label: n.label,
        precision: n.precision,
        startAt: n.start_at === null ? null : Number(n.start_at),
        endAt: n.end_at === null ? null : Number(n.end_at),
        tz: n.tz,
        rawText: n.raw_text,
        done: n.done === 1,
        doneAt: n.done_at === null ? null : Number(n.done_at),
        source: n.source,
      })),
      reminders: reminders.map((r) => ({
        nodeKind: nodeById.get(r.node_id)?.kind ?? 'custom',
        nodeLabel: nodeById.get(r.node_id)?.label ?? '',
        offsetKind: r.offset_kind,
        offsetValue: Number(r.offset_value),
        channel: r.channel,
        enabled: r.enabled === 1,
      })),
    })
    nodeTotal += nodes.length
    reminderTotal += reminders.length
  }

  // ---- materials/ 复制（sha256 命名；同 sha EEXIST 跳过 = 幂等/断点续传）----
  const destMaterialsDir = join(destDir, 'materials')
  await mkdir(destMaterialsDir, { recursive: true })
  const manifestMaterials: ManifestMaterial[] = []
  const expectedDir = materialsDir()
  for (const row of materialBySha.values()) {
    const fileName = basename(row.stored_path)
    if (!row.stored_path.startsWith(expectedDir)) {
      // 存储路径越界（理论不可达）：如实跳过，绝不复制库外文件
      logger.warn(`contestpin backup export: material ${row.sha256} stored_path out of bounds, skipped`)
      continue
    }
    let data: Buffer
    try {
      data = await readFile(row.stored_path)
    } catch {
      logger.warn(`contestpin backup export: material ${row.sha256} file missing, skipped`)
      continue
    }
    // 内容哈希与行内 sha 不符（库不一致）：如实跳过（manifest 只收自洽条目）
    if (sha256Hex(data) !== row.sha256) {
      logger.warn(`contestpin backup export: material ${row.sha256} content hash mismatch, skipped`)
      continue
    }
    const destPath = join(destMaterialsDir, fileName)
    await writeFile(destPath, data, { flag: 'wx' }).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'EEXIST') throw err
      // 同 sha 已在（先前中断重跑）：sha256 命名 ⇒ 内容一致，跳过即幂等
    })
    manifestMaterials.push({
      sha256: row.sha256,
      fileName,
      originalName: row.original_name,
      kind: (['pdf', 'image', 'other'] as const).includes(row.kind as 'pdf') ? (row.kind as ManifestMaterial['kind']) : 'other',
      sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    })
  }

  // ---- manifest 最后原子写（临时名 + rename；中断不留半成品 manifest）----
  const manifest: BackupManifest = {
    kind: BACKUP_KIND,
    version: BACKUP_VERSION,
    exportedAt: nowSec(),
    source: { app: 'DevHub', module: 'contestpin' },
    counts: {
      contests: manifestContests.length,
      nodes: nodeTotal,
      reminders: reminderTotal,
      materials: manifestMaterials.length,
    },
    contests: manifestContests,
    materials: manifestMaterials,
  }
  const json = JSON.stringify(manifest, null, 2)
  const tmpPath = `${manifestPath}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmpPath, json, 'utf8')
  await rename(tmpPath, manifestPath)
  logger.info(
    `contestpin backup exported: ${manifestPath} contests=${manifestContests.length} nodes=${nodeTotal} reminders=${reminderTotal} materials=${manifestMaterials.length}`,
  )
  return {
    manifestPath,
    bytes: Buffer.byteLength(json, 'utf8'),
    contestCount: manifestContests.length,
    nodeCount: nodeTotal,
    reminderCount: reminderTotal,
    materialCount: manifestMaterials.length,
  }
}

// ---------------------------------------------------------------------------
// contestpin:backupImport（形状/材料对账校验 → 一份 draft；绝不静默覆盖）
// ---------------------------------------------------------------------------

/** 导入侧 manifest 解析产物（合法条目 + flag 收集）。 */
interface ParsedManifest {
  version: number
  contests: ManifestContest[]
  materials: ManifestMaterial[]
  flags: ImportFlag[]
}

const NODE_KINDS: readonly string[] = ['signup_start', 'signup_deadline', 'payment_deadline', 'contest_start', 'contest_end', 'submit_deadline', 'custom']
const PRECISIONS: readonly string[] = ['exact', 'date', 'month', 'tbd']
const OFFSET_KINDS: readonly string[] = ['before_days', 'before_hours', 'at_time']
const CHANNELS: readonly string[] = ['windows', 'in_app']
const MATERIAL_KINDS: readonly string[] = ['pdf', 'image', 'other']
const SHA_RE = /^[0-9a-f]{64}$/

/** manifest JSON → 结构化条目（形状校验：非法条目 flag+丢弃，不抛碎错误）。 */
function parseManifest(raw: string): ParsedManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new ServiceError('BAD_RESPONSE', `manifest JSON 解析失败：${err instanceof Error ? err.message : String(err)}`)
  }
  if (!isPlainObject(parsed)) {
    throw new ServiceError('BAD_RESPONSE', 'manifest 形状非法：顶层必须为对象')
  }
  if (parsed.kind !== BACKUP_KIND) {
    throw new ServiceError('BAD_RESPONSE', `manifest 形状非法：kind 必须为 '${BACKUP_KIND}'`)
  }
  const version = parsed.version
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    throw new ServiceError('BAD_RESPONSE', 'manifest 形状非法：version 必须为正整数')
  }
  const flags: ImportFlag[] = []
  if (version !== BACKUP_VERSION) {
    flags.push({ field: 'manifest.version', reason: `manifest 版本 ${version} 较新，按 v${BACKUP_VERSION} 语义尽力解析（请人工核对结果）` })
  }
  const knownTop = new Set(['kind', 'version', 'exportedAt', 'source', 'counts', 'contests', 'materials'])
  const unknownFields = Object.keys(parsed).filter((k) => !knownTop.has(k))
  if (unknownFields.length > 0) {
    flags.push({ field: 'manifest', reason: `manifest 含未知字段（向前兼容已忽略）：${unknownFields.join(', ').slice(0, 200)}` })
  }
  const contestsRaw = Array.isArray(parsed.contests) ? parsed.contests : []
  const materialsRaw = Array.isArray(parsed.materials) ? parsed.materials : []

  const materials: ManifestMaterial[] = []
  for (const m of materialsRaw) {
    if (!isPlainObject(m) || typeof m.sha256 !== 'string' || SHA_RE.test(m.sha256) === false) {
      flags.push({ field: 'manifest.materials', reason: '材料条目缺 sha256 或形状非法，已忽略该条目' })
      continue
    }
    if (typeof m.fileName !== 'string' || m.fileName.trim().length === 0) {
      flags.push({ field: 'manifest.materials', reason: `材料 ${m.sha256.slice(0, 12)}… 缺 fileName，已忽略该条目` })
      continue
    }
    materials.push({
      sha256: m.sha256,
      fileName: m.fileName,
      originalName: typeof m.originalName === 'string' && m.originalName.trim().length > 0 ? m.originalName : m.fileName,
      kind: MATERIAL_KINDS.includes(m.kind as string) ? (m.kind as ManifestMaterial['kind']) : 'other',
      sizeBytes: typeof m.sizeBytes === 'number' && Number.isSafeInteger(m.sizeBytes) && m.sizeBytes > 0 ? m.sizeBytes : null,
    })
  }

  const contests: ManifestContest[] = []
  for (const c of contestsRaw) {
    if (!isPlainObject(c) || typeof c.name !== 'string' || c.name.trim().length === 0) {
      flags.push({ field: 'manifest.contests', reason: '比赛条目缺非空 name，已忽略该条目' })
      continue
    }
    const nodes: ManifestNode[] = []
    for (const n of Array.isArray(c.nodes) ? c.nodes : []) {
      if (!isPlainObject(n) || typeof n.label !== 'string' || n.label.trim().length === 0) {
        flags.push({ field: `manifest.contests.${c.name}.nodes`, reason: '节点条目缺非空 label，已忽略该条目', excerpt: c.name })
        continue
      }
      const kindKnown = NODE_KINDS.includes(n.kind as string)
      if (!kindKnown) {
        flags.push({ field: `manifest.contests.${c.name}.nodes.${n.label}`, reason: `节点 kind '${String(n.kind)}' 非法，已按 custom 保留`, excerpt: c.name })
      }
      const num = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) ? v : null)
      nodes.push({
        kind: kindKnown ? (n.kind as string) : 'custom',
        label: n.label,
        precision: PRECISIONS.includes(n.precision as string) ? (n.precision as string) : 'tbd',
        startAt: num(n.startAt),
        endAt: num(n.endAt),
        tz: typeof n.tz === 'string' && n.tz.trim().length > 0 ? n.tz : 'local',
        rawText: typeof n.rawText === 'string' ? n.rawText : null,
        done: n.done === true,
        doneAt: num(n.doneAt),
        source: typeof n.source === 'string' ? n.source : 'imported',
      })
    }
    const reminders: ManifestReminder[] = []
    for (const r of Array.isArray(c.reminders) ? c.reminders : []) {
      if (!isPlainObject(r) || typeof r.nodeLabel !== 'string' || r.nodeLabel.trim().length === 0) continue
      reminders.push({
        nodeKind: typeof r.nodeKind === 'string' ? r.nodeKind : 'custom',
        nodeLabel: r.nodeLabel,
        offsetKind: OFFSET_KINDS.includes(r.offsetKind as string) ? (r.offsetKind as string) : 'at_time',
        offsetValue: typeof r.offsetValue === 'number' && Number.isSafeInteger(r.offsetValue) && r.offsetValue >= 0 ? r.offsetValue : 0,
        channel: CHANNELS.includes(r.channel as string) ? (r.channel as string) : 'in_app',
        enabled: r.enabled !== false,
      })
    }
    const str = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v : null)
    contests.push({
      name: c.name.trim(),
      year: typeof c.year === 'number' && Number.isSafeInteger(c.year) ? c.year : null,
      edition: str(c.edition),
      organizer: str(c.organizer),
      note: typeof c.note === 'string' ? c.note : null,
      status: typeof c.status === 'string' ? c.status : 'watching',
      archived: c.archived === true,
      officialSite: str(c.officialSite),
      signupUrl: str(c.signupUrl),
      submitUrl: str(c.submitUrl),
      materialShas: (Array.isArray(c.materialShas) ? c.materialShas : []).filter(
        (s): s is string => typeof s === 'string' && SHA_RE.test(s),
      ),
      nodes,
      reminders,
    })
  }
  return { version, contests, materials, flags }
}

/**
 * unix 秒 → 草稿时刻文本（本地时区；parseTimeText 可解析形态，导入校验阶段
 * 反解析回同一 unix 秒）：exact → 'YYYY-MM-DD HH:mm[:ss]'、date → 'YYYY-MM-DD'、
 * month → 'YYYY-MM'。
 */
function formatTimeText(sec: number, precision: ContestNodePrecision): string {
  const d = new Date(sec * 1000)
  const p2 = (n: number): string => String(n).padStart(2, '0')
  const ymd = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
  if (precision === 'month') return ymd.slice(0, 7)
  if (precision === 'date') return ymd
  const hm = `${p2(d.getHours())}:${p2(d.getMinutes())}`
  return d.getSeconds() === 0 ? `${ymd} ${hm}` : `${ymd} ${hm}:${p2(d.getSeconds())}`
}

const BACKUP_PROVENANCE = { materialId: 0, page: 0, excerpt: '备份 manifest 还原' }

/** manifest 比赛 → 草稿条目（时刻文本重建 + 元数据如实 flag，绝不静默丢弃/编造）。 */
function toDraftContest(c: ManifestContest, flags: ImportFlag[]): ImportContestDraft {
  const nodes: ImportNodeDraft[] = []
  for (const n of c.nodes) {
    const precision = (PRECISIONS.includes(n.precision) ? n.precision : 'tbd') as ContestNodePrecision
    const node: ImportNodeDraft = {
      kind: (NODE_KINDS.includes(n.kind) ? n.kind : 'custom') as ContestNodeKind,
      label: n.label,
      precision,
      rawText: n.rawText ?? undefined,
      // 来源映射 = 备份 manifest 本身（M#0 约定；值为导出库原值，非材料重提取）
      provenance: { ...BACKUP_PROVENANCE },
    }
    if (precision === 'tbd') {
      if (n.startAt !== null || n.endAt !== null) {
        flags.push({ field: `node.${n.label}`, reason: '节点精度 tbd 但导出数据带时刻，已按 tbd 丢弃时刻（不编造）', excerpt: c.name })
      }
      node.startAt = null
      node.endAt = null
    } else if (n.startAt === null) {
      flags.push({ field: `node.${n.label}`, reason: `节点精度 ${precision} 缺开始时刻，已按 tbd 处理（不编造）`, excerpt: c.name })
      node.precision = 'tbd'
      node.startAt = null
      node.endAt = null
    } else {
      node.startAtText = formatTimeText(n.startAt, precision)
      node.endAtText = n.endAt !== null ? formatTimeText(n.endAt, precision) : undefined
      node.startAt = n.startAt
      node.endAt = n.endAt
      // 时刻语义保真核（低精度 + 带时刻成分 → 重建会取整，如实 flag）
      if (precision === 'date') {
        const dayStart = new Date(n.startAt * 1000)
        dayStart.setHours(0, 0, 0, 0)
        if (n.startAt !== Math.floor(dayStart.getTime() / 1000)) {
          flags.push({ field: `node.${n.label}.startAt`, reason: 'date 精度节点携带时刻成分，重建为当日 00:00，请核对', excerpt: node.startAtText })
        }
      } else if (precision === 'month' && new Date(n.startAt * 1000).getDate() !== 1) {
        flags.push({ field: `node.${n.label}.startAt`, reason: 'month 精度节点非当月 1 日，重建为当月 1 日 00:00，请核对', excerpt: node.startAtText })
      }
      if (n.endAt !== null && n.endAt < n.startAt) {
        flags.push({ field: `node.${n.label}.endAt`, reason: '导出数据 endAt 早于 startAt，endAt 将置空待人工确认', excerpt: c.name })
      }
    }
    if (n.tz.trim().toLowerCase() !== 'local') {
      flags.push({ field: `node.${n.label}.tz`, reason: `节点时区 '${n.tz}' 非本机时区，时刻已按本机时区重建，请核对`, excerpt: c.name })
    }
    if (n.done) {
      flags.push({ field: `node.${n.label}.done`, reason: '导出库中该节点已标记完成，草稿导入后为未完成态，请确认后手动勾选', excerpt: c.name })
    }
    nodes.push(node)
  }

  // 元数据（状态/归档/备注/提醒规则）草稿形状不含 → 汇总一条 flag 如实告知
  const metaNotes: string[] = []
  if (c.status !== 'watching' && c.status !== '') metaNotes.push(`参赛状态=${c.status}`)
  if (c.archived) metaNotes.push('导出库中已归档')
  if (c.note !== null && c.note.trim().length > 0) metaNotes.push('含备注')
  if (c.reminders.length > 0) {
    const brief = c.reminders
      .map((r) =>
        r.offsetKind === 'at_time'
          ? `${r.nodeLabel}:准点/${r.channel}`
          : r.offsetKind === 'before_days'
            ? `${r.nodeLabel}:提前${r.offsetValue}天/${r.channel}`
            : `${r.nodeLabel}:提前${r.offsetValue}小时/${r.channel}`,
      )
      .join('、')
    metaNotes.push(`提醒规则 ${c.reminders.length} 条（${brief.slice(0, 200)}）——提醒不随导入自动重建，确认建赛后请在节点提醒编辑器按需恢复`)
  }
  if (metaNotes.length > 0) {
    flags.push({ field: `contest.${c.name}`, reason: `导出元数据（草稿不含这些字段，确认后请手动调整）：${metaNotes.join('；')}`.slice(0, 400) })
  }

  return {
    name: c.name,
    year: c.year,
    edition: c.edition ?? undefined,
    organizer: c.organizer ?? undefined,
    officialSite: c.officialSite !== null ? { url: c.officialSite, provenance: { ...BACKUP_PROVENANCE } } : undefined,
    signupUrl: c.signupUrl !== null ? { url: c.signupUrl, provenance: { ...BACKUP_PROVENANCE } } : undefined,
    submitUrl: c.submitUrl !== null ? { url: c.submitUrl, provenance: { ...BACKUP_PROVENANCE } } : undefined,
    nodes,
  }
}

/**
 * 备份导入主流程：manifest 解析 → 材料 sha256 对账（库已有复用；备份夹读文件
 * 重算哈希核对；缺/损如实 flag 降级）→ 全部赛事一份草稿（ensureValidatedDraft
 * 同一 validateDraftContests 校验落位）→ manual_pack 任务挂 draft → 既有核对
 * 界面。本函数零 contests/contest_nodes 生产行写入（约束：绝不静默覆盖）。
 */
export async function importBackup(payload: ContestBackupImportPayload): Promise<ContestBackupImportResult> {
  if (typeof payload.manifestPath !== 'string' || payload.manifestPath.trim().length === 0) {
    throw badRequest('Import', 'manifestPath is required')
  }
  if (!isAbsolute(payload.manifestPath)) {
    throw badRequest('Import', 'manifestPath must be an absolute path')
  }
  const manifestPath = payload.manifestPath.trim()
  let stat0
  try {
    stat0 = await stat(manifestPath)
  } catch {
    throw new ServiceError('NOT_FOUND', `manifest 文件不存在或不可读：${manifestPath}`)
  }
  if (!stat0.isFile()) {
    throw badRequest('Import', 'manifestPath must be a regular file')
  }
  if (stat0.size > MANIFEST_MAX_BYTES) {
    throw badRequest('Import', `manifest 超限（>${MANIFEST_MAX_BYTES} 字节）`)
  }
  const raw = await readFile(manifestPath, 'utf8')
  const parsed = parseManifest(raw)

  // ---- 材料 sha256 对账（缺文件/哈希不符 → flag 降级，绝不带病导入）----
  const flags: ImportFlag[] = [...parsed.flags]
  const backupMaterialsDir = join(manifestPath, '..', 'materials')
  let dirFiles: string[] = []
  try {
    dirFiles = await readdir(backupMaterialsDir)
  } catch {
    dirFiles = []
  }
  const fileBySha = new Map<string, string>()
  for (const f of dirFiles) {
    const dot = f.lastIndexOf('.')
    const stem = dot > 0 ? f.slice(0, dot) : f
    if (SHA_RE.test(stem)) fileBySha.set(stem, f)
  }
  const db = getDatabase()
  const materialIdBySha = new Map<string, number>()
  let restoredMaterials = 0
  let reusedMaterials = 0
  for (const m of parsed.materials) {
    const existing = db.prepare('SELECT id FROM contest_materials WHERE sha256 = ?').get(m.sha256) as { id: number } | undefined
    if (existing !== undefined) {
      // 库已有同 sha 材料：内容一致性由库内 UNIQUE(sha256) 保证，直接复用不重复建
      materialIdBySha.set(m.sha256, Number(existing.id))
      reusedMaterials += 1
      continue
    }
    const fileName = fileBySha.get(m.sha256) ?? m.fileName
    let data: Buffer
    try {
      data = await readFile(join(backupMaterialsDir, fileName))
    } catch {
      flags.push({
        field: 'manifest.materials',
        reason: `材料缺失（备份 materials/ 夹无 ${m.originalName} 且库内无同 sha），降级不带病导入`,
        excerpt: m.sha256.slice(0, 16),
      })
      continue
    }
    if (data.length > LIMIT_CEILINGS.maxFileBytes) {
      flags.push({ field: 'manifest.materials', reason: `材料超限（>${LIMIT_CEILINGS.maxFileBytes} 字节），降级不带病导入`, excerpt: m.originalName })
      continue
    }
    if (sha256Hex(data) !== m.sha256) {
      flags.push({ field: 'manifest.materials', reason: '材料哈希对账不符（文件内容与 manifest sha256 不一致），降级不带病导入', excerpt: m.originalName })
      continue
    }
    const view = await restoreMaterialFromBackup(m.originalName, data)
    materialIdBySha.set(m.sha256, view.id)
    restoredMaterials += 1
  }

  // ---- manifest 内部去重提示（同 name+year 多条 → flag，取舍归用户核对）----
  const seen = new Map<string, number>()
  parsed.contests.forEach((c, idx) => {
    const key = `${c.name.toLowerCase()}@${c.year ?? ''}`
    const prev = seen.get(key)
    if (prev !== undefined) {
      flags.push({ field: `contest.${c.name}`, reason: `manifest 内部重复（与第 ${prev} 条同 name+year），请核对后取舍`, excerpt: c.name })
    } else {
      seen.set(key, idx + 1)
    }
  })

  // ---- 全部赛事一份草稿 ----
  const drafts: ImportContestDraft[] = parsed.contests.map((c) => toDraftContest(c, flags))
  if (parsed.contests.length > 0) {
    flags.push({ field: 'manifest.provenance', reason: 'M#0 = 备份 manifest 本身：草稿值为导出库原值（非材料重提取）；材料已按 sha256 对账' })
  }
  const draft: ImportDraftView = { contests: drafts, flags }

  const now = nowSec()
  const inserted = db
    .prepare(
      "INSERT INTO contest_import_jobs (contest_id, material_id, mode, stage, params_json, result_json, progress, created_at, updated_at) VALUES (NULL, NULL, 'manual_pack', 'text_done', ?, ?, 90, ?, ?)",
    )
    .run(
      JSON.stringify({
        source: 'backupImport',
        manifestPath,
        manifestVersion: parsed.version,
        contestCount: parsed.contests.length,
        materialCount: parsed.materials.length,
        restoredMaterials,
        reusedMaterials,
        inScopeMaterialIds: [...new Set(materialIdBySha.values())],
      }),
      JSON.stringify({
        backup: { restoredMaterials, reusedMaterials, manifestVersion: parsed.version, manifestContests: parsed.contests.length },
        draft,
      } as unknown as Record<string, unknown>),
      now,
      now,
    )
  const jobId = Number(inserted.lastInsertRowid)
  await ensureValidatedDraft(jobId)
  logger.info(
    `contestpin backup imported: job ${jobId} contests=${drafts.length} restoredMaterials=${restoredMaterials} reusedMaterials=${reusedMaterials} → draft`,
  )
  const { jobs } = listImportJobs(jobId)
  const job = jobs[0] as ContestAgentJobView | undefined
  if (job === undefined) {
    throw new ServiceError('INTERNAL', `backup import job ${jobId} disappeared after insert`)
  }
  return { job }
}
