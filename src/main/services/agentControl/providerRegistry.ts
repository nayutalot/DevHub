/**
 * providerRegistry.ts — 五家 provider 目录常量 + Provider 层共享接口 + 运行期实例表
 * （docs/12 §9 catalog 模式 + §4 统一 Provider 接口）。
 *
 * AC2 边界（保留）：目录常量（provider 业务键 + 展示名）是 agent_providers 行的
 * 写入依据（L3 唯一写库层，约束 #20），事实源永远是真实文件系统/进程。
 *
 * AC3 扩展（docs/16 §1 AC3 行授权）：落地 docs/12 §4 的 AgentProvider 九方法接口
 * 与共享投影类型；运行期实例表（惰性创建）+ 注入式覆盖位（smoke 夹具化关键设计：
 * provider 构造参数注入源路径，L3 经 setProviderOverride 换成夹具 provider，
 * 真机路径零触碰）。
 * AC4 扩展（docs/16 §1 AC4 行）：kimi / zcode / deepseek 三家接入运行期实例表，
 * WIRED_PROVIDER_IDS 五家收口。
 *
 * electron-free：零 electron import，可被 smoke 在系统 Node 下直接加载。
 */

import type {
  AgentCapabilitySet,
  AgentHealth,
  AgentProviderId,
  SessionMode,
  SessionStatus,
} from '../../../shared/types.ts'

/** provider 目录条目（agent_providers.provider / display_name 的取值来源）。 */
export interface AgentProviderCatalogEntry {
  readonly id: AgentProviderId
  /** 展示名（docs/11 §4 命名：Codex / Claude Code / Kimi Code / ZCode / DeepSeek Harness）。 */
  readonly displayName: string
}

/**
 * 五家 provider 目录（docs/11 §4.1-§4.5 顺序）。目录→agent_providers 行的 ensure
 * 逻辑在 AC3 监控管线接线（agentControlService.ensureAgentProviderRows）。
 */
export const AGENT_PROVIDER_CATALOG: readonly AgentProviderCatalogEntry[] = [
  { id: 'codex', displayName: 'Codex' },
  { id: 'claude-code', displayName: 'Claude Code' },
  { id: 'kimi', displayName: 'Kimi Code' },
  { id: 'zcode', displayName: 'ZCode' },
  { id: 'deepseek', displayName: 'DeepSeek Harness' },
] as const

/** AC3 起接入的 provider（AC4 收口后五家全部 wired：kimi/zcode/deepseek 属 AC4，docs/16 §1 批次表）。 */
export const WIRED_PROVIDER_IDS: readonly AgentProviderId[] = [
  'codex',
  'claude-code',
  'kimi',
  'zcode',
  'deepseek',
] as const

/** provider 业务键全集（handler 侧白名单校验复用）。 */
export const AGENT_PROVIDER_IDS: readonly AgentProviderId[] = AGENT_PROVIDER_CATALOG.map((entry) => entry.id)

/** 运行期守卫：值是否为合法 provider 业务键。 */
export function isAgentProviderId(value: unknown): value is AgentProviderId {
  return typeof value === 'string' && (AGENT_PROVIDER_IDS as readonly string[]).includes(value)
}

// ---------------------------------------------------------------------------
// Provider 层共享类型（docs/12 §4 TS 草案逐字 + 会话/消息投影）
// ---------------------------------------------------------------------------

export interface SessionRef {
  providerId: AgentProviderId
  nativeId: string
}

/** probeHealth 探测结果（不写库，写库归 L3；docs/12 §4）。 */
export interface ProviderHealth {
  installed: boolean
  version?: string
  exePath?: string
  health: AgentHealth
  /** 结构化降级原因（约束 #26）。 */
  healthDetail?: string
}

/** listSessions 会话快照（upsert 语义；native_id 幂等，docs/12 §4）。 */
export interface SessionSnapshot {
  nativeId: string
  workdir?: string
  title?: string
  /** unix 秒。 */
  startedAt?: number
  /** unix 秒。 */
  lastActivityAt?: number
  /**
   * AC8（docs/16 §1 AC8 行：托管会话最小路径）：provider 已确知的会话模式。
   * 缺省 = 'observed'（扫描投影）；DevHub 亲自发起的托管线程（thread/start）
   * 由 provider 显式携带 'managed'，L3 upsert 以此落 managed 行。
   * 可选字段：既有五家 provider 构造的快照零改动。
   */
  mode?: SessionMode
}

/** 脱敏后消息投影（完整内容绝不落库；contentRedacted 经 redact.ts）。 */
export interface RedactedMessage {
  role: string
  contentRedacted: string
  nativeMsgId: string
  /** unix 秒。 */
  occurredAt?: number
  seqInSession?: number
  /** 源指针（文件路径+offset 等，指向 provider 原始数据而非本库副本）。 */
  sourceRef: string
}

export interface MessagePage {
  messages: RedactedMessage[]
  /** 增量游标（文件 offset 等；透传回 readMessages(ref, after)）。 */
  cursor: string
  hasMore: boolean
}

/** 控制命令执行结果（sendReply/pause/resume；能力门在 L3 二次校验）。 */
export interface CommandOutcome {
  ok: boolean
  status: 'executed' | 'unsupported' | 'failed'
  errorCode?: string
  detail?: string
}

/** session.waiting_input payload.status 两值（docs/12 §6；eventPipeline 校验复用）。 */
export type AgentEventTypeWaitStatus = 'waiting_input' | 'approval_required'

/**
 * 监控管线事件出口（docs/12 §7 sink 段）。L3 接线把每个观察翻译为
 * agent_sessions upsert + eventPipeline 落库；provider 只负责「判定」。
 */
