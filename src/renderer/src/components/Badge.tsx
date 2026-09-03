/**
 * components/Badge.tsx — 状态徽章（docs/06）。
 * tone 决定配色（ok 绿 / warn 黄 / err 红 / accent 蓝 / wsl 橙 / docker 青 / dim 灰），
 * stateTone / originTone 把领域状态折叠到 tone，视图无需自行配色。
 */

import type { ReactNode } from 'react'

export type BadgeTone = 'ok' | 'warn' | 'err' | 'accent' | 'wsl' | 'docker' | 'dim'

const TONE_CLASS: Record<BadgeTone, string> = {
  ok: 'badge badge-ok',
  warn: 'badge badge-warn',
  err: 'badge badge-err',
  accent: 'badge badge-accent',
  wsl: 'badge badge-wsl',
  docker: 'badge badge-docker',
  dim: 'badge',
}

export function Badge({
  tone = 'dim',
  title,
  children,
}: {
  tone?: BadgeTone
  title?: string
  children: ReactNode
}) {
  return (
    <span className={TONE_CLASS[tone]} title={title}>
      {children}
    </span>
  )
}

/** 生命周期/状态词 → tone：running/clean/installed/done → ok，dirty/warn → warn，
 * missing/error/failed → err，stopped/其余 → dim。无未知缺口（else 归 dim）。 */
export function stateTone(status: string | undefined): BadgeTone {
  switch ((status ?? '').toLowerCase()) {
    case 'running':
    case 'clean':
    case 'installed':
    case 'done':
    case 'ok':
      return 'ok'
    case 'dirty':
    case 'warn':
    case 'warning':
    case 'degraded':
      return 'warn'
    case 'error':
    case 'failed':
    case 'missing':
      return 'err'
    default:
      return 'dim'
  }
}

/** 服务来源 → tone（三色区分，docs/06 §3.4）：windows 蓝 / wsl 橙 / docker 青。 */
export function originTone(origin: 'windows' | 'wsl' | 'docker'): BadgeTone {
  switch (origin) {
    case 'windows':
      return 'accent'
    case 'wsl':
      return 'wsl'
    case 'docker':
      return 'docker'
  }
}
