/**
 * quitGuarantee.ts — 退出保证状态机（AC9 退出滞留修复；electron-free 纯逻辑）。
 *
 * 背景（AC9 终验实测）：teardown 日志完整（gateway 关闭 → agent control 收尾 →
 * DB 关闭 WAL checkpointed）但主进程+GPU+网络服务 3 个 electron 进程滞留。
 * 「收尾完成」≠「进程退出」：旧实现 5s 硬上限只再次 app.quit()（同样可能被事件
 * 循环残留句柄拖住），且托盘 2s 刷新 interval 从未清除（ref'd 定时器让主进程
 * 事件循环永不枯竭，还会经 getDatabase() 惰性重开已关闭的库）、托盘从未 destroy。
 *
 * 状态机（单向收敛、幂等）：idle → tearing-down → quitting → force-exit。
 *  - first-before-quit（仅 idle）：preventDefault + 挂收尾硬上限 → tearing-down；
 *    非 idle 的二次 before-quit 一律放行（不 preventDefault，与旧 isQuitting 语义一致）。
 *  - teardown-completed / hard-cap-elapsed（仅 tearing-down）：清硬上限（前者）→
 *    再次 app.quit() + 挂退出看门狗 → quitting。
 *  - watchdog-elapsed：宽限期到进程仍未退 → forceExit（app.exit(0) 强退）——
 *    退出保证：优雅收尾照旧执行，但进程必须在有限时间内消失。
 *
 * 纯数据转换，零 electron / 定时器 / IO 依赖：定时器与 app.* 调用由 index.ts
 * 按 action 字段执行；smoke 可直载断言分支逻辑。
 */

/** 有序收尾硬上限（docs/12 §10：收尾不得挂死应用）。 */
export const QUIT_TEARDOWN_HARD_CAP_MS = 5000

/** 退出保证看门狗：quit 发起后进程仍未退的宽限期，到点强制 app.exit(0)。 */
export const QUIT_EXIT_WATCHDOG_MS = 3000

export type QuitStage = 'idle' | 'tearing-down' | 'quitting' | 'force-exit'

export type QuitTrigger =
  | 'first-before-quit'
  | 'teardown-completed'
  | 'hard-cap-elapsed'
  | 'watchdog-elapsed'

/** 一次转换的执行指令（index.ts 按 true 的字段执行对应副作用）。 */
export interface QuitAction {
  /** before-quit 事件 preventDefault（暂缓退出，先做有序收尾）。 */
  preventDefault: boolean
  /** 调 app.quit() 再次发起优雅退出。 */
  quitAgain: boolean
  /** 调 app.exit(0) 强制退出（退出保证兜底，杜绝进程滞留）。 */
  forceExit: boolean
  /** 挂收尾硬上限定时器（5s，watchdog 之外的独立守卫）。 */
  armHardCap: boolean
  /** 挂退出看门狗定时器（3s 宽限后强退；仅挂一次）。 */
  armWatchdog: boolean
  /** 清收尾硬上限定时器（收尾已收敛，不再需要）。 */
  clearHardCap: boolean
  /** 转换后的状态机阶段。 */
  nextStage: QuitStage
}

function noop(nextStage: QuitStage): QuitAction {
  return {
    preventDefault: false,
    quitAgain: false,
    forceExit: false,
    armHardCap: false,
    armWatchdog: false,
    clearHardCap: false,
    nextStage,
  }
}

/**
 * 状态机转换（纯函数）：给定当前阶段与触发器，返回要执行的指令与下一阶段。
 * 未知组合一律 no-op 原地停留（幂等，绝不放大动作）。
 */
export function quitTransition(current: QuitStage, trigger: QuitTrigger): QuitAction {
  if (trigger === 'first-before-quit') {
    if (current !== 'idle') {
      // tearing-down / quitting / force-exit：二次 before-quit 放行（不拦截）
      return noop(current)
    }
    return {
      preventDefault: true,
      quitAgain: false,
      forceExit: false,
      armHardCap: true,
      armWatchdog: false,
      clearHardCap: false,
      nextStage: 'tearing-down',
    }
  }

  if (trigger === 'teardown-completed') {
    if (current !== 'tearing-down') return noop(current) // 已收敛：幂等
    return {
      preventDefault: false,
      quitAgain: true,
      forceExit: false,
      armHardCap: false,
      armWatchdog: true,
      clearHardCap: true,
      nextStage: 'quitting',
    }
  }

  if (trigger === 'hard-cap-elapsed') {
    if (current !== 'tearing-down') return noop(current)
    // 收尾挂死：照常发起 quit + 看门狗兜底（宽限后必强退，绝不无限等待）
    return {
      preventDefault: false,
      quitAgain: true,
      forceExit: false,
      armHardCap: false,
      armWatchdog: true,
      clearHardCap: false,
      nextStage: 'quitting',
    }
  }

  // watchdog-elapsed：宽限期到进程仍未退 → 退出保证（强退）
  if (current === 'quitting' || current === 'tearing-down') {
    return {
      preventDefault: false,
      quitAgain: false,
      forceExit: true,
      armHardCap: false,
      armWatchdog: false,
      clearHardCap: false,
      nextStage: 'force-exit',
    }
  }
  return noop(current) // idle / force-exit：无可保证动作
}
