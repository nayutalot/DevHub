/**
 * importPipeline.ts — ContestPin 两阶段识别管线（CP3b 批次，任务书 §2.3，
 * docs/22 §5 两阶段状态机 + 缓存/取消/来源映射/结构化草稿契约）。
 *
 * - electron-free 纯 Node；识别调用一律经 openaiClient.chatCompletion（测试注入
 *   fake transport，**零真实网络**）；真实出站只发生在生产 renderer 触发。
 * - **状态机（008 stage 九值）**：imported→preprocessed→vision_done→text_done→
 *   validated→draft→confirmed；failed/cancelled 从任一阶段可达。importCreate
 *   每份材料一行任务，异步推进（不持 DB 长事务，逐阶段短 UPDATE + progress）。
 * - **每阶段独立重试**：importRetry {jobId, fromStage: vision|text|validate}
 *   重跑该阶段及以后（vision 清指纹重跑视觉；text 保留视觉结果；validate 只重
 *   跑本地程序化校验，零 LLM 调用）。multimodal 不支持 text 阶段。
 * - **缓存失效**：vision_fingerprint = `<材料sha256>@<sha256(baseUrl+model+页参
 *   数)>`——行内既存一致且 result.vision 可复用 → 跳过视觉（材料或视觉配置/页
 *   参数任一变化即失效）；同指纹他行已有视觉结果 → 跨行复用（reusedFromJobId）。
 * - **取消与晚到结果**：importCancel 置 stage='cancelled' + AbortController.abort；
 *   每次出站 await 之后检查行 stage——已 cancelled 则抛 ImportCancelledError，
 *   结果**绝不落库**（smoke 锚定用例）。中途失败→failed + error_json 结构化。
 * - **不编造/不提升精度**（docs/22 §2.2）：链接字段仅当带 provenance 才保留；
 *   节点精度以原文文本形态为权威——模型标 'exact' 而原文仅日期 → 降级 'date' +
 *   flag precision_escalation_rejected；时刻不可解析 → 'tbd' + flag；year 缺失
 *   置 null。模糊/冲突打 flags（{field,reason,excerpt}）展示待核对，绝不自动丢弃。
 * - **草稿→确认两段式**：draftConfirm 缺省回相似比赛检测（同 name 或 name+year
 *   近似）+ 规范化草稿；confirmed 经 contestService.createContest/
 *   createImportedNode 落库（source='imported'），mergeIntoContestId 只追加节点
 *   **不静默覆盖**既有字段。draftDiscard 两段式删任务行（材料保留）。
 */

import { createHash } from 'node:crypto'
import { getDatabase } from '../../db/index.ts'
import { logger } from '../../core/logger.ts'
import { getSetting } from '../settingsService.ts'
import { ServiceError, nowSec, dbVal } from '../internal.ts'
import { chatCompletion, type ChatContentPart, type ChatFailure, type ChatMessage } from './openaiClient.ts'
import { resolveConfigForCall } from './recognitionConfigService.ts'
import {
  extractPdfContent,
  isPageRenderAvailable,
  prepareImageDataUrl,
  renderPdfPageToJpegDataUrl,
  sniffImageMime,
} from './pdfService.ts'
import { readMaterialStoredFile, resolveMaterialLimits } from './materialService.ts'
import { createContest, createImportedNode, getContest } from './contestService.ts'
import { CONTEST_NODE_KINDS, CONTEST_NODE_PRECISIONS } from './contestService.ts'
import { validateNodePrecisionState } from './contestRules.ts'
import type {
  ContestImportCancelResult,
  ContestImportCreateParams,
  ContestImportCreatePayload,
  ContestImportCreateResult,
  ContestImportDraftConfirmPayload,
  ContestImportDraftConfirmResult,
  ContestImportDraftConfirmStart,
  ContestImportDraftDiscardPayload,
  ContestImportDraftDiscardResult,
  ContestImportDraftDiscardStart,
  ContestImportDraftListResult,
  ContestImportJobView,
  ContestImportMode,
  ContestImportRetryFromStage,
  ContestImportRetryResult,
  ContestImportStage,
  ContestImportStatusResult,
  ContestMaterialView,
  ContestSimilarItem,
  ContestStatus,
  ContestView,
  ImportContestDraft,
  ImportDraftView,
  ImportFlag,
  ImportJobError,
  ImportJobResultView,
  ImportLinkDraft,
  ImportNodeDraft,
  ImportProvenance,
  ImportVisionPage,
} from '../../../shared/types.ts'

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const TERMINAL_STAGES: readonly ContestImportStage[] = ['confirmed', 'failed', 'cancelled']

/** 单页文本在 result_json / prompt 中的截断上限（材料级超长防护，截断记 flag）。 */
const PAGE_TEXT_MAX = 20000

function stageRank(stage: ContestImportStage): number {
  const order: ContestImportStage[] = ['imported', 'preprocessed', 'vision_done', 'text_done', 'validated', 'draft', 'confirmed']
  const idx = order.indexOf(stage)
  return idx
}

