/**
 * agentControlService.ts — L3 编排入口（docs/12 §1/§9：13 条 IPC handler 的业务
 * 实现，唯一写库层延伸，约束 #20）。
 *
 * AC2 实现深度边界（母智能体裁决，docs/16 §1 AC2 行）：
 * - 读类 8 条（providers/sessions/sessionDetail/messages/events/devices/
 *   gatewayStatus/diagnostics）：查 004 新表真实返回；本批表为空 → 空列表/空态，
 *   gatewayStatus 返回 settings 真值 + running:false。
 * - agents:sessionAction：AC2 无任何能力验证 → 服务端能力门真实生效，
 *   返回 COMMAND_NOT_EXECUTABLE（结构化，语义真实：无已验证能力）。
 * - agents:pairingCreate：gateway_enabled 默认 0 → GATEWAY_DISABLED（远程面未启用）。
 * - agents:deviceRevoke：两段式真实实现（confirmRequired+impacts / 撤销 + 审计落库；
 *   活跃 WS 断开留 AC6）。
 * - agents:gatewayRestart：两段式；启动监听属 AC6，禁用态/运行时未接线 → GATEWAY_DISABLED。
 * - agents:setAutoStart：写 settings login_autostart 真实生效；app.setLoginItemSettings
 *   即时应用已随 AC5 落地（AutoStartApplier 注入位，docs/12 §10）。
 * - 配对码签发/核销等审计基础写函数留 AC6（本批仅 deviceRevoke 所需审计写入）。
 *
 * electron-free：零 electron import，可被 smoke 在系统 Node 下直接加载；
 * 一切 SQL 参数绑定（约束 #11）；错误一律 ServiceError（约束 #14）。
 */

import { randomUUID } from 'node:crypto'
import { getDatabase } from '../../db/index.ts'
import type {
  AgentProviderId,
  AgentCapability,
  AgentCapabilitySet,
  AgentDeviceRevokeResult,
  AgentDeviceRevokeStart,
  AgentDeviceView,
  AgentDiagnosticsResult,
  AgentEventView,
  AgentGatewayRestartResult,
  AgentGatewayRestartStart,
  AgentHealth,
  AgentMessageView,
  AgentPairingCreateResult,
  AgentProbeProviderResult,
  AgentProvidersResult,
  AgentProviderView,
  AgentSessionActionResult,
  AgentSessionView,
  AgentSessionsResult,
  AgentEventsResult,
  AgentMessagesResult,
  EventDeliveryState,
  GatewayStatusView,
  SessionMode,
  SessionStatus,
} from '../../../shared/types.ts'
import { ServiceError, dbVal, normalizePathKey, nowSec } from '../internal.ts'
import { getSetting, setSetting } from '../settingsService.ts'
import { registerResource, relate } from '../resourceGraph.ts'
import { cancelAllMonitorTasks, getMonitorTask } from './monitorRegistry.ts'
import { redactText } from './redact.ts'
import { parseSegmentsJson } from './messageSegments.ts'
import { recordLatencySample } from './latencyStats.ts'
import {
  FINISHED_STATUSES,
  recordCommandResult,
  recordEvent,
  recordWaitingInputEvent,
} from './eventPipeline.ts'
import { computeNatPierceStatus, refreshNatPierceStatus } from './natpierce.ts'
import { generateDeviceToken, sha256Hex } from './gateway/auth.ts'
import { projectRelayStatus } from './relayClient/statusProjector.ts'
import {
  AGENT_PROVIDER_CATALOG,
  WIRED_PROVIDER_IDS,
  clearProviderOverrides,
  getProviderInstance,
  setProviderOverride,
} from './providerRegistry.ts'
import type {
  EventSink,
  ProviderDiagnosticsInfo,
  RedactedMessage,
  SessionRef,
  SessionSnapshot,
} from './providerRegistry.ts'

export { clearProviderOverrides, setProviderOverride }

/** AC2 会话状态 9 值全集（docs/12 §4；DB 层为注释枚举，docs/13 §4.2）。handler 白名单校验复用。 */
export const AGENT_SESSION_STATUSES: readonly SessionStatus[] = [
  'running',
  'completed',
  'failed',
  'waiting_input',
  'approval_required',
  'paused',
  'connection_lost',
  'stopped',
  'unknown',
]

/** 健康四态（agent_providers.health 注释枚举，docs/13 §4.1）。 */
const PROVIDER_HEALTH: readonly AgentHealth[] = ['ok', 'degraded', 'unavailable', 'unknown']

/** 能力验证有效期（docs/12 §5：verifiedAt 超过 300s 视为过期，收缩为空集）。 */
const CAPABILITY_TTL_SEC = 300

/** 列表类 channel 的统一上限（docs/14 §A.1：limit ≤200）。handler 白名单校验复用。 */
export const AGENT_LIST_LIMIT_MAX = 200
/** 列表类 channel 缺省页大小（sessions 契约缺省 100；messages/events 沿用同值）。 */
const LIST_LIMIT_DEFAULT = 100

/** 应用效果上限：>200 由 handler 以 BAD_PAYLOAD 拒绝，这里只兜底缺省。 */
function effectiveLimit(limit: number | undefined): number {
  return Math.min(limit ?? LIST_LIMIT_DEFAULT, AGENT_LIST_LIMIT_MAX)
}

// ---------------------------------------------------------------------------
// 行类型（snake_case，docs/13 §4 DDL）
// ---------------------------------------------------------------------------

interface ProviderRow {
  id: number
  provider: string
  display_name: string
  installed: number
  version: string | null
  exe_path: string | null
  health: string
  health_detail: string | null
  capabilities_json: string
  enabled: number
  last_probe_at: number | null
  created_at: number
  updated_at: number
}

interface SessionRow {
  id: number
  provider_id: number
  native_id: string
  session_mode: string
  project_id: number | null
  workdir: string | null
  title: string | null
  status: string
  status_detail: string | null
  started_at: number | null
  last_activity_at: number | null
  ended_at: number | null
  /** 005 起可选列（R2 父子链 / R3 归档）。 */
  parent_session_id: number | null
  archived_at: number | null
  created_at: number
  updated_at: number
}

interface MessageRow {
  id: number
  session_id: number
  native_msg_id: string | null
  role: string
  content_redacted: string
  source_ref: string | null
  seq_in_session: number | null
  occurred_at: number | null
  /** 005 起可选列（R1 分段投影 JSON；NULL = 无结构 → 整段 text）。 */
  segments_json: string | null
  created_at: number
}

interface EventRow {
  id: number
  provider_id: number | null
  session_id: number | null
  event_type: string
  event_id: string
  payload_json: string
  summary: string | null
  delivery_state: string
  delivered_at: number | null
  acked_at: number | null
  created_at: number
}

interface DeviceRow {
  id: number
  device_name: string
  platform: string
  token_hash: string
  token_version: number
  status: string
  paired_at: number
  last_seen_at: number | null
  revoked_at: number | null
  created_at: number
  updated_at: number
}

// ---------------------------------------------------------------------------
// settings 读取（gateway/monitor/autostart 三组真值）
// ---------------------------------------------------------------------------

function monitorEnabledSetting(): boolean {
  // 默认 1（004 种子）；缺行视为开（docs/13 §6），只有显式 '0' 才是关。
  return getSetting('agents_monitor_enabled') !== '0'
}

function gatewayEnabledSetting(): boolean {
  // 默认 0（docs/13 §6：远程面默认关闭，未启用时 Gateway 零监听）。
  return getSetting('gateway_enabled') === '1'
}

function gatewayPortSetting(): number {
  const raw = getSetting('gateway_port')
  const parsed = raw !== undefined ? Number.parseInt(raw, 10) : Number.NaN
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 65535 ? parsed : 8746
}

function loginAutostartSetting(): boolean {
  return getSetting('login_autostart') === '1'
}

/** gateway_enabled 真值（gateway/pairing 等远程面共用读口；默认 0 = 零监听，docs/13 §6）。 */
export function isGatewayEnabled(): boolean {
  return gatewayEnabledSetting()
}

// ---------------------------------------------------------------------------
// 自启即时应用注入位（AC5，docs/12 §10：services 层 electron-free 纪律不变，
// keyStoreWire setKeyCrypto 同款注入先例）——生产注入实现见 src/main/autostartWire.ts
// ---------------------------------------------------------------------------

/** 注入的即时应用能力形态：openAtLogin 落 app.setLoginItemSettings（Electron 自处理 path）。 */
export type AutoStartApplier = (enabled: boolean) => { ok: boolean; error?: string }

let autoStartApplier: AutoStartApplier | null = null

/** 注入 / 清除（传 null）即时应用能力；smoke 在系统 Node 下保持 null（仅 settings 侧行为）。 */
export function setAutoStartApplier(applier: AutoStartApplier | null): void {
  autoStartApplier = applier
}

/** 调用注入位（未注入时直接成功——AC2 settings-only 语义保留）。 */
function applyLoginItem(enabled: boolean): void {
  if (autoStartApplier === null) return
  const result = autoStartApplier(enabled)
  if (!result.ok) {
    throw new ServiceError('INTERNAL', `agents:setAutoStart: login item apply failed: ${result.error ?? 'unknown error'}`)
  }
}

/** 按当前 settings 真值应用一次自启（应用启动时调用，docs/12 §10）。返回现值。 */
export function applyAutoStartSetting(): boolean {
  const enabled = loginAutostartSetting()
  applyLoginItem(enabled)
  return enabled
}

/** 托盘真实可用性（agents:diagnostics tray 字段；trayWire 创建/销毁时回报）。 */
let agentTrayAvailable = false

export function setAgentTrayAvailable(available: boolean): void {
  agentTrayAvailable = available
}

/**
 * 远程面可用性门已随 AC6 退役：pairingCreate/gatewayRestart 走真实运行时
 * （enabled=0 → GATEWAY_DISABLED 语义保留在各自实现内）。
 */

// ---------------------------------------------------------------------------
// 投影助手（snake_case 行 → camelCase 视图）
// ---------------------------------------------------------------------------

/** CapabilitySet JSON 解析（agent_providers.capabilities_json）；未探测/损坏 → 空能力集。 */
function parseCapabilitySet(json: string | null): AgentCapabilitySet {
  if (json !== null && json.trim().length > 0) {
    try {
      const parsed = JSON.parse(json) as Partial<AgentCapabilitySet> | null
      if (parsed !== null && typeof parsed === 'object' && typeof parsed.mode === 'string') {
        return {
          mode: parsed.mode as SessionMode,
          granted: Array.isArray(parsed.granted)
            ? parsed.granted.filter((c): c is AgentCapability => typeof c === 'string')
            : [],
          verifiedAt: typeof parsed.verifiedAt === 'number' ? parsed.verifiedAt : 0,
          evidence: typeof parsed.evidence === 'string' ? parsed.evidence : '',
          // RD-mobile-chat run4 投影保真修复：DSW 批给 AgentCapabilitySet 增设的
          // workspace（managed 生效工作区，shared/types.ts）在重建时被此固定形态
          // 丢弃 → agents 列表/relay agent_list/会话详情三条投影一律缺 workspace →
          // App 启动面板「工作区：<路径>」恒不显示。按原样透传（缺省不构造）。
          ...(typeof parsed.workspace === 'string' && parsed.workspace.length > 0
            ? { workspace: parsed.workspace }
            : {}),
        }
      }
    } catch {
      // 损坏 JSON 视同未探测（绝不猜测能力）
    }
  }
  return {
    mode: 'observed',
    granted: [],
    verifiedAt: 0,
    evidence: 'not probed (no capability verification yet)',
  }
}

function asHealth(value: string): AgentHealth {
  return (PROVIDER_HEALTH as readonly string[]).includes(value) ? (value as AgentHealth) : 'unknown'
}

function asSessionStatus(value: string): SessionStatus {
  return (AGENT_SESSION_STATUSES as readonly string[]).includes(value) ? (value as SessionStatus) : 'unknown'
}

function asDeliveryState(value: string): EventDeliveryState {
  return value === 'delivered' || value === 'acked' ? value : 'pending'
}

/**
 * stale 判定（docs/14 §A.1 #2：数据源过期标注，绝不猜实时态）：
 * AC2 无监控管线、无探测（health 恒 unknown）→ 一律 stale:true（诚实标注
 * 「当前无新鲜数据源」）；AC3 接线 monitorRegistry/探测后按真实数据源刷新。
 * ux 批 A（R4/R3/R2）：可选附加 providerKey/providerLabel/archivedAt；
 * childSessions 仅 sessionDetail 投影按需填充（见 getAgentSessionDetail）。
 */
function sessionView(
  row: SessionRow,
  providerHealth: string,
  monitorEnabled: boolean,
  providerIdentity?: { key: string; label: string },
): AgentSessionView {
  return {
    id: row.id,
    providerId: row.provider_id,
    nativeId: row.native_id,
    sessionMode: row.session_mode as SessionMode,
    ...(row.project_id !== null ? { projectId: row.project_id } : {}),
    ...(row.title !== null ? { title: row.title } : {}),
    status: asSessionStatus(row.status),
    ...(row.status_detail !== null ? { statusDetail: row.status_detail } : {}),
    ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
    ...(row.last_activity_at !== null ? { lastActivityAt: row.last_activity_at } : {}),
    ...(row.ended_at !== null ? { endedAt: row.ended_at } : {}),
    stale: !(monitorEnabled && providerHealth === 'ok'),
    ...(providerIdentity !== undefined ? { providerKey: providerIdentity.key, providerLabel: providerIdentity.label } : {}),
    ...(row.archived_at !== null ? { archivedAt: row.archived_at } : {}),
  }
}

function providerView(row: ProviderRow): AgentProviderView {
  return {
    id: row.id,
    displayName: row.display_name,
    installed: row.installed === 1,
    ...(row.version !== null ? { version: row.version } : {}),
    ...(row.exe_path !== null ? { exePath: row.exe_path } : {}),
    health: asHealth(row.health),
    ...(row.health_detail !== null ? { healthDetail: row.health_detail } : {}),
    capabilities: parseCapabilitySet(row.capabilities_json),
    enabled: row.enabled === 1,
    lastProbeAt: row.last_probe_at,
  }
}

/** 读单个会话行；不存在 → NOT_FOUND（约束 #14 结构化错误）。 */
function readSessionRow(sessionId: number): SessionRow {
  const row = getDatabase().prepare('SELECT * FROM agent_sessions WHERE id = ?').get(sessionId) as
    | SessionRow
    | undefined
  if (row === undefined) {
    throw new ServiceError('NOT_FOUND', `agent session ${sessionId} not found`)
  }
  return row
}

function readProviderRow(providerId: number): ProviderRow | undefined {
  return getDatabase().prepare('SELECT * FROM agent_providers WHERE id = ?').get(providerId) as
    | ProviderRow
    | undefined
}

