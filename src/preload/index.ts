/**
 * sandboxed preload（docs/04 §1，约束 #18）。
 *
 * contextBridge 仅暴露一个方法 window.devhub.invoke(channel, payload?)，
 * 经唯一网关 channel `devhub:invoke` 转发 `{ channel, payload }`；
 * 不暴露任何 Node 对象 / 原型 / fs / child_process。
 *
 * electron 只允许 import contextBridge 与 ipcRenderer 两个沙箱可用 API。
 * 窗口 webPreferences 必须配套 sandbox: true、contextIsolation: true、
 * nodeIntegration: false（src/main/index.ts）。
 *
 * 构建形态约束：sandbox:true 的 preload 只能以 CJS 加载 —— electron.vite.config.ts
 * 的 preload 段已显式钉死 rollupOptions.output.format = 'cjs'，产物
 * out/preload/index.js 不得含顶层 import/export ESM 语句。
 * shared/channels.ts 经打包内联进本文件（无运行时 require）。
 */

import { contextBridge, ipcRenderer } from 'electron'
import { IPC_GATEWAY } from '../shared/channels.ts'
import type { IpcChannel } from '../shared/channels.ts'

contextBridge.exposeInMainWorld('devhub', {
  /**
   * 唯一桥接方法。channel 的强类型（IpcChannel + ChannelContract 契约）由
   * src/renderer/src/env.d.ts 在 Renderer 侧声明；本实现的运行时白名单
   * 校验在主进程网关（gateway → handlers.dispatchGatewayRequest）。
   */
  invoke: (channel: IpcChannel, payload?: unknown): Promise<unknown> =>
    ipcRenderer.invoke(IPC_GATEWAY, { channel, payload }),
})
