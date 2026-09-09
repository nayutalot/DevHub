/**
 * reviewService.ts — LLM 复核编排（LR1 批次，advisory-only；
 * docs/briefs/lr1-llm-review.md 全文权威 + docs/09 §13 + docs/10 范围修订块）。
 *
 * - **electron-free** 纯 Node 模块（铁律基线同 docs/09 §11）；零新依赖；
 *   传输面经 reviewClient 注入（smoke fake transport 零联网，cp3a 同范式）。
 * - **advisory-only 铁律**：复核永不阻塞归档主流程——归档 execute 管线
 *   （precheck→preview→confirm→execute→verify）零改动、零新增调用（任务书 §1/
 *   §4.2：自动挂管线 = LR2 选项）；本服务对端点任何形态的失败都折叠为四态
 *   envelope 返回，绝不向 IPC 层抛异常（runId 不存在 NOT_FOUND 除外——那是
 *   普通资源查找错误，非复核失败）。
 * - **四态 envelope**（任务书 §3）：ok（合法 JSON 过结构校验）/ skipped（未配置/
 *   不可达/超时——行为等价现状）/ failed（非 2xx、网络错误）/ unparseable
 *   （模型回非法 JSON，不崩）。TIMEOUT 归 skipped（任务书 §2 超时语义）。
 * - **缓存**（任务书 §4.2/§7）：reviewPost 结果缓存 archive_runs.review_post_json，
 *   命中不再打端点；只缓存 ok 态（失败态可重试）。列缺失（真实库已被 ContestPin
 *   预迁到 user_version=8，007 按 docs/03 §4 序号语义不再自动应用）→ 优雅降级
 *   为无缓存模式，行为仍正确（见本文件 PRAGMA table_info 备忘）。
 * - **prompt 纪律**（任务书 §6）：模板 = 代码常量（不入 settings、不入 DB、非
 *   用户可编辑）；复核输入仅路径/名称/描述/计数级字段——零文件内容、零 key，
 *   任何把文件内容或凭据拼进 prompt 的实现即为缺陷。
 * - **settings 双键**（任务书 §5）：llm_review_base_url / llm_review_model，
 *   默认空 = 停用；双键同设才生效（任一为空 → skipped）。v1 零 key 字段。
 * - skills:reviewMeta 只读咨询不落库，doctor 语义不变（docs/09 §13）。
 */

import type { DatabaseSync } from 'node:sqlite'
import type {
  ArchiveReviewPrePayload,
  ReviewEnvelope,
  ReviewRisk,
  ReviewTestEndpointResult,
  SkillMetaFlag,
  SkillMetaFlagKind,
  SkillsReviewMetaResult,
} from '../../../shared/types.ts'
import { getDatabase } from '../../db/index.ts'
import { errorMessage, ServiceError } from '../internal.ts'
import { logger } from '../../core/logger.ts'
import { getSetting } from '../settingsService.ts'
import { listSkills } from '../skillService.ts'
import { reviewChatCompletion } from './reviewClient.ts'
import type { ReviewChatMessage } from './reviewClient.ts'

// ---------------------------------------------------------------------------
// 配置读取（settings 双键，任一为空 = 未配置 → skipped）
// ---------------------------------------------------------------------------

/** 读复核端点配置；双键同设才生效（任务书 §5），否则 null = 未配置。 */
export function readReviewConfig(): { baseUrl: string; model: string } | null {
  const baseUrl = (getSetting('llm_review_base_url') ?? '').trim()
  const model = (getSetting('llm_review_model') ?? '').trim()
  if (baseUrl.length === 0 || model.length === 0) return null
  return { baseUrl, model }
}

const SKIPPED_UNCONFIGURED = 'LLM 复核未配置（llm_review_base_url 与 llm_review_model 需双键同设）— 行为等价现状'

// ---------------------------------------------------------------------------
// prompt 常量（任务书 §6：代码常量；输入仅路径/名称/描述/计数，零文件内容零 key）
// ---------------------------------------------------------------------------

