/**
 * ac7-seed-gateway.mjs —— AC7 验收用一次性配置种子（可逆）。
 *
 * 作用：把真实用户库 %APPDATA%/devhub/devhub.db 的 settings.gateway_enabled 翻到 '1'，
 * 使桌面启动后 Remote Gateway 监听 127.0.0.1:8746（docs/12 §2），供 Android 模拟器
 * （10.0.2.2 回环映射）配对/联调。等价于桌面 UI「启用远程面」开关的用户级操作；
 * 与 scripts/migrate-legacy.mjs 直写真实库为同一先例。AC8 仍需 Gateway=1，故本批
 * 保持 1 不回滚（回滚：node ac7-seed-gateway.mjs 0）。
 *
 * 用法：node ac7-seed-gateway.mjs [0|1]   （缺省 1；先打印前后值）
 * 红线：只动 settings 表 gateway_enabled 一行，零其他读写；不改 src/。
 */
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { homedir } from 'node:os'

const target = process.argv[2] === '0' ? '0' : '1'
const dbPath = join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'devhub', 'devhub.db')

const db = new DatabaseSync(dbPath)
const before = db.prepare("SELECT value FROM settings WHERE key = 'gateway_enabled'").get()
db.prepare(
  "INSERT INTO settings (key, value) VALUES ('gateway_enabled', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
).run(target)
const after = db.prepare("SELECT value FROM settings WHERE key = 'gateway_enabled'").get()
db.close()
console.log(`ac7-seed-gateway: ${dbPath}`)
console.log(`ac7-seed-gateway: gateway_enabled ${before?.value ?? '(unset)'} -> ${after?.value}`)
