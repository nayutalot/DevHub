/**
 * lib/ipc.ts — Renderer 侧统一 IPC 调用包装（docs/04 §1，docs/00 约束 #14/#17）。
 *
 * call(channel, payload) 是全 UI 唯一的数据获取入口：解 Result envelope，
 * ok:false 抛 IpcError（code + message，无堆栈）供视图 error 态渲染；
 * window.devhub.invoke 由沙箱 preload 暴露（env.d.ts 提供按 channel 的
 * payload/result 编译期类型）。运行时才触达 window，模块本身保持可静态分析。
 */

import type { IpcChannel } from '../../../shared/channels.ts'
import type { ChannelContract, Result } from '../../../shared/types.ts'

type PayloadOf<C extends IpcChannel> = ChannelContract[C][0]
type ResultOf<C extends IpcChannel> = ChannelContract[C][1]

/** envelope 错误分支的异常形态：结构化 { code, message }，绝无堆栈（约束 #14）。 */
export class IpcError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'IpcError'
    this.code = code
  }
}

/**
 * 统一 invoke 包装：调用 → 解 envelope → data 或 throw IpcError。
 * 网关契约保证永远返回 envelope（永不 reject 裸异常），但保险起见把
 * invoke 本身的意外 rejection（bridge 缺失等）也折叠为 IpcError('INTERNAL')。
 */
export async function call<C extends IpcChannel>(
  channel: C,
  payload?: PayloadOf<C>,
): Promise<ResultOf<C>> {
  let envelope: Result<ResultOf<C>>
  try {
    envelope = await window.devhub.invoke(channel, payload)
  } catch (err) {
    throw new IpcError('INTERNAL', err instanceof Error ? err.message : String(err))
  }
  if (!envelope.ok) {
    throw new IpcError(envelope.error.code, envelope.error.message)
  }
  return envelope.data
}

/** 轮询间隔等待；timeout 毫秒后 resolve（不 reject）。 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