const REVIEW_SYSTEM_PROMPT =
  'You are an advisory reviewer for a local project-archiving tool. ' +
  'You only ever receive structured metadata (paths, names, descriptions, counts) — never file contents. ' +
  'Reply with STRICT JSON only: no markdown fences, no commentary before or after the JSON object.'

/** prompt 内描述字段截断上限（防超长描述撑爆请求；仍属"描述级字段"范畴）。 */
const PROMPT_DESCRIPTION_MAX = 300

function clipDescription(raw: string | undefined): string {
  const text = (raw ?? '').replace(/\s+/g, ' ').trim()
  return text.length > PROMPT_DESCRIPTION_MAX ? `${text.slice(0, PROMPT_DESCRIPTION_MAX)}…` : text
}

function buildPreUserPrompt(plan: ArchiveReviewPrePayload['plan']): string {
  return [
    'Assess the risk of this project archive plan (the directory will be MOVED to the archive volume and path references rewritten).',
    `Project name: ${plan.projectName}`,
    `Project description: ${clipDescription(plan.projectDescription) || '(none)'}`,
    `Source path: ${plan.oldPath}`,
    `Destination path: ${plan.destPath}`,
    `Cross-volume move: ${plan.crossVolume ? 'yes (verified copy)' : 'no (same-volume rename)'}`,
    `Reference hits (total): ${plan.totalHits}`,
    `Unique files to rewrite: ${plan.filesToRewrite}`,
    `Regenerable dirs stripped: ${plan.stripDirs}`,
    `Occupying processes: ${plan.occupiers}`,
    'Respond with JSON of shape {"risk":"low"|"medium"|"high","concerns":["short string",...],"rationale":"one or two sentences"}.',
    'Write concerns and rationale in Simplified Chinese. Empty concerns array is allowed.',
  ].join('\n')
}

interface ArchiveRunReviewRow {
  id: number
  project_name: string
  old_path: string
  new_path: string
  status: string
  fixed_files: number
  external_files: number
  residual_hits: number
  started_at: number
  finished_at: number | null
}

const RUN_REVIEW_ROW_SQL =
  'SELECT id, project_name, old_path, new_path, status, fixed_files, external_files, residual_hits, started_at, finished_at FROM archive_runs WHERE id = ?'

function buildPostUserPrompt(run: ArchiveRunReviewRow): string {
  const durationSec = run.finished_at !== null ? Math.max(run.finished_at - run.started_at, 0) : null
  return [
    'Review the result of a completed project archive run (metadata only) and assess residual risk.',
    `Project name: ${run.project_name}`,
    `Moved from: ${run.old_path}`,
    `Moved to: ${run.new_path}`,
    `Run status: ${run.status}`,
    `Internal files rewritten: ${run.fixed_files}`,
    `External reference files rewritten: ${run.external_files}`,
    `Residual old-path references after rewrite: ${run.residual_hits}`,
    `Duration seconds: ${durationSec ?? 'unknown'}`,
    'Respond with JSON of shape {"risk":"low"|"medium"|"high","concerns":["short string",...],"rationale":"one or two sentences"}.',
    'Write concerns and rationale in Simplified Chinese. Empty concerns array is allowed.',
  ].join('\n')
}

/** Skills 元数据体检判定标准（docs/09 §13 三类 flags；阈值在此锚定并随 prompt 发给模型）。 */
const SKILL_META_CRITERIA = [
  'short_description: the description is missing or shorter than 20 characters.',
  'language_mismatch: the description language is clearly inconsistent with the skill name or the dominant language of the other descriptions.',
  'suspected_duplicate: another skill in the provided list covers substantially the same purpose (name near-synonyms or near-identical descriptions).',
].join('; ')

