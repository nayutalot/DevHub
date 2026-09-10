-- 0004_workspace_link_action.sql —— S 批 action 值域扩展（docs/18 §5.3 注记，
--   任务书 §1 #3）：relay_commands.action 七值 → 八值，追加 workspace_link
--   （ZCode 移动遥控链接查询；App 零手工获取、桌面磁盘重建、拉取模型）。
--
-- 契约依据（docs/18-ecs-relay-protocol.md §5.3 注记 + 任务书）：
--   值域扩展零新逻辑分支——ECS 仍纯透传（仅持久化边界脱敏：workspace_link 的
--   command_result.result 内嵌 URL，result_json 落库只记 {provider}，令牌红线）；
--   src/forwarder.ts RELAY_ACTIONS 白名单同步扩展七值 → 八值。扩展后白名单仍是
--   封闭枚举（未知 action 依旧 BAD_PAYLOAD，值域扩展绝不放松防线）。
--
-- append-only 纪律：不改 0001/0002/0003 既有文件。SQLite 无法原地修改 CHECK——按
--   0003 同款标准表重建序：建新表（唯一差异 = action CHECK 八值）→ 逐行复制
--   （存量排队/幂等行全保留，部署升级零命令丢失）→ 换名 → 重建索引。存量行 action
--   均为旧七值，复制后行为与升级前完全一致（生产库兼容，ECS 复验项）。

CREATE TABLE relay_commands_v4 (
  id              INTEGER PRIMARY KEY,
  command_id      TEXT,                             -- Windows 回填
  device_id       INTEGER NOT NULL REFERENCES relay_devices(id) ON DELETE CASCADE,
  idempotency_key TEXT    NOT NULL,
  action          TEXT    NOT NULL CHECK (action IN ('send_message','approve','pause','resume','interrupt','spawn_session','revoke_device','workspace_link')),
  payload_json    TEXT,                             -- 脱敏后（上游 redact 纪律；ECS 原样存储）
  session_ref     TEXT,                             -- '<provider>:<sessionId>' 定位串（可空）
  request_id      TEXT,                             -- 帧级关联（响应回显用）
  payload_fingerprint TEXT NOT NULL,                -- action+sessionId+payload 指纹（同 key 异 payload → COMMAND_KEY_CONFLICT）
  status          TEXT    NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','acked','accepted','executed','rejected','expired','failed')),
  requested_at    INTEGER NOT NULL,
  acked_at        INTEGER,
  result_at       INTEGER,
  result_json     TEXT,                             -- 持久化投影（workspace_link 的 result 由 forwarder 脱敏为 {provider}）
  UNIQUE(device_id, idempotency_key)                -- 幂等根（docs/18 §3.9）
);

INSERT INTO relay_commands_v4 (
  id, command_id, device_id, idempotency_key, action, payload_json, session_ref,
  request_id, payload_fingerprint, status, requested_at, acked_at, result_at, result_json
) SELECT
  id, command_id, device_id, idempotency_key, action, payload_json, session_ref,
  request_id, payload_fingerprint, status, requested_at, acked_at, result_at, result_json
FROM relay_commands;

DROP TABLE relay_commands;
ALTER TABLE relay_commands_v4 RENAME TO relay_commands;
CREATE INDEX idx_relay_commands_status ON relay_commands(status);
