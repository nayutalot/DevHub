-- 0002_rotation_grace.sql —— token_rotation 300s 宽限（docs/18 §3.14，M3-C3b 修1）
--
-- 契约依据（docs/18-ecs-relay-protocol.md）：
--   §3.14 L356「宽限：旧 Token 自帧发出起 300s 后失效（窗口内旧连接不断）」
--   §9.4  L629「300s 宽限内旧 Token 仍可连；未确认 → 维持新 Token，401 → 重配对路径」
--   §3.0  L108 帧 #14「300s 确认宽限」
-- 语义：rotation 帧受理时，旧 token_hash 原值转入 grace 列（仅 sha256，红线不变），
--   宽限窗口内旧凭据仍可鉴权（三态：窗内旧 200 / 窗外旧 401 RELAY_DEVICE_UNKNOWN /
--   新恒 200）；窗口过期由服务端清扫（README 偏离单 #11）。
--
-- append-only 纪律：只加列，不改 0001 既有列与既有行语义；存量单哈希行 grace 列
-- 为 NULL → 鉴权行为与升级前完全一致（生产库兼容，ECS 复验项）。

ALTER TABLE relay_devices ADD COLUMN grace_token_hash TEXT;    -- 轮换前旧 token sha256（宽限凭据）
ALTER TABLE relay_devices ADD COLUMN grace_expires_at INTEGER; -- 宽限截止（unix 秒 = 帧发出 + 300s）

CREATE INDEX idx_relay_devices_grace ON relay_devices(grace_token_hash);
