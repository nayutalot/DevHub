/**
 * handlers.ts — IPC handler 注册表与网关分发（docs/04，约束 #17/#14）。
 *
 * 纯 Node 模块：零 electron import，可被 scripts/smoke.mjs 在系统 Node 下直接
 * 加载（与 services 层同一约束风格）。electron 侧胶水见 gateway.ts —— 它只把
 * ipcMain.handle(IPC_GATEWAY, ...) 接到本模块的 dispatchGatewayRequest 上。
 *
 * envelope 包装位置（二选一裁决）：统一放在本纯模块的 dispatchGatewayRequest 内，
 * 而不是 gateway.ts 胶水层。理由：请求形状校验、白名单校验、ServiceError 折叠、
 * envelope 包装全部落在这一个可被 smoke 直测的纯函数里，gateway.ts 的不可测面
 * 缩到最小（只剩 ipcMain 注册）。handler 自身按 service 语义返回裸数据或抛
 * ServiceError，由 dispatch 统一折叠为
 *   { ok: true, data } | { ok: false, error: { code, message } }
 * （约束 #14：renderer 永远收到可渲染的结构，绝不收到裸 Error / 堆栈）。
 *
 * payload 校验宽松但防炸：只在"形状不对会让下游炸裂"的点上拒绝（BAD_PAYLOAD），
 * 业务存在性校验（NOT_FOUND / DB_ERROR 等）仍归 Service 层。
 *
 * 错误码说明：docs/02 §3 枚举之外，dispatch 额外使用两个稳定 code：
 *  - BAD_PAYLOAD：请求/payload 形状不合法（docs 枚举无校验类错误码，DB_ERROR
 *    等语义不符；已在交付报告上报该扩展）；
 *  - INTERNAL：非 ServiceError 的意外异常折叠（不泄露堆栈与绝对路径）。
 * 未注册 channel 使用 docs/04 §1 的 CHANNEL_NOT_ALLOWED（文档权威，约束 #6）。
 */

import type { IpcChannel } from '../../shared/channels.ts'
import type { AssertContractCoversWhitelist, Result, ScanKind, SessionStatus } from '../../shared/types.ts'
import { logger } from '../core/logger.ts'
import { ServiceError } from '../services/internal.ts'
import {
  AGENT_LIST_LIMIT_MAX,
  AGENT_SESSION_STATUSES,
  createPairing,
  createSessionAction,
  getAgentSessionDetail,
  getDiagnostics,
  getGatewayStatus,
  listAgentEvents,
  listAgentMessages,
  listAgentProviders,
  listAgentSessions,
  listDevices,
  probeProviderById,
  restartGateway,
  revokeDevice,
  setAutoStart,
} from '../services/agentControl/agentControlService.ts'
import {
  currentAdapter,
  deleteProfile,
  listAdapters,
  listProfiles,
  saveProfile,
  switchProfile,
} from '../services/apihub/apihubService.ts'
import { isAdapterId } from '../services/apihub/adapters.ts'
import {
  cancelUpdateJob,
  checkAll,
  checkOneById,
  jobSnapshot,
  listTargets,
  requestUpdate,
} from '../services/versionCenter/versionService.ts'
import { findCatalogEntry } from '../services/versionCenter/catalog.ts'
import { dashboardSummary } from '../services/dashboardService.ts'
import { detectEnvironment, runDoctor } from '../services/environmentService.ts'
import {
  addProject,
  getProject,
  listProjects,
  openProject,
  removeProject,
  rescanProjects,
  updateProject,
} from '../services/projectService.ts'
import { cancelScan, scanStatus, startScan } from '../services/scanService.ts'
import {
  agentScans,
  companionStatus,
  deployCompanion,
  doctor,
  importSkill,
  linkStates,
  listSkills,
  removeAgent,
  repair,
  scanVault,
  scanWsl,
  syncVault,
  toggleLink,
  upsertAgent,
} from '../services/skillService.ts'
import { findByPort, listServices, refreshServices } from '../services/servicesService.ts'
import { getSetting, setSetting } from '../services/settingsService.ts'
import {
  containerAction,
  containerLogs,
  dockerOverview,
  DOCKER_LOGS_TAIL_MAX,
} from '../services/dockerService.ts'
import { knownDistroNames, wslAction, wslDistroStatsSummary, wslShutdownAll } from '../services/wslService.ts'
import {
  ARCHIVE_HISTORY_LIMIT,
  archiveHistory,
  archiveStatus,
  previewArchive,
  rollbackArchive,
  runArchive,
} from '../services/archiveService.ts'

/** scan:start 的 kind 合法值（docs/04 §2）。 */
const SCAN_KINDS: readonly ScanKind[] = ['full', 'projects', 'services', 'environment']

/**
 * docker 容器名/ID 白名单字符集：字母数字开头，仅 [A-Za-z0-9_.-]，≤128。
 * docker 名/ID 永不包含空白、引号、`$`、`;`、前导 `-`（选项注入面一并封死）。
 */