/** 非法/过期 JSON 一律 null（脏数据不上抛）。 */
function parseJsonObject(raw: string | null): Record<string, unknown> | null {
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

function parseResultView(row: { result_json: string | null }): ImportJobResultView | null {
  const parsed = parseJsonObject(row.result_json)
  return parsed === null ? null : (parsed as unknown as ImportJobResultView)
}

function parseErrorView(row: { error_json: string | null }): ImportJobError | null {
  const parsed = parseJsonObject(row.error_json)
  if (parsed === null || typeof parsed.kind !== 'string' || typeof parsed.message !== 'string') return null
  return { kind: parsed.kind, message: parsed.message }
}

// ---------------------------------------------------------------------------
// 行读写
// ---------------------------------------------------------------------------

interface JobRow {
  id: number
  contest_id: number | null
  material_id: number | null
  mode: string
  stage: string
  vision_config_id: number | null
  text_config_id: number | null
  vision_fingerprint: string | null
  params_json: string | null
  result_json: string | null
  error_json: string | null
  progress: number | null
  created_at: number
  updated_at: number
}

function getJobRow(jobId: number): JobRow {
  const row = getDatabase().prepare('SELECT * FROM contest_import_jobs WHERE id = ?').get(jobId) as unknown as JobRow | undefined
  if (row === undefined) {
    throw new ServiceError('NOT_FOUND', `import job ${jobId} not found`)
  }
  return row
}

interface MaterialRefRow {
  id: number
  sha256: string
  original_name: string
  kind: string
}

function materialRef(materialId: number | null): MaterialRefRow | null {
  if (materialId === null) return null
  const row = getDatabase()
    .prepare('SELECT id, sha256, original_name, kind FROM contest_materials WHERE id = ?')
    .get(materialId) as unknown as MaterialRefRow | undefined
  return row ?? null
}

function toJobView(row: JobRow): ContestImportJobView {
  const material = materialRef(row.material_id)
  const materialView: ContestMaterialView | null =
    material === null
      ? null
      : {
          id: material.id,
          sha256: material.sha256,
          originalName: material.original_name,
          storedPath: '',
          sizeBytes: null,
          pages: null,
          kind: material.kind as ContestMaterialView['kind'],
          importedAt: 0,
        }
  return {
    id: Number(row.id),
    contestId: row.contest_id === null ? null : Number(row.contest_id),
    material: materialView,
    mode: row.mode as ContestImportMode,
    stage: row.stage as ContestImportStage,
    visionConfigId: row.vision_config_id === null ? null : Number(row.vision_config_id),
    textConfigId: row.text_config_id === null ? null : Number(row.text_config_id),
    visionFingerprint: row.vision_fingerprint,
    params: parseJsonObject(row.params_json),
    result: parseResultView(row),
    error: parseErrorView(row),
    progress: row.progress === null ? null : Number(row.progress),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

interface JobPatch {
  stage?: ContestImportStage
  resultJson?: object | null
  errorJson?: ImportJobError | null
  progress?: number | null
  visionFingerprint?: string | null
  contestId?: number | null
}

/**
 * 逐阶段短 UPDATE（不持事务）；result_json 由调用方给全量对象。
 * **取消守卫**：除 cancelImport 自身置 'cancelled' 外，一切写入都带
 * `stage <> 'cancelled'` 守卫——取消竞态下在途阶段的回写绝不覆盖 cancelled
 * 终态（晚到结果丢弃语义的落库侧兜底，配合 throwIfCancelled 出站侧检查）。
 */
function patchJob(jobId: number, patch: JobPatch): void {
  const sets: string[] = []
  const params: (string | number | null)[] = []
  if (patch.stage !== undefined) {
    sets.push('stage = ?')
    params.push(patch.stage)
  }
  if (patch.resultJson !== undefined) {
    sets.push('result_json = ?')
    params.push(patch.resultJson === null ? null : JSON.stringify(patch.resultJson))
  }
  if (patch.errorJson !== undefined) {
    sets.push('error_json = ?')
    params.push(patch.errorJson === null ? null : JSON.stringify(patch.errorJson))
  }
  if (patch.progress !== undefined) {
    sets.push('progress = ?')
    params.push(patch.progress)
  }
  if (patch.visionFingerprint !== undefined) {
    sets.push('vision_fingerprint = ?')
    params.push(patch.visionFingerprint)
  }
  if (patch.contestId !== undefined) {
    sets.push('contest_id = ?')
    params.push(patch.contestId)
  }
  if (sets.length === 0) return
  sets.push('updated_at = ?')
  params.push(nowSec())
  const guard = patch.stage === 'cancelled' ? '' : " AND stage <> 'cancelled'"
  getDatabase()
    .prepare(`UPDATE contest_import_jobs SET ${sets.join(', ')} WHERE id = ?${guard}`)
    .run(...params, jobId)
}

// ---------------------------------------------------------------------------
// 运行中任务登记（取消句柄 + idle 等待）
// ---------------------------------------------------------------------------

const activeControllers = new Map<number, AbortController>()
const inflight = new Map<number, Promise<void>>()

function isJobRunning(jobId: number): boolean {
  return inflight.has(jobId)
}

/** smoke 测试钩子：等待全部在途任务落定（超时抛错，防挂死）。 */
export async function waitForJobsIdle(timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (inflight.size > 0) {
    if (Date.now() > deadline) {
      throw new Error(`waitForJobsIdle timed out with ${inflight.size} inflight jobs`)
    }
    await Promise.race([...inflight.values()])
  }
}

// ---------------------------------------------------------------------------
// LLM 输出 JSON 解析（宽松提取 + 严格形状归一）
// ---------------------------------------------------------------------------

/** 从模型 content 中提取 JSON：直接 parse → ```json 围栏 → 首个 { 到末个 }。 */
function extractJsonLoose(content: string): unknown {
  const trimmed = content.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    // 继续宽松路径
  }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence !== null) {
    try {
      return JSON.parse(fence[1].trim())
    } catch {
      // 继续首尾大括号路径
    }
  }
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start !== -1 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1)) // 形状非法 → 上抛给 BAD_RESPONSE
  }
  throw new SyntaxError('no JSON object found in model content')
}

const NODE_KIND_SET = new Set<string>(CONTEST_NODE_KINDS)
const PRECISION_SET = new Set<string>(CONTEST_NODE_PRECISIONS)

function normalizeProvenance(raw: unknown): ImportProvenance | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const rec = raw as Record<string, unknown>
  if (typeof rec.materialId !== 'number' || !Number.isSafeInteger(rec.materialId) || rec.materialId < 1) return undefined
  if (typeof rec.page !== 'number' || !Number.isSafeInteger(rec.page) || rec.page < 1) return undefined
  if (typeof rec.excerpt !== 'string' || rec.excerpt.trim().length === 0) return undefined
  return { materialId: rec.materialId, page: rec.page, excerpt: rec.excerpt.trim().slice(0, 400) }
}

function normalizeLinkDraft(raw: unknown): ImportLinkDraft | undefined {
  if (typeof raw === 'string') {
    // 容错：模型直接给字符串 URL（无 provenance → 校验阶段剔除+flag）
    const url = raw.trim()
    return url.length > 0 ? { url } : undefined
  }
  if (typeof raw !== 'object' || raw === null) return undefined
  const rec = raw as Record<string, unknown>
  if (typeof rec.url !== 'string' || rec.url.trim().length === 0) return undefined
  return { url: rec.url.trim(), ...(normalizeProvenance(rec.provenance) !== undefined ? { provenance: normalizeProvenance(rec.provenance) } : {}) }
}

function normalizeNodeDraft(raw: unknown): ImportNodeDraft | null {
  if (typeof raw !== 'object' || raw === null) return null
  const rec = raw as Record<string, unknown>
  const kind = typeof rec.kind === 'string' && NODE_KIND_SET.has(rec.kind) ? rec.kind : 'custom'
  const label = typeof rec.label === 'string' && rec.label.trim().length > 0 ? rec.label.trim().slice(0, 200) : kind
  const precision = typeof rec.precision === 'string' && PRECISION_SET.has(rec.precision) ? rec.precision : 'tbd'
  const node: ImportNodeDraft = {
    kind: kind as ImportNodeDraft['kind'],
    label,
    precision: precision as ImportNodeDraft['precision'],
  }
  if (typeof rec.startAtText === 'string' && rec.startAtText.trim().length > 0) node.startAtText = rec.startAtText.trim().slice(0, 100)
  if (typeof rec.endAtText === 'string' && rec.endAtText.trim().length > 0) node.endAtText = rec.endAtText.trim().slice(0, 100)
  if (typeof rec.rawText === 'string' && rec.rawText.trim().length > 0) node.rawText = rec.rawText.trim().slice(0, 500)
  const provenance = normalizeProvenance(rec.provenance)
  if (provenance !== undefined) node.provenance = provenance
  return node
}

function normalizeContestDraft(raw: unknown): ImportContestDraft | null {
  if (typeof raw !== 'object' || raw === null) return null
  const rec = raw as Record<string, unknown>
  if (typeof rec.name !== 'string' || rec.name.trim().length === 0) return null
  let year: number | null = null
  if (typeof rec.year === 'number' && Number.isSafeInteger(rec.year)) year = rec.year
  else if (typeof rec.year === 'string' && /^\d{4}$/.test(rec.year.trim())) year = Number(rec.year.trim())
  const draft: ImportContestDraft = { name: rec.name.trim().slice(0, 200), year, nodes: [] }
  if (typeof rec.edition === 'string' && rec.edition.trim().length > 0) draft.edition = rec.edition.trim().slice(0, 100)
  if (typeof rec.organizer === 'string' && rec.organizer.trim().length > 0) draft.organizer = rec.organizer.trim().slice(0, 200)
  const officialSite = normalizeLinkDraft(rec.officialSite)
  if (officialSite !== undefined) draft.officialSite = officialSite
  const signupUrl = normalizeLinkDraft(rec.signupUrl)
  if (signupUrl !== undefined) draft.signupUrl = signupUrl
  const submitUrl = normalizeLinkDraft(rec.submitUrl)
  if (submitUrl !== undefined) draft.submitUrl = submitUrl
  if (Array.isArray(rec.nodes)) {
    for (const rawNode of rec.nodes) {
      const node = normalizeNodeDraft(rawNode)
      if (node !== null) draft.nodes.push(node)
    }
  }
  return draft
}

/**
 * 模型输出 → 草稿（形状不合法上抛 SyntaxError，由调用方折叠 BAD_RESPONSE）。
 */
