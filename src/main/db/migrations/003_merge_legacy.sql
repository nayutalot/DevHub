-- 003_merge_legacy.sql (S1 批次：SkillVault + ArchiveKeeper 功能合并的数据落地)
--
-- 新表 5 张（skills / apihub / versions / archive 四个合并域）：
--   skill_agents      registry.json v2 的 agents 元数据（唯一事实源迁入 SQLite）
--   skill_links       (agent, skill) 链接状态缓存（doctor 扫描产物，非事实源）
--   apihub_profiles   接口中心档案（key 为 safeStorage 密文，needs_rekey 标记待重加密）
--   version_targets   版本中心 8 目标检测快照（catalog 目录是代码常量，表只存状态）
--   archive_runs      归档历史流水（老 history 迁入；上限 100 由 service 层维护）
-- 重建扩列 2 张（002 同款 CREATE -> INSERT SELECT -> DROP -> RENAME，append-only 合同）：
--   skills            + vault_rel_path / frontmatter_json（vault 镜像与 frontmatter 缓存）
--   archives          + run_id / old_path（关联归档流水与原始位置）
-- settings 种子 2 条（WHERE NOT EXISTS：用户已有值不覆盖）：
--   vault_path        SkillVault 中心 vault 根
--   archive_dest_root 归档目标根（空 = 未设置，UI 引导）
--
-- 注意：本文件不得包含 PRAGMA user_version（docs/03 §4.3）；
-- migrate.ts 在文件应用成功后以字面量 switch 赋值 user_version = 3。

PRAGMA foreign_keys = ON;

