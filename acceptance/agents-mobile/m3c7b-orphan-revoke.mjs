// m3c7b-orphan-revoke.mjs — M3-C7b 修 ⑤：桌面 remote_devices 孤儿行清账（DB 等价脚本）。
//
// 背景（任务书 §1 #5）：remote_devices #38/39/40/41/42/43 为 C2c/C2d 实证批产物
// 孤儿行（测试设备残留 active 态）。本脚本经桌面侧通道的 DB 等价路径置 revoked
// （m3c2-revoke-row.ps1 夹具模式改造：原 UIA 点击撤销按钮 → 等价 L3 revokeDevice
// 落库语义 = status='revoked' + revoked_at + security_audit_logs device_revoked 行）。
//
// 纪律：
//   - SQL 全参数绑定（约束 #11）；目标 id 集合为编译期常量，绝不动态拼接值；
//   - 快照零凭据（绝不出 token_hash / previous_token_hash——红线约束 #1/#13）；
//   - 幂等：已 revoked 行零触碰（WHERE status='active'），重复执行安全；
//   - 只动 remote_devices 状态位 + 审计流水，零删行、零 schema 变更。
//
// 运行：node acceptance/agents-mobile/m3c7b-orphan-revoke.mjs [--dry-run]
// 前置：DevHub.exe / electron.exe 已退出（DB WAL 无活跃写者）；输出 JSON 至 stdout。

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** 孤儿行目标集（任务书 §1 #5 固定清单；编译期常量）。 */
const ORPHAN_IDS = [38, 39, 40, 41, 42, 43]
/** 应用数据目录名（package.json productName = 'DevHub'，与 Electron userData 同源）。 */
const DATA_DIR_NAME = 'DevHub'

const dryRun = process.argv.includes('--dry-run')

function resolveDbPath() {
  // 与 src/main/core/paths.ts 四级策略对齐（本脚本固定走 DEVHUB_HOME / 平台目录两级）
  if (process.env.DEVHUB_HOME) return join(process.env.DEVHUB_HOME, 'devhub.db')
  if (process.platform === 'win32' && process.env.APPDATA) {
    return join(process.env.APPDATA, DATA_DIR_NAME, 'devhub.db')
  }
  return join(homedir(), '.config', DATA_DIR_NAME, 'devhub.db')
}

const dbPath = resolveDbPath()
if (!existsSync(dbPath)) {
  console.error(JSON.stringify({ error: 'db not found', dbPath }))
  process.exit(2)
}

const db = new DatabaseSync(dbPath)
db.exec('PRAGMA busy_timeout = 5000')

const placeholders = ORPHAN_IDS.map(() => '?').join(', ')
const snapshotSql = `SELECT id, device_name, platform, token_version, status, paired_at, last_seen_at, revoked_at, created_at, updated_at
FROM remote_devices WHERE id IN (${placeholders}) ORDER BY id`

const before = db.prepare(snapshotSql).all(...ORPHAN_IDS)
const now = Math.floor(Date.now() / 1000)

let changes = 0
const revokedIds = []
if (!dryRun) {
  // L3 revokeDevice 等价落库语义（状态位 + revoked_at 补齐 + updated_at）；
  // 已 revoked 行零触碰（幂等）。SQL 参数绑定，零动态值拼接。
  const update = db.prepare(
    `UPDATE remote_devices SET status = 'revoked', revoked_at = COALESCE(revoked_at, ?), updated_at = ?
     WHERE id IN (${placeholders}) AND status = 'active'`,
  )
  changes = Number(update.run(now, now, ...ORPHAN_IDS).changes)

  // 审计镜像（security_audit_logs schema 见 004 §4.8；detail 零凭据零 Token 材料）
  const audit = db.prepare(
    'INSERT INTO security_audit_logs (category, action, device_id, outcome, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
  for (const row of before) {
    if (row.status === 'active') {
      audit.run('device', 'device_revoked', Number(row.id), 'success', JSON.stringify({ via: 'm3c7b-orphan-cleanup-db-fixture' }), now)
      revokedIds.push(Number(row.id))
    }
  }
}

const after = db.prepare(snapshotSql).all(...ORPHAN_IDS)

console.log(
  JSON.stringify(
    {
      script: 'm3c7b-orphan-revoke',
      dbPath,
      dryRun,
      targetIds: ORPHAN_IDS,
      changedRows: changes,
      revokedIds,
      before,
      after,
    },
    null,
    2,
  ),
)
db.close()
