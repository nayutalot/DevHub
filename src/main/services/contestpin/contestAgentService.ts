/**
 * contestAgentService.ts — ContestPin Agent 模式（CP5 批次，docs/22 §8）。
 *
 * 双路径，同一 draft 核对管线：
 * - **自动路径**（contestpin:agentSubmit）：材料本地文字提取 + 结构化指令 = 纯文本
 *   任务（零文件内容外发超出材料文字本身，与 CP3 识别同一面），经 L3
 *   `startProviderManagedSession` 发起 codex managed 托管会话——**只消费不绕过**：
 *   能力门（managed 授权 + 能力验证 ≤300s 新鲜）在 L3，observed/陈旧 → 结构化拒绝
 *   （AGENT_CAPABILITY_MISSING / COMMAND_NOT_EXECUTABLE），不静默降级不模拟成功。
 *   本模块零新 spawn 点（exec.ts 唯一 spawn 纪律不受影响）。
 * - **手动路径**（contestpin:exportPack / importPack）：任务包 JSON
 *   （kind='contestpin-task-pack'：任务说明 + 材料清单 + 材料文字；**零凭据零
 *   key**，manifest 同款红线）→ 用户交给任意 Agent → 结果导入 → 与两阶段/多模态
 *   同一条 parseDraftJson → validateDraftContests → validated→draft 落位 → 既有
 *   draftConfirm 两段式核对界面。绝不直写生产行、不静默覆盖。
 * - **任务态**（contestpin:agentStatus，READ_ONLY）：agent/manual_pack 任务行投影
 *   + mode='agent' 行联查托管会话状态（agent_sessions 只读投影，绝不猜）。
 * - **取消**（复用 contestpin:importCancel，不设新通道）：agent 任务 = 置
 *   stage='cancelled' + 监控循环取消令牌（monitorRegistry 同款 { cancelled } 令牌
 *   语义，作用域 = 本任务及其托管会话）+ L3 `createSessionAction(pause)` 只中断
 *   本任务托管 turn——不终止用户其他任务/会话。取消后的晚到回流因 stage 守卫与
 *   watcher 退出绝不落库（importPipeline 同款语义）。
 *
 * electron-free 纯 Node；smoke 全 fake provider 注入（setProviderOverride +
 * buildMonitorSink 落库面），零真实推理零配额消耗（真实 codex 实测留主控窗毕复验）。
 */

import { readFile, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { getDatabase } from '../../db/index.ts'
import { logger } from '../../core/logger.ts'
import { ServiceError, nowSec } from '../internal.ts'
import {
  createSessionAction,
  getAgentSessionDetail,
  listAgentMessages,
  MANAGED_SESSION_TASK_MAX_CHARS,
  startProviderManagedSession,
} from '../agentControl/agentControlService.ts'
import { extractPdfContent } from './pdfService.ts'
import { readMaterialStoredFile } from './materialService.ts'
import {
  ensureValidatedDraft,
  JSON_CONTRACT_PROMPT,
  parseDraftJson,
  patchJob,
  parseResultView,
} from './importPipeline.ts'
import type {
  ContestAgentJobView,
  ContestAgentStatusPayload,
  ContestAgentStatusResult,
  ContestAgentSubmitPayload,
  ContestAgentSubmitResult,
  ContestImportJobView,
  ContestPackExportPayload,
  ContestPackExportResult,
  ContestPackImportPayload,
  ContestPackImportResult,
  ImportDraftView,
  ImportFlag,
} from '../../../shared/types.ts'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 任务包内单页文字截断上限（与管线 PAGE_TEXT_MAX 同量级）。 */
const PACK_PAGE_TEXT_MAX = 20_000
/** 用户附加指令长度上限。 */
const INSTRUCTION_MAX_CHARS = 2_000
/** 任务包结果文件大小上限。 */
const PACK_RESULT_FILE_MAX_BYTES = 10 * 1024 * 1024
/** agent 任务托管会话等待上限（unix 秒；超时 → 结构化 failed，可重新提交）。 */
export const AGENT_JOB_TIMEOUT_SEC = 1_800
/** watcher 轮询间隔毫秒（监控管线读端为本地 SQLite 投影，轮询开销可忽略）。 */
const AGENT_POLL_INTERVAL_MS = 1_500

// ---------------------------------------------------------------------------
// 材料本地文字提取（零联网零推理：pdfjs 纯 JS 本地提取，图片材料仅列元数据）
// ---------------------------------------------------------------------------

export interface PackMaterial {
  materialId: number
  name: string
  sha256: string
  kind: string
  pageCount: number | null
  /** 逐页本地文字（pdf only；image/other 不含——显式标注而非编造）。 */
  pages: { page: number; text: string }[]
  /** 本地 PDF 超链接（注释 URI）。 */
  links: { uri: string; page: number }[]
  /** 图片/无文字材料的显式说明（绝不静默省略）。 */
  note?: string
}

interface MaterialRow {
  id: number
  sha256: string
  original_name: string
  kind: string
}

function loadMaterialRows(materialIds: number[]): MaterialRow[] {
  const db = getDatabase()
  const rows: MaterialRow[] = []
  for (const id of materialIds) {
    const row = db.prepare('SELECT id, sha256, original_name, kind FROM contest_materials WHERE id = ?').get(id) as
      | MaterialRow
      | undefined
    if (row === undefined) {
      throw new ServiceError('NOT_FOUND', `contest material ${id} not found`)
    }
    rows.push(row)
  }
  return rows
}

/** 校验 payload.materialIds 形状并去重（保序）。 */
function validatedMaterialIds(raw: number[] | undefined, face: string): number[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ServiceError('BAD_PAYLOAD', `${face}: materialIds must be a non-empty array`)
  }
  for (const id of raw) {
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) {
      throw new ServiceError('BAD_PAYLOAD', `${face}: materialIds must contain positive integers`)
    }
  }
  return [...new Set(raw)]
}

