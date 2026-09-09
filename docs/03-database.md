# DevHub 数据库设计（Phase 1）

## 1. 基本约定

- 引擎：Electron 内置 `node:sqlite` 的 `DatabaseSync`（同步 API，零原生编译依赖）。
- 方言：SQLite。启用 `PRAGMA foreign_keys = ON;`（connection 级）。
- 主键：`id INTEGER PRIMARY KEY`（rowid 别名，自动递增语义）。
- 时间戳：`created_at` / `updated_at` 等一律 `INTEGER`，存 unix 秒。
- 布尔：`INTEGER` 0/1。
- **SQL 一律参数绑定**（`?` + 参数数组）；唯一例外 `PRAGMA user_version = N` 用字面量（约束 #11）。
- migration：`src/main/db/migrations/001_init.sql` 起，只追加不修改（约束 #21）；
  版本读取 `PRAGMA user_version`，应用后以字面量写入对应版本号。

## 2. 表清单（14 张）

Phase 1 实现业务逻辑的表：projects、repositories、environments、environment_tools、services、containers、scans、settings、resources、relationships。
Phase 1 **只建表不实现功能**（为后续 Phase 预留）：devices、skills、mcp_servers、archives。

## 3. DDL（001_init.sql 全文设计）

```sql
PRAGMA foreign_keys = ON;

-- 3.1 项目（一等公民）
CREATE TABLE projects (
  id             INTEGER PRIMARY KEY,
  name           TEXT    NOT NULL UNIQUE,
  slug           TEXT    NOT NULL,
  description    TEXT,
  win_path       TEXT,
  wsl_path       TEXT,
  runtime_hint   TEXT,
  last_opened_at INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  CHECK (win_path IS NOT NULL OR wsl_path IS NOT NULL)
);
CREATE UNIQUE INDEX idx_projects_slug    ON projects(slug);
CREATE INDEX        idx_projects_opened  ON projects(last_opened_at DESC);

-- 3.2 Git 仓库（project contains repository）
CREATE TABLE repositories (
  id             INTEGER PRIMARY KEY,
  project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  remote_url     TEXT,
  branch         TEXT,
  head_sha       TEXT,
  is_dirty       INTEGER NOT NULL DEFAULT 0,
  ahead          INTEGER NOT NULL DEFAULT 0,
  behind         INTEGER NOT NULL DEFAULT 0,
  last_status_at INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX idx_repositories_project ON repositories(project_id);

-- 3.3 环境（Windows 本机 / WSL 发行版）
CREATE TABLE environments (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL UNIQUE,   -- 'windows' | 'wsl:Ubuntu'
  kind        TEXT    NOT NULL,          -- 'windows' | 'wsl'
  os_version  TEXT,
  detected_at INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- 3.4 环境内的工具链检测明细
CREATE TABLE environment_tools (
  id             INTEGER PRIMARY KEY,
  environment_id INTEGER NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  tool           TEXT    NOT NULL,       -- 'node' | 'npm' | 'pnpm' | 'python' | 'git' | 'docker' | 'cmake' | 'gcc' | 'vscode' | ...
  version        TEXT,
  path           TEXT,
  state          TEXT    NOT NULL DEFAULT 'missing',  -- installed | missing | error
  raw_version    TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  UNIQUE(environment_id, tool)
);
CREATE INDEX idx_env_tools_env ON environment_tools(environment_id);

-- 3.5 服务 / 端口占用（port -> process -> environment -> project 归因链）
CREATE TABLE services (
  id            INTEGER PRIMARY KEY,
  port          INTEGER NOT NULL,
  protocol      TEXT    NOT NULL DEFAULT 'tcp',   -- tcp | udp
  pid           INTEGER,
  process_name  TEXT,
  command_line  TEXT,
  working_dir   TEXT,
  origin        TEXT    NOT NULL,        -- windows | wsl | docker
  project_id    INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);
CREATE INDEX idx_services_port    ON services(port);
CREATE INDEX idx_services_project ON services(project_id);

-- 3.6 Docker 容器（project uses container）
CREATE TABLE containers (
  id         INTEGER PRIMARY KEY,
  docker_id  TEXT    NOT NULL UNIQUE,     -- container id (12 hex)
  name       TEXT    NOT NULL,
  image      TEXT,
  state      TEXT,                        -- running | exited | paused | ...
  ports_json TEXT,                        -- JSON: [{"host":8080,"container":80,"proto":"tcp"}]
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_containers_project ON containers(project_id);

-- 3.7 远程设备（Phase 1 只建表）
CREATE TABLE devices (
  id                INTEGER PRIMARY KEY,
  name              TEXT    NOT NULL,
  host              TEXT,
  user              TEXT,
  kind              TEXT,                 -- ssh | wsl | ...
  last_connected_at INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

-- 3.8 Skills（Phase 1 只建表）
CREATE TABLE skills (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL UNIQUE,
  source_path TEXT,
  description TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- 3.9 MCP servers（Phase 1 只建表）
CREATE TABLE mcp_servers (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL UNIQUE,
  command     TEXT,
  config_path TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- 3.10 项目归档（Phase 1 只建表）
CREATE TABLE archives (
  id           INTEGER PRIMARY KEY,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  archive_path TEXT    NOT NULL,
  size_bytes   INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX idx_archives_project ON archives(project_id);

-- 3.11 通用资源注册（Resource Graph 预留，见 docs/05-resource-model.md）
CREATE TABLE resources (
  id            INTEGER PRIMARY KEY,
  resource_type TEXT    NOT NULL,          -- project | repository | environment | service | container | ...
  ref_id        INTEGER NOT NULL,          -- 对应类型表内的 id
  display_name  TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE(resource_type, ref_id)
);
CREATE INDEX idx_resources_type ON resources(resource_type);

-- 3.12 资源关系（有向边）
CREATE TABLE relationships (
  id                 INTEGER PRIMARY KEY,
  source_resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  target_resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  relation_type      TEXT    NOT NULL,     -- uses | contains | depends_on | located_in
  created_at         INTEGER NOT NULL,
  UNIQUE(source_resource_id, target_resource_id, relation_type)
);
CREATE INDEX idx_relationships_source ON relationships(source_resource_id);
CREATE INDEX idx_relationships_target ON relationships(target_resource_id);

-- 3.13 扫描历史
CREATE TABLE scans (
  id            INTEGER PRIMARY KEY,
  kind          TEXT    NOT NULL,           -- full | projects | services | environment
  root_path     TEXT,
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  status        TEXT    NOT NULL DEFAULT 'running',  -- running | done | cancelled | failed
  found_count   INTEGER NOT NULL DEFAULT 0,
  error_summary TEXT
);
CREATE INDEX idx_scans_status ON scans(status);

-- 3.14 设置（KV）
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT    NOT NULL
);

-- 种子数据
INSERT INTO settings (key, value) VALUES
  ('scan_root', 'F:\Active_Project'),
  ('theme', 'dark');

-- 注意：migration SQL 文件不得包含 PRAGMA user_version（§4.3），
-- 版本号由 migrate.ts 的字面量 switch 在事务内赋值。
```