export function parseDraftJson(content: string): ImportDraftView {
  const parsed = extractJsonLoose(content)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SyntaxError('model JSON top-level is not an object')
  }
  const rec = parsed as Record<string, unknown>
  if (!Array.isArray(rec.contests)) {
    throw new SyntaxError('model JSON missing contests array')
  }
  const contests: ImportContestDraft[] = []
  for (const raw of rec.contests) {
    const contest = normalizeContestDraft(raw)
    if (contest !== null) contests.push(contest)
  }
  return { contests, flags: [] }
}

// ---------------------------------------------------------------------------
// 时刻文本解析（docs/22 §2.2 精度语义；本地时区）
// ---------------------------------------------------------------------------

export interface ParsedTimeText {
  precision: 'exact' | 'date' | 'month'
  /** 本地时区 unix 秒（exact=解析到分/秒；date=当日 00:00；month=当月 1 日 00:00）。 */
  at: number
}

/**
 * ISO 风格时刻文本解析：'YYYY-MM-DD HH:mm(:ss)' → exact；'YYYY-MM-DD' → date；
 * 'YYYY-MM' → month；'待定'/'TBD' → tbd（null）；其余不可解析 → null。
 * 月份/日期越界直接判不可解析（Date 宽松进位会伪造时刻，禁止）。
 */
export function parseTimeText(text: string): ParsedTimeText | 'tbd' | null {
  const trimmed = text.trim()
  if (/^(待定|tbd)$/i.test(trimmed)) return 'tbd'
  let m = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/)
  if (m !== null) {
    const [, y, mo, d, h, mi, s] = m
    if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31 || Number(h) > 23 || Number(mi) > 59 || (s !== undefined && Number(s) > 59)) return null
    const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), s === undefined ? 0 : Number(s))
    if (Number.isNaN(date.getTime())) return null
    return { precision: 'exact', at: Math.floor(date.getTime() / 1000) }
  }
  m = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (m !== null) {
    const [, y, mo, d] = m
    if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31) return null
    const date = new Date(Number(y), Number(mo) - 1, Number(d), 0, 0, 0)
    if (Number.isNaN(date.getTime())) return null
    return { precision: 'date', at: Math.floor(date.getTime() / 1000) }
  }
  m = trimmed.match(/^(\d{4})-(\d{2})$/)
  if (m !== null) {
    const [, y, mo] = m
    if (Number(mo) < 1 || Number(mo) > 12) return null
    const date = new Date(Number(y), Number(mo) - 1, 1, 0, 0, 0)
    if (Number.isNaN(date.getTime())) return null
    return { precision: 'month', at: Math.floor(date.getTime() / 1000) }
  }
  return null
}

// ---------------------------------------------------------------------------
// 草稿程序化校验（任务书 §2.3 #9：规则与 contestService 同源，模糊打 flags 不丢弃）
// ---------------------------------------------------------------------------

function validateDraftContests(draft: ImportDraftView): ImportDraftView {
  const flags: ImportFlag[] = []
  const contests: ImportContestDraft[] = []
  for (const contest of draft.contests) {
    if (contest.name.trim().length === 0) {
      flags.push({ field: 'contest.name', reason: '比赛名为空，该草稿无法落库（需人工补名称）', excerpt: JSON.stringify(contest).slice(0, 120) })
      continue
    }
    let year = contest.year
    if (year !== null && (!Number.isSafeInteger(year) || year < 1990 || year > 2100)) {
      flags.push({ field: 'contest.year', reason: `年份越界（${year}），已置空待人工确认`, excerpt: contest.name })
      year = null
    }
    const urls: { key: 'officialSite' | 'signupUrl' | 'submitUrl'; link: ImportLinkDraft }[] = []
    for (const key of ['officialSite', 'signupUrl', 'submitUrl'] as const) {
      const link = contest[key]
      if (link === undefined) continue
      if (!/^https?:\/\/\S+$/i.test(link.url)) {
        flags.push({ field: `contest.${key}`, reason: `URL 形状非法（仅接受 http/https）：${link.url.slice(0, 120)}`, excerpt: contest.name })
        continue
      }
      if (link.provenance === undefined) {
        // 来源映射红线：无 provenance 的链接视为无法溯源，剔除（不落库不编造）
        flags.push({ field: `contest.${key}`, reason: '链接缺少来源映射（materialId/page/excerpt），已剔除待人工补录', excerpt: link.url.slice(0, 160) })
        continue
      }
      urls.push({ key, link })
    }
    const nodes: ImportNodeDraft[] = []
    for (const node of contest.nodes) {
      nodes.push(validateDraftNode(node, flags, contest.name))
    }
    // 年份缺失提示（不编造）：任一节点已解析时刻携带年份 → flag 提示人工补
    if (year === null) {
      const yearBearingNode = nodes.find((n) => n.startAt !== null && n.startAt !== undefined)
      if (yearBearingNode !== undefined && typeof yearBearingNode.startAt === 'number') {
        const y = new Date(yearBearingNode.startAt * 1000).getFullYear()
        flags.push({ field: 'contest.year', reason: `节点时刻含年份 ${y} 但材料未明确比赛年份，year 保持空待人工确认`, excerpt: contest.name })
      }
    }
    contests.push({
      ...contest,
      year,
      ...(Object.fromEntries(urls.map((u) => [u.key, u.link])) as Partial<Pick<ImportContestDraft, 'officialSite' | 'signupUrl' | 'submitUrl'>>),
      nodes,
    })
  }
  return { contests, flags }
}

function validateDraftNode(node: ImportNodeDraft, flags: ImportFlag[], contestName: string): ImportNodeDraft {
  const where = `contest「${contestName}」节点「${node.label}」`
  const out: ImportNodeDraft = { ...node }
  // provenance 完整性（节点级：缺失仅 flag，不丢弃——时间/名称仍可人工核对）
  if (out.provenance === undefined) {
    flags.push({ field: `node.${out.label}`, reason: '节点缺少来源映射（materialId/page/excerpt），请人工核对', excerpt: out.rawText ?? out.startAtText ?? '' })
  }
  // 文本形态为权威：解析 startAtText/endAtText → unix 秒 + 精度
  let derived: { precision: ImportNodeDraft['precision']; startAt: number | null; endAt: number | null } = {
    precision: 'tbd',
    startAt: null,
    endAt: null,
  }
  const startParsed = out.startAtText !== undefined ? parseTimeText(out.startAtText) : null
  const endParsed = out.endAtText !== undefined ? parseTimeText(out.endAtText) : null
  if (startParsed === 'tbd') {
    derived.precision = 'tbd'
  } else if (startParsed !== null) {
    derived.precision = startParsed.precision
    derived.startAt = startParsed.at
  }
  if (endParsed !== null && endParsed !== 'tbd') {
    derived.endAt = endParsed.at
    if (derived.precision === 'tbd' && startParsed === null) derived.precision = endParsed.precision
  }
  // 精度冲突/提升拒绝：模型标注 ≠ 文本形态 → 以文本为准 + flag（date→exact 编造在此拒绝）
  if (derived.precision !== node.precision) {
    if (node.precision === 'exact' && (derived.precision === 'date' || derived.precision === 'month')) {
      flags.push({
        field: `node.${out.label}.precision`,
        reason: `精度提升被拒绝：模型标注 exact 但原文仅给到${derived.precision === 'date' ? '日期' : '年月'}，按原文降级为 ${derived.precision}（docs/22 §2.2）`,
        excerpt: out.startAtText ?? out.rawText ?? '',
      })
    } else {
      flags.push({
        field: `node.${out.label}.precision`,
        reason: `精度标注与原文文本形态不一致（模型 ${node.precision} / 文本 ${derived.precision}），按文本取 ${derived.precision}`,
        excerpt: out.startAtText ?? out.rawText ?? '',
      })
    }
  }
  // 时刻不可解析（模型给了 precision 但文本无法解析）→ tbd 不编造
  if (derived.startAt === null && derived.endAt === null && node.precision !== 'tbd' && node.precision !== undefined) {
    if (out.startAtText === undefined && out.rawText === undefined) {
      flags.push({ field: `node.${out.label}.startAt`, reason: `节点标注精度 ${node.precision} 但缺少任何时刻文本，已按 tbd 处理（不编造）`, excerpt: contestName })
    } else if (out.startAtText !== undefined && parseTimeText(out.startAtText) === null) {
      flags.push({ field: `node.${out.label}.startAt`, reason: `时刻文本无法解析：${out.startAtText.slice(0, 60)}，已按 tbd 处理（保留原文待人工修正）`, excerpt: out.rawText ?? out.startAtText })
    }
  }
  out.precision = derived.precision
  out.startAt = derived.startAt
  out.endAt = derived.endAt
  // endAt < startAt → 冲突 flag，endAt 置空（不静默丢弃节点）
  if (out.startAt !== null && out.endAt !== null && out.endAt < out.startAt) {
    flags.push({ field: `node.${out.label}.endAt`, reason: '结束时刻早于开始时刻，endAt 已置空待人工确认', excerpt: out.endAtText ?? '' })
    out.endAt = null
  }
  // 落库前最后一致性防线（与 contestService 同一规则）
  try {
    validateNodePrecisionState(out.precision, out.startAt, out.endAt, where)
  } catch {
    // 理论不可达（推导已保证 tbd→null、其余→startAt 非空）；保守置 tbd
    out.precision = 'tbd'
    out.startAt = null
    out.endAt = null
  }
  return out
}

