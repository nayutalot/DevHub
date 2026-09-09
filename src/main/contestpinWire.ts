/**
 * contestpinWire.ts — ContestPin 的 main 侧 electron 胶水（CP3b 批次）。
 *
 * 唯一职责：为 materialService 注入系统剪贴板图片读取器（粘贴截图入口）——
 * services 目录保持 electron-free（keyStoreWire 同款注入范式）。Electron 44 的
 * clipboard 模块为 W3C 异步形态（clipboard.read() → ClipboardItem[]），读取器
 * 相应为 async。剪贴板只在 renderer 显式调用 contestpin:importMaterials
 * { pasteClipboard: true } 时读取，每次调用至多读取一次；失败（权限/无图/异常）
 * 一律返回 null → service 层结构化 no-op（clipboardUnavailable: true），绝不抛
 * 裸异常。
 *
 * 红线：本模块绝不触碰网络、不读取剪贴板文本、不缓存图片内容（Buffer 仅在
 * 调用栈内瞬间存在，sha256 落盘后即弃）。
 */

import { clipboard } from 'electron'
import { setClipboardImageReader } from './services/contestpin/materialService.ts'

/** 生产剪贴板读取器：首个 image/* 项 → buffer；无图/异常返回 null（service 层 no-op）。 */
export function installContestpinWire(): void {
  setClipboardImageReader(async () => {
    try {
      const items = await clipboard.read()
      for (const item of items) {
        const imageType = item.types.find((t) => typeof t === 'string' && t.startsWith('image/'))
        if (imageType === undefined) continue
        const payload = await item.getType(imageType)
        if (payload instanceof Blob) {
          return Buffer.from(await payload.arrayBuffer())
        }
      }
      return null
    } catch {
      return null
    }
  })
}

/** 退出/测试收尾：摘除注入（恢复未注入态）。 */
export function shutdownContestpinWire(): void {
  setClipboardImageReader(null)
}
