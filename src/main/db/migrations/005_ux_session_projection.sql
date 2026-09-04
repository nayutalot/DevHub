-- 005_ux_session_projection.sql（ux 整改批 A：R2 父子链 / R3 归档 / R1 分段投影）
--
-- 只加列 + 加索引，零重建、零 UPDATE、零既有列触碰（约束 #21 只追加）：
--   agent_sessions.parent_session_id  nullable 自引用（R2：子会话链；NULL = 主会话，
--                                     默认列表按 IS NULL 过滤——保留 8442e9d 意图）
--   agent_sessions.archived_at        nullable（R3：归档时间戳；NULL = 未归档）
--   agent_messages.segments_json      nullable（R1：结构化分段投影 JSON；
--                                     NULL = 无结构 → 整段 contentRedacted，绝不猜）
-- parent_session_id 故意不加 FOREIGN KEY：子会话先于父会话行存在的窗口内允许
-- 悬空引用由 L3 侧「父行不存在则不落子行」护栏兜底（绝不造父行）；自引用 FK +
-- 立即约束会让合法的同事务父子导入顺序复杂化，索引 + L3 护栏已满足查询面。
--
-- 注意：本文件不得包含 PRAGMA user_version（docs/03 §4）；
-- migrate.ts 在文件应用成功后以字面量 switch 赋值 user_version = 5（docs/13 §3）。

-- ------------------------------------------------------------------
-- R2：子会话链（parentNativeSessionId 落库；nullable 自引用）
-- ------------------------------------------------------------------
ALTER TABLE agent_sessions ADD COLUMN parent_session_id INTEGER;
CREATE INDEX idx_agent_sessions_parent ON agent_sessions(parent_session_id);

-- ------------------------------------------------------------------
-- R3：归档（nullable 时间戳；删除/归档只动 DevHub 本地投影，源文件零触碰）
-- ------------------------------------------------------------------
ALTER TABLE agent_sessions ADD COLUMN archived_at INTEGER;

-- ------------------------------------------------------------------
-- R1：消息分段投影（可选；provider 转录源有明确结构时由 L3 persistMessage 落
--     [{kind,label?,content}] JSON；无结构保持 NULL → 投影整段 text，绝不猜。
--     contentRedacted 保留不动（向后兼容 + 原始 plugin:// 等 URI 只留此列））
-- ------------------------------------------------------------------
ALTER TABLE agent_messages ADD COLUMN segments_json TEXT;