function buildMetaUserPrompt(skills: { id: number; name: string; description: string }[]): string {
  const lines = skills.map((s) => `- {"skillId":${s.id},"name":${JSON.stringify(s.name)},"description":${JSON.stringify(clipDescription(s.description))}}`)
  return [
    'Review this skill metadata list (names and descriptions only — never file contents) and report metadata issues.',
    'Flag criteria:',
    SKILL_META_CRITERIA,
    'Skill list:',
    ...lines,
    'Respond with JSON of shape {"flags":[{"skillId":number,"kind":"short_description"|"language_mismatch"|"suspected_duplicate","detail":"one short sentence"}]}.',
    'Only reference skillId values from the provided list. Write detail in Simplified Chinese. Empty flags array is allowed.',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// 模型回复解析与结构校验（unparseable 判定：非法 JSON / 结构不符，不崩）
// ---------------------------------------------------------------------------

/** 宽容解析：剥掉 ```json 围栏后 JSON.parse；任何失败返回 null（调用方折叠 unparseable）。 */
function parseModelJson(content: string): unknown {
  let text = content.trim()
  if (text.startsWith('```')) {
    text = text.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim()
  }
  return JSON.parse(text)
}

const REVIEW_RISKS: readonly ReviewRisk[] = ['low', 'medium', 'high']

/** 风险/关注点/理由结构校验：任一不符 → null（unparseable 态）。concerns 上限 10 条防刷屏。 */
function validateReviewVerdict(parsed: unknown): { risk: ReviewRisk; concerns: string[]; rationale: string } | null {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  const risk = record.risk
  if (typeof risk !== 'string' || !(REVIEW_RISKS as readonly string[]).includes(risk)) return null
  const concernsRaw = record.concerns
  if (!Array.isArray(concernsRaw)) return null
  const concerns: string[] = []
  for (const c of concernsRaw) {
    if (typeof c !== 'string') return null
    const trimmed = c.trim()
    if (trimmed.length > 0) concerns.push(trimmed)
    if (concerns.length >= 10) break
  }
  const rationale = record.rationale
  if (typeof rationale !== 'string' || rationale.trim().length === 0) return null
  return { risk: risk as ReviewRisk, concerns, rationale: rationale.trim() }
}

// ---------------------------------------------------------------------------
// review 附属列在场性备忘（真实库已被 ContestPin 预迁 user_version=8 的降级面）
// ---------------------------------------------------------------------------

let reviewColumnsMemo: boolean | null = null

/**
 * archive_runs 是否已有 review_pre_json/review_post_json 两列。
 * 背景：runner 只应用序号 > user_version 的迁移（docs/03 §4），ContestPin 批次
 * 已把真实库预迁到 8 → 007 不会再自动应用，列可能缺席。advisory 层选择优雅
 * 降级（无缓存模式，envelope 语义不变），绝不因列缺席打断调用方。
 */
function archiveRunsHasReviewColumns(db: DatabaseSync): boolean {
  if (reviewColumnsMemo !== null) return reviewColumnsMemo
  try {
    const cols = db.prepare('PRAGMA table_info(archive_runs)').all() as { name: string }[]
    const names = new Set(cols.map((c) => c.name))
    reviewColumnsMemo = names.has('review_pre_json') && names.has('review_post_json')
  } catch {
    reviewColumnsMemo = false
  }
  return reviewColumnsMemo
}

/** 缓存读：命中且可解析返回 envelope（cached 标记由调用方补）；其余 null。 */
function readPostCache(db: DatabaseSync, runId: number): ReviewEnvelope | null {
  if (!archiveRunsHasReviewColumns(db)) return null
  try {
    const row = db.prepare('SELECT review_post_json FROM archive_runs WHERE id = ?').get(runId) as
      | { review_post_json: string | null }
      | undefined
    if (row === undefined || row.review_post_json === null) return null
    const parsed: unknown = JSON.parse(row.review_post_json)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    if (record.status !== 'ok') return null // 只缓存 ok 态；异常缓存内容视同未复核
    return validateReviewVerdict(parsed) === null ? null : (parsed as ReviewEnvelope)
  } catch {
    return null
  }
}

/** 缓存写：best-effort（advisory 纪律）——列缺失/写失败仅记日志，绝不抛出。 */
function writePostCache(db: DatabaseSync, runId: number, envelope: ReviewEnvelope): void {
  if (!archiveRunsHasReviewColumns(db)) return
  try {
    db.prepare('UPDATE archive_runs SET review_post_json = ? WHERE id = ?').run(JSON.stringify(envelope), runId)
  } catch (err) {
    logger.warn(`reviewPost cache write skipped (advisory non-fatal): ${errorMessage(err)}`)
  }
}

// ---------------------------------------------------------------------------
// 端点调用 → 四态归并（ok / skipped / failed / unparseable；TIMEOUT 归 skipped）
// ---------------------------------------------------------------------------

type ChatOutcome =
  | { status: 'ok'; content: string; latencyMs: number }
  | { status: 'skipped' | 'failed' | 'unparseable'; note: string; latencyMs: number }

function collapseClientResult(result: Awaited<ReturnType<typeof reviewChatCompletion>>): ChatOutcome {
  if (result.ok) return { status: 'ok', content: result.content, latencyMs: result.latencyMs }
  const { kind, message } = result.failure
  if (kind === 'TIMEOUT') return { status: 'skipped', note: `LLM 复核超时已跳过（advisory 不阻塞）— ${message}`, latencyMs: result.latencyMs }
  if (kind === 'BAD_RESPONSE') return { status: 'unparseable', note: `模型回复格式不可解析 — ${message}`, latencyMs: result.latencyMs }
  return { status: 'failed', note: message, latencyMs: result.latencyMs }
}

function verdictEnvelope(outcome: ChatOutcome, model: string, verdict: { risk: ReviewRisk; concerns: string[]; rationale: string } | null): ReviewEnvelope {
  if (outcome.status !== 'ok') {
    return { status: outcome.status, note: outcome.note, latencyMs: outcome.latencyMs }
  }
  if (verdict === null) {
    return { status: 'unparseable', note: '模型回复不是合法 JSON 或缺少 risk/concerns/rationale 字段', latencyMs: outcome.latencyMs }
  }
  return { status: 'ok', model, latencyMs: outcome.latencyMs, ...verdict }
}

async function callVerdict(config: { baseUrl: string; model: string }, userPrompt: string): Promise<ReviewEnvelope> {
  const messages: readonly ReviewChatMessage[] = [
    { role: 'system', content: REVIEW_SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
  ]
  const result = await reviewChatCompletion(config, messages)
  const outcome = collapseClientResult(result)
  let verdict: { risk: ReviewRisk; concerns: string[]; rationale: string } | null = null
  if (outcome.status === 'ok') {
    try {
      verdict = validateReviewVerdict(parseModelJson(outcome.content))
    } catch {
      verdict = null // 非法 JSON → unparseable（advisory 不崩）
    }
  }
  return verdictEnvelope(outcome, config.model, verdict)
}

// ---------------------------------------------------------------------------
// review:testEndpoint —— 设置卡片端点测试入口（任务书 §8：{ ok, latencyMs, error? }）
// ---------------------------------------------------------------------------

/** 端点连通性/延迟探测：显式传入 baseUrl/model（不读 settings、不落任何存储）。 */
export async function testReviewEndpoint(baseUrl: string, model: string): Promise<ReviewTestEndpointResult> {
  const messages: readonly ReviewChatMessage[] = [
    { role: 'system', content: REVIEW_SYSTEM_PROMPT },
    { role: 'user', content: 'Connectivity probe. Reply with the JSON object {"risk":"low","concerns":[],"rationale":"pong"}.' },
  ]
  const result = await reviewChatCompletion({ baseUrl, model }, messages)
  if (result.ok) return { ok: true, latencyMs: result.latencyMs }
  return { ok: false, latencyMs: result.latencyMs, error: result.failure.message }
}

// ---------------------------------------------------------------------------
// archive:reviewPre —— 归档前复核（preview 既有 plan 摘要，零额外扫描；纯计算不落库）
// ---------------------------------------------------------------------------

/**
 * 归档前复核。LR1 不写 review_pre_json（run 行在 execute 时才创建，而归档执行
 * 路径零新增调用——任务书 §4.2；自动写缓存挂管线 = LR2 选项），本通道为纯计算：
 * plan 摘要 → 四态 envelope，确认弹窗咨询条展示（advisory 不拦截 DOUBLE_CONFIRM）。
 */
export async function runReviewPre(payload: ArchiveReviewPrePayload): Promise<ReviewEnvelope> {
  const config = readReviewConfig()
  if (config === null) return { status: 'skipped', note: SKIPPED_UNCONFIGURED }
  return callVerdict(config, buildPreUserPrompt(payload.plan))
}

// ---------------------------------------------------------------------------
// archive:reviewPost —— 归档后复核（run 详情按需触发；ok 态缓存，命中不再打端点）
// ---------------------------------------------------------------------------

export async function runReviewPost(runId: number): Promise<ReviewEnvelope> {
  const db = getDatabase()
  const run = db.prepare(RUN_REVIEW_ROW_SQL).get(runId) as ArchiveRunReviewRow | undefined
  if (run === undefined) {
    throw new ServiceError('NOT_FOUND', `archive run ${runId} not found`)
  }
  const cached = readPostCache(db, runId)
  if (cached !== null) return { ...cached, cached: true }

  const config = readReviewConfig()
  if (config === null) return { status: 'skipped', note: SKIPPED_UNCONFIGURED }

  const envelope = await callVerdict(config, buildPostUserPrompt(run))
  if (envelope.status === 'ok') writePostCache(db, runId, envelope)
  return envelope
}

// ---------------------------------------------------------------------------
// skills:reviewMeta —— 元数据体检（手动按钮触发；只读咨询不落库，doctor 语义不变）
// ---------------------------------------------------------------------------

const META_FLAG_KINDS: readonly SkillMetaFlagKind[] = ['short_description', 'language_mismatch', 'suspected_duplicate']

/** flags 结构校验：skillId 必须出自输入清单（模型幻觉 id 一律丢弃），kind 白名单。 */
function validateMetaFlags(parsed: unknown, knownIds: Map<number, string>): SkillMetaFlag[] | null {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const flagsRaw = (parsed as Record<string, unknown>).flags
  if (!Array.isArray(flagsRaw)) return null
  const flags: SkillMetaFlag[] = []
  for (const item of flagsRaw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null
    const record = item as Record<string, unknown>
    const skillId = record.skillId
    if (typeof skillId !== 'number' || !Number.isSafeInteger(skillId) || !knownIds.has(skillId)) continue
    const kind = record.kind
    if (typeof kind !== 'string' || !(META_FLAG_KINDS as readonly string[]).includes(kind)) return null
    const detail = record.detail
    if (typeof detail !== 'string') return null
    flags.push({ skillId, name: knownIds.get(skillId) ?? '', kind: kind as SkillMetaFlagKind, detail: detail.trim() })
    if (flags.length >= 100) break
  }
  return flags
}

export async function runSkillsMetaReview(): Promise<SkillsReviewMetaResult> {
  const skills = listSkills().skills
  if (skills.length === 0) {
    return { status: 'skipped', note: 'vault 无 skill 记录，无可体检元数据' }
  }
  const config = readReviewConfig()
  if (config === null) return { status: 'skipped', note: SKIPPED_UNCONFIGURED }

  const knownIds = new Map(skills.map((s) => [s.id, s.name]))
  const messages: readonly ReviewChatMessage[] = [
    { role: 'system', content: REVIEW_SYSTEM_PROMPT },
    { role: 'user', content: buildMetaUserPrompt(skills.map((s) => ({ id: s.id, name: s.name, description: s.description }))) },
  ]
  const result = await reviewChatCompletion(config, messages)
  const outcome = collapseClientResult(result)
  if (outcome.status !== 'ok') {
    return { status: outcome.status, note: outcome.note, latencyMs: outcome.latencyMs }
  }
  let flags: SkillMetaFlag[] | null = null
  try {
    flags = validateMetaFlags(parseModelJson(outcome.content), knownIds)
  } catch {
    flags = null
  }
  if (flags === null) {
    return { status: 'unparseable', note: '模型回复不是合法 JSON 或 flags 结构不符', latencyMs: outcome.latencyMs }
  }
  return { status: 'ok', model: config.model, latencyMs: outcome.latencyMs, flags, checkedCount: skills.length }
}

/** smoke 专用：清空列在场性备忘（迁移路径用例在临时库间切换时必须重置）。 */
export function _testReset(): void {
  reviewColumnsMemo = null
}
