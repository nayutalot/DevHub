/**
 * DevHub 主进程入口（docs/02 §1，docs/07 Step 6；AC5 托盘生命周期 docs/12 §10）。
 *
 * 职责：单实例锁 → 全局异常钩子 → whenReady 初始化（AppUserModelID → SQLite 落
 * userData → 密钥加密/自启注入 → 注册唯一 IPC 网关 → 主窗口 + 托盘常驻）。
 * 系统操作全部经 Service 层；本文件不做任何探测/写库以外的事情（DB 初始化
 * 只是触发惰性单例，读写仍只发生在 Service 层，约束 #20）。
 *
 * 托盘生命周期（docs/12 §10 逐项）：isQuitting 标志（before-quit 置 true）→
 * 窗口 close 事件 !isQuitting → preventDefault + hide（关窗 = 隐藏，监控/Gateway
 * 持续）→ window-all-closed 不 quit → second-instance 窗口隐藏时 show + focus →
 * 退出唯一入口（托盘「退出 DevHub」/ before-quit）按收尾顺序：
 * cancelAll 监控 → [关 WS → 关 Gateway（AC6 预留位）] → 托管子进程收尾
 * （provider.dispose）→ closeDatabase（WAL 落盘）→ app.quit()。
 * 退出保证（AC9 退出滞留修复）：teardown 前先撤 UI 常驻句柄（destroyTray + 清
 * 2s 刷新 interval——ref'd 定时器会让主进程事件循环永不枯竭而滞留）；teardown
 * 完成（或 5s 硬上限到）后 quit，若宽限期到进程仍未退则 app.exit(0) 强退，
 * 杜绝主进程+GPU+网络服务滞留（状态机见 core/quitGuarantee.ts，smoke 可测）。
 */

import { join } from 'node:path'
import { app, BrowserWindow, Menu, shell } from 'electron'
import { logger } from './core/logger.ts'
import {
  quitTransition,
  QUIT_TEARDOWN_HARD_CAP_MS,
  QUIT_EXIT_WATCHDOG_MS,
  type QuitAction,
  type QuitStage,
} from './core/quitGuarantee.ts'
import { closeDatabase, getDatabase } from './db/index.ts'
import { createSafeStorageKeyCrypto } from './keyStoreWire.ts'
import { registerGateway } from './ipc/gateway.ts'
import { setKeyCrypto } from './services/apihub/keyStore.ts'
import { injectAutoStart } from './autostartWire.ts'
import { initTray, refreshTraySummary, destroyTray } from './trayWire.ts'
import type { TrayDeps } from './trayWire.ts'
import {
  destroyOverlay,
  initOverlay,
  setFocusMainWindowApplier,
  setOpenExternalApplier,
  setOverlayEnabled,
} from './overlayWire.ts'
import { shutdownAgentControlRuntime } from './services/agentControl/agentControlService.ts'

/** Windows 通知/托盘归属前置（AC0 审计：现缺，docs/12 §10）。 */
const APP_USER_MODEL_ID = 'com.devhub.app'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isDevMode(): boolean {
  return typeof process.env.ELECTRON_RENDERER_URL === 'string' && process.env.ELECTRON_RENDERER_URL.length > 0
}

/**
 * docs/12 §10 托盘生命周期标志：before-quit 置 true 后，窗口 close 事件不再
 * preventDefault（真退出放行），托盘「退出 DevHub」同样经 quitApp() 走该语义。
 */
let isQuitting = false

/**
 * AC9 退出滞留修复：退出保证状态机阶段（idle → tearing-down → quitting →
 * force-exit）。转换只由 core/quitGuarantee.ts 裁决，本文件负责副作用
 * （preventDefault / 定时器 / app.quit / app.exit）。
 */
let quitStage: QuitStage = 'idle'
let hardCapTimer: NodeJS.Timeout | null = null
let exitWatchdog: NodeJS.Timeout | null = null

/** 托盘 2s 摘要刷新 interval（退出路径必须清除，否则事件循环滞留，AC9）。 */
let trayRefreshTimer: NodeJS.Timeout | null = null

let mainWindow: BrowserWindow | null = null

/**
 * hash 路由（docs/22 §4.2）：'agents'（托盘「查看 Agent 摘要」先例）/ 'overlay'
 * （CP2 悬浮窗 → App 分流 OverlayApp）/ `contest:<id>`（悬浮窗卡片 → 主窗口比赛
 * 详情，App.tsx initialTarget 解析）。undefined = 默认首页。
 */
