/**
 * gateway.ts — Electron IPC 网关胶水层（docs/02 §1，约束 #17）。
 *
 * 全应用唯一注册的 IPC channel 是 IPC_GATEWAY（'devhub:invoke'，docs/04 §1）。
 * 校验、白名单分发、envelope 包装、异常折叠全部位于纯模块 handlers.ts 的
 * dispatchGatewayRequest（可被 smoke 在系统 Node 下直测）；本模块只做三件事：
 *   1. 用注入的 appVersion 构造 handler 注册表；
 *   2. ipcMain.handle(IPC_GATEWAY, ...) 接到 dispatch；
 *   3. 兜底 catch：dispatch 理论上永不抛异常，此层保证 ipcMain.handle 绝不把
 *      rejection（可能携带堆栈/绝对路径的 Error）直接漏给 renderer（约束 #14）。
 */

import { ipcMain } from 'electron'
import { IPC_GATEWAY } from '../../shared/channels.ts'
import { logger } from '../core/logger.ts'
import { createHandlerRegistry, dispatchGatewayRequest } from './handlers.ts'
import type { HandlerRegistry } from './handlers.ts'

export interface GatewayDeps {
  /** 注入的应用版本号（main 入口传 app.getVersion()）。 */
  appVersion: string
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 注册唯一网关 channel；在 app.whenReady 之后调用一次。 */
export function registerGateway(deps: GatewayDeps): void {
  const registry: HandlerRegistry = createHandlerRegistry(deps)
  ipcMain.handle(IPC_GATEWAY, async (_event, request: unknown) => {
    try {
      return await dispatchGatewayRequest(registry, request)
    } catch (err) {
      // 兜底（防御式）：dispatch 自身已折叠一切 handler 异常，走到这里说明
      // dispatch 基础设施出错；只记日志，renderer 仍拿到干净的结构化 envelope
      logger.error(`gateway: dispatch itself failed: ${errorMessage(err)}`)
      return { ok: false, error: { code: 'INTERNAL', message: 'internal gateway error' } }
    }
  })
  logger.info(`gateway registered on "${IPC_GATEWAY}" with ${Object.keys(registry).length} channels`)
}