const CONTAINER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/

/** archive previewId 凭证格式（服务端 previewArchive 签发：'arc-<uuid>'）。
 * 格式不符直接 BAD_PAYLOAD，伪造/过期再由 service 层注册表校验兜底（安全规则 1）。 */
const PREVIEW_ID_PATTERN = /^arc-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** agents:sessionAction reply 文本上限（docs/14 §A.1 #6：非空 ≤4000 字符）。 */
const AGENTS_REPLY_TEXT_MAX = 4000

// ---------------------------------------------------------------------------
// payload 校验助手（宽松但防炸）
// ---------------------------------------------------------------------------

function badPayload(channel: IpcChannel, detail: string): ServiceError {
  return new ServiceError('BAD_PAYLOAD', `${channel}: ${detail}`)
}

/** undefined / null → {}（空 payload 的 channel 宽松放行）；非普通对象 → BAD_PAYLOAD。 */
function asPayloadObject(channel: IpcChannel, payload: unknown): Record<string, unknown> {
  if (payload === undefined || payload === null) return {}
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    throw badPayload(channel, 'payload must be an object')
  }
  return payload as Record<string, unknown>
}

function requireId(channel: IpcChannel, payload: Record<string, unknown>, key = 'id'): number {
  const id = payload[key]
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) {
    throw badPayload(channel, `${key} must be a positive integer`)
  }
  return id
}

function optionalPositiveInt(channel: IpcChannel, payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw badPayload(channel, `${key} must be a positive integer when present`)
  }
  return value
}

function optionalPort(channel: IpcChannel, payload: Record<string, unknown>): number | undefined {
  const port = payload.port
  if (port === undefined) return undefined
  if (typeof port !== 'number' || !Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw badPayload(channel, 'port must be an integer within 0-65535 when present')
  }
  return port
}

function optionalString(channel: IpcChannel, payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw badPayload(channel, `${key} must be a string when present`)
  }
  return value
}

function optionalBoolean(channel: IpcChannel, payload: Record<string, unknown>, key: string): boolean | undefined {
  const value = payload[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') {
    throw badPayload(channel, `${key} must be a boolean when present`)
  }
  return value
}

function requireString(channel: IpcChannel, payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  if (typeof value !== 'string') {
    throw badPayload(channel, `${key} must be a string`)
  }
  return value
}

/** 非空字符串（变操作的关键入参，如 sourceDir / fixId / skill 名）。 */
function requireNonEmptyString(channel: IpcChannel, payload: Record<string, unknown>, key: string): string {
  const value = requireString(channel, payload, key)
  if (value.trim().length === 0) {
    throw badPayload(channel, `${key} must be a non-empty string`)
  }
  return value
}

/** agentIds: number[]（正整数；skills:import 可选）。 */
function optionalAgentIds(channel: IpcChannel, payload: Record<string, unknown>): number[] | undefined {
  const value = payload.agentIds
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1)) {
    throw badPayload(channel, 'agentIds must be an array of positive integers when present')
  }
  return value as number[]
}

/** docker 容器名/ID：白名单字符集（防注入样式字符串），非空且匹配 CONTAINER_NAME_PATTERN。 */
function requireContainerName(channel: IpcChannel, payload: Record<string, unknown>, key = 'name'): string {
  const value = requireNonEmptyString(channel, payload, key)
  if (CONTAINER_NAME_PATTERN.test(value) === false) {
    throw badPayload(channel, `${key} must match [A-Za-z0-9][A-Za-z0-9_.-]{0,127} (container name or id)`)
  }
  return value
}

/** docker logs tail：非负整数（负数/非整数 BAD_PAYLOAD）；>500 截到 500（docs/09 §9 语义）。 */
function optionalLogsTail(channel: IpcChannel, payload: Record<string, unknown>): number | undefined {
  const value = payload.tail
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw badPayload(channel, 'tail must be a non-negative integer when present')
  }
  return Math.min(value, DOCKER_LOGS_TAIL_MAX)
}

/** distro 白名单校验（= 已知发行版列表，versions:update 的 handler 侧白名单同款）。 */
async function requireKnownDistro(channel: IpcChannel, distro: string): Promise<string> {
  const known = await knownDistroNames()
  if (known.includes(distro) === false) {
    throw badPayload(
      channel,
      known.length > 0
        ? `distro must be one of the known distributions (got: ${distro}; known: ${known.join(', ')})`
        : `distro must be one of the known distributions (got: ${distro}; wsl.exe probe returned none)`,
    )
  }
  return distro
}

/** agents 列表类 limit：正整数 ≤200（docs/14 §A.1；>200 BAD_PAYLOAD，archive:history 同款）。 */
function optionalListLimit(channel: IpcChannel, payload: Record<string, unknown>): number | undefined {
  const value = optionalPositiveInt(channel, payload, 'limit')
  if (value !== undefined && value > AGENT_LIST_LIMIT_MAX) {
    throw badPayload(channel, `limit must be <= ${AGENT_LIST_LIMIT_MAX}`)
  }
  return value
}

