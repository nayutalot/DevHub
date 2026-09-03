# DevHub Agent Control 数据库设计（docs/13）

> Phase 2/3 Agent Control / Mobile 设计，约束基线同 docs/00；migration/历史文档零改动。
> 本文是 AC 域的数据库权威：migration 004 全量 DDL 草案（8 张新表）+ migrate.ts case 4 +
> resources/relationships 登记方案。架构见 docs/12，API 见 docs/14。
> 001 预留表 `devices` / `mcp_servers` 不复用（AC 设备表按用户锁定表名新建
> `remote_devices`）；`skills` / `skill_agents` 已被 Skills 域占用，AC 实体全新建表。

---

## 1. 基本约定（对齐 docs/03 §1 与 003 风格）

- 引擎 `node:sqlite` DatabaseSync（WAL）；`PRAGMA foreign_keys = ON`（connection 级）。
- 主键 `INTEGER PRIMARY KEY`；时间戳 `INTEGER` unix 秒；布尔 `INTEGER` 0/1；
  枚举一律 `TEXT` + 行注释（安全相关枚举另加 CHECK，见 §4.2）。
- 索引命名 `idx_<table>_<col>`；种子数据（若有）`INSERT … SELECT … WHERE NOT EXISTS`。
- **004 是纯追加 migration：只有 CREATE TABLE / CREATE INDEX / settings 种子，
  无 UPDATE、无 DROP、无任何历史表触碰**（旧数据零改动保证，见 §7）。
- migration SQL 文件不得包含 `PRAGMA user_version`（docs/03 §4）；版本号由
  migrate.ts 字面量 switch 赋值。

## 2. migration 004 概览

| 表 | 职责 | 关键约束 |
| --- | --- | --- |
| `agent_providers` | 五家 provider 登记 + 健康 + 能力投影 | provider UNIQUE |
| `agent_sessions` | 统一会话模型（9 值状态 × 3 模式；对外展示用户锁定 7 态） | (provider_id, native_id) UNIQUE；session_mode CHECK |
| `agent_messages` | 消息脱敏投影（完整内容不落库） | (session_id, native_msg_id) UNIQUE |
| `agent_events` | 7 类型事件 + sequence + 投递状态机 | event_id UNIQUE；id AUTOINCREMENT（§4.4） |
| `remote_devices` | 已配对设备（Token 只存哈希） | token_hash 唯一哈希列；status 状态机 |
| `remote_commands` | 设备指令流水（幂等 + 过期） | command_id / idempotency_key 各自 UNIQUE |
| `event_deliveries` | 每 (事件 × 设备) 投递状态 | (event_id, device_id) UNIQUE |
| `security_audit_logs` | 安全审计流水 | 不含任何凭据值（§4.8） |

settings 种子 4 条（WHERE NOT EXISTS）：`gateway_port` / `gateway_enabled` /
`agents_monitor_enabled` / `login_autostart`（§6）。

## 3. migrate.ts 补 case 4（强制，AC0 审计确认的现状缺口）

`src/main/db/migrate.ts:51-65` 的 `setUserVersionLiteral` switch 现只有 case 1/2/3；
**新增 `004_agent_control.sql` 必须补 case 4**，否则运行期显式报错
（`no literal user_version statement registered for migration version 4`）：

```ts
function setUserVersionLiteral(db: DatabaseSync, version: number): void {
  switch (version) {
    case 1: db.exec('PRAGMA user_version = 1'); return
    case 2: db.exec('PRAGMA user_version = 2'); return
    case 3: db.exec('PRAGMA user_version = 3'); return
    case 4: db.exec('PRAGMA user_version = 4'); return   // ← 004 批次（AC2）新增
    default:
      throw new Error(`no literal user_version statement registered for migration version ${version}`)
  }
}
```

文件命名：`src/main/db/migrations/004_agent_control.sql`。fresh 库一次迁到 4；
v3 库升级仅应用 004。smoke 断言：fresh `user_version = 4` + 8 新表存在 + 既有 19 表
数据行数零变化（T1）。

## 4. DDL 草案（004_agent_control.sql 全文设计）

