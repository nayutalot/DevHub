/**
 * views/AgentsView.tsx — Agent Control 视图（第 10 视图，AC5 批次，docs/11 §5
 * D1–D14 / docs/14 §A Part A / docs/12 §10）。
 *
 * 布局：控制条（监控总开关 D10 + 自启开关 D11）→ Provider 卡区（D1/D2/D7：
 * 健康四值徽章 / 版本 / capabilities{mode,granted[],verifiedAt,evidence} /
 * enabled）→ 会话列表（D3：9 值状态徽章，waiting_input 与 approval_required
 * 高亮区分，connection_lost/stale 显式标注，provider/status 过滤，project 关联）
 * → 会话详情（D4/D6：capabilities + counts + 消息脱敏分页 after 游标 + 该会话
 * 事件）→ 最近事件流（D5：after=sequence 游标轮询，deliveryState 徽标）→
 * 设备列表 + 撤销（D13：两段式 confirmRequired→impacts→confirmed，绝无 token
 * 字段）→ Gateway 状态 + 重启（D9：两段式）+ 手机配对（D8：8 位码 + TTL 倒计时
 * +「码仅此一次显示」；GATEWAY_DISABLED 结构化引导）→ 诊断面板（D12：
 * agents:diagnostics 全字段）。
 *
 * 数据纪律：全部真实 IPC（零 mock，约束 #23）；docs/14 §A.3 轮询模式 2s（无广播
 * channel）；每个面板四态强制（D14，约束 #24）+ 结构化降级文案（约束 #26）；
 * React 19 StrictMode 双挂载防抖走 promise 模式（R6：effect cleanup + 游标幂等，
 * 模块级禁 boolean 标记，HANDOFF §6）。
 *
 * D3-F1（AUDIT D-Aud F1，行为不变纪律）：devices / diagnostics 慢变面降频 10s
 * （AGENTS_SLOW_POLL_MS；新鲜度面 providers/sessions/events/detail/messages 保持
 * 2s）；会话/消息/事件/设备行组件 memo 化——IPC 每轮新引用故按展示值比较，配
 * 30s 时效桶（timeBucket30s）保 relativeTime 文案时效；Names Map 以解析字符串
 * 下传防 memo 击穿。
 */

import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Badge, stateTone } from '../components/Badge.tsx'
import type { BadgeTone } from '../components/Badge.tsx'
import { ExpandableText } from '../components/ExpandableText.tsx'
import {EmptyState, ErrorState, InlineState, Loading, Spinner,} from '../components/StateViews.tsx'
import { useToast } from '../components/ToastProvider.tsx'
import { relativeTime, toMs } from '../lib/format.ts'
import { call } from '../lib/ipc.ts'
import { useAsync } from '../lib/useAsync.ts'
import { AGENTS_POLL_MS, AGENTS_SLOW_POLL_MS, usePolling } from '../lib/usePolling.ts'
import type { AsyncError } from '../lib/useAsync.ts'
import type {
  AgentCapabilitySet,
  AgentDiagnosticsResult,
  AgentDeviceView,
  AgentEventView,
  AgentHealth,
  AgentMessageView,
  AgentProviderView,
  AgentSessionView,
  GatewayStatusView,
  RelayStatusView,
  SessionMode,
  SessionStatus,
} from '../../../shared/types.ts'

/** 9 值状态全集（docs/12 §4；会话过滤下拉与徽章着色共用）。 */
const SESSION_STATUSES: readonly SessionStatus[] = [
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

/** 状态徽章着色（D3：waiting_input 黄 / approval_required 蓝高亮区分；9 值无缺口）。 */
function sessionStatusTone(status: SessionStatus): BadgeTone {
  switch (status) {
    case 'running':
    case 'completed':
      return 'ok'
    case 'failed':
    case 'connection_lost':
      return 'err'
    case 'waiting_input':
      return 'warn'
    case 'approval_required':
      return 'accent'
    case 'paused':
      return 'wsl'
    case 'stopped':
    case 'unknown':
      return 'dim'
  }
}

/* D2（AUDIT A1）：状态/健康/模式/投递值的用户面中文投影（契约原值保留在数据与过滤器，仅展示层投影）。 */
const SESSION_STATUS_LABEL: Record<SessionStatus, string> = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  waiting_input: '等待输入',
  approval_required: '待批准',
  paused: '已暂停',
  connection_lost: '连接丢失',
  stopped: '已停止',
  unknown: '未知',
}

const HEALTH_LABEL: Record<AgentHealth, string> = {
  ok: '正常',
  degraded: '降级',
  unavailable: '不可用',
  unknown: '未知',
}

const MODE_LABEL: Record<SessionMode, string> = {
  managed: '托管',
  attached: '附加',
  observed: '观察',
}

const DELIVERY_LABEL: Record<AgentEventView['deliveryState'], string> = {
  acked: '已签收',
  delivered: '已投递',
  pending: '待投递',
}

/** 状态语义提示（D3 显式标注：等文本输入 vs 等工具批准 vs 监控源失联）。 */
function sessionStatusHint(status: SessionStatus): string {
  switch (status) {
    case 'waiting_input':
      return '等待用户文本输入（等待输入高亮，docs/11 D3）'
    case 'approval_required':
      return '等待工具执行批准（与 waiting_input 独立判定，docs/12 §5）'
    case 'connection_lost':
      return '监控源失联（非终态，恢复后重探刷新，docs/12 §7）'
    case 'stopped':
      return '有终态记录的正常停止（区别于 connection_lost）'
    case 'unknown':
      return '判定未定（绝不猜实时态，skills 先例）'
    default:
      return status
  }
}

function healthTone(health: AgentHealth): BadgeTone {
  switch (health) {
    case 'ok':
      return 'ok'
    case 'degraded':
      return 'warn'
    case 'unavailable':
      return 'err'
    case 'unknown':
      return 'dim'
  }
}

function modeTone(mode: SessionMode): BadgeTone {
  switch (mode) {
    case 'managed':
      return 'ok'
    case 'attached':
      return 'wsl'
    case 'observed':
      return 'dim'
  }
}

function capabilityTone(cap: AgentCapabilitySet): BadgeTone {
  if (cap.granted.length > 0) return 'ok'
  return 'dim'
}

function deliveryTone(state: AgentEventView['deliveryState']): BadgeTone {
  switch (state) {
    case 'acked':
      return 'ok'
    case 'delivered':
      return 'accent'
    case 'pending':
      return 'warn'
  }
}

/** 会话/详情/事件流共用的游标流 hook：after 游标自动增量 + 按 id 去重（R6 幂等）。
 *  loadMore = 手动追加路径（保留既有列表 + 游标推进，append 分支生效，防重入）；
 *  refresh = 世代重置语义不变（tick 重跑 effect → 游标与列表清零重拉第一页）
 *  （AUDIT D-Aud I2：原 loadMore 与 refresh 同为 setTick，实为重载第一页）。 */
interface CursorPage<T> {
  list: T[]
  nextAfter?: number
}

