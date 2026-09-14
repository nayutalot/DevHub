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
 * docs/19 §2.2 红线）/
 * contestpin_default_mode / contestpin_overlay_enabled / contestpin_overlay_state
 * （CP1：008 种子两键 + 运行期键，docs/22 §2.1）/
 * llm_review_base_url / llm_review_model（LR1：007 种子两键，默认空 = 停用，
 * 双键同设才生效；docs/briefs/lr1-llm-review.md §5，白名单 16→18）/
 * zcode_managed_model（T2 批：zcode 托管面模型键，值 = 完整 "provider/model" 串，
 * 默认缺行 = 停用——llm_review 双键「默认空 = 停用绝不半开」先例；docs/
 * briefs/t2-zcode-managed.md 主控定案 #1。无种子行、零 migration：settings 键值对
 * 表既有机制，缺行 = 空 = 托管面停用，caps 保持 observed，白名单 18→19）；
 * kimi_managed_enabled（KM 批，20→上文）+ deepseek_managed_enabled /
 * deepseek_managed_model（DM 批：DeepSeek Harness 真机 managed 授权门+可选模型
 * 路由键，恰 '1' 授权默认停用；白名单 20→22，docs/briefs/dm-dsh-managed.md §1.2）/
 * deepseek_managed_workspace（DSW 批：DeepSeek managed 托管会话工作区生产旋钮，
 * docs/briefs/dsw-workspace.md §1——缺行 = 默认安全目录 <data>/dsh-workspace
 * （paths 边界解析、DEVHUB_HOME 策略感知、按需创建、绝不默认 home 根——run3
 * Windows ACL 确定性失败教训）；显式键必须指向已存在目录（不存在 = 结构化拒绝，
 * 绝不静默创建）。白名单 22→23）；
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
  // CP1 批次（ContestPin，docs/22 §2.1）：default_mode/overlay_enabled 为 008 种子
  // （'two_stage'/'0'）；overlay_state 为运行期键（悬浮窗 bounds+collapsed JSON，
  // contestService 直写，不经 renderer settings:set）
  'contestpin_default_mode',
  'contestpin_overlay_enabled',
  'contestpin_overlay_state',
  // LR1 批次（LLM 复核层 advisory-only，docs/briefs/lr1-llm-review.md §5）：
  // 007 种子的两键，默认空 = 停用，双键同设才生效（任一为空即 skipped 态）。
  // v1 零 key 字段（局域网自备端点无鉴权）；将来引入鉴权时凭据必须走
  // safeStorage 封装存储，禁止明文写 settings（任务书 §5 红线）
  'llm_review_base_url',
  'llm_review_model',
  // T2 批（zcode 真托管 provider，docs/briefs/t2-zcode-managed.md 主控定案 #1）：
  // 模型键 = 完整 "provider/model" 串；缺行 = 空 = 托管面停用（caps 保持 observed）。
  // 凭据绝不入 settings——apiKey 走 ApiHub zcode 活动档案（safeStorage 封装）。
  'zcode_managed_model',
  // KM 批（kimi 真机 managed 通道授权门，docs/briefs/km-kimi-managed.md Phase B）：
  // 值恰为 '1' = 用户显式授权真机 managed（真实推理 + ~/.kimi-code 写入，09-14
  // 「推进 kimicode 适配」令 = §1.5 等待解除）；缺行/'0' = 停用（caps 保持
  // observed，provider 行为与未接线逐字节一致）。默认 0 = 停用绝不半开；零凭据
  // 语义（kimi CLI 用自己的 config.toml，DevHub 零注入）。无种子行零迁移。19→20。
  'kimi_managed_enabled',
  // DM 批（DeepSeek Harness 真机 managed 通道，docs/briefs/dm-dsh-managed.md §1.2；
  // kimi_managed_enabled 同构先例）：enabled 值恰为 '1' = 授权（真实推理 +
  // ~/.dsh 会话写入；缺行/'0'/'true' 等一律停用，绝不宽松解析）；model 为可选
  // "provider/model" 路由键（缺行 = runtime 默认 deepseek-official/deepseek-v4-flash，
  // 形态不符 = 结构化拒绝）。凭据三零（harness credential seam 自取
  // ~/.dsh/.credentials.yaml，DevHub 零读取零注入）；无种子行零迁移。20→22。
  'deepseek_managed_enabled',
  'deepseek_managed_model',
  // DSW 批（DeepSeek managed 托管会话工作区生产旋钮，docs/briefs/dsw-workspace.md §1；
  // run3 阻断修复：spawn cwd/workspaceRoot 默认曾=用户 home 根 → dsh 沙箱 temp-root
  // 撞 Windows ACL → initialize 30s 超时）：缺行 = 默认安全目录 <data>/dsh-workspace
  // （paths 边界解析 DEVHUB_HOME 感知；按需创建；绝不默认 home 根）；显式键 =
  // 用户自管已存在目录（不存在 = 结构化拒绝绝不静默创建）。零凭据语义（目录路径
  // 非凭据）；无种子行零迁移。22→23。
  'deepseek_managed_workspace',
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