/** agents:sessions 的 status 白名单（9 值全集，docs/12 §4）。 */
function optionalSessionStatus(channel: IpcChannel, payload: Record<string, unknown>): SessionStatus | undefined {
  const value = optionalString(channel, payload, 'status')
  if (value === undefined) return undefined
  if ((AGENT_SESSION_STATUSES as readonly string[]).includes(value) === false) {
    throw badPayload(channel, `status must be one of: ${AGENT_SESSION_STATUSES.join(' | ')}`)
  }
  return value as SessionStatus
}

/** agents:sessionAction reply 文本：非空 ≤4000 字符（docs/14 §A.1 #6）。 */
function requireReplyText(channel: IpcChannel, payload: Record<string, unknown>): string {
  const value = requireNonEmptyString(channel, payload, 'text')
  if (value.length > AGENTS_REPLY_TEXT_MAX) {
    throw badPayload(channel, `text must be <= ${AGENTS_REPLY_TEXT_MAX} characters`)
  }
  return value
}

// ---------------------------------------------------------------------------
// 注册表与分发（纯函数；gateway.ts 只做 electron 接线）
// ---------------------------------------------------------------------------

export type ChannelHandler = (payload: unknown) => Promise<unknown>

/** 编译期断言：ChannelContract 覆盖且仅覆盖白名单 channel（漏配一行即 tsc 报错）。 */
export const contractCoversWhitelist: AssertContractCoversWhitelist = true

/**
 * channel → handler 注册表。键类型为 IpcChannel（编译期强制白名单 channel
 * 全覆盖：缺一条 / 多一条都是类型错误，权威清单见 shared/channels.ts ——
 * Phase 1 21 条 + S2 skills 14 条 = 35 + S3 apihub 6 条 + versions 4 条 = 45
 * + S4 docker 3 条 + wsl 2 条 = 50 + S5 archive 5 条 = 55 + AC2 agents 13 条 = 68
 * + 夜间#1 versions:cancel / agents:probeProvider = 70）。
 */
export type HandlerRegistry = Record<IpcChannel, ChannelHandler>

export interface HandlerDeps {
  /** 注入的版本号（main 进程传 app.getVersion()；本模块不 import electron）。 */
  appVersion: string
}

function errEnvelope(code: string, message: string): Result<never> {
  return { ok: false, error: { code, message } }
}

/**
 * 网关分发（纯函数，永不向调用方抛异常，约束 #14）：
 * 请求形状校验 → 白名单（CHANNEL_NOT_ALLOWED）→ 调 handler → 统一 envelope。
 * ServiceError 按 code 原样折叠；非 ServiceError 意外异常折叠为 INTERNAL，
 * 给 renderer 的 message 不含堆栈与绝对路径细节，细节只进主进程日志。
 */
export async function dispatchGatewayRequest(
  registry: HandlerRegistry,
  request: unknown,
): Promise<Result<unknown>> {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return errEnvelope('BAD_PAYLOAD', 'gateway request must be an object of shape { channel, payload? }')
  }
  const record = request as { channel?: unknown; payload?: unknown }
  if (typeof record.channel !== 'string') {
    return errEnvelope('BAD_PAYLOAD', 'gateway request field "channel" must be a string')
  }
  // Object.hasOwn 防原型链键（__proto__ / constructor 等）绕过白名单
  const handler = Object.hasOwn(registry, record.channel) ? registry[record.channel as IpcChannel] : undefined
  if (handler === undefined) {
    return errEnvelope('CHANNEL_NOT_ALLOWED', `channel is not in the gateway whitelist: ${record.channel}`)
  }
  try {
    const data = await handler(record.payload)
    return { ok: true, data }
  } catch (err) {
    if (err instanceof ServiceError) {
      logger.warn(`gateway ${record.channel}: ${err.code}: ${err.message}`)
      return errEnvelope(err.code, err.message)
    }
    logger.error(`gateway ${record.channel}: unexpected error: ${err instanceof Error ? err.message : String(err)}`)
    return errEnvelope('INTERNAL', 'unexpected internal error while handling the request')
  }
}

/**
 * 构造白名单全部 channel 的 handler 注册表。所有 handler 签名统一为
 * (payload: unknown) => Promise<unknown>：内部完成宽松 payload 校验后调用
 * Service 层（约束 #16/#20：IPC 层不触碰 DB 与进程，只经 Service）。
 */