function useCursorStream<T extends { id: number }>(
  fetchPage: (after: number | undefined) => Promise<CursorPage<T>>,
  deps: readonly unknown[],
  options: { cap?: number; pollMs?: number } = {},
): { list: T[]; loading: boolean; error: AsyncError | null; loadMore: () => void; hasMore: boolean; refresh: () => void } {
  const cap = options.cap ?? 300
  const pollMs = options.pollMs ?? AGENTS_POLL_MS
  const [list, setList] = useState<T[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<AsyncError | null>(null)
  const [tick, setTick] = useState(0)
  const [lastPageFull, setLastPageFull] = useState(false)
  const seqRef = useRef(0)
  const cursorRef = useRef<number | undefined>(undefined)
  const fetchRef = useRef(fetchPage)
  fetchRef.current = fetchPage
  /** loadMore 防重入：手动追加请求在途时再点直接忽略。 */
  const appendingRef = useRef(false)
  /** 当前活跃世代注册的 loadMore 触发器（cleanup 置 null 防跨世代误触）。 */
  const appendRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    let cancelled = false
    const id = ++seqRef.current
    cursorRef.current = undefined
    setList([])
    setLoading(true)
    setLastPageFull(false)
    appendingRef.current = false
    let timer: number | undefined

    const once = async (manual: boolean): Promise<void> => {
      try {
        const page = await fetchRef.current(cursorRef.current)
        if (cancelled || seqRef.current !== id) return
        cursorRef.current = page.nextAfter ?? cursorRef.current
        setList((prev) => {
          const seen = new Set(prev.map((x) => x.id))
          const merged = manual ? [...prev, ...page.list] : [...prev, ...page.list.filter((x) => !seen.has(x.id))]
          const deduped = [...new Map(merged.map((x) => [x.id, x])).values()]
          return deduped.length > cap ? deduped.slice(deduped.length - cap) : deduped
        })
        setLastPageFull(page.nextAfter !== undefined)
        setError(null)
        setLoading(false)
      } catch (err) {
        if (cancelled || seqRef.current !== id) return
        setError(err instanceof Error && 'code' in err ? { code: String((err as { code: unknown }).code), message: err.message } : { code: 'INTERNAL', message: err instanceof Error ? err.message : String(err) })
        setLoading(false)
      } finally {
        if (manual) appendingRef.current = false
        if (!cancelled && seqRef.current === id && !manual) {
          timer = window.setTimeout(() => void once(false), pollMs)
        }
      }
    }

    appendRef.current = () => {
      if (appendingRef.current) return
      appendingRef.current = true
      void once(true)
    }
    void once(false)
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
      seqRef.current += 1
      appendRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps 由调用方显式给定
  }, [...deps, tick, pollMs])

  const loadMore = () => appendRef.current?.()
  const refresh = () => setTick((t) => t + 1)
  return { list, loading, error, loadMore, hasMore: lastPageFull, refresh }
}

/** IpcError → AsyncError（与 useAsync 同形状；供手写 catch 分支使用）。 */
function toAsyncErrorLocal(err: unknown): AsyncError {
  const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : undefined
  if (code !== undefined && err instanceof Error) return { code, message: err.message }
  return { code: 'INTERNAL', message: err instanceof Error ? err.message : String(err) }
}

// ---------------------------------------------------------------------------
// D3-F1：长列表行组件 memo 化（AUDIT D-Aud F1——100→200 行 × 2s 轮询新数组
// 全表 reconciliation；运行时帧率本就流畅，成本在渲染面 CPU 空转）
// ---------------------------------------------------------------------------

/**
 * relativeTime 时效桶（30s 粒度）：行 memo 的值比较含 timeBucket——数据未变的行
 * 在父组件（2s 轮询重渲染）到达新桶时才刷新一次 relativeTime 文案（最大滞后
 * ~30s；relativeTime 本身分钟级粒度、该文案语义本就容忍分钟级滞后），其余
 * 轮询 tick 整行跳过 reconciliation。
 */
function timeBucket30s(): number {
  return Math.floor(Date.now() / 30_000)
}

// ---------------------------------------------------------------------------
// 面板 0：控制条（D10 监控总开关 + D11 自启开关）
// ---------------------------------------------------------------------------

