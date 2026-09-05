/**
 * cache.ts — relay_events 缓存写入/查询/淘汰（docs/19 §5.4，G1/G9 裁决具体化）。
 *
 * - 缓存内容 = 事件帧粒度：元数据 + 已脱敏有界 payload（≤4KB/条，docs/19 §5.4）+ summary；
 *   完整消息正文/代码/密钥永不入缓存（消息取数实时中继）；
 * - sequence = Windows agent_events.id 镜像（PRIMARY KEY，幂等插入去重 host 回填重发）；
 * - ACK 淘汰：被全部活跃 relay 设备 ack 且 created_at 超 72h → 删 payload_json
 *   （保元数据行 7 天供 hasGaps 判定）后整行删除；
 * - 容量两级：软 25,000 行/100MB 触顶 → 先删已全 ack 最旧行，仍超删最旧行
 *   （含未 ack，删前审计 relay_cache_evicted，触发 hasGaps 语义）；硬 50,000 行/200MB 绝不突破。
 */
import type { Store } from './store.ts'
import type { RelayConfig } from './config.ts'

export interface CachedEventRow {
  sequence: number
  event_id: string
  type: string
  provider: string | null
  session_ref: string | null
  summary: string | null
  payload_json: string | null
  requires_user_action: number
  created_at: number
}

export interface CacheEventInput {
  sequence: number
  eventId: string
  type: string
  provider?: string | null
  sessionId?: number | null
  summary?: string | null
  payloadJson?: string | null
  requiresUserAction: boolean
  createdAt: number
}

/** session_ref 定位串（docs/19 §5.3：Windows sessionId + provider 冗余定位串）。 */
export function sessionRef(provider: string | null | undefined, sessionId: number | null | undefined): string | null {
  if (sessionId === null || sessionId === undefined || !Number.isSafeInteger(sessionId)) return null
  const p = typeof provider === 'string' && provider.length > 0 ? provider : 'unknown'
  return `${p}:${sessionId}`
}

export class EventCache {
  private readonly store: Store
  private readonly config: RelayConfig

  constructor(store: Store, config: RelayConfig) {
    this.store = store
    this.config = config
  }

  /**
   * 幂等插入（sequence UNIQUE 去重；host 回填重发零重复）。返回 inserted。
   * payload 超过 4KB 上界时只落元数据（payload_json NULL）——实时扇出仍转发完整帧
   * （缓存界 ≠ 转发界，docs/19 §5.4 缓存内容契约）。
   */
  insert(input: CacheEventInput): { inserted: boolean } {
    const payloadJson = input.payloadJson !== null && input.payloadJson !== undefined
      && Buffer.byteLength(input.payloadJson, 'utf8') <= this.config.cachePayloadMaxBytes
      ? input.payloadJson
      : null
    const existing = this.store.get<{ event_id: string }>('SELECT event_id FROM relay_events WHERE sequence = ?', input.sequence)
    if (existing !== undefined) {
      if (existing.event_id !== input.eventId) {
        // sequence 冲突且 eventId 不同：host 是权威（绝不自编号），审计后忽略
        return { inserted: false }
      }
      return { inserted: false }
    }
    try {
      this.store.run(
        'INSERT INTO relay_events (sequence, event_id, type, provider, session_ref, summary, payload_json, requires_user_action, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        input.sequence,
        input.eventId,
        input.type,
        input.provider ?? null,
        sessionRef(input.provider, input.sessionId),
        input.summary ?? null,
        payloadJson,
        input.requiresUserAction ? 1 : 0,
        input.createdAt,
      )
      return { inserted: true }
    } catch {
      // eventId UNIQUE 并发冲突等：幂等语义下视为已存在
      return { inserted: false }
    }
  }

  /** 缓存最高 sequence（hello.sequence 基准，docs/18 §3.1；空缓存 = 0）。 */
  maxSequence(): number {
    const row = this.store.get<{ maxSeq: number | null }>('SELECT MAX(sequence) AS maxSeq FROM relay_events')
    return row?.maxSeq ?? 0
  }

  /** 按 sequence > after 升序分页（页上限 = syncPageLimit，docs/18 §3.12）。 */
  pageSince(after: number, limit: number): CachedEventRow[] {
    return this.store.all<CachedEventRow>(
      'SELECT sequence, event_id, type, provider, session_ref, summary, payload_json, requires_user_action, created_at FROM relay_events WHERE sequence > ? AND payload_json IS NOT NULL ORDER BY sequence ASC LIMIT ?',
      after,
      limit,
    )
  }