/** 安全审计写入（docs/13 §4.8：detail_json 绝不含凭据值；调用方保证）。 */
function insertSecurityAudit(
  category: string,
  action: string,
  deviceId: number | null,
  outcome: 'success' | 'denied' | 'error',
  detailJson: string | null,
): void {
  getDatabase()
    .prepare(
      'INSERT INTO security_audit_logs (category, action, device_id, outcome, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(category, action, dbVal(deviceId), outcome, dbVal(detailJson), nowSec())
}

/**
 * 审计写入口（AC6 Gateway 面共用；写库经 L3——裁决：配对/命令/审计落库均经
 * L3 函数，docs/15 §10）。detail 由调用方保证零凭据（Token/码明文绝不入审计）。
 */
export function recordSecurityAudit(
  category: string,
  action: string,
  deviceId: number | null,
  outcome: 'success' | 'denied' | 'error',
  detailJson: string | null,
): void {
  insertSecurityAudit(category, action, deviceId, outcome, detailJson)
}

// ---------------------------------------------------------------------------
// Gateway 运行时注入缝（AC6；autoStartApplier 同款先例：services 层 electron-free，
// Gateway 运行态经探针回报，避免 L3 ↔ gateway 静态循环 import）
// ---------------------------------------------------------------------------

/** Gateway 运行态探针视图（httpServer 注册时回报真值）。 */
export interface GatewayRuntimeProbeView {
  running: boolean
  actualPort?: number
  activeConnections: number
  lastError?: string
}

type GatewayRuntimeProbe = () => GatewayRuntimeProbeView

let gatewayRuntimeProbe: GatewayRuntimeProbe | null = null

/** 注册/清除（传 null）Gateway 运行态探针（httpServer ensureWiring 时注册）。 */
export function setGatewayRuntimeProbe(probe: GatewayRuntimeProbe | null): void {
  gatewayRuntimeProbe = probe
}

/** 设备撤销监听（Gateway 注册：撤销后已建立 WS 服务端立即关闭，docs/15 §4）。 */
let deviceRevokedListener: ((deviceId: number) => void) | null = null

export function setDeviceRevokedListener(listener: ((deviceId: number) => void) | null): void {
  deviceRevokedListener = listener
}

/**
 * 追加设备撤销监听（M2-R1 relayClient 踢线注入，docs/18 §3.15/§9.5）：与
 * setDeviceRevokedListener（主槽，Gateway 独占）并行的附加槽列表——撤销路径
 * 逐个回调（单个失败不阻断其余，与主槽同纪律）。
 */
const extraDeviceRevokedListeners: Array<(deviceId: number) => void> = []

export function addDeviceRevokedListener(listener: (deviceId: number) => void): void {
  extraDeviceRevokedListeners.push(listener)
}

/** 清空附加撤销监听（smoke/测试复位；生产不调用）。 */
export function clearExtraDeviceRevokedListeners(): void {
  extraDeviceRevokedListeners.length = 0
}

/**
 * 配对码签发监听（M2-R1 relayClient pairingBridge 消费，docs/19 §4.5「签发同步」）：
 * createPairing 成功签发后触发一次；监听方（pairingBridge）计算 code_hash 后经
 * register_pairing 帧同步 ECS 落 pairing_codes。relay 关闭/离线时监听缺席或投递
 * 失败 → 配对退化为本地模式专用（docs/19 §4.5），绝不影响签发本身。
 * code 明文仅在监听参数中瞬时流转（pairingBridge 现场哈希后丢弃）——不入日志/
 * 审计/DB（docs/15 §2 红线）。
 */
export interface PairingIssuedEvent {
  pairingId: string
  /** 8 位 Crockford Base32 明文（瞬时；监听方现场 sha256 后同步 ECS）。 */
  code: string
  expiresAt: number
}

let pairingIssuedListener: ((event: PairingIssuedEvent) => void) | null = null

export function setPairingIssuedListener(listener: ((event: PairingIssuedEvent) => void) | null): void {
  pairingIssuedListener = listener
}

/** 签发触发（L3 内部；监听异常不影响签发结果）。 */
function notifyPairingIssued(event: PairingIssuedEvent): void {
  if (pairingIssuedListener === null) return
  try {
    pairingIssuedListener(event)
  } catch {
    /* 同步失败不阻断本地配对（本地模式照常可用，docs/19 §4.5） */
  }
}

/**
 * 远程指令终态监听（M2-R1 relayClient commandDownlink 消费，docs/18 §3.10
 * command_result 回帧）：executeRemoteCommand / 过期标记到达终态时触发一次。
 * relay 侧按 commandId 过滤（只回帧经 relay 下达的指令）；Gateway/IPC 来源
 * 指令的终态已由 command.result 事件承载，不在 relay 面回帧。
 */
export interface RemoteCommandTerminalEvent {
  commandId: string
  idempotencyKey: string
  sessionId: number
  action: string
  status: 'executed' | 'rejected' | 'failed' | 'expired'
  errorCode: string | null
}

let remoteCommandCompleteListener: ((event: RemoteCommandTerminalEvent) => void) | null = null

export function setRemoteCommandCompleteListener(listener: ((event: RemoteCommandTerminalEvent) => void) | null): void {
  remoteCommandCompleteListener = listener
}

/** 终态触发（L3 内部；监听异常绝不影响指令行状态机）。 */
function notifyRemoteCommandTerminal(event: RemoteCommandTerminalEvent): void {
  if (remoteCommandCompleteListener === null) return
  try {
    remoteCommandCompleteListener(event)
  } catch {
    /* 回帧侧异常不影响 L3 终态（command.result 事件双通道兜底） */
  }
}

/**
 * 远程指令终态只读投影（M2-R1 commandDownlink 幂等重放回帧数据源；docs/18 §3.10
 * 「同 key 重试返回原结果」的 result 帧形态）。gateway 层只读豁免同款（零写库）。
 */
export function getRemoteCommandResultView(commandId: string): RemoteCommandTerminalEvent | null {
  const row = getDatabase()
    .prepare('SELECT command_id, idempotency_key, session_id, action, status, error_code FROM remote_commands WHERE command_id = ?')
    .get(commandId) as
    | { command_id: string; idempotency_key: string; session_id: number | null; action: string; status: string; error_code: string | null }
    | undefined
  if (row === undefined) return null
  const status = row.status
  if (status !== 'executed' && status !== 'rejected' && status !== 'failed' && status !== 'expired') return null
  return {
    commandId: row.command_id,
    idempotencyKey: row.idempotency_key,
    sessionId: row.session_id === null ? 0 : Number(row.session_id),
    action: row.action,
    status,
    errorCode: row.error_code,
  }
}

// ---------------------------------------------------------------------------
// 读类 8 条（查 004 新表真实返回）
// ---------------------------------------------------------------------------

/**
 * agents:providers（docs/14 §A.1 #1）。AC3 起（docs/16 §1 AC3 行）接入真实探测投影：
 * 监控总开关开启时 → 监控任务同步 + 节流探测（catalog 行 ensure / 健康 / 能力落库）；
 * 关闭时零探测，直接返回缓存投影（enabled:false 语义经 monitorEnabled 承载）。
 */
export async function listAgentProviders(): Promise<AgentProvidersResult> {
  const monitorEnabled = monitorEnabledSetting()
  if (monitorEnabled) {
    await syncMonitorTasks()
    await probeWiredProviders()
  }
  const rows = getDatabase().prepare('SELECT * FROM agent_providers ORDER BY id').all() as unknown as ProviderRow[]
  const probedAtRow = getDatabase().prepare('SELECT MAX(last_probe_at) AS m FROM agent_providers').get() as
    | { m: number | null }
    | undefined
  return {
    providers: rows.map(providerView),
    monitorEnabled,
    probedAt: probedAtRow?.m ?? null,
  }
}

export interface AgentSessionsFilter {
  providerId?: number
  projectId?: number
  status?: SessionStatus
  limit?: number
  /** R2：给定时返回其子会话（含已结束）；缺省只返回主会话（parent_session_id IS NULL）。 */
  parentId?: number
  /** R3：true 时归档会话可见；缺省隐藏归档（archived_at IS NULL）。 */
  includeArchived?: boolean
}

/**
 * provider 业务键 → agent_providers 行数字 id（M3-C7b host 腿 session_list 查询
 * 的字符串 providerId 解析；docs/14 §B.1「providerId 受理数字 id 或业务键」先例
 * 的读镜像）。未知引用 → null（调用方折 NOT_FOUND，绝不猜空结果）。
 */
export function resolveAgentProviderRef(ref: string): number | null {
  const row = getDatabase().prepare('SELECT id FROM agent_providers WHERE provider = ?').get(ref) as
    | { id: number }
    | undefined
  return row === undefined ? null : Number(row.id)
}

/**
 * agents:sessions（docs/14 §A.1 #2；filters 全参数绑定）。
 * ux 批 A：默认过滤 = 主会话（parent IS NULL，保留 8442e9d 意图）+ 未归档
 * （R3）；parentId= 指定时返回该会话的子会话（含已结束/归档——子会话页是
 * 明确指向性的浏览，不做二次隐藏）；includeArchived=1 时归档可见（R4
 * providerKey/providerLabel 随 JOIN 投影）。
 */
export function listAgentSessions(filter: AgentSessionsFilter = {}): AgentSessionsResult {
  const monitorEnabled = monitorEnabledSetting()
  const conditions: string[] = []
  const params: (number | string)[] = []
  if (filter.parentId !== undefined) {
    conditions.push('s.parent_session_id = ?')
    params.push(filter.parentId)
  } else {
    conditions.push('s.parent_session_id IS NULL')
  }
  if (filter.includeArchived !== true) {
    conditions.push('s.archived_at IS NULL')
  }
  if (filter.providerId !== undefined) {
    conditions.push('s.provider_id = ?')
    params.push(filter.providerId)
  }
  if (filter.projectId !== undefined) {
    conditions.push('s.project_id = ?')
    params.push(filter.projectId)
  }
  if (filter.status !== undefined) {
    conditions.push('s.status = ?')
    params.push(filter.status)
  }
  const whereSql = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''
  const limit = effectiveLimit(filter.limit)
  // provider health/identity 经 LEFT JOIN 带出（stale 标注 + R4 识别列）；
  // provider 行缺失（不应发生，FK 保证）按 unknown 处理。
  const sessions = getDatabase()
    .prepare(
      `SELECT s.*, p.health AS provider_health, p.provider AS provider_key, p.display_name AS provider_label FROM agent_sessions s
       LEFT JOIN agent_providers p ON p.id = s.provider_id${whereSql}
       ORDER BY s.id DESC LIMIT ?`,
    )
    .all(...params, limit) as unknown as (SessionRow & { provider_health: string | null; provider_key: string | null; provider_label: string | null })[]
  return {
    sessions: sessions.map((row) =>
      sessionView(
        row,
        row.provider_health ?? 'unknown',
        monitorEnabled,
        row.provider_key !== null && row.provider_label !== null
          ? { key: row.provider_key, label: row.provider_label }
          : undefined,
      ),
    ),
  }
}

/**
 * agents:sessionDetail（docs/14 §A.1 #3；capabilities 取 provider 投影，docs/12 §5）。
 * ux 批 A（R2/R4）：session 视图附 childSessions（含已结束，带状态/时间/标题，
 * 可再下钻——子会话 detail 同样返回其 childSessions）与 providerKey/providerLabel。
 */
export function getAgentSessionDetail(sessionId: number): {
  session: AgentSessionView
  capabilities: AgentCapabilitySet
  counts: { messages: number; events: number }
} {
  const session = readSessionRow(sessionId)
  const provider = readProviderRow(session.provider_id)
  const db = getDatabase()
  const messages = Number(
    (db.prepare('SELECT COUNT(*) AS c FROM agent_messages WHERE session_id = ?').get(sessionId) as { c: number }).c,
  )
  const events = Number(
    (db.prepare('SELECT COUNT(*) AS c FROM agent_events WHERE session_id = ?').get(sessionId) as { c: number }).c,
  )
  const monitorEnabled = monitorEnabledSetting()
  const identity =
    provider !== undefined ? { key: provider.provider, label: provider.display_name } : undefined
  const view = sessionView(session, provider?.health ?? 'unknown', monitorEnabled, identity)
  const childRows = db
    .prepare(
      `SELECT s.*, p.health AS provider_health FROM agent_sessions s
       LEFT JOIN agent_providers p ON p.id = s.provider_id
       WHERE s.parent_session_id = ? ORDER BY s.id ASC`,
    )
    .all(sessionId) as unknown as (SessionRow & { provider_health: string | null })[]
  if (childRows.length > 0) {
    view.childSessions = childRows.map((row) =>
      sessionView(row, row.provider_health ?? 'unknown', monitorEnabled, identity),
    )
  }
  return {
    session: view,
    capabilities: parseCapabilitySet(provider?.capabilities_json ?? null),
    counts: { messages, events },
  }
}

export interface AgentMessagesQuery {
  sessionId: number
  /** 正向游标（id > after；语义不变）。与 before/last 互斥。 */
  after?: number
  /** R10 尾部取数：id < before 的最新一页（ASC 返回）。与 after/last 互斥。 */
  before?: number
  /** R10 尾部取数：最新 last 条（ASC 返回）。与 after/before 互斥。 */
  last?: number
  limit?: number
}

/**
 * agents:messages（docs/14 §A.1 #4；contentRedacted 为已脱敏投影）。
 * ux 批 A：R10 尾部取数（last/before + prevAfter 游标，after 正向语义零变化）
 * 与 R1 可选 segments 投影（源无结构 → 缺省，展示按整段 text，绝不猜）。
 */
export function listAgentMessages(query: AgentMessagesQuery): AgentMessagesResult {
  readSessionRow(query.sessionId) // 会话存在性 → NOT_FOUND
  if (query.after !== undefined && query.before !== undefined) {
    throw new ServiceError('BAD_PAYLOAD', 'agents:messages: after and before are mutually exclusive')
  }
  if (query.after !== undefined && query.last !== undefined) {
    throw new ServiceError('BAD_PAYLOAD', 'agents:messages: after and last are mutually exclusive')
  }
  if (query.before !== undefined && query.last !== undefined) {
    throw new ServiceError('BAD_PAYLOAD', 'agents:messages: before and last are mutually exclusive')
  }
  const limit = effectiveLimit(query.limit)
  // R10：last 尾取条数自身封顶 ≤200（limit 同时给定时二者取小——页大小明确化）
  const tailSize = query.last !== undefined ? Math.min(query.last, AGENT_LIST_LIMIT_MAX, limit) : limit
  const db = getDatabase()

  // after 正向分页（语义零变化）：页满 → nextAfter
  if (query.after !== undefined || (query.before === undefined && query.last === undefined)) {
    const after = query.after
    const rows = (
      after !== undefined
        ? db
            .prepare('SELECT * FROM agent_messages WHERE session_id = ? AND id > ? ORDER BY id ASC LIMIT ?')
            .all(query.sessionId, after, limit)
        : db
            .prepare('SELECT * FROM agent_messages WHERE session_id = ? ORDER BY id ASC LIMIT ?')
            .all(query.sessionId, limit)
    ) as unknown as MessageRow[]
    const items = rows.map(projectMessageRow)
    return {
      items,
      ...(items.length === limit ? { nextAfter: items[items.length - 1].id } : {}),
    }
  }

  // R10 尾部取数（last / before）：DESC 取 tailSize+1 探测更早窗口，ASC 返回；
  // 有更早消息 → prevAfter = 本页最早一条 id（客户端 before=prevAfter 续拉）
  const anchor = query.before
  const rows = (
    anchor !== undefined
      ? db
          .prepare('SELECT * FROM agent_messages WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ?')
          .all(query.sessionId, anchor, tailSize + 1)
      : db
          .prepare('SELECT * FROM agent_messages WHERE session_id = ? ORDER BY id DESC LIMIT ?')
          .all(query.sessionId, tailSize + 1)
  ) as unknown as MessageRow[]
  const hasOlder = rows.length > tailSize
  const page = (hasOlder ? rows.slice(0, tailSize) : rows).map(projectMessageRow)
  page.reverse() // ASC 返回（与既有投影顺序一致）
  return {
    items: page,
    ...(hasOlder ? { prevAfter: page[0].id } : {}),
  }
}

/** 行 → 投影（segments_json 损坏/缺列 → 缺省 segments，绝不猜）。 */
function projectMessageRow(row: MessageRow): AgentMessageView {
  const segments = parseSegmentsJson(row.segments_json)
  return {
    id: row.id,
    role: row.role,
    contentRedacted: row.content_redacted,
    ...(row.occurred_at !== null ? { occurredAt: row.occurred_at } : {}),
    ...(row.source_ref !== null ? { sourceRef: row.source_ref } : {}),
    ...(segments !== undefined ? { segments } : {}),
  }
}

export interface AgentEventsQuery {
  after?: number
  providerId?: number
  sessionId?: number
  limit?: number
}

/** agents:events（docs/14 §A.1 #5；id 即全局 sequence，游标轮询）。 */
export function listAgentEvents(query: AgentEventsQuery = {}): AgentEventsResult {
  const conditions: string[] = []
  const params: (number | string)[] = []
  if (query.after !== undefined) {
    conditions.push('id > ?')
    params.push(query.after)
  }
  if (query.providerId !== undefined) {
    conditions.push('provider_id = ?')
    params.push(query.providerId)
  }
  if (query.sessionId !== undefined) {
    conditions.push('session_id = ?')
    params.push(query.sessionId)
  }
  const whereSql = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''
  const limit = effectiveLimit(query.limit)
  const rows = getDatabase()
    .prepare(`SELECT * FROM agent_events${whereSql} ORDER BY id ASC LIMIT ?`)
    .all(...params, limit) as unknown as EventRow[]
  const events: AgentEventView[] = rows.map((row) => {
    let payload: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(row.payload_json) as unknown
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>
      }
    } catch {
      // 损坏 JSON → 空 payload（脱敏投影宁缺毋滥）
    }
    return {
      id: row.id,
      eventId: row.event_id,
      eventType: row.event_type,
      ...(row.provider_id !== null ? { providerId: row.provider_id } : {}),
      ...(row.session_id !== null ? { sessionId: row.session_id } : {}),
      ...(row.summary !== null ? { summary: row.summary } : {}),
      payload,
      deliveryState: asDeliveryState(row.delivery_state),
      createdAt: row.created_at,
    }
  })
  return {
    events,
    ...(events.length === limit ? { nextAfter: events[events.length - 1].id } : {}),
  }
}