type RendererHash = 'agents' | 'overlay' | `contest:${number}`

function loadRenderer(win: BrowserWindow, hash?: RendererHash): void {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (isDevMode() && typeof devUrl === 'string') {
    win.loadURL(hash === undefined ? devUrl : `${devUrl}#${hash}`).catch((err) =>
      logger.error(`renderer loadURL failed: ${errorMessage(err)}`),
    )
    // 默认不开 DevTools（验收截图干净）；显式 DEVHUB_OPEN_DEVTOOLS=1 才打开
    if (hash === undefined && process.env.DEVHUB_OPEN_DEVTOOLS === '1') {
      win.webContents.openDevTools({ mode: 'right', activate: false })
    }
  } else {
    win
      .loadFile(join(__dirname, '../renderer/index.html'), hash === undefined ? undefined : { hash })
      .catch((err) => logger.error(`renderer loadFile failed: ${errorMessage(err)}`))
  }
}

/**
 * 主窗口：1280×800（min 1024×680）、深色底、无系统菜单栏（开发者工具风格）。
 * webPreferences 满足约束 #18：sandbox: true、contextIsolation: true、
 * nodeIntegration: false；preload 是唯一桥（仅暴露 devhub.invoke）。
 * close 事件：!isQuitting → preventDefault + hide（托盘常驻，docs/12 §10）。
 */
function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 680,
    title: 'DevHub',
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // 托盘常驻：关窗 = 隐藏窗口，监控/Gateway 持续运行（docs/12 §10；AC5 退出唯一
  // 入口 = 托盘「退出 DevHub」/ before-quit，isQuitting 置位后本分支放行）
  win.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      win.hide()
    }
  })

  loadRenderer(win)
  return win
}

/**
 * 显示主窗口（最小化先还原；隐藏→show）。second-instance 与托盘共用。
 * CP2 单实例收紧（docs/22 §4.6，审计风险 1）：显式判空 + 销毁态检查，不再
 * `getAllWindows()[0]` 兜底——悬浮窗存在时"打开 DevHub"永不误选悬浮窗
 * （不得对悬浮窗做 show/focus/loadRenderer）。
 */
function currentMainWindow(): BrowserWindow | null {
  return mainWindow !== null && !mainWindow.isDestroyed() ? mainWindow : null
}

function showMainWindow(): void {
  const win = currentMainWindow()
  if (win !== null) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
}

/**
 * second-instance：把已有实例的窗口拉到前台（Windows 应用单实例语义）。
 * docs/12 §10 扩展：窗口隐藏（关窗常驻态）→ show() + focus() 恢复。
 * CP2 收紧：只指向主窗口（getAllWindows()[0] 兜底已移除，防误选悬浮窗）。
 */
function focusExistingWindow(): void {
  const win = currentMainWindow()
  if (win !== null) {
    if (win.isMinimized()) win.restore()
    if (!win.isVisible()) win.show()
    win.focus()
    logger.info('second-instance: existing window shown/focused')
  }
}

/** 托盘「查看 Agent 摘要」：显示主窗口并导航到 Agents 视图（#/agents hash 重载）。 */
function showMainWindowNavigateAgents(): void {
  const win = currentMainWindow()
  if (win === null) return
  if (win.isMinimized()) win.restore()
  loadRenderer(win, 'agents')
  win.show()
  win.focus()
}

/**
 * 悬浮窗卡片 / 通知入口（CP2，docs/22 §4.5）：显示主窗口并导航到比赛详情
 * （#contest:<id> hash 重载，App.tsx initialTarget 解析进比赛视图详情态）。
 * 经 overlayWire.setFocusMainWindowApplier 注册为 contestpin:openInMain 生产实现。
 */
function showMainWindowNavigateContest(contestId: number): void {
  const win = currentMainWindow()
  if (win === null) return
  if (win.isMinimized()) win.restore()
  loadRenderer(win, `contest:${contestId}`)
  win.show()
  win.focus()
}

/**
 * 退出收尾（docs/12 §10 收尾顺序，幂等且带硬上限）：
 * 撤 UI 常驻句柄（AC9：托盘 destroy + 清 2s 刷新 interval——先于一切异步收尾，
 * 防止 ref'd 定时器拖住主进程事件循环/惰性重开已关闭的 DB）→ cancelAll 监控 →
 * [关 WS → 关 Gateway] → 托管子进程收尾（provider.dispose）→ closeDatabase
 * （WAL 落盘）。任一步失败不阻断后续步骤。
 * CP2：destroyOverlay 挂在最前（与 trayRefreshTimer 并列、先于 closeDatabase）——
 * overlayWire 内部 ref'd 防抖定时器同样会经 getDatabase() 惰性重开已关闭 DB，
 * 必须最先清；destroy 同步非阻塞，5s 硬上限内完成。
 */
