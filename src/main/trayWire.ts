/**
 * trayWire.ts — 托盘常驻的 Electron 胶水（AC5，docs/12 §10）。
 *
 * Tray 单例持有：重建前先 destroy（防重复图标/监听器泄漏）。菜单六项（docs/12
 * §10 + docs/11 §6 + docs/22 §4.5）：打开 DevHub / 查看 Agent 摘要（导航到 Agents
 * 视图）/ 开启/暂停 Agent 监控（勾选态 = settings agents_monitor_enabled，切换走既有
 * settings 写路径 + syncMonitorTasks）/ 开机自启（勾选态 = login_autostart，
 * 切换 = agents:setAutoStart 同语义）/ 比赛悬浮窗（CP2，勾选态 =
 * contestpin_overlay_enabled，切换 = deps.setOverlayEnabled）/ 退出 DevHub（唯一真
 * 退出入口）。
 *
 * 图标：resources/tray.png（@2x 相邻自动加载，docs/12 §10）；加载失败降级空图标 +
 * 结构化日志不崩（docs/12 §10）。electron import 仅本模块（main 根胶水位）。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, Menu, nativeImage, Tray } from 'electron'
import type { NativeImage } from 'electron'
import { logger } from './core/logger.ts'
import { getSetting, setSetting } from './services/settingsService.ts'
import {
  getAgentSummaryCounts,
  setAgentTrayAvailable,
  setAutoStart,
  syncMonitorTasks,
} from './services/agentControl/agentControlService.ts'
import { agentSummaryText } from './services/agentControl/traySummary.ts'

export interface TrayDeps {
  /** 打开主窗口（show + focus）。 */
  showMainWindow(): void
  /** 打开主窗口并导航到 Agents 视图（#/agents hash 重载，docs/12 §10）。 */
  showMainWindowNavigateAgents(): void
  /** 唯一真退出：置 isQuitting → 有序收尾 → app.quit()（index.ts 提供）。 */
  quitApp(): void
  /** CP2 比赛悬浮窗开关（docs/22 §4.5）：settings 持久化 + 窗口即时生效
   * （overlayWire.setOverlayEnabled，index.ts 接线注入；与
   * contestpin:overlaySetEnabled 同一收敛点）。 */
  setOverlayEnabled(enabled: boolean): void
}

let tray: Tray | null = null
/** 菜单重建去抖：勾选态未变化时不重建（避免周期 tooltip 刷新打断打开中的菜单）。 */
let lastMenuState = { monitor: false, autostart: false, overlay: false }

/**
 * 图标加载（双模式路径解析，packaging fix）：dev 下项目根 resources/ 两个既有
 * candidate；打包后 resources/ 经 extraResources 落在 asar 外的
 * process.resourcesPath/resources/（asar 内旧路径均不存在）→ app.isPackaged
 * 时优先追加该 candidate。失败 → 空图标 + 结构化日志（docs/12 §10）。
 */
