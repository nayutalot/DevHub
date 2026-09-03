/**
 * Renderer 全局类型声明：window.devhub —— 沙箱 preload 经 contextBridge
 * 暴露的唯一 API（src/preload/index.ts）。
 *
 * payload / result 类型直接取自 shared 契约表 ChannelContract（src/shared/types.ts），
 * 让 Step 7 四视图的全部 devhub.invoke 调用获得编译期 channel 白名单校验与
 * 按 channel 的 payload/result 类型推导（docs/04 §1/#17）。
 */
import type { IpcChannel } from '../../shared/channels.ts'
import type { ChannelContract, Result } from '../../shared/types.ts'

type ContractPayload<C extends IpcChannel> = ChannelContract[C][0]
type ContractResult<C extends IpcChannel> = ChannelContract[C][1]

declare global {
  interface Window {
    devhub: {
      /**
       * 唯一 IPC 入口：invoke(channel, payload?) → Promise<Result<result>>。
       * channel 限定为白名单 IpcChannel；payload 按契约可省略（空 payload 的
       * channel）；返回值恒为统一 Result envelope，错误分支为
       * { ok: false, error: { code, message } }（约束 #14）。
       */
      invoke<C extends IpcChannel>(
        channel: C,
        payload?: ContractPayload<C>,
      ): Promise<Result<ContractResult<C>>>
    }
  }
}

export {}