// ---------------------------------------------------------------------------
// prompts（契约文本常量；无任何用户凭据）
// ---------------------------------------------------------------------------

const VISION_OCR_SYSTEM = '你是严谨的 OCR 转录助手。只转录图片中实际可见的文字、表格、日期与网址，保持原文措辞，不推断不存在的内容，不添加任何评论或解释。'

const JSON_CONTRACT_PROMPT = [
  '你是比赛赛程信息整理助手。输入为比赛通知材料的逐页文字（OCR 或本地提取）。请输出严格的 JSON（禁止 markdown 代码块、禁止任何解释文字），形状：',
  '{"contests":[{"name":string,"year":number|null,"edition"?:string,"organizer"?:string,',
  '"officialSite"?:{"url":string,"provenance":{"materialId":number,"page":number,"excerpt":string}},',
  '"signupUrl"?:同上,"submitUrl"?:同上,',
  '"nodes":[{"kind":"signup_start"|"signup_deadline"|"payment_deadline"|"contest_start"|"contest_end"|"submit_deadline"|"custom",',
  '"label":string,"precision":"exact"|"date"|"month"|"tbd","startAtText"?:string,"endAtText"?:string,"rawText"?:string,',
  '"provenance":{"materialId":number,"page":number,"excerpt":string}}]}]}',
  '规则：',
  '1. 只允许使用材料原文实际出现的信息；缺失字段留空或省略，绝不编造年份/时刻/官网/链接。',
  '2. 链接字段仅当 URL 出现在原文文字或 PDF 超链接中才输出，且必须携带 provenance（materialId/page/excerpt 引原文短摘录）。',
  '3. precision：原文给到具体时刻→exact；仅日期→date；仅年月→month；原文明确说待定→tbd。startAtText 用 ISO 形式：YYYY-MM-DD HH:mm / YYYY-MM-DD / YYYY-MM；待定不写 startAtText。',
  '4. 缺少年份 → year=null；同类节点多截止（如校内/全国）拆成多个节点并用 label 区分。',
].join('\n')

// ---------------------------------------------------------------------------
// fingerprint
// ---------------------------------------------------------------------------

/**
 * vision_fingerprint = `<材料sha256>@<sha256(baseUrl+model+页参数)>`：
 * 材料或视觉配置/页参数任一变化即失效（不含任何凭据值，docs/22 §2.1）。
 */
export function computeVisionFingerprint(
  materialSha256: string,
  baseUrl: string,
  model: string,
  pageParams: { pageFrom: number | null; pageTo: number | null; skipTextPages: boolean },
): string {
  const payload = JSON.stringify({ baseUrl, model, ...pageParams })
  return `${materialSha256}@${createHash('sha256').update(payload).digest('hex')}`
}

// ---------------------------------------------------------------------------
// createImportJobs
// ---------------------------------------------------------------------------

interface ValidatedCreateParams {
  pageFrom: number | null
  pageTo: number | null
  skipTextPages: boolean
  limits: ReturnType<typeof resolveMaterialLimits>
}

function badCreate(detail: string): ServiceError {
  return new ServiceError('BAD_PAYLOAD', `importCreate: ${detail}`)
}

function validateCreateParams(params: ContestImportCreateParams | undefined): ValidatedCreateParams {
  const limits = resolveMaterialLimits(params?.limits)
  let pageFrom: number | null = null
  let pageTo: number | null = null
  if (params?.pageFrom !== undefined) {
    if (typeof params.pageFrom !== 'number' || !Number.isSafeInteger(params.pageFrom) || params.pageFrom < 1) {
      throw badCreate('params.pageFrom must be a positive integer when present')
    }
    pageFrom = params.pageFrom
  }
  if (params?.pageTo !== undefined) {
    if (typeof params.pageTo !== 'number' || !Number.isSafeInteger(params.pageTo) || params.pageTo < 1) {
      throw badCreate('params.pageTo must be a positive integer when present')
    }
    pageTo = params.pageTo
  }
  if (pageFrom !== null && pageTo !== null && pageFrom > pageTo) {
    throw badCreate('params.pageFrom must be <= params.pageTo')
  }
  if (params?.skipTextPages !== undefined && typeof params.skipTextPages !== 'boolean') {
    throw badCreate('params.skipTextPages must be a boolean when present')
  }
  return { pageFrom, pageTo, skipTextPages: params?.skipTextPages === true, limits }
}

function configExists(id: number): boolean {
  return getDatabase().prepare('SELECT 1 FROM contestpin_configs WHERE id = ?').get(id) !== undefined
}

/**
 * contestpin:importCreate：每份材料一行任务（008 表 material_id 单列语义），
 * 建行后异步推进状态机，立即返回 imported 行视图（进度经 importStatus 轮询）。
 */
export async function createImportJobs(payload: ContestImportCreatePayload): Promise<ContestImportCreateResult> {
  if (!Array.isArray(payload.materialIds) || payload.materialIds.length === 0) {
    throw badCreate('materialIds must be a non-empty array')
  }
  for (const id of payload.materialIds) {
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) {
      throw badCreate('materialIds must contain positive integers')
    }
  }
  const materialIds = [...new Set(payload.materialIds)]
  const params = validateCreateParams(payload.params)

  let mode = payload.mode
  if (mode === undefined) {
    const stored = getSetting('contestpin_default_mode')
    mode = stored === 'multimodal' ? 'multimodal' : 'two_stage'
  }
  if (mode !== 'two_stage' && mode !== 'multimodal') {
    throw badCreate("mode must be 'two_stage' | 'multimodal'（agent/manual_pack 归 CP5）")
  }
  if (payload.params?.visionConfigId !== undefined && configExists(payload.params.visionConfigId) === false) {
    throw new ServiceError('NOT_FOUND', `vision config ${payload.params.visionConfigId} not found`)
  }
  if (payload.params?.textConfigId !== undefined && configExists(payload.params.textConfigId) === false) {
    throw new ServiceError('NOT_FOUND', `text config ${payload.params.textConfigId} not found`)
  }

  const db = getDatabase()
  const now = nowSec()
  const views: ContestImportJobView[] = []
  for (const materialId of materialIds) {
    const material = db
      .prepare('SELECT id, kind FROM contest_materials WHERE id = ?')
      .get(materialId) as unknown as { id: number; kind: string } | undefined
    if (material === undefined) {
      throw new ServiceError('NOT_FOUND', `contest material ${materialId} not found`)
    }
    if (material.kind !== 'pdf' && material.kind !== 'image') {
      throw badCreate(`material ${materialId} kind='${material.kind}' 不支持识别（仅 pdf/image）`)
    }
    const result = db
      .prepare(
        'INSERT INTO contest_import_jobs (contest_id, material_id, mode, stage, vision_config_id, text_config_id, params_json, progress, created_at, updated_at) VALUES (NULL, ?, ?, ?, ?, ?, ?, 0, ?, ?)',
      )
      .run(
        materialId,
        mode,
        'imported',
        dbVal(payload.params?.visionConfigId ?? null),
        dbVal(mode === 'two_stage' ? (payload.params?.textConfigId ?? null) : null),
        JSON.stringify({
          ...(params.pageFrom !== null ? { pageFrom: params.pageFrom } : {}),
          ...(params.pageTo !== null ? { pageTo: params.pageTo } : {}),
          skipTextPages: params.skipTextPages,
          limits: params.limits,
        }),
        now,
        now,
      )
    views.push(toJobView(getJobRow(Number(result.lastInsertRowid))))
  }
  logger.info(`contestpin import jobs created: ${views.map((v) => v.id).join(',')} mode=${mode}`)
  for (const view of views) {
    kickJob(view.id)
  }
  return { jobs: views }
}