/** agents:devices（docs/14 §A.1 #8；绝无 Token 明文/哈希）。 */
export function listDevices(): { devices: AgentDeviceView[] } {
  const rows = getDatabase().prepare('SELECT * FROM remote_devices ORDER BY id').all() as unknown as DeviceRow[]
  return {
    devices: rows.map((row) => ({
      id: row.id,
      deviceName: row.device_name,
      platform: row.platform,
      status: row.status === 'revoked' ? ('revoked' as const) : ('active' as const),
      pairedAt: row.paired_at,
      ...(row.last_seen_at !== null ? { lastSeenAt: row.last_seen_at } : {}),
      tokenVersion: row.token_version,
    })),
  }
}

/** agents:gatewayStatus（docs/14 §A.1 #10；AC6 起 running/actualPort/lastError 为探针真值）。 */
export function getGatewayStatus(): GatewayStatusView {
  const activeDevicesRow = getDatabase()
    .prepare("SELECT COUNT(*) AS c FROM remote_devices WHERE status = 'active'")
    .get() as { c: number }
  const probe = gatewayRuntimeProbe !== null ? gatewayRuntimeProbe() : undefined
  // M2-R1（docs/19 §4.7 D5）：relay 可选附加字段——disabled → projectRelayStatus null
  // → 字段缺席（零噪声向后兼容）；enabled → 结构化真值（statusProjector 投影）。
  const relayStatus = projectRelayStatus()
  return {
    enabled: gatewayEnabledSetting(),
    running: probe?.running ?? false,
    port: gatewayPortSetting(),
    ...(probe?.actualPort !== undefined ? { actualPort: probe.actualPort } : {}),
    activeDevices: Number(activeDevicesRow.c),
    // AC8（docs/15 §8 / docs/16 §1 AC8 行）：NatPierce 外置配置投影——configured
    // = env 齐备性，reachable = 60s 缓存的健康探测（diagnostics 面刷新），零凭据。
    natpierce: computeNatPierceStatus(),
    ...(relayStatus !== null ? { relay: relayStatus } : {}),
    ...(probe?.lastError !== undefined && probe.lastError.length > 0 ? { lastError: probe.lastError } : {}),
  }
}

/** agents:diagnostics（docs/14 §A.1 #13；与 REST /v1/diagnostics 同投影红线）。
 *  AC3 起 providers 数据源/控制通道取 provider.describeDiagnostics() 真实形态。 */
export async function getDiagnostics(): Promise<AgentDiagnosticsResult> {
  const monitorEnabled = monitorEnabledSetting()
  if (monitorEnabled) {
    await syncMonitorTasks()
    await probeWiredProviders()
  }
  // AC8：NatPierce reachable 节流刷新（endpoint 未配置时零出站；失败折叠为
  // reachable:false 布尔，绝不抛——诊断面必须结构化返回）。
  await refreshNatPierceStatus().catch(() => undefined)
  const rows = getDatabase().prepare('SELECT * FROM agent_providers ORDER BY id').all() as unknown as ProviderRow[]
  return {
    providers: rows.map((row) => {
      const key = row.provider as AgentProviderId
      const instance = getProviderInstance(key)
      const diag: ProviderDiagnosticsInfo | undefined = instance?.describeDiagnostics?.()
      return {
        id: row.id,
        installed: row.installed === 1,
        ...(row.version !== null ? { version: row.version } : {}),
        exeFound: row.exe_path !== null,
        dataSource:
          diag !== undefined
            ? diag.dataSource
            : {
                kind: 'unknown',
                readable: false,
                detail: 'provider wiring lands in AC4 (kimi/zcode/deepseek)',
              },
        control:
          diag !== undefined
            ? diag.control
            : { note: 'no control channel verified (provider wiring lands in AC4)' },
      }
    }),
    gateway: getGatewayStatus(),
    tray: { available: agentTrayAvailable }, // AC5 托盘真实可用性（trayWire 注入回报）
    autostart: { enabled: loginAutostartSetting() },
    monitorEnabled,
  }
}

// ---------------------------------------------------------------------------
// 动作类入口（AC2 深度边界见文件头）
// ---------------------------------------------------------------------------

/**
 * 指令门（docs/15 §5 授权矩阵 + docs/12 §5 能力验证门的 L3 二次校验，IPC 与
 * REST 远程指令共用同一判定——「服务端拒绝才是合同」）：
 * - observed → COMMAND_NOT_EXECUTABLE（无输入通道）；
 * - attached + pause/resume → COMMAND_NOT_EXECUTABLE（矩阵：attached 只有 reply）；
 * - 能力未验证/过期（verifiedAt > 300s）→ AGENT_CAPABILITY_MISSING；
 * - 能力未授予 → AGENT_CAPABILITY_MISSING。
 */
function resolveCommandGate(session: SessionRow, action: AgentCapability): { providerKey: string } {
  const provider = readProviderRow(session.provider_id)
  const providerKey = provider?.provider
  if (providerKey === undefined) {
    throw new ServiceError('NOT_FOUND', `agent provider row ${session.provider_id} not found`)
  }
  if (session.session_mode === 'observed') {
    throw new ServiceError(
      'COMMAND_NOT_EXECUTABLE',
      `sessionAction: session ${session.id} is observed (no input channel, docs/12 §5)`,
    )
  }
  if (session.session_mode === 'attached' && action !== 'reply') {
    throw new ServiceError(
      'COMMAND_NOT_EXECUTABLE',
      `sessionAction: attached session ${session.id} does not allow "${action}" (docs/15 §5 matrix: attached grants reply only)`,
    )
  }
  const caps = parseCapabilitySet(provider?.capabilities_json ?? null)
  const verifiedFresh = caps.verifiedAt > 0 && nowSec() - caps.verifiedAt <= CAPABILITY_TTL_SEC
  if (!verifiedFresh) {
    throw new ServiceError(
      'AGENT_CAPABILITY_MISSING',
      `sessionAction: capabilities for session ${session.id} are not verified or stale (>300s), re-probe required`,
    )
  }
  if (!caps.granted.includes(action)) {
    throw new ServiceError(
      'AGENT_CAPABILITY_MISSING',
      `sessionAction: capability "${action}" is not granted for session ${session.id} (granted: ${caps.granted.length > 0 ? caps.granted.join('|') : 'none'})`,
    )
  }
  return { providerKey }
}

/**
 * 动作成功后的状态推进（AC8，docs/12 §6：status_changed 仅状态 ≠ 旧值才发）。
 * 判定源 = DevHub 第一手执行结果（reply/resume 成功 = 已向真实 Agent 注入输入 →
 * running；pause 成功 = turn/interrupt 已确认 → paused）。随后的 rollout 观察
 * （task_started/task_complete/turn_aborted）按监控管线正常覆盖/收敛。
 */
function applyActionOutcomeStatus(providerKey: string, nativeId: string, action: AgentCapability): void {
  applySessionStatus(providerKey, nativeId, action === 'pause' ? 'paused' : 'running', `${action} command executed (DevHub-initiated)`)
}

/**
 * agents:sessionAction（docs/14 §A.1 #6）。AC3 起细分能力门（docs/16 §1 AC3 行）：
 * 门判定统一走 resolveCommandGate（observed → COMMAND_NOT_EXECUTABLE；attached 无
 * pause/resume → COMMAND_NOT_EXECUTABLE；能力未验证 → AGENT_CAPABILITY_MISSING）。
 * 两道门都过 → provider 真实执行（app-server 通道等），provider 结构化不支持 →
 * 同样折叠为结构化拒绝。
 */
export async function createSessionAction(
  sessionId: number,
  action: AgentCapability,
  text?: string,
): Promise<AgentSessionActionResult> {
  const session = readSessionRow(sessionId)
  const { providerKey } = resolveCommandGate(session, action)
  const instance = getProviderInstance(providerKey as AgentProviderId)
  if (instance === undefined) {
    throw new ServiceError('AGENT_PROVIDER_UNAVAILABLE', `agents:sessionAction: provider "${providerKey}" is not wired in this build`)
  }
  const ref: SessionRef = { providerId: providerKey as AgentProviderId, nativeId: session.native_id }
  const outcome =
    action === 'reply'
      ? await instance.sendReply(ref, text ?? '')
      : action === 'pause'
        ? await instance.pause(ref)
        : await instance.resume(ref)
  if (outcome.status === 'unsupported') {
    throw new ServiceError('AGENT_CAPABILITY_MISSING', `agents:sessionAction: ${outcome.detail ?? 'channel does not support this action'}`)
  }
  if (!outcome.ok) {
    throw new ServiceError('COMMAND_NOT_EXECUTABLE', `agents:sessionAction: ${outcome.detail ?? 'command execution failed'}`)
  }
  const commandId = `cmd-${randomUUID()}`
  applyActionOutcomeStatus(providerKey, session.native_id, action)
  recordCommandResult({
    providerKey,
    sessionId,
    nativeId: session.native_id,
    commandId,
    action,
    status: 'executed',
  })
  return { commandId, status: 'executed' }
}

/**
 * agents:pairingCreate（docs/14 §A.1 #7）。AC6 起进程内直调真实签发（docs/14 §B.1
 * 注：桌面常规路径不经 HTTP）：gateway/pairing.createPairingCode 承载签发语义
 * （gateway_enabled=0 → GATEWAY_DISABLED 引导启用；8 位 Crockford Base32 +
 * TTL 300s + 同时至多 1 活跃码 + 审计）。动态 import（gateway 静态依赖本模块，
 * 反向只允许动态，避免循环加载）。
 */
export async function createPairing(deviceName?: string): Promise<AgentPairingCreateResult> {
  const { createPairingCode } = await import('./gateway/pairing.ts')
  const result = createPairingCode(deviceName)
  // M2-R1：relay 面签发同步（pairingBridge register_pairing → ECS pairing_codes；
  // 明文码仅在监听参数中瞬时流转，docs/19 §4.5）
  notifyPairingIssued({ pairingId: result.pairingId, code: result.code, expiresAt: result.expiresAt })
  return result
}

/**
 * agents:deviceRevoke（docs/14 §A.1 #9 两段式）：
 * 无 confirmed → confirmRequired + impacts（查设备，绝不执行）；
 * confirmed → 设备不存在 NOT_FOUND；存在则撤销 + 审计落库 + 撤销监听回调
 * （Gateway 注册：活跃 WS 服务端立即关闭，docs/15 §4；AC6 已接线）。
 */
export function revokeDevice(
  deviceId: number,
  confirmed?: boolean,
  via: 'ipc' | 'rest-self' | 'relay-self' = 'ipc',
): AgentDeviceRevokeStart | AgentDeviceRevokeResult {
  const db = getDatabase()
  const row = db.prepare('SELECT * FROM remote_devices WHERE id = ?').get(deviceId) as DeviceRow | undefined
  if (row === undefined) {
    throw new ServiceError('NOT_FOUND', `remote device ${deviceId} not found`)
  }
  if (confirmed !== true) {
    return {
      confirmRequired: true,
      impacts: {
        deviceId: row.id,
        deviceName: row.device_name,
        ...(row.last_seen_at !== null ? { lastSeenAt: row.last_seen_at } : {}),
        note:
          row.status === 'revoked'
            ? 'device is already revoked; confirming again only refreshes the audit trail'
            : 'revoking immediately invalidates the device token and cuts its active connections',
      },
    }
  }
  const ts = nowSec()
  db.prepare("UPDATE remote_devices SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE id = ?").run(
    ts,
    ts,
    deviceId,
  )
  insertSecurityAudit('device', 'device_revoked', deviceId, 'success', JSON.stringify({ via }))
  // 撤销即拒：回调 Gateway 关闭该设备全部活跃 WS（docs/15 §4；失败不阻断撤销）
  if (deviceRevokedListener !== null) {
    try {
      deviceRevokedListener(deviceId)
    } catch {
      /* 断连异常不影响撤销结果 */
    }
  }
  // M2-R1：附加撤销监听（relayClient 踢线 disconnect{deviceId,reason:'revoked'}，
  // docs/18 §9.5 撤销链路；单监听失败不阻断其余与撤销结果）
  for (const listener of extraDeviceRevokedListeners) {
    try {
      listener(deviceId)
    } catch {
      /* 踢线异常不影响撤销结果 */
    }
  }
  return { revoked: true }
}

