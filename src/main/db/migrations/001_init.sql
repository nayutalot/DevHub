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

-- 3.4 环境内工具链检测明细
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