/** 材料本地文字提取（pdf → pdfjs 文本+链接；image/other → 元数据 + 显式 note）。 */
export async function extractMaterialsText(materialIds: number[]): Promise<PackMaterial[]> {
  const rows = loadMaterialRows(materialIds)
  const packs: PackMaterial[] = []
  for (const row of rows) {
    const pack: PackMaterial = {
      materialId: Number(row.id),
      name: row.original_name,
      sha256: row.sha256,
      kind: row.kind,
      pageCount: null,
      pages: [],
      links: [],
    }
    if (row.kind === 'pdf') {
      const { data } = await readMaterialStoredFile(Number(row.id))
      const extracted = await extractPdfContent(data, { maxPages: 500 })
      pack.pageCount = extracted.pageCount
      pack.pages = extracted.pages.map((p) => ({ page: p.page, text: p.text.slice(0, PACK_PAGE_TEXT_MAX) }))
      pack.links = extracted.pages.flatMap((p) => p.links.map((l) => ({ uri: l.uri, page: l.page })))
    } else if (row.kind === 'image') {
      pack.note = '图片材料：本任务包不含图片内容（仅文字路径），请勿臆测其中信息'
    } else {
      pack.note = '非 PDF/图片材料：无内容参与识别'
    }
    packs.push(pack)
  }
  return packs
}

/** 材料文字总量（去空白后；agentSubmit 判定「无可提取文字」用）。 */
function materialTextCharTotal(materials: PackMaterial[]): number {
  return materials.reduce((acc, m) => acc + m.pages.reduce((a, p) => a + p.text.length, 0), 0)
}

// ---------------------------------------------------------------------------
// 任务文本 / 任务包组装
// ---------------------------------------------------------------------------

/** 结构化任务头（自动路径任务文本 + 手动任务包共用同一契约，绝不维护第二份）。 */
function buildTaskHeader(instruction: string | undefined): string {
  const lines: string[] = [
    '[DevHub ContestPin 识别任务]',
    '请阅读以下比赛通知材料的逐页文字，按下方契约输出严格 JSON（禁止 markdown 代码块、禁止解释文字）。',
    '只允许使用材料原文实际出现的信息；缺失字段留空或省略，绝不编造年份/时刻/官网/链接。',
    JSON_CONTRACT_PROMPT,
  ]
  if (instruction !== undefined && instruction.trim().length > 0) {
    lines.push(`[用户附加指令] ${instruction.trim().slice(0, INSTRUCTION_MAX_CHARS)}`)
  }
  return lines.join('\n')
}