// ---------------------------------------------------------------------------
// M3-E1 — 设备自撤销 WS command 面（docs/18 §5.3 revoke_device；用户裁决
// 2026-09-07 #9=B）。两段式：受理段（幂等行 + 审计，先回 command_ack）→ 执行段
// （L3 revoke → §3.15 撤销链自动接管）。commandId 终态照常落库（§5.3 终态收口 =
// disconnect(revoked) 而非 command_result，回帧不保证送达）。目标恒 = auth Token
// 对应设备自身（帧无目标字段天然自指；payload 一概不解释——禁止代撤销语义）。
// remote_commands.action 值域为注释级枚举（无 CHECK，004 建表），写 'revoke_device'
// 零迁移（任务书 §1 #6「relay action → L3 通道映射」路线）。
// ---------------------------------------------------------------------------

export interface DeviceSelfRevokeBegin {
  commandId: string
  /** true = 幂等重试命中既有行（受理段零新写；撤销已在既往执行）。 */
  replayed: boolean
  status: 'accepted' | 'executed' | 'rejected' | 'expired' | 'failed'
}

/**
 * 受理段（commandDownlink revoke_device 分支第一步）：幂等键查重 → 落 accepted 行 +
 * 审计；绝不执行撤销。调用方先以返回的 commandId 回 command_ack，再调执行段——
 * ack 与 disconnect(revoked) 的 wire 序由此保证（§5.3 受理先于踢线）。
 */
export function beginDeviceSelfRevoke(input: { deviceId: number; idempotencyKey: string }): DeviceSelfRevokeBegin {
  const db = getDatabase()
  const now = nowSec()
  const existing = db.prepare('SELECT * FROM remote_commands WHERE idempotency_key = ?').get(input.idempotencyKey) as
    | RemoteCommandRow
    | undefined
  if (existing !== undefined) {
    // 同 key 异 action → COMMAND_KEY_CONFLICT（docs/14 §B.5 语义；幂等键是全局唯一资源，
    // 绝不把其他 action 的行误当撤销重放）
    if (existing.action !== 'revoke_device') {
      throw new ServiceError('COMMAND_KEY_CONFLICT', 'device self-revoke: idempotency key already used with a different action (docs/14 B.5)')
    }
    // 同 key 重试：原命令原受理（docs/14 §B.5 语义；撤销为一次性事实，绝不重复执行）
    return { commandId: existing.command_id, replayed: true, status: commandRowStatusToResult(existing.status) }
  }
  const commandId = `cmd-${randomUUID()}`
  db.prepare(
    "INSERT INTO remote_commands (command_id, idempotency_key, device_id, session_id, action, payload_json, status, expires_at, created_at) VALUES (?, ?, ?, NULL, 'revoke_device', NULL, 'accepted', ?, ?)",
  ).run(commandId, input.idempotencyKey, dbVal(input.deviceId), now + REMOTE_COMMAND_TTL_SEC, now)
  insertSecurityAudit(
    'command',
    'command_accepted',
    input.deviceId,
    'success',
    JSON.stringify({ commandId, action: 'revoke_device', source: 'relay-command' }),
  )
  return { commandId, replayed: false, status: 'accepted' }
}

/**
 * 执行段（受理回执发出后调用）：L3 revokeDevice(confirmed) → §3.15 撤销链自动接管
 * （closeDeviceConnections + relayClient disconnect{deviceId,reason:'revoked'} → ECS
 * 踢线 + 注册表 revoked）。行终态照常落库 + 终态通知（回帧不保证送达，§5.3 终态语义）。
 */
export async function executeDeviceSelfRevoke(input: { commandId: string; deviceId: number; idempotencyKey: string }): Promise<void> {
  const db = getDatabase()
  try {
    revokeDevice(input.deviceId, true, 'relay-self')
    db.prepare("UPDATE remote_commands SET status = 'executed', result_json = ?, executed_at = ? WHERE command_id = ?").run(
      JSON.stringify({ status: 'executed' }),
      nowSec(),
      input.commandId,
    )
    notifyRemoteCommandTerminal({
      commandId: input.commandId,
      idempotencyKey: input.idempotencyKey,
      sessionId: 0,
      action: 'revoke_device',
      status: 'executed',
      errorCode: null,
    })
  } catch (err) {
    const errorCode = err instanceof ServiceError ? err.code : 'COMMAND_NOT_EXECUTABLE'
    try {
      db.prepare("UPDATE remote_commands SET status = 'failed', error_code = ?, executed_at = ? WHERE command_id = ?").run(
        errorCode,
        nowSec(),
        input.commandId,
      )
      insertSecurityAudit('command', 'command_rejected', input.deviceId, 'error', JSON.stringify({ commandId: input.commandId, action: 'revoke_device', errorCode }))
      notifyRemoteCommandTerminal({
        commandId: input.commandId,
        idempotencyKey: input.idempotencyKey,
        sessionId: 0,
        action: 'revoke_device',
        status: 'failed',
        errorCode,
      })
    } catch {
      /* 双重失败：行保持 accepted + expires_at 兜底（重试幂等覆盖） */
    }
  }
}

// ---------------------------------------------------------------------------
// S 批 — workspace_link 查询命令面（docs/18 §5.3 注记；任务书 §1 #1/#2）。
// 语义：设备经 relay 查询当前有效 ZCode 移动遥控链接（**纯拉取查询**——URL 凭据
// 成分静态、t=时间戳 nonce，桌面磁盘三文件实时重建，永远新鲜且有效）。
// 授权矩阵：READ 类能力门——任何已配对设备可查询（auth 校验在 commandDownlink）。
// **零持久化红线**：URL 仅内存构造即发；remote_commands.result_json 与审计
// detail 一律只记 {provider} 形态（URL 与其任何子串零落库，任务书 §1 #1）。
// remote_commands.action 值域为注释级枚举（无 CHECK，004 建表），写
// 'workspace_link' 零迁移（M3-E1 revoke_device 同款先例）。
// ---------------------------------------------------------------------------

export interface WorkspaceLinkBegin {
  commandId: string
  /** true = 幂等重试命中既有行（受理段零新写；查询语义由执行段重新拉取）。 */
  replayed: boolean
}

/**
 * 受理段（workspace_link 命令面第一步；调用方 = commandDownlink relay 腿 / gateway
 * localCommand 本地腿，docs/18 §5.3.1/§5.3.2）：幂等键查重 → 落 accepted 行 +
 * 审计（detail 只记 commandId/action/source，零 URL）。同 key 异 action →
 * COMMAND_KEY_CONFLICT（docs/14 §B.5 语义，revoke_device 同款）。
 * X-L 批：input.source 审计通道位——缺省 'relay-command'（relay 面审计原文零变化），
 * 本地网关腿传 'local-gateway'（通道如实入册，同一台账）。
 */
export function beginWorkspaceLink(input: {
  deviceId: number
  idempotencyKey: string
  /** 审计 source 字段（通道如实）；缺省 'relay-command'。 */
  source?: string
}): WorkspaceLinkBegin {
  const db = getDatabase()
  const now = nowSec()
  const existing = db.prepare('SELECT * FROM remote_commands WHERE idempotency_key = ?').get(input.idempotencyKey) as
    | RemoteCommandRow
    | undefined
  if (existing !== undefined) {
    if (existing.action !== 'workspace_link') {
      throw new ServiceError('COMMAND_KEY_CONFLICT', 'workspace_link: idempotency key already used with a different action (docs/14 B.5)')
    }
    // 查询语义的同 key 重试：命中原命令行（零新写）；执行段重建当前链接作为结果
    // ——拉取模型下「原结果」= 最新链接（旧 URL 从不持久化，无从重放，任务书零持久化红线）。
    return { commandId: existing.command_id, replayed: true }
  }
  const commandId = `cmd-${randomUUID()}`
  db.prepare(
    "INSERT INTO remote_commands (command_id, idempotency_key, device_id, session_id, action, payload_json, status, expires_at, created_at) VALUES (?, ?, ?, NULL, 'workspace_link', NULL, 'accepted', ?, ?)",
  ).run(commandId, input.idempotencyKey, dbVal(input.deviceId), now + REMOTE_COMMAND_TTL_SEC, now)
  insertSecurityAudit(
    'command',
    'command_accepted',
    input.deviceId,
    'success',
    JSON.stringify({ commandId, action: 'workspace_link', source: input.source ?? 'relay-command' }),
  )
  return { commandId, replayed: false }
}

/**
 * 执行段收口（链接重建成功/失败后调用）：行终态 + 审计 + command.result 事件。
 * **result_json 与事件 payload 只记 {provider}**——URL 只经 commandDownlink 的
 * command_result 帧内存过境回流（ECS 侧持久化边界另有脱敏，forwarder S 批注记）。
 * reason 仅静态字面量（provider 内部保证），落 result_json 供诊断，零敏感成分。
 */
export function completeWorkspaceLink(input: {
  commandId: string
  deviceId: number
  idempotencyKey: string
  ok: boolean
  /** ok=false 时的静态原因（如 'pass_hash_decrypt_failed'；零 URL/零凭据成分）。 */
  reason?: string
}): void {
  const db = getDatabase()
  const now = nowSec()
  if (input.ok) {
    db.prepare("UPDATE remote_commands SET status = 'executed', result_json = ?, executed_at = ? WHERE command_id = ?").run(
      JSON.stringify({ status: 'executed', provider: 'zcode' }),
      now,
      input.commandId,
    )
    insertSecurityAudit('command', 'command_executed', input.deviceId, 'success', JSON.stringify({ commandId: input.commandId, action: 'workspace_link', provider: 'zcode' }))
    recordCommandResult({
      providerKey: 'zcode',
      commandId: input.commandId,
      action: 'workspace_link',
      status: 'executed',
    })
    notifyRemoteCommandTerminal({
      commandId: input.commandId,
      idempotencyKey: input.idempotencyKey,
      sessionId: 0,
      action: 'workspace_link',
      status: 'executed',
      errorCode: null,
    })
  } else {
    const errorCode = 'ZCODE_LINK_UNAVAILABLE'
    db.prepare("UPDATE remote_commands SET status = 'failed', error_code = ?, result_json = ?, executed_at = ? WHERE command_id = ?").run(
      errorCode,
      JSON.stringify({ status: 'failed', provider: 'zcode', reason: input.reason ?? 'unavailable' }),
      now,
      input.commandId,
    )
    insertSecurityAudit('command', 'command_rejected', input.deviceId, 'error', JSON.stringify({ commandId: input.commandId, action: 'workspace_link', provider: 'zcode', errorCode, reason: input.reason ?? 'unavailable' }))
    recordCommandResult({
      providerKey: 'zcode',
      commandId: input.commandId,
      action: 'workspace_link',
      status: 'failed',
      errorCode,
    })
    notifyRemoteCommandTerminal({
      commandId: input.commandId,
      idempotencyKey: input.idempotencyKey,
      sessionId: 0,
      action: 'workspace_link',
      status: 'failed',
      errorCode,
    })
  }
}

/**
 * provider 能力集只读投影（relay session_detail 附带 caps 用，RD-mobile-chat
 * run2：host 腿 session_list detail 语义与本地 REST detail 同源，docs/12 §5）：
 * 业务键或数字 id → CapabilitySet；provider 未知 → null。绝不写库、绝不旁路 L3
 * 门（仅读投影，授权判定仍归各 L3 权威校验）。
 */
export function readProviderCapabilitySet(ref: string): AgentCapabilitySet | null {
  const numericId = /^\d+$/.test(ref) ? Number.parseInt(ref, 10) : null
  const row = (
    numericId !== null
      ? (getDatabase().prepare('SELECT capabilities_json FROM agent_providers WHERE id = ?').get(numericId) as { capabilities_json: string | null } | undefined)
      : (getDatabase().prepare('SELECT capabilities_json FROM agent_providers WHERE provider = ?').get(ref) as { capabilities_json: string | null } | undefined)
  )
  if (row === undefined) return null
  return parseCapabilitySet(row.capabilities_json)
}

/**
 * provider 能力模式只读投影（M3-E1 commandDownlink spawn_session 拒绝码分类专用）：
 * 业务键或数字 id → caps.mode（managed|attached|observed）；provider 未知 → null
 * （分类跳过，由 L3 startProviderManagedSession 折 NOT_FOUND）。绝不写库、绝不
 * 旁路 L3 门——L3 在执行路径重新权威校验，本投影仅用于错误码映射（§5.3：
 * 授权矩阵不允许 → COMMAND_NOT_EXECUTABLE；spawn 特有拒绝 → SPAWN_REJECTED）。
 */
export function readProviderCapabilityMode(ref: string): 'managed' | 'attached' | 'observed' | null {
  return readProviderCapabilitySet(ref)?.mode ?? null
}

/**
 * agents:gatewayRestart（docs/14 §A.1 #11 两段式）：无 confirmed → confirmRequired +
 * impacts（活跃连接数为探针真值）；confirmed → 重读 settings 并重启监听
 * （stop → start；禁用态 → GATEWAY_DISABLED；8746–8755 全占 → GATEWAY_PORT_IN_USE）。
 */
export async function restartGateway(confirmed?: boolean): Promise<AgentGatewayRestartStart | AgentGatewayRestartResult> {
  if (confirmed !== true) {
    const probe = gatewayRuntimeProbe !== null ? gatewayRuntimeProbe() : undefined
    return {
      confirmRequired: true,
      impacts: {
        activeConnections: probe?.activeConnections ?? 0,
        note: 'restart re-reads settings gateway_port/gateway_enabled and re-binds the listener',
      },
    }
  }
  if (!gatewayEnabledSetting()) {
    throw new ServiceError('GATEWAY_DISABLED', 'agents:gatewayRestart: remote gateway is disabled (settings gateway_enabled = 0)')
  }
  const gw = await import('./gateway/httpServer.ts')
  await gw.stopGateway('restart requested (agents:gatewayRestart)')
  const status = await gw.startGateway()
  return { running: status.running, port: status.actualPort ?? gatewayPortSetting() }
}

/**
 * agents:setAutoStart（docs/14 §A.1 #12）：写 settings login_autostart 真实生效 +
 * 即时应用（AC5，docs/12 §10）：注入位存在时先落 app.setLoginItemSettings（失败 →
 * 结构化错误且 settings 不写，保持两侧一致），再写 settings；未注入（smoke/系统
 * Node）时仅写 settings，AC2 行为保留。
 */
export function setAutoStart(enabled: boolean): { enabled: boolean } {
  applyLoginItem(enabled)
  setSetting('login_autostart', enabled ? '1' : '0')
  return { enabled }
}

// ---------------------------------------------------------------------------
// AC6 — 远程指令链（docs/14 §B.5：REST 202 → 能力门/授权矩阵复检 → provider
// 执行 → command.result 事件；remote_commands 落库在本 Service，约束 #20）
// ---------------------------------------------------------------------------

/** 指令过期窗口（docs/14 §B.5：expires_at = created_at + 300s）。 */
export const REMOTE_COMMAND_TTL_SEC = 300

/** remote_commands 行（docs/13 §4.6）。 */
interface RemoteCommandRow {
  id: number
  command_id: string
  idempotency_key: string
  device_id: number | null
  session_id: number | null
  action: string
  payload_json: string | null
  status: string
  result_json: string | null
  error_code: string | null
  expires_at: number
  created_at: number
  executed_at: number | null
}

export interface RemoteCommandSubmitInput {
  /** 发起设备（remote_devices.id；审计与 remote_commands.device_id 归因）。 */
  deviceId: number
  sessionId: number
  action: AgentCapability
  text?: string
  /** 客户端幂等键（建议 UUID；缺省时进程内生成自动键，docs/14 §B.5）。 */
  idempotencyKey?: string
}

