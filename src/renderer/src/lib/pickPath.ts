/**
 * lib/pickPath.ts — 原生目录/文件选择器包装（D5 批次，AUDIT D-Aud I8）。
 *
 * pickPath 是 dialog:pickPath（electron dialog.showOpenDialog 经主进程网关）的
 * renderer 侧统一入口：取消/失败一律 resolve null（调用方维持原输入值，不报错
 * ——任务书 §1 语义）；选中 → 返回绝对路径字符串，由调用方回填输入框。手输能力
 * 原样保留，「浏览…」只是并列的补充入口。
 */

import { call } from './ipc.ts'

/**
 * 打开原生选择器：mode='directory' 选目录 / 'file' 选文件。
 * 返回 null = 用户取消或通道失败（结构化 INTERNAL 等一并折叠），绝不抛异常。
 */
export async function pickPath(
  mode: 'directory' | 'file',
  opts?: { defaultPath?: string; title?: string },
): Promise<string | null> {
  try {
    const result = await call('dialog:pickPath', {
      mode,
      ...(opts?.defaultPath !== undefined && opts.defaultPath.trim().length > 0 ? { defaultPath: opts.defaultPath } : {}),
      ...(opts?.title !== undefined ? { title: opts.title } : {}),
    })
    return result.canceled ? null : result.path
  } catch {
    return null
  }
}
