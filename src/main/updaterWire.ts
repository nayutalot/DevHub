/**
 * updaterWire.ts — electron-updater 生产接线（X-U 批，docs/briefs/xu-updater.md）。
 *
 * 独立 wire 模块（index.ts 薄挂一行 initUpdaterWire，与 notifyWire/trayWire 同
 * 模式），把 electron-updater 的事件/promise 面折叠进纯状态机
 * updateController（smoke 全 fake 直测，本文件不被任何测试加载）。
 *
 * 红线（任务书 §1/§2 逐条）：
 *   - **dev 全链禁用**：app.isPackaged=false → 构造 supported=false 的禁用控制
 *     器（设置卡如实显示禁用说明），绝不 import electron-updater、绝不挂定时
 *     器、零网络零文件系统；
 *   - **编译期 feed 常量**：与 ZCODE_LINK_ORIGIN 同型（裸 const、零凭据、零
 *     env、零 settings 覆盖面）——既有 relay 基址（wss://59.110.149.11 的
 *     host 腿，REST 面 https）+ `/updates/` 路径（ECS caddy 静态 generic feed）；
 *   - **静默检查**：启动后延迟 60s（unref 定时器——绝不拖住事件循环阻塞退出，
 *     AC9 同款纪律）静默检查一次；仅发现新版时置 silentAnnounced（renderer 全
 *     局 toast 一次），绝不自动下载（autoDownload=false）；
 *   - **绝不静默重启**：autoInstallOnAppQuit=false——退出链永不携带安装；安装
 *     只能由用户在设置卡「下载并安装」→ 下载完成 → 确认弹窗 → quitAndInstall
 *     三段确认后发生；
 *   - **退出链零触碰**：本模块不挂 before-quit、不改 quitTransition 状态机；
 *     quitAndInstall 触发的 app.quit() 走既有 before-quit 有序收尾（electron-updater
 *     内部安装器调度属框架固有行为，注记即可）；失败只结构化日志（core/logger），
 *     绝不弹窗绝不打断启动/退出链。
 */

import { app } from 'electron'
import { logger } from './core/logger.ts'
import { createUpdateController } from './services/updateCenter/updateController.ts'
import type { UpdateControllerActions } from './services/updateCenter/updateController.ts'
import { setUpdateController } from './services/updateCenter/updateRegistry.ts'

/**
 * 更新 feed 编译期常量（ZCODE_LINK_ORIGIN 同型）：既有 relay 基址 + `/updates/`。
 * - relay 基址 = `https://59.110.149.11`（docs/19 §4.7/§10 REST 面，与
 *   relay_endpoint 的 wss host 腿同源；443 TLS 到 caddy 生产已在役）；
 * - feed 形态 = ECS caddy 静态 generic feed（latest.yml + 安装包，装配脚本
 *   scripts/build-updates-feed.mjs，X11 收官批部署消费）；
 * - 零凭据零 token（私有 GitHub provider 因需客户端 token 已否决，任务书 §0）。
 */
export const DEVHUB_UPDATE_FEED_URL = 'https://59.110.149.11/updates/'

/** 启动后静默检查延迟（任务书 §1 #2：60s；unref 定时器不阻塞退出链）。 */
export const UPDATE_SILENT_CHECK_DELAY_MS = 60_000

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export interface UpdaterWireDeps {
  /** 退出态探测（index.ts 的 isQuitting 标志原样透传；定时器到点时为 true → 跳过）。 */
  isQuitting(): boolean
}

/**
 * 注册更新控制器并（仅打包态）接线 electron-updater + 挂 60s 静默检查定时器。
 * 同步、非阻塞、绝不抛异常——任何接线失败折叠为结构化日志后返回，绝不阻塞
 * 启动链（调用点在 app.whenReady 内，失败不影响其余初始化）。
 */