export function createHandlerRegistry(deps: HandlerDeps): HandlerRegistry {
  return {
    // --- scan（docs/04 §2 扫描） ------------------------------------------
    'scan:start': async (payload) => {
      const p = asPayloadObject('scan:start', payload)
      const kind = p.kind
      if (typeof kind !== 'string' || !SCAN_KINDS.includes(kind as ScanKind)) {
        throw badPayload('scan:start', 'kind must be one of: full | projects | services | environment')
      }
      return startScan(kind as ScanKind)
    },
    'scan:status': async (payload) => {
      const p = asPayloadObject('scan:status', payload)
      return scanStatus(optionalPositiveInt('scan:status', p, 'scanId'))
    },
    'scan:cancel': async (payload) => {
      // 契约携带 scanId（docs/04），但取消语义是进程级"至多一个 running 扫描"，
      // 形状校验后不透传，避免暴露契约之外的按 id 取消假象
      const p = asPayloadObject('scan:cancel', payload)
      optionalPositiveInt('scan:cancel', p, 'scanId')
      return cancelScan()
    },

    // --- projects CRUD ----------------------------------------------------
    'projects:list': async () => listProjects(),
    'projects:get': async (payload) => {
      const p = asPayloadObject('projects:get', payload)
      return getProject(requireId('projects:get', p))
    },
    'projects:add': async (payload) => {
      const p = asPayloadObject('projects:add', payload)
      return addProject({
        winPath: optionalString('projects:add', p, 'winPath'),
        wslPath: optionalString('projects:add', p, 'wslPath'),
        name: optionalString('projects:add', p, 'name'),
        description: optionalString('projects:add', p, 'description'),
        runtimeHint: optionalString('projects:add', p, 'runtimeHint'),
      })
    },
    'projects:remove': async (payload) => {
      const p = asPayloadObject('projects:remove', payload)
      return removeProject(requireId('projects:remove', p))
    },
    'projects:rescan': async (payload) => {
      const p = asPayloadObject('projects:rescan', payload)
      return rescanProjects(optionalPositiveInt('projects:rescan', p, 'id'))
    },
    'projects:update': async (payload) => {
      const p = asPayloadObject('projects:update', payload)
      return updateProject({
        id: requireId('projects:update', p),
        name: optionalString('projects:update', p, 'name'),
        description: optionalString('projects:update', p, 'description'),
        winPath: optionalString('projects:update', p, 'winPath'),
        wslPath: optionalString('projects:update', p, 'wslPath'),
        runtimeHint: optionalString('projects:update', p, 'runtimeHint'),
      })
    },

    // --- projects open（经 exec.launchViaStartProcess，约束 #12） -----------
    'projects:openFolder': async (payload) => {
      const p = asPayloadObject('projects:openFolder', payload)
      return openProject('folder', requireId('projects:openFolder', p))
    },
    'projects:openVSCode': async (payload) => {
      const p = asPayloadObject('projects:openVSCode', payload)
      return openProject('vscode', requireId('projects:openVSCode', p), {
        wsl: optionalBoolean('projects:openVSCode', p, 'wsl'),
      })
    },
    'projects:openTerminal': async (payload) => {
      const p = asPayloadObject('projects:openTerminal', payload)
      return openProject('terminal', requireId('projects:openTerminal', p), {
        wsl: optionalBoolean('projects:openTerminal', p, 'wsl'),
      })
    },
    'projects:openWSL': async (payload) => {
      const p = asPayloadObject('projects:openWSL', payload)
      return openProject('wsl', requireId('projects:openWSL', p))
    },

    // --- environment --------------------------------------------------------
    'environment:detect': async () => detectEnvironment(),
    'environment:doctor': async () => runDoctor(),

    // --- services -----------------------------------------------------------
    'services:list': async (payload) => {
      const p = asPayloadObject('services:list', payload)
      const port = optionalPort('services:list', p)
      return port !== undefined ? findByPort(port) : listServices()
    },
    'services:refresh': async () => {
      // Step 5 决议：返回 { records, scanId } —— records 为本轮写入/更新的记录，
      // scanId 取 refreshServices 刚写入的 kind='services' 扫描行（docs/04 已同步）
      const records = await refreshServices()
      const latest = scanStatus()
      return { records, scanId: latest.scanId }
    },

    // --- dashboard / settings / app ----------------------------------------
    'dashboard:summary': async () => dashboardSummary(),
    'settings:get': async (payload) => {
      const p = asPayloadObject('settings:get', payload)
      const key = requireString('settings:get', p, 'key')
      const value = getSetting(key) // key 白名单（scan_root/theme）由 settingsService 强制
      // 种子数据保证白名单 key 常在；未写入时按空串返回，维持契约 value: string
      return { key, value: value ?? '' }
    },
    'settings:set': async (payload) => {
      const p = asPayloadObject('settings:set', payload)
      const key = requireString('settings:set', p, 'key')
      setSetting(key, requireString('settings:set', p, 'value'))
      // AC3 监控启停接线（docs/16 §1 AC3 行）：agents_monitor_enabled 翻转即时生效，
      // 监控任务随之 start/stop（L3 内挂接，幂等）；托盘/视图接线属 AC5。
      if (key === 'agents_monitor_enabled') {
        void import('../services/agentControl/agentControlService.ts').then((svc) => svc.syncMonitorTasks()).catch(() => {})
      }
      // AC6 Gateway 接线（docs/14 §A.1 #11 + docs/12 §9）：gateway_enabled/
      // gateway_port 翻转即时生效——按 settings 真值收敛监听（enabled → 停旧 +
      // 重绑端口；disabled → 零监听），照 agents_monitor_enabled 先例。启动失败
      // （如 8746–8755 全占）不回滚 settings，经 gatewayStatus.lastError 结构化可见。
      if (key === 'gateway_enabled' || key === 'gateway_port') {
        void import('../services/agentControl/gateway/httpServer.ts')
          .then((gw) => gw.applyGatewaySettings())
          .catch(() => {})
      }
      return { saved: true as const }
    },
    'app:version': async () => ({
      appVersion: deps.appVersion,
      electronVersion: process.versions.electron ?? '',
      nodeVersion: process.versions.node,
    }),

    // --- skills（S2 批次，docs/09 §9；变操作 payload 严格校验） -----------------
    'skills:scan': async () => scanVault(),
    'skills:scanWsl': async () => scanWsl(),
    'skills:list': async () => listSkills(),
    'skills:agents': async () => agentScans(),
    'skills:linkStates': async (payload) => {
      const p = asPayloadObject('skills:linkStates', payload)
      return linkStates(optionalPositiveInt('skills:linkStates', p, 'agentId'))
    },
    'skills:toggleLink': async (payload) => {
      const p = asPayloadObject('skills:toggleLink', payload)
      const enable = p.enable
      if (typeof enable !== 'boolean') {
        throw badPayload('skills:toggleLink', 'enable must be a boolean')
      }
      return toggleLink(requireId('skills:toggleLink', p, 'agentId'), requireNonEmptyString('skills:toggleLink', p, 'skill'), enable, optionalBoolean('skills:toggleLink', p, 'confirmed'))
    },
    'skills:import': async (payload) => {
      const p = asPayloadObject('skills:import', payload)
      return importSkill(
        requireNonEmptyString('skills:import', p, 'sourceDir'),
        optionalAgentIds('skills:import', p),
        optionalBoolean('skills:import', p, 'confirmed'),
      )
    },
    'skills:doctor': async (payload) => {
      const p = asPayloadObject('skills:doctor', payload)
      return doctor(optionalPositiveInt('skills:doctor', p, 'agentId'))
    },
    'skills:repair': async (payload) => {
      const p = asPayloadObject('skills:repair', payload)
      const fixPayload = p.payload
      if (fixPayload !== undefined && (typeof fixPayload !== 'object' || fixPayload === null || Array.isArray(fixPayload))) {
        throw badPayload('skills:repair', 'payload must be an object when present')
      }
      return repair(requireNonEmptyString('skills:repair', p, 'fixId'), fixPayload as Record<string, unknown> | undefined, optionalBoolean('skills:repair', p, 'confirmed'))
    },
    'skills:sync': async (payload) => {
      const p = asPayloadObject('skills:sync', payload)
      return syncVault(optionalBoolean('skills:sync', p, 'confirmed'))
    },
    'skills:agent.upsert': async (payload) => {
      const p = asPayloadObject('skills:agent.upsert', payload)
      const include = p.include
      if (!Array.isArray(include)) {
        throw badPayload('skills:agent.upsert', 'include must be an array of skill names (or ["*"])')
      }
      const platform = p.platform
      if (platform !== 'windows' && platform !== 'linux') {
        throw badPayload('skills:agent.upsert', 'platform must be "windows" or "linux"')
      }
      const agentsDir = optionalString('skills:agent.upsert', p, 'agentsDir')
      return upsertAgent({
        ...(p.id !== undefined ? { id: optionalPositiveInt('skills:agent.upsert', p, 'id') } : {}),
        name: requireNonEmptyString('skills:agent.upsert', p, 'name'),
        platform,
        skillsDir: requireNonEmptyString('skills:agent.upsert', p, 'skillsDir'),
        ...(agentsDir !== undefined ? { agentsDir } : {}),
        include: include.map((x) => String(x)),
        enabled: optionalBoolean('skills:agent.upsert', p, 'enabled') ?? true,
      })
    },
    'skills:agent.remove': async (payload) => {
      const p = asPayloadObject('skills:agent.remove', payload)
      return removeAgent(requireId('skills:agent.remove', p))
    },
    'skills:companion.status': async () => companionStatus(),
    'skills:companion.deploy': async (payload) => {
      const p = asPayloadObject('skills:companion.deploy', payload)
      return deployCompanion(optionalBoolean('skills:companion.deploy', p, 'confirmed'))
    },

    // --- apihub（S3 批次，docs/09 §9；provider 枚举白名单 + profileId≥1 严格校验） ---
    'apihub:adapters': async () => ({ adapters: listAdapters() }),
    'apihub:current': async (payload) => {
      const p = asPayloadObject('apihub:current', payload)
      const adapterId = p.adapterId
      if (!isAdapterId(adapterId)) {
        throw badPayload('apihub:current', 'adapterId must be one of: claude-cli | claude-desktop | codex | grok | kimi | zcode | deepseek')
      }
      return currentAdapter(adapterId)
    },
    'apihub:profiles': async (payload) => {
      const p = asPayloadObject('apihub:profiles', payload)
      const adapterId = p.adapterId
      if (!isAdapterId(adapterId)) {
        throw badPayload('apihub:profiles', 'adapterId must be one of: claude-cli | claude-desktop | codex | grok | kimi | zcode | deepseek')
      }
      return listProfiles(adapterId)
    },
    'apihub:saveProfile': async (payload) => {
      const p = asPayloadObject('apihub:saveProfile', payload)
      const input = p.input
      if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        throw badPayload('apihub:saveProfile', 'input must be an object of shape { adapterId, id?, name, fields }')
      }
      const rec = input as Record<string, unknown>
      if (!isAdapterId(rec.adapterId)) {
        throw badPayload('apihub:saveProfile', 'input.adapterId must be a valid adapter id')
      }
      const fields = rec.fields
      if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) {
        throw badPayload('apihub:saveProfile', 'input.fields must be an object of string values')
      }
      const fieldsRecord: Record<string, string> = {}
      for (const [k, v] of Object.entries(fields as Record<string, unknown>)) {
        if (typeof v !== 'string') throw badPayload('apihub:saveProfile', `input.fields.${k} must be a string`)
        fieldsRecord[k] = v
      }
      const apiKeyPlain = optionalString('apihub:saveProfile', p, 'apiKeyPlain')
      return saveProfile(
        {
          adapterId: rec.adapterId,
          ...(rec.id !== undefined ? { id: requireId('apihub:saveProfile', rec, 'id') } : {}),
          name: requireNonEmptyString('apihub:saveProfile', rec, 'name'),
          fields: fieldsRecord,
        },
        apiKeyPlain,
      )
    },
    'apihub:deleteProfile': async (payload) => {
      const p = asPayloadObject('apihub:deleteProfile', payload)
      const adapterId = p.adapterId
      if (!isAdapterId(adapterId)) {
        throw badPayload('apihub:deleteProfile', 'adapterId must be a valid adapter id')
      }
      return deleteProfile(adapterId, requireId('apihub:deleteProfile', p))
    },
    'apihub:switch': async (payload) => {
      const p = asPayloadObject('apihub:switch', payload)
      const adapterId = p.adapterId
      if (!isAdapterId(adapterId)) {
        throw badPayload('apihub:switch', 'adapterId must be a valid adapter id')
      }
      const killPids = p.killPids
      if (killPids !== undefined) {
        if (!Array.isArray(killPids) || killPids.some((v) => typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1)) {
          throw badPayload('apihub:switch', 'killPids must be an array of positive integers when present')
        }
      }
      return switchProfile(adapterId, requireId('apihub:switch', p), optionalBoolean('apihub:switch', p, 'confirmed'), {
        ...(killPids !== undefined ? { killPids: killPids as number[] } : {}),
      })
    },

    // --- versions（S3 批次，docs/09 §9；catalog id 白名单校验） -------------------
    'versions:list': async () => listTargets(),
    'versions:check': async (payload) => {
      const p = asPayloadObject('versions:check', payload)
      const id = optionalString('versions:check', p, 'id')
      return id !== undefined ? checkOneById(id) : checkAll()
    },
    'versions:update': async (payload) => {
      const p = asPayloadObject('versions:update', payload)
      const id = requireNonEmptyString('versions:update', p, 'id')
      // 形状校验后先做 catalog 白名单（未知 id 语义上更接近 BAD_PAYLOAD 而非库存 NOT_FOUND）
      if (findCatalogEntry(id) === undefined) {
        throw badPayload('versions:update', `id must be a catalog entry id (got: ${id})`)
      }
      return requestUpdate(id, optionalBoolean('versions:update', p, 'confirmed'))
    },
    'versions:job': async (payload) => {
      const p = asPayloadObject('versions:job', payload)
      return jobSnapshot(requireNonEmptyString('versions:job', p, 'jobId'))
    },
    // 夜间#1 批次：versions:cancel（docs/09 §7.2 cancelled 分支主动取消；缺省 jobId =
    // 取消当前唯一活跃任务——多活跃时不指定 jobId 在 service 侧 BAD_PAYLOAD 消歧）
    'versions:cancel': async (payload) => {
      const p = asPayloadObject('versions:cancel', payload)
      const jobId = optionalString('versions:cancel', p, 'jobId')
      if (jobId !== undefined && jobId.trim().length === 0) {
        throw badPayload('versions:cancel', 'jobId must be a non-empty string when present')
      }
      return cancelUpdateJob(jobId)
    },

    // --- docker（S4 批次，docs/09 §9 按文档命名 overview/logs/action；daemon 不可用
    // 一律结构化降级；action 为 CONFIRM_REQUIRED 两段式，name 白名单字符集校验；
    // remove 为夜间#1 批次追加（docs/09 §8.3 DOUBLE_CONFIRM 档，UI 侧名称匹配）） ---
    'docker:overview': async () => dockerOverview(),
    'docker:logs': async (payload) => {
      const p = asPayloadObject('docker:logs', payload)
      const tail = optionalLogsTail('docker:logs', p)
      const since = optionalPositiveInt('docker:logs', p, 'since')
      return containerLogs(requireContainerName('docker:logs', p), {
        ...(tail !== undefined ? { tail } : {}),
        ...(since !== undefined ? { since } : {}),
      })
    },
    'docker:action': async (payload) => {
      const p = asPayloadObject('docker:action', payload)
      const action = p.action
      if (action !== 'start' && action !== 'stop' && action !== 'restart' && action !== 'remove') {
        throw badPayload('docker:action', 'action must be one of: start | stop | restart | remove')
      }
      return containerAction(requireContainerName('docker:action', p), action, optionalBoolean('docker:action', p, 'confirmed'))
    },

    // --- wsl（S4 批次，docs/09 §8.2/§9；distro 白名单 = 已知发行版列表；terminate
    // 为 CONFIRM_REQUIRED 两段式，boot 无害直接执行；shutdownAll 为夜间#1 批次追加
    // （docs/09 §8.2 二次确认文案，全停语义，无 distro 参数）） ---
    'wsl:action': async (payload) => {
      const p = asPayloadObject('wsl:action', payload)
      const action = p.action
      if (action !== 'terminate' && action !== 'boot' && action !== 'shutdownAll') {
        throw badPayload('wsl:action', 'action must be one of: terminate | boot | shutdownAll')
      }
      if (action === 'shutdownAll') {
        // 全停语义：不接受 distro 参数（防止"看起来像单发行版关停"的误导）
        if (p.distro !== undefined) {
          throw badPayload('wsl:action', 'shutdownAll stops every distro and takes no distro parameter')
        }
        return wslShutdownAll(optionalBoolean('wsl:action', p, 'confirmed'))
      }
      const distro = await requireKnownDistro('wsl:action', requireNonEmptyString('wsl:action', p, 'distro'))
      return wslAction(distro, action, optionalBoolean('wsl:action', p, 'confirmed'))
    },
    'wsl:distroStats': async (payload) => {
      const p = asPayloadObject('wsl:distroStats', payload)
      const distro = optionalString('wsl:distroStats', p, 'distro')
      if (distro !== undefined) {
        if (distro.trim().length === 0) {
          throw badPayload('wsl:distroStats', 'distro must be a non-empty string when present')
        }
        await requireKnownDistro('wsl:distroStats', distro)
      }
      return wslDistroStatsSummary(distro)
    },

    // --- archive（S5 批次，docs/10 §11；preview 强制 dry-run + run 两段式） --------
    'archive:preview': async (payload) => {
      const p = asPayloadObject('archive:preview', payload)
      const destRoot = optionalString('archive:preview', p, 'destRoot')
      return previewArchive(requireId('archive:preview', p, 'projectId'), destRoot !== undefined ? { destRoot } : {})
    },
    'archive:run': async (payload) => {
      const p = asPayloadObject('archive:run', payload)
      const killPids = p.killPids
      if (killPids !== undefined) {
        if (!Array.isArray(killPids) || killPids.some((v) => typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1)) {
          throw badPayload('archive:run', 'killPids must be an array of positive integers when present')
        }
      }
      return runArchive(
        requirePreviewId('archive:run', p),
        optionalBoolean('archive:run', p, 'confirmed'),
        killPids as number[] | undefined,
      )
    },
    'archive:history': async (payload) => {
      const p = asPayloadObject('archive:history', payload)
      const limit = optionalPositiveInt('archive:history', p, 'limit')
      // 上限语义在 service（ARCHIVE_HISTORY_LIMIT=100）处裁剪
      if (limit !== undefined && limit > ARCHIVE_HISTORY_LIMIT) {
        throw badPayload('archive:history', `limit must be <= ${ARCHIVE_HISTORY_LIMIT}`)
      }
      return archiveHistory(limit)
    },
    'archive:rollback': async (payload) => {
      const p = asPayloadObject('archive:rollback', payload)
      return rollbackArchive(requireId('archive:rollback', p, 'runId'), optionalBoolean('archive:rollback', p, 'confirmed'))
    },
    'archive:status': async (payload) => {
      const p = asPayloadObject('archive:status', payload)
      return archiveStatus(requirePreviewId('archive:status', p))
    },

    // --- agents（AC2 批次，docs/14 §A.1 13 条；全部轮询 channel，docs/14 §A.3。
    // 读类查 004 新表真实返回（空表 → 空态）；sessionAction/pairingCreate/
    // gatewayRestart/setAutoStart 的 AC2 深度边界见 agentControlService 文件头） ---
    'agents:providers': async () => listAgentProviders(),
    'agents:sessions': async (payload) => {
      const p = asPayloadObject('agents:sessions', payload)
      return listAgentSessions({
        providerId: optionalPositiveInt('agents:sessions', p, 'providerId'),
        projectId: optionalPositiveInt('agents:sessions', p, 'projectId'),
        status: optionalSessionStatus('agents:sessions', p),
        limit: optionalListLimit('agents:sessions', p),
        // ux 批 A（R2/R3）：parentId 子会话页；includeArchived 归档可见
        parentId: optionalPositiveInt('agents:sessions', p, 'parentId'),
        includeArchived: optionalBoolean('agents:sessions', p, 'includeArchived'),
      })
    },
    'agents:sessionDetail': async (payload) => {
      const p = asPayloadObject('agents:sessionDetail', payload)
      return getAgentSessionDetail(requireId('agents:sessionDetail', p, 'sessionId'))
    },
    'agents:messages': async (payload) => {
      const p = asPayloadObject('agents:messages', payload)
      return listAgentMessages({
        sessionId: requireId('agents:messages', p, 'sessionId'),
        after: optionalPositiveInt('agents:messages', p, 'after'),
        // ux 批 A（R10）：尾部取数（last/before + prevAfter）；与 after 互斥在 L3 校验
        before: optionalPositiveInt('agents:messages', p, 'before'),
        last: optionalPositiveInt('agents:messages', p, 'last'),
        limit: optionalListLimit('agents:messages', p),
      })
    },
    'agents:events': async (payload) => {
      const p = asPayloadObject('agents:events', payload)
      return listAgentEvents({
        after: optionalPositiveInt('agents:events', p, 'after'),
        providerId: optionalPositiveInt('agents:events', p, 'providerId'),
        sessionId: optionalPositiveInt('agents:events', p, 'sessionId'),
        limit: optionalListLimit('agents:events', p),
      })
    },
    'agents:sessionAction': async (payload) => {
      const p = asPayloadObject('agents:sessionAction', payload)
      const action = p.action
      if (action !== 'reply' && action !== 'pause' && action !== 'resume') {
        throw badPayload('agents:sessionAction', 'action must be one of: reply | pause | resume')
      }
      const text = action === 'reply' ? requireReplyText('agents:sessionAction', p) : optionalString('agents:sessionAction', p, 'text')
      return createSessionAction(requireId('agents:sessionAction', p, 'sessionId'), action, text)
    },
    'agents:pairingCreate': async (payload) => {
      const p = asPayloadObject('agents:pairingCreate', payload)
      // AC6：进程内直调真实签发（docs/14 §B.1 注）；enabled=0 → GATEWAY_DISABLED
      return await createPairing(optionalString('agents:pairingCreate', p, 'deviceName'))
    },
    'agents:devices': async () => listDevices(),
    'agents:deviceRevoke': async (payload) => {
      const p = asPayloadObject('agents:deviceRevoke', payload)
      return revokeDevice(requireId('agents:deviceRevoke', p, 'deviceId'), optionalBoolean('agents:deviceRevoke', p, 'confirmed'))
    },
    'agents:gatewayStatus': async () => getGatewayStatus(),
    'agents:gatewayRestart': async (payload) => {
      const p = asPayloadObject('agents:gatewayRestart', payload)
      // AC6：confirmed → 真实重启监听（重读 settings；端口全占 → GATEWAY_PORT_IN_USE）
      return await restartGateway(optionalBoolean('agents:gatewayRestart', p, 'confirmed'))
    },
    'agents:setAutoStart': async (payload) => {
      const p = asPayloadObject('agents:setAutoStart', payload)
      const enabled = p.enabled
      if (typeof enabled !== 'boolean') {
        throw badPayload('agents:setAutoStart', 'enabled must be a boolean')
      }
      return setAutoStart(enabled)
    },
    'agents:diagnostics': async () => getDiagnostics(),
    // 夜间#1 批次：per-provider 单独重探（UX 验收 backlog，known-limitations §3.2；
    // force 语义：绕过 60s 节流，probeHealth+落库+该家会话快照强刷；未注册 → NOT_FOUND）
    'agents:probeProvider': async (payload) => {
      const p = asPayloadObject('agents:probeProvider', payload)
      return probeProviderById(requireId('agents:probeProvider', p, 'providerId'))
    },
  }
}

/** archive previewId 凭证：PREVIEW_ID_PATTERN 之外一律 BAD_PAYLOAD。 */
function requirePreviewId(channel: IpcChannel, payload: Record<string, unknown>): string {
  const value = requireNonEmptyString(channel, payload, 'previewId')
  if (PREVIEW_ID_PATTERN.test(value) === false) {
    throw badPayload(channel, 'previewId must be an arc-<uuid> token issued by archive:preview')
  }
  return value
}
