# DevHub 会话交接文档（2026-09-05 午，M2 进行中·配额中断点）

> 交接范围：项目重建 → Phase 1 → MCP → 并库 S1-S6 → Agent Control AC0-AC9 → ECS+frp 隧道 → 打包 → UX 整改 R1-R11 → 夜间迭代 → IP TLS 裁决 → **ECS Relay M2（R2 完成；R1/R3 代码全部完成、差测试收尾——本会话因模型并发配额被占中断于此）**。新会话按本文档续接。

## 1. 当前状态一句话

**M2 三批代码已全部写完**：R2 服务已合并 main（e46c1c9）；R1 八模块与 R3 全功能块分别在各自 worktree 增量提交完毕（接力模式对抗配额中断），**只剩两个收尾批**（R1 的 smoke 测试段+门禁；R3 的门禁实跑+模拟器截图）。用户已切换到 coding plan（5.3 主控，实测 3 子代理并发可用）——新会话直接执行 §5 两个收尾任务书即可。

## 2. 协作模式（用户铁律）

- 主控只 plan/review/merge，执行派 omni-agent；一 Agent 一 Worktree 一任务，禁交叉，主控独占 merge
- **配额中断应对（本会话实证）**：concurrency limit 反复杀子代理时用「增量提交接力」——任务书强制"每完成一个模块立即 git commit"，中断后新 agent 从 WIP 提交续作，每轮净赚一块（R1 八模块就是这样拼完的）；配额占满时 10-30 分钟退避重试
- **端口铁律**：smoke 需 8746-8755 全空闲——跑门禁前 `taskkill //IM DevHub.exe //F`，跑完 `cmd //c start "" "F:\Active_Project\DevHub\dist\win-unpacked\DevHub.exe"` 恢复常驻+curl 127.0.0.1:8746/v1/health 确认 200；子代理测试桩一律用段外端口（18443 类）
- mcp-acceptance 先 commit 再跑（A12 干净树）；Mimosa「env→path→fs」误报不可安抚；绝不 --no-verify
- **GitHub 增量推送纪律（用户 2026-09-05 定为正式规则）**：①子代理每完成一个可独立验证的模块/里程碑 → 原子提交后**立即 `git push origin <自己的分支>`**（增量接力提交也推，防本地丢失、进度随时可在 GitHub 可见）；②主控每次合并 main 后即推送；③汇报必须带分支名+commit SHA；④推送失败保留本地提交、记录错误、不无限重试，继续不依赖推送的工作并在报告标注未上传项
- 视觉评审派 omni-agent 看图；先规划后写码；冲突上报裁决
- **契约先行纪律（用户 2026-09-05 定为正式规则；UX 批三处跨批契约错位的教训）**：凡多批并行，开工前主控**冻结 DTO 契约表**进各任务书（字段名/类型/嵌套位置/请求与响应参数名逐项写死）；**fixture 制度化**——先完成的批次产共享 fixture（帧集/DTO 样例，标注权威出处），后跑批次逐字段对拍，对拍不一致=停下上报不改契约
- **机器资源登记（三次 smoke 挂死事故的教训）**：任务书必须声明"本批占用资源清单"（监听端口/模拟器/常驻实例/CDP 等），主控派发前核对互斥；子代理严禁占用未声明资源；需要临时占用共享资源（如杀常驻跑门禁）必须事后恢复并在报告记录
- **任务书落盘**：大任务书一律写进 `docs/briefs/<批次名>.md`（或 HANDOFF 附录），对话只引用路径——重派/新会话零重贴成本（配额连环杀期间重派 11 次的教训）
- **自主长跑规定（用户 2026-09-05 定为正式规则）**：①**触发**：仅用户明示授权（"自主跑到 X 点"类指令）；②**红线不豁免**：花钱/外部账号/写用户红线目录（~/.codex 等）/动阿里云安全组/删除性操作——一律留待用户，绝不因"自主"越权；③**节奏**：开工先出计划清单公告 → 按批推进（任务书→执行→门禁→合并→推送→台账）→ 待用户裁决项只排队不代答；④**卡死处理**：同类失败 3 次换路径或降级、配额秒杀 10-30 分钟退避循环、影响用户环境的操作先恢复环境再继续；⑤**环境守护**：不杀用户在用的实例（门禁必需除外且事后恢复）、每批结束不留孤儿进程/端口占用；⑥**收尾硬性**：截止前 ≥30 分钟停止开新批、HANDOFF/记忆/GitHub 三同步、总汇报按「已完成并验证/仅本地验证/环境阻塞/待用户」四分类

