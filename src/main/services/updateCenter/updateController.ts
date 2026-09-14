/**
 * updateController.ts — App 自更新状态机（X-U 批，docs/briefs/xu-updater.md §1）。
 *
 * 纯逻辑核心：electron-updater 的事件/promise 面被折进 UpdateControllerActions
 * 门面（生产由 updaterWire.ts 接线，smoke 注 fake 零网络直测）。职责：
 *   - dev 禁用门：isPackaged=false → supported=false，全部动作结构化拒绝、
 *     门面零触达（全链禁用，约束同 handlers NOT_AVAILABLE 风格）；
 *   - 检查三态：最新（not-available，含 feed 版本 ≤ 当前——降级一律按最新处理，
 *     绝不降级）/ 发现新版（available + 人话说明）/ 失败（error 结构化，零弹窗）；
 *   - 静默宣布：启动后延迟检查发现新版 → silentAnnounced=true（renderer 全局
 *     toast 一次的依据；手动检查不置位）；
 *   - 下载进度 → downloaded；安装受理仅 downloaded 态（用户确认前置由 renderer
 *     UI 保证，本层再做一道状态门）；
 *   - 幂等容忍：重复失败/重复完成回填为 no-op（electron-updater 的 promise 拒绝
 *     与 'error' 事件会双路上报，控制器必须幂等防抖）。
 *
 * 纯 Node 模块：零 electron / 零 electron-updater import（smoke 直测）。
 */

import { isNewerVersion, projectReleaseNotes } from './updateFeed.ts'
import type { UpdateDownloadProgress, UpdatePhase, UpdateStatusView } from '../../../shared/types.ts'

/** 动作受理结果（handlers 层折叠为 ServiceError envelope 的稳定 code）。 */
export type UpdateActionResult = { ok: true } | { ok: false; code: string; message: string }

/** electron-updater 门面（生产 = updaterWire 接线；smoke = fake，零网络）。 */
export interface UpdateControllerActions {
  /** 发起检查（kind 仅日志区分；async 结果经 checkSucceeded/operationFailed 回填）。 */
  check(kind: 'silent' | 'manual'): void
  /** 发起下载（结果经 downloadSucceeded/operationFailed 回填；进度经 progressChanged）。 */
  download(): void
  /** 退出并安装（quitAndInstall；框架内部调度属 electron-updater 固有行为）。 */
  install(): void
}

export interface UpdateControllerDeps {
  /** 编译期门（app.isPackaged；smoke 注固定值）。 */
  isPackaged: boolean
  /** 当前运行版本（app.getVersion()）。 */
  currentVersion: string
  /** 门面（dev 禁用态可缺省——本就零触达）。 */
  actions?: UpdateControllerActions
  /** unix 秒时间源（缺省 Date.now/1000；smoke 注固定钟）。 */
  nowSec?(): number
  /** 结构化日志（缺省 no-op；生产接 core/logger）。 */
  log?(message: string): void
}

export interface UpdateController {
  readonly supported: boolean
  /** 设置卡状态快照（updates:status 投影；全字段可渲染，零抛异常面）。 */
  getStatus(): UpdateStatusView
  /** 启动后延迟静默检查（updaterWire 60s 定时回调；isQuitting 由 wire 判定）。 */
  startSilentCheck(): UpdateActionResult
  /** 手动检查（设置卡「检查更新」按钮）。 */
  startManualCheck(): UpdateActionResult
  /** 检查结果回填：null = 最新（含降级防护）；有值 = 发现新版（须比当前新）。 */
  checkSucceeded(info: { version: string; releaseNotes: unknown } | null): void
  /** 下载进度回填（仅 downloading 态采纳，乱序迟到回填忽略）。 */
  progressChanged(progress: UpdateDownloadProgress): void
  /** 下载完成回填。 */
  downloadSucceeded(): void
  /**
   * 失败回填（检查/下载共用，按当前 phase 路由；双路上报幂等——已处 error 态
   * 时保留首个结构化错误）。code = UPDATE_CHECK_FAILED / UPDATE_DOWNLOAD_FAILED。
   */
  operationFailed(code: string, message: string): void
  /** 下载受理（仅 available 态；renderer「下载并安装」确认钮已前置）。 */
  startDownload(): UpdateActionResult
  /** 安装受理（仅 downloaded 态；renderer 确认弹窗已前置 → quitAndInstall）。 */
  installConfirmed(): UpdateActionResult
}

/** 允许发起新检查的阶段（checking/downloading/installing 进行中一律拒绝）。 */
const CHECKABLE_PHASES: readonly UpdatePhase[] = ['idle', 'available', 'not-available', 'downloaded', 'error']

