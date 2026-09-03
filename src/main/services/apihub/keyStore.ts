/**
 * keyStore.ts — ApiHub 注入式密钥加解密接口（docs/09 §6.1，铁律：services 目录
 * electron-free）。
 *
 * - KeyCrypto 只有 encrypt/decrypt 两个能力方法 + 一个 readonly plainStore 标记
 *   （明文降级实现置 true，envelope 落 plainStore:true 供 UI 强提示）；
 * - 生产实现由 main 侧 keyStoreWire.ts 注入（Electron safeStorage / DPAPI），
 *   smoke / 纯 Node 场景注入 plaintextKeyCrypto（base64，明确标记明文降级）；
 * - 无注入时的默认值是 plaintextKeyCrypto()（base64 ≠ 明文原样落库），保证纯
 *   Node 直载 service 不炸；生产入口 main/index.ts 启动即覆盖注入，绝不依赖该默认；
 * - maskKey 是全项目唯一的 key 脱敏出口：对外只有尾 4 位与长度（docs/09 §6.5 红线）。
 */

/** 注入接口（任务书 KeyCrypto 签名）：密文为 base64 字符串，可同步可异步。 */
export interface KeyCrypto {
  /** true = 产出可视为明文降级形态（如 base64），档案 envelope 落 plainStore:true。 */
  readonly plainStore?: boolean
  encrypt(plain: string): string | Promise<string>
  decrypt(sealed: string): string | Promise<string>
}

/**
 * 测试 / 纯 Node 降级实现：encrypt = base64(plain)，decrypt 反向。
 * plainStore 恒为 true —— smoke 用例断言「落库形态 ≠ 明文」与 plainStore 标记。
 */
export function plaintextKeyCrypto(): KeyCrypto {
  return {
    plainStore: true,
    encrypt(plain: string): string {
      return Buffer.from(plain, 'utf8').toString('base64')
    },
    decrypt(sealed: string): string {
      return Buffer.from(sealed, 'base64').toString('utf8')
    },
  }
}

let active: KeyCrypto = plaintextKeyCrypto()

/** main/index.ts 启动时注入 safeStorage 实现（keyStoreWire.ts）。 */
export function setKeyCrypto(crypto: KeyCrypto): void {
  active = crypto
}

/** 当前注入实现（未注入 = plaintextKeyCrypto 默认）。 */
export function getKeyCrypto(): KeyCrypto {
  return active
}

/** 统一 mask：只留尾 4 位与长度（对外投影唯一形态，docs/09 §6.5）。 */
export function maskKey(key: string): { tail: string; len: number } {
  return { tail: key.slice(-4), len: key.length }
}
