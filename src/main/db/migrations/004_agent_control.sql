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

-- ------------------------------------------------------------------
-- 6. settings 种子（docs/13 §6；WHERE NOT EXISTS：用户已有值不覆盖）
--    gateway_enabled 默认 0：远程面默认关闭，未启用时 Gateway 零监听（docs/15 §3）；
--    agents_monitor_enabled 默认 1（本机只读监控；关闭即 cancelAll，docs/12 §7）。
-- ------------------------------------------------------------------
INSERT INTO settings (key, value) SELECT 'gateway_port', '8746'
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'gateway_port');
INSERT INTO settings (key, value) SELECT 'gateway_enabled', '0'
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'gateway_enabled');
INSERT INTO settings (key, value) SELECT 'agents_monitor_enabled', '1'
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'agents_monitor_enabled');
INSERT INTO settings (key, value) SELECT 'login_autostart', '0'
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'login_autostart');
