/**
 * autostartWire.ts — 开机自启的 Electron 注入实现（AC5，docs/12 §10）。
 *
 * services 层 electron-free 纪律不变（keyStoreWire.setKeyCrypto 同款注入先例）：
 * 本模块是唯一把 app.setLoginItemSettings 能力交给 agentControlService 的胶水，
 * 放 main 根目录（electron import 白名单 = index.ts / keyStoreWire.ts /
 * ipc/gateway.ts / 本模块 / trayWire.ts）。
 *
 * Windows path 语义（docs/12 §10）：使用 app.setLoginItemSettings 默认 path——
 * Electron 对打包产物自写自身路径；dev 模式 process.execPath 是 electron.exe
 * （注册表 Run 键会登记 electron.exe + 项目作为 CWD 的形态差异在批次报告如实
 * 上报，验收后恢复关闭态）。
 */

import { app } from 'electron'
import { logger } from './core/logger.ts'
import {
  applyAutoStartSetting,
  setAutoStartApplier,
} from './services/agentControl/agentControlService.ts'
import type { AutoStartApplier } from './services/agentControl/agentControlService.ts'

/** 生产注入实现：setLoginItemSettings 默认 path（Electron 自处理）。 */
export function createElectronAutoStartApplier(): AutoStartApplier {
  return (enabled: boolean) => {
    try {
      app.setLoginItemSettings({ openAtLogin: enabled })
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: message }
    }
  }
}

/**
 * 注入即时应用能力 + 按当前 login_autostart 现值应用一次（whenReady 内调用，
 * docs/12 §10「启动时应用」）。返回应用后的现值（供日志）。
 */
export function injectAutoStart(): boolean {
  setAutoStartApplier(createElectronAutoStartApplier())
  const enabled = applyAutoStartSetting()
  logger.info(`autostart applied from settings login_autostart=${enabled ? '1' : '0'}`)
  return enabled
}
