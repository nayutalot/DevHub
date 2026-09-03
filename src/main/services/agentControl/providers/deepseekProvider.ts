/**
 * deepseekProvider.ts — DeepSeek Harness 骨架 + 能力检测（docs/12 §8.5，裁决 4）。
 *
 * 本机实态（本批真机只读复核）：settings 键 `deepseekHarnessRoot`（ALLOWED_KEYS，
 * 默认 D:\Apps\deepseek-harness）指向**源码重建形态**的 pnpm monorepo
 * （package.json: @deepseek-ai/dsh-root 0.1.0-rc.5, private；AGENTS.md/CLAUDE.md/
 * apps/packages/scripts；无用户侧 sessions/profiles/storages 顶层目录）。
 *
 * 纪律（docs/12 §8.5）：骨架 + 能力检测——目录存在性/版本线索（package.json/
 * AGENTS.md/CLAUDE.md）→ health；**能力无法真实验证 → 「未接入」显式文案**
 * （health_detail/evidence 写明检测到什么、缺什么）；getCapabilities 恒
 * observed + 空集；绝不伪造会话/事件/双向能力；probeHealth 只读目录探测，
 * **绝不启动任何 harness 进程**。
 *
 * electron-free；零 child_process import（约束 #7）。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentCapabilitySet } from '../../../../shared/types.ts'
import { nowSec } from '../../internal.ts'
import { getSetting } from '../../settingsService.ts'
import type {
  AgentProvider,
  CommandOutcome,
  EventSink,
  MessagePage,
  MonitorHandle,
  ProviderDiagnosticsInfo,
  ProviderHealth,
  SessionRef,
  SessionSnapshot,
} from '../providerRegistry.ts'

export interface DeepseekProviderOptions {
  /** harness 根目录（默认 settings deepseekHarnessRoot → D:\Apps\deepseek-harness）。 */
  harnessRoot?: string
}

/** settings 缺省时的默认安装根（AC0 实测；docs/12 §8.5）。 */
export const DEEPSEEK_HARNESS_ROOT_DEFAULT = 'D:/Apps/deepseek-harness'

/** 未接入显式文案（docs/14 §A.1 #1 降级可读；T12 断言对象）。 */
export const DEEPSEEK_NOT_INTEGRATED_NOTE =
  'not integrated: harness source tree detected but no session/control interface verified (never fabricated)'

export function createDeepseekProvider(options: DeepseekProviderOptions = {}): AgentProvider {
  function harnessRoot(): string {
    if (options.harnessRoot !== undefined) return options.harnessRoot
    try {
      const configured = getSetting('deepseekHarnessRoot')
      if (configured !== undefined && configured.trim().length > 0) return configured
    } catch {
      // settings 不可用（无库上下文）：默认根兜底
    }
    return DEEPSEEK_HARNESS_ROOT_DEFAULT
  }

  /** 只读目录探测：检测到什么/缺什么（供 health_detail 与诊断面）。 */
  function probeRoot(): {
    exists: boolean
    detail: string
    version?: string
    name?: string
  } {
    const root = harnessRoot()
    let isDir = false
    try {
      isDir = statSync(root).isDirectory()
    } catch {
      isDir = false
    }
    if (!isDir) {
      return { exists: false, detail: `deepseekHarnessRoot not found at ${root}` }
    }
    const clues: string[] = [`root present: ${root}`]
    let name: string | undefined
    let version: string | undefined
    const pkgPath = join(root, 'package.json')
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: unknown; version?: unknown }
        if (typeof pkg.name === 'string') {
          name = pkg.name
          clues.push(`package.json ${pkg.name}`)
        }
        if (typeof pkg.version === 'string') {
          version = pkg.version
          clues.push(`version ${pkg.version}`)
        }
      } catch {
        clues.push('package.json unreadable')
      }
    } else {
      clues.push('package.json missing')
    }
    for (const marker of ['AGENTS.md', 'CLAUDE.md', 'apps', 'packages']) {
      clues.push(`${marker} ${existsSync(join(root, marker)) ? 'present' : 'missing'}`)
    }
    return { exists: true, detail: clues.join(', '), ...(version !== undefined ? { version } : {}), ...(name !== undefined ? { name } : {}) }
  }

  // -------------------------------------------------------------------------
  // 九方法 1：probeHealth（只读目录探测；绝不启动 harness 进程）
  // -------------------------------------------------------------------------

  async function probeHealth(): Promise<ProviderHealth> {
    const probe = probeRoot()
    if (!probe.exists) {
      return {
        installed: false,
        health: 'unavailable',
        healthDetail: `${probe.detail} (${DEEPSEEK_NOT_INTEGRATED_NOTE})`,
      }
    }
    return {
      installed: true,
      ...(probe.version !== undefined ? { version: probe.version } : {}),
      health: 'ok',
      healthDetail: `harness detected: ${probe.detail}; ${DEEPSEEK_NOT_INTEGRATED_NOTE}`,
    }
  }

  // -------------------------------------------------------------------------
  // 九方法 2-3：listSessions / readMessages（骨架：无已验证数据源，绝不伪造）
  // -------------------------------------------------------------------------

  async function listSessions(): Promise<SessionSnapshot[]> {
    return [] // 无已验证会话数据源（不猜测 harness 会话格式，docs/12 §8.5）
  }

  async function readMessages(_ref: SessionRef, after?: string): Promise<MessagePage> {
    return { messages: [], cursor: after ?? '0', hasMore: false }
  }

  // -------------------------------------------------------------------------
  // 九方法 4-7：能力恒「未接入」（observed + 空集）；动作结构化不支持
  // -------------------------------------------------------------------------

  async function getCapabilities(_ref: SessionRef): Promise<AgentCapabilitySet> {
    return {
      mode: 'observed',
      granted: [],
      verifiedAt: nowSec(),
      evidence: DEEPSEEK_NOT_INTEGRATED_NOTE,
    }
  }

  function unsupported(): CommandOutcome {
    return {
      ok: false,
      status: 'unsupported',
      errorCode: 'AGENT_CAPABILITY_MISSING',
      detail: DEEPSEEK_NOT_INTEGRATED_NOTE,
    }
  }

  // -------------------------------------------------------------------------
  // 九方法 8：startMonitor（无已验证监控源：空句柄，不注册监控任务）
  // -------------------------------------------------------------------------

  function startMonitor(_sink: EventSink): MonitorHandle {
    return {
      providerId: 'deepseek',
      async stop(): Promise<void> {
        /* 无监控任务（未接入） */
      },
    }
  }

  // -------------------------------------------------------------------------
  // 九方法 9：dispose + 诊断投影
  // -------------------------------------------------------------------------

  async function dispose(): Promise<void> {
    /* 无常驻资源 */
  }

  function describeDiagnostics(): ProviderDiagnosticsInfo {
    const probe = probeRoot()
    return {
      dataSource: {
        kind: 'not-connected',
        readable: false,
        detail: probe.exists ? `harness detected (${probe.detail}); no session source wired` : probe.detail,
      },
      control: {
        note: DEEPSEEK_NOT_INTEGRATED_NOTE,
      },
    }
  }

  return {
    id: 'deepseek',
    probeHealth,
    listSessions,
    readMessages,
    getCapabilities,
    sendReply: async () => unsupported(),
    pause: async () => unsupported(),
    resume: async () => unsupported(),
    startMonitor,
    dispose,
    describeDiagnostics,
  }
}