  /**
   * hasGaps 判定（docs/18 §3.12/§6.3）：after 与 upTo 之间存在缺失 sequence，
   * 或存在 payload 已淘汰的元数据行（无法忠实补发）→ true。缓存洞显式标注，绝不静默跳号。
   */
  hasGapsBetween(after: number, upTo: number): boolean {
    if (upTo <= after) return false
    const row = this.store.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM relay_events WHERE sequence > ? AND sequence <= ? AND payload_json IS NOT NULL',
      after,
      upTo,
    )
    return (row?.n ?? 0) !== upTo - after
  }

  /** 单事件查询（缓存元数据投影，供 stale 降级与调试）。 */
  bySequence(sequence: number): CachedEventRow | undefined {
    return this.store.get<CachedEventRow>(
      'SELECT sequence, event_id, type, provider, session_ref, summary, payload_json, requires_user_action, created_at FROM relay_events WHERE sequence = ?',
      sequence,
    )
  }

  /** 缓存规模（行数 + 估算字节：payload + summary + 定长开销）。 */
  size(): { rows: number; bytes: number } {
    const row = this.store.get<{ rows: number; bytes: number | null }>(
      "SELECT COUNT(*) AS rows, COALESCE(SUM(COALESCE(LENGTH(payload_json),0) + COALESCE(LENGTH(summary),0) + 256), 0) AS bytes FROM relay_events",
    )
    return { rows: row?.rows ?? 0, bytes: row?.bytes ?? 0 }
  }

  /**
   * 淘汰扫描（TTL 72h + 容量两级；docs/19 §5.4）。返回审计明细。
   * 周期调用（evictionIntervalMs）+ 大批量插入后调用。
   */
  evict(nowSec: number, onEvicted?: (stage: 'ttl_payload' | 'ttl_row' | 'capacity_acked' | 'capacity_forced', count: number) => void): void {
    const cfg = this.config
    // ① TTL：全 ack（全部活跃 relay 设备 acked_through ≥ sequence）+ created_at 超 72h → 删 payload
    const ttlPayloadBefore = nowSec - cfg.cachePayloadTtlSec
    const moved = this.store.run(
      `UPDATE relay_events SET payload_json = NULL
       WHERE payload_json IS NOT NULL AND created_at < ?
         AND NOT EXISTS (
           SELECT 1 FROM relay_devices d
           WHERE d.status = 'active' AND d.token_version > 0
             AND COALESCE((SELECT acked_through FROM relay_event_acks WHERE device_id = d.id), 0) < relay_events.sequence
         )`,
      ttlPayloadBefore,
    )
    if (moved.changes > 0) onEvicted?.('ttl_payload', Number(moved.changes))

    // ② TTL：元数据行超 7 天 → 整行删除（hasGaps 判定窗口终点）
    const ttlRowBefore = nowSec - cfg.cacheRowTtlSec
    const deletedRows = this.store.run('DELETE FROM relay_events WHERE created_at < ?', ttlRowBefore)
    if (deletedRows.changes > 0) onEvicted?.('ttl_row', Number(deletedRows.changes))

    // ③ 容量两级（软 25k 行/100MB → 硬 50k 行/200MB 绝不突破）
    let size = this.size()
    if (size.rows > cfg.cacheSoftRows || size.bytes > cfg.cacheSoftBytes) {
      // 先删「已全 ack 最旧行」至软限内
      let removed = this.deleteOldest(true, size.rows - cfg.cacheSoftRows, nowSec)
      if (removed > 0) onEvicted?.('capacity_acked', removed)
      size = this.size()
      if (size.rows > cfg.cacheSoftRows || size.bytes > cfg.cacheSoftBytes) {
        // 仍超 → 删最旧行（含未 ack；删前审计 relay_cache_evicted → hasGaps 语义）
        removed = this.deleteOldest(false, size.rows - cfg.cacheSoftRows, nowSec)
        if (removed > 0) onEvicted?.('capacity_forced', removed)
      }
    }
    // ④ 硬限保险丝：异常场景（批量洪峰）下绝不突破硬上限
    size = this.size()
    if (size.rows > cfg.cacheHardRows || size.bytes > cfg.cacheHardBytes) {
      const removed = this.deleteOldest(false, size.rows - cfg.cacheSoftRows, nowSec)
      if (removed > 0) onEvicted?.('capacity_forced', removed)
    }
  }

  /** 删最旧行（ackedOnly=true 仅已全 ack；false 含未 ack）。返回删除行数。 */
  private deleteOldest(ackedOnly: boolean, excessRows: number, nowSec: number): number {
    if (excessRows <= 0) return 0
    const victims = ackedOnly
      ? this.store.all<{ sequence: number }>(
          `SELECT sequence FROM relay_events
           WHERE NOT EXISTS (
             SELECT 1 FROM relay_devices d
             WHERE d.status = 'active' AND d.token_version > 0
               AND COALESCE((SELECT acked_through FROM relay_event_acks WHERE device_id = d.id), 0) < relay_events.sequence
           )
           ORDER BY sequence ASC LIMIT ?`,
          excessRows,
        )
      : this.store.all<{ sequence: number }>('SELECT sequence FROM relay_events ORDER BY sequence ASC LIMIT ?', excessRows)
    if (victims.length === 0) return 0
    let removed = 0
    for (const victim of victims) {
      const res = this.store.run('DELETE FROM relay_events WHERE sequence = ?', victim.sequence)
      removed += Number(res.changes)
    }
    void nowSec
    return removed
  }
}

/** 全部活跃 relay 设备（扇出目标；token_version>0 = 已绑定 Token 的真实设备）。 */
export function activeDevices(store: Store): Array<{ id: number; win_device_id: number | null; device_name: string; token_version: number }> {
  return store.all<{ id: number; win_device_id: number | null; device_name: string; token_version: number }>(
    "SELECT id, win_device_id, device_name, token_version FROM relay_devices WHERE status = 'active' AND token_version > 0 ORDER BY id ASC",
  )
}