export function initUpdaterWire(deps: UpdaterWireDeps): void {
  try {
    const currentVersion = app.getVersion()

    // dev 禁用门（任务书 §1 #2：app.isPackaged=false 全链禁用）：禁用控制器
    // 照常注册（设置卡如实显示 supported=false），但零 electron-updater、零定时器
    if (!app.isPackaged) {
      setUpdateController(
        createUpdateController({ isPackaged: false, currentVersion, log: (m) => logger.info(`updater: ${m}`) }),
      )
      logger.info('updater wire: dev/unpackaged mode — update chain fully disabled (app.isPackaged=false)')
      return
    }

    // 控制器先行注册（updates:* IPC 立即可用；electron-updater 动态 import 到位
    // 前 action 门面为空 → beginCheck 结构化拒绝 UPDATE_UNSUPPORTED 防早触发）
    let actions: UpdateControllerActions | undefined
    const controller = createUpdateController({
      isPackaged: true,
      currentVersion,
      get actions(): UpdateControllerActions | undefined {
        return actions
      },
      log: (m) => logger.info(`updater: ${m}`),
    })
    setUpdateController(controller)

    void import('electron-updater')
      .then(({ autoUpdater }) => {
        // 三重「绝不」配置（任务书红线）：绝不自动下载 / 退出链绝不携带安装 /
        // 不收预发布版
        autoUpdater.autoDownload = false
        autoUpdater.autoInstallOnAppQuit = false
        autoUpdater.allowPrerelease = false
        autoUpdater.autoRunAppAfterInstall = true
        autoUpdater.setFeedURL({ provider: 'generic', url: DEVHUB_UPDATE_FEED_URL })
        // electron-updater 自身日志路由进结构化 logger（零打扰：只落日志，不弹窗）
        autoUpdater.logger = {
          info: (m) => logger.info(`electron-updater: ${String(m)}`),
          warn: (m) => logger.warn(`electron-updater: ${String(m)}`),
          error: (m) => logger.error(`electron-updater: ${String(m)}`),
        }

        // 下载进度（唯一走事件的回填；检查/下载的成败走 promise，见下）
        autoUpdater.on('download-progress', (progress) => {
          controller.progressChanged({
            percent: progress.percent,
            transferredBytes: progress.transferred,
            totalBytes: progress.total,
          })
        })
        // 'error' 事件 = promise 拒绝的镜像（electron-updater 双路上报）：这里只
        // 落日志，状态翻转统一由 promise 拒绝经 operationFailed 幂等处理
        autoUpdater.on('error', (err) => {
          logger.warn(`electron-updater error event: ${errorMessage(err)}`)
        })

        actions = {
          check: (kind) => {
            void autoUpdater
              .checkForUpdates()
              .then((result) => {
                if (result === null) {
                  controller.checkSucceeded(null)
                  return
                }
                // isUpdateAvailable 已含 electron-updater 的降级门；控制器内
                // isNewerVersion 再做一道同判护栏（feed 脏数据双保险）
                controller.checkSucceeded(
                  result.isUpdateAvailable
                    ? { version: result.updateInfo.version, releaseNotes: result.updateInfo.releaseNotes }
                    : null,
                )
              })
              .catch((err) => controller.operationFailed('UPDATE_CHECK_FAILED', `${kind}: ${errorMessage(err)}`))
          },
          download: () => {
            void autoUpdater
              .downloadUpdate()
              .then(() => controller.downloadSucceeded())
              .catch((err) => controller.operationFailed('UPDATE_DOWNLOAD_FAILED', errorMessage(err)))
          },
          install: () => {
            // 用户三段确认后的唯一安装入口：quitAndInstall 先派生 detached 安装
            // 进程再 app.quit()——quit 走既有 before-quit 有序收尾（quitTransition
            // 零触碰）；isSilent=false 保留 NSIS 安装向导，autoRunAppAfterInstall
            // 已置 true（装后自启）。框架内部安装器调度属 electron-updater 固有行为
            autoUpdater.quitAndInstall(false)
          },
        }

        // 启动后延迟 60s 静默检查一次（unref：绝不拖住事件循环阻塞退出链，AC9
        // 同款纪律；到点时若已处退出流程则跳过——isQuitting 由 index.ts 透传）
        const timer = setTimeout(() => {
          if (deps.isQuitting()) {
            logger.info('updater wire: silent check skipped (app is quitting)')
            return
          }
          const result = controller.startSilentCheck()
          if (!result.ok) logger.info(`updater wire: silent check not started: ${result.code}`)
        }, UPDATE_SILENT_CHECK_DELAY_MS)
        timer.unref()

        logger.info(`updater wire: electron-updater wired (feed=${DEVHUB_UPDATE_FEED_URL}, silent check in ${UPDATE_SILENT_CHECK_DELAY_MS}ms, autoDownload=false)`)
      })
      .catch((err) => {
        // electron-updater 动态 import 失败（理论不达：生产依赖随 asar 分发）——
        // 结构化日志，零打扰，绝不阻塞启动链
        logger.error(`updater wire: electron-updater import failed: ${errorMessage(err)}`)
      })
  } catch (err) {
    logger.error(`updater wire: init failed (non-blocking): ${errorMessage(err)}`)
  }
}
