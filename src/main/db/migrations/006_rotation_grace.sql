-- 006_rotation_grace.sql（M3-C7b 修 ②：桌面镜像 ECS 300s 轮换宽限，docs/18 §3.14）
--
-- 背景（C2d 实证，任务书 §1 #2）：remote_devices 此前只有单 token_hash 列，
-- 轮换（rotateDeviceToken 覆盖 + token_version+1）即刻作废旧 Token → 宽限窗内
-- 设备仍持 v1 → 命令帧面 AUTH_INVALID_TOKEN 阻断（R-B5/R-B4 根因）。docs/18
-- §3.14 裁决宽限 = 旧 Token 自 token_rotation 帧发出起 300s 后失效（窗内旧值
-- 仍认、窗外拒；无轮换恒认新值），ECS 侧已实现，本批补桌面镜像半边。
--
-- 只加列 + 加索引，零重建、零 UPDATE、零既有列触碰（约束 #21 只追加 / append-only）：
--   remote_devices.previous_token_hash  nullable（轮换前一版 Token 的 SHA-256 hex；
--                                       NULL = 该设备从未轮换 → 恒只认当前 token_hash）
--   remote_devices.rotated_at           nullable（最近一次轮换时刻 unix 秒；
--                                       与 previous_token_hash 成对写入）
-- 窗口判定归 gateway/auth.ts（ROTATION_GRACE_SEC = 300，docs/18 §3.14 权威值）：
-- 旧哈希命中且 (now - rotated_at) ≤ 300 → 放行；窗外 → AUTH_INVALID_TOKEN；
-- 撤销即拒优先级不变（docs/15 §4）。
--
-- 注意：本文件不得包含 PRAGMA user_version（docs/03 §4）；
-- migrate.ts 在文件应用成功后以字面量 switch 赋值 user_version = 6（docs/13 §3）。

-- ------------------------------------------------------------------
-- 轮换宽限镜像（nullable 成对列；单哈希主值 token_hash 语义零变化）
-- ------------------------------------------------------------------
ALTER TABLE remote_devices ADD COLUMN previous_token_hash TEXT;
ALTER TABLE remote_devices ADD COLUMN rotated_at INTEGER;
CREATE INDEX idx_remote_devices_prev_token_hash ON remote_devices(previous_token_hash);