function kickJob(jobId: number): void {
  if (inflight.has(jobId)) return
  const controller = new AbortController()
  activeControllers.set(jobId, controller)
  const promise = runJob(jobId, controller).finally(() => {
    inflight.delete(jobId)
    activeControllers.delete(jobId)
  })
  inflight.set(jobId, promise)
}

// ---------------------------------------------------------------------------
// 状态机推进
// ---------------------------------------------------------------------------

/** 取消晚到检查：每次出站 await 之后调用——已 cancelled 的任务结果绝不落库。 */
function throwIfCancelled(jobId: number): void {
  const stage = getJobRow(jobId).stage
  if (stage === 'cancelled') {
    throw new ImportCancelledError(jobId)
  }
}

class ImportCancelledError extends Error {
  constructor(jobId: number) {
    super(`import job ${jobId} cancelled`)
    this.name = 'ImportCancelledError'
  }
}

class ChatFailureError extends Error {
  readonly failure: ChatFailure
  constructor(failure: ChatFailure) {
    super(failure.message)
    this.name = 'ChatFailureError'
    this.failure = failure
  }
}

async function runJob(jobId: number, controller: AbortController): Promise<void> {
  try {
    await ensurePreprocessed(jobId)
    throwIfCancelled(jobId)
    const row = getJobRow(jobId)
    if (row.mode === 'two_stage') {
      await ensureVision(jobId, controller.signal)
      throwIfCancelled(jobId)
      await ensureTextStage(jobId, controller.signal)
    } else {
      await ensureMultimodal(jobId, controller.signal)
    }
    throwIfCancelled(jobId)
    await ensureValidatedDraft(jobId)
  } catch (err) {
    handleJobFailure(jobId, err)
  }
}

function handleJobFailure(jobId: number, err: unknown): void {
  const row = getJobRow(jobId)
  if (err instanceof ImportCancelledError || row.stage === 'cancelled') {
    // 晚到失败/结果在取消之后抵达：丢弃，不覆盖 cancelled 终态
    logger.info(`contestpin import job ${jobId}: late result discarded (cancelled)`)
    return
  }
  let error: ImportJobError
  if (err instanceof ChatFailureError) {
    error = { kind: err.failure.kind, message: err.failure.message }
  } else if (err instanceof ServiceError) {
    error = { kind: err.code, message: err.message }
  } else {
    logger.error(`contestpin import job ${jobId} unexpected failure: ${err instanceof Error ? err.stack : String(err)}`)
    error = { kind: 'INTERNAL', message: '识别管线内部错误（详见主进程日志）' }
  }
  patchJob(jobId, { stage: 'failed', errorJson: error })
  logger.warn(`contestpin import job ${jobId} failed: ${error.kind}: ${error.message}`)
}

interface PreprocessedRow {
  row: JobRow
  material: MaterialRefRow
  result: ImportJobResultView
  params: { pageFrom: number | null; pageTo: number | null; skipTextPages: boolean; limits?: unknown }
}

async function ensurePreprocessed(jobId: number): Promise<PreprocessedRow> {
  let row = getJobRow(jobId)
  const result = parseResultView(row) ?? {}
  const params = parseJsonObject(row.params_json) ?? {}
  const material = materialRef(row.material_id)
  if (material === null) {
    throw new ServiceError('DB_ERROR', `import job ${jobId} has no material`)
  }
  if (result.preprocessing !== undefined && stageRank(row.stage as ContestImportStage) >= stageRank('preprocessed')) {
    return { row, material, result, params: params as PreprocessedRow['params'] }
  }
  const limits = resolveMaterialLimits((params.limits ?? undefined) as Parameters<typeof resolveMaterialLimits>[0])
  if (material.kind === 'pdf') {
    const { data } = await readMaterialStoredFile(material.id)
    const extracted = await extractPdfContent(data, { maxPages: limits.maxPdfPages })
    // 材料行 pages 延后填充（任务书 §2.1 #1）
    getDatabase().prepare('UPDATE contest_materials SET pages = ? WHERE id = ?').run(extracted.pageCount, material.id)
    const renderAvailable = await isPageRenderAvailable()
    result.preprocessing = {
      pageCount: extracted.pageCount,
      truncatedByLimit: extracted.truncatedByLimit,
      renderAvailable,
      links: extracted.pages.flatMap((p) => p.links.map((l) => ({ uri: l.uri, page: l.page }))),
      pages: extracted.pages.map((p) => ({ page: p.page, text: p.text.slice(0, PAGE_TEXT_MAX) })),
    }
    if (extracted.truncatedByLimit) {
      logger.warn(`contestpin material ${material.id}: PDF pages truncated to ${limits.maxPdfPages}/${extracted.pageCount}`)
    }
  } else {
    result.preprocessing = { pageCount: null, truncatedByLimit: false, renderAvailable: await isPageRenderAvailable(), links: [], pages: [] }
  }
  patchJob(jobId, { resultJson: result as unknown as Record<string, unknown>, stage: 'preprocessed', progress: 10, errorJson: null })
  row = getJobRow(jobId)
  return { row, material, result, params: params as PreprocessedRow['params'] }
}

async function resolveVisionConfig(jobId: number): Promise<Awaited<ReturnType<typeof resolveConfigForCall>>> {
  const row = getJobRow(jobId)
  if (row.vision_config_id === null) {
    throw new ServiceError('CONFIG_MISSING', `导入任务 ${jobId} 未指定视觉识别配置（multimodal 模式即多模态配置），请在导入参数中选择`)
  }
  return resolveConfigForCall(Number(row.vision_config_id))
}

async function resolveTextConfig(jobId: number): Promise<Awaited<ReturnType<typeof resolveConfigForCall>>> {
  const row = getJobRow(jobId)
  if (row.text_config_id === null) {
    throw new ServiceError('CONFIG_MISSING', `导入任务 ${jobId} 未指定文本整理配置，请在导入参数中选择`)
  }
  return resolveConfigForCall(Number(row.text_config_id))
}

/** 页参数（指纹组成 + 视觉页选择）。 */
function pageParamsOf(params: PreprocessedRow['params']): { pageFrom: number | null; pageTo: number | null; skipTextPages: boolean } {
  return {
    pageFrom: typeof params.pageFrom === 'number' ? params.pageFrom : null,
    pageTo: typeof params.pageTo === 'number' ? params.pageTo : null,
    skipTextPages: params.skipTextPages === true,
  }
}

