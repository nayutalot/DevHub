-- 0001_init.sql —— devhub-relay 独立 schema（docs/19 §5.3，G9 裁决：绝不进 DevHub migration 序列）
-- 独立生命周期：由 scripts/migrate.mjs（或服务启动自检 ensureSchema）应用到 relay.db。
-- 纪律：一切运行期 SQL 全参数绑定（约束 #11 同款）；凭据列只存 SHA-256（docs/19 §2）。

PRAGMA foreign_keys = ON;

-- 设备注册表（L1，docs/19 §2.1）
CREATE TABLE relay_devices (
  id             INTEGER PRIMARY KEY,              -- ECS 侧设备号（独立命名域）
  win_device_id  INTEGER,                          -- Windows remote_devices.id（pair_accepted 回填，可空）
  device_name    TEXT    NOT NULL,
  platform       TEXT    NOT NULL DEFAULT 'android',
  token_hash     TEXT    NOT NULL UNIQUE,          -- sha256(端到端 Token)：配对捕获/轮换同步；仅哈希（G9）
  token_version  INTEGER NOT NULL DEFAULT 1,       -- 0 = 配对受理但 pair_accepted 未回（pending 占位）
  status         TEXT    NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','revoked')),   -- 撤销即拒不可复活（语义同 remote_devices）
  paired_at      INTEGER NOT NULL,
  last_seen_at   INTEGER,
  revoked_at     INTEGER,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX idx_relay_devices_status ON relay_devices(status);
CREATE INDEX idx_relay_devices_win ON relay_devices(win_device_id);

-- 配对码（语义上移：TTL 300s/一次性/失败5次作废/单活跃码，docs/18 §3.2）
CREATE TABLE pairing_codes (
  id             INTEGER PRIMARY KEY,
  pairing_id     TEXT    NOT NULL UNIQUE,          -- Windows 签发 id（原样回传校验）
  code_hash      TEXT    NOT NULL,                 -- sha256(8位码明文)；明文绝不落盘
  expires_at     INTEGER NOT NULL,                 -- created + 300s
  fail_count     INTEGER NOT NULL DEFAULT 0,       -- ≥5 → status='voided'
  status         TEXT    NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','used','expired','voided')),
  created_at     INTEGER NOT NULL
);
CREATE INDEX idx_pairing_codes_status ON pairing_codes(status);

-- 主机身份（L2，docs/19 §2.2）
CREATE TABLE relay_hosts (
  id               INTEGER PRIMARY KEY,
  host_name        TEXT,
  credential_hash  TEXT    NOT NULL UNIQUE,        -- sha256(Relay 凭据)
  status           TEXT    NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active','revoked')),
  enrolled_at      INTEGER NOT NULL,
  last_seen_at     INTEGER,
  updated_at       INTEGER NOT NULL
);

-- 连接审计（当前态在内存 registry；落库仅供审计与断线诊断）
CREATE TABLE relay_connections (
  id           INTEGER PRIMARY KEY,
  side         TEXT    NOT NULL CHECK (side IN ('device','host')),
  device_id    INTEGER REFERENCES relay_devices(id) ON DELETE SET NULL,
  host_id      INTEGER REFERENCES relay_hosts(id)   ON DELETE SET NULL,
  remote_ip    TEXT,
  connected_at INTEGER NOT NULL,
  closed_at    INTEGER,
  close_reason TEXT                                 -- 零凭据零 payload
);

-- 事件缓存（脱敏帧元数据 + payload；权威 sequence 的镜像，G9 裁决：只存脱敏摘要与元数据）
CREATE TABLE relay_events (
  sequence            INTEGER PRIMARY KEY,          -- = Windows agent_events.id（镜像，绝不自编号）
  event_id            TEXT    NOT NULL UNIQUE,      -- 幂等（host 回填重发去重）
  type                TEXT    NOT NULL,
  provider            TEXT,
  session_ref         TEXT,                         -- Windows sessionId + provider 冗余定位串（'<provider>:<sessionId>'）
  summary             TEXT,                         -- ≤120 字符已脱敏
  payload_json        TEXT,                         -- 已脱敏有界 payload（≤4KB）；淘汰后 NULL
  requires_user_action INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL              -- = Windows createdAt
);
CREATE INDEX idx_relay_events_created ON relay_events(created_at);
CREATE INDEX idx_relay_events_session ON relay_events(session_ref);

-- 每设备 ACK 游标（累计制，只前进）
CREATE TABLE relay_event_acks (
  device_id      INTEGER PRIMARY KEY REFERENCES relay_devices(id) ON DELETE CASCADE,
  acked_through  INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

-- 命令幂等 + 离线队列（docs/18 §3.8/§3.9）
CREATE TABLE relay_commands (
  id              INTEGER PRIMARY KEY,
  command_id      TEXT,                             -- Windows 回填
  device_id       INTEGER NOT NULL REFERENCES relay_devices(id) ON DELETE CASCADE,
  idempotency_key TEXT    NOT NULL,
  action          TEXT    NOT NULL CHECK (action IN ('send_message','approve','pause','resume','interrupt')),
  payload_json    TEXT,                             -- 脱敏后（上游 redact 纪律；ECS 原样存储）
  session_ref     TEXT,                             -- '<provider>:<sessionId>' 定位串（可空）
  request_id      TEXT,                             -- 帧级关联（响应回显用）
  payload_fingerprint TEXT NOT NULL,                -- action+sessionId+payload 指纹（同 key 异 payload → COMMAND_KEY_CONFLICT）
  status          TEXT    NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','acked','accepted','executed','rejected','expired','failed')),
  requested_at    INTEGER NOT NULL,
  acked_at        INTEGER,
  result_at       INTEGER,
  result_json     TEXT,
  UNIQUE(device_id, idempotency_key)                -- 幂等根（docs/18 §3.9）
);
CREATE INDEX idx_relay_commands_status ON relay_commands(status);

-- 审计（目录镜像 docs/15 §10 / docs/19 §5.3；detail 零凭据零码明文零 payload 全文）
CREATE TABLE relay_audit (
  id          INTEGER PRIMARY KEY,
  category    TEXT NOT NULL,   -- pairing|auth|command|device|relay
  action      TEXT NOT NULL,   -- pairing_code_registered|pairing_claimed|pairing_failed|auth_failed|
                               -- replay_rejected|rate_limited|command_queued|command_relayed|
                               -- command_expired|device_paired|device_revoked|host_enrolled|host_revoked|
                               -- relay_started|relay_stopped|relay_cache_evicted|connection_opened|connection_closed
  device_id   INTEGER REFERENCES relay_devices(id) ON DELETE SET NULL,
  host_id     INTEGER REFERENCES relay_hosts(id)   ON DELETE SET NULL,
  outcome     TEXT NOT NULL,   -- success|denied|error
  detail_json TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_relay_audit_created ON relay_audit(created_at);

-- 版本登记表（IF NOT EXISTS：store.ensureSchema 首读版本时需先存在——引导顺序需要）
CREATE TABLE IF NOT EXISTS relay_meta (key TEXT PRIMARY KEY, value TEXT);  -- schema 版本/水位等
