// m3c8a-orphan-revoke.mjs — M3-C8a 修 ④：桌面 remote_devices 存量 active 行清账。
//
// 背景（任务书 §1 #5 / §2.4）：remote_devices #2-7/10-37/44/45 为先前批次遗留的
// active 孤儿行（测试设备残留）；另含本批 smoke uxa-147 配对残留 #48-51（同类别）。
// 经 m3c7b-orphan-revoke.mjs 同模式 DB 等价路径置 revoked。
//
// 勿动清单：#46（C2e App 设备，在役）、#47（已 revoked）、#52（本批 App 设备，在役）、
// #8/9/31-33/38-43（此前批次已 revoked）。
//
// 纪律：
//   - SQL 全参数绑定（约束 #11）；目标 id 集合为编译期常量，绝不动态拼接值；
//   - 快照零凭据（绝不出 token_hash / previous_token_hash——红线约束 #1/#13）；
//   - 幂等：已 revoked 行零触碰（WHERE status='active'），重复执行安全；
//   - 只动 remote_devices 状态位 + 审计流水，零删行、零 schema 变更；
//   - 前置：DevHub.exe / electron.exe 已退出（DB WAL 无活跃写者）。
//
// 运行：node acceptance/agents-mobile/m3c8a-orphan-revoke.mjs [--dry-run]
// 输出：前后快照 JSON（stdout）。

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** 孤儿行目标集（任务书 §1 #5 固定清单 + 本批 smoke 残留 #48-51；编译期常量）。 */
const ORPHAN_IDS = [
  2, 3, 4, 5, 6, 7,
  10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
  31, 32, 33, 34, 35, 36, 37,
  44, 45,
  48, 49, 50, 51,
]
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
     WHERE id = ? AND status = 'active'`,
  )
  const audit = db.prepare(
    `INSERT INTO security_audit_logs (category, action, device_id, outcome, detail_json, created_at)
     VALUES ('device', 'device_revoked', ?, 'success', ?, ?)`,
  )
  for (const id of ORPHAN_IDS) {
    const r = update.run(now, now, id)
    if (Number(r.changes) > 0) {
      revokedIds.push(id)
      changes += Number(r.changes)
      // 审计 detail 零码零凭据（m3c7b 同形）
      audit.run(id, JSON.stringify({ via: 'm3c8a-orphan-cleanup-db-fixture' }), now)
    }
  }
}

const after = db.prepare(snapshotSql).all(...ORPHAN_IDS)
const activeRemaining = db.prepare("SELECT id, device_name FROM remote_devices WHERE status = 'active' ORDER BY id").all()

console.log(
  JSON.stringify(
    {
      batch: 'm3c8a',
      dbPath,
      dryRun,
      targetCount: ORPHAN_IDS.length,
      revokedCount: changes,
      revokedIds,
      before: before.map((r) => ({ id: r.id, name: r.device_name, status: r.status, token_version: r.token_version })),
      after: after.map((r) => ({ id: r.id, name: r.device_name, status: r.status, revoked_at: r.revoked_at })),
      activeRemaining,
      note: '零凭据快照；#46/#52 在役勿动、#47 已 revoked 勿动；审计流水 device_revoked via=m3c8a-orphan-cleanup-db-fixture',
    },
    null,
    1,
  ),
)
db.close()