```sql
-- 004_agent_control.sql（AC2 批次：Agent Control / Mobile 数据落地）
--
-- 新表 8 张（全部新建，零重建、零 UPDATE、零历史表触碰）：
--   agent_providers      provider 登记 + 健康 + 能力投影
--   agent_sessions       统一会话模型（9 值状态 × managed/attached/observed；对外展示用户锁定 7 态）
--   agent_messages       消息脱敏投影（完整内容按需从源读取，绝不落库）
--   agent_events         事件 + 全局单调 sequence + 投递状态机
--   remote_devices       已配对远程设备（Token 只存 SHA-256）
--   remote_commands      设备指令流水（幂等键唯一 + expires_at）
--   event_deliveries     每 (事件 × 设备) 投递状态
--   security_audit_logs  安全审计流水（绝不含凭据值）
-- settings 种子 4 条（WHERE NOT EXISTS：用户已有值不覆盖）。
--
-- 注意：本文件不得包含 PRAGMA user_version（docs/03 §4）；
-- migrate.ts 在文件应用成功后以字面量 switch 赋值 user_version = 4（docs/13 §3）。

PRAGMA foreign_keys = ON;

-- ------------------------------------------------------------------
-- 4.1 agent_providers：provider 目录与健康投影（探测产物，非事实源——
--     事实源永远是真实文件系统/进程，skills 先例「缓存投影 + stale 标注」）
-- ------------------------------------------------------------------
CREATE TABLE agent_providers (
  id                INTEGER PRIMARY KEY,
  provider          TEXT    NOT NULL UNIQUE,   -- codex | claude-code | kimi | zcode | deepseek（Grok 预留，docs/12 §11）
  display_name      TEXT    NOT NULL,
  installed         INTEGER NOT NULL DEFAULT 0,
  version           TEXT,
  exe_path          TEXT,                      -- 可执行文件路径（仅展示，绝不存凭据）
  health            TEXT    NOT NULL DEFAULT 'unknown', -- ok | degraded | unavailable | unknown
  health_detail     TEXT,                      -- 结构化降级原因（约束 #26）
  capabilities_json TEXT    NOT NULL DEFAULT '{}', -- CapabilitySet JSON：{mode,granted[],verifiedAt,evidence}
  enabled           INTEGER NOT NULL DEFAULT 1,-- 每 provider 监控开关（总开关在 settings）
  last_probe_at     INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

-- ------------------------------------------------------------------
-- 4.2 agent_sessions：统一会话模型
-- ------------------------------------------------------------------
CREATE TABLE agent_sessions (
  id               INTEGER PRIMARY KEY,
  provider_id      INTEGER NOT NULL REFERENCES agent_providers(id) ON DELETE CASCADE,
  native_id        TEXT    NOT NULL,           -- provider 原生 session ID（幂等业务键）
  session_mode     TEXT    NOT NULL DEFAULT 'observed'
                   CHECK (session_mode IN ('managed','attached','observed')),
                   -- CHECK 而非纯注释枚举：授权矩阵以本列为判定根（docs/15 §5），防脏数据
  project_id       INTEGER REFERENCES projects(id) ON DELETE SET NULL,
                   -- workdir 与 projects.win_path/wsl_path 归一匹配；匹配不上为 NULL（绝不造行）
  workdir          TEXT,
  title            TEXT,
  status           TEXT    NOT NULL DEFAULT 'unknown',
                   -- 用户锁定 7 态：running | completed | failed | waiting_input |
                   --   approval_required（等待工具执行批准）| paused | connection_lost（监控源失联）
                   -- 辅助 2 态（9 值全集）：stopped（有终态记录的正常停止）| unknown（判定未定）
  status_detail    TEXT,
  started_at       INTEGER,
  last_activity_at INTEGER,
  ended_at         INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  UNIQUE(provider_id, native_id)               -- 原生 session ID 唯一约束（upsert 幂等键）
);
CREATE INDEX idx_agent_sessions_provider ON agent_sessions(provider_id);
CREATE INDEX idx_agent_sessions_status   ON agent_sessions(status);
CREATE INDEX idx_agent_sessions_project  ON agent_sessions(project_id);

-- ------------------------------------------------------------------
-- 4.3 agent_messages：消息投影（content 只存脱敏文本；完整上下文按需从
--     provider 源读取——红线：转录中的密钥/Token 绝不落入本表，docs/15 §6）
-- ------------------------------------------------------------------
CREATE TABLE agent_messages (
  id               INTEGER PRIMARY KEY,
  session_id       INTEGER NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  native_msg_id    TEXT,                       -- provider 原生消息 ID（可空：无 ID 的源以行指纹派生）
  role             TEXT    NOT NULL,           -- user | assistant | system | tool
  content_redacted TEXT    NOT NULL,           -- 脱敏后投影（redact.ts 统一实现）
  source_ref       TEXT,                       -- 完整上下文的源指针（文件路径+offset 等，
                                               -- 指向 provider 原始数据而非本库副本，按需加载）
  seq_in_session   INTEGER,                    -- provider 内序号/文件 offset（增量游标）
  occurred_at      INTEGER,
  created_at       INTEGER NOT NULL,
  UNIQUE(session_id, native_msg_id)            -- 增量重读幂等（NULL 不参与去重，由行指纹兜底）
);
CREATE INDEX idx_agent_messages_session ON agent_messages(session_id);

-- ------------------------------------------------------------------
-- 4.4 agent_events：事件表（sequence 全局单调 = AUTOINCREMENT 主键。
--     唯一一处偏离「INTEGER PRIMARY KEY 默认风格」：事件存在未来清理可能，
--     普通 rowid 在删最大行后回绕，破坏 sequence 单调语义（裁决 5），故显式
--     AUTOINCREMENT。delivery_state 状态机：pending → delivered → acked，
--     只前进不回退；未确认（非 acked）事件绝不删除（裁决 5）。
-- ------------------------------------------------------------------
CREATE TABLE agent_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,  -- 即全局 sequence（单调递增，不回绕）
  provider_id    INTEGER REFERENCES agent_providers(id) ON DELETE SET NULL,
  session_id     INTEGER REFERENCES agent_sessions(id) ON DELETE SET NULL,
  event_type     TEXT    NOT NULL,
                 -- session.started | session.status_changed |
                 -- session.waiting_input（输入等待类事件，event_type 名不变；
                 --   payload 必含 status: 'waiting_input' | 'approval_required'）|
                 -- session.finished | message.appended | provider.health_changed | command.result
  event_id       TEXT    NOT NULL UNIQUE,     -- 幂等键：<provider>:<native>:<type>:<内容指纹>
  payload_json   TEXT    NOT NULL,            -- 脱敏后负载
  summary        TEXT,                        -- 通知摘要（≤120 字符，已脱敏）
  delivery_state TEXT    NOT NULL DEFAULT 'pending',  -- pending | delivered | acked
  delivered_at   INTEGER,
  acked_at       INTEGER,
  created_at     INTEGER NOT NULL
);
CREATE INDEX idx_agent_events_session ON agent_events(session_id);
CREATE INDEX idx_agent_events_state   ON agent_events(delivery_state);
CREATE INDEX idx_agent_events_created ON agent_events(created_at);

-- ------------------------------------------------------------------
-- 4.5 remote_devices：已配对设备（不复用 001 devices 预留表）
--     Token 明文绝不入库（红线）：只存 SHA-256(256bit Token)。
-- ------------------------------------------------------------------
CREATE TABLE remote_devices (
  id           INTEGER PRIMARY KEY,
  device_name  TEXT    NOT NULL,
  platform     TEXT    NOT NULL DEFAULT 'android',
  token_hash   TEXT    NOT NULL UNIQUE,        -- SHA-256 hex；明文 Token 仅在 claim/轮换响应中一次性返回
  token_version INTEGER NOT NULL DEFAULT 1,    -- 轮换递增（v1 轮换 = 撤销重配 + WS token_rotation 帧预留，docs/14 §B.5）
  status       TEXT    NOT NULL DEFAULT 'active',  -- active | revoked（撤销即拒，不可复活）
  paired_at    INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at   INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX idx_remote_devices_status ON remote_devices(status);

-- ------------------------------------------------------------------
-- 4.6 remote_commands：指令流水（裁决 5：幂等键唯一 + expires_at 过期）
-- ------------------------------------------------------------------
CREATE TABLE remote_commands (
  id              INTEGER PRIMARY KEY,
  command_id      TEXT    NOT NULL UNIQUE,     -- 对外命令 ID（cmd-<uuid>）
  idempotency_key TEXT    NOT NULL UNIQUE,     -- 客户端幂等键：重试返回原结果；同 key 异 payload 拒绝
  device_id       INTEGER REFERENCES remote_devices(id) ON DELETE SET NULL,
  session_id      INTEGER REFERENCES agent_sessions(id) ON DELETE SET NULL,
  action          TEXT    NOT NULL,            -- reply | pause | resume（手机 v1 全集，docs/11 §7）
  payload_json    TEXT,                        -- 脱敏后负载（reply 文本）
  status          TEXT    NOT NULL DEFAULT 'pending',
                  -- pending | accepted | executed | rejected | expired | failed
  result_json     TEXT,
  error_code      TEXT,                        -- 结构化错误码（docs/14 Part C）
  expires_at      INTEGER NOT NULL,            -- unix 秒；过期 → status=expired，拒绝执行
  created_at      INTEGER NOT NULL,
  executed_at     INTEGER
);
CREATE INDEX idx_remote_commands_status  ON remote_commands(status);
CREATE INDEX idx_remote_commands_session ON remote_commands(session_id);

-- ------------------------------------------------------------------
-- 4.7 event_deliveries：每 (事件 × 设备) 投递状态（WS 补发的依据；
--     与 agent_events.delivery_state 冗余一层设备粒度，聚合态由 L3 维护）
-- ------------------------------------------------------------------
CREATE TABLE event_deliveries (
  id           INTEGER PRIMARY KEY,
  event_id     INTEGER NOT NULL REFERENCES agent_events(id) ON DELETE CASCADE,
  device_id    INTEGER NOT NULL REFERENCES remote_devices(id) ON DELETE CASCADE,
  status       TEXT    NOT NULL DEFAULT 'pending',  -- pending | delivered | acked
  delivered_at INTEGER,
  acked_at     INTEGER,
  created_at   INTEGER NOT NULL,
  UNIQUE(event_id, device_id)
);
CREATE INDEX idx_event_deliveries_device ON event_deliveries(device_id, status);

-- ------------------------------------------------------------------
-- 4.8 security_audit_logs：安全审计（docs/15 §7）。detail_json 绝不含
--     Token 明文/配对码明文/消息全文/任何凭据值（红线）。
-- ------------------------------------------------------------------
CREATE TABLE security_audit_logs (
  id          INTEGER PRIMARY KEY,
  category    TEXT NOT NULL,   -- pairing | auth | command | device | gateway
  action      TEXT NOT NULL,   -- pairing_code_created | pairing_claimed | pairing_code_expired |
                               -- auth_failed | replay_rejected | rate_limited |
                               -- command_accepted | command_rejected | command_executed |
                               -- device_paired | device_revoked | gateway_started | gateway_stopped
  device_id   INTEGER REFERENCES remote_devices(id) ON DELETE SET NULL,
  outcome     TEXT NOT NULL,   -- success | denied | error
  detail_json TEXT,            -- 仅非敏感上下文（来源回环/隧道、限流计数等）
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_security_audit_logs_category ON security_audit_logs(category);
CREATE INDEX idx_security_audit_logs_created  ON security_audit_logs(created_at);
```

