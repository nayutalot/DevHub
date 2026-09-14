/**
 * kimiManagedConfig.ts — kimi 真机 managed 面授权门（KM 批
 * docs/briefs/km-kimi-managed.md Phase B；对齐 zcodeManagedConfig 先例：settings
 * 键默认停用、每调用读取（运行期翻转即时生效，无需重启）、结构化 reason 零凭据、
 * 键=0 时 provider 行为与未接线逐字节一致）。
 *
 * 授权链（known-limitations §1.5：managed 通道代码+夹具验证全就位，唯一缺口=真机
 * 端到端；用户 2026-09-14 令「推进 kimicode 适配」= 等待解除）：
 * - settings 键 `kimi_managed_enabled` 值恰为 '1' = 允许真机 managed：
 *   getCapabilities 授 managed+reply（evidence 带真实 CLI 版本，zcode doctor 先例：
 *   存活探测+配置就绪 → managed；回合级真实验证由真实 sendReply 承担——一次性
 *   -p 探测必然消耗推理并产生垃圾会话，绝不作为 caps 探测面）；sendReply 走一次性
 *   argv 通道 `kimi -S <sessionId> -p <prompt> --output-format stream-json`
 *   （Phase A 0.42.0 实测：TUI+管道 stdin 有 workspace 信任门+TTY 依赖，不可托管；
 *   一次性 argv 是唯一已验证形态；resume 落同一 wire.jsonl（turnId 增量），
 *   state.json lastTurnReason 终态线索与 0.36 假设兼容）；
 * - 缺行/非 '1' = 停用：provider 保持 observed+空集+evidence 如实（默认态绝不半开）；
 * - 真机语义（本键存在的理由）：真实推理消耗 + ~/.kimi-code 写入必然发生——默认
 *   停用，用户显式授权后才发生（可撤销：键回 0 即回归 observed）。
 *
 * 红线：零凭据——kimi CLI 用自己的 ~/.kimi-code/config.toml，DevHub 不读不写不注入
 * 任何 key（api_key 红线，maskKey 尾 4 位纪律不涉本模块：本模块零 config 内容读取）；
 * 本模块零 env 读取（KIMI_CODE_HOME 重定向面 Phase A 已侦察但生产不用——home 边界
 * 复用 kimiProvider 同款 homedir()/.kimi-code）；零日志零 console；reason 只含静态
 * 字面量+键名。Mimosa 纪律：命名避开 `.request(` 形态。
 * electron-free；纯 Node 可加载。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { getSetting } from '../../settingsService.ts'

/** settings 键名（KM 批 Phase B；ALLOWED_KEYS 白名单 19→20）。 */
export const KIMI_MANAGED_ENABLED_SETTING_KEY = 'kimi_managed_enabled'

/**
 * 真机 managed 一次性回复 argv 模板（Phase A kimi 0.42.0 实测复核值）：
 * - `-S {sessionId}`：resume 指定会话（session_index.jsonl 的 sessionId；
 *   实测 resume 不建新会话，turn 增量落同一 wire.jsonl）；
 * - `-p {prompt}`：一次性非交互 prompt（provider 把 {prompt} 替换为回复全文，
 *   单 argv 原样传递——参数数组无 shell，零注入面）；
 * - `--output-format stream-json`：stdout NDJSON 事件流（system.version/
 *   turn.step.retrying 等实时输出）——喂 spawnManaged 心跳空闲计时，网络重试
 *   （0.42 实测退避可达 ~34s）不再触发 idle 树杀。
 * 占位符由 kimiProvider 全量替换；本常量只读导出（smoke 断言占位符形态用）。
 */
export const KIMI_MANAGED_REPLY_TEMPLATE: readonly string[] = [
  '-S', '{sessionId}',
  '-p', '{prompt}',
  '--output-format', 'stream-json',
]

/**
 * 真机 managed 托管启动（spawn_session）一次性 argv 模板（KC 批，
 * docs/briefs/kc-kimi-spawn.md；docs/18 §5.3 spawn_session 契约面）：新会话无
 * `{sessionId}` 可占——与已验证 resume 模板（KIMI_MANAGED_REPLY_TEMPLATE）同源
 * 少 `-S {sessionId}` 段，`-p {prompt}` 携带 spawn 表单的首条任务文本（契约必带，
 * task 非空 ≤4000）。占位符 {prompt} 由 kimiProvider 全量替换；本常量只读导出。
 * 显式常量而非从 replyTemplate 推导：模板演进不静默漂移（显式 > 隐式）。
 */
export const KIMI_MANAGED_SPAWN_TEMPLATE: readonly string[] = [
  '-p', '{prompt}',
  '--output-format', 'stream-json',
]

/**
 * 授权门开启时的托管进程超时（覆盖 provider 默认）：idle 60s（Phase A 实测重试
 * 退避上限 ~34s，默认 15s 会误杀网络抖动中的真实回合）；总生命周期 300s（一次性
 * 最小 prompt 回合的宽裕上限；超时即树杀→结构化失败，不存在无超时状态）。
 */
export const KIMI_MANAGED_IDLE_TIMEOUT_MS = 60_000
export const KIMI_MANAGED_LIFETIME_TIMEOUT_MS = 300_000

/** 授权门状态（kimiProvider.options.managedGate 的返回形态；纯数据零凭据）。 */
export interface KimiManagedGateState {
  enabled: boolean
  /** 停用原因（零凭据：静态字面量+键名；enabled=true 时缺省）。 */
  reason?: string
  /** 一次性回复 argv 模板（enabled=true 必有；{sessionId}/{prompt} 占位符）。 */
  replyTemplate?: string[]
  /**
   * 托管启动（spawn_session）一次性 argv 模板（enabled=true 必有；KC 批新增，
   * {prompt} 占位符=spawn 表单首条任务文本；无 {sessionId}——新会话由 kimi 物化）。
   */
  spawnTemplate?: string[]
  /** 托管进程心跳空闲超时（enabled=true 必有；理由见常量注）。 */
  managedIdleTimeoutMs?: number
  /** 托管进程总生命周期上限（enabled=true 必有）。 */
  managedLifetimeTimeoutMs?: number
  /** kimi home（默认 ~/.kimi-code；evidence 路径用，零凭据）。 */
  kimiHome?: string
}

/**
 * settings 门读取（每调用读；trim 后必须恰为 '1' 才算授权——'true'/'yes' 等
 * 一律停用，绝不宽松解析；getSetting 对白名单外键抛错，本键在白名单内）。
 */
export function readKimiManagedGate(deps?: { kimiHome?: string }): KimiManagedGateState {
  const raw = (getSetting(KIMI_MANAGED_ENABLED_SETTING_KEY) ?? '').trim()
  if (raw !== '1') {
    return {
      enabled: false,
      reason: `settings key ${KIMI_MANAGED_ENABLED_SETTING_KEY} is not '1' (managed face disabled by default)`,
    }
  }
  const kimiHome = deps?.kimiHome ?? join(homedir(), '.kimi-code')
  return {
    enabled: true,
    replyTemplate: [...KIMI_MANAGED_REPLY_TEMPLATE],
    spawnTemplate: [...KIMI_MANAGED_SPAWN_TEMPLATE],
    managedIdleTimeoutMs: KIMI_MANAGED_IDLE_TIMEOUT_MS,
    managedLifetimeTimeoutMs: KIMI_MANAGED_LIFETIME_TIMEOUT_MS,
    kimiHome,
  }
}