/** 视觉阶段页工作清单（pdf 按页范围 + skipTextPages 过滤；image 单页）。 */
function selectVisionPages(pre: PreprocessedRow): { page: number; localText: string }[] {
  const pre1 = pre.result.preprocessing
  if (pre1 === undefined) return []
  if (pre.material.kind === 'image') return [{ page: 1, localText: '' }]
  const pageCount = pre1.pageCount ?? 0
  const from = Math.max(1, pre.params.pageFrom ?? 1)
  const to = Math.min(pageCount, pre.params.pageTo ?? pageCount)
  const selected: { page: number; localText: string }[] = []
  for (let page = from; page <= to; page++) {
    const local = pre1.pages.find((p) => p.page === page)
    const text = local?.text ?? ''
    if (pre.params.skipTextPages === true && text.trim().length > 0) continue // 用户显式跳过文字页
    selected.push({ page, localText: text })
  }
  return selected
}

async function ensureVision(jobId: number, signal: AbortSignal): Promise<void> {
  const pre = await ensurePreprocessed(jobId)
  const row = pre.row
  const existingResult = parseResultView(row)
  if (existingResult?.vision !== undefined && stageRank(row.stage as ContestImportStage) >= stageRank('vision_done')) {
    return // 视觉结果已在（text 阶段重试路径）
  }
  const config = await resolveVisionConfig(jobId)
  const pageParams = pageParamsOf(pre.params)
  const fingerprint = computeVisionFingerprint(pre.material.sha256, config.baseUrl, config.model, pageParams)
  // 行内缓存：指纹一致且既有 vision 结果可复用 → 跳过视觉
  if (row.vision_fingerprint === fingerprint && existingResult?.vision !== undefined) {
    patchJob(jobId, { stage: 'vision_done', visionFingerprint: fingerprint })
    return
  }
  // 跨行复用：同指纹的他行 vision 结果直接复用（材料+配置+页参数相同不重跑）
  const cachedRows = getDatabase()
    .prepare("SELECT id, result_json FROM contest_import_jobs WHERE vision_fingerprint = ? AND id <> ? ORDER BY id DESC LIMIT 5")
    .all(fingerprint, jobId) as unknown as { id: number; result_json: string | null }[]
  for (const cached of cachedRows) {
    const cachedResult = parseResultView(cached)
    if (cachedResult?.vision !== undefined && Array.isArray(cachedResult.vision.pages) && cachedResult.vision.pages.length > 0) {
      const reused: ImportJobResultView = { ...existingResult, vision: { pages: cachedResult.vision.pages, reusedFromJobId: cached.id } }
      patchJob(jobId, { resultJson: reused as unknown as Record<string, unknown>, stage: 'vision_done', visionFingerprint: fingerprint, progress: 70 })
      logger.info(`contestpin import job ${jobId}: vision cache hit from job ${cached.id}`)
      return
    }
  }

  const pre1 = pre.result.preprocessing
  if (pre1 === undefined) throw new ServiceError('INTERNAL', 'preprocessing missing before vision stage')
  const selected = selectVisionPages(pre)
  if (selected.length === 0) {
    throw new ServiceError('BAD_PAYLOAD', '页范围为空（页范围超出材料页数或全部页被跳过）')
  }

  // 降级面（docs/22 §5）：页转图不可用时，文字 PDF 以本地提取文字直接进文本阶段；
  // 扫描页（无本地文字）→ PAGE_RENDER_UNAVAILABLE 已知限制，不阻塞其余任务。
  const needRender = pre.material.kind === 'pdf'
  if (needRender && pre1.renderAvailable === false) {
    const allHaveText = selected.every((p) => p.localText.trim().length > 0)
    if (!allHaveText) {
      throw new ServiceError('PAGE_RENDER_UNAVAILABLE', '扫描版 PDF 页转图依赖不可用（@napi-rs/canvas 缺失），无法视觉识别；文字 PDF 不受影响')
    }
    const pages: ImportVisionPage[] = selected.map((p) => ({ materialId: pre.material.id, page: p.page, text: p.localText, source: 'local_text' }))
    patchJob(jobId, {
      resultJson: { ...existingResult, vision: { pages } } as unknown as Record<string, unknown>,
      stage: 'vision_done',
      visionFingerprint: fingerprint,
      progress: 70,
    })
    return
  }

  const { data } = await readMaterialStoredFile(pre.material.id)
  const pages: ImportVisionPage[] = []
  for (let i = 0; i < selected.length; i++) {
    throwIfCancelled(jobId)
    const page = selected[i].page
    let dataUrl: string
    let source: ImportVisionPage['source']
    if (pre.material.kind === 'pdf') {
      dataUrl = await renderPdfPageToJpegDataUrl(data, page)
      source = 'render'
    } else {
      const mime = sniffImageMime(data) ?? 'image/png'
      const prepared = await prepareImageDataUrl(data, mime)
      dataUrl = prepared.dataUrl
      source = 'image'
    }
    const messages: ChatMessage[] = [
      { role: 'system', content: VISION_OCR_SYSTEM },
      {
        role: 'user',
        content: [
          { type: 'text', text: `第 ${page} 页。请转录本页全部可见文字内容（含表格、日期与链接文字），保持原有阅读顺序。` },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ]
    const completion = await chatCompletion(config, messages, { signal })
    if (!completion.ok) {
      throw new ChatFailureError(completion.failure)
    }
    throwIfCancelled(jobId) // 晚到结果丢弃检查（取消后绝不落库）
    pages.push({ materialId: pre.material.id, page, text: completion.content.slice(0, PAGE_TEXT_MAX), source })
    patchJob(jobId, { progress: Math.min(70, 10 + Math.round((60 * (i + 1)) / selected.length)) })
  }
  const resultView: ImportJobResultView = { ...existingResult, vision: { pages } }
  patchJob(jobId, {
    resultJson: resultView as unknown as Record<string, unknown>,
    stage: 'vision_done',
    visionFingerprint: fingerprint,
    progress: 70,
    errorJson: null,
  })
}

/** 文本阶段输入（vision 结果 + 本地文本/链接补充）。 */
function buildTextStageUserContent(pre: PreprocessedRow, visionPages: ImportVisionPage[]): string {
  const lines: string[] = [`材料 #${pre.material.id}（${pre.material.original_name}）逐页内容：`]
  for (const page of visionPages) {
    lines.push(`--- [materialId=${page.materialId} 第 ${page.page} 页 | 来源:${page.source}] ---`)
    lines.push(page.text)
  }
  const pre1 = pre.result.preprocessing
  if (pre1 !== undefined && pre1.pages.length > 0) {
    lines.push('--- 本地 PDF 提取文本（补充，可能与 OCR 重复）---')
    for (const page of pre1.pages) {
      if (page.text.trim().length === 0) continue
      lines.push(`[materialId=${pre.material.id} 第 ${page.page} 页] ${page.text.slice(0, 4000)}`)
    }
  }
  if (pre1 !== undefined && pre1.links.length > 0) {
    lines.push('--- 本地 PDF 超链接（注释 URI）---')
    for (const link of pre1.links) {
      lines.push(`[materialId=${pre.material.id} 第 ${link.page} 页] ${link.uri}`)
    }
  }
  return lines.join('\n')
}

async function ensureTextStage(jobId: number, signal: AbortSignal): Promise<void> {
  const pre = await ensurePreprocessed(jobId)
  const row = getJobRow(jobId)
  const result = parseResultView(row) ?? {}
  if (result.draft !== undefined && stageRank(row.stage as ContestImportStage) >= stageRank('text_done')) {
    return
  }
  if (result.vision === undefined) {
    throw new ServiceError('INTERNAL', 'vision result missing before text stage')
  }
  const config = await resolveTextConfig(jobId)
  const messages: ChatMessage[] = [
    { role: 'system', content: JSON_CONTRACT_PROMPT },
    { role: 'user', content: buildTextStageUserContent(pre, result.vision.pages) },
  ]
  const completion = await chatCompletion(config, messages, { signal })
  if (!completion.ok) {
    throw new ChatFailureError(completion.failure)
  }
  throwIfCancelled(jobId)
  let draft: ImportDraftView
  try {
    draft = parseDraftJson(completion.content)
  } catch (err) {
    // 解析失败 → 结构化 BAD_RESPONSE，可单独重试（fromStage='text'）
    throw new ServiceError('BAD_RESPONSE', `识别输出 JSON 解析失败：${err instanceof Error ? err.message : String(err)}；内容摘要：${completion.content.replace(/\s+/g, ' ').slice(0, 200)}`)
  }
  patchJob(jobId, {
    resultJson: { ...result, draft } as unknown as Record<string, unknown>,
    stage: 'text_done',
    progress: 85,
    errorJson: null,
  })
}

/** 多模态一步式：单次 vision 配置调用直接出结构化 JSON（同文本阶段契约）。 */
async function ensureMultimodal(jobId: number, signal: AbortSignal): Promise<void> {
  const pre = await ensurePreprocessed(jobId)
  const row = getJobRow(jobId)
  const existingResult = parseResultView(row) ?? {}
  if (existingResult.draft !== undefined && stageRank(row.stage as ContestImportStage) >= stageRank('text_done')) {
    return
  }
  const config = await resolveVisionConfig(jobId)
  const fingerprint = computeVisionFingerprint(pre.material.sha256, config.baseUrl, config.model, pageParamsOf(pre.params))
  if (row.vision_fingerprint === fingerprint && existingResult.draft !== undefined) {
    patchJob(jobId, { stage: 'text_done', visionFingerprint: fingerprint })
    return
  }
  const pre1 = pre.result.preprocessing
  if (pre1 === undefined) throw new ServiceError('INTERNAL', 'preprocessing missing before multimodal stage')
  const selected = selectVisionPages(pre)
  if (selected.length === 0) {
    throw new ServiceError('BAD_PAYLOAD', '页范围为空（页范围超出材料页数或全部页被跳过）')
  }
  if (pre.material.kind === 'pdf' && pre1.renderAvailable === false) {
    const allHaveText = selected.every((p) => p.localText.trim().length > 0)
    if (!allHaveText) {
      throw new ServiceError('PAGE_RENDER_UNAVAILABLE', '扫描版 PDF 页转图依赖不可用（@napi-rs/canvas 缺失），无法视觉识别；文字 PDF 不受影响')
    }
  }
  const { data } = await readMaterialStoredFile(pre.material.id)
  const content: ChatContentPart[] = [
    { type: 'text', text: `以下是材料（共 ${selected.length} 页）的图像/文字内容。请按系统契约输出结构化 JSON。` },
  ]
  for (const page of selected) {
    throwIfCancelled(jobId)
    if (pre.material.kind === 'pdf') {
      if (pre1.renderAvailable === false) {
        content.push({ type: 'text', text: `[第 ${page.page} 页 本地文字]\n${page.localText.slice(0, 6000)}` })
        continue
      }
      const dataUrl = await renderPdfPageToJpegDataUrl(data, page.page)
      content.push({ type: 'text', text: `第 ${page.page} 页：` })
      content.push({ type: 'image_url', image_url: { url: dataUrl } })
    } else {
      const mime = sniffImageMime(data) ?? 'image/png'
      const prepared = await prepareImageDataUrl(data, mime)
      content.push({ type: 'text', text: '材料图像：' })
      content.push({ type: 'image_url', image_url: { url: prepared.dataUrl } })
    }
  }
  const messages: ChatMessage[] = [
    { role: 'system', content: JSON_CONTRACT_PROMPT },
    { role: 'user', content },
  ]
  const completion = await chatCompletion(config, messages, { signal })
  if (!completion.ok) {
    throw new ChatFailureError(completion.failure)
  }
  throwIfCancelled(jobId)
  let draft: ImportDraftView
  try {
    draft = parseDraftJson(completion.content)
  } catch (err) {
    throw new ServiceError('BAD_RESPONSE', `识别输出 JSON 解析失败：${err instanceof Error ? err.message : String(err)}；内容摘要：${completion.content.replace(/\s+/g, ' ').slice(0, 200)}`)
  }
  const result: ImportJobResultView = { ...existingResult, draft }
  patchJob(jobId, {
    resultJson: result as unknown as Record<string, unknown>,
    stage: 'text_done',
    visionFingerprint: fingerprint,
    progress: 85,
    errorJson: null,
  })
}

/** 校验+草稿落位：validated → draft（程序化规则，零 LLM）。 */
async function ensureValidatedDraft(jobId: number): Promise<void> {
  const row = getJobRow(jobId)
  if (stageRank(row.stage as ContestImportStage) >= stageRank('validated')) return
  const result = parseResultView(row) ?? {}
  if (result.draft === undefined) {
    throw new ServiceError('INTERNAL', 'draft missing before validation stage')
  }
  const validated = validateDraftContests(result.draft)
  patchJob(jobId, { resultJson: { ...result, draft: validated } as unknown as Record<string, unknown>, stage: 'validated', progress: 90 })
  patchJob(jobId, { stage: 'draft', progress: 100, errorJson: null })
}

// ---------------------------------------------------------------------------
// contestpin:importStatus / draftList
// ---------------------------------------------------------------------------

export function listImportJobs(jobId?: number): ContestImportStatusResult {
  if (jobId !== undefined) {
    return { jobs: [toJobView(getJobRow(jobId))] }
  }
  const rows = getDatabase()
    .prepare('SELECT * FROM contest_import_jobs ORDER BY id DESC LIMIT 50')
    .all() as unknown as JobRow[]
  return { jobs: rows.map(toJobView) }
}

export function listDraftJobs(): ContestImportDraftListResult {
  const rows = getDatabase()
    .prepare("SELECT * FROM contest_import_jobs WHERE stage = 'draft' ORDER BY id DESC")
    .all() as unknown as JobRow[]
  return { jobs: rows.map(toJobView) }
}

// ---------------------------------------------------------------------------
// contestpin:importCancel / importRetry
// ---------------------------------------------------------------------------

/**
 * 取消：置 stage='cancelled' + abort 在途出站。晚到回调经 throwIfCancelled
 * 丢弃（行已 cancelled 结果绝不落库）。终态（confirmed/failed/cancelled）为
 * 结构化 no-op（cancelled:false）。
 */
export function cancelImport(jobId: number): ContestImportCancelResult {
  const row = getJobRow(jobId)
  if (TERMINAL_STAGES.includes(row.stage as ContestImportStage)) {
    return { cancelled: false, stage: row.stage as ContestImportStage }
  }
  patchJob(jobId, { stage: 'cancelled', errorJson: null })
  activeControllers.get(jobId)?.abort()
  logger.info(`contestpin import job ${jobId} cancelled`)
  return { cancelled: true, stage: 'cancelled' }
}

/**
 * 每阶段独立重试：fromStage 指定重跑该阶段及以后（vision 清指纹重跑视觉；
 * text 保留视觉结果；validate 只重跑本地校验零 LLM）。任务在途/终态拒绝。
 */
export function retryImport(payload: { jobId: number; fromStage: ContestImportRetryFromStage }): ContestImportRetryResult {
  const row = getJobRow(payload.jobId)
  if (isJobRunning(row.id)) {
    throw new ServiceError('BAD_PAYLOAD', `导入任务 ${row.id} 正在运行，不能重试`)
  }
  if (row.stage === 'cancelled' || row.stage === 'confirmed' || row.stage === 'imported') {
    throw new ServiceError('BAD_PAYLOAD', `导入任务 ${row.id} 当前阶段 ${row.stage} 不可重试（cancelled 请重新导入；confirmed 已完成）`)
  }
  if (row.mode === 'multimodal' && payload.fromStage === 'text') {
    throw badCreate("multimodal 模式无独立 text 阶段（fromStage 仅 vision|validate）")
  }
  const result = parseResultView(row) ?? {}
  if (payload.fromStage === 'vision') {
    delete result.vision
    patchJob(payload.jobId, {
      resultJson: result,
      visionFingerprint: null,
      stage: row.mode === 'multimodal' ? 'imported' : 'preprocessed',
      progress: row.mode === 'multimodal' ? 0 : 10,
      errorJson: null,
    })
  } else if (payload.fromStage === 'text') {
    delete result.draft
    if (result.vision === undefined) {
      throw new ServiceError('BAD_PAYLOAD', `导入任务 ${row.id} 无可复用的视觉结果（请从 vision 重试）`)
    }
    patchJob(payload.jobId, { resultJson: result, stage: 'vision_done', errorJson: null })
  } else {
    if (result.draft === undefined) {
      throw new ServiceError('BAD_PAYLOAD', `导入任务 ${row.id} 无草稿可重新校验（请从 vision/text 重试）`)
    }
    patchJob(payload.jobId, { stage: 'text_done', errorJson: null })
  }
  kickJob(payload.jobId)
  logger.info(`contestpin import job ${payload.jobId} retry from ${payload.fromStage}`)
  return { job: toJobView(getJobRow(payload.jobId)) }
}

// ---------------------------------------------------------------------------
// 相似比赛检测与两段式确认
// ---------------------------------------------------------------------------

/** 名称归一（近似比较）：去空白/标点/符号 + 小写。 */
function normalizeContestName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, '')
}