export interface RemoteCommandAccepted {
  commandId: string
  status: 'accepted' | 'executed' | 'rejected'
}

/** 执行中指令集合（过期语义豁免：已 accepted 的执行到底，docs/14 §B.5）。 */
const inFlightRemoteCommands = new Set<string>()

/** 行 status → 响应 status（rejected/failed/expired 折叠为 rejected）。 */
function commandRowStatusToResult(status: string): RemoteCommandAccepted['status'] {
  if (status === 'executed') return 'executed'
  if (status === 'pending' || status === 'accepted') return 'accepted'
  return 'rejected'
}

/**
 * 远程指令提交（REST /v1/sessions/{id}/reply|actions 的 L3 落点）：
 * 1. 幂等键 UNIQUE：同 key 重试 → 原命令原结果（202 + 原 commandId，不重复执行）；
 *    同 key 异 payload → 409 COMMAND_KEY_CONFLICT（payload 同一性 = sessionId +
 *    action + reply 文本的脱敏投影比对）；
 * 2. 过期：expires_at 已过且从未执行 → status=expired + command.result(expired) 事件，
 *    再触发 → 409 COMMAND_EXPIRED；执行中指令不受过期影响（in-flight 豁免）；
 * 3. 门：resolveCommandGate（与 IPC sessionAction 同一授权矩阵/能力门实现）；
 * 4. 落库 accepted → 202 语义 → 后台执行（结果回写行 + command.result 事件，
 *    docs/12 §6 event 表第 7 行）。
 */
export async function submitRemoteCommand(input: RemoteCommandSubmitInput): Promise<RemoteCommandAccepted> {
  const db = getDatabase()
  const session = readSessionRow(input.sessionId) // NOT_FOUND
  const key = input.idempotencyKey ?? `auto-${randomUUID()}`
  const payloadJson = JSON.stringify({ text: input.text !== undefined ? redactText(input.text) : null })
  const now = nowSec()

  const existing = db.prepare('SELECT * FROM remote_commands WHERE idempotency_key = ?').get(key) as
    | RemoteCommandRow
    | undefined
  if (existing !== undefined) {
    const samePayload =
      existing.session_id === input.sessionId &&
      existing.action === input.action &&
      (existing.payload_json ?? '{"text":null}') === payloadJson
    if (!samePayload) {
      throw new ServiceError(
        'COMMAND_KEY_CONFLICT',
        `remote command: idempotency key already used with a different payload (docs/14 B.5)`,
      )
    }
    if (existing.status === 'expired') {
      // 已标记 expired 的重试：409 幂等拒绝（docs/14 §B.5「再触发 → 409」），
      // 绝不重复标记/重复发 command.result 事件（首次标记只发生一次）
      throw new ServiceError('COMMAND_EXPIRED', `remote command: command expired (idempotent retry on expired command, docs/14 B.5)`)
    }
    const terminal = existing.status === 'executed' || existing.status === 'rejected' || existing.status === 'failed'
    if (now > existing.expires_at && !terminal) {
      if (inFlightRemoteCommands.has(existing.command_id)) {
        // 已 accepted 的执行到底（不受过期影响）；过期后再触发拒绝且不改行状态
        throw new ServiceError('COMMAND_EXPIRED', `remote command: expired while executing (command continues to terminal state, docs/14 B.5)`)
      }
      // 到达仍未执行 → status=expired + command.result(expired) 事件；再触发 → 409
      db.prepare("UPDATE remote_commands SET status = 'expired', error_code = 'COMMAND_EXPIRED', executed_at = ? WHERE id = ?").run(
        now,
        existing.id,
      )
      const providerKey = readProviderRow(session.provider_id)?.provider
      recordCommandResult({
        ...(providerKey !== undefined ? { providerKey } : {}),
        sessionId: input.sessionId,
        nativeId: session.native_id,
        commandId: existing.command_id,
        action: input.action,
        status: 'expired',
        errorCode: 'COMMAND_EXPIRED',
      })
      // M2-R1：relay 面终态回帧（commandDownlink 按 commandId 过滤）
      notifyRemoteCommandTerminal({
        commandId: existing.command_id,
        idempotencyKey: key,
        sessionId: input.sessionId,
        action: input.action,
        status: 'expired',
        errorCode: 'COMMAND_EXPIRED',
      })
      throw new ServiceError('COMMAND_EXPIRED', `remote command: command expired (expires_at = ${existing.expires_at}, docs/14 B.5)`)
    }
    // 同 key 重试：原命令原结果，不重复执行（终态/未过期均返回原结果）
    return { commandId: existing.command_id, status: commandRowStatusToResult(existing.status) }
  }

  // 门（授权矩阵 + 能力验证）先于落库：拒绝的指令不产生流水行
  const gate = resolveCommandGate(session, input.action)
  const commandId = `cmd-${randomUUID()}`
  db.prepare(
    "INSERT INTO remote_commands (command_id, idempotency_key, device_id, session_id, action, payload_json, status, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, 'accepted', ?, ?)",
  ).run(commandId, key, dbVal(input.deviceId), input.sessionId, input.action, payloadJson, now + REMOTE_COMMAND_TTL_SEC, now)
  insertSecurityAudit(
    'command',
    'command_accepted',
    input.deviceId,
    'success',
    JSON.stringify({ commandId, sessionId: input.sessionId, action: input.action, source: 'rest' }),
  )
  // 202 accepted 语义：响应先回，执行到底（结果照常回写 command.result 事件）
  void executeRemoteCommand({
    commandId,
    idempotencyKey: key,
    providerKey: gate.providerKey,
    nativeId: session.native_id,
    sessionId: input.sessionId,
    deviceId: input.deviceId,
    action: input.action,
    text: input.text,
  })
  return { commandId, status: 'accepted' }
}

/** 后台执行体：provider 动作 → remote_commands 终态 + command.result 事件（异常折叠，绝不上抛）。 */
async function executeRemoteCommand(input: {
  commandId: string
  /** M2-R1：relay 面终态回帧（notifyRemoteCommandTerminal）所需幂等键。 */
  idempotencyKey: string
  providerKey: string
  nativeId: string
  sessionId: number
  deviceId: number
  action: AgentCapability
  text?: string
}): Promise<void> {
  inFlightRemoteCommands.add(input.commandId)
  const db = getDatabase()
  try {
    const instance = getProviderInstance(input.providerKey as AgentProviderId)
    if (instance === undefined) {
      throw new ServiceError('AGENT_PROVIDER_UNAVAILABLE', `remote command: provider "${input.providerKey}" is not wired in this build`)
    }
    const ref: SessionRef = { providerId: input.providerKey as AgentProviderId, nativeId: input.nativeId }
    const outcome =
      input.action === 'reply'
        ? await instance.sendReply(ref, input.text ?? '')
        : input.action === 'pause'
          ? await instance.pause(ref)
          : await instance.resume(ref)
    const now = nowSec()
    if (outcome.ok) {
      db.prepare("UPDATE remote_commands SET status = 'executed', result_json = ?, executed_at = ? WHERE command_id = ?").run(
        JSON.stringify({ status: 'executed' }),
        now,
        input.commandId,
      )
      insertSecurityAudit('command', 'command_executed', input.deviceId, 'success', JSON.stringify({ commandId: input.commandId, action: input.action }))
      applyActionOutcomeStatus(input.providerKey, input.nativeId, input.action)
      recordCommandResult({
        providerKey: input.providerKey,
        sessionId: input.sessionId,
        nativeId: input.nativeId,
        commandId: input.commandId,
        action: input.action,
        status: 'executed',
      })
      notifyRemoteCommandTerminal({
        commandId: input.commandId,
        idempotencyKey: input.idempotencyKey,
        sessionId: input.sessionId,
        action: input.action,
        status: 'executed',
        errorCode: null,
      })
    } else if (outcome.status === 'unsupported') {
      db.prepare("UPDATE remote_commands SET status = 'rejected', error_code = 'AGENT_CAPABILITY_MISSING', result_json = ?, executed_at = ? WHERE command_id = ?").run(
        JSON.stringify({ status: 'unsupported' }),
        now,
        input.commandId,
      )
      insertSecurityAudit('command', 'command_rejected', input.deviceId, 'denied', JSON.stringify({ commandId: input.commandId, action: input.action, errorCode: 'AGENT_CAPABILITY_MISSING' }))
      recordCommandResult({
        providerKey: input.providerKey,
        sessionId: input.sessionId,
        nativeId: input.nativeId,
        commandId: input.commandId,
        action: input.action,
        status: 'rejected',
        errorCode: 'AGENT_CAPABILITY_MISSING',
      })
      notifyRemoteCommandTerminal({
        commandId: input.commandId,
        idempotencyKey: input.idempotencyKey,
        sessionId: input.sessionId,
        action: input.action,
        status: 'rejected',
        errorCode: 'AGENT_CAPABILITY_MISSING',
      })
    } else {
      const errorCode = outcome.errorCode ?? 'COMMAND_NOT_EXECUTABLE'
      db.prepare('UPDATE remote_commands SET status = ?, error_code = ?, result_json = ?, executed_at = ? WHERE command_id = ?').run(
        'failed',
        errorCode,
        JSON.stringify({ status: outcome.status }),
        now,
        input.commandId,
      )
      insertSecurityAudit('command', 'command_rejected', input.deviceId, 'error', JSON.stringify({ commandId: input.commandId, action: input.action, errorCode }))
      recordCommandResult({
        providerKey: input.providerKey,
        sessionId: input.sessionId,
        nativeId: input.nativeId,
        commandId: input.commandId,
        action: input.action,
        status: 'failed',
        errorCode,
      })
      notifyRemoteCommandTerminal({
        commandId: input.commandId,
        idempotencyKey: input.idempotencyKey,
        sessionId: input.sessionId,
        action: input.action,
        status: 'failed',
        errorCode,
      })
    }
  } catch (err) {
    // 门后异常折叠为 rejected + 结构化错误码（约束 #14；事件照发，远程端可见）
    const errorCode = err instanceof ServiceError ? err.code : 'COMMAND_NOT_EXECUTABLE'
    try {
      db.prepare("UPDATE remote_commands SET status = 'rejected', error_code = ?, executed_at = ? WHERE command_id = ?").run(
        errorCode,
        nowSec(),
        input.commandId,
      )
      insertSecurityAudit('command', 'command_rejected', input.deviceId, 'error', JSON.stringify({ commandId: input.commandId, action: input.action, errorCode }))
      recordCommandResult({
        providerKey: input.providerKey,
        sessionId: input.sessionId,
        nativeId: input.nativeId,
        commandId: input.commandId,
        action: input.action,
        status: 'rejected',
        errorCode,
      })
      notifyRemoteCommandTerminal({
        commandId: input.commandId,
        idempotencyKey: input.idempotencyKey,
        sessionId: input.sessionId,
        action: input.action,
        status: 'rejected',
        errorCode,
      })
    } catch {
      /* 双重失败：行保持 accepted + expires_at 兜底（事件丢失可由重试幂等覆盖） */
    }
  } finally {
    inFlightRemoteCommands.delete(input.commandId)
  }
}

// ---------------------------------------------------------------------------
// R6 — 托管会话启动（ux 批 A：REST POST /v1/providers/{providerId}/sessions 的
// L3 落点；内部经 provider 托管通道（exec.spawnManaged 双上限），仅 capabilities
// 已授予 managed 的 provider 开放；幂等四件套对齐 docs/14 §B.5）
// ---------------------------------------------------------------------------

/** 托管启动任务文本上限（与 codex MANAGED_TASK_MAX_CHARS / reply 4000 同量级）。 */
export const MANAGED_SESSION_TASK_MAX_CHARS = 4_000

export interface ManagedSessionStartInput {
  /**
   * 发起设备（remote_devices.id；审计与 remote_commands.device_id 归因）。
   * CP5 起可缺省：桌面内部分（ContestPin agentSubmit）无配对设备语义，
   * device_id 落 NULL（004 列可空，ON DELETE SET NULL 同款）——能力门/幂等/
   * 审计语义零变化（docs/22 §8 落地注记）。
   */
  deviceId?: number
  /** provider 业务键（'codex'）或 agent_providers 行数字 id（两者都受理）。 */
  provider: string
  /** 托管任务文本（非空 ≤4000 字符；BAD_PAYLOAD）。 */
  task: string
  /** 客户端幂等键（docs/14 §B.5 语义同 reply/actions）。 */
  idempotencyKey?: string
  /** 审计 source 标签（缺省 'rest' 维持既有投影；CP5 桌面内部传入 'contestpin'）。 */
  source?: string
}

export interface ManagedSessionStartResult {
  commandId: string
  status: 'accepted' | 'executed' | 'rejected'
  /** 执行成功时解析出的本地会话行 id（App 跳转会话详情用）。 */
  sessionId?: number
  nativeId?: string
}

/** spawn 幂等行的 result_json 形态（重试原结果还原 sessionId/nativeId）。 */
interface ManagedSpawnResultJson {
  status: 'accepted' | 'executed' | 'rejected'
  nativeId?: string
  sessionId?: number
}

/**
 * 启动托管会话（同步执行；docs/14 §B.5 幂等语义同 reply/actions）：
 * 1. provider 解析（业务键或数字 id）→ NOT_FOUND；
 * 2. 门：能力未验证/过期 → AGENT_CAPABILITY_MISSING；caps.mode ≠ 'managed' 或
 *    provider 未实现 startManagedSession → COMMAND_NOT_EXECUTABLE（任务书 R6：
 *    仅 managed provider 开放，其余 403，绝不降安全标准）；
 * 3. 幂等：remote_commands(action='spawn', session_id NULL) 同 key 同 payload →
 *    原命令原结果；同 key 异 payload → COMMAND_KEY_CONFLICT；过期 → COMMAND_EXPIRED；
 * 4. 执行：provider.startManagedSession(task, sink)（sink = 监控 sink，快照/事件
 *    经 L3 落库）→ 行终态 + command.result 事件 + 审计。
 */