export interface EventSink {
  /** 新会话发现（(provider, native_id) 首见）。 */
  onSessionDiscovered?(providerId: AgentProviderId, snapshot: SessionSnapshot): void
  /** 增量消息（已脱敏投影）。 */
  onMessageAppended?(ref: SessionRef, message: RedactedMessage): void
  /** 状态判定器输出（调用方保证 to ≠ from 才有意义；L3 侧二次比较后才发事件）。 */
  onStatusChanged?(ref: SessionRef, from: SessionStatus | undefined, to: SessionStatus, detail?: string): void
  /** 连续 5 次读失败降级（L3：受影响活跃会话置 connection_lost + health_changed）。 */
  onProviderDegraded?(providerId: AgentProviderId, detail: string): void
  /** 监控源恢复（L3：重探刷新真实状态）。 */
  onProviderRecovered?(providerId: AgentProviderId): void
}

export interface MonitorHandle {
  readonly providerId: AgentProviderId
  /** 停止监控、关闭管道、释放资源（cancel token + watcher/timer 收尾）。 */
  stop(): Promise<void>
}

/** agents:diagnostics 的 provider 侧数据源/控制通道形态（docs/14 §A.1 #13）。 */
export interface ProviderDiagnosticsInfo {
  dataSource: { kind: string; readable: boolean; detail?: string }
  control: { hooks?: boolean; appServer?: boolean; stdin?: boolean; note?: string }
}

/**
 * 统一 Provider 接口（docs/12 §4 九方法逐字）。describeDiagnostics 为本批新增的
 * 可选方法（docs/14 §A.1 #13 诊断投影数据源；九方法契约零改动，缺省方法不算
 * 扩大接口面——smoke 与 L3 均按可选调用）。
 */
export interface AgentProvider {
  readonly id: AgentProviderId
  /** 探测安装/版本/数据源可用性 → agent_providers 健康投影（不写库，写库归 L3）。 */
  probeHealth(): Promise<ProviderHealth>
  /** 全量会话快照（upsert 语义；native_id 幂等）。 */
  listSessions(): Promise<SessionSnapshot[]>
  /** 增量消息（游标 = 已见最大 seq_in_session / 文件 offset）。 */
  readMessages(ref: SessionRef, after?: string): Promise<MessagePage>
  /** 能力真实验证：只返回「此刻验证存在」的能力，绝不因「理论上支持」放行（docs/12 §5）。 */
  getCapabilities(ref: SessionRef): Promise<AgentCapabilitySet>
  /** 注入回复（仅 managed/attached 且 reply 已验证；实现内部走 stdin/hooks/app-server）。 */
  sendReply(ref: SessionRef, text: string): Promise<CommandOutcome>
  pause(ref: SessionRef): Promise<CommandOutcome>
  resume(ref: SessionRef): Promise<CommandOutcome>
  /** 注册监控管线（fs.watch / 快照轮询），返回句柄；并发可取消（docs/12 §7）。 */
  startMonitor(sink: EventSink): MonitorHandle
  /** 停止监控、关闭管道、释放资源（托盘退出/开关关闭时调用）。 */
  dispose(): Promise<void>
  /** 可选：诊断投影（agents:diagnostics 数据源/控制通道真实形态）。 */
  describeDiagnostics?(): ProviderDiagnosticsInfo
}

// ---------------------------------------------------------------------------
// 运行期实例表（惰性创建 + 注入式覆盖位）
// ---------------------------------------------------------------------------

import { createCodexProvider } from './providers/codexProvider.ts'
import { createClaudeProvider } from './providers/claudeProvider.ts'
import { createKimiProvider } from './providers/kimiProvider.ts'
import { createZcodeProvider } from './providers/zcodeProvider.ts'
import { createDeepseekProvider } from './providers/deepseekProvider.ts'

let instances: Partial<Record<AgentProviderId, AgentProvider>> | null = null
/** smoke / 夹具注入位：优先于默认实例（真机路径零触碰的夹具化关键设计）。 */
const overrides: Partial<Record<AgentProviderId, AgentProvider>> = {}

/** 注入夹具 provider（传 null 清除该 provider 的覆盖）。 */
export function setProviderOverride(providerId: AgentProviderId, provider: AgentProvider | null): void {
  if (provider === null) delete overrides[providerId]
  else overrides[providerId] = provider
}

/** 清空全部覆盖（smoke finally 收尾）。 */
export function clearProviderOverrides(): void {
  for (const key of Object.keys(overrides) as AgentProviderId[]) delete overrides[key]
}

/** 取 provider 实例（覆盖 > 默认惰性实例；五家全部 wired，docs/16 §1 AC4 行）。 */
export function getProviderInstance(providerId: AgentProviderId): AgentProvider | undefined {
  const override = overrides[providerId]
  if (override !== undefined) return override
  if (instances === null) {
    instances = {
      codex: createCodexProvider(),
      'claude-code': createClaudeProvider(),
      kimi: createKimiProvider(),
      zcode: createZcodeProvider(),
      deepseek: createDeepseekProvider(),
    }
  }
  return instances[providerId]
}

/** session_mode 三态（docs/12 §5；此处仅供 provider 层类型引用的场景导入）。 */
export type ProviderSessionMode = SessionMode

// Grok 预留位（docs/12 §11）：Grok CLI 1.0.5 本机存在但不在用户首批清单，本期
// 零实现、零注册。后续批次接入时：本目录追加一行 + providers/ 新增 grokProvider.ts
//（数据源 ~/.grok/bin/grok、~/.grok/config.toml、~/.grok/sessions/，实现批次复核），
// agent_providers.provider 为 TEXT UNIQUE，无需 migration 变更。
