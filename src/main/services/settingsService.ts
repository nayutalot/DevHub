/**
 * settingsService.ts — settings KV 读写（docs/03 3.14，docs/04 settings channels）。
 *
 * key 白名单：scan_root / theme / vault_path / archive_dest_root（后两者为 003 种子）/
 * skills_last_sync_at（S2：Skills 页上次双侧同步时间，skillService 写入）/
 * deepseekHarnessRoot（S3：版本中心 DeepSeek Harness 安装目录，docs/09 §7.1）/
 * gateway_port / gateway_enabled / agents_monitor_enabled / login_autostart
 * （AC2：004 种子的 4 个 AC 域键，docs/13 §6——settings:set 通道白名单同步 6→10）/
 * relay_enabled / relay_endpoint（M2-R1：ECS Relay 两键，docs/19 §4.7）/
 * relay_last_sent_seq（M2-R1：eventUplink 断线回填水位，docs/19 §4.3 明文指定
 * 的 settings 普通键值非凭据——三键并落，白名单 10→13；对 §4.7「10→12」的
 * 计数偏离 = §4.3 该键的明文授权，非凭据属性经本注记声明。Relay 凭据/注册码
 * 绝不入 settings，凭据走 %LOCALAPPDATA%\DevHub\relay\credential 机器本地文件，
 * docs/19 §2.2 红线）；
 * 一切 SQL 参数绑定（约束 #11）。
 */

import { getDatabase } from '../db/index.ts'
import { ServiceError } from './internal.ts'

const ALLOWED_KEYS: readonly string[] = [
  'scan_root',
  'theme',
  'vault_path',
  'archive_dest_root',
  'skills_last_sync_at',
  'deepseekHarnessRoot',
  // AC2 批次（docs/13 §6）：004 种子的 4 个 Agent Control 键
  'gateway_port',
  'gateway_enabled',
  'agents_monitor_enabled',
  'login_autostart',
  // M2-R1 批次（docs/19 §4.7 + §4.3）：ECS Relay 键（enabled/endpoint 默认 '0'/''——
  // 零连接；last_sent_seq 为 eventUplink 回填水位，普通键值非凭据）
  'relay_enabled',
  'relay_endpoint',
  'relay_last_sent_seq',
]

function assertAllowedKey(key: string): void {
  if (!ALLOWED_KEYS.includes(key)) {
    throw new ServiceError('DB_ERROR', `settings key not allowed: ${key} (allowed: ${ALLOWED_KEYS.join(', ')})`)
  }
}

/** 读单个设置项；key 不在白名单 → ServiceError；无该行 → undefined。 */
export function getSetting(key: string): string | undefined {
  assertAllowedKey(key)
  const row = getDatabase()
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(key) as { value: string } | undefined
  return row !== undefined ? row.value : undefined
}

/** 写单个设置项（upsert）；key 不在白名单 → ServiceError。 */
export function setSetting(key: string, value: string): void {
  assertAllowedKey(key)
  getDatabase()
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value)
}

/** 导出只读副本，供 gateway 参数校验等复用。 */
export function allowedSettingKeys(): readonly string[] {
  return ALLOWED_KEYS
}
