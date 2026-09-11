# T2 批任务书：zcode 真托管 provider（ZCode Protocol v1 app-server 接入）

> 用户裁决（2026-09-11 夜）：zcode 可直接托管（两轨都做的 T2 轨）。前置=Z1 侦察已合 main（96b060f），**协议事实与 7 差异点对照表=权威依据**：`acceptance/agents-mobile/zcode-appserver-scout-20260912/REPORT.md`（先完整读）。参照实现=codex 托管模式（`src/main/services/agentControl/providers/codexProvider.ts`，spawnRpcConnection L515 起）。
>
> 主控定案（架构决策，不重开）：
> 1. **env 注入源=ApiHub zcode 活动档案 + settings 模型键**：spawn env 注入 `ZCODE_BASE_URL`/`ZCODE_API_KEY`（取 ApiHub zcode 活动档案 baseURL/apiKeyPlain/kind——apihubService 读活动档案面）+ `ZCODE_MODEL`（settings 新键 `zcode_managed_model`，值=完整 "provider/model" 串，默认空）。**档案缺失或键空=结构化 unconfigured，caps 保持 observed**（llm_review 双键先例：默认空=停用绝不半开）。**绝不读 ~/.zcode/v2/credentials.json**；apiKeyPlain 仅内存中转，绝不入日志/审计/错误（令牌三零）。
> 2. **探针**：`doctor` 快探（node zcode.cjs doctor，exit 0<1s=alive）+ 配置就绪判定（档案+模型键）→ caps.mode='managed'（数据驱动，App「启动托管会话」门自动开，App 零改动）。
> 3. **server-request 分发器**：`session/requestRuntimePreferences` 回默认四字段（false/false/false/默认策略）；`interaction/requestPermission` v1 一律回 **denied**（保守诚实，UI 路由留后续批）+会话事件如实投影；未实现 interaction/* 回 -32601（服务端有兼容回退）。
> 4. **turn 路径**：session/create（persistence:'immediate'）→ session/subscribe（deliveryKind:'desktop-continuous'）→ session/send → 消费 session/event 至 turn.completed（resultType 六值如实映射状态）→ session/close；中断=session/stop（旁路队列）→ 兜底 killTree。
> 5. **帧层差异**（Z1 对照表 #1/#2）：无 jsonrpc 字段、id string|int、错误 id 可为字符串、无 initialize 握手（探针勿发握手）。
> 6. **转录**：零额外工作（CLI 会话与桌面同库 ~/.zcode/cli/db/db.sqlite，现有九方法面天然可见）；不做库隔离。
> 7. 会话投影落库走 codex 同款 sink 模式（spawn 的会话标 session_mode='managed'，与桌面外部会话区分）。

## 1. 红线

- 28 条合同；exec.ts 唯一 spawn（zcode.cjs 经 `node` 调起走 spawnManaged）；SQL 绑定；migration append-only（本批预期零新 migration——caps/审计结构复用既有；确需先上报主控）。
- 令牌三零 + apiKeyPlain 中转零落盘；spawn env 不入任何日志。
- App（android/）零改动——本批纯桌面 `src/main`+`scripts`；若发现 App 面必须动，停下上报。
- 帧编解码/分发器纯函数单测全 fake（零联网零真实 CLI），协议 fixture 以 Z1 证据日志为源（脱敏形态）；真实端到端（真 CLI+真 key）**不做**，留主控复跑/用户验收（codex 烂尾教训：真实推理回流不冒充）。

## 2. 实现模块（增量提交，每模块一 commit+push）

1. `src/main/services/agentControl/providers/zcodeProtocol.ts`（新）：帧编解码（请求/通知/响应/错误 id 宽松）+ server-request 分发器纯函数 + 事件类型枚举/判态（waiting_input/paused/active 映射沿用现有语义）。单测直锁。
2. zcodeProvider 托管面：spawnManaged（env 注入拼装纯函数单测）+ app-server 连接管理（spawnManaged 托管、stdin EOF 退出映射）+ turn 生命周期（create/subscribe/send/stop/close）+ 事件→sink 投影。探针=doctor+配置就绪。
3. 能力门接线：caps 探测链（probe→managed 判定）+ managed spawn 入口（复用 spawnSession 通用门，provider 分发面接 zcode）+ sessionAction 门对 managed zcode 会话放行（observed 外部会话照旧 COMMAND_NOT_EXECUTABLE）。
4. settings 键 `zcode_managed_model`（迁移零——settings 键值对表既有机制；如走 DB settings 表核对既有模式）。
5. smoke：托管面用例（fake transport/fixture 帧）+ 计数连锁更新点全枚举（step1/step6 等锁数字处逐一核对，历史教训 ac2-84/ac5-120）。

## 3. 门禁与交付

- Worktree：`F:/Active_Project/DevHub-worktrees/t2managed`，分支 `agent/zcode-managed`（自 main 建）。
- 门禁：`npm run typecheck`（0 error）→ `npm run smoke:fast` 全绿 → `npm run smoke` 全量全绿（大改动跑全量；mcp 面无关可免，主控合并前核）。跑前双杀 DevHub.exe+electron.exe（常驻现为 X2 版 PID 3832——**毕后不拉回**，主控排换装批）。
- 增量 commit+push（墙期 SOCKS 配方同 T1 任务书 §2）；绝不 --no-verify。
- 汇报：模块级 diff 概览、四门禁数字、fake 覆盖面清单、push 回执、偏差如实（遇协议歧义以 Z1 证据为准并注明，不擅自猜）。
