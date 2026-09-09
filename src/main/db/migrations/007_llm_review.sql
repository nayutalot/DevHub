-- 007_llm_review.sql（LR1 批次：LLM 复核层 advisory-only，docs/briefs/lr1-llm-review.md §7）
--
-- 背景（用户裁决 2026-09-09 恢复 LLM 复核层）：归档前/后复核 envelope 缓存落
-- archive_runs 两列；设计权威 docs/briefs/lr1-llm-review.md，docs/03 §4 条目 8
-- 预告（007 序号 ContestPin 批次跳过、判给 LR1）。
--
-- 只加列 + settings 种子 2 条，零重建、零 UPDATE、零既有列触碰（约束 #21 只追加）：
--   archive_runs.review_pre_json   nullable（归档前复核 envelope 缓存；
--                                   NULL = 从未复核，展示语义等同 skipped。
--                                   LR1 归档执行路径零新增调用，本列 LR2 自动挂
--                                   execute 管线选项启用前恒 NULL——任务书 §4.2）
--   archive_runs.review_post_json  nullable（归档后复核 envelope 缓存；run 详情
--                                   按需触发时写入，命中后不再打端点——任务书 §4.2）
-- settings 种子 2 条（WHERE NOT EXISTS：用户已有值不覆盖）：
--   llm_review_base_url=''（占位 http://<lan-ip>:11434/v1，用户自备局域网端点）
--   llm_review_model=''（默认空 = 停用；双键同设才生效，任一为空即 skipped）
-- v1 零 key 字段（局域网无鉴权）；将来引入鉴权时凭据必须走 safeStorage，
-- 禁止明文写 settings（任务书 §5 红线）。
--
-- 注意：本文件不得包含 PRAGMA user_version（docs/03 §4.3）；
-- migrate.ts 在文件应用成功后以字面量 switch 赋值 user_version = 7。
-- 全部 SQL 为静态字面量（约束 #11：无参数场景，亦无任何拼接）。

-- ------------------------------------------------------------------
-- 7.1 archive_runs 复核 envelope 缓存列（nullable 成对列；既有列语义零变化）
-- ------------------------------------------------------------------
ALTER TABLE archive_runs ADD COLUMN review_pre_json TEXT;
ALTER TABLE archive_runs ADD COLUMN review_post_json TEXT;

-- ------------------------------------------------------------------
-- 7.2 settings 种子（docs/briefs/lr1-llm-review.md §5；WHERE NOT EXISTS：
--     用户已有值不覆盖；默认空 = 停用）
-- ------------------------------------------------------------------
INSERT INTO settings (key, value)
SELECT 'llm_review_base_url', ''
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'llm_review_base_url');

INSERT INTO settings (key, value)
SELECT 'llm_review_model', ''
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'llm_review_model');
