/**
 * keyStoreWire.ts — ApiHub 密钥加密的生产注入实现（main 侧，docs/09 §6.1）。
 *
 * 唯一允许 import electron 的 ApiHub 相关模块（放 main 根，services 目录保持
 * electron-free）。包一层 Electron safeStorage（DPAPI）：
 *  - isEncryptionAvailable() 为 false 时 encrypt/decrypt 返回结构化错误
 *    （KeyCryptoError），档案按「密钥不可用」处理（保存失败/切换拒绝），绝不
 *    明文落库（任务书：safeStorage 不可用时档案标记不可用而非明文落库）；
 *  - 密文形态为 base64(safeStorage.encryptString(plain))，与 apihub_profiles
 *    envelope 的 sealed 字段对齐；
 *  - 解密只发生在主进程内存瞬间（切换/掩码/重加密迁移），结果绝不落日志。
 */

import { safeStorage } from 'electron'
import type { KeyCrypto } from './services/apihub/keyStore.ts'

/** KeyCrypto 的结构化错误：code 稳定，message 不含密钥材料与堆栈。 */
export class KeyCryptoError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'KeyCryptoError'
  }
}

/** 生产 KeyCrypto：Electron safeStorage（Windows DPAPI）不可用时返回错误而非降级明文。 */
export function createSafeStorageKeyCrypto(): KeyCrypto {
  return {
    plainStore: false,
    encrypt(plain: string): string {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new KeyCryptoError('KEYSTORE_UNAVAILABLE', '系统密钥加密（safeStorage/DPAPI）不可用，拒绝以明文形态保存密钥；请稍后重试')
      }
      return safeStorage.encryptString(plain).toString('base64')
    },
    decrypt(sealed: string): string {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new KeyCryptoError('KEYSTORE_UNAVAILABLE', '系统密钥加密（safeStorage/DPAPI）不可用，无法解密档案密钥')
      }
      return safeStorage.decryptString(Buffer.from(sealed, 'base64'))
    },
  }
}
