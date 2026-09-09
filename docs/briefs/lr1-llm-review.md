# LR1 实现简报：LLM 复核层（advisory-only —— 归档前/后复核 + Skills 元数据体检）

> 依据：用户裁决 2026-09-09（推翻原「Agent 复核层不移植」裁决，逐字保真见
> docs/10-archive-module.md 开头范围修订块）。本简报为 LR0 文档批产物（零代码）；
> 实现批次 = LR1。老 agentPre/agentPost/profiles/configCrypto/configTransfer/secrets.json
> 仍不移植——本层为**全新轻量实现**。
> 端点 = 用户自备局域网 OpenAI chat/completions 兼容本地服务（硬件 Jetson Orin Nano；
> **Orin 侧部署/模型选型不在本项目范围**）。base URL 一律写占位 `http://<lan-ip>:11434/v1`。

## 0. 硬门（开工前置，缺一不开工）

- **M3-D 72h 观察窗终点 2026-09-10 08:49 且终报通过后方可开工**——窗内本简报仅作评审稿，
  零编码零构建零部署（纪律同 M3-E1 先例）。
- 与 M3-E1 **并行执行、不同 worktree**（各自独立 agent/* 分支与工作树，互不共享）。
- **零 ECS 改动**：ecs-relay 仓不在本批触达面（无新端点、无白名单变化、无部署更新）。

## 1. 范围（进/不进）

进（全部落点）：
- 新增 `src/main/services/review/`（**electron-free**，铁律基线同 docs/09 §11）
- settings 两键（§5）
- migration 007（§7，append-only）
- IPC 4 条（§8，全 READ_ONLY）
- 设置卡片 UI（settings 页 LLM 复核卡片：base_url / model 两项 + 端点测试入口）
- smoke（§9）

不进（不变式）：
- **不改 MCP**：`devhub.archives.*` 面零新增；preview/run/rollback 依旧不进 MCP（docs/10 §11 纪律不变）
- **不改归档 execute 管线**：precheck→preview→confirm→execute→verify 主流程零改动，
  复核只挂在缝隙处且永不阻塞（advisory-only）

## 2. 端点契约

- OpenAI chat/completions 兼容、**非流式**；base URL 占位 `http://<lan-ip>:11434/v1`。
- Node 原生 `fetch`，**零新依赖**。
- `AbortController` 超时 **30s**；超时按 failed/skipped 语义落 envelope（§3），不阻塞主流程。
- **传输层注入式**：service 不内联固定传输实现，构造时注入（smoke 塞夹具端点，
  同 providerRegistry override 模式）。

## 3. 结果四态 envelope

复核调用统一落四态 envelope，**永不抛异常打断归档主流程**：

| 态 | 触发 |
| --- | --- |
| `ok` | 端点可达，模型回合法 JSON 且过结构校验 |
| `skipped` | 端点未配置 / 不可达 / 超时——**全流程行为等价现状**（docs/10 裁决 (3)） |
| `failed` | 端点非 2xx / 网络错误 |
| `unparseable` | 模型回非法 JSON——落 unparseable 态，**不崩** |

## 4. 三任务

### 4.1 归档前复核（`archive:reviewPre`）
- 时机：preview 生成后调用；**输入 = 既有 plan 摘要（零额外扫描）**——仅路径/名称/描述/计数级字段。
- 输出：`{ risk: 'low'|'medium'|'high', concerns: string[], rationale: string }`。
- 展示：确认弹窗咨询条（advisory 条，不拦截、不改变 DOUBLE_CONFIRM 流程）。

### 4.2 归档后复核（`archive:reviewPost { runId }`）
- 时机：run 详情查看时**按需触发**；结果缓存 `review_post_json`（§7），缓存命中不再打端点。
- **「自动挂 execute 管线」= LR2 选项，不进本期**（本期归档执行路径零新增调用）。

### 4.3 Skills 元数据体检（`skills:reviewMeta`）
- 入口：Skills 页**手动按钮**（无自动触发）。
- 输出：批量 flags——描述过短 / 语言不一致 / 疑似重复。
- **只读咨询不落库**；**doctor 语义不变**（体检结果不进 doctor 判定，不改任何既有通道语义）。

## 5. settings 与安全红线

- 两键：`llm_review_base_url` / `llm_review_model`；**默认空 = 停用**；**双键同设才生效**
  （任一键为空即视为未配置 → skipped 态）。
- 种子写入沿用既有幂等模式：`INSERT … SELECT … WHERE NOT EXISTS`（不覆盖用户改动）。
- **v1 零 key 字段**（端点为局域网自备服务，无鉴权）。
- **红线**：将来若引入鉴权，凭据必须走 Electron `safeStorage` 封装存储，
  **禁止明文写 settings**。

## 6. prompt 纪律

- prompt 模板 = **代码常量**（不入 settings、不入 DB、非用户可编辑模板）。
- 复核输入仅路径/名称/描述/计数，**零文件内容、零 key**——任何把文件内容或凭据
  拼进 prompt 的实现即为缺陷。

## 7. DB：migration 007（append-only）

```sql
ALTER TABLE archive_runs ADD COLUMN review_pre_json TEXT;   -- 归档前复核 envelope 缓存（可空）
ALTER TABLE archive_runs ADD COLUMN review_post_json TEXT;  -- 归档后复核 envelope 缓存（可空）
```

- 两列均可空；旧行 NULL = 从未复核（展示语义等同 skipped）。
- append-only 纪律：禁止改旧迁移文件；docs/03 migrations 清单已同步预告（LR0）。

## 8. IPC（4 条，全 READ_ONLY）

| channel | payload | result |
| --- | --- | --- |
| `review:testEndpoint` | `{ baseUrl, model }` | `{ ok, latencyMs, error? }`（设置卡片端点测试入口） |
| `archive:reviewPre` | preview 既有 plan 摘要（§4.1，零额外扫描） | 四态 envelope；ok 态含 `{ risk, concerns[], rationale }` |
| `archive:reviewPost` | `{ runId }` | 四态 envelope（缓存命中直接回缓存） |
| `skills:reviewMeta` | 无 | 批量 flags 清单（只读，不落库） |

- 白名单 + handler 注册表追加模式同 docs/09 §9；smoke #1 通道计数断言同步更新（+4）。

## 9. smoke

- 夹具端点（经注入式传输层）覆盖三路径：**ok / 不可达 / 坏 JSON**。
- **回归判据（最重要）**：端点未配置时，归档全流程与现状行为**等价**
  （preview→confirm→execute→verify 既有断言逐条不变绿转红）。
- 更新 smoke #1 通道计数断言（IPC 白名单 +4）。

## 10. 验收判据

1. **端点未配置/不可达 → 归档主流程等价现状（最重要判据，违反即打回）**。
2. 端点可用 → 确认弹窗含复核咨询条、run 行含 review JSON、四态（ok/skipped/failed/unparseable）全覆盖。
3. 零新依赖；services electron-free；prompt 零文件内容零 key。
4. MCP 零新增。
5. smoke 全绿。
6. 体量 = 单夜批（超出即范围失控，停下上报母智能体裁决）。