function loadTrayIcon(): NativeImage {
  const candidates = [
    join(app.getAppPath(), 'resources', 'tray.png'),
    join(__dirname, '../../resources/tray.png'),
  ]
  if (app.isPackaged) {
    candidates.unshift(join(process.resourcesPath, 'resources', 'tray.png'))
  }
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue
      const image = nativeImage.createFromPath(candidate)
      if (image.isEmpty()) {
        logger.warn(`tray icon file present but decoded empty: ${candidate}`)
        continue
      }
      logger.info(`tray icon loaded: ${candidate}`)
      return image
    } catch (err) {
      logger.warn(`tray icon load failed (${candidate}): ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  logger.warn('tray icon resource unavailable on every candidate path — degrading to empty icon (docs/12 §10)')
  return nativeImage.createEmpty()
}

/** 摘要文案（真实库投影；DB 早期不可用等异常降级为纯应用名，绝不崩托盘）。 */
function summaryText(): string {
  try {
    return agentSummaryText(getAgentSummaryCounts())
  } catch (err) {
    logger.warn(`tray summary unavailable: ${err instanceof Error ? err.message : String(err)}`)
    return 'DevHub — Agents: summary unavailable'
  }
}

function monitorEnabledSetting(): boolean {
  return getSetting('agents_monitor_enabled') !== '0'
}

function buildContextMenu(deps: TrayDeps): Menu {
  const monitor = monitorEnabledSetting()
  let autostart = false
  let overlay = false
  try {
    autostart = getSetting('login_autostart') === '1'
    // CP2：种子默认 '0'（关）——与 monitor（默认开）语义相反，用 === '1'
    overlay = getSetting('contestpin_overlay_enabled') === '1'
  } catch {
    // settings 读取失败：勾选态按关渲染（结构化降级，切换时真实写路径会纠正）
  }
  lastMenuState = { monitor, autostart, overlay }
  return Menu.buildFromTemplate([
    { label: '打开 DevHub', click: () => deps.showMainWindow() },
    { label: '查看 Agent 摘要', click: () => deps.showMainWindowNavigateAgents() },
    { type: 'separator' },
    {
      label: '开启/暂停 Agent 监控',
      type: 'checkbox',
      checked: monitor,
      click: (item) => {
        try {
          // 与 settings:set(agents_monitor_enabled) 同一条写路径（AC3 接线）：
          // 写 settings → syncMonitorTasks 即时生效（docs/16 §1 AC3 行）
          setSetting('agents_monitor_enabled', item.checked ? '1' : '0')
          void syncMonitorTasks().catch((err: unknown) => {
            logger.warn(`tray monitor toggle: syncMonitorTasks failed: ${err instanceof Error ? err.message : String(err)}`)
          })
          logger.info(`tray monitor toggle: agents_monitor_enabled=${item.checked ? '1' : '0'}`)
        } catch (err) {
          logger.warn(`tray monitor toggle failed: ${err instanceof Error ? err.message : String(err)}`)
        }
        rebuildContextMenu(deps)
      },
    },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: autostart,
      click: (item) => {
        try {
          // 与 agents:setAutoStart 同语义（settings + 注入位即时应用，docs/12 §10）
          setAutoStart(item.checked)
          logger.info(`tray autostart toggle: login_autostart=${item.checked ? '1' : '0'}`)
        } catch (err) {
          logger.warn(`tray autostart toggle failed: ${err instanceof Error ? err.message : String(err)}`)
        }
        rebuildContextMenu(deps)
      },
    },
    {
      // CP2 比赛悬浮窗（docs/22 §4.5）：checked = contestpin_overlay_enabled，
      // 点击 toggle → deps.setOverlayEnabled（settings 持久化 + 窗口即时生效）+ rebuild
      label: '比赛悬浮窗',
      type: 'checkbox',
      checked: overlay,
      click: (item) => {
        try {
          deps.setOverlayEnabled(item.checked)
          logger.info(`tray overlay toggle: contestpin_overlay_enabled=${item.checked ? '1' : '0'}`)
        } catch (err) {
          logger.warn(`tray overlay toggle failed: ${err instanceof Error ? err.message : String(err)}`)
        }
        rebuildContextMenu(deps)
      },
    },
    { type: 'separator' },
    { label: '退出 DevHub', click: () => deps.quitApp() },
  ])
}

function rebuildContextMenu(deps: TrayDeps): void {
  if (tray === null) return
  try {
    tray.setContextMenu(buildContextMenu(deps))
  } catch (err) {
    logger.warn(`tray context menu rebuild failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * 创建（或重建）托盘：destroy 旧实例 → new Tray → 右键菜单 + tooltip +
 * 左键点击恢复主窗口（docs/11 §6）。创建成功回报 agents:diagnostics tray.available。
 */
export function initTray(deps: TrayDeps): void {
  destroyTray()
  try {
    tray = new Tray(loadTrayIcon())
    tray.setToolTip(summaryText())
    tray.setContextMenu(buildContextMenu(deps))
    tray.on('click', () => deps.showMainWindow())
    setAgentTrayAvailable(true)
    logger.info('tray created (resident mode: closing the window hides it, docs/12 §10)')
  } catch (err) {
    tray = null
    setAgentTrayAvailable(false)
    logger.error(`tray init failed (app continues without tray): ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * 周期刷新（2s 轮询节奏与 renderer 对齐）：tooltip 恒更新；菜单仅勾选态变化时
 * 重建（避免打断打开中的菜单）。
 */
export function refreshTraySummary(deps: TrayDeps): void {
  if (tray === null) return
  try {
    tray.setToolTip(summaryText())
    let monitor = false
    let autostart = false
    let overlay = false
    try {
      monitor = monitorEnabledSetting()
      autostart = getSetting('login_autostart') === '1'
      overlay = getSetting('contestpin_overlay_enabled') === '1'
    } catch {
      return // settings 暂不可读：保持上一次菜单
    }
    if (
      monitor !== lastMenuState.monitor ||
      autostart !== lastMenuState.autostart ||
      overlay !== lastMenuState.overlay
    ) {
      tray.setContextMenu(buildContextMenu(deps))
    }
  } catch (err) {
    logger.warn(`tray refresh failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** 托盘销毁（退出收尾与重建路径共用；幂等）。 */
export function destroyTray(): void {
  if (tray === null) return
  try {
    tray.destroy()
    logger.info('tray destroyed')
  } catch (err) {
    logger.warn(`tray destroy failed: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    tray = null
    setAgentTrayAvailable(false)
  }
}