export async function startProviderManagedSession(input: ManagedSessionStartInput): Promise<ManagedSessionStartResult> {
  const db = getDatabase()
  if (input.task.trim().length === 0 || input.task.length > MANAGED_SESSION_TASK_MAX_CHARS) {
    throw new ServiceError('BAD_PAYLOAD', `managed session: task must be a non-empty string of 1..${MANAGED_SESSION_TASK_MAX_CHARS} chars`)
  }
  // provider 解析：数字 id 或业务键（/v1/agents 投影给 App 的是数字 id，业务键
  // 更稳定可读——两种形态都受理，docs/14 §B.1 注明）
  const numericId = /^\d+$/.test(input.provider) ? Number.parseInt(input.provider, 10) : null
  const providerRow = (
    numericId !== null
      ? (db.prepare('SELECT * FROM agent_providers WHERE id = ?').get(numericId) as ProviderRow | undefined)
      : (db.prepare('SELECT * FROM agent_providers WHERE provider = ?').get(input.provider) as ProviderRow | undefined)
  )
  if (providerRow === undefined) {
    throw new ServiceError('NOT_FOUND', `agent provider "${input.provider}" not found`)
  }
  const providerKey = providerRow.provider

  // 幂等键查重（先于门：重试不重复执行；同 key 异 payload 拒绝）
  const key = input.idempotencyKey ?? `auto-${randomUUID()}`
  const payloadJson = JSON.stringify({ task: redactText(input.task) })
  const now = nowSec()
  const existing = db.prepare('SELECT * FROM remote_commands WHERE idempotency_key = ?').get(key) as
    | RemoteCommandRow
    | undefined
  if (existing !== undefined) {
    const samePayload = existing.action === 'spawn' && (existing.payload_json ?? '{}') === payloadJson
    if (!samePayload) {
      throw new ServiceError('COMMAND_KEY_CONFLICT', 'managed session: idempotency key already used with a different payload (docs/14 B.5)')
    }
    if (existing.status === 'expired') {
      throw new ServiceError('COMMAND_EXPIRED', 'managed session: command expired (idempotent retry on expired command, docs/14 B.5)')
    }
    const terminal = existing.status === 'executed' || existing.status === 'rejected' || existing.status === 'failed'
    if (now > existing.expires_at && !terminal && !inFlightRemoteCommands.has(existing.command_id)) {
      db.prepare("UPDATE remote_commands SET status = 'expired', error_code = 'COMMAND_EXPIRED', executed_at = ? WHERE id = ?").run(now, existing.id)
      recordCommandResult({ providerKey, commandId: existing.command_id, action: 'spawn', status: 'expired', errorCode: 'COMMAND_EXPIRED' })
      throw new ServiceError('COMMAND_EXPIRED', 'managed session: command expired (docs/14 B.5)')
    }
    // 同 key 重试：原命令原结果（含 sessionId/nativeId 还原）
    let prior: ManagedSpawnResultJson = { status: commandRowStatusToResult(existing.status) }
    try {
      const parsed = JSON.parse(existing.result_json ?? '{}') as Partial<ManagedSpawnResultJson>
      prior = {
        status: commandRowStatusToResult(existing.status),
        ...(parsed.nativeId !== undefined ? { nativeId: parsed.nativeId } : {}),
        ...(parsed.sessionId !== undefined ? { sessionId: parsed.sessionId } : {}),
      }
    } catch {
      /* result_json 缺失/损坏 → 仅返回状态 */
    }
    return {
      commandId: existing.command_id,
      status: prior.status,
      ...(prior.nativeId !== undefined ? { nativeId: prior.nativeId } : {}),
      ...(prior.sessionId !== undefined ? { sessionId: prior.sessionId } : {}),
    }
  }

  // 门（能力验证 + managed 授权）先于落库：拒绝的指令不产生流水行
  const caps = parseCapabilitySet(providerRow.capabilities_json)
  const verifiedFresh = caps.verifiedAt > 0 && nowSec() - caps.verifiedAt <= CAPABILITY_TTL_SEC
  if (!verifiedFresh) {
    throw new ServiceError('AGENT_CAPABILITY_MISSING', `managed session: capabilities for provider "${providerKey}" are not verified or stale (>300s), re-probe required`)
  }
  if (caps.mode !== 'managed') {
    throw new ServiceError('COMMAND_NOT_EXECUTABLE', `managed session: provider "${providerKey}" is not granted managed capabilities (mode=${caps.mode}; docs/12 §5)`)
  }
  const instance = getProviderInstance(providerKey as AgentProviderId)
  if (instance === undefined) {
    throw new ServiceError('AGENT_PROVIDER_UNAVAILABLE', `managed session: provider "${providerKey}" is not wired in this build`)
  }
  if (instance.startManagedSession === undefined) {
    throw new ServiceError('COMMAND_NOT_EXECUTABLE', `managed session: provider "${providerKey}" does not implement managed session start`)
  }

  const commandId = `cmd-${randomUUID()}`
  db.prepare(
    "INSERT INTO remote_commands (command_id, idempotency_key, device_id, session_id, action, payload_json, status, expires_at, created_at) VALUES (?, ?, ?, NULL, 'spawn', ?, 'accepted', ?, ?)",
  ).run(commandId, key, dbVal(input.deviceId), payloadJson, now + REMOTE_COMMAND_TTL_SEC, now)
  insertSecurityAudit(
    'command',
    'command_accepted',
    dbVal(input.deviceId),
    'success',
    JSON.stringify({ commandId, provider: providerKey, action: 'spawn', source: input.source ?? 'rest' }),
  )

  inFlightRemoteCommands.add(commandId)
  try {
    // sink = 监控 sink：托管快照（mode:'managed'）经 L3 upsert 落库 + session.started
    const sink = buildMonitorSink(providerKey)
    const outcome = await instance.startManagedSession(input.task, sink)
    if (!outcome.ok || outcome.nativeId === undefined) {
      const detail = outcome.detail ?? 'managed session start failed'
      db.prepare("UPDATE remote_commands SET status = 'failed', error_code = 'COMMAND_NOT_EXECUTABLE', result_json = ?, executed_at = ? WHERE command_id = ?").run(
        JSON.stringify({ status: 'failed', detail: detail.slice(0, 200) }),
        nowSec(),
        commandId,
      )
      insertSecurityAudit('command', 'command_rejected', dbVal(input.deviceId), 'error', JSON.stringify({ commandId, action: 'spawn', errorCode: 'COMMAND_NOT_EXECUTABLE' }))
      recordCommandResult({ providerKey, commandId, action: 'spawn', status: 'failed', errorCode: 'COMMAND_NOT_EXECUTABLE' })
      throw new ServiceError('COMMAND_NOT_EXECUTABLE', `managed session: ${detail.slice(0, 200)}`)
    }
    const nativeId = outcome.nativeId
    const sessionRow = db
      .prepare('SELECT id FROM agent_sessions WHERE provider_id = ? AND native_id = ?')
      .get(providerRow.id, nativeId) as { id: number } | undefined
    const sessionId = sessionRow?.id
    db.prepare("UPDATE remote_commands SET status = 'executed', result_json = ?, executed_at = ? WHERE command_id = ?").run(
      JSON.stringify({ status: 'executed', nativeId, ...(sessionId !== undefined ? { sessionId } : {}) } satisfies ManagedSpawnResultJson),
      nowSec(),
      commandId,
    )
    insertSecurityAudit('command', 'command_executed', dbVal(input.deviceId), 'success', JSON.stringify({ commandId, action: 'spawn', provider: providerKey }))
    // 托管 turn 已真实发起 → running（随后由监控管线按 rollout 观察收敛）
    applySessionStatus(providerKey, nativeId, 'running', 'managed session started (DevHub-initiated)')
    recordCommandResult({ providerKey, ...(sessionId !== undefined ? { sessionId } : {}), nativeId, commandId, action: 'spawn', status: 'executed' })
    return { commandId, status: 'executed', nativeId, ...(sessionId !== undefined ? { sessionId } : {}) }
  } catch (err) {
    if (err instanceof ServiceError) throw err
    db.prepare("UPDATE remote_commands SET status = 'failed', error_code = 'COMMAND_NOT_EXECUTABLE', executed_at = ? WHERE command_id = ?").run(nowSec(), commandId)
    recordCommandResult({ providerKey, commandId, action: 'spawn', status: 'failed', errorCode: 'COMMAND_NOT_EXECUTABLE' })
    throw new ServiceError('COMMAND_NOT_EXECUTABLE', `managed session: ${err instanceof Error ? err.message : String(err)}`.slice(0, 220))
  } finally {
    inFlightRemoteCommands.delete(commandId)
  }
}

/**
 * claim 成功的设备落库（gateway/pairing 经此写入——写库经 L3 函数，裁决；
 * Token 明文绝不入参：只收 tokenHash，docs/15 §3）。
 */
export function pairDevice(input: { deviceName: string; platform: string; tokenHash: string }): { deviceId: number; tokenVersion: number } {
  const db = getDatabase()
  const now = nowSec()
  const info = db
    .prepare(
      "INSERT INTO remote_devices (device_name, platform, token_hash, token_version, status, paired_at, created_at, updated_at) VALUES (?, ?, ?, 1, 'active', ?, ?, ?)",
    )
    .run(input.deviceName.slice(0, 100), input.platform, input.tokenHash, now, now, now)
  const deviceId = Number(info.lastInsertRowid)
  insertSecurityAudit('device', 'device_paired', deviceId, 'success', JSON.stringify({ platform: input.platform }))
  return { deviceId, tokenVersion: 1 }
}

/** last_seen 节流写（60s 内存节流；Gateway 鉴权/WS 连接/ack 时触达）。 */
const LAST_SEEN_THROTTLE_SEC = 60
const lastSeenTouches = new Map<number, number>()

export function touchDeviceLastSeen(deviceId: number): void {
  const now = nowSec()
  if (now - (lastSeenTouches.get(deviceId) ?? 0) < LAST_SEEN_THROTTLE_SEC) return
  lastSeenTouches.set(deviceId, now)
  getDatabase()
    .prepare('UPDATE remote_devices SET last_seen_at = ?, updated_at = ? WHERE id = ?')
    .run(now, now, deviceId)
}

// ---------------------------------------------------------------------------
// M2-R1 — 设备 Token 轮换（docs/18 §3.14 + docs/19 §4.5 rotationBridge 数据面：
// L3 新 Token 生成 + token_hash 覆盖 + token_version+1 + 审计；schema 现字段
// 承载，零 migration。明文 Token 仅返回值一次性流转进 token_rotation 帧——
// 红线受控面 docs/19 §3 W-R3，绝不入日志/审计/DB）
// ---------------------------------------------------------------------------

/** 轮换原因全集（docs/18 §3.14 reason 枚举）。 */
export type DeviceTokenRotationReason = 'post-pairing' | 'manual' | 'periodic'

/**
 * 设备 Token 轮换（rotationBridge 的 L3 落点；docs/18 §3.14「Windows 侧落库」行）：
 * 撤销设备 → DEVICE_REVOKED（轮换对撤销设备无意义，撤销即拒不可复活）；成功 =
 * sha256(newToken) 覆盖 token_hash + token_version+1 + 审计 device/token_rotated
 * （detail 零 Token 明文）。宽限跟踪（300s 确认窗口）与帧发送归 rotationBridge。
 *
 * M3-C7b 修 ②（docs/18 §3.14 宽限桌面镜像）：覆盖前把旧 token_hash 存入
 * previous_token_hash 并登记 rotated_at（unix 秒）——gateway/auth.ts 据此在
 * 300s 宽限窗内仍认旧 Token（窗外拒；无轮换行恒认当前值）。migration 006
 * append-only 新列承载，零重建。
 */
export function rotateDeviceToken(
  deviceId: number,
  reason: DeviceTokenRotationReason,
): { deviceId: number; tokenVersion: number; token: string } {
  const db = getDatabase()
  const row = db.prepare('SELECT id, status, token_version, token_hash FROM remote_devices WHERE id = ?').get(deviceId) as
    | { id: number; status: string; token_version: number; token_hash: string }
    | undefined
  if (row === undefined) {
    throw new ServiceError('NOT_FOUND', `remote device ${deviceId} not found`)
  }
  if (row.status === 'revoked') {
    throw new ServiceError('DEVICE_REVOKED', `remote device ${deviceId} is revoked; token rotation refused (revocation is final, docs/15 §4)`)
  }
  const token = generateDeviceToken()
  const tokenVersion = Number(row.token_version) + 1
  const now = nowSec()
  db.prepare(
    'UPDATE remote_devices SET previous_token_hash = token_hash, rotated_at = ?, token_hash = ?, token_version = ?, updated_at = ? WHERE id = ?',
  ).run(now, sha256Hex(token), tokenVersion, now, deviceId)
  insertSecurityAudit('device', 'token_rotated', deviceId, 'success', JSON.stringify({ reason, tokenVersion }))
  return { deviceId, tokenVersion, token }
}

// ---------------------------------------------------------------------------
// AC3 — Provider 探测 / 会话/消息落库 / 资源登记 / 监控启停接线
// （docs/16 §1 AC3 行；写库只发生在本 Service，约束 #20）
// ---------------------------------------------------------------------------

/** 探测最小间隔（节流；agents:providers 轮询触发的探测不每次打真实子进程）。 */
const PROBE_MIN_INTERVAL_SEC = 60
/** 能力重验最小间隔（docs/12 §5：verifiedAt > 300s 过期 → 240s 时主动重验）。 */
const CAPABILITY_REVERIFY_MIN_SEC = 240

// ---------------------------------------------------------------------------
// R5（ux 批 A）：全量会话快照刷新自适应节流。
// 「活跃 provider」（其任一会话的 last_activity_at 距今 ≤ 活跃窗口）快刷（3s，
//  任务书允许 2–5s）；空闲保持 15s。读失败降级（monitorRegistry SLOW_POLL_MS=15s
//  的 provider 监控轮询）逻辑不动——本节流只约束 L3 全量兜底刷新。
// ---------------------------------------------------------------------------

/** 活跃 provider 快刷间隔（秒；任务书 §2 R5：2–5s 区间取 3s）。 */
export const SESSIONS_REFRESH_ACTIVE_SEC = 3
/** 空闲 provider 刷新间隔（秒；原 SESSIONS_REFRESH_MIN_INTERVAL_SEC 固定值）。 */
export const SESSIONS_REFRESH_IDLE_SEC = 15
/** provider 活跃判定窗口（秒；近 5 分钟有会话活动视为活跃）。 */
export const PROVIDER_ACTIVE_WINDOW_SEC = 300

/**
 * 自适应刷新间隔纯函数（smoke 直测）：
 * 活跃（lastActivityAt 距 now ≤ 窗口且非空）→ ACTIVE(3s)；否则 → IDLE(15s)。
 */
export function sessionsRefreshIntervalSec(now: number, latestActivityAt: number | null | undefined): number {
  if (latestActivityAt !== null && latestActivityAt !== undefined && latestActivityAt > 0 && now - latestActivityAt <= PROVIDER_ACTIVE_WINDOW_SEC) {
    return SESSIONS_REFRESH_ACTIVE_SEC
  }
  return SESSIONS_REFRESH_IDLE_SEC
}

/** provider 快照刷新节流表（内存态；探测节流以 DB last_probe_at 为准）。 */
const sessionsThrottle = new Map<string, number>()

/** 该 provider 全部会话的最新活动时刻（无会话/无活动 → null；JOIN 经 provider 业务键）。 */
function latestProviderActivityAt(providerKey: string): number | null {
  const row = getDatabase()
    .prepare(
      `SELECT MAX(s.last_activity_at) AS m FROM agent_sessions s
       JOIN agent_providers p ON p.id = s.provider_id WHERE p.provider = ?`,
    )
    .get(providerKey) as { m: number | null }
  return row.m === null ? null : Number(row.m)
}

/** catalog → agent_providers 行 ensure（docs/13 §4.1；WHERE NOT EXISTS 参数绑定）。 */
export function ensureAgentProviderRows(): void {
  const db = getDatabase()
  for (const entry of AGENT_PROVIDER_CATALOG) {
    db.prepare(
      'INSERT INTO agent_providers (provider, display_name, created_at, updated_at) SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM agent_providers WHERE provider = ?)',
    ).run(entry.id, entry.displayName, nowSec(), nowSec(), entry.id)
  }
}

function readProviderRowByKey(providerKey: string): ProviderRow | undefined {
  return getDatabase().prepare('SELECT * FROM agent_providers WHERE provider = ?').get(providerKey) as
    | ProviderRow
    | undefined
}

