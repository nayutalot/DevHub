-- 002_env_tools_unique.sql (Step 5, parent-agent ruling revision #2)
--
-- Relax the environment_tools uniqueness from (environment_id, tool) to
-- (environment_id, tool, path) so the same tool may be stored once per real
-- interpreter path — required for Windows machines where multiple Python
-- interpreters (e.g. 3.9 and 3.13) coexist on PATH.
--
-- Rebuild strategy (SQLite cannot ALTER a constraint):
--   CREATE new table -> INSERT SELECT deduped copy -> DROP old -> RENAME.
-- Dedup keeps the lowest id per (environment_id, tool, path); v1 data can not
-- contain (environment_id, tool) duplicates (old UNIQUE), so in practice the
-- copy is 1:1 — the dedup guard is defensive only.
--
-- Note: this file must NOT contain PRAGMA user_version (docs/03 §4.3);
-- migrate.ts assigns the version literal after the file applies cleanly.

PRAGMA foreign_keys = ON;

CREATE TABLE environment_tools_v2 (
  id             INTEGER PRIMARY KEY,
  environment_id INTEGER NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  tool           TEXT    NOT NULL,       -- 'node' | 'npm' | 'pnpm' | 'python' | 'git' | 'docker' | 'cmake' | 'gcc' | 'vscode' | ...
  version        TEXT,
  path           TEXT,
  state          TEXT    NOT NULL DEFAULT 'missing',  -- installed | missing | error
  raw_version    TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  UNIQUE(environment_id, tool, path)
);

INSERT INTO environment_tools_v2 (
  id, environment_id, tool, version, path, state, raw_version, created_at, updated_at
)
SELECT
  t.id, t.environment_id, t.tool, t.version, t.path, t.state, t.raw_version, t.created_at, t.updated_at
FROM environment_tools t
WHERE t.id = (
  SELECT MIN(t2.id)
  FROM environment_tools t2
  WHERE t2.environment_id = t.environment_id
    AND t2.tool = t.tool
    AND (
      (t2.path IS NULL AND t.path IS NULL)
      OR t2.path = t.path
    )
);

DROP TABLE environment_tools;

ALTER TABLE environment_tools_v2 RENAME TO environment_tools;

CREATE INDEX idx_env_tools_env ON environment_tools(environment_id);
