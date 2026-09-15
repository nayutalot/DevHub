-- 009_memory_graph.sql（MEM 批次：记忆域知识图谱并入 DevHub——知识图谱九工具
-- + import_jsonl 一次性导入原型 JSONL，docs/briefs/mem-mcp.md）
--
-- 新表 3 张（全部新建，零重建、零历史表触碰；append-only 对齐 008 风格）：
--   memory_entities      实体（name 主键=原型身份键；entity_type 类型）
--   memory_observations  观察（PK(entity_name,content) 天然去重；
--                        FK→entities ON DELETE CASCADE，随实体级联删）
--   memory_relations     关系（PK(from,to,type) 天然去重；from FK→entities
--                        CASCADE；to 刻意不做 FK 硬约束——原型 create_relations
--                        允许指向未建实体，语义保真；delete_entities 对 to 方向
--                        的关系由服务层显式清除，见 memoryGraphService）
-- 语义权威 = @modelcontextprotocol/server-memory dist/index.js（只读参考）：
-- create 幂等跳过已存在 / observations 去重 / relations 三元组去重 /
-- delete 级联 / search 子串匹配返回邻域 / read_graph 全量 / open_nodes 精确点名。
--
-- 注意：本文件不得包含 PRAGMA user_version（docs/03 §4.3）；
-- migrate.ts 在文件应用成功后以字面量 switch 赋值 user_version = 9。
-- 全部 SQL 为静态字面量（约束 #11：无参数场景，亦无任何拼接）。

PRAGMA foreign_keys = ON;

-- ------------------------------------------------------------------
-- 9.1 memory_entities：实体（原型 Entity{name, entityType, observations[]} 的
--     主行；observations 拆行到 9.2。name 即身份键——原型 create_entities
--     以 name 判重跳过，PK 约束兜底第二道防线）
-- ------------------------------------------------------------------
CREATE TABLE memory_entities (
  name        TEXT    PRIMARY KEY,
  entity_type TEXT    NOT NULL,
  created_at  INTEGER NOT NULL
);

-- ------------------------------------------------------------------
-- 9.2 memory_observations：观察内容（PK(entity_name,content) = 原型
--     add_observations 的 contents.includes 判重语义在存储层落地；
--     实体删除 → 观察随之级联删除，无需服务层手工清）
-- ------------------------------------------------------------------
CREATE TABLE memory_observations (
  entity_name TEXT    NOT NULL REFERENCES memory_entities(name) ON DELETE CASCADE,
  content     TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (entity_name, content)
);

-- ------------------------------------------------------------------
-- 9.3 memory_relations：关系三元组（原型 Relation{from, to, relationType}；
--     PK 三元组 = create_relations 判重语义落地。from 方向 FK CASCADE：
--     delete_entities 原型同时清除 from/to 两侧关系——from 侧由级联完成，
--     to 侧由服务层显式 DELETE（本表不对 to 建 FK，见文件头））
-- ------------------------------------------------------------------
CREATE TABLE memory_relations (
  from_name     TEXT    NOT NULL REFERENCES memory_entities(name) ON DELETE CASCADE,
  to_name       TEXT    NOT NULL,
  relation_type TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (from_name, to_name, relation_type)
);

-- to 方向无 PK 前缀可依：delete_entities 清 to 侧关系与 open/search 邻域
-- 反查（endpoint 命中）走本索引。
CREATE INDEX idx_memory_relations_to ON memory_relations(to_name);