## 5. resources / relationships 登记方案

表结构零改动（001 的 `resources.resource_type` / `relationships.relation_type` 本就是
TEXT + 注释枚举）；扩展发生在**代码层联合类型**（`src/main/services/resourceGraph.ts`）：

| 扩展 | 值 | 语义与建边规则（L3 写具体表后同步登记，约束 #20/#22） |
| --- | --- | --- |
| `ResourceType` 扩值 | `'agent'` | agent_providers 行 → 资源节点（display_name = provider 名） |
| | `'session'` | agent_sessions 行 → 资源节点（display_name = `"<provider>:<native_id 短>"`） |
| | `'device'` | remote_devices 行 → 资源节点（display_name = device_name） |
| `RelationType` 扩值 | `'monitors'` | agent → session：该会话处于 provider 主动监控之下（managed / attached） |
| | `'exposes'` | agent → session：被动发现（observed） |
| | `'controls'` | device → session：设备对该会话有成功控制记录（首条 executed 指令时建边；授权矩阵可追溯投影，docs/15 §5） |

与既有枚举（uses / contains / depends_on / located_in）并存；同一 (source, target,
relation_type) 幂等（INSERT OR IGNORE，既有 relate() 语义复用）。session_mode 变化
（如 attached → observed 降级）时由 L3 在同事务内切换 monitors ↔ exposes 边。