-- ------------------------------------------------------------------
-- 5.1 skill_agents：AI agent harness 登记表（registry.json v2 agents）
-- ------------------------------------------------------------------
CREATE TABLE skill_agents (
  id           INTEGER PRIMARY KEY,
  name         TEXT    NOT NULL UNIQUE,   -- agent 业务名，如 zcode-win / codex-win
  platform     TEXT    NOT NULL,          -- windows | linux
  skills_dir   TEXT    NOT NULL,          -- 该 agent 的 skills 目录（Windows 盘符或 WSL POSIX 路径）
  agents_dir   TEXT,                      -- 子智能体共享目录（v1 数据缺省为 NULL）
  include_json TEXT    NOT NULL,          -- include 白名单 JSON（["*"] 或技能名数组）
  enabled      INTEGER NOT NULL DEFAULT 1,-- 0 = 停用（doctor/toggle 跳过，不删行）
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- ------------------------------------------------------------------
-- 5.2 skills 重建扩列：+ vault_rel_path / frontmatter_json
-- ------------------------------------------------------------------
CREATE TABLE skills_v3 (
  id              INTEGER PRIMARY KEY,
  name            TEXT    NOT NULL UNIQUE,
  source_path     TEXT,                    -- 非 vault 来源的发现位置（vault 镜像行为 NULL）
  vault_rel_path  TEXT,                    -- vault 内相对路径（skills/<name>）
  frontmatter_json TEXT,                   -- SKILL.md frontmatter 解析结果 JSON
  description     TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

INSERT INTO skills_v3 (id, name, source_path, vault_rel_path, frontmatter_json, description, created_at, updated_at)
SELECT id, name, source_path, NULL, NULL, description, created_at, updated_at
FROM skills;

DROP TABLE skills;

ALTER TABLE skills_v3 RENAME TO skills;

-- ------------------------------------------------------------------
-- 5.3 skill_links：链接状态缓存（事实源永远是真实文件系统）
-- ------------------------------------------------------------------
CREATE TABLE skill_links (
  id         INTEGER PRIMARY KEY,
  agent_id   INTEGER NOT NULL REFERENCES skill_agents(id) ON DELETE CASCADE,
  skill_id   INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  state      TEXT    NOT NULL,             -- linked | missing | wrong-target | real-dir | vault-missing
  checked_at INTEGER NOT NULL,
  UNIQUE(agent_id, skill_id)
);

CREATE INDEX idx_skill_links_agent ON skill_links(agent_id);
CREATE INDEX idx_skill_links_skill ON skill_links(skill_id);

-- ------------------------------------------------------------------
-- 5.4 apihub_profiles：接口中心档案（key 全值绝不出现于 IPC/MCP/日志）
-- ------------------------------------------------------------------
CREATE TABLE apihub_profiles (
  id             INTEGER PRIMARY KEY,
  name           TEXT    NOT NULL UNIQUE,  -- 全局唯一；导入冲突时以 <provider>/<name> 去重
  provider       TEXT    NOT NULL,         -- claude-cli | claude-desktop | codex | grok | kimi | zcode | deepseek
  encrypted_blob BLOB,                     -- JSON envelope {v,sealed,fields,plainStore?} 的 UTF-8 字节
  needs_rekey    INTEGER NOT NULL DEFAULT 0, -- 1 = 老 DPAPI blob 待 S3 重加密（禁止切换动作）
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

-- ------------------------------------------------------------------
-- 5.5 version_targets：版本中心检测快照（catalog 是代码常量）
-- ------------------------------------------------------------------
CREATE TABLE version_targets (
  id                INTEGER PRIMARY KEY,
  key               TEXT    NOT NULL UNIQUE, -- catalog id：claude-code-npm / codex-desktop / zcode / ...
  display_name      TEXT    NOT NULL,
  kind              TEXT    NOT NULL,        -- npm | winget | native | arp | github
  installed_version TEXT,
  target_version    TEXT,
  state             TEXT    NOT NULL DEFAULT 'unknown', -- up-to-date | upgradable | unknown | check-failed | detect-only
  last_checked_at   INTEGER
);

-- ------------------------------------------------------------------
-- 5.6 archive_runs：归档历史流水（老 history[] 迁入；上限 100）
-- ------------------------------------------------------------------
CREATE TABLE archive_runs (
  id             INTEGER PRIMARY KEY,
  project_id     INTEGER REFERENCES projects(id) ON DELETE SET NULL, -- 路径归一匹配关联；匹配不上为 NULL
  project_name   TEXT    NOT NULL,
  old_path       TEXT    NOT NULL,
  new_path       TEXT    NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'done', -- running | done | failed | rolled-back
  fixed_files    INTEGER NOT NULL DEFAULT 0,
  external_files INTEGER NOT NULL DEFAULT 0,
  residual_hits  INTEGER NOT NULL DEFAULT 0,
  stripped_json  TEXT,                            -- 剥离的可再生日录名数组 JSON（老数据为 NULL）
  started_at     INTEGER NOT NULL,
  finished_at    INTEGER
);

CREATE INDEX idx_archive_runs_project ON archive_runs(project_id);

-- ------------------------------------------------------------------
-- 5.7 archives 重建扩列：+ run_id / old_path
-- ------------------------------------------------------------------
CREATE TABLE archives_v3 (
  id           INTEGER PRIMARY KEY,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  archive_path TEXT    NOT NULL,
  run_id       INTEGER REFERENCES archive_runs(id) ON DELETE SET NULL,
  old_path     TEXT,
  size_bytes   INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

INSERT INTO archives_v3 (id, project_id, archive_path, run_id, old_path, size_bytes, created_at, updated_at)
SELECT id, project_id, archive_path, NULL, NULL, size_bytes, created_at, updated_at
FROM archives;

DROP TABLE archives;

ALTER TABLE archives_v3 RENAME TO archives;

CREATE INDEX idx_archives_project ON archives(project_id);

-- ------------------------------------------------------------------
-- 5.8 settings 种子（不覆盖用户已有值）
-- ------------------------------------------------------------------
INSERT INTO settings (key, value)
SELECT 'vault_path', 'C:\Users\sakuya\SkillVault'
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'vault_path');

INSERT INTO settings (key, value)
SELECT 'archive_dest_root', ''
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'archive_dest_root');
