-- 008_contestpin.sql（CP1 批次：ContestPin 赛程钉数据落地，docs/22 §2）
--
-- 新表 7 张（全部新建，零重建、零历史表触碰；007 已判给 LR1，ContestPin 从 008 起）：
--   contests              比赛主表（name 必填；year 可空；三入口链接；archived 软归档）
--   contest_nodes         比赛时间节点（kind 枚举 + 自定义；precision 时间精度四值；
--                         raw_text 原文依据；done/done_at 完成标记）
--   contest_reminders     提醒策略（与 precision 分开保存，docs/22 §2.2；
--                         UNIQUE(node_id,offset_kind,offset_value,channel)）
--   contest_reminder_log  补发去重账本（UNIQUE(reminder_id,fire_key)：
--                         跨重启/休眠恢复补发不重复，docs/22 §2.1）
--   contest_materials     材料（sha256 UNIQUE 文件级去重；附件复制到
--                         getDataDir()/contestpin/materials/）
--   contest_import_jobs   识别导入任务（两阶段状态机 imported→…→confirmed +
--                         failed/cancelled；vision_fingerprint 缓存失效指纹）
--   contestpin_configs    识别配置（key_sealed 走 apihub keyStore KeyCrypto envelope，
--                         绝不落明文，docs/22 §6）
-- settings 种子 2 条（WHERE NOT EXISTS：用户已有值不覆盖）：
--   contestpin_default_mode='two_stage'、contestpin_overlay_enabled='0'。
-- 运行期键 contestpin_overlay_state 不种子（service 直写）。
--
-- 注意：本文件不得包含 PRAGMA user_version（docs/03 §4.3）；
-- migrate.ts 在文件应用成功后以字面量 switch 赋值 user_version = 8。
-- 全部 SQL 为静态字面量（约束 #11：无参数场景，亦无任何拼接）。

PRAGMA foreign_keys = ON;