## 4. migration 机制

1. 启动时读 `PRAGMA user_version`（当前版本 V）。
2. 按 001、002、… 序号顺序应用所有编号 > V 的 `.sql` 文件，每个文件在单个事务内执行。
3. migration SQL 文件**不得**包含 `PRAGMA user_version`；版本号由 migrate.ts 以字面量 switch 统一管理（文件执行成功后由 runner 赋值，见约束 #11 唯一例外）。
4. **已应用的文件永不修改**；schema 变更一律新增文件（约束 #21）。
5. Step 3 验收：smoke 断言新建库 `user_version = 1` 且 14 张表全部存在（Step 5 起 fresh 库直接迁到 2）。
6. `002_env_tools_unique.sql`（Step 5）：`environment_tools` 的 UNIQUE 约束从
   `(environment_id, tool)` 放宽为 `(environment_id, tool, path)`——以重建表方式迁移
   （CREATE 新表 → INSERT SELECT 按 `(environment_id, tool, path)` 去重取 MIN(id) →
   DROP 旧表 → RENAME），支持 Windows 同名工具多解释器并存（如 Python 3.9 / 3.13 各占一行，
   以 path 区分）。`PRAGMA user_version = 2` 由 migrate.ts 字面量赋值。
7. `003_merge_legacy.sql`（S1 批次，功能合并）：新表 5 张——
   `skill_agents`（registry.json v2 agents 元数据，name UNIQUE，include_json 白名单）、
   `skill_links`（(agent_id, skill_id) UNIQUE 链接状态缓存，LinkState 五态）、
   `apihub_profiles`（name UNIQUE，encrypted_blob 为 JSON envelope 密文，needs_rekey 标记）、
   `version_targets`（key UNIQUE = 版本目录 id，检测快照）、
   `archive_runs`（归档历史流水，project_id 可空外键，历史上限 100 由 service 维护）；
   重建扩列 2 张（002 同款 CREATE → INSERT SELECT → DROP → RENAME）——
   `skills` + `vault_rel_path` / `frontmatter_json`，`archives` + `run_id` / `old_path`；
   settings 种子 `vault_path`（SkillVault 根）与 `archive_dest_root`（空 = 未设置），
   均带 WHERE NOT EXISTS 不覆盖用户已有值。
   `PRAGMA user_version = 3` 由 migrate.ts 字面量赋值。表结构全文见
   `src/main/db/migrations/003_merge_legacy.sql`；模块设计见 docs/09、docs/10。
   S1 起 fresh 库一次迁到 3；v2 库升级仅应用 003 且既有数据保留。
