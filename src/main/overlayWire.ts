/**
 * overlayWire.ts — ContestPin 悬浮窗的 Electron 胶水（CP2 批次，docs/22 §4）。
 *
 * 唯一新增 electron import 位（autostartWire.ts 纪律注记扩展）：electron import
 * 白名单 = index.ts / keyStoreWire.ts / ipc/gateway.ts / autostartWire.ts /
 * trayWire.ts / 本模块。窗口/屏幕能力只在本文件出现；handlers/renderer 经
 * overlayStateService 的注入 applier 间接到达（service 层保持 electron-free）。
 *
 * 职责（docs/22 §4.1–§4.4）：
 *  - initOverlay：注册 service 侧 applier（开关/折叠/默认浏览器/主窗口导航），
 *    settings contestpin_overlay_enabled 为 '1' 时创建悬浮窗（frame:false /
 *    alwaysOnTop / skipTaskbar / show:false → ready-to-show 后 show；webPreferences
 *    与主窗口同款 sandbox/contextIsolation/preload —— 复用唯一 devhub:invoke 网关，
 *    不写第二个 preload）。
 *  - 位置/尺寸：启动恢复时 screen.getDisplayMatching 校验 + workArea 裁剪（显示器
 *    变化后回可见区；Electron bounds 为 DIP，不自行换算 DPI scale factor）；
 *    折叠态重启恢复=建窗即折叠高度（展开高度由 expandedHeight 记忆，取消折叠回它）。
 *    display-removed / display-metrics-changed 主动 relocate。
 *  - move/resize 防抖（600ms）→ overlayStateService.saveOverlayState（写库唯一经
 *    service，wire 层不写 SQL）；collapsed 时持久化高度记展开态高度。
 *  - close 事件：!isQuitting → preventDefault + hide（与主窗口同款守卫）；退出路径
 *    由 destroyOverlay 兜底（runQuitTeardown 最前调用，同步非阻塞）。
 *  - setOverlayEnabled：开=创建/show，关=hide（选 hide 非销毁：托盘/设置反复开关
 *    不经历 create + ready-to-show 闪烁，hide 后零渲染开销；退出由 destroyOverlay
 *    收口）。settings 持久化经 overlayStateService 助手。
 *  - setOpenExternalApplier / setFocusMainWindowApplier：index.ts 接线处注册生产
 *    实现（shell.openExternal / showMainWindow + loadRenderer hash contest:<id>）。
 */

import { BrowserWindow, screen } from 'electron'
import type { Rectangle } from 'electron'
import { join } from 'node:path'
import { logger } from './core/logger.ts'
import {
  getOverlayState,
  isOverlayEnabled,
  saveOverlayState,
  setOverlayCollapsed as serviceSetOverlayCollapsed,
  setOverlayCollapsedApplier,
  setOpenExternalApplier as setServiceOpenExternalApplier,
  setOpenInMainApplier as setServiceOpenInMainApplier,
  setOverlayEnabled as serviceSetOverlayEnabled,
  setOverlaySwitchApplier,
} from './services/contestpin/overlayStateService.ts'

// ---------------------------------------------------------------------------
// 尺寸常量（DIP；折叠态 = 单行摘要高度）
// ---------------------------------------------------------------------------

const OVERLAY_DEFAULT_WIDTH = 320
const OVERLAY_DEFAULT_HEIGHT = 420
const OVERLAY_COLLAPSED_HEIGHT = 56
const OVERLAY_MIN_WIDTH = 240
const OVERLAY_MIN_HEIGHT = 40
const OVERLAY_MAX_WIDTH = 720
const OVERLAY_MAX_HEIGHT = 1400
/** move/resize 防抖窗口（≥500ms 要求，任务书 §2.1 #1）。 */
const SAVE_DEBOUNCE_MS = 600

// ---------------------------------------------------------------------------
// 模块态（退出路径 destroyOverlay 统一清空，幂等）
// ---------------------------------------------------------------------------

let overlayWindow: BrowserWindow | null = null
/** 当前折叠态（wire 层窗口高度的依据；持久化在 service）。 */
let collapsed = false
/** 折叠前的展开态高度（恢复展开时回该高度；启动恢复自持久化 bounds）。 */
let expandedHeight = OVERLAY_DEFAULT_HEIGHT
let saveTimer: NodeJS.Timeout | null = null
let displayWatchAttached = false
let isQuittingProbe: () => boolean = () => false
let loadPage: ((win: BrowserWindow) => void) | null = null

/** 生产实现（index.ts 注册）：默认浏览器打开 / 主窗口聚焦 + contest:<id> 导航。 */
let openExternalImpl: ((url: string) => void) | null = null
let focusMainImpl: ((contestId: number) => void) | null = null