## 3. M2 状态台账（精确到 commit）

| 批次 | 位置 | 状态 | 剩余 |
| --- | --- | --- | --- |
| R2 ecs-relay 服务 | **已合并 main @ e46c1c9**（含 16 帧 fixture：`ecs-relay/test/fixtures/frames.json`、偏离单：`ecs-relay/README.md`） | ✅ 完成（node --test 76/76、selfcheck 59/59） | — |
| R1 relay-client | worktree `F:\Active_Project\DevHub-worktrees\relay-client`，分支 `agent/relay-client`，HEAD=**26d8249**，树净 | **八模块代码全完成**（groundwork/wsClient/config/backoff/eventUplink/commandDownlink/pairingBridge/rotationBridge+statusProjector+编排组装，git log 各 wip 提交可查） | §5.1 收尾批：smoke 段+四门禁+终提交 |
| R3 android-relay | worktree `F:\Active_Project\DevHub-worktrees\android-relay`，分支 `agent/android-relay`，HEAD=**6a80ae8**，树净 | **全功能块完成**（Room 双模式/:core relay 五件+4 测试/ConnectionManager 参数化/UI 双模式接线/:core 曾实测全绿+fixture 对拍） | §5.2 收尾批：门禁实跑+模拟器四类截图+终提交 |

- 两个 worktree 的分支已推送 origin（同名分支）做保险。
- R2 协议裁定（R1/R3 已对齐，新会话继续遵守）：①event 帧=`type:'event'`+`eventType`；②token_rotation 必携 deviceId；③register_pairing host 腿控制帧；④requestId ECS 内部重写；⑤host 离线 `command_ack{status:'queued'}`。

## 4. 项目事实基线（main @ 28e0f38+）

- git main（=origin/main）：IP TLS 裁决批 28e0f38（U1=DONE 无域名方案）；门禁基线 tsc 0 / smoke 156/156 / mcp 27/27 / :core 107 / assembleDebug
- 白名单 70 条；MCP 16 tools；migration 005（user_version=5）；常驻=打包版 DevHub.exe（用户新版已含全部 main 代码）
- ECS Relay 权威文档：docs/18 协议（16 帧）/19 架构/20 计划（M2-M5）/21 裁决（U1 已决；FCM/Kimi 真机/hooks 待用户）；部署物料 docs/ecs-relay-deploy/（自签 IP 证书+双指纹）
- 公网通道现役：frp（59.110.149.11:8746）；Relay 443 正式入口在 M3 部署时上线

## 5. 新会话立即执行的两个收尾任务书（可直接派 omni-agent）

### 5.1 R1 终收批（worktree relay-client，HEAD=26d8249）