/** 材料文字段（`[materialId=N 第 P 页]` 标记与管线 provenance 约定一致）。 */
function buildMaterialSection(materials: PackMaterial[]): string {
  const lines: string[] = []
  for (const m of materials) {
    lines.push(`[材料 #${m.materialId}] name=${m.name} kind=${m.kind}${m.pageCount !== null ? ` pages=${m.pageCount}` : ''}`)
    if (m.note !== undefined) lines.push(m.note)
    for (const page of m.pages) {
      lines.push(`--- [materialId=${m.materialId} 第 ${page.page} 页] ---`)
      lines.push(page.text)
    }
    for (const link of m.links) {
      lines.push(`[materialId=${m.materialId} 第 ${link.page} 页 超链接] ${link.uri}`)
    }
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// 任务行读写（写库一律经 importPipeline.patchJob 同一守卫；约束 #20）
// ---------------------------------------------------------------------------

interface AgentJobRow {
  id: number
  contest_id: number | null
  material_id: number | null
  mode: string
  stage: string
  params_json: string | null
  result_json: string | null
  error_json: string | null
  progress: number | null
  created_at: number
  updated_at: number
}

function getAgentJobRow(jobId: number): AgentJobRow | undefined {
  return getDatabase().prepare('SELECT * FROM contest_import_jobs WHERE id = ?').get(jobId) as
    | AgentJobRow
    | undefined
}

function parseJsonObject(raw: string | null): Record<string, unknown> | null {
  if (raw === null || raw.trim().length === 0) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    return null
  } catch {
    return null
  }
}

/** 行 → 视图（复用 importPipeline.listImportJobs 的投影；此处仅补 agent 联查态）。 */
function toAgentJobView(row: AgentJobRow, sessionStatus?: string): ContestAgentJobView {
  const result = parseResultView(row)
  const view: ContestAgentJobView = {
    id: Number(row.id),
    contestId: row.contest_id === null ? null : Number(row.contest_id),
    material: null,
    mode: row.mode as ContestImportJobView['mode'],
    stage: row.stage as ContestImportJobView['stage'],
    visionConfigId: null,
    textConfigId: null,
    visionFingerprint: null,
    params: parseJsonObject(row.params_json),
    result,
    error: (() => {
      const parsed = parseJsonObject(row.error_json)
      if (parsed === null || typeof parsed.kind !== 'string' || typeof parsed.message !== 'string') return null
      return { kind: parsed.kind, message: parsed.message }
    })(),
    progress: row.progress === null ? null : Number(row.progress),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
  const link = result?.agent
  if (row.mode === 'agent' && link !== undefined && typeof link.provider === 'string') {
    view.agent = {
      provider: link.provider,
      sessionId: typeof link.sessionId === 'number' ? link.sessionId : null,
      nativeId: typeof link.nativeId === 'string' ? link.nativeId : null,
      sessionStatus: sessionStatus ?? 'unknown',
    }
  }
  return view
}

// ---------------------------------------------------------------------------
// agent 任务 watcher（监控循环取消令牌；作用域 = 本任务及其托管会话）
// ---------------------------------------------------------------------------

const agentControllers = new Map<number, AbortController>()
const agentInflight = new Map<number, Promise<void>>()

/** smoke 测试钩子：等待全部 agent watcher 落定（超时抛错，防挂死）。 */
export async function waitForAgentJobsIdle(timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (agentInflight.size > 0) {
    if (Date.now() > deadline) {
      throw new Error(`waitForAgentJobsIdle timed out with ${agentInflight.size} inflight watchers`)
    }
    await Promise.race([...agentInflight.values()])
  }
}

/** 取消令牌感知 sleep：abort 立即返回（monitorRegistry cancellableSleep 同款语义）。 */
function abortableSleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolveSleep) => {
    if (signal.aborted) {
      resolveSleep(false)
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolveSleep(!signal.aborted)
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      resolveSleep(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function failAgentJob(jobId: number, kind: string, message: string): void {
  patchJob(jobId, { stage: 'failed', errorJson: { kind, message } })
  logger.warn(`contestpin agent job ${jobId} failed: ${kind}: ${message}`)
}

function kickAgentWatcher(jobId: number): void {
  if (agentInflight.has(jobId)) return
  const controller = new AbortController()
  agentControllers.set(jobId, controller)
  const promise = runAgentWatcher(jobId, controller).finally(() => {
    agentInflight.delete(jobId)
    agentControllers.delete(jobId)
  })
  agentInflight.set(jobId, promise)
}

/**
 * watcher 主循环：轮询托管会话状态（agent_sessions 投影，L3 读面）——
 * waiting_input/completed → 抽取最后一条 assistant 消息进 draft 管线；
 * paused/failed/stopped/connection_lost → 结构化 failed；cancelled → 退出
 * （晚到回流绝不落库）；行被删（draftDiscard）→ 静默退出。
 */
async function runAgentWatcher(jobId: number, controller: AbortController): Promise<void> {
  const deadline = nowSec() + AGENT_JOB_TIMEOUT_SEC
  try {
    for (;;) {
      if (controller.signal.aborted) return
      const row = getAgentJobRow(jobId)
      if (row === undefined) return // 行已删（draftDiscard/用户清理）：watcher 无意义
      const stage = row.stage
      if (stage === 'cancelled' || stage === 'confirmed' || stage === 'failed') return
      const link = parseResultView(row)?.agent
      if (link === undefined || typeof link.sessionId !== 'number') {
        // L3 尚未回填会话联动（submit 与 sink 落库同函数内完成，理论不可达）；下轮再看
        if (nowSec() > deadline) {
          failAgentJob(jobId, 'AGENT_TIMEOUT', `agent 任务超时（>${AGENT_JOB_TIMEOUT_SEC}s）无托管会话联动`)
          return
        }
        if (!(await abortableSleep(AGENT_POLL_INTERVAL_MS, controller.signal))) return
        continue
      }
      let sessionStatus = 'unknown'
      try {
        const detail = getAgentSessionDetail(link.sessionId)
        sessionStatus = detail.session.status
      } catch {
        sessionStatus = 'unknown' // 会话行缺失（绝不猜）：按 unknown 继续，直到超时
      }
      if (sessionStatus === 'waiting_input' || sessionStatus === 'completed') {
        await collectAgentResult(jobId, controller.signal)
        return
      }
      if (sessionStatus === 'paused') {
        failAgentJob(jobId, 'AGENT_INTERRUPTED', '托管会话 turn 被中断（paused），任务未完成；请重新提交')
        return
      }
      if (sessionStatus === 'failed' || sessionStatus === 'stopped' || sessionStatus === 'connection_lost') {
        failAgentJob(jobId, `AGENT_SESSION_${sessionStatus.toUpperCase()}`, `托管会话状态 ${sessionStatus}，任务未完成；请重新提交`)
        return
      }
      if (nowSec() > deadline) {
        failAgentJob(jobId, 'AGENT_TIMEOUT', `agent 任务超时（>${AGENT_JOB_TIMEOUT_SEC}s，会话状态 ${sessionStatus}）；请重新提交`)
        return
      }
      if (!(await abortableSleep(AGENT_POLL_INTERVAL_MS, controller.signal))) return
    }
  } catch (err) {
    if (controller.signal.aborted) return // 取消竞态：失败折叠丢弃
    try {
      const row = getAgentJobRow(jobId)
      if (row !== undefined && row.stage !== 'cancelled' && row.stage !== 'confirmed' && row.stage !== 'failed') {
        failAgentJob(jobId, 'INTERNAL', `agent watcher 内部错误：${err instanceof Error ? err.message : String(err)}`.slice(0, 300))
      }
    } catch {
      /* 双重失败：保持现状（下一轮提交自愈） */
    }
  }
}

/** 回流抽取：最后一条 assistant 消息 → parseDraftJson → provenance 越界 flag → 同一 validated→draft 落位。 */
async function collectAgentResult(jobId: number, signal: AbortSignal): Promise<void> {
  const row = getAgentJobRow(jobId)
  if (row === undefined) return
  if (row.stage === 'cancelled' || row.stage === 'confirmed' || row.stage === 'failed') return
  const link = parseResultView(row)?.agent
  if (link === undefined || typeof link.sessionId !== 'number') {
    failAgentJob(jobId, 'INTERNAL', '回流抽取缺托管会话联动')
    return
  }
  const page = listAgentMessages({ sessionId: link.sessionId, last: 50 })
  if (signal.aborted) return
  let content: string | null = null
  for (let i = page.items.length - 1; i >= 0; i--) {
    if (page.items[i].role === 'assistant') {
      content = page.items[i].contentRedacted
      break
    }
  }
  if (content === null) {
    failAgentJob(jobId, 'BAD_RESPONSE', '托管会话无 assistant 回复（turn 可能未产出结果）；请重新提交')
    return
  }
  let draft: ImportDraftView
  try {
    draft = parseDraftJson(content)
  } catch (err) {
    failAgentJob(
      jobId,
      'BAD_RESPONSE',
      `Agent 输出 JSON 解析失败：${err instanceof Error ? err.message : String(err)}；内容摘要：${content.replace(/\s+/g, ' ').slice(0, 200)}`,
    )
    return
  }
  // provenance 越界审计：引用了任务材料集之外的 materialId → flag（不丢弃，人工核对）
  const params = parseJsonObject(row.params_json) ?? {}
  const scope = Array.isArray(params.materialIds) ? (params.materialIds as unknown[]).filter((v): v is number => typeof v === 'number') : []
  if (scope.length > 0) {
    const extraFlags: ImportFlag[] = []
    for (const contest of draft.contests) {
      const links = [contest.officialSite, contest.signupUrl, contest.submitUrl]
      for (const l of links) {
        if (l?.provenance !== undefined && !scope.includes(l.provenance.materialId)) {
          extraFlags.push({ field: 'contest.officialSite', reason: `链接 provenance 引用材料 #${l.provenance.materialId} 不在本任务材料集内，请人工核对`, excerpt: l.url.slice(0, 160) })
        }
      }
      for (const node of contest.nodes) {
        if (node.provenance !== undefined && !scope.includes(node.provenance.materialId)) {
          extraFlags.push({ field: `node.${node.label}`, reason: `节点 provenance 引用材料 #${node.provenance.materialId} 不在本任务材料集内，请人工核对`, excerpt: node.rawText ?? node.startAtText ?? '' })
        }
      }
    }
    draft = { contests: draft.contests, flags: [...draft.flags, ...extraFlags] }
  }
  const result = parseResultView(row) ?? {}
  patchJob(jobId, { resultJson: { ...result, draft } as unknown as Record<string, unknown>, stage: 'text_done', progress: 90, errorJson: null })
  await ensureValidatedDraft(jobId)
  logger.info(`contestpin agent job ${jobId}: agent result collected → draft`)
}

// ---------------------------------------------------------------------------
// contestpin:agentSubmit（自动路径）
// ---------------------------------------------------------------------------

/**
 * 提交 Agent 识别任务：一行 agent 任务 + L3 startProviderManagedSession 托管会话
 * （能力门在 L3：observed/陈旧 → AGENT_CAPABILITY_MISSING / COMMAND_NOT_EXECUTABLE，
 * 结构化拒绝回填 failed 后原样上抛——绝不静默降级，无可用自动 Provider 时两阶段
 * 模式完整可用，不用模拟成功代替闭环，docs/22 §8 设计红线）。
 */
export async function submitAgentJob(payload: ContestAgentSubmitPayload): Promise<ContestAgentSubmitResult> {
  const materialIds = validatedMaterialIds(payload.materialIds, 'agentSubmit')
  if (typeof payload.provider !== 'string' || payload.provider.trim().length === 0) {
    throw new ServiceError('BAD_PAYLOAD', 'agentSubmit: provider must be a non-empty string')
  }
  const instruction = payload.instruction !== undefined
    ? (typeof payload.instruction === 'string' ? payload.instruction : undefined)
    : undefined
  if (payload.instruction !== undefined && typeof payload.instruction !== 'string') {
    throw new ServiceError('BAD_PAYLOAD', 'agentSubmit: instruction must be a string when present')
  }

  const materials = await extractMaterialsText(materialIds)
  if (materialTextCharTotal(materials) === 0) {
    throw new ServiceError('BAD_PAYLOAD', 'agentSubmit: 材料无可提取的本地文字（图片材料不参与自动路径；请用两阶段/多模态识别或手动任务包）')
  }

  const header = buildTaskHeader(instruction)
  const body = buildMaterialSection(materials)
  // L3 面硬上限（MANAGED_SESSION_TASK_MAX_CHARS）：超限按页顺序截断并显式记录（不静默）
  const budget = MANAGED_SESSION_TASK_MAX_CHARS - header.length - 1
  if (budget <= 0) {
    throw new ServiceError('BAD_PAYLOAD', `agentSubmit: 任务头超出 L3 任务文本上限（${MANAGED_SESSION_TASK_MAX_CHARS} 字符）`)
  }
  const truncated = body.length > budget
  const task = `${header}\n${body.slice(0, Math.max(budget, 0))}`

  const db = getDatabase()
  const now = nowSec()
  const inserted = db
    .prepare(
      "INSERT INTO contest_import_jobs (contest_id, material_id, mode, stage, params_json, progress, created_at, updated_at) VALUES (NULL, NULL, 'agent', 'imported', ?, 0, ?, ?)",
    )
    .run(
      JSON.stringify({
        provider: payload.provider.trim(),
        materialIds,
        taskChars: task.length,
        taskTruncated: truncated,
        instructionChars: instruction !== undefined ? instruction.trim().slice(0, INSTRUCTION_MAX_CHARS).length : 0,
      }),
      now,
      now,
    )
  const jobId = Number(inserted.lastInsertRowid)

  try {
    const started = await startProviderManagedSession({
      provider: payload.provider.trim(),
      task,
      source: 'contestpin',
    })
    patchJob(jobId, {
      resultJson: {
        agent: {
          provider: payload.provider.trim(),
          commandId: started.commandId,
          nativeId: started.nativeId,
          sessionId: started.sessionId ?? null,
          submittedAt: nowSec(),
        },
      } as unknown as Record<string, unknown>,
      stage: 'preprocessed',
      progress: 20,
    })
    logger.info(`contestpin agent job ${jobId}: managed session started provider=${payload.provider.trim()} nativeId=${started.nativeId} commandId=${started.commandId}`)
    kickAgentWatcher(jobId)
    const row = getAgentJobRow(jobId)
    return { job: toAgentJobView(row as AgentJobRow) }
  } catch (err) {
    // 能力门/启动失败：结构化拒绝回填 failed 后原样上抛（约束 #14；不静默降级）
    const code = err instanceof ServiceError ? err.code : 'INTERNAL'
    failAgentJob(jobId, code, `自动路径不可用（${code}）：${err instanceof Error ? err.message : String(err)}`.slice(0, 400))
    throw err
  }
}

// ---------------------------------------------------------------------------
// contestpin:agentStatus（READ_ONLY）
// ---------------------------------------------------------------------------

/** agent/manual_pack 任务态投影（+ mode='agent' 托管会话状态联查，绝不猜）。 */
export function getAgentStatus(payload: ContestAgentStatusPayload): ContestAgentStatusResult {
  const db = getDatabase()
  const rows =
    payload.jobId !== undefined
      ? (db.prepare("SELECT * FROM contest_import_jobs WHERE id = ? AND mode IN ('agent','manual_pack')").all(payload.jobId) as unknown as AgentJobRow[])
      : (db.prepare("SELECT * FROM contest_import_jobs WHERE mode IN ('agent','manual_pack') ORDER BY id DESC LIMIT 50").all() as unknown as AgentJobRow[])
  if (payload.jobId !== undefined && rows.length === 0) {
    const exists = db.prepare('SELECT mode FROM contest_import_jobs WHERE id = ?').get(payload.jobId) as { mode: string } | undefined
    if (exists !== undefined) {
      throw new ServiceError('BAD_PAYLOAD', `agentStatus: 任务 ${payload.jobId} mode='${exists.mode}' 不在 agentStatus 面（请用 importStatus）`)
    }
    throw new ServiceError('NOT_FOUND', `import job ${payload.jobId} not found`)
  }
  // 托管会话状态批量联查（只读 SELECT；会话行缺失 → 'unknown'）
  const statusBySessionId = new Map<number, string>()
  for (const row of rows) {
    const sessionId = parseResultView(row)?.agent?.sessionId
    if (typeof sessionId === 'number') statusBySessionId.set(sessionId, 'unknown')
  }
  for (const sessionId of statusBySessionId.keys()) {
    const row = db.prepare('SELECT status FROM agent_sessions WHERE id = ?').get(sessionId) as { status: string } | undefined
    if (row !== undefined) statusBySessionId.set(sessionId, row.status)
  }
  return { jobs: rows.map((row) => {
    const sessionId = parseResultView(row)?.agent?.sessionId
    return toAgentJobView(row, typeof sessionId === 'number' ? statusBySessionId.get(sessionId) : undefined)
  }) }
}

// ---------------------------------------------------------------------------
// contestpin:exportPack（手动路径·导出；零凭据零 key）
// ---------------------------------------------------------------------------

/**
 * 生成任务包 JSON 落用户选择目录（destDir 由 renderer 提供，必须已存在的绝对
 * 路径目录）。形状：{ kind, version, exportedAt, instruction, contract, materials[] }
 * ——结构性零凭据零 key（不含 contestpin_configs、base_url、api key 任何字段，
 * manifest 同款红线）。
 */
export async function exportPack(payload: ContestPackExportPayload): Promise<ContestPackExportResult> {
  const materialIds = validatedMaterialIds(payload.materialIds, 'exportPack')
  if (typeof payload.destDir !== 'string' || payload.destDir.trim().length === 0) {
    throw new ServiceError('BAD_PAYLOAD', 'exportPack: destDir is required')
  }
  if (!isAbsolute(payload.destDir)) {
    throw new ServiceError('BAD_PAYLOAD', 'exportPack: destDir must be an absolute path')
  }
  const destDir = payload.destDir.trim()
  let destStat
  try {
    destStat = await stat(destDir)
  } catch {
    throw new ServiceError('BAD_PAYLOAD', `exportPack: 目标目录不存在或不可访问：${destDir}`)
  }
  if (!destStat.isDirectory()) {
    throw new ServiceError('BAD_PAYLOAD', `exportPack: 目标不是目录：${destDir}`)
  }
  const instruction = payload.instruction !== undefined && typeof payload.instruction === 'string'
    ? payload.instruction.trim().slice(0, INSTRUCTION_MAX_CHARS)
    : undefined
  if (payload.instruction !== undefined && typeof payload.instruction !== 'string') {
    throw new ServiceError('BAD_PAYLOAD', 'exportPack: instruction must be a string when present')
  }

  const materials = await extractMaterialsText(materialIds)
  const pack = {
    kind: 'contestpin-task-pack' as const,
    version: 1,
    exportedAt: nowSec(),
    ...(instruction !== undefined && instruction.length > 0 ? { instruction } : {}),
    contract: JSON_CONTRACT_PROMPT,
    materials,
  }
  const json = JSON.stringify(pack, null, 2)
  const exportPath = join(destDir, `contestpin-task-pack-${Date.now()}.json`)
  await writeFile(exportPath, json, 'utf8')
  const textChars = materialTextCharTotal(materials)
  logger.info(`contestpin pack exported: ${exportPath} materials=${materials.length} textChars=${textChars}`)
  return { exportPath, bytes: Buffer.byteLength(json, 'utf8'), materialCount: materials.length, textChars }
}

// ---------------------------------------------------------------------------
// contestpin:importPack（手动路径·导入；同一 draft 核对管线，绝不直写生产行）
// ---------------------------------------------------------------------------

/**
 * 导入任务包结果：resultText / resultPath 二选一 → parseDraftJson（同管线解析）
 * → provenance 越界 flag → 一行 manual_pack 任务 → ensureValidatedDraft 同一
 * validated→draft 落位 → 既有 draftConfirm 两段式核对（相似检测/合并/另建）。
 * 本函数零生产行写入（contests/contest_nodes 不动），不静默覆盖。
 */
export async function importPack(payload: ContestPackImportPayload): Promise<ContestPackImportResult> {
  const materialIds = validatedMaterialIds(payload.materialIds, 'importPack')
  loadMaterialRows(materialIds) // 材料存在性校验（NOT_FOUND 带缺失 id）
  if (payload.resultPath !== undefined && payload.resultText !== undefined) {
    throw new ServiceError('BAD_PAYLOAD', 'importPack: resultPath and resultText are mutually exclusive')
  }
  let text: string
  if (payload.resultPath !== undefined) {
    if (typeof payload.resultPath !== 'string' || payload.resultPath.trim().length === 0) {
      throw new ServiceError('BAD_PAYLOAD', 'importPack: resultPath must be a non-empty string when present')
    }
    let stat0
    try {
      stat0 = await stat(payload.resultPath)
    } catch {
      throw new ServiceError('NOT_FOUND', `importPack: 结果文件不存在或不可读：${payload.resultPath}`)
    }
    if (!stat0.isFile()) {
      throw new ServiceError('BAD_PAYLOAD', `importPack: 结果路径不是常规文件：${payload.resultPath}`)
    }
    if (stat0.size > PACK_RESULT_FILE_MAX_BYTES) {
      throw new ServiceError('BAD_PAYLOAD', `importPack: 结果文件超限（>${PACK_RESULT_FILE_MAX_BYTES} 字节）`)
    }
    text = await readFile(payload.resultPath, 'utf8')
  } else if (typeof payload.resultText === 'string' && payload.resultText.trim().length > 0) {
    text = payload.resultText
    if (text.length > PACK_RESULT_FILE_MAX_BYTES) {
      throw new ServiceError('BAD_PAYLOAD', `importPack: resultText 超限（>${PACK_RESULT_FILE_MAX_BYTES} 字符）`)
    }
  } else {
    throw new ServiceError('BAD_PAYLOAD', 'importPack: resultPath (string) or resultText (string) is required')
  }

  // 兼容两种来源形态：裸契约 JSON（{contests:[...]}, agent 直接回复）或任务包
  // 回填形态（{kind:'contestpin-task-pack', ..., result:{contests:[...]}}）。
  let candidate: unknown = text
  try {
    candidate = JSON.parse(text)
  } catch {
    /* parseDraftJson 的宽松提取（围栏/首尾大括号）兜底 */
  }
  let contractText = text
  if (typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)) {
    const rec = candidate as Record<string, unknown>
    if (rec.kind === 'contestpin-task-pack' && typeof rec.result === 'object' && rec.result !== null) {
      contractText = JSON.stringify(rec.result)
    }
  }

  let draft: ImportDraftView
  try {
    draft = parseDraftJson(contractText)
  } catch (err) {
    throw new ServiceError('BAD_RESPONSE', `任务包结果 JSON 解析失败：${err instanceof Error ? err.message : String(err)}；内容摘要：${text.replace(/\s+/g, ' ').slice(0, 200)}`)
  }
  // provenance 越界审计（同自动路径）：引用了 payload 材料集之外的 materialId → flag
  const extraFlags: ImportFlag[] = []
  for (const contest of draft.contests) {
    const links = [contest.officialSite, contest.signupUrl, contest.submitUrl]
    for (const l of links) {
      if (l?.provenance !== undefined && !materialIds.includes(l.provenance.materialId)) {
        extraFlags.push({ field: 'contest.officialSite', reason: `链接 provenance 引用材料 #${l.provenance.materialId} 不在导入材料集内，请人工核对`, excerpt: l.url.slice(0, 160) })
      }
    }
    for (const node of contest.nodes) {
      if (node.provenance !== undefined && !materialIds.includes(node.provenance.materialId)) {
        extraFlags.push({ field: `node.${node.label}`, reason: `节点 provenance 引用材料 #${node.provenance.materialId} 不在导入材料集内，请人工核对`, excerpt: node.rawText ?? node.startAtText ?? '' })
      }
    }
  }
  draft = { contests: draft.contests, flags: [...draft.flags, ...extraFlags] }

  const db = getDatabase()
  const now = nowSec()
  const inserted = db
    .prepare(
      "INSERT INTO contest_import_jobs (contest_id, material_id, mode, stage, params_json, result_json, progress, created_at, updated_at) VALUES (NULL, NULL, 'manual_pack', 'text_done', ?, ?, 90, ?, ?)",
    )
    .run(
      JSON.stringify({ materialIds, source: 'importPack', ...(payload.resultPath !== undefined ? { resultPath: payload.resultPath } : {}) }),
      JSON.stringify({ packResult: { textChars: text.length }, draft } as unknown as Record<string, unknown>),
      now,
      now,
    )
  const jobId = Number(inserted.lastInsertRowid)
  await ensureValidatedDraft(jobId)
  logger.info(`contestpin pack imported: job ${jobId} materials=${materialIds.join(',')} → draft`)
  const row = getAgentJobRow(jobId)
  return { job: toAgentJobView(row as AgentJobRow) }
}

// ---------------------------------------------------------------------------
// 取消（复用 contestpin:importCancel 面；handler 先调本函数，null = 非 agent 任务）
// ---------------------------------------------------------------------------

/**
 * agent 任务取消：置 cancelled（importPipeline.patchJob 同一守卫）+ watcher 取消
 * 令牌 abort + L3 createSessionAction(pause) 只中断本任务托管 turn（能力门在 L3；
 * pause 失败结构化折叠——cancel 本身不回滚，晚到回流因 stage 守卫绝不落库）。
 * 非 agent 任务返回 null（handler 回落 cancelImport）。
 */
export function cancelAgentJob(jobId: number): { cancelled: boolean; stage: ContestImportJobView['stage'] } | null {
  const row = getAgentJobRow(jobId)
  if (row === undefined || row.mode !== 'agent') return null
  if (row.stage === 'cancelled' || row.stage === 'confirmed' || row.stage === 'failed') {
    return { cancelled: false, stage: row.stage as ContestImportJobView['stage'] }
  }
  patchJob(jobId, { stage: 'cancelled', errorJson: null })
  agentControllers.get(jobId)?.abort()
  const link = parseResultView(row)?.agent
  if (link !== undefined && typeof link.sessionId === 'number') {
    void createSessionAction(link.sessionId, 'pause').catch((err) => {
      // 结构化折叠：turn 已结束/会话行缺失等场景 pause 不可执行，取消语义不受影响
      logger.info(`contestpin agent job ${jobId}: managed turn pause skipped (${err instanceof Error ? err.message : String(err)})`)
    })
  }
  logger.info(`contestpin agent job ${jobId} cancelled (watcher token + managed turn pause)`)
  return { cancelled: true, stage: 'cancelled' }
}