/** index.ts 接线：shell.openExternal 生产实现（经 service applier 供 handlers 到达）。 */
export function setOpenExternalApplier(impl: (url: string) => void): void {
  openExternalImpl = impl
  setServiceOpenExternalApplier((url) => {
    if (openExternalImpl !== null) openExternalImpl(url)
  })
}

/** index.ts 接线：showMainWindow + loadRenderer hash `contest:<id>` 生产实现。 */
export function setFocusMainWindowApplier(impl: (contestId: number) => void): void {
  focusMainImpl = impl
  setServiceOpenInMainApplier((contestId) => {
    if (focusMainImpl !== null) focusMainImpl(contestId)
  })
}

// ---------------------------------------------------------------------------
// bounds 校正（DIP；不换算 DPI scale，docs/22 §4.3）
// ---------------------------------------------------------------------------

/** 裁剪到目标显示器 workArea 内（尺寸夹取 min/max + 位置夹取可见区）。 */
function clampBoundsToWorkArea(bounds: Rectangle): Rectangle {
  const display = screen.getDisplayMatching(bounds)
  const wa = display.workArea
  const width = Math.min(Math.max(bounds.width, OVERLAY_MIN_WIDTH), OVERLAY_MAX_WIDTH, wa.width)
  const height = Math.min(Math.max(bounds.height, OVERLAY_MIN_HEIGHT), OVERLAY_MAX_HEIGHT, wa.height)
  const x = Math.min(Math.max(bounds.x, wa.x), Math.max(wa.x, wa.x + wa.width - width))
  const y = Math.min(Math.max(bounds.y, wa.y), Math.max(wa.y, wa.y + wa.height - height))
  return { x, y, width, height }
}

/** 默认位置：主显示器 workArea 居中（持久化 bounds=null 时的落点）。 */
function defaultBounds(): Rectangle {
  const wa = screen.getPrimaryDisplay().workArea
  return {
    x: wa.x + Math.max(0, Math.floor((wa.width - OVERLAY_DEFAULT_WIDTH) / 2)),
    y: wa.y + Math.max(0, Math.floor((wa.height - OVERLAY_DEFAULT_HEIGHT) / 2)),
    width: Math.min(OVERLAY_DEFAULT_WIDTH, wa.width),
    height: Math.min(OVERLAY_DEFAULT_HEIGHT, wa.height),
  }
}

// ---------------------------------------------------------------------------
// 持久化（防抖）与折叠
// ---------------------------------------------------------------------------

/** 立即持久化当前窗口态：collapsed 时高度记展开态高度（bounds 语义=展开态）。 */
function saveStateNow(): void {
  const win = overlayWindow
  if (win === null || win.isDestroyed()) return
  const b = win.getBounds()
  saveOverlayState(
    { x: b.x, y: b.y, width: b.width, height: collapsed ? expandedHeight : b.height },
    collapsed,
  )
}

