# MEM 批任务书：记忆 MCP 并入 DevHub（知识图谱九工具+SQLite 存储+原型导入）

> 背景：用户令「记忆 mcp 已有雏形，完善并并入 devhub」。雏形=官方 `@modelcontextprotocol/server-memory`（本机 `C:/Users/sakuya/.agents/memory/server/`，JSONL 文件存储，九工具：create_entities/create_relations/add_observations/delete_entities/delete_observations/delete_relations/read_graph/search_nodes/open_nodes——语义以本地 dist/index.js 为准）。DevHub MCP 服务器（src/main/mcp/，registerTool+permissions 静态分类+scripts/mcp-acceptance.mjs 验收）成熟，本批=**记忆域并入 DevHub MCP**：SQLite 存储替代 JSONL、权限分级、原型数据导入通道。基线 main=794a265 后（先 `git -C . log --oneline -1` 核对）；门禁 fast 133/full 235；迁移最新=008_contestpin。

## 0. 工作区与纪律

- worktree：主仓根 `git worktree add worktrees/mem-mcp -b agent/mem-mcp main`；`npm install`。
- 每 commit 即 push 分支（直连优先 socks5h://127.0.0.1:1081 兜底重试循环）；绝不 push main；绝不 --no-verify；凭据三零。
- **本批不换装不出 APK**（收官 X20 统一）；MCP 验收跑法照 scripts/mcp-acceptance.mjs 既有口径（mcp-A13 常驻互斥铁律：验收窗口先停常驻跑完再拉回 health×3）。

## 1. 存储层：migration 009_memory_graph.sql + memoryGraphService

- 三表（append-only 迁移，user_version 递增，对齐 008 风格）：`memory_entities(name TEXT PK, entity_type TEXT NOT NULL, created_at INTEGER)`；`memory_observations(entity_name TEXT NOT NULL REFERENCES memory_entities(name) ON DELETE CASCADE, content TEXT NOT NULL, created_at INTEGER, PK(entity_name,content))`；`memory_relations(from_name TEXT NOT NULL, to_name TEXT NOT NULL, relation_type TEXT NOT NULL, created_at INTEGER, PK(from_name,to_name,relation_type))`（外键对 entities CASCADE；to_name 不做 FK 硬约束——原型的 relations 允许指向未建实体，语义保真）。
- `services/memoryGraphService.ts`（node:sqlite DatabaseSync，prepared statements）：九操作语义与原型逐一对齐（create 幂等跳过已存在/observations 去重/relations 去重/delete 级联/search=实体名+类型+观察内容子串匹配返回匹配邻域/read_graph 全量/open_nodes 精确点名），**WAL 事务**替代原型 JSONL 全量重写。

## 2. MCP 工具面（src/main/mcp/tools/memory.ts，命名对齐 `devhub.<域>.<动作>`）

- 9 只读/写工具：`devhub.memory.create_entities/create_relations/add_observations/delete_entities/delete_observations/delete_relations/read_graph/search_nodes/open_nodes` + **`devhub.memory.import_jsonl`**（完善点：一次性导入原型记忆文件——参数给 JSONL 路径，DevHub 零硬编码用户路径；解析逐行 JSON 数组结构、逐条走 create 语义、导入计数返回；SAFE）。
- zod schema 对齐原型入参形状（entities/relations/observations 数组结构）；输出人话+结构化摘要。
- **权限裁决（主控已定）**：read_graph/search_nodes/open_nodes=READ_ONLY；六写工具+import=**SAFE**（docs/08 §9 Phase B 首批启用——域特定结构化写入，非 §9.4 红线的万能执行接口；permissions.ts 分类表增补+docs/08 §9 就地注记一段）。

## 3. 验收与测试

- `scripts/mcp-acceptance.mjs` 扩展 memory 工具用例（create→add→search→open→relations→delete 级联→import 全链；计数 27→新值如实），验收窗口遵循 mcp-A13（先停常驻跑完拉回 health×3）。
- 存储层单测：幂等/去重/级联/搜索邻域/导入计数/并发两连接 WAL。
- 门禁：typecheck 0 + fast 全绿（基线 **133/133**）+ full 全绿（基线 **235/235**）+ build + **mcp 验收全绿（基线 27→新值）**。

## 4. 边界

Agents UI 面不做（MCP 工具面为 v1 交付，UI 候选留档）；原型目录/配置零触碰（只读参考语义）；Exec/agentControl 面零触碰；docs/08 §9 注记纯插入。

## 5. 汇报

commits / 工具清单+权限分类 / 迁移与验收计数（27→N）/ mcp 验收证据 / 存储层单测清单 / 偏差如实。
