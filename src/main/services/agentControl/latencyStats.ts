/**
 * latencyStats.ts — R5.1 延迟打点（ux 整改批 A）：分段耗时统计面。
 *
 * 链路分段（任务书 §2 R5.1；App Room 更新段由批次 C 端侧补齐，本模块只承载
 * 服务端可测的两段）：
 *   source-to-db : 源转录落盘（消息 occurredAt）→ DevHub 入库（persistMessage）
 *   db-to-ws     : agent_events 入库（created_at）→ COMMIT 后 WS 投递回调触发
 *
 * 形态：内存环形样本（每段独立，默认保留 512 样本）+ 快照（count/p50/p95/max/
 * last）+ 每 50 样本一条 logger.info 汇总（R5 改造前后 p50/p95 对比表的数据面，
 * 批次 C 消费）。绝不记录消息内容/路径/凭据——只有毫秒数（约束 #13）。
 *
 * electron-free；零 DB 写（打点非业务数据，约束 #20 不适用）。
 */

import { logger } from '../../core/logger.ts'

export type LatencyStage = 'source-to-db' | 'db-to-ws'

export const LATENCY_STAGES: readonly LatencyStage[] = ['source-to-db', 'db-to-ws'] as const

/** 每段保留样本数（环形；防长驻进程无界增长）。 */
export const LATENCY_SAMPLE_CAP = 512
/** 汇总日志间隔（每段每 N 个样本输出一条 p50/p95）。 */
export const LATENCY_LOG_EVERY = 50

export interface LatencyStageStats {
  /** 累计样本数（含已被环形淘汰的）。 */
  count: number
  /** 窗口内分位数（毫秒）。 */
  p50Ms: number
  p95Ms: number
  maxMs: number
  lastMs: number
}

const SAMPLE_CAP = LATENCY_SAMPLE_CAP
const samples: Record<LatencyStage, number[]> = { 'source-to-db': [], 'db-to-ws': [] }
const totals: Record<LatencyStage, number> = { 'source-to-db': 0, 'db-to-ws': 0 }

/**
 * 纯分位计算（输入容忍乱序——内部先升序排序；smoke 直测）。
 * p 取 0-100；空样本 → 0；单样本 → 原值。
 */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) return 0
  const sortedAsc = [...samples].sort((a, b) => a - b)
  if (sortedAsc.length === 1) return sortedAsc[0]
  const clamped = Math.min(Math.max(p, 0), 100)
  const idx = Math.ceil((clamped / 100) * sortedAsc.length) - 1
  return sortedAsc[Math.min(Math.max(idx, 0), sortedAsc.length - 1)]
}

/**
 * 记录一个延迟样本（毫秒；负值折叠为 0——时钟回拨/秒级 occurredAt 粒度下的
 * 边界形态，绝不传播负延迟）。每 LATENCY_LOG_EVERY 个样本输出一条汇总日志。
 */
export function recordLatencySample(stage: LatencyStage, ms: number): void {
  const value = Number.isFinite(ms) ? Math.max(0, Math.floor(ms)) : 0
  const ring = samples[stage]
  ring.push(value)
  if (ring.length > SAMPLE_CAP) ring.splice(0, ring.length - SAMPLE_CAP)
  totals[stage] += 1
  if (totals[stage] % LATENCY_LOG_EVERY === 0) {
    const snapshot = stageStats(stage)
    logger.info(
      `latency: ${stage} n=${snapshot.count} p50=${snapshot.p50Ms}ms p95=${snapshot.p95Ms}ms max=${snapshot.maxMs}ms (R5.1, window=${ring.length})`,
    )
  }
}

function stageStats(stage: LatencyStage): LatencyStageStats {
  const ring = samples[stage]
  if (ring.length === 0) return { count: totals[stage], p50Ms: 0, p95Ms: 0, maxMs: 0, lastMs: 0 }
  const sorted = [...ring].sort((a, b) => a - b)
  return {
    count: totals[stage],
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    maxMs: sorted[sorted.length - 1],
    lastMs: ring[ring.length - 1],
  }
}

/** 快照（R5 延迟对比表数据面；批次 C 消费；smoke 断言形态）。 */
export function latencySnapshot(): { 'source-to-db': LatencyStageStats; 'db-to-ws': LatencyStageStats } {
  return {
    'source-to-db': stageStats('source-to-db'),
    'db-to-ws': stageStats('db-to-ws'),
  }
}

/** smoke/测试复位。 */
export function resetLatencyStats(): void {
  samples['source-to-db'] = []
  samples['db-to-ws'] = []
  totals['source-to-db'] = 0
  totals['db-to-ws'] = 0
}