async function runQuitTeardown(): Promise<void> {
  destroyOverlay()
  if (trayRefreshTimer !== null) {
    clearInterval(trayRefreshTimer)
    trayRefreshTimer = null
  }
  destroyTray()
  logger.info('quit teardown: overlay destroyed + tray destroyed + 2s refresh interval cleared (AC9 exit fix)')
  try {
    await shutdownAgentControlRuntime()
    logger.info('quit teardown: agent control runtime shut down (monitors cancelled, providers disposed)')
  } catch (err) {
    logger.warn(`quit teardown: agent control shutdown failed: ${errorMessage(err)}`)
  }
  try {
    closeDatabase()
    logger.info('quit teardown: database closed (WAL checkpointed)')
  } catch (err) {
    logger.warn(`quit teardown: closeDatabase failed: ${errorMessage(err)}`)
  }
}

/**
 * 执行状态机指令（副作用收口）：清/挂定时器、再次 quit、强退兜底。
 * 看门狗 unref：quit 正常完成时它不得反过来拖住事件循环；只有进程真的滞留时
 * 它才会到点触发 app.exit(0)。
 */
function applyQuitAction(action: QuitAction): void {
  quitStage = action.nextStage
  if (action.clearHardCap && hardCapTimer !== null) {
    clearTimeout(hardCapTimer)
    hardCapTimer = null
  }
  if (action.armWatchdog && exitWatchdog === null) {
    const timer = setTimeout(() => {
      exitWatchdog = null
      applyQuitAction(quitTransition(quitStage, 'watchdog-elapsed'))
    }, QUIT_EXIT_WATCHDOG_MS)
    timer.unref()
    exitWatchdog = timer
  }
  if (action.quitAgain) app.quit()
  if (action.forceExit) {
    logger.warn(
      `quit exit guarantee: process still alive after quit — forcing app.exit(0) (AC9 lingering-process fix, watchdog=${QUIT_EXIT_WATCHDOG_MS}ms)`,
    )
    destroyTray()
    app.exit(0)
  }
}

/**
 * before-quit 入口（状态机接线）：首次进入 preventDefault 并执行有序收尾（UI
 * 常驻句柄先撤），收尾完成后再次 app.quit() 并挂退出看门狗；isQuitting 已置位 →
 * close 事件放行 → quit 完成。双守卫：5s 硬上限守收尾（挂死照常发起 quit）、
 * 3s 看门狗守最终退出（宽限期到进程仍在 → app.exit(0) 强退，杜绝滞留）。
 */
function requestQuit(event: Electron.Event): void {
  isQuitting = true
  const action = quitTransition(quitStage, 'first-before-quit')
  if (!action.preventDefault) return // 已在退出流程：本次 quit 放行
  event.preventDefault()
  applyQuitAction(action) // → tearing-down
  hardCapTimer = setTimeout(() => {
    hardCapTimer = null
    logger.warn('quit teardown timed out — forcing quit (hard cap)')
    applyQuitAction(quitTransition(quitStage, 'hard-cap-elapsed'))
  }, QUIT_TEARDOWN_HARD_CAP_MS)
  void runQuitTeardown()
    .catch((err) => logger.warn(`quit teardown rejected: ${errorMessage(err)}`))
    .then(() => {
      applyQuitAction(quitTransition(quitStage, 'teardown-completed'))
    })
}