function scheduleSaveState(): void {
  if (saveTimer !== null) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      saveStateNow()
    } catch (err) {
      logger.warn(`overlay save state failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, SAVE_DEBOUNCE_MS)
  saveTimer.unref()
}

/** 折叠切换的窗口半边（service applier 注入位）：只调高度，宽度不变。 */
function applyOverlayCollapsed(next: boolean): void {
  collapsed = next
  const win = overlayWindow
  if (win === null || win.isDestroyed()) return
  const b = win.getBounds()
  if (next) {
    expandedHeight = b.height
    win.setBounds({ height: OVERLAY_COLLAPSED_HEIGHT })
  } else {
    win.setBounds({ height: Math.min(Math.max(expandedHeight, OVERLAY_MIN_HEIGHT), OVERLAY_MAX_HEIGHT) })
  }
}

// ---------------------------------------------------------------------------
// 显示器变化监听（display-removed / display-metrics-changed → relocate）
// ---------------------------------------------------------------------------

function relocateOverlay(): void {
  const win = overlayWindow
  if (win === null || win.isDestroyed() || !win.isVisible()) return
  const b = win.getBounds()
  const refHeight = collapsed ? expandedHeight : b.height
  const clamped = clampBoundsToWorkArea({ x: b.x, y: b.y, width: b.width, height: refHeight })
  if (clamped.x !== b.x || clamped.y !== b.y) {
    win.setBounds({ x: clamped.x, y: clamped.y })
  }
}

function attachDisplayWatch(): void {
  if (displayWatchAttached) return
  displayWatchAttached = true
  screen.on('display-removed', relocateOverlay)
  screen.on('display-metrics-changed', relocateOverlay)
}

function detachDisplayWatch(): void {
  if (!displayWatchAttached) return
  displayWatchAttached = false
  screen.removeListener('display-removed', relocateOverlay)
  screen.removeListener('display-metrics-changed', relocateOverlay)
}

// ---------------------------------------------------------------------------
// 窗口生命周期
// ---------------------------------------------------------------------------

function createOverlayWindow(): void {
  if (overlayWindow !== null && !overlayWindow.isDestroyed()) return

  const state = getOverlayState()
  collapsed = state.collapsed
  expandedHeight = state.bounds !== null ? state.bounds.height : OVERLAY_DEFAULT_HEIGHT
  // 恢复位置：持久化 bounds 经 displayMatching 校验 + workArea 裁剪（显示器被拔/
  // 分辨率变化后回可见区）；无持久化 → 主显示器居中
  const restored = state.bounds !== null ? clampBoundsToWorkArea(state.bounds) : defaultBounds()
  // 折叠态重启恢复=建窗即折叠高度（宽度/x/y 不变；展开高度已由 expandedHeight 记忆，
  // applyOverlayCollapsed(false) 时回到它）——否则高个子窗体配折叠单行内容，视觉错位
  const bounds = collapsed ? { ...restored, height: OVERLAY_COLLAPSED_HEIGHT } : restored

  const win = new BrowserWindow({
    ...bounds,
    minWidth: OVERLAY_MIN_WIDTH,
    minHeight: OVERLAY_MIN_HEIGHT,
    maxWidth: OVERLAY_MAX_WIDTH,
    maxHeight: OVERLAY_MAX_HEIGHT,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    show: false,
    title: 'DevHub Contests',
    backgroundColor: '#1e1e1e',
    webPreferences: {
      // 与主窗口完全同款（约束 #18；复用唯一 preload/devhub:invoke 网关）
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  overlayWindow = win

  // close=hide 语义（与主窗口同款 isQuitting 守卫；退出路径 destroyOverlay 兜底）
  win.on('close', (event) => {
    if (!isQuittingProbe()) {
      event.preventDefault()
      win.hide()
    }
  })
  win.on('move', scheduleSaveState)
  win.on('resize', scheduleSaveState)
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show()
  })
  if (loadPage !== null) loadPage(win)

  attachDisplayWatch()
  logger.info(`overlay window created (collapsed=${collapsed ? '1' : '0'}, bounds restored from settings)`)
}

/**
 * 开关（窗口半边，overlayStateService applier 注入位）：开=创建/show；关=hide
 * （选型注记见文件头）。持久化由调用方 service 半边完成，本函数不写 settings。
 */
function applyOverlayVisibility(enabled: boolean): void {
  if (enabled) {
    if (overlayWindow === null || overlayWindow.isDestroyed()) {
      createOverlayWindow()
      return
    }
    if (!overlayWindow.isVisible()) overlayWindow.show()
    overlayWindow.focus()
    return
  }
  if (overlayWindow !== null && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) {
    overlayWindow.hide()
  }
}

/**
 * whenReady 后由 index.ts 调用一次：注册 service applier（生产实现）→ 按
 * contestpin_overlay_enabled 现值决定是否创建悬浮窗。
 */
export function initOverlay(deps: {
  /** isQuitting 探针（index.ts 持有标志）：close 事件放行真退出。 */
  isQuitting: () => boolean
  /** 页面加载（index.ts loadRenderer 注入，hash 'overlay' → #overlay 分流 OverlayApp）。 */
  loadPage: (win: BrowserWindow) => void
}): void {
  isQuittingProbe = deps.isQuitting
  loadPage = deps.loadPage
  setOverlaySwitchApplier(applyOverlayVisibility)
  setOverlayCollapsedApplier(applyOverlayCollapsed)
  if (isOverlayEnabled()) {
    createOverlayWindow()
  } else {
    logger.info('overlay disabled by settings (contestpin_overlay_enabled=0) — window not created')
  }
}

/** 托盘/设置入口：settings 持久化经 service 助手 + 窗口即时生效（applier 回环）。 */
export function setOverlayEnabled(enabled: boolean): void {
  try {
    serviceSetOverlayEnabled(enabled)
  } catch (err) {
    logger.error(`overlay enable failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** 折叠入口：持久化 + 窗口高度调整（宽度不变）。 */
export function setOverlayCollapsed(next: boolean): void {
  try {
    serviceSetOverlayCollapsed(next)
  } catch (err) {
    logger.error(`overlay collapse failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * 退出清理（runQuitTeardown 最前调用，先于 closeDatabase）：清防抖句柄 →
 * 撤 screen 监听 → destroy 窗口。同步非阻塞、幂等；destroy 绕过 close 事件
 * （isQuitting 守卫不再需要拦截），防 ref'd 定时器经 getDatabase() 惰性重开 DB。
 */
export function destroyOverlay(): void {
  if (saveTimer !== null) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  detachDisplayWatch()
  const win = overlayWindow
  overlayWindow = null
  if (win !== null && !win.isDestroyed()) {
    try {
      win.destroy()
      logger.info('overlay window destroyed (quit teardown)')
    } catch (err) {
      logger.warn(`overlay destroy failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
