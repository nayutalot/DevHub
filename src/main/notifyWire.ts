/**
 * notifyWire.ts — ContestPin 提醒的 main 侧 electron 胶水（CP4 批次，docs/22 §7）。
 *
 * 全仓首个 Electron Notification 使用位（electron import 白名单新增本文件；
 * overlayWire.ts 头注同款纪律：窗口/系统事件能力只在 wire 层出现，services 保持
 * electron-free）。AppUserModelID 已在 index.ts:41 设置（Windows 通知归属）。
 *
 * 职责（任务书 §1.2）：
 *  - 注册 reminderEngine.setNotifyApplier 生产实现：Notification.isSupported 守卫
 *    （不支持/异常 → 记日志降级 in-app 记录，绝不抛——引擎 fireOnce 已按 degraded
 *    统计）；点击 → 复用 CP2 的主窗口导航 contest:<id>（openInMain 同款）。
 *  - 调度：模块级 setInterval 60s 桶扫（unref；句柄可清——trayRefreshTimer 先例，
 *    runQuitTeardown 最前经 shutdownNotifyWire 清理，防 ref'd 定时器拖住事件循环/
 *    惰性重开已关闭 DB）；powerMonitor 'resume' / 'shutdown' / 'system-clock-changed'
 *    （Electron 44 事件名以实机为准，注册失败不阻断）触发立即补发重扫
 *    （runReminderScan catchup 模式，默认 48h 窗口；幂等去重根在
 *    contest_reminder_log UNIQUE(reminder_id, fire_key)）。
 *  - 关机/退出后不承诺实时提醒（charter §八原文）：teardown 只清句柄不补偿。
 */

import { Notification, powerMonitor } from 'electron'
import { logger } from './core/logger.ts'
import { runReminderScan, setNotifyApplier, type ReminderFireNotification } from './services/contestpin/reminderEngine.ts'

/** 60s 桶扫节拍（任务书 §1.2 #5；分钟级提醒精度足够——不追求秒级实时）。 */
const SCAN_INTERVAL_MS = 60_000

/** 模块级调度句柄（runQuitTeardown 最前清理；trayRefreshTimer 先例）。 */
let scanTimer: NodeJS.Timeout | null = null
/** powerMonitor 监听是否已挂（resume/shutdown/system-clock-changed 三事件）。 */
let powerWatchAttached = false

/**
 * 'system-clock-changed' 在 Electron 44.1.1 的 electron.d.ts 中未收录（任务书
 * 「事件名以实测为准」）：经 EventEmitter 接口防御性注册——运行期若真无此事件
 * 则静默不触发（无害），实机验证清单覆盖「时钟变化重扫」一项。
 */
type PowerEventName = 'resume' | 'shutdown' | 'system-clock-changed'
const POWER_EVENTS: readonly PowerEventName[] = ['resume', 'shutdown', 'system-clock-changed']

/** resume/时钟变化后的立即补发重扫（异常吞在 runReminderScan 内，这里不再包一层）。 */
function rescanForCatchUp(source: string): void {
  const stats = runReminderScan({ mode: 'catchup' })
  if (stats.due > 0 || stats.skippedOutsideWindow > 0) {
    logger.info(`notify wire: catchup rescan after ${source}: due=${stats.due} fired=${stats.fired} skipped=${stats.skippedOutsideWindow}`)
  }
}

/** powerMonitor 事件注册（事件名以实机为准——未知事件名静默不触发，无害）。 */
function attachPowerWatch(): void {
  if (powerWatchAttached) return
  powerWatchAttached = true
  try {
    const emitter = powerMonitor as unknown as NodeJS.EventEmitter
    for (const event of POWER_EVENTS) {
      emitter.on(event, () => rescanForCatchUp(event))
    }
  } catch (err) {
    logger.warn(`notify wire: powerMonitor attach failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function detachPowerWatch(): void {
  if (!powerWatchAttached) return
  powerWatchAttached = false
  try {
    const emitter = powerMonitor as unknown as NodeJS.EventEmitter
    for (const event of POWER_EVENTS) {
      emitter.removeAllListeners(event)
    }
  } catch {
    // teardown 路径：清理失败不阻断退出
  }
}

/** 生产通知实现：windows 通道触发时的系统通知；点击导航 contest:<id>。 */
function showNotification(n: ReminderFireNotification, navigateToContest: (contestId: number) => void): void {
  if (!Notification.isSupported()) {
    // 系统禁用/无通知能力 → 降级 in-app 记录（账本行已写），不抛
    logger.info(`notify wire: Notification unsupported — reminder ${n.reminderId} degrades to in-app record`)
    return
  }
  const notif = new Notification({
    title: n.title,
    body: n.body,
    silent: false,
  })
  notif.on('click', () => {
    try {
      navigateToContest(n.contestId)
    } catch (err) {
      logger.error(`notify click navigate failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  })
  notif.show()
}

/**
 * whenReady 后由 index.ts 调用一次（installContestpinWire 同位）：注册生产
 * notifyApplier → 启动补发重扫（上次退出/关机期间的错过按 48h 窗口收敛）→
 * 60s 桶扫（unref）→ powerMonitor 事件挂接。
 */
export function initNotifyWire(deps: {
  /** 通知点击导航（index.ts showMainWindowNavigateContest，openInMain 同款）。 */
  navigateToContest: (contestId: number) => void
}): void {
  setNotifyApplier((n) => showNotification(n, deps.navigateToContest))

  // 启动补发：先扫一轮（引擎内部吞异常），再挂常驻节拍
  rescanForCatchUp('startup')

  if (scanTimer === null) {
    const timer = setInterval(() => {
      runReminderScan({ mode: 'tick' })
    }, SCAN_INTERVAL_MS)
    timer.unref() // 不阻止进程自然退出（AC9 语义）；teardown 仍显式清
    scanTimer = timer
  }
  attachPowerWatch()
  logger.info('notify wire initialized (60s scan tick + powerMonitor resume/clock watch, applier registered)')
}

/**
 * 退出清理（runQuitTeardown 最前调用，先于 destroyOverlay/closeDatabase）：清
 * 60s 桶扫句柄 → 摘 powerMonitor 监听 → 撤 notifyApplier。同步、幂等、非阻塞。
 */
export function shutdownNotifyWire(): void {
  if (scanTimer !== null) {
    clearInterval(scanTimer)
    scanTimer = null
  }
  detachPowerWatch()
  setNotifyApplier(null)
  logger.info('notify wire shut down (scan timer cleared, power watch detached, applier removed)')
}