function bootstrapMainProcess(): void {
  // 主进程级 catch：记录日志、不崩（Windows 常驻控制台应用语义）
  process.on('uncaughtException', (err) => {
    logger.error(`uncaughtException: ${err.stack ?? err.message}`)
  })
  process.on('unhandledRejection', (reason) => {
    const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
    logger.error(`unhandledRejection: ${detail}`)
  })

  app.on('second-instance', focusExistingWindow)

  // 托盘常驻（docs/12 §10）：window-all-closed 不再 quit——关窗 = 隐藏，
  // 全部窗口关闭（如关闭前窗口从未 show）时应用继续在托盘运行
  app.on('window-all-closed', () => {
    logger.info('window-all-closed: staying resident in tray (docs/12 §10)')
  })

  // 优雅退出（docs/12 §10 收尾顺序）：isQuitting 置位 + 首次 preventDefault +
  // 有序收尾（幂等），收尾完成后二次 app.quit() 放行
  app.on('before-quit', (event) => {
    requestQuit(event)
  })

  void app
    .whenReady()
    .then(() => {
      // Windows 通知/托盘归属前置（docs/12 §10：whenReady 首行）
      app.setAppUserModelId(APP_USER_MODEL_ID)

      // 去默认菜单栏（开发者工具风格）；dev 需要时经 DEVHUB_OPEN_DEVTOOLS=1 开 DevTools
      Menu.setApplicationMenu(null)

      // 此刻 app.getPath('userData') 已生效：SQLite 落 userData
      // （DEVHUB_HOME 环境变量仍可覆盖，见 core/paths.ts 三级策略）
      getDatabase()

      // ApiHub 密钥加密注入（docs/09 §6.1）：services 层只见 KeyCrypto 接口，
      // safeStorage 不可用时其实现返回结构化错误（档案标记不可用，绝不明文落库）
      setKeyCrypto(createSafeStorageKeyCrypto())
      logger.info('apihub key crypto: electron safeStorage injected')

      // 自启注入 + 按现值应用一次（docs/12 §10：login_autostart 驱动 setLoginItemSettings）
      injectAutoStart()

      registerGateway({ appVersion: app.getVersion() })

      // AC6 Remote Gateway 启动（docs/14 §B / docs/12 §2/§9）：按 settings
      // gateway_enabled 真值收敛监听（默认 0 → 零监听；1 → 绑 127.0.0.1，
      // gateway_port 占用则 8747–8755 顺延）。失败不阻断应用启动，
      // 错误经 agents:gatewayStatus.lastError 结构化可见。
      void import('./services/agentControl/gateway/httpServer.ts')
        .then((gw) => gw.applyGatewaySettings({ appName: 'devhub', appVersion: app.getVersion() }))
        .catch((err) => logger.error(`gateway startup failed: ${errorMessage(err)}`))

      // M2-R1 ECS Relay client 启动（docs/19 §4.2 常驻形态：随 Main 进程）：按
      // settings relay_enabled/relay_endpoint + 凭据文件真值收敛（disabled/
      // unregistered/misconfigured 结构化投影零连接）。失败不阻断应用启动，
      // 错误经 agents:gatewayStatus.relay.lastError 结构化可见。
      void import('./services/agentControl/relayClient/index.ts')
        .then((relay) => relay.applyRelaySettings())
        .catch((err) => logger.error(`relay client startup failed: ${errorMessage(err)}`))

      mainWindow = createWindow()

      // 托盘常驻（docs/12 §10）：创建 + 2s 节奏刷新 tooltip 摘要（活跃会话计数）
      const trayDeps: TrayDeps = {
        showMainWindow: () => showMainWindow(),
        showMainWindowNavigateAgents: () => showMainWindowNavigateAgents(),
        quitApp: () => app.quit(), // before-quit → requestQuit（有序收尾）
        // CP2 悬浮窗开关（docs/22 §4.5）：settings 持久化经 overlayStateService +
        // 窗口创建/show 或 hide 即时生效（与 contestpin:overlaySetEnabled 同一收敛点）
        setOverlayEnabled: (enabled) => setOverlayEnabled(enabled),
      }
      initTray(trayDeps)
      // 句柄必须可清（AC9 滞留根因之一）：退出路径 runQuitTeardown 里 clearInterval
      trayRefreshTimer = setInterval(() => refreshTraySummary(trayDeps), 2000)

      // CP2 悬浮窗（docs/22 §4）：生产 applier 注册（默认浏览器/主窗口导航）→
      // initOverlay 按 settings contestpin_overlay_enabled 决定是否创建悬浮窗
      setOpenExternalApplier((url) => {
        void shell.openExternal(url).catch((err) =>
          logger.error(`shell.openExternal failed: ${errorMessage(err)}`),
        )
      })
      setFocusMainWindowApplier((contestId) => showMainWindowNavigateContest(contestId))
      initOverlay({
        isQuitting: () => isQuitting,
        loadPage: (win) => loadRenderer(win, 'overlay'),
      })
    })
    .catch((err) => {
      logger.error(`startup failed: ${errorMessage(err)}`)
    })
}

// 单实例锁：抢不到锁说明已有 DevHub 实例在跑，本进程直接退出，
// 由既有实例接收 second-instance 事件完成聚焦（隐藏窗口时 show + focus）
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  bootstrapMainProcess()
}
