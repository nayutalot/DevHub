/**
 * audit.ts — relay_audit 写入（docs/19 §5.2/§5.3，目录镜像 docs/15 §10）。
 *
 * 红线（约束 #13 同款）：detail 零凭据零码明文零 payload 全文——只允许标识符
 * （deviceId/commandId/pairingId/hostId）、结果（outcome）与计数类字段。
 * 调用方传入的 detail 必须已是安全字段；本模块不再做内容清洗（绝不猜）。
 */
import type { Store } from './store.ts'

export type AuditCategory = 'pairing' | 'auth' | 'command' | 'device' | 'relay' | 'wake'
export type AuditOutcome = 'success' | 'denied' | 'error'

export interface AuditEntry {
  category: AuditCategory
  action: string
  outcome: AuditOutcome
  deviceId?: number | null
  hostId?: number | null
  /** 必须零凭据（红线：调用方责任 + selfcheck 抽样断言）。 */
  detail?: Record<string, unknown>
}

export class Audit {
  private readonly store: Store
  private readonly retentionSec: number
  private lastRetentionSweepAt = 0

  constructor(store: Store, retentionSec: number) {
    this.store = store
    this.retentionSec = retentionSec
  }

  write(entry: AuditEntry, nowSec: number = Math.floor(Date.now() / 1000)): void {
    try {
      this.store.run(
        'INSERT INTO relay_audit (category, action, device_id, host_id, outcome, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        entry.category,
        entry.action,
        entry.deviceId ?? null,
        entry.hostId ?? null,
        entry.outcome,
        entry.detail === undefined ? null : JSON.stringify(entry.detail),
        nowSec,
      )
      // 180 天滚动删除（docs/19 §5.4）；每 6h 至多扫一次（低频审计面，避免每次写放大）
      if (nowSec - this.lastRetentionSweepAt > 6 * 3600) {
        this.lastRetentionSweepAt = nowSec
        this.store.run('DELETE FROM relay_audit WHERE created_at < ?', nowSec - this.retentionSec)
      }
    } catch {
      /* 审计写失败不杀伤业务路径（连接面优先）；selfcheck 会抽样核对 */
    }
  }
}