/** 同 name（归一相等）或 name+year 近似（归一后互相包含且短侧 ≥4 字符）。 */
export function findSimilarContests(draft: ImportDraftView): ContestSimilarItem[] {
  const db = getDatabase()
  const rows = db
    .prepare('SELECT c.id, c.name, c.year, c.status, (SELECT COUNT(*) FROM contest_nodes n WHERE n.contest_id = c.id) AS node_count FROM contests c WHERE c.archived = 0')
    .all() as unknown as { id: number; name: string; year: number | null; status: string; node_count: number }[]
  const similar: ContestSimilarItem[] = []
  for (const draftContest of draft.contests) {
    const norm = normalizeContestName(draftContest.name)
    for (const row of rows) {
      const rowNorm = normalizeContestName(row.name)
      const nameLike = norm === rowNorm || (norm.length >= 4 && rowNorm.length >= 4 && (norm.includes(rowNorm) || rowNorm.includes(norm)))
      const yearLike = draftContest.year === null || row.year === null || draftContest.year === row.year
      if (nameLike && yearLike) {
        const item: ContestSimilarItem = { id: row.id, name: row.name, year: row.year, nodeCount: Number(row.node_count), status: row.status as ContestStatus }
        if (!similar.some((s) => s.id === row.id)) similar.push(item)
      }
    }
  }
  return similar
}

