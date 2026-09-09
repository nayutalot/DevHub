/**
 * overlayStateService.ts — ContestPin 悬浮窗状态 / 外部链接校验 / due-node 相关
 * applier 注入位（CP2 批次，docs/22 §4 + 任务书 §2.1 #4）。
 *
 * - electron-free 纯 Node 模块（与 contestService 同纪律）：settings 读写经
 *   settingsService（白名单键 contestpin_overlay_enabled / contestpin_overlay_state，
 *   CP1 批次已入册），本模块不直接触碰 SQL —— wire 层（overlayWire.ts）也不写 SQL，
 *   持久化唯一入口在 service 层（约束 #20）。
 * - 窗口/浏览器打开等 electron 能力经注入 applier（autostartWire.setAutoStartApplier
 *   先例）：wire 层 init 时注册生产实现；纯 Node（smoke）语境未注入 → 结构化 no-op
 *   （opened:false），绝不抛 electron 相关异常。
 * - contestpin_overlay_state 值格式（CP1 smoke 已锚定）：
 *   {"bounds":{"x":1,"y":2,"width":320,"height":420},"collapsed":false}；
 *   非法持久化值（非 JSON / 形状不符）一律拒绝并回默认（bounds=null → wire 层
 *   居中主显示器），绝不把脏数据抛给 renderer。
 * - validateExternalUrl：仅 http/https（拒绝 javascript:/file:/ftp:/空白/相对
 *   路径等），返回规范化 URL；违规一律 ServiceError('BAD_PAYLOAD')（约束 #14）。
 */

import type {
  ContestOverlayBounds,
  ContestOverlaySetCollapsedResult,
  ContestOverlaySetEnabledResult,
  ContestOverlayStateResult,
} from '../../../shared/types.ts'
import { ServiceError } from '../internal.ts'
import { getSetting, setSetting } from '../settingsService.ts'

const ENABLED_KEY = 'contestpin_overlay_enabled'
const STATE_KEY = 'contestpin_overlay_state'

// ---------------------------------------------------------------------------
// applier 注入位（wire 层生产实现；electron-free 语境为 null → 结构化 no-op）
// ---------------------------------------------------------------------------

/** 悬浮窗开关的窗口侧实现（创建/show 或 hide），overlayWire 注册。 */
export type OverlaySwitchApplier = (enabled: boolean) => void
/** 折叠态的窗口侧实现（按 collapsed 调整窗口高度，宽度不变）。 */
export type OverlayCollapsedApplier = (collapsed: boolean) => void
/** 默认浏览器打开实现（shell.openExternal），overlayWire 注册。 */
export type OpenExternalApplier = (url: string) => void
/** 聚焦主窗口并导航 contest:<id> 的实现，overlayWire 注册（showMainWindow 先例）。 */
export type OpenInMainApplier = (contestId: number) => void

let overlaySwitchApplier: OverlaySwitchApplier | null = null
let overlayCollapsedApplier: OverlayCollapsedApplier | null = null
let openExternalApplier: OpenExternalApplier | null = null
let openInMainApplier: OpenInMainApplier | null = null

export function setOverlaySwitchApplier(applier: OverlaySwitchApplier | null): void {
  overlaySwitchApplier = applier
}

export function setOverlayCollapsedApplier(applier: OverlayCollapsedApplier | null): void {
  overlayCollapsedApplier = applier
}

export function setOpenExternalApplier(applier: OpenExternalApplier | null): void {
  openExternalApplier = applier
}

export function setOpenInMainApplier(applier: OpenInMainApplier | null): void {
  openInMainApplier = applier
}

// ---------------------------------------------------------------------------
// enabled 开关（settings 持久化 + 窗口 applier 即时生效）
// ---------------------------------------------------------------------------

export function isOverlayEnabled(): boolean {
  return getSetting(ENABLED_KEY) === '1'
}

/** 持久化开关 + 通知 wire 层创建/show 或 hide（applier 未注入时仅持久化）。 */
export function setOverlayEnabled(enabled: boolean): ContestOverlaySetEnabledResult {
  setSetting(ENABLED_KEY, enabled ? '1' : '0')
  overlaySwitchApplier?.(enabled)
  return { enabled }
}

// ---------------------------------------------------------------------------
// 状态（bounds + collapsed）往返：读拒绝脏数据回默认，写先校验
// ---------------------------------------------------------------------------

const DEFAULT_STATE: ContestOverlayStateResult = {
  enabled: false,
  bounds: null,
  collapsed: false,
}