/** workdir 归一匹配 projects.win_path / wsl_path；匹配不上 project_id=NULL，绝不造行。 */
export function matchProjectByWorkdir(workdir: string | null | undefined): number | null {
  if (workdir === undefined || workdir === null || workdir.trim().length === 0) return null
  const key = normalizePathKey(workdir)
  if (key.length === 0) return null
  const rows = getDatabase().prepare('SELECT id, win_path, wsl_path FROM projects').all() as unknown as Array<{
    id: number
    win_path: string | null
    wsl_path: string | null
  }>
  for (const row of rows) {
    if (row.win_path !== null && normalizePathKey(row.win_path) === key) return row.id
    if (row.wsl_path !== null && normalizePathKey(row.wsl_path) === key) return row.id
  }
  return null
}

/**
 * 资源登记（docs/13 §5）：agent/session 资源节点 + monitors/exposes 边；
 * mode 变化时同事务内换边（删除对侧边再建新边）。
 */
function registerSessionResources(providerRowId: number, providerKey: string, sessionRowId: number, nativeId: string, mode: SessionMode): void {
  const db = getDatabase()
  const agentRes = registerResource(db, 'agent', providerRowId, providerKey)
  const shortId = nativeId.length > 12 ? nativeId.slice(0, 12) : nativeId
  const sessionRes = registerResource(db, 'session', sessionRowId, `${providerKey}:${shortId}`)
  const wanted = mode === 'observed' ? 'exposes' : 'monitors'
  const opposite = mode === 'observed' ? 'monitors' : 'exposes'
  db.prepare('DELETE FROM relationships WHERE source_resource_id = ? AND target_resource_id = ? AND relation_type = ?').run(
    agentRes,
    sessionRes,
    opposite,
  )
  relate(db, agentRes, sessionRes, wanted as 'monitors' | 'exposes')
}

/** provider 资源节点登记（agent_providers 行 → resources）。 */
function registerProviderResource(providerRowId: number, displayName: string): void {
  registerResource(getDatabase(), 'agent', providerRowId, displayName)
}

/**
 * 会话 upsert（(provider_id, native_id) 幂等；docs/13 §4.2）。
 * 返回会话行 id 与是否新建；新建时登记资源边并返回 created=true（供 session.started）。
 * 显式 mode 双向换边语义保持 docs/13 §5（ac3-102 锁定）；扫描路径的 mode 保持见
 * scanAwareSessionMode。
 * ux 批 A（R2）：快照携带 parentNativeSessionId 时——父行存在 → 落/回填
 * parent_session_id；父行未知 → 不落子行（返回 null，绝不猜父、绝不造父行）。
 * 同轮全量发现按源 rowid 序先父后子（zcode 实测父子创建序），监控增量路径
 * 天然满足；父行缺失的子快照等下一轮父行就位后再落。
 */
export function upsertSessionSnapshot(
  providerKey: string,
  snapshot: SessionSnapshot,
  mode: SessionMode = 'observed',
): { sessionId: number; created: boolean } | null {
  const provider = readProviderRowByKey(providerKey)
  if (provider === undefined) return null
  const db = getDatabase()
  // R2：父行解析（快照声明父子关系时）——父行不存在则拒绝落子行
  let parentRowId: number | null = null
  if (snapshot.parentNativeSessionId !== undefined) {
    const parentRow = db
      .prepare('SELECT id FROM agent_sessions WHERE provider_id = ? AND native_id = ?')
      .get(provider.id, snapshot.parentNativeSessionId) as { id: number } | undefined
    if (parentRow === undefined) return null
    parentRowId = parentRow.id
  }
  const existing = db
    .prepare('SELECT id, session_mode, project_id, workdir, title, started_at, last_activity_at, parent_session_id FROM agent_sessions WHERE provider_id = ? AND native_id = ?')
    .get(provider.id, snapshot.nativeId) as
    | { id: number; session_mode: string; project_id: number | null; workdir: string | null; title: string | null; started_at: number | null; last_activity_at: number | null; parent_session_id: number | null }
    | undefined
  const projectId = matchProjectByWorkdir(snapshot.workdir)
  const now = nowSec()
  if (existing === undefined) {
    const info = db
      .prepare(
        'INSERT INTO agent_sessions (provider_id, native_id, session_mode, project_id, workdir, title, status, started_at, last_activity_at, parent_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        provider.id,
        snapshot.nativeId,
        mode,
        dbVal(projectId),
        dbVal(snapshot.workdir ?? null),
        dbVal(snapshot.title ?? null),
        'unknown',
        dbVal(snapshot.startedAt ?? null),
        dbVal(snapshot.lastActivityAt ?? null),
        dbVal(parentRowId),
        now,
        now,
      )
    const sessionId = Number(info.lastInsertRowid)
    registerSessionResources(provider.id, providerKey, sessionId, snapshot.nativeId, mode)
    return { sessionId, created: true }
  }
  // 既有行：补全（title/workdir 空缺时填、last_activity 取新、project 首次匹配落位）；
  // 状态绝不在此触碰（状态归 applySessionStatus 的事件语义）。
  const modeChanged = existing.session_mode !== mode
  const updates: string[] = []
  const params: (string | number | null)[] = []
  if (existing.title === null && snapshot.title !== undefined) {
    updates.push('title = ?')
    params.push(snapshot.title)
  }
  if ((existing.workdir === null || existing.workdir.length === 0) && snapshot.workdir !== undefined) {
    updates.push('workdir = ?')
    params.push(snapshot.workdir)
    if (existing.project_id === null && projectId !== null) {
      updates.push('project_id = ?')
      params.push(projectId)
    }
  }
  if (existing.started_at === null && snapshot.startedAt !== undefined) {
    updates.push('started_at = ?')
    params.push(snapshot.startedAt)
  }
  if (snapshot.lastActivityAt !== undefined && (existing.last_activity_at === null || snapshot.lastActivityAt > existing.last_activity_at)) {
    updates.push('last_activity_at = ?')
    params.push(snapshot.lastActivityAt)
  }
  updates.push('updated_at = ?')
  params.push(now)
  if (modeChanged) {
    // session_mode 变化与换边同事务语义（docs/13 §5）；列更新在此，边切换见下方
    updates.push('session_mode = ?')
    params.push(mode)
  }
  if (parentRowId !== null && existing.parent_session_id === null) {
    // R2 回填：先到的子快照（父行当时未知被拒）不适用——本支路只在父行已存在时
    // 到达；此处处理「子行先以无父语义落库（历史行/旧版本），父快照后补」的形态
    updates.push('parent_session_id = ?')
    params.push(parentRowId)
  }
  db.prepare(`UPDATE agent_sessions SET ${updates.join(', ')} WHERE id = ?`).run(...params, existing.id)
  if (modeChanged) registerSessionResources(provider.id, providerKey, existing.id, snapshot.nativeId, mode)
  return { sessionId: existing.id, created: false }
}

/**
 * AC8：扫描路径的 mode 保持——快照无 mode（纯扫描投影）时沿用既有行 mode，
 * 绝不在扫描/重扫路径上改写会话模式（managed 行在 DevHub 重启、provider 内存
 * 丢失、rollout 重扫后仍保持 managed——「DevHub 发起」是第一手事实，观察投影
 * 无权改写；显式带 mode 的调用（attach/managed 快照）照常换边，docs/13 §5）。
 */
function scanAwareSessionMode(providerKey: string, snapshot: SessionSnapshot): SessionMode {
  if (snapshot.mode !== undefined) return snapshot.mode
  const provider = readProviderRowByKey(providerKey)
  if (provider === undefined) return 'observed'
  const row = getDatabase()
    .prepare('SELECT session_mode FROM agent_sessions WHERE provider_id = ? AND native_id = ?')
    .get(provider.id, snapshot.nativeId) as { session_mode: string } | undefined
  return row !== undefined ? (asSessionMode(row.session_mode)) : 'observed'
}

function asSessionMode(value: string): SessionMode {
  return value === 'managed' || value === 'attached' ? value : 'observed'
}

/** 确保会话行存在（状态事件到达但快照未发现的兜底；绝不造 project 匹配）。 */
function ensureSessionRow(providerKey: string, nativeId: string): number | null {
  const provider = readProviderRowByKey(providerKey)
  if (provider === undefined) return null
  const db = getDatabase()
  const existing = db
    .prepare('SELECT id FROM agent_sessions WHERE provider_id = ? AND native_id = ?')
    .get(provider.id, nativeId) as { id: number } | undefined
  if (existing !== undefined) return existing.id
  const now = nowSec()
  const info = db
    .prepare(
      "INSERT INTO agent_sessions (provider_id, native_id, session_mode, status, created_at, updated_at) VALUES (?, ?, 'observed', 'unknown', ?, ?)",
    )
    .run(provider.id, nativeId, now, now)
  const sessionId = Number(info.lastInsertRowid)
  registerSessionResources(provider.id, providerKey, sessionId, nativeId, 'observed')
  return sessionId
}

/**
 * 会话状态落库 + 事件（docs/12 §6：status_changed 仅状态 ≠ 旧值才发；
 * waiting_input 事件 payload.status 两值；终态 → session.finished）。
 */
export function applySessionStatus(providerKey: string, nativeId: string, to: SessionStatus, detail?: string): number | null {
  const sessionId = ensureSessionRow(providerKey, nativeId)
  if (sessionId === null) return null
  const db = getDatabase()
  const row = db.prepare('SELECT status FROM agent_sessions WHERE id = ?').get(sessionId) as { status: string }
  const from = row.status
  if (from === to) return sessionId // 状态未变：零事件（docs/12 §6 事件表第 2 行）
  const now = nowSec()
  const terminal = (FINISHED_STATUSES as readonly string[]).includes(to)
  if (terminal) {
    db.prepare('UPDATE agent_sessions SET status = ?, status_detail = ?, ended_at = ?, updated_at = ? WHERE id = ?').run(
      to,
      dbVal(detail ?? null),
      now,
      now,
      sessionId,
    )
  } else {
    db.prepare('UPDATE agent_sessions SET status = ?, status_detail = ?, updated_at = ? WHERE id = ?').run(
      to,
      dbVal(detail ?? null),
      now,
      sessionId,
    )
  }
  recordEvent({
    eventType: 'session.status_changed',
    providerKey,
    sessionId,
    nativeId,
    payload: { sessionId, from, to, ...(detail !== undefined ? { detail } : {}) },
    summary: `session ${to}`,
    fingerprint: `${nativeId}:${from}:${to}:${detail ?? ''}`,
  })
  if (to === 'waiting_input' || to === 'approval_required') {
    recordWaitingInputEvent({ providerKey, sessionId, nativeId, status: to, summary: detail })
  }
  if (terminal) {
    recordEvent({
      eventType: 'session.finished',
      providerKey,
      sessionId,
      nativeId,
      payload: { sessionId, finalStatus: to, ...(detail !== undefined ? { exitHint: detail } : {}) },
      summary: `session finished: ${to}`,
      fingerprint: `${nativeId}:finished:${to}`,
    })
  }
  return sessionId
}

/**
 * 消息投影落库（content_redacted 经 redact；source_ref 指向源文件+offset；UNIQUE 幂等）。
 * ux 批 A：segments（R1，provider 有明确转录结构时携带）落 segments_json；
 * R5.1 source-to-db 打点（源 occurredAt → 入库）。
 * run5-fix 批（缺陷 C 单气泡增长）：INSERT OR IGNORE → **upsert**——同
 * (session_id, native_msg_id) 的重复投影从「忽略」改为「覆盖内容」（deepseek
 * 流式形态：同 turn+step 的 text-delta 累积投影共用同一 nativeMsgId，逐段增长
 * 同一条消息；committed 到达时以最终全文+segments 覆盖同一条）。既有五家投影
 * 面语义不变（各自的游标/去重保证无重复投影，upsert 在其路径下等价于 IGNORE）。
 * message.appended 事件指纹同步推进（nativeMsgId:内容长度）——增长步产生新事件
 * （App refreshSignal 依据），同内容重投影零重复（幂等键纪律不变）。
 */
export function persistMessage(providerKey: string, nativeId: string, message: RedactedMessage): { sessionId: number | null; recorded: boolean } {
  const sessionId = ensureSessionRow(providerKey, nativeId)
  if (sessionId === null) return { sessionId: null, recorded: false }
  const db = getDatabase()
  const now = nowSec()
  const segmentsJson = message.segments !== undefined ? JSON.stringify(message.segments) : null
  const info = db
    .prepare(
      `INSERT INTO agent_messages (session_id, native_msg_id, role, content_redacted, source_ref, seq_in_session, occurred_at, segments_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, native_msg_id) DO UPDATE SET
         content_redacted = excluded.content_redacted,
         segments_json = COALESCE(excluded.segments_json, segments_json),
         occurred_at = COALESCE(excluded.occurred_at, occurred_at),
         source_ref = excluded.source_ref`,
    )
    .run(
      sessionId,
      message.nativeMsgId,
      message.role,
      message.contentRedacted,
      message.sourceRef,
      dbVal(message.seqInSession ?? null),
      dbVal(message.occurredAt ?? null),
      dbVal(segmentsJson),
      now,
    )
  const recorded = Number(info.changes) > 0
  if (recorded) {
    if (message.occurredAt !== undefined) {
      // R5.1：源落盘（occurredAt）→ 入库 分段耗时（服务端可测段；批次 C 出对比表）
      recordLatencySample('source-to-db', Date.now() - message.occurredAt * 1000)
      db.prepare('UPDATE agent_sessions SET last_activity_at = MAX(COALESCE(last_activity_at, 0), ?), updated_at = ? WHERE id = ?').run(
        message.occurredAt,
        now,
        sessionId,
      )
    }
    // message.appended（可折叠；指纹 = native_msg_id:内容长度——流式增长步产生
    // 新事件，同内容重放零重复；preview 随内容推进）
    recordEvent({
      eventType: 'message.appended',
      providerKey,
      sessionId,
      nativeId,
      payload: {
        sessionId,
        role: message.role,
        preview: message.contentRedacted.slice(0, 120),
        nativeMsgId: message.nativeMsgId,
        contentLength: message.contentRedacted.length,
      },
      summary: message.contentRedacted.slice(0, 120),
      fingerprint: `${message.nativeMsgId}:${message.contentRedacted.length}`,
    })
  }
  return { sessionId, recorded }
}

/** 监控源失联：该 provider 活跃（非终态）会话置 connection_lost + 逐行事件。 */
export function markProviderSessionsConnectionLost(providerKey: string, detail: string): void {
  const provider = readProviderRowByKey(providerKey)
  if (provider === undefined) return
  const db = getDatabase()
  const rows = db
    .prepare(
      "SELECT id, native_id, status FROM agent_sessions WHERE provider_id = ? AND status NOT IN ('completed', 'failed', 'stopped', 'connection_lost')",
    )
    .all(provider.id) as unknown as Array<{ id: number; native_id: string; status: string }>
  const now = nowSec()
  for (const row of rows) {
    db.prepare('UPDATE agent_sessions SET status = ?, status_detail = ?, updated_at = ? WHERE id = ?').run(
      'connection_lost',
      detail.slice(0, 200),
      now,
      row.id,
    )
    recordEvent({
      eventType: 'session.status_changed',
      providerKey,
      sessionId: row.id,
      nativeId: row.native_id,
      payload: { sessionId: row.id, from: row.status, to: 'connection_lost', detail },
      summary: 'monitoring source lost',
      fingerprint: `${row.native_id}:${row.status}:connection_lost:${detail}`,
    })
  }
}

