/**
 * updateRegistry.ts — App 自更新控制器的单例注册表（X-U 批）。
 *
 * handlers.ts 保持零 electron import：updates:* handler 经本注册表取 main 侧
 * 控制器（updaterWire.ts 在 app.whenReady 时构造并注入——与 keyStore setKeyCrypto
 * 同一单例注入先例）。纯 Node / smoke 环境未注入 → handler 折叠 NOT_AVAILABLE
 * 结构化错误，绝不触碰 electron / electron-updater。
 */

import type { UpdateController } from './updateController.ts'

let active: UpdateController | null = null

/** 注入生产控制器（updaterWire 生产接线一次性调用；smoke 注 fake 后可清空）。 */
export function setUpdateController(controller: UpdateController): void {
  active = controller
}

/** 取当前控制器（未注入 = null；handler 侧折叠 NOT_AVAILABLE）。 */
export function getUpdateController(): UpdateController | null {
  return active
}

/** 清空注入（smoke 用例间隔离；生产不调用）。 */
export function resetUpdateController(): void {
  active = null
}
