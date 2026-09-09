/**
 * sandboxed preload（docs/04 §1，约束 #18；CP3b 就地注记更新）。
 *
 * contextBridge 暴露两个方法：
 *   1. window.devhub.invoke(channel, payload?) —— 经唯一网关 channel
 *      `devhub:invoke` 转发 `{ channel, payload }`；
 *   2. window.devhub.pathForFile(file) —— webUtils.getPathForFile 包装：把
 *      renderer 文件对话框/拖入得到的 File 对象解析为磁盘绝对路径，随
 *      contestpin:importMaterials {paths} 送 main 侧校验导入（任务书 §2.4 #14：
 *      renderer 不拿 Node fs；webUtils 在沙箱 preload 允许清单内，无 Node 面）。
 * 不暴露任何 Node 对象 / 原型 / fs / child_process。
 *
 * electron 只允许 import contextBridge、ipcRenderer、webUtils 三个沙箱可用 API。
 * 窗口 webPreferences 必须配套 sandbox: true、contextIsolation: true、
 * nodeIntegration: false（src/main/index.ts）。
 *
 * 构建形态约束：sandbox:true 的 preload 只能以 CJS 加载 —— electron.vite.config.ts
 * 的 preload 段已显式钉死 rollupOptions.output.format = 'cjs'，产物
 * out/preload/index.js 不得含顶层 import/export ESM 语句。
 * shared/channels.ts 经打包内联进本文件（无运行时 require）。
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC_GATEWAY } from '../shared/channels.ts'
import type { IpcChannel } from '../shared/channels.ts'

contextBridge.exposeInMainWorld('devhub', {
  /**
   * 网关桥接方法。channel 的强类型（IpcChannel + ChannelContract 契约）由
   * src/renderer/src/env.d.ts 在 Renderer 侧声明；本实现的运行时白名单
   * 校验在主进程网关（gateway → handlers.dispatchGatewayRequest）。
   */
  invoke: (channel: IpcChannel, payload?: unknown): Promise<unknown> =>
    ipcRenderer.invoke(IPC_GATEWAY, { channel, payload }),
  /**
   * File → 磁盘绝对路径（webUtils.getPathForFile；非 File 入参/解析失败返回
   * null，由调用方按无效文件处理——绝不抛异常穿透 contextBridge）。
   */
  pathForFile: (file: File): string | null => {
    try {
      const path = webUtils.getPathForFile(file)
      return typeof path === 'string' && path.length > 0 ? path : null
    } catch {
      return null
    }
  },
})