-- ------------------------------------------------------------------
-- 8.1 contests：比赛主表（docs/22 §2.1）
--     status 枚举 CHECK 兜底（运行期白名单在 contestService 双保险）；
--     archived 软归档（列表缺省排除，docs/04 ContestPin 追加节）。
-- ------------------------------------------------------------------
CREATE TABLE contests (
  id            INTEGER PRIMARY KEY,
  name          TEXT    NOT NULL,            -- 比赛名（非空，运行期再校验非空白）
  year          INTEGER,                     -- 可空：缺少年份不编造（docs/22 §2.2）
  edition       TEXT,                        -- 届次（如 "第十七届"）
  organizer     TEXT,                        -- 主办方
  note          TEXT,                        -- 备注
  status        TEXT    NOT NULL DEFAULT 'watching'
                CHECK (status IN ('watching','registered','submitted','completed','given_up')),
  archived      INTEGER NOT NULL DEFAULT 0,  -- 布尔 0/1（docs/03 §1）
  official_site TEXT,                        -- 官网（仅 http/https，运行期校验）
  signup_url    TEXT,                        -- 报名入口（仅 http/https）
  submit_url    TEXT,                        -- 提交入口（仅 http/https）
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_contests_archived ON contests(archived);

-- ------------------------------------------------------------------
-- 8.2 contest_nodes：比赛时间节点（一个比赛多个节点 = 同比赛多截止语义，
--     校内/全国不同截止以 label+raw_text 区分，docs/22 §2.2）
--     precision：'exact'=原文给到时刻；'date'=仅日期（存当日 00:00，提醒与
--     悬浮窗不得按精确时刻处理，识别校验禁止 date→exact 提升）；'month'=仅
--     年月（start_at 取当月 1 日）；'tbd'=时间待定（start_at/end_at NULL）。
--     缺省 'exact'：未显式给精度时按时刻语义，start_at 必填（运行期校验）。
-- ------------------------------------------------------------------
CREATE TABLE contest_nodes (
  id         INTEGER PRIMARY KEY,
  contest_id INTEGER NOT NULL REFERENCES contests(id) ON DELETE CASCADE,
  kind       TEXT    NOT NULL DEFAULT 'custom'
             CHECK (kind IN ('signup_start','signup_deadline','payment_deadline',
                             'contest_start','contest_end','submit_deadline','custom')),
  label      TEXT    NOT NULL,               -- 自定义节点名 / 原文节点名（非空）
  start_at   INTEGER,                        -- unix 秒可空（tbd 恒 NULL）
  end_at     INTEGER,                        -- unix 秒可空；给定时 ≥ start_at（运行期校验）
  tz         TEXT    NOT NULL DEFAULT 'local', -- IANA 名或 'local'（自由文本，不强校验）
  precision  TEXT    NOT NULL DEFAULT 'exact'
             CHECK (precision IN ('exact','date','month','tbd')),
  raw_text   TEXT,                           -- 原文依据（低精度→exact 提升的显式证据）
  done       INTEGER NOT NULL DEFAULT 0,     -- 布尔 0/1；done 后停提醒（CP4 语义）
  done_at    INTEGER,                        -- 完成时刻 unix 秒可空
  source     TEXT    NOT NULL DEFAULT 'manual'
             CHECK (source IN ('manual','imported','agent')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_contest_nodes_contest ON contest_nodes(contest_id);

-- ------------------------------------------------------------------
-- 8.3 contest_reminders：提醒策略（与 precision 分开保存，charter §三裁决；
--     'date' 精度节点 only before_days —— 语义约束由 CP4 引擎承担，本表不区分）
-- ------------------------------------------------------------------
CREATE TABLE contest_reminders (
  id           INTEGER PRIMARY KEY,
  node_id      INTEGER NOT NULL REFERENCES contest_nodes(id) ON DELETE CASCADE,
  offset_kind  TEXT    NOT NULL
               CHECK (offset_kind IN ('before_days','before_hours','at_time')),
  offset_value INTEGER NOT NULL,              -- before_days/before_hours 的 N；at_time 恒 0
  channel      TEXT    NOT NULL
               CHECK (channel IN ('windows','in_app')),
  enabled      INTEGER NOT NULL DEFAULT 1,    -- 布尔 0/1
  last_fired_at INTEGER,                       -- 最近一次触发 unix 秒可空
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE(node_id, offset_kind, offset_value, channel)
);
CREATE INDEX idx_contest_reminders_node ON contest_reminders(node_id);

-- ------------------------------------------------------------------
-- 8.4 contest_reminder_log：补发去重账本（docs/22 §2.1）。fire_key = 到期桶
--     标识，跨重启/休眠恢复补发不重复；CP4 落地使用，表随 008 先行冻结。
-- ------------------------------------------------------------------
CREATE TABLE contest_reminder_log (
  id          INTEGER PRIMARY KEY,
  reminder_id INTEGER NOT NULL REFERENCES contest_reminders(id) ON DELETE CASCADE,
  node_id     INTEGER NOT NULL REFERENCES contest_nodes(id) ON DELETE CASCADE,
  fire_at     INTEGER NOT NULL,               -- 计划触发时刻 unix 秒
  fire_key    TEXT    NOT NULL,               -- 到期桶标识（去重键）
  created_at  INTEGER NOT NULL,
  UNIQUE(reminder_id, fire_key)
);

-- ------------------------------------------------------------------
-- 8.5 contest_materials：材料文件（sha256 UNIQUE：重复文件不重复创建；
--     stored_path 固定在 getDataDir()/contestpin/materials/ 下，docs/22 §2.1）
-- ------------------------------------------------------------------
CREATE TABLE contest_materials (
  id            INTEGER PRIMARY KEY,
  sha256        TEXT    NOT NULL UNIQUE,      -- 文件级去重键（hex）
  original_name TEXT    NOT NULL,
  stored_path   TEXT    NOT NULL,             -- 绝不存密钥/凭据（材料内容文件路径）
  size_bytes    INTEGER,
  pages         INTEGER,                      -- PDF 页数（图片/其他为 NULL）
  kind          TEXT    NOT NULL DEFAULT 'other'
                CHECK (kind IN ('pdf','image','other')),
  imported_at   INTEGER NOT NULL
);

-- ------------------------------------------------------------------
-- 8.6 contestpin_configs：识别配置（docs/22 §6）。key_sealed 只存 apihub
--     keyStore KeyCrypto envelope 密文（生产=safeStorage），绝不落明文；
--     独立于 apihub_profiles（后者语义=切换写外部文件）。
-- ------------------------------------------------------------------
CREATE TABLE contestpin_configs (
  id                  INTEGER PRIMARY KEY,
  name                TEXT    NOT NULL,
  role                TEXT    NOT NULL
                      CHECK (role IN ('vision','text','multimodal')),
  base_url            TEXT    NOT NULL,
  model               TEXT    NOT NULL,
  key_sealed          TEXT,                   -- KeyCrypto envelope JSON 密文（可空 = 无鉴权）
  timeout_ms          INTEGER,
  last_test_at        INTEGER,
  last_test_ok        INTEGER,                -- 布尔 0/1 可空（未测过 NULL）
  last_test_usage_json TEXT,                  -- 实测 usage（仅服务真实返回才标实测）
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  UNIQUE(name, role)
);

-- ------------------------------------------------------------------
-- 8.7 contest_import_jobs：识别导入任务（两阶段状态机，docs/22 §5；
--     CP1 只建表，管线 CP3 落地。stage 九值：imported→preprocessed→
--     vision_done→text_done→validated→draft→confirmed；failed/cancelled
--     可从任一阶段进入）。vision_fingerprint = sha256(材料)+'@'+hash(视觉配置
--     base_url+model)——材料或视觉配置任一变化即重跑视觉。
-- ------------------------------------------------------------------
CREATE TABLE contest_import_jobs (
  id                 INTEGER PRIMARY KEY,
  contest_id         INTEGER REFERENCES contests(id) ON DELETE CASCADE,
                     -- 可空：草稿确认前可能尚无正式比赛行（CP3 语义）
  material_id        INTEGER REFERENCES contest_materials(id) ON DELETE CASCADE,
  mode               TEXT    NOT NULL DEFAULT 'two_stage'
                     CHECK (mode IN ('two_stage','multimodal','agent','manual_pack')),
  stage              TEXT    NOT NULL DEFAULT 'imported'
                     CHECK (stage IN ('imported','preprocessed','vision_done','text_done',
                                      'validated','draft','confirmed','failed','cancelled')),
  vision_config_id   INTEGER REFERENCES contestpin_configs(id) ON DELETE SET NULL,
  text_config_id     INTEGER REFERENCES contestpin_configs(id) ON DELETE SET NULL,
  vision_fingerprint TEXT,                    -- 缓存失效指纹（不含任何凭据值）
  params_json        TEXT,                    -- 处理参数（页范围/跳过文字页等）
  result_json        TEXT,                    -- 结构化识别结果（finding 级来源映射）
  error_json         TEXT,                    -- 结构化错误（约束 #14 同款形状）
  progress           INTEGER,                 -- 0-100 进度（可空 = 未开始/不适用）
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE INDEX idx_contest_import_jobs_material ON contest_import_jobs(material_id);

-- ------------------------------------------------------------------
-- 8.8 settings 种子（docs/22 §2.1；WHERE NOT EXISTS：用户已有值不覆盖）
-- ------------------------------------------------------------------
INSERT INTO settings (key, value) SELECT 'contestpin_default_mode', 'two_stage'
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'contestpin_default_mode');
INSERT INTO settings (key, value) SELECT 'contestpin_overlay_enabled', '0'
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'contestpin_overlay_enabled');
