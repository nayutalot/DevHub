# DevHub 资源关系模型（Resource Model）

## 1. 设计动机

DevHub 中"项目"不是孤立目录，而是资源的枢纽。为避免把 Git / Docker / 服务等资源硬编码进
projects 表（约束 #22），Phase 1 采用**具体表 + 通用注册表**双层模型：

- **具体表**：projects、repositories、environments、environment_tools、services、containers 等，
  承载各自的属性与查询。
- **通用注册表**：`resources(resource_type, ref_id, display_name)` 把每行具体资源登记为
  全局唯一资源节点：`UNIQUE(resource_type, ref_id)`。
- **关系表**：`relationships(source_resource_id, target_resource_id, relation_type)` 存有向边，
  同一对节点同一关系类型唯一（幂等写入）。

Service 层在写入具体表的同时负责维护 resources / relationships（同步登记，约束 #20：只有 Service 层写库）。

## 2. relation_type 语义（有向：source → target）

| relation_type | 语义 | 示例 |
| --- | --- | --- |
| `contains` | source 拥有/包含 target（强从属，target 随 source 删除） | project contains repository；project contains archive |
| `uses` | source 使用 target（运行时依赖，非从属） | project uses environment；project uses container |
| `depends_on` | 弱依赖/软关联（可替代） | service depends_on container |
| `located_in` | 空间/环境归属 | service located_in environment；project located_in environment |

删除语义：关系边不隐式删除具体资源；具体资源删除由 FK CASCADE 处理，孤儿关系边由 Service 层在写库事务内清理。

## 3. Phase 1 关系建立规则（自动推导）

| 规则 | 触发时机 | 建立的关系 |
| --- | --- | --- |
| 项目目录含 `.git` | projects 扫描 | `project contains repository` |
| 项目有 win_path / wsl_path | 项目登记时 | `project located_in environment('windows')` / `('wsl:<distro>')` |
| 端口归因到项目（工作目录/命令行含项目路径） | services 扫描 | `service located_in environment(origin)`；归因成功则补 `project uses service`（service 同时回填 project_id） |
| 容器端口与项目服务端口重合，或容器 label/名称匹配项目 | services 扫描 | `project uses container` |
| WSL 发行版探测到 | environment:detect | 仅登记 environments，不建关系（环境是锚点不是从属） |

归因链：**port → process → environment → project**。Services 视图"谁占用了 8080"的回答 =
services 表行 + 上述关系边展开出的项目归属。

## 4. 未来 Resource Graph 扩展方式

- 新资源类型 = 新具体表 + `resource_type` 新增枚举值，resources/relationships 结构不变。
- 新关系 = `relation_type` 新增枚举值，无需迁移既有边。
- 图查询 = relationships 的递归 CTE（SQLite `WITH RECURSIVE`）即可支持多跳遍历，
  Phase 1 不实现，仅保证模型可扩展（devices / skills / mcp_servers / archives 建表即为预留节点类型）。