export function createUpdateController(deps: UpdateControllerDeps): UpdateController {
  const nowSec = deps.nowSec ?? ((): number => Math.floor(Date.now() / 1000))
  const log = deps.log ?? ((): void => {})

  let phase: UpdatePhase = 'idle'
  let availableVersion: string | null = null
  let releaseNotes: string | null = null
  let downloadProgress: UpdateDownloadProgress | null = null
  let error: { code: string; message: string } | null = null
  let silentAnnounced = false
  let lastCheckedAt: number | null = null
  /** 最近一次检查的发起形态（silent → 发现新版时置 silentAnnounced）。 */
  let lastCheckKind: 'silent' | 'manual' | null = null
  /** 静默检查受理过即置位（启动后台检查至多一次，零打扰纪律）。 */
  let silentCheckStarted = false
  /** 幂等护栏：error 态后忽略迟到同相位失败回填（首错保留）。 */
  let failureSettled = false

  const refused = (code: string, message: string): UpdateActionResult => ({ ok: false, code, message })

  function beginCheck(kind: 'silent' | 'manual'): UpdateActionResult {
    if (!deps.isPackaged || deps.actions === undefined) {
      return refused('UPDATE_UNSUPPORTED', '开发模式（app.isPackaged=false）下更新链路全链禁用')
    }
    if (!CHECKABLE_PHASES.includes(phase)) {
      return refused('UPDATE_BUSY', `当前阶段 ${phase} 不受理新检查`)
    }
    lastCheckKind = kind
    phase = 'checking'
    error = null
    downloadProgress = null
    deps.actions.check(kind)
    return { ok: true }
  }

  const controller: UpdateController = {
    supported: deps.isPackaged,

    getStatus(): UpdateStatusView {
      return {
        supported: deps.isPackaged,
        currentVersion: deps.currentVersion,
        phase,
        availableVersion,
        releaseNotes,
        downloadProgress,
        error,
        silentAnnounced,
        lastCheckedAt,
      }
    },

    startSilentCheck(): UpdateActionResult {
      if (silentCheckStarted) {
        // 静默检查启动后至多一次（无论结果如何不再重复发起，零打扰纪律；
        // wire 侧定时器本就只挂一次，此处是状态机层第二道护栏）
        return refused('UPDATE_SILENT_ALREADY_DONE', '静默检查已完成或已受理，不再重复发起')
      }
      const result = beginCheck('silent')
      if (result.ok) silentCheckStarted = true
      return result
    },

    startManualCheck(): UpdateActionResult {
      return beginCheck('manual')
    },

    checkSucceeded(info): void {
      if (phase !== 'checking') return // 迟到回填（如取消后的旧 promise）→ 忽略
      lastCheckedAt = nowSec()
      if (info === null || !isNewerVersion(deps.currentVersion, info.version)) {
        // 最新（feed 版本 ≤ 当前 = 降级/平版，一律按最新处理，绝不降级安装）
        phase = 'not-available'
        availableVersion = null
        releaseNotes = null
        log(`update check: up to date (current=${deps.currentVersion}, kind=${String(lastCheckKind)})`)
        return
      }
      phase = 'available'
      availableVersion = info.version
      releaseNotes = projectReleaseNotes(info.releaseNotes)
      if (lastCheckKind === 'silent') {
        silentAnnounced = true
        log(`update check: silent check found new version ${info.version} (announce only, never auto-download)`)
      } else {
        log(`update check: manual check found new version ${info.version}`)
      }
    },

    progressChanged(progress): void {
      if (phase !== 'downloading') return // 仅下载中采纳（乱序/迟到忽略）
      downloadProgress = {
        percent: Number.isFinite(progress.percent) ? progress.percent : 0,
        transferredBytes: Number.isFinite(progress.transferredBytes) ? progress.transferredBytes : 0,
        totalBytes: Number.isFinite(progress.totalBytes) ? progress.totalBytes : 0,
      }
    },

    downloadSucceeded(): void {
      if (phase !== 'downloading') return // 幂等：双路回填/迟到回填忽略
      phase = 'downloaded'
      log(`update download: finished (${String(availableVersion)})`)
    },

    operationFailed(code, message): void {
      if (phase !== 'checking' && phase !== 'downloading') return // 幂等 + 迟到忽略
      if (failureSettled) return // 首错保留（promise 拒绝与 error 事件双路上报防抖）
      failureSettled = true
      error = { code, message }
      phase = 'error'
      downloadProgress = null
      log(`update failure: ${code}: ${message}`)
    },

    startDownload(): UpdateActionResult {
      if (!deps.isPackaged || deps.actions === undefined) {
        return refused('UPDATE_UNSUPPORTED', '开发模式（app.isPackaged=false）下更新链路全链禁用')
      }
      if (phase !== 'available' || availableVersion === null) {
        return refused('UPDATE_NOT_DOWNLOADABLE', `当前阶段 ${phase} 无可下载更新（须先检查发现新版）`)
      }
      phase = 'downloading'
      downloadProgress = { percent: 0, transferredBytes: 0, totalBytes: 0 }
      error = null
      failureSettled = false
      deps.actions.download()
      return { ok: true }
    },

    installConfirmed(): UpdateActionResult {
      if (!deps.isPackaged || deps.actions === undefined) {
        return refused('UPDATE_UNSUPPORTED', '开发模式（app.isPackaged=false）下更新链路全链禁用')
      }
      if (phase !== 'downloaded') {
        return refused('UPDATE_NOT_INSTALLED_READY', `当前阶段 ${phase} 不受理安装（须下载完成后确认）`)
      }
      phase = 'installing'
      deps.actions.install()
      return { ok: true }
    },
  }

  return controller
}