## 6. settings 种子（004 内，WHERE NOT EXISTS）

```sql
INSERT INTO settings (key, value) SELECT 'gateway_port', '8746'
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'gateway_port');
INSERT INTO settings (key, value) SELECT 'gateway_enabled', '0'
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'gateway_enabled');
INSERT INTO settings (key, value) SELECT 'agents_monitor_enabled', '1'
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'agents_monitor_enabled');
INSERT INTO settings (key, value) SELECT 'login_autostart', '0'
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'login_autostart');
```

- `gateway_enabled` 默认 **0**：远程面默认关闭，未启用时 Gateway 零监听（docs/15 §3）。
- `agents_monitor_enabled` 默认 1（本机只读监控；关闭即 cancelAll，docs/12 §7）。
- `gateway_port` 默认 8746；被占用 → 8747–8755 顺延尝试，全占则结构化
  GATEWAY_PORT_IN_USE 降级（docs/14 Part C）。
- `settingsService.ALLOWED_KEYS` 同步 6→10（白名单同步是 settings:set 通道的前提）。

## 7. 旧数据零改动保证

1. 004 只含 `CREATE TABLE` / `CREATE INDEX` / `INSERT … SELECT … WHERE NOT EXISTS`
   （仅 settings，4 条新键不存在冲突面）；无 UPDATE / DELETE / DROP / ALTER，
   不触碰 001–003 的任何表与数据（含 devices / mcp_servers 预留表——原样保留，不迁移不删除）。
2. FK 均指向新表或既有 `projects(id)`（ON DELETE SET NULL / CASCADE，不改变 projects 侧行为）。
3. 升级路径：v3 → 仅执行 004；fresh → 001→004 一次到底。smoke T1 双路径断言。
4. `agent_events.id AUTOINCREMENT` 只影响新表，sqlite_sequence 由 SQLite 自动管理。
