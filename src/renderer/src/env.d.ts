/**
 * Renderer 全局类型声明：window.devhub —— 沙箱 preload 经 contextBridge
 * 暴露的 API（src/preload/index.ts；CP3b 起含 pathForFile——File→磁盘路径，
 * 供材料导入把文件对话框/拖入的 File 落成 main 侧可校验路径，renderer 不拿
 * Node fs）。
 *
 * payload / result 类型直接取自 shared 契约表 ChannelContract（src/shared/types.ts），
 * 让各视图的全部 devhub.invoke 调用获得编译期 channel 白名单校验与
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
      /**
       * File → 磁盘绝对路径（webUtils.getPathForFile 的 preload 包装；
       * 非 File/解析失败 → null）。材料导入专用，无任何 fs 能力暴露。
       */
      pathForFile(file: File): string | null
    }
  }
}

export {}