8. **migration 007（预告，LR1 待落地）**：`ALTER TABLE archive_runs ADD COLUMN
   review_pre_json TEXT` 与 `ADD COLUMN review_post_json TEXT`（均可空，LLM 复核
   envelope 缓存；append-only，不改既有迁移）——设计见 docs/briefs/lr1-llm-review.md
   （硬门：M3-D 72h 终报通过后开工）。
9. **migration 008（预告，ContestPin 待落地）**：赛程钉比赛模块 7 张新表——
   `contests`（名称/届次/主办方/参赛状态/三入口链接/archived）、`contest_nodes`
   （多时间节点：kind 枚举+自定义、start/end unix 秒可空、tz、precision 枚举
   exact/date/month/tbd、raw_text 原文依据、done、source）、`contest_reminders`
   （提醒策略，与 precision 分开保存；UNIQUE(node,offset,channel)）、
   `contest_reminder_log`（补发去重账本，UNIQUE(reminder_id,fire_key)）、
   `contest_materials`（sha256 UNIQUE 文件级去重，附件复制到
   `getDataDir()/contestpin/materials/`）、`contest_import_jobs`（两阶段识别
   状态机 imported→…→confirmed + 指纹缓存列）、`contestpin_configs`（识别
   配置，key_sealed 走 KeyCrypto envelope 绝不落明文）+ settings 种子
   `contestpin_default_mode`/`contestpin_overlay_enabled`（WHERE NOT EXISTS）。
   时间语义权威（precision 不得 date→exact 提升等）见 docs/22 §2.2；
   设计见 docs/22-contestpin-design.md。fresh 库迁移后 applied=7、
   user_version=8；resourceGraph ResourceType 同批追加 'contest'（docs/05
   枚举表随批更新）。

## 5. 表清单（S1 起，19 张）

Phase 1 的 14 张 + 003 新增 5 张（skill_agents、skill_links、apihub_profiles、
version_targets、archive_runs）。skills / archives 在 003 中重建扩列（仍是一张表）。
