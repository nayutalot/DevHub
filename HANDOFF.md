# DevHub 会话交接文档（2026-09-05 晨，UX 整改+夜间迭代收官）

> 交接范围：项目重建 → Phase 1 → MCP → 并库 S1-S6 → Agent Control AC0-AC9 → ECS+frp 公网隧道 → 打包 exe → **App 体验整改 R1-R11 全过 + ECS Relay 设计批 + 夜间迭代三批**。新会话按此文档续接。

## 1. 当前状态一句话

**DevHub 全功能就绪且已推送 GitHub（main @ 70dd8f3）：UX 整改 R1-R11 真机验收全过（含公网隧道端到端 spawn+回复回流、延迟 p95 4.76s）、ECS Relay 阶段 2 设计文档齐备（docs/18-21，等用户四项裁决后进 M2 编码）、夜间迭代三批（服务端积压/MCP 四工具/App 视觉打磨）全部合并。门禁终态：tsc 0 / smoke 156/156 / mcp-acceptance 27/27 / build / :core:test 107 / assembleDebug 全绿。**

## 2. 协作模式（用户铁律）

- **主控只 plan/review/merge，一切执行派 omni-agent**；每批独立复跑门禁后追认
- **夜间时段（23:00-09:00 至 09-20）并发工作流**：一 Agent 一 Worktree 一任务，禁交叉，主控独占 merge；文件域隔离分工（TS 服务端/MCP/android 各一路）
- 先规划后写码；冲突上报裁决；视觉评审派 omni-agent 看图；截图 PrintWindow/adb screencap
- **端口铁律（三次事故教训）：smoke 依赖 8746-8755 全空闲；真实 Gateway/常驻实例与其互斥——跑门禁前 taskkill DevHub.exe，跑完用 dist/win-unpacked/DevHub.exe 恢复；用户手动启动的常驻实例也会撞端口，门禁窗口提示用户勿启动**
- mcp-acceptance 先 commit 再跑（A12 干净树）；Mimosa「env→path→fs」误报不可安抚（npm 已单源化先例）；绝不 --no-verify

## 3. 项目事实基线（终态）

- git main @ 70dd8f3 = origin/main（github.com/nayutalot/DevHub）；树净；打包产物 dist/（NSIS+portable+win-unpacked，未入库）
- IPC 白名单 **70 条**（55+15 agents:，夜间#1 +versions:cancel/+agents:probeProvider）；MCP **16 tools**（夜间#2 补 skills.list/versions.list/archives.list/docker.images）；migration **005**（user_version=5：parent_session_id/archived_at/segments_json）
- smoke **156/156**；mcp-acceptance **27/27**；:core:test **107**；真库 user_version=5
- 公网通道：ECS 59.110.149.11 frps + PC frpc（HKCU Run 常驻）→ 127.0.0.1:8746；皎月连备用未激活
- 常驻=打包版 DevHub.exe（登录自启指向 win-unpacked 路径）

## 4. 近三阶段交付摘要

### App 体验整改 R1-R11（docs/17 任务书，批次 A/B/C 三 worktree 并行）
- **批 A（05ecc8b）**：migration 005、messages segments 投影（思维链/工具调用分段，无结构绝不猜）、plugin/skill 引用标签化、last/before/prevAfter 尾部取数、archive/unarchive/DELETE 端点（只动本地投影零触碰源文件）、childSessions 父子链、providerKey/Label、自适应刷新节流（活跃 3s/空闲 15s）+延迟打点、`POST /v1/providers/{id}/sessions` 托管会话启动端点（docs/15 §5 已加授权注记）
- **批 B（35d96f8）**：App 全套阅读体验——气泡对话流/思维链默认折叠/纯 Compose 迷你渲染器（chip 化插件引用）/逆序首屏+prevAfter 上翻/scrubber 拖动定位+跳最新 FAB/子会话入口/归档长按菜单/五家色板徽标+过滤 chips；**显式夹具演示模式**（显著标注零冒充）；:core 37→88 单测
- **批 C（1e42115）**：R6「启动托管会话」按钮+**公网隧道真实端到端**（手机一键起托管 Codex 会话 cmd-204a…→202→跳转→5 次手机回复全部真实推理回流）；R7 四家 per-provider 原因卡；延迟三段实测 **源→App p95 4.76s 达标（≤5s）**；29 张截图视觉评审 **29/29 pass 零红线**；ux-final-report.md（R1-R11 逐条全过）
- 跨批契约修复三处（archivedAt 双形态/childSessions 嵌套兼容/空会话 tail 回退）——**教训：并行批次共享 DTO 契约时，请求参数名等未定义点必须主控先行裁决广播**

### ECS Relay 阶段 1+2（审计→设计）
- 审计四文档（d98e300）：ecs-relay-current-state（证据分级）/ecs-relay-gaps（G1-G11）/agent-control-reference-map（八仓）/ecs-security-group-policy
- 设计四文档（a9acfe8）：docs/18 协议（WS 16 帧+REST 5 端点混合制）/19 架构（三层身份模型+ECS 被攻破论证+relayClient 八模块）/20 计划（M1-M5+G8 四阶段迁移编排）/21 待裁决（域名/FCM/Kimi 真机/Claude hooks）
- **下一步 M2 三 worktree 并行编码，等用户裁决 docs/21（域名+TLS 是 443 硬前置）**

### 夜间迭代三批（并发 worktree）
- **#1 服务端积压（49423c5）**：docker remove/wsl shutdownAll 两段确认、versions:cancel（spawnManaged+killTree 真中断）、agents:probeProvider、**WS delivery 修复**（late-paired 设备投递行 upsert + sendFrame 背压语义修正）
- **#2 MCP 四工具（c6b5e2a+ecde667）**：docs/09 §10 欠账补齐，16 tools，mcp 22→27 用例
- **#4 App 视觉打磨（b4faa07）**：钉深色主题+状态栏、inset 去双计、scrubber 最新锚、markdown ** 粗体渲染统一+标题 strip、FAB 避让、文案杂项六项；:core 88→107
- 计数断言就地更新（授权模式）：m2-t01 12→16、ac2-84 68→70、ac5-120 13→14、#1 批内 5 处

## 5. 遗留与待用户裁决

1. **docs/21 四项**：域名+TLS（推荐购域名+Let's Encrypt，阻塞 M2 起跑的 443 正式态）/FCM 分期/Kimi 真机 managed（approve 验证门依赖）/Claude hooks 注册入口
2. delivery 聚合语义：现按"全部设备行"计（陈旧离线设备卡聚合 pending）——是否改"仅活跃设备"待裁决
3. R5.3 App WS 事件驱动刷新半程未做（现轮询兜底已达标）；R9 拖动气泡帧/R11 日期帧引用 B 批截图
4. 旧已知项：relativeTime 中英混排（等用户）、ZCode approval 判定源未实测到 pending 形态、DeepSeek 未接入

## 6. 关键执行约束（沿用）

28 条合同 + docs/11-16 + docs/17 §3 红线 + docs/18-21（ECS Relay 协议/架构权威）；exec.ts 唯一 spawn；SQL 绑定；migration append-only（现 user_version=5）；electron-free services；真库只读快照法；打包带双镜像环境变量（ELECTRON_MIRROR/ELECTRON_BUILDER_BINARIES_MIRROR）。