**任务**：①smoke 新段（append-only，scripts/smoke.mjs 尾部，模式照 ac6 段，用例名 `nb-r1-*`）：16 帧 round-trip 逐帧对拍 ecs-relay/test/fixtures/frames.json；重连退避参数；断线回填幂等；命令排队→上线投递；同幂等键重试返回原结果；token_rotation 落库+宽限；撤销踢线；凭据零入日志/DB 抽样。内存 Relay 桩端口 127.0.0.1:18443 类段外，帧数据源=fixture。②门禁：跑 smoke 前 taskkill DevHub.exe/跑完恢复常驻+curl 200（§2 端口铁律）；tsc 0+smoke（156 基线+新段全绿）+build+mcp-acceptance（先 commit 树净，27/27）。③缺陷最小修复重跑。④`git commit -m "test(relay): relay-client smoke segment + gates green (M2-R1 wrap)"`。铁律：docs/00 全 28 条；smoke append-only（计数断言受影响就地更新注明）；MCP/android/ecs-relay 零触碰；增量提交纪律（每 2-3 用例一 commit）。

### 5.2 R3 收尾批（worktree android-relay，HEAD=6a80ae8）

**任务**：①门禁实跑：`gradlew :core:test :app:assembleDebug`（JAVA_HOME=D:\Apps\JetBrains\IntelliJ IDEA 2026.1\jbr；local.properties 已在位）→全绿数字+APK 路径；失败则最小修复（每 fix 一 commit）。②模拟器冒烟+四类截图（**不做真实 relay 连接**，端到端归 M3）：local 模式回归（连桌面常驻 Gateway 127.0.0.1:8746）；relay 模式 UI 验收=模式选择页/relayUrl+wss 校验（输 ws:// 被拒）/降级态 upstream:disconnected；截图存 worktree acceptance/agents-mobile/relay-*.png（控制门恒空一类也要），数据来源如实标注，零凭据。③`git commit -m "test(app): relay dual-mode gates + emulator evidence (M2-R3 wrap)"`。铁律：只改 android/+acceptance；observed 零控件；桌面常驻不杀；绝不 --no-verify。

### 5.3 收尾后主控流程

R1/R3 回报 → 逐一 review（范围纪律：R1 只动 src+scripts、R3 只动 android+acceptance）→ 合入序 **R1 → R3** → 主仓统一门禁（端口铁律）→ push main → 清 worktree/分支 → **M3 规划**（部署 ECS Relay 上 443：gen-ip-cert.sh→Caddy→指纹分发→App/relayClient 双端 wss 联调→R-B1..R-B9 验收表，含 TLS 三拒）→ P1-P4 迁移编排（docs/20 §4）。

**M3 任务书须携带的四项技术建议（用户已认可 2026-09-05）**：
1. **ECS 加固收口**：部署 Relay 时一并完成——确认密钥可登→禁 root 密码登录→22 收缩固定管理 IP→核查 3389 规则残留（步骤详见 docs/ecs-security-group-policy.md，全部人工/授权操作）
2. **证书日历**：自签证书 90 天过期=全链断——ecs-relay selfcheck 加"剩余 <14 天告警"项，不靠人记
3. **R5.3 收尾**：App 侧 WS 事件驱动刷新只做了一半（现轮询兜底为主）——M3 联调窗口补完，手机端体感再提速
4. **smoke 分层（M2 合并后择机）**：156 用例 6-8 分钟且持续增长——拆快速档（单元/纯逻辑 <2min，每批跑）+全量档（Gateway/e2e，合并时跑），砍并行批次等待



## 6. 遗留与待用户

1. docs/21 待裁决三项：FCM 分期/Kimi 真机 managed/Claude hooks 注册（不阻塞 M2/M3 前中期）
2. R2 验收线③部署演练（2C2G 实机 loadtest）归 M3
3. delivery 聚合"全设备 vs 仅活跃"语义小裁决
4. 旧已知项：relativeTime 中英混排、ZCode approval 判定源未实测、DeepSeek 未接入

## 7. 关键约束速查

28 条合同（docs/00）+ docs/11-16 + docs/17 §3 + docs/18-21；exec.ts 唯一 spawn；SQL 绑定；migration append-only（user_version=5）；electron-free services；真库只读快照法；打包带双镜像环境变量；ecs-relay/ 子目录自含（独立 node_modules/node --test，零污染 DevHub 门禁）。