/** 监控恢复：connection_lost 会话重探回 unknown（判定未定，绝不猜真实态）。 */
export function refreshConnectionLostSessions(providerKey: string): void {
  const provider = readProviderRowByKey(providerKey)
  if (provider === undefined) return
  const db = getDatabase()
  const rows = db
    .prepare("SELECT id, native_id FROM agent_sessions WHERE provider_id = ? AND status = 'connection_lost'")
    .all(provider.id) as unknown as Array<{ id: number; native_id: string }>
  const now = nowSec()
  for (const row of rows) {
    db.prepare('UPDATE agent_sessions SET status = ?, status_detail = ?, updated_at = ? WHERE id = ?').run(
      'unknown',
      'monitor recovered; real status pending re-probe',
      now,
      row.id,
    )
    recordEvent({
      eventType: 'session.status_changed',
      providerKey,
      sessionId: row.id,
      nativeId: row.native_id,
      payload: { sessionId: row.id, from: 'connection_lost', to: 'unknown', detail: 'monitor recovered' },
      summary: 'monitoring recovered',
      fingerprint: `${row.native_id}:connection_lost:unknown:${now}`,
    })
  }
}

/** 全量会话快照刷新（listSessions → upsert；节流由调用方控制）。
 *  ux 批 A（R5）：节流间隔自适应——活跃 provider 快刷 3s，空闲 15s（sessionsRefreshIntervalSec）。 */
export async function refreshProviderSessions(providerKey: string, force = false): Promise<number> {
  const provider = getProviderInstance(providerKey as AgentProviderId)
  if (provider === undefined) return 0
  const now = nowSec()
  const last = sessionsThrottle.get(providerKey) ?? 0
  const interval = sessionsRefreshIntervalSec(now, latestProviderActivityAt(providerKey))
  if (!force && now - last < interval) return 0
  sessionsThrottle.set(providerKey, now)
  const snapshots = await provider.listSessions()
  let created = 0
  for (const snapshot of snapshots) {
    // AC8：快照携带 provider 已确知 mode 时采用之；无 mode 的扫描投影保持既有行 mode
    const result = upsertSessionSnapshot(providerKey, snapshot, scanAwareSessionMode(providerKey, snapshot))
    if (result !== null && result.created) {
      created += 1
      recordEvent({
        eventType: 'session.started',
        providerKey,
        sessionId: result.sessionId,
        nativeId: snapshot.nativeId,
        payload: {
          sessionId: result.sessionId,
          providerId: providerKey,
          ...(snapshot.workdir !== undefined ? { workdir: snapshot.workdir } : {}),
        },
        summary: snapshot.title ?? snapshot.nativeId,
        fingerprint: `${snapshot.nativeId}:started`,
      })
    }
  }
  return created
}

/** 监控 sink → L3 落库接线（docs/12 §7 sink 段）。 */
function buildMonitorSink(providerKey: string): EventSink {
  return {
    onSessionDiscovered: (_providerId, snapshot) => {
      // AC8：快照携带 mode（managed——DevHub 发起的托管线程）时采用；无 mode 的
      // 扫描投影保持既有行 mode（managed 行不被重扫降级）
      const result = upsertSessionSnapshot(providerKey, snapshot, scanAwareSessionMode(providerKey, snapshot))
      if (result !== null && result.created) {
        recordEvent({
          eventType: 'session.started',
          providerKey,
          sessionId: result.sessionId,
          nativeId: snapshot.nativeId,
          payload: {
            sessionId: result.sessionId,
            providerId: providerKey,
            ...(snapshot.workdir !== undefined ? { workdir: snapshot.workdir } : {}),
          },
          summary: snapshot.title ?? snapshot.nativeId,
          fingerprint: `${snapshot.nativeId}:started`,
        })
      }
    },
    onMessageAppended: (ref, message) => {
      persistMessage(providerKey, ref.nativeId, message)
    },
    onStatusChanged: (ref, _from, to, detail) => {
      applySessionStatus(providerKey, ref.nativeId, to, detail)
    },
    onProviderDegraded: (_providerId, failDetail) => {
      recordEvent({
        eventType: 'provider.health_changed',
        providerKey,
        payload: { providerId: providerKey, from: 'ok', to: 'degraded', detail: failDetail },
        summary: `monitor degraded: ${failDetail}`,
        fingerprint: `degraded:${Math.floor(Date.now() / 1000)}`,
      })
      markProviderSessionsConnectionLost(providerKey, failDetail)
    },
    onProviderRecovered: (_providerId) => {
      recordEvent({
        eventType: 'provider.health_changed',
        providerKey,
        payload: { providerId: providerKey, from: 'degraded', to: 'ok', detail: 'monitor source recovered' },
        summary: 'monitor source recovered',
        fingerprint: `recovered:${Math.floor(Date.now() / 1000)}`,
      })
      refreshConnectionLostSessions(providerKey)
    },
  }
}

/** 启动指定 provider 的监控任务（重复调用幂等：已有活跃任务或 provider 行禁用则跳过）。 */
export function startMonitorForProvider(providerKey: string): boolean {
  const providerId = providerKey as AgentProviderId
  if (getMonitorTask(providerId) !== undefined) return false
  const row = readProviderRowByKey(providerKey)
  if (row === undefined || row.enabled !== 1) return false
  const provider = getProviderInstance(providerId)
  if (provider === undefined) return false
  provider.startMonitor(buildMonitorSink(providerKey))
  return true
}

/**
 * 监控任务同步（docs/12 §7）：开关关闭 → cancelAll；开启 → 每 wired provider
 * 至多 1 个活跃 task。settings:set（agents_monitor_enabled）与 agents 读类轮询
 * 共同驱动（幂等）。
 */
export async function syncMonitorTasks(): Promise<void> {
  if (!monitorEnabledSetting()) {
    cancelAllMonitorTasks()
    return
  }
  ensureAgentProviderRows()
  for (const id of WIRED_PROVIDER_IDS) startMonitorForProvider(id)
}

/** 退出收尾（AC5 托盘接线；AC3 供 smoke/测试使用）。 */
export function stopAllAgentControlRuntime(): void {
  cancelAllMonitorTasks()
  clearProviderOverrides()
}

/**
 * 退出收尾·有序完整版（AC5/AC6，docs/12 §10 收尾顺序）：
 * cancelAll 监控 → 关 WS 连接 → 关 Gateway 监听（AC6 已接线，gateway/httpServer
 * stopGateway 幂等且 enabled=0 时零监听直返）→ 托管子进程收尾（provider.dispose）
 * → clearProviderOverrides；closeDatabase 归 index.ts 侧执行。
 * 幂等（重复调用安全），供托盘退出与 before-quit 复用。
 */
export async function shutdownAgentControlRuntime(): Promise<void> {
  cancelAllMonitorTasks()
  // AC6：关 WS 连接 → 关 Gateway 监听（docs/12 §10 顺序第 2/3 步；动态 import
  // 防静态循环——gateway 模块静态依赖本模块）
  try {
    const gw = await import('./gateway/httpServer.ts')
    await gw.stopGateway('app quit teardown (docs/12 §10 order: WS close -> listener close)')
  } catch {
    // Gateway 收尾失败不阻断后续步骤（runQuitTeardown 同纪律）
  }
  // M2-R1：关 relayClient（docs/19 §4.2「托盘退出收尾顺序追加『关 relayClient』一步」
  // ——docs/12 §10 顺序表延伸；动态 import 同上，relayClient/index.ts 静态依赖本模块）
  try {
    const relay = await import('./relayClient/index.ts')
    relay.stopRelayClient('app quit teardown (docs/12 §10 order: relay client close)')
  } catch {
    // relayClient 收尾失败不阻断后续步骤
  }
  for (const id of WIRED_PROVIDER_IDS) {
    const instance = getProviderInstance(id)
    if (instance === undefined) continue
    try {
      await instance.dispose()
    } catch {
      // 单 provider dispose 失败不阻断收尾（killTree 兜底在 provider 内部）
    }
  }
  clearProviderOverrides()
}

// ---------------------------------------------------------------------------
// 托盘摘要计数（AC5，docs/12 §10 托盘菜单「查看 Agent 摘要」tooltip 数据源）
// ---------------------------------------------------------------------------

/** 托盘摘要输入（纯函数 agentSummaryText 消费；traySummary.ts 承载文案）。 */
export interface AgentSummaryCounts {
  totalSessions: number
  activeSessions: number
  waitingInput: number
  approvalRequired: number
  monitorEnabled: boolean
}

/**
 * 托盘摘要计数（真实库投影；托盘与 renderer 同进程直读 Service，约束 #20）。
 * 活跃 = 非终态 7 态中的进行中集合（running/waiting_input/approval_required/
 * paused/connection_lost）；waiting/approval 单列（docs/11 D3 高亮区分的托盘版）。
 */
export function getAgentSummaryCounts(): AgentSummaryCounts {
  const row = getDatabase()
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status IN ('running', 'waiting_input', 'approval_required', 'paused', 'connection_lost') THEN 1 ELSE 0 END) AS active,
         SUM(CASE WHEN status = 'waiting_input' THEN 1 ELSE 0 END) AS waiting,
         SUM(CASE WHEN status = 'approval_required' THEN 1 ELSE 0 END) AS approval
       FROM agent_sessions`,
    )
    .get() as { total: number; active: number | null; waiting: number | null; approval: number | null }
  return {
    totalSessions: Number(row.total ?? 0),
    activeSessions: Number(row.active ?? 0),
    waitingInput: Number(row.waiting ?? 0),
    approvalRequired: Number(row.approval ?? 0),
    monitorEnabled: monitorEnabledSetting(),
  }
}

/**
 * wired provider 探测 + 落库（节流）：health → agent_providers 行；能力重验；
 * 全量会话快照兜底刷新；provider 资源节点；health_changed 事件仅变化沿。
 */
export async function probeWiredProviders(force = false): Promise<void> {
  ensureAgentProviderRows()
  const db = getDatabase()
  for (const id of WIRED_PROVIDER_IDS) {
    const row = readProviderRowByKey(id)
    if (row === undefined || row.enabled !== 1) continue
    const now = nowSec()
    const lastProbe = row.last_probe_at ?? 0
    if (!force && now - lastProbe < PROBE_MIN_INTERVAL_SEC) continue
    const provider = getProviderInstance(id)
    if (provider === undefined) continue
    const health = await provider.probeHealth()
    const from = row.health
    const to = health.health
    db.prepare(
      'UPDATE agent_providers SET installed = ?, version = ?, exe_path = ?, health = ?, health_detail = ?, last_probe_at = ?, updated_at = ? WHERE id = ?',
    ).run(
      health.installed ? 1 : 0,
      dbVal(health.version ?? null),
      dbVal(health.exePath ?? null),
      to,
      dbVal(health.healthDetail ?? null),
      now,
      now,
      row.id,
    )
    registerProviderResource(row.id, row.display_name)
    if (from !== to) {
      recordEvent({
        eventType: 'provider.health_changed',
        providerKey: id,
        payload: { providerId: id, from, to, ...(health.healthDetail !== undefined ? { detail: health.healthDetail } : {}) },
        summary: `${id}: ${from} -> ${to}`,
        fingerprint: `${id}:${from}:${to}:${now}`,
      })
    }
    // 能力重验（节流 240s；docs/12 §5 >300s 过期）
    const caps = parseCapabilitySet(row.capabilities_json)
    const stale = caps.verifiedAt === 0 || now - caps.verifiedAt > CAPABILITY_REVERIFY_MIN_SEC
    if (stale) {
      const verified = await provider.getCapabilities({ providerId: id, nativeId: '-' })
      db.prepare('UPDATE agent_providers SET capabilities_json = ?, updated_at = ? WHERE id = ?').run(
        JSON.stringify(verified),
        nowSec(),
        row.id,
      )
    }
    await refreshProviderSessions(id)
  }
}

/**
 * agents:probeProvider（夜间#1 批次，UX 验收 backlog：per-provider 单独重探，
 * known-limitations §3.2）：对单家 provider 立即 probeHealth + 落库（force 语义，
 * 绕过 60s 全局探测节流）+ 能力过期重验 + 该家会话快照强刷（force）。
 * 返回重探后该家投影；未注册 providerId / 非 wired provider → NOT_FOUND。
 * 探测失败语义与全局探测一致：probeHealth 自身结构化（installed/health/detail），
 * 不因单家失败拖垮其他 provider（这里单家即全部，失败照实落库）。
 */
export async function probeProviderById(providerId: number): Promise<AgentProbeProviderResult> {
  ensureAgentProviderRows()
  const row = readProviderRow(providerId)
  if (row === undefined) {
    throw new ServiceError('NOT_FOUND', `agent provider ${providerId} not found (registered: ${WIRED_PROVIDER_IDS.join(', ')})`)
  }
  const key = row.provider as AgentProviderId
  if ((WIRED_PROVIDER_IDS as readonly string[]).includes(key) === false) {
    throw new ServiceError('NOT_FOUND', `agent provider ${providerId} (${key}) is not a wired provider`)
  }
  const provider = getProviderInstance(key)
  if (provider === undefined) {
    throw new ServiceError('NOT_FOUND', `agent provider ${key} has no runtime instance`)
  }

  const db = getDatabase()
  const now = nowSec()
  const health = await provider.probeHealth()
  const from = row.health
  const to = health.health
  db.prepare(
    'UPDATE agent_providers SET installed = ?, version = ?, exe_path = ?, health = ?, health_detail = ?, last_probe_at = ?, updated_at = ? WHERE id = ?',
  ).run(
    health.installed ? 1 : 0,
    dbVal(health.version ?? null),
    dbVal(health.exePath ?? null),
    to,
    dbVal(health.healthDetail ?? null),
    now,
    now,
    row.id,
  )
  registerProviderResource(row.id, row.display_name)
  let healthChanged = false
  if (from !== to) {
    healthChanged = true
    recordEvent({
      eventType: 'provider.health_changed',
      providerKey: key,
      payload: { providerId: key, from, to, ...(health.healthDetail !== undefined ? { detail: health.healthDetail } : {}) },
      summary: `${key}: ${from} -> ${to}`,
      fingerprint: `${key}:${from}:${to}:${now}`,
    })
  }
  // 能力重验（过期才验，与全局探测同一 240s 阈值；显式重探不做无谓开销）
  const caps = parseCapabilitySet(row.capabilities_json)
  const stale = caps.verifiedAt === 0 || now - caps.verifiedAt > CAPABILITY_REVERIFY_MIN_SEC
  if (stale) {
    const verified = await provider.getCapabilities({ providerId: key, nativeId: '-' })
    db.prepare('UPDATE agent_providers SET capabilities_json = ?, updated_at = ? WHERE id = ?').run(
      JSON.stringify(verified),
      nowSec(),
      row.id,
    )
  }
  // 该家会话快照强刷（force = 绕过会话节流；探测 → 落库 → 刷新为一次完整重探语义）
  await refreshProviderSessions(key, true)

  const fresh = readProviderRow(providerId)
  return { provider: providerView(fresh !== undefined ? fresh : row), healthChanged }
}

/** 供 smoke 断言节流态清理（进程内多次 makeTempHome 场景）。 */
export function resetAgentControlThrottles(): void {
  sessionsThrottle.clear()
  lastSeenTouches.clear()
}