/** bounds 形状校验：x/y 有限数值，width/height 正有限数值。 */
function isValidBounds(value: unknown): value is ContestOverlayBounds {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const b = value as Record<string, unknown>
  return (
    typeof b.x === 'number' && Number.isFinite(b.x) &&
    typeof b.y === 'number' && Number.isFinite(b.y) &&
    typeof b.width === 'number' && Number.isFinite(b.width) && b.width > 0 &&
    typeof b.height === 'number' && Number.isFinite(b.height) && b.height > 0
  )
}

/**
 * 读取悬浮窗状态（enabled + bounds + collapsed）。持久化值缺失/非法（非 JSON、
 * 形状不符）一律回默认（bounds=null + collapsed=false），由 wire 层居中主显示器
 * ——脏数据绝不向上抛（docs/22 §4.3「校验 + workArea 裁剪」的服务侧半边）。
 */
export function getOverlayState(): ContestOverlayStateResult {
  let raw: string | undefined
  try {
    raw = getSetting(STATE_KEY)
  } catch {
    return { ...DEFAULT_STATE, enabled: false }
  }
  const state: ContestOverlayStateResult = {
    enabled: isOverlayEnabledSafe(),
    bounds: null,
    collapsed: false,
  }
  if (raw === undefined || raw.trim().length === 0) {
    return state
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return state
    }
    const record = parsed as Record<string, unknown>
    if (record.bounds === null || isValidBounds(record.bounds)) {
      state.bounds = record.bounds === null ? null : { ...record.bounds }
    } // else：bounds 形状非法 → 保持 null（拒绝并回默认）
    if (typeof record.collapsed === 'boolean') {
      state.collapsed = record.collapsed
    }
    return state
  } catch {
    return state // 非 JSON → 默认
  }
}

function isOverlayEnabledSafe(): boolean {
  try {
    return isOverlayEnabled()
  } catch {
    return false
  }
}

/** 持久化悬浮窗状态（wire 层防抖后的唯一写入口）；入参非法 BAD_PAYLOAD。 */
export function saveOverlayState(bounds: ContestOverlayBounds | null, collapsed: boolean): void {
  if (bounds !== null && !isValidBounds(bounds)) {
    throw new ServiceError('BAD_PAYLOAD', 'overlayState: bounds must be {x, y, width>0, height>0} numbers or null')
  }
  if (typeof collapsed !== 'boolean') {
    throw new ServiceError('BAD_PAYLOAD', 'overlayState: collapsed must be a boolean')
  }
  setSetting(STATE_KEY, JSON.stringify({ bounds, collapsed }))
}

/** 折叠切换（渲染层/托盘入口）：持久化 + wire 层窗口高度调整（宽度不变）。 */
export function setOverlayCollapsed(collapsed: boolean): ContestOverlaySetCollapsedResult {
  const current = getOverlayState()
  saveOverlayState(current.bounds, collapsed)
  overlayCollapsedApplier?.(collapsed)
  return { collapsed }
}

// ---------------------------------------------------------------------------
// 外部链接校验与打开（悬浮窗 官网/报名/提交 入口）
// ---------------------------------------------------------------------------

/**
 * validateExternalUrl：仅 http/https 绝对 URL。拒绝 javascript:/file:/ftp:/
 * 空白/相对路径/不可解析输入；返回规范化 URL（new URL().toString()）。
 * 违规一律 ServiceError('BAD_PAYLOAD')（约束 #14 结构化错误）。
 */
export function validateExternalUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim()
  if (trimmed.length === 0) {
    throw new ServiceError('BAD_PAYLOAD', 'openLink: url must be a non-empty http(s) URL')
  }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new ServiceError('BAD_PAYLOAD', 'openLink: url must be an absolute http(s) URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ServiceError('BAD_PAYLOAD', `openLink: url must be an http(s) URL (got scheme: ${parsed.protocol})`)
  }
  return parsed.toString()
}

/**
 * 打开外部链接（悬浮窗/详情入口按钮）：service 侧先校验，再经注入的
 * openExternalApplier（生产=shell.openExternal）打开默认浏览器。
 * applier 未注入（纯 Node 语境）→ { opened: false }（结构化 no-op）。
 */
export function openExternalLink(rawUrl: string): { opened: boolean } {
  const url = validateExternalUrl(rawUrl)
  if (openExternalApplier === null) return { opened: false }
  openExternalApplier(url)
  return { opened: true }
}

/**
 * 在主窗口打开比赛详情（悬浮窗卡片点击）：存在性校验由 handlers 侧经
 * contestService 承担；本函数只负责经注入 applier 聚焦主窗口 + 导航。
 * applier 未注入 → { opened: false }。
 */
export function openContestInMain(contestId: number): { opened: boolean } {
  if (openInMainApplier === null) return { opened: false }
  openInMainApplier(contestId)
  return { opened: true }
}