/** 确认前的草稿规整：用户编辑覆盖（payload.draft）也过同款程序化校验。 */
function normalizedDraftForConfirm(row: JobRow, override: ImportDraftView | undefined): ImportDraftView {
  const stored = parseResultView(row)?.draft
  const source = override !== undefined ? override : stored
  if (source === undefined || !Array.isArray(source.contests)) {
    throw new ServiceError('BAD_PAYLOAD', `导入任务 ${row.id} 无有效草稿（stage=${row.stage}）`)
  }
  return validateDraftContests({ contests: source.contests, flags: source.flags ?? [] })
}

/**
 * 两段式确认：缺省 confirmed → { confirmRequired, draft（规范化后）, similar }；
 * confirmed → mergeIntoContestId 给定 = 追加节点合并（绝不静默覆盖既有字段/节点，
 * 多比赛草稿不支持合并指尚）→ 否则逐草稿条目 createContest+createImportedNode
 * （source='imported'），任务 contest_id 回填（材料关联）+ stage=confirmed。
 */
export async function confirmDraft(payload: ContestImportDraftConfirmPayload): Promise<ContestImportDraftConfirmStart | ContestImportDraftConfirmResult> {
  const row = getJobRow(payload.jobId)
  if (row.stage !== 'draft') {
    throw new ServiceError('BAD_PAYLOAD', `导入任务 ${payload.jobId} 不在 draft 阶段（当前 ${row.stage}），无法确认`)
  }
  const draft = normalizedDraftForConfirm(row, payload.draft)
  if (payload.confirmed !== true) {
    // 持久化规范化结果（确认面所见即确认所建）
    const result = parseResultView(row) ?? {}
    patchJob(payload.jobId, { resultJson: { ...result, draft } })
    return { confirmRequired: true, draft, similar: findSimilarContests(draft) }
  }
  if (draft.contests.length === 0) {
    throw new ServiceError('BAD_PAYLOAD', '草稿为空（无比赛条目），请编辑或弃用')
  }
  const merging = payload.mergeIntoContestId !== undefined
  if (merging && draft.contests.length > 1) {
    throw new ServiceError('BAD_PAYLOAD', '合并语义仅支持单比赛草稿（当前草稿含多比赛条目，请拆分后合并）')
  }
  if (merging) {
    const mergeId = payload.mergeIntoContestId as number
    const target = getDatabase().prepare('SELECT id FROM contests WHERE id = ?').get(mergeId)
    if (target === undefined) {
      throw new ServiceError('NOT_FOUND', `mergeIntoContestId ${mergeId} not found`)
    }
  }
  let firstContestId: number | null = null
  let firstContestView: ContestView | null = null
  for (const contest of draft.contests) {
    if (merging) {
      const mergeId = payload.mergeIntoContestId as number
      for (const node of contest.nodes) {
        createImportedNode(mergeId, {
          kind: node.kind,
          label: node.label,
          precision: node.precision,
          startAt: node.startAt ?? null,
          endAt: node.endAt ?? null,
          rawText: node.rawText ?? null,
        })
      }
      if (firstContestId === null) {
        firstContestId = mergeId
        firstContestView = getContest(mergeId)
      }
    } else {
      const created = createContest({
        name: contest.name,
        year: contest.year,
        edition: contest.edition,
        organizer: contest.organizer,
        status: 'watching',
        officialSite: contest.officialSite?.url,
        signupUrl: contest.signupUrl?.url,
        submitUrl: contest.submitUrl?.url,
      })
      for (const node of contest.nodes) {
        createImportedNode(created.id, {
          kind: node.kind,
          label: node.label,
          precision: node.precision,
          startAt: node.startAt ?? null,
          endAt: node.endAt ?? null,
          rawText: node.rawText ?? null,
        })
      }
      if (firstContestId === null) {
        firstContestId = created.id
        firstContestView = created
      }
    }
  }
  patchJob(payload.jobId, { contestId: firstContestId, stage: 'confirmed', progress: 100 })
  logger.info(`contestpin import job ${payload.jobId} confirmed: contest=${firstContestId} merged=${merging}`)
  return { confirmRequired: undefined, merged: merging, contestId: firstContestId as number, contest: firstContestView as ContestView }
}

/** 两段式弃用：仅 stage='draft' 可弃（终态confirmed/运行中不可）；删任务行，材料保留。 */
export function discardDraft(payload: ContestImportDraftDiscardPayload): ContestImportDraftDiscardStart | ContestImportDraftDiscardResult {
  const row = getJobRow(payload.jobId)
  if (row.stage !== 'draft') {
    throw new ServiceError('BAD_PAYLOAD', `导入任务 ${payload.jobId} 不在 draft 阶段（当前 ${row.stage}），无法弃用`)
  }
  if (payload.confirmed !== true) {
    const material = materialRef(row.material_id)
    return { confirmRequired: true, jobId: row.id, materialName: material?.original_name ?? null }
  }
  getDatabase().prepare('DELETE FROM contest_import_jobs WHERE id = ?').run(row.id)
  logger.info(`contestpin import job ${row.id} draft discarded`)
  return { confirmRequired: undefined, removed: true }
}