function ControlBar({ monitorEnabled, autostartEnabled, onChanged }: {
  monitorEnabled: boolean | undefined
  autostartEnabled: boolean | undefined
  onChanged: () => void
}) {
  const { show } = useToast()
  const [busy, setBusy] = useState<string | null>(null)

  async function toggle(kind: 'monitor' | 'autostart', next: boolean): Promise<void> {
    setBusy(kind)
    try {
      if (kind === 'monitor') {
        await call('settings:set', { key: 'agents_monitor_enabled', value: next ? '1' : '0' })
        show(`agents_monitor_enabled = ${next ? '1' : '0'}（监控任务同步已触发）`)
      } else {
        await call('agents:setAutoStart', { enabled: next })
        show(`login_autostart = ${next ? '1' : '0'}（setLoginItemSettings 已即时应用）`)
      }
      onChanged()
    } catch (err) {
      show(toAsyncErrorLocal(err).message, 'err')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="panel agents-control-bar">
      <label className="agents-switch">
        <input
          type="checkbox"
          checked={monitorEnabled === true}
          disabled={monitorEnabled === undefined || busy !== null}
          onChange={(e) => void toggle('monitor', e.target.checked)}
        />
        Agent 监控总开关 <span className="td-dim mono">agents_monitor_enabled</span>
        {busy === 'monitor' && <Spinner />}
      </label>
      <label className="agents-switch">
        <input
          type="checkbox"
          checked={autostartEnabled === true}
          disabled={autostartEnabled === undefined || busy !== null}
          onChange={(e) => void toggle('autostart', e.target.checked)}
        />
        开机自启 <span className="td-dim mono">login_autostart</span>
        {busy === 'autostart' && <Spinner />}
      </label>
      <span className="td-dim">托盘常驻：关窗 = 隐藏窗口，监控持续；退出请走托盘菜单「退出 DevHub」</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 面板 1：Provider 卡区（D1/D2/D7）
// ---------------------------------------------------------------------------

function CapabilityBlock({ caps }: { caps: AgentCapabilitySet }) {
  return (
    <div className="agents-caps">
      <Badge tone={modeTone(caps.mode)} title={`接入深度三态（docs/12 §5）：${caps.mode}`}>{MODE_LABEL[caps.mode]}</Badge>
      {caps.granted.length > 0 ? (
        caps.granted.map((g) => (
          <Badge key={g} tone="ok" title="此刻真实验证存在的能力（能力验证门，docs/12 §5）">
            {g}
          </Badge>
        ))
      ) : (
        <Badge tone="dim" title="无已验证控制能力（observed 或验证失败，服务端能力门拒绝）">
          无已验证能力
        </Badge>
      )}
      <Badge tone={capabilityTone(caps)} title={caps.evidence || 'no evidence'}>
        {caps.verifiedAt > 0 ? `验证于 ${relativeTime(caps.verifiedAt)}` : '从未验证'}
      </Badge>
    </div>
  )
}

/** 轮询四态解析（面板共用）：首载 loading → 无数据 error → 有数据时错误降级为横幅。 */
function resolvePanelState<T>(data: T | null, loading: boolean, error: AsyncError | null): {
  phase: 'loading' | 'error' | 'empty' | 'data'
  data: T | null
} {
  if (data === null && loading) return { phase: 'loading', data: null }
  if (data === null && error !== null) return { phase: 'error', data: null }
  if (data === null) return { phase: 'empty', data: null }
  return { phase: 'data', data }
}

function ProvidersPanel({ providers, monitorEnabled, loading, error, onRefresh }: {
  providers: AgentProviderView[] | null
  monitorEnabled: boolean | undefined
  loading: boolean
  error: AsyncError | null
  onRefresh: () => void
}) {
  const state = resolvePanelState(providers, loading, error)
  // 夜间#1 批次：per-provider 单独重探（agents:probeProvider）。四态：idle →
  // probing（按钮内 spinner）→ ok/err（toast 结构化），错误含 {code,message}。
  const { show } = useToast()
  const [probingId, setProbingId] = useState<number | null>(null)

  async function reprobe(providerId: number, displayName: string): Promise<void> {
    setProbingId(providerId)
    try {
      const r = await call('agents:probeProvider', { providerId })
      show(
        `${displayName}：重新探测完成—健康 ${HEALTH_LABEL[r.provider.health]}${r.healthChanged ? '（有变化，已记录事件）' : '（无变化）'}`,
      )
      onRefresh()
    } catch (err) {
      const code = (err as { code?: string } | null)?.code
      show(`${displayName}：重新探测失败${code !== undefined ? ` [${code}]` : ''} — ${err instanceof Error ? err.message : String(err)}`, 'err')
    } finally {
      setProbingId(null)
    }
  }

  if (state.phase === 'loading') return <Loading label="正在探测 Agent provider（真实文件系统 / 进程检测）…" />
  if (state.phase === 'error') return <ErrorState error={error as AsyncError} onRetry={onRefresh} />
  if (state.phase === 'empty') {
    return (
      <EmptyState
        title="尚未注册 Agent provider"
        hint="agent_providers 目录为空——正常情况不会出现（catalog 五家 ensure）；重试或检查数据库。"
      />
    )
  }
  const list = (state.data as AgentProviderView[]) ?? []
  return (
    <>
      <div className="agents-poll-line">
        <span className="td-dim">
          {monitorEnabled === true
            ? '监控已开启—探测由服务端节流（60s）；会话经监控管线流入'
            : '监控已关闭—零探测，仅展示缓存投影（docs/14 §A.1 #1）'}
        </span>
        <button type="button" className="btn btn-small" onClick={onRefresh}>
          刷新探测
        </button>
      </div>
      {error !== null && <div className="degraded-banner">providers 轮询异常（显示为最后成功快照）: {error.code} — {error.message}</div>}
      <div className="agents-grid">
        {list.map((p) => (
          <div key={p.id} className="panel agents-card">
            <div className="agents-card-head">
              <span className="agents-card-name">{p.displayName}</span>
              <Badge tone={p.installed ? 'ok' : 'err'}>{p.installed ? '已安装' : '未安装'}</Badge>
              <Badge tone={healthTone(p.health)} title={p.healthDetail ?? p.health}>{HEALTH_LABEL[p.health]}</Badge>
              <button
                type="button"
                className="btn btn-small"
                disabled={probingId !== null}
                title={`立即重新探测 ${p.displayName}（绕过 60s 节流；同时刷新该 provider 的会话）`}
                onClick={() => {
                  void reprobe(p.id, p.displayName)
                }}
              >
                {probingId === p.id ? <Spinner /> : null}
                重新探测
              </button>
            </div>
            <div className="agents-card-line mono" title={p.exePath ?? ''}>
              {p.version !== undefined ? `v${p.version}` : '版本未知'}
              {p.exePath !== undefined ? ` · ${p.exePath}` : ''}
            </div>
            {p.healthDetail !== undefined && (
              <div className="degraded-banner">
                {/* AUDIT D-Aud A3：内部探测日志默认折叠（ExpandableText），不整块铺用户面 */}
                <ExpandableText text={p.healthDetail} collapsedLines={2} />
              </div>
            )}
            <CapabilityBlock caps={p.capabilities} />
            <div className="agents-card-line">
              <Badge tone={p.enabled ? 'ok' : 'dim'} title="agent_providers.enabled（每 provider 监控开关，docs/11 D10）">
                {p.enabled ? '已启用' : '已停用'}
              </Badge>
              <span className="td-dim">上次探测：{p.lastProbeAt !== null ? relativeTime(p.lastProbeAt) : '—'}</span>
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// 面板 2：会话列表（D3）
// ---------------------------------------------------------------------------

/** 会话表行（D3）：memo 化。IPC 每轮轮询产生全新对象/数组引用，引用比较无效，
 *  比较器按「实际展示值」逐字段比较（含 timeBucket 时效桶）。providerName/
 *  projectName 以解析好的字符串下传——Names Map 引用每轮都在变，直接下传会击穿 memo。 */
interface SessionRowProps {
  s: AgentSessionView
  providerName: string
  projectName: string
  selected: boolean
  timeBucket: number
  onSelect: (id: number) => void
}

const SessionRow = memo(
  function SessionRow({ s, providerName, projectName, selected, onSelect }: SessionRowProps) {
    return (
      <tr
        className={`row-hit${selected ? ' agents-row-selected' : ''}`}
        role="button"
        tabIndex={0}
        aria-label={`会话 #${s.id} ${s.title ?? ''}`.trim()}
        onClick={() => onSelect(s.id)}
        onKeyDown={(e) => {
          // D4-M5（AUDIT D-Aud I6）：键盘可达——Enter/Space 触发（对齐 OverlayApp 正确做法）
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onSelect(s.id)
          }
        }}
      >
        <td className="td-dim">{s.id}</td>
        <td>{providerName}</td>
        <td className="td-mono td-dim" title={s.nativeId}>{s.nativeId.length > 24 ? `${s.nativeId.slice(0, 24)}…` : s.nativeId}</td>
        <td className="td-dim" title={s.title ?? ''}>{s.title ?? '—'}</td>
        <td className="td-dim">{s.projectId !== undefined ? `#${s.projectId} ${projectName}`.trim() : '—'}</td>
        <td>
          <Badge tone={sessionStatusTone(s.status)} title={sessionStatusHint(s.status)}>{SESSION_STATUS_LABEL[s.status]}</Badge>
          {s.stale && (
            <Badge tone="dim" title="数据源过期标注——绝不猜实时态（docs/14 §A.1 #2）">
              过期
            </Badge>
          )}
        </td>
        <td>
          <Badge tone={modeTone(s.sessionMode)} title="接入深度（managed/attached/observed，docs/12 §5）">
            {MODE_LABEL[s.sessionMode]}
          </Badge>
        </td>
        <td className="td-dim">{s.lastActivityAt !== undefined ? relativeTime(s.lastActivityAt) : '—'}</td>
      </tr>
    )
  },
  (a, b) =>
    a.s.id === b.s.id &&
    a.s.providerId === b.s.providerId &&
    a.s.nativeId === b.s.nativeId &&
    a.s.title === b.s.title &&
    a.s.projectId === b.s.projectId &&
    a.s.status === b.s.status &&
    a.s.stale === b.s.stale &&
    a.s.sessionMode === b.s.sessionMode &&
    a.s.lastActivityAt === b.s.lastActivityAt &&
    a.providerName === b.providerName &&
    a.projectName === b.projectName &&
    a.selected === b.selected &&
    a.timeBucket === b.timeBucket &&
    a.onSelect === b.onSelect,
)

function SessionsPanel({ sessions, loading, error, onRetry, providerNames, projectNames, selectedId, onSelect, providerFilter, onProviderFilter, statusFilter, onStatusFilter, limit, onLoadMore }: {
  sessions: AgentSessionView[] | null
  loading: boolean
  error: AsyncError | null
  onRetry: () => void
  providerNames: Map<number, string>
  projectNames: Map<number, string>
  selectedId: number | null
  onSelect: (id: number) => void
  /** AC6 遗留小修：过滤状态提升至视图层——真实传给 agents:sessions 服务端（docs/14 §A.1 #2）。 */
  providerFilter: string
  onProviderFilter: (value: string) => void
  statusFilter: string
  onStatusFilter: (value: string) => void
  /** 服务端 limit（Load more = limit 提升，100 → 200 封顶，docs/14 §A.1 #2）。 */
  limit: number
  onLoadMore: () => void
}) {
  const state = resolvePanelState(sessions, loading, error)

  if (state.phase === 'loading') return <Loading label="正在加载 Agent 会话…" />
  if (state.phase === 'error') return <ErrorState error={error as AsyncError} onRetry={onRetry} />
  if (state.phase === 'empty') {
    return (
      <EmptyState
        title="尚未观察到 Agent 会话"
        hint="监控管线发现会话后落库展示（Codex rollout / Claude 转录 / Kimi sessionIndex / ZCode 快照）；当前无任何会话记录。"
      />
    )
  }
  const list = (state.data as AgentSessionView[]) ?? []
  // D3-F1：relativeTime 时效桶（30s）——本组件每 2s 随轮询重渲染，桶值下传行 memo。
  const timeBucket = timeBucket30s()
  return (
    <>
      <div className="toolbar">
        <select className="input" value={providerFilter} onChange={(e) => onProviderFilter(e.target.value)} aria-label="按 provider 筛选">
          <option value="">全部 Provider</option>
          {[...providerNames.entries()].map(([id, name]) => (
            <option key={id} value={String(id)}>{name}</option>
          ))}
        </select>
        <select className="input" value={statusFilter} onChange={(e) => onStatusFilter(e.target.value)} aria-label="按状态筛选">
          <option value="">全部状态（9 值）</option>
          {SESSION_STATUSES.map((s) => (
            <option key={s} value={s}>{SESSION_STATUS_LABEL[s]}</option>
          ))}
        </select>
        <span className="td-dim">{list.length} 个会话（服务端过滤，limit {limit}，最新在前）</span>
        {list.length >= limit && limit < 200 && (
          <button type="button" className="btn btn-small" onClick={onLoadMore}>
            加载更多（limit {limit} → {Math.min(200, limit + 100)}）
          </button>
        )}
      </div>
      {error !== null && <div className="degraded-banner">sessions 轮询异常（显示为最后成功快照）: {error.code} — {error.message}</div>}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>Provider</th>
              <th>原生 ID</th>
              <th>标题</th>
              <th>项目</th>
              <th>状态</th>
              <th>模式</th>
              <th>最近活动</th>
            </tr>
          </thead>
          <tbody>
            {list
              .map((s) => (
                <SessionRow
                  key={s.id}
                  s={s}
                  providerName={providerNames.get(s.providerId) ?? `#${s.providerId}`}
                  projectName={s.projectId !== undefined ? (projectNames.get(s.projectId) ?? '') : ''}
                  selected={selectedId === s.id}
                  timeBucket={timeBucket}
                  onSelect={onSelect}
                />
              ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// 面板 3：会话详情（D4/D6）+ 消息脱敏分页 + 会话事件
// ---------------------------------------------------------------------------

/** 消息表行：memo 化（值比较 + 30s 时效桶；消息 100 行/页，detail 每 2s 重渲染）。 */
interface MessageRowProps {
  m: AgentMessageView
  timeBucket: number
}

const MessageRow = memo(
  function MessageRow({ m }: MessageRowProps) {
    return (
      <tr>
        <td className="td-dim">{m.id}</td>
        <td>
          <Badge tone={m.role === 'user' ? 'accent' : m.role === 'assistant' ? 'ok' : 'dim'}>{m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : m.role}</Badge>
        </td>
        <td className="td-mono agents-msg-cell" title={m.contentRedacted}>{m.contentRedacted}</td>
        <td className="td-dim">{m.occurredAt !== undefined ? relativeTime(m.occurredAt) : '—'}</td>
      </tr>
    )
  },
  (a, b) => a.m.id === b.m.id && a.m.role === b.m.role && a.m.contentRedacted === b.m.contentRedacted && a.m.occurredAt === b.m.occurredAt && a.timeBucket === b.timeBucket,
)

function SessionDetailPanel({ sessionId, providerNames, projectNames }: {
  sessionId: number
  providerNames: Map<number, string>
  projectNames: Map<number, string>
}) {
  const detail = usePolling(
    () => call('agents:sessionDetail', { sessionId }),
    [sessionId],
    AGENTS_POLL_MS,
  )
  const messages = useCursorStream<AgentMessageView>(
    async (after) => {
      const page = await call('agents:messages', { sessionId, ...(after !== undefined ? { after } : {}), limit: 100 })
      return { list: page.items, nextAfter: page.nextAfter }
    },
    [sessionId],
  )
  const events = useCursorStream<AgentEventView>(
    async (after) => {
      const page = await call('agents:events', { sessionId, ...(after !== undefined ? { after } : {}), limit: 100 })
      return { list: page.events, nextAfter: page.nextAfter }
    },
    [sessionId],
  )

  const state = resolvePanelState(detail.data, detail.loading, detail.error)
  if (state.phase === 'loading') return <Loading label="正在加载会话详情…" />
  if (state.phase === 'error') return <ErrorState error={detail.error as AsyncError} onRetry={detail.refresh} />
  if (state.phase !== 'data') return null
  const data = state.data as {
    session: AgentSessionView
    capabilities: AgentCapabilitySet
    counts: { messages: number; events: number }
  }
  const { session, capabilities, counts } = data
  // D3-F1：时效桶下传 memo 行（detail 每 2s 重渲染面：meta 徽章 + 消息表 + 事件表）。
  const timeBucket = timeBucket30s()

  return (
    <div className="agents-detail">
      {detail.error !== null && <div className="degraded-banner">detail 轮询异常（显示为最后成功快照）: {detail.error.code} — {detail.error.message}</div>}
      <div className="agents-detail-meta">
        <span className="agents-card-name">{providerNames.get(session.providerId) ?? `#${session.providerId}`}</span>
        <Badge tone={sessionStatusTone(session.status)} title={sessionStatusHint(session.status)}>{SESSION_STATUS_LABEL[session.status]}</Badge>
        <Badge tone={modeTone(session.sessionMode)}>{MODE_LABEL[session.sessionMode]}</Badge>
        {session.stale && <Badge tone="dim" title="数据源过期标注（绝不猜实时态）">过期</Badge>}
        <span className="td-dim mono" title={session.nativeId}>native: {session.nativeId}</span>
        {session.projectId !== undefined && <span className="td-dim">项目 #{session.projectId} {projectNames.get(session.projectId) ?? ''}</span>}
        <span className="td-dim">开始：{session.startedAt !== undefined ? relativeTime(session.startedAt) : '—'}</span>
        <span className="td-dim">最近：{session.lastActivityAt !== undefined ? relativeTime(session.lastActivityAt) : '—'}</span>
        {session.endedAt !== undefined && <span className="td-dim">结束：{relativeTime(session.endedAt)}</span>}
        {session.statusDetail !== undefined && <span className="td-dim">· {session.statusDetail}</span>}
      </div>
      <div className="agents-detail-meta">
        <CapabilityBlock caps={capabilities} />
        <span className="td-dim mono">计数：{counts.messages} 条消息 · {counts.events} 条事件</span>
      </div>

      <h4 className="panel-title">消息（脱敏投影 — after 游标分页）</h4>
      <InlineState
        loading={messages.loading}
        error={messages.error}
        onRetry={messages.refresh}
        empty={messages.list.length === 0}
        loadingLabel="正在加载消息…"
      />
      {messages.list.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>角色</th>
                <th>内容（脱敏）</th>
                <th>时间</th>
              </tr>
            </thead>
            <tbody>
              {messages.list.map((m) => (
                <MessageRow key={m.id} m={m} timeBucket={timeBucket} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {messages.hasMore && (
        <button type="button" className="btn btn-small" onClick={messages.loadMore}>
          加载更多消息（after 游标 {messages.list.length > 0 ? messages.list[messages.list.length - 1].id : '—'}）
        </button>
      )}

      <h4 className="panel-title">会话事件（after=sequence 游标）</h4>
      <InlineState
        loading={events.loading}
        error={events.error}
        onRetry={events.refresh}
        empty={events.list.length === 0}
        loadingLabel="正在加载会话事件…"
      />
      {events.list.length > 0 && <EventRows events={[...events.list].reverse()} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 面板 4：最近事件流（D5，全局 after=sequence 游标轮询）
// ---------------------------------------------------------------------------

/** 事件表行：memo 化（全局事件流 cap 200 + 会话事件流，每 2s 重渲染面）。
 *  payload 按引用比较：summary 在位时 payload 不参与渲染（跳过安全）；
 *  summary 缺失时回退渲染 JSON.stringify(payload)，引用不同即保守重渲染。 */
interface EventRowProps {
  e: AgentEventView
}

const EventRow = memo(
  function EventRow({ e }: EventRowProps) {
    return (
      <tr>
        <td className="td-dim">{e.id}</td>
        <td className="td-dim">{new Date(toMs(e.createdAt)).toLocaleTimeString()}</td>
        <td>
          <Badge tone={e.eventType === 'session.waiting_input' ? 'warn' : e.eventType === 'command.result' ? 'accent' : 'dim'} title={e.eventId}>
            {e.eventType}
          </Badge>
        </td>
        <td className="td-dim mono">
          {e.providerId !== undefined ? `p#${e.providerId}` : ''} {e.sessionId !== undefined ? `s#${e.sessionId}` : ''}
        </td>
        <td className="td-mono td-dim agents-msg-cell" title={e.summary ?? JSON.stringify(e.payload)}>
          {e.summary ?? JSON.stringify(e.payload)}
        </td>
        <td>
          <Badge tone={deliveryTone(e.deliveryState)} title="投递状态机只前进不回退（docs/12 §6）">
            {DELIVERY_LABEL[e.deliveryState]}
          </Badge>
        </td>
      </tr>
    )
  },
  (a, b) =>
    a.e.id === b.e.id &&
    a.e.createdAt === b.e.createdAt &&
    a.e.eventType === b.e.eventType &&
    a.e.providerId === b.e.providerId &&
    a.e.sessionId === b.e.sessionId &&
    a.e.summary === b.e.summary &&
    a.e.deliveryState === b.e.deliveryState &&
    a.e.payload === b.e.payload,
)

function EventRows({ events }: { events: AgentEventView[] }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>序号</th>
            <th>时间</th>
            <th>类型</th>
            <th>引用</th>
            <th>摘要（脱敏）</th>
            <th>投递</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <EventRow key={e.id} e={e} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 面板 5：设备列表 + 撤销（D13，两段式）
// ---------------------------------------------------------------------------

/** 设备表行：memo 化（值比较 + 30s 时效桶）。revoke 闭包每轮新建、故意不参与
 *  比较——busyId 入比较（撤销态变化必重渲染换新闭包），disabled 语义同原实现
 *  （任一撤销在途即全表按钮禁用）。 */
interface DeviceRowProps {
  d: AgentDeviceView
  busyId: number | null
  timeBucket: number
  revoke: (d: AgentDeviceView) => void
}

const DeviceRow = memo(
  function DeviceRow({ d, busyId, revoke }: DeviceRowProps) {
    return (
      <tr>
        <td className="td-dim">{d.id}</td>
        <td className="td-mono">{d.deviceName}</td>
        <td>{d.platform}</td>
        <td>
          <Badge tone={stateTone(d.status === 'active' ? 'running' : 'dim')}>{d.status === 'active' ? '生效中' : '已撤销'}</Badge>
        </td>
        <td className="td-dim">{relativeTime(d.pairedAt)}</td>
        <td className="td-dim">{d.lastSeenAt !== undefined ? relativeTime(d.lastSeenAt) : '—'}</td>
        <td className="td-dim">{d.tokenVersion}</td>
        <td>
          <button type="button" className="btn btn-small btn-danger" disabled={busyId !== null} onClick={() => revoke(d)}>
            {busyId === d.id && <Spinner />} 撤销
          </button>
        </td>
      </tr>
    )
  },
  (a, b) =>
    a.d.id === b.d.id &&
    a.d.deviceName === b.d.deviceName &&
    a.d.platform === b.d.platform &&
    a.d.status === b.d.status &&
    a.d.pairedAt === b.d.pairedAt &&
    a.d.lastSeenAt === b.d.lastSeenAt &&
    a.d.tokenVersion === b.d.tokenVersion &&
    a.busyId === b.busyId &&
    a.timeBucket === b.timeBucket,
)

function DevicesPanel({ devices, loading, error, onRetry, onChanged }: {
  devices: AgentDeviceView[] | null
  loading: boolean
  error: AsyncError | null
  onRetry: () => void
  onChanged: () => void
}) {
  const { show } = useToast()
  const [busyId, setBusyId] = useState<number | null>(null)

  async function revoke(device: AgentDeviceView): Promise<void> {
    setBusyId(device.id)
    try {
      const first = await call('agents:deviceRevoke', { deviceId: device.id })
      if (first.confirmRequired === true) {
        // 两段式（docs/14 §A.1 #9）：impacts 全部展示后才 confirmed
        const lines = [
          `撤销设备「${first.impacts.deviceName}」（#${first.impacts.deviceId}）？`,
          `last seen: ${first.impacts.lastSeenAt !== undefined ? relativeTime(first.impacts.lastSeenAt) : '—'}`,
          first.impacts.note,
        ]
        if (window.confirm(lines.join('\n'))) {
          const done = await call('agents:deviceRevoke', { deviceId: device.id, confirmed: true })
          if (done.confirmRequired === true) return
          show(`设备 #${device.id} 已撤销（token 即拒 + 审计落库）`)
          onChanged()
        }
      } else {
        show(`设备 #${device.id} 已撤销`)
        onChanged()
      }
    } catch (err) {
      show(toAsyncErrorLocal(err).message, 'err')
    } finally {
      setBusyId(null)
    }
  }

  const state = resolvePanelState(devices, loading, error)
  if (state.phase === 'loading') return <Loading label="正在加载已配对设备…" />
  if (state.phase === 'error') return <ErrorState error={error as AsyncError} onRetry={onRetry} />
  if (state.phase === 'empty') {
    return (
      <EmptyState
        title="暂无已配对设备"
        hint="Gateway 启用后经「配对新设备」签发一次性码；设备 Token 哈希永不投影到本列表（docs/14 §A.1 #8）。"
      />
    )
  }
  const list = (state.data as AgentDeviceView[]) ?? []
  const timeBucket = timeBucket30s()
  return (
    <div>
      {error !== null && <div className="degraded-banner">devices 轮询异常（显示为最后成功快照）: {error.code} — {error.message}</div>}
      <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>#</th>
            <th>名称</th>
            <th>平台</th>
            <th>状态</th>
            <th>配对时间</th>
            <th>最近在线</th>
            <th>Token 版本</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {list.map((d) => (
            <DeviceRow key={d.id} d={d} busyId={busyId} timeBucket={timeBucket} revoke={(row) => void revoke(row)} />
          ))}
        </tbody>
      </table>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 面板 6：Gateway 状态 + 重启（D9）+ 手机配对（D8）
// ---------------------------------------------------------------------------

function GatewayPanel({ status, loading, error, onRetry, onChanged }: {
  status: GatewayStatusView | null
  loading: boolean
  error: AsyncError | null
  onRetry: () => void
  onChanged: () => void
}) {
  const { show } = useToast()
  const [busy, setBusy] = useState(false)
  const [pairing, setPairing] = useState<{ code: string; expiresAt: number } | null>(null)
  const [pairingBusy, setPairingBusy] = useState(false)
  const [pairingError, setPairingError] = useState<string | null>(null)
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000))

  useEffect(() => {
    if (pairing === null) return
    const t = window.setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000)
    return () => window.clearInterval(t)
  }, [pairing])

  async function restart(): Promise<void> {
    setBusy(true)
    try {
      const first = await call('agents:gatewayRestart', {})
      if (first.confirmRequired === true) {
        const lines = ['重启远程网关？', `活跃连接：${first.impacts.activeConnections}`, first.impacts.note]
        if (window.confirm(lines.join('\n'))) {
          const done = await call('agents:gatewayRestart', { confirmed: true })
          if (done.confirmRequired === true) return
          show(`网关已重启：端口 ${done.port} running=${done.running}`)
          onChanged()
        }
      }
    } catch (err) {
      show(toAsyncErrorLocal(err).message, 'err')
    } finally {
      setBusy(false)
    }
  }

  async function createPairing(): Promise<void> {
    setPairingBusy(true)
    setPairingError(null)
    try {
      const result = await call('agents:pairingCreate', {})
      setNowSec(Math.floor(Date.now() / 1000))
      setPairing({ code: result.code, expiresAt: result.expiresAt })
    } catch (err) {
      const e = toAsyncErrorLocal(err)
      // GATEWAY_DISABLED：结构化引导文案（约束 #26），不是崩溃
      setPairingError(`${e.code}: ${e.message}`)
      setPairing(null)
    } finally {
      setPairingBusy(false)
    }
  }

  const state = resolvePanelState(status, loading, error)
  if (state.phase === 'loading') return <Loading label="正在加载 Gateway 状态…" />
  if (state.phase === 'error') return <ErrorState error={error as AsyncError} onRetry={onRetry} />
  if (state.phase === 'empty') return <div className="inline-note">暂无 Gateway 状态。</div>
  const st = state.data as GatewayStatusView
  const remaining = pairing !== null ? Math.max(0, pairing.expiresAt - nowSec) : 0

  return (
    <div className="agents-gateway">
      {error !== null && <div className="degraded-banner">gateway 轮询异常（显示为最后成功快照）: {error.code} — {error.message}</div>}
      <div className="agents-detail-meta">
        <Badge tone={st.enabled ? 'ok' : 'dim'}>enabled: {String(st.enabled)}</Badge>
        <Badge tone={st.running ? 'ok' : 'dim'}>running: {String(st.running)}</Badge>
        <span className="td-dim mono">port: {st.port}{st.actualPort !== undefined && st.actualPort !== st.port ? ` (actual ${st.actualPort})` : ''}</span>
        <span className="td-dim">活跃设备：{st.activeDevices}</span>
        <span className="td-dim">natpierce: {st.natpierce.configured ? (st.natpierce.reachable === true ? '已配置，可达' : '已配置') : '未配置（用户自备隧道，docs/15 §8）'}</span>
        {st.natpierce.hint !== undefined && <span className="td-dim">· {st.natpierce.hint}</span>}
        {st.lastError !== undefined && <span className="degraded-banner">last error: {st.lastError}</span>}
        <button type="button" className="btn btn-small" disabled={busy} onClick={() => void restart()}>
          {busy && <Spinner />} 重启网关
        </button>
      </div>
      <div className="agents-detail-meta">
        <button type="button" className="btn btn-small" disabled={pairingBusy} onClick={() => void createPairing()}>
          {pairingBusy && <Spinner />} 配对新设备（一次性码）
        </button>
        {pairing !== null && remaining > 0 && (
          <span className="agents-pairing-box">
            <span className="agents-pairing-code mono">{pairing.code}</span>
            <span className="td-dim">TTL {remaining}s · 8 位 Crockford Base32 · 码仅此一次显示，关闭即不可再见</span>
          </span>
        )}
        {pairing !== null && remaining === 0 && <span className="td-dim">配对码已过期（TTL 300s），请重新签发</span>}
        {pairingError !== null && <span className="degraded-banner">配对未签发：{pairingError}——远程面（gateway_enabled）未启用时属预期；启用 Gateway（AC6）后方可配对</span>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 面板 6.5：远程中继（Relay）设置分组（M3-C1b，docs/19 §4.7/§10）
// ---------------------------------------------------------------------------

/**
 * wss 前端校验（D7 / docs/18 §2，对齐 R3 App 行为）：仅接受可解析的 wss://，
 * 输 ws:// 红字拒绝保存（主进程 loopback-ws 联调例外不经 UI——UI 是正式面）。
 */
function validateRelayEndpointInput(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed.length === 0) return null // 空 = 未配置（清空保存合法，主进程按未配置投影）
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return '无法解析（期望形态 wss://host[:port][/path]，docs/18 §2）'
  }
  if (parsed.protocol !== 'wss:') return 'relay endpoint 必须 wss://（明文 ws:// 被拒——D7，与 R3 App 行为一致）'
  if (parsed.hostname.length === 0) return 'wss:// 后缺主机名'
  return null
}

function RelayPanel({ relay, onChanged }: {
  /** agents:gatewayStatus.relay 投影（disabled → null；状态行数据源）。 */
  relay: RelayStatusView | null
  onChanged: () => void
}) {
  const { show } = useToast()
  // settings 两键读写（settings:get/set 白名单既有，M2-R1 起；零新增 channel，PR12 纪律）
  const enabledSetting = useAsync(() => call('settings:get', { key: 'relay_enabled' }), [])
  const endpointSetting = useAsync(() => call('settings:get', { key: 'relay_endpoint' }), [])
  const [endpointInput, setEndpointInput] = useState('')
  const [endpointTouched, setEndpointTouched] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    if (endpointSetting.data !== null && !endpointTouched) setEndpointInput(endpointSetting.data.value)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅在设置数据首次到达时回填输入框
  }, [endpointSetting.data])

  const endpointError = validateRelayEndpointInput(endpointInput)
  const enabledNow = enabledSetting.data?.value === '1'
  const tls = relay?.tls

  async function toggleEnabled(next: boolean): Promise<void> {
    setBusy('enabled')
    try {
      await call('settings:set', { key: 'relay_enabled', value: next ? '1' : '0' })
      // M3-C3b 修3（C2 #4/C1c 遗留）：settings:set relay 键成功后失效本查询——勾选态由
      // 查询真值重渲染。此前 enabledSetting deps=[] 永不回刷（refreshAllPanels 只刷兄弟
      // 面板查询），checkbox 显示态与 DB 真值漂移。
      enabledSetting.refresh()
      show(`relay_enabled = ${next ? '1' : '0'}（relayClient 已按设置收敛）`)
      onChanged()
    } catch (err) {
      show(toAsyncErrorLocal(err).message, 'err')
    } finally {
      setBusy(null)
    }
  }

  async function saveEndpoint(): Promise<void> {
    if (endpointError !== null) return
    setBusy('endpoint')
    try {
      await call('settings:set', { key: 'relay_endpoint', value: endpointInput.trim() })
      // 同修3：endpoint 写入后失效查询并复位 touched——输入框回填 DB 真值（显示态=查询真值）
      endpointSetting.refresh()
      setEndpointTouched(false)
      show(`relay_endpoint saved（relayClient 已按设置收敛）`)
      onChanged()
    } catch (err) {
      show(toAsyncErrorLocal(err).message, 'err')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="agents-relay">
      <div className="relay-setting-row">
        <label className="agents-switch">
          <input
            type="checkbox"
            checked={enabledNow}
            disabled={enabledSetting.loading || busy !== null}
            onChange={(e) => void toggleEnabled(e.target.checked)}
          />
          启用远程中继 <span className="td-dim mono">relay_enabled</span>
          {busy === 'enabled' && <Spinner />}
        </label>
        <span className="td-dim">启用 = relayClient 按 settings + 凭据/信任物真值收敛（disabled/未注册/配置坏 → 结构化零连接投影）</span>
      </div>
      <div className="relay-setting-row">
        <input
          className="input relay-endpoint-input mono"
          placeholder="wss://59.110.149.11/relay/host"
          value={endpointInput}
          disabled={endpointSetting.loading || busy !== null}
          onChange={(e) => {
            setEndpointInput(e.target.value)
            setEndpointTouched(true)
          }}
          aria-label="relay endpoint"
        />
        <button
          type="button"
          className="btn btn-small"
          disabled={endpointSetting.loading || busy !== null || endpointError !== null || endpointInput.trim() === endpointSetting.data?.value}
          onClick={() => void saveEndpoint()}
        >
          {busy === 'endpoint' && <Spinner />} 保存 endpoint
        </button>
        {endpointError !== null && <span className="relay-endpoint-error">{endpointError}</span>}
      </div>
      <div className="relay-setting-row">
        <span className="td-dim">TLS 信任物料（docs/19 §10，指纹=公开物料）：</span>
        {tls === undefined ? (
          <span className="td-dim">启用后经 agents:gatewayStatus.relay.tls 只读投影</span>
        ) : tls.ok ? (
          <Badge tone="ok" title="wss 连接将以 tls{ca, checkServerIdentity} 构造（默认规则先行 + SPKI pin 任一命中）">
            指纹 {tls.pins} 枚 · 来源 {tls.source} · 就绪
          </Badge>
        ) : (
          <>
            <Badge tone="err" title={tls.error ?? 'trust material unavailable'}>指纹缺失</Badge>
            <span className="td-dim mono">{tls.error}</span>
          </>
        )}
      </div>
      {relay !== null && (
        <div className="relay-setting-row">
          <Badge tone={relay.connected ? 'ok' : 'dim'}>connected: {String(relay.connected)}</Badge>
          <span className="td-dim mono">{relay.endpoint.length > 0 ? relay.endpoint : 'endpoint 未配置'}</span>
          {relay.hostId !== undefined && <span className="td-dim">hostId {relay.hostId}</span>}
          {relay.warning !== undefined && <span className="degraded-banner relay-warning">{relay.warning}</span>}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 面板 7：诊断（D12，agents:diagnostics 全字段）
// ---------------------------------------------------------------------------

function DiagnosticsPanel({ diag, loading, error, onRetry }: {
  diag: AgentDiagnosticsResult | null
  loading: boolean
  error: AsyncError | null
  onRetry: () => void
}) {
  const state = resolvePanelState(diag, loading, error)
  if (state.phase === 'loading') return <Loading label="正在收集诊断信息…" />
  if (state.phase === 'error') return <ErrorState error={error as AsyncError} onRetry={onRetry} />
  if (state.phase === 'empty') return <div className="inline-note">暂无诊断信息。</div>
  const d = state.data as AgentDiagnosticsResult
  return (
    <div>
      {error !== null && <div className="degraded-banner">diagnostics 轮询异常（显示为最后成功快照）: {error.code} — {error.message}</div>}
      <div className="agents-detail-meta">
        <span className="td-dim">monitorEnabled: {String(d.monitorEnabled)}</span>
        <span className="td-dim">tray: {d.tray.available ? 'available' : 'unavailable'}</span>
        <span className="td-dim">autostart: {String(d.autostart.enabled)}</span>
        <span className="td-dim">gateway: enabled={String(d.gateway.enabled)} running={String(d.gateway.running)} port={d.gateway.port}</span>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Provider</th>
              <th>已安装</th>
              <th>exe</th>
              <th>数据源</th>
              <th>控制通道</th>
            </tr>
          </thead>
          <tbody>
            {d.providers.map((p) => (
              <tr key={p.id}>
                <td className="td-mono">{p.id}</td>
                <td>
                  <Badge tone={p.installed ? 'ok' : 'dim'}>{p.installed ? '是' : '否'}</Badge>
                </td>
                <td>
                  <Badge tone={p.exeFound ? 'ok' : 'dim'}>{p.exeFound ? '已找到' : '未找到'}</Badge>
                </td>
                <td className="td-dim" title={p.dataSource.detail ?? ''}>
                  <Badge tone={p.dataSource.readable ? 'ok' : 'warn'}>{p.dataSource.kind}</Badge>
                  {p.dataSource.detail !== undefined ? ` ${p.dataSource.detail}` : ''}
                </td>
                <td className="td-dim">
                  {p.control.hooks !== undefined && `hooks=${String(p.control.hooks)} `}
                  {p.control.appServer !== undefined && `appServer=${String(p.control.appServer)} `}
                  {p.control.stdin !== undefined && `stdin=${String(p.control.stdin)} `}
                  {p.control.note ?? ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 视图组装
// ---------------------------------------------------------------------------

export function AgentsView() {
  // providers 轮询（agents:providers；探测节流在服务端 60s，轮询面为廉价读）
  const providers = usePolling(() => call('agents:providers', {}), [], AGENTS_POLL_MS)
  // sessions 轮询（agents:sessions）。AC6 遗留小修（并入 AC6 批次）：providerId/
  // status 过滤真实传给服务端（此前为客户端过滤已载页——315 条只见前 100）；
  // limit 提升 = Load more（契约 payload 只有 limit：服务端按 id DESC 排序 +
  // limit 提升，docs/14 §A.1 #2 limit ≤200）。
  const [sessionProviderFilter, setSessionProviderFilter] = useState<string>('')
  const [sessionStatusFilter, setSessionStatusFilter] = useState<string>('')
  const [sessionLimit, setSessionLimit] = useState<number>(100)
  const sessions = usePolling(
    () =>
      call('agents:sessions', {
        limit: sessionLimit,
        ...(sessionProviderFilter !== '' ? { providerId: Number(sessionProviderFilter) } : {}),
        ...(sessionStatusFilter !== '' ? { status: sessionStatusFilter as SessionStatus } : {}),
      }),
    [sessionProviderFilter, sessionStatusFilter, sessionLimit],
    AGENTS_POLL_MS,
  )
  // events 全局游标流（after=sequence，docs/14 §A.3）
  const events = useCursorStream<AgentEventView>(
    async (after) => {
      const page = await call('agents:events', { ...(after !== undefined ? { after } : {}), limit: 100 })
      return { list: page.events, nextAfter: page.nextAfter }
    },
    [],
    { cap: 200 },
  )
  // devices / gateway / diagnostics 轮询。D3-F1（AUDIT D-Aud F1 修法）：devices /
  // diagnostics 属慢变面降频 10s（配对/撤销/设置变更仍有 onChanged→refresh 即时
  // 重拉兜底）；gatewayStatus 保持 2s（relay connected 态新鲜度）；providers /
  // sessions / events 新鲜度契约面全部不动（docs/14 §A.3）。
  const devices = usePolling(() => call('agents:devices', {}), [], AGENTS_SLOW_POLL_MS)
  const gateway = usePolling(() => call('agents:gatewayStatus', {}), [], AGENTS_POLL_MS)
  const diagnostics = usePolling(() => call('agents:diagnostics', {}), [], AGENTS_SLOW_POLL_MS)
  // project 关联显示（projects:list 一次挂载拉取，与 Services 归因列同模式）
  const projects = useAsync(() => call('projects:list', {}), [])

  const [selectedSessionId, setSelectedSessionId] = useState<number | null>(null)

  const providerNames = useMemo(() => {
    const map = new Map<number, string>()
    for (const p of providers.data?.providers ?? []) map.set(p.id, p.displayName)
    return map
  }, [providers.data])

  const projectNames = useMemo(() => {
    const map = new Map<number, string>()
    for (const p of projects.data ?? []) map.set(p.id, p.name)
    return map
  }, [projects.data])

  // 会话详情：选中行不存在（如被清理）时自动取消选中
  useEffect(() => {
    if (selectedSessionId !== null && sessions.data !== null && !sessions.data.sessions.some((s) => s.id === selectedSessionId)) {
      setSelectedSessionId(null)
    }
  }, [sessions.data, selectedSessionId])

  const monitorEnabled = providers.data?.monitorEnabled
  const autostartEnabled = diagnostics.data?.autostart.enabled
  const refreshAllPanels = (): void => {
    providers.refresh()
    sessions.refresh()
    devices.refresh()
    gateway.refresh()
    diagnostics.refresh()
  }

  return (
    <section className="view">
      <header className="view-header">
        <div>
          <h2 className="view-title">Agents</h2>
          <p className="view-sub">本机 AI Agent 统一监控与受限遥控面 — 五家 provider 真实探测 / 9 值会话状态 / 脱敏事件流（docs/11 §5）</p>
        </div>
      </header>

      <ControlBar
        monitorEnabled={monitorEnabled}
        autostartEnabled={autostartEnabled}
        onChanged={refreshAllPanels}
      />

      <h3 className="panel-title">Provider（健康四值 / 版本 / 能力集）</h3>
      <ProvidersPanel
        providers={providers.data?.providers ?? null}
        monitorEnabled={monitorEnabled}
        loading={providers.loading}
        error={providers.error}
        onRefresh={providers.refresh}
      />

      <h3 className="panel-title">会话（9 值状态 · waiting_input / approval_required 高亮区分 · stale 标注）</h3>
      <div className="panel">
        <SessionsPanel
          sessions={sessions.data?.sessions ?? null}
          loading={sessions.loading}
          error={sessions.error}
          onRetry={sessions.refresh}
          providerNames={providerNames}
          projectNames={projectNames}
          selectedId={selectedSessionId}
          onSelect={setSelectedSessionId}
          providerFilter={sessionProviderFilter}
          onProviderFilter={setSessionProviderFilter}
          statusFilter={sessionStatusFilter}
          onStatusFilter={setSessionStatusFilter}
          limit={sessionLimit}
          onLoadMore={() => setSessionLimit((n) => Math.min(200, n + 100))}
        />
      </div>

      {selectedSessionId !== null && (
        <>
          <h3 className="panel-title">会话 #{selectedSessionId} 详情（capabilities · counts · 脱敏消息 · 会话事件）</h3>
          <div className="panel">
            <SessionDetailPanel sessionId={selectedSessionId} providerNames={providerNames} projectNames={projectNames} />
          </div>
        </>
      )}

      <h3 className="panel-title">最近事件（after=sequence 游标轮询 · deliveryState 徽标）</h3>
      <div className="panel">
        {events.loading ? (
          <Loading label="正在轮询事件流…" />
        ) : events.list.length === 0 && events.error === null ? (
          <EmptyState title="还没有 Agent 事件" hint="会话发现 / 状态变化 / 消息追加 / 健康变化事件先落库后投递（docs/12 §6）。" />
        ) : events.list.length === 0 && events.error !== null ? (
          <ErrorState error={events.error} onRetry={events.refresh} />
        ) : (
          <>
            {events.error !== null && <div className="degraded-banner">events 轮询异常（游标保持，恢复后续传）: {events.error.code} — {events.error.message}</div>}
            <EventRows events={[...events.list].reverse()} />
          </>
        )}
      </div>

      <h3 className="panel-title">设备（已配对 · 撤销两段式 · 绝无 token 字段）</h3>
      <div className="panel">
        <DevicesPanel
          devices={devices.data?.devices ?? null}
          loading={devices.loading}
          error={devices.error}
          onRetry={devices.refresh}
          onChanged={refreshAllPanels}
        />
      </div>

      <h3 className="panel-title">Gateway 与配对（回环默认关 · 隧道提示 · 一次性配对码）</h3>
      <div className="panel">
        <GatewayPanel
          status={gateway.data ?? null}
          loading={gateway.loading}
          error={gateway.error}
          onRetry={gateway.refresh}
          onChanged={refreshAllPanels}
        />
      </div>

      <h3 className="panel-title">远程中继（Relay）— 设置驱动面（relay_enabled · wss endpoint · TLS 指纹）</h3>
      <div className="panel">
        <RelayPanel relay={gateway.data?.relay ?? null} onChanged={refreshAllPanels} />
      </div>

      <h3 className="panel-title">诊断（数据源可读性 / 控制通道 / Gateway / 托盘 / 自启）</h3>
      <div className="panel">
        <DiagnosticsPanel diag={diagnostics.data ?? null} loading={diagnostics.loading} error={diagnostics.error} onRetry={diagnostics.refresh} />
      </div>
    </section>
  )
}
