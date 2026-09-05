# DevHub 会话交接文档（2026-09-06 凌晨，M2 收官·M3 待授权）

> 交接范围：项目重建 → Phase 1 → MCP → 并库 S1-S6 → Agent Control AC0-AC9 → ECS+frp 隧道 → 打包 → UX 整改 R1-R11 → 夜间迭代 → IP TLS 裁决 → **ECS Relay M2 三批全部收官（本会话完成 R1/R3 两个收尾批+统一门禁+清理）**。新会话按本文档续接。

## 1. 当前状态一句话

**M2 全部完成**：R2（e46c1c9）+ R1（b329deb 合并）+ R3（70f721a 合并）都在 main 并已推 GitHub；主仓统一门禁全绿（tsc 0 / smoke **164**/164 / build / mcp 27/27 / :core **167**/167 / assembleDebug）；三 relay worktree 与 agent/* 分支（本地+远端）已清理。**下一步=M3**，批次规划已定稿 `docs/briefs/m3-deploy-plan.md`（v2）：本地先行批 P0a/P0b 可立即派；部署批 M3-A/B 需用户授权（ECS SSH 会话+S1 控制台操作+固定管理 IP）。

## 2. 协作模式（用户铁律，滚动有效）

- 主控只 plan/review/merge，执行派 omni-agent；一 Agent 一 Worktree 一任务，禁交叉，主控独占 merge
- **配额中断应对（实证）**：「增量提交接力」——任务书强制"每完成一个模块立即 git commit"，中断后新 agent 从 WIP 提交续作；配额占满时 10-30 分钟退避重试
- **端口铁律**：smoke 需 8746-8755 全空闲——跑门禁前 `taskkill //IM DevHub.exe //F`，跑完 `cmd //c start "" "F:\Active_Project\DevHub\dist\win-unpacked\DevHub.exe"` 恢复常驻+curl 127.0.0.1:8746/v1/health 确认 200；子代理测试桩一律用段外端口（18443 类）
- mcp-acceptance 先 commit 再跑（A12 干净树）；Mimosa「env→path→fs」误报不可安抚；绝不 --no-verify
- **GitHub 增量推送纪律**：①子代理每完成可独立验证的模块→原子提交后立即 push 自己分支（增量接力提交也推）；②主控每次合并 main 后即推送；③汇报必带分支名+commit SHA；④推送失败保留本地提交、记录错误、不无限重试，报告标注未上传项
- 视觉评审派 omni-agent 看图（本会话变体：主控用 analyze_image 抽查关键证据图，有效）；先规划后写码；冲突上报裁决
- **契约先行纪律**：多批并行前主控冻结 DTO 契约表进任务书；fixture 制度化——先完成批次产共享 fixture，后跑批次逐字段对拍，不一致=停下上报
- **机器资源登记**：任务书必须声明占用资源清单（端口/模拟器/常驻实例），派发前核对互斥（本会话实证：R1 门禁杀常驻 vs R3 local 回归需常驻→串行派发，零冲突收官）；临时占用共享资源事后必须恢复并记录
- **任务书落盘**：大任务书写进 `docs/briefs/<批次名>.md`，对话只引用路径
- **自主长跑规定**：仅用户明示授权触发；红线不豁免（花钱/外部账号/写 ~/.codex/动阿里云安全组/删除性操作）；节奏=计划公告→按批推进→裁决项只排队；同类失败 3 次换路径；每批结束不留孤儿进程；截止前 ≥30 分钟停开新批、HANDOFF/记忆/GitHub 三同步、四分类总汇报

## 3. M2 收官台账（本会话动作）

| 批次 | 结果 |
| --- | --- |
| R2 ecs-relay 服务 | 已并 main @ e46c1c9（前会话） |
| R1 relay-client 收尾 | agent 完成（smoke 新段 8 用例 nb-r1-155..162、E→H command 路由缺陷修复 f6713e1、四门禁绿）→ 主控 review（范围=src+scripts、smoke 纯追加 809/0）→ 合并 **b329deb** → push |
| R3 android-relay 收尾 | agent 完成（:core 167/167、assembleDebug、6 张实截证据零凭据、local 回归不回退、如实申报信标徽标偏差）→ 主控 review（范围=android+acceptance、关键图视觉核验过）→ 合并 **70f721a** → push |
| 统一门禁（main） | tsc 0 / smoke **164**/164 / build 绿 / mcp 27/27 / :core **167**/167（20 类）/ assembleDebug 成功 / 常驻恢复 curl 200 |
| 清理 | worktree×3（relay-client/android-relay/ecs-relay）移除；agent/* 分支本地+远端删除；远端仅剩 main |

R3 附带事实：桌面 Gateway 新注册配对设备 `DevHub-Emulator-R3Wrap`（schema v3 迁移后重配对，用户可在设备页撤销）；App 已恢复 local 模式。

## 4. 项目事实基线（main @ 70f721a）

- 门禁基线：tsc 0 / **smoke 164**/164（nb-r1 段起 155）/ mcp 27/27 / **:core 107→167**（relay 四件套 39 例）/ assembleDebug；白名单 70 条；MCP 16 tools；migration 005（user_version=5）
- 常驻=打包版 DevHub.exe（**注意：dist 里是旧版打包**，不含 R1 relayClient 代码——下个打包窗口需重出 dist，见 §6）
- ECS Relay 权威文档：docs/18 协议（16 帧）/19 架构/20 计划（M3-M5+P1-P4）/21 裁决（U1 已决）；部署物料 docs/ecs-relay-deploy/；M3 批次编排 docs/briefs/m3-deploy-plan.md（v2 定稿）
- 公网通道现役：frp（59.110.149.11:8746）；Relay 443 正式入口在 M3 部署时上线
- fixture：ecs-relay/test/fixtures/frames.json（16 帧，三线对拍权威）；android :core 侧 android/core/src/test/resources/relay/frames-fixture.json

## 5. 下一步：M3（按 docs/briefs/m3-deploy-plan.md v2 执行）

- **可立即派（零 ECS 依赖）**：M3-P0a 证书日历（ecs-relay selfcheck 加"<14 天告警"项）；M3-P0b smoke 分层（快速档<2min/全量档，164 一条不删）
- **需用户三项输入后才动**：①ECS SSH 部署会话授权（M3-A 服务部署+R2 验收线③ 64 连接压测；M3-B gen-ip-cert.sh→Caddy→指纹分发）；②S1 安全组 443/tcp 规则（控制台人工）；③固定管理 IP（22 收缩+ECS 加固收口用）
- **M3-C 联调批**（M3-A/B 后）：R-B1..R-B9 全表+TLS 三拒+**R3 信标遗留补齐**（upstream:disconnected 真信标端到端截图）∥ M3-C2 R5.3 事件驱动刷新收尾
- **M3-D**：72h 稳定（T2）→ M4 P1-P4 迁移编排（另出任务书；P4 撤 8746/7000+S2-S6 全为用户控制台人工）

## 6. 遗留与待用户

1. **待用户授权/输入（M3 门槛）**：ECS SSH 会话授权、S1 控制台操作时机、固定管理 IP
2. **打包窗口**：dist 常驻是旧版（不含 relayClient）——M3 联调需要新版打包桌面端（relayClient 随主进程启动），建议 M3-A 前重出 dist；打包批次任务书届时出
3. docs/21 既有三项：FCM 分期/Kimi 真机 managed/Claude hooks 注册（不阻塞 M3 前中期）
4. delivery 聚合"全设备 vs 仅活跃"语义小裁决（R2 遗留）
5. Emulator-R3Wrap 设备是否撤销（知情项，桌面设备页可操作）
6. 旧已知项：relativeTime 中英混排、ZCode approval 判定源未实测、DeepSeek 未接入
7. Mimosa hook 连续提示扫描结论不完整（library_source/callgraph partial）——不宣称项目安全，深审归用户择机

## 7. 关键约束速查

28 条合同（docs/00）+ docs/11-16 + docs/17 §3 + docs/18-21；exec.ts 唯一 spawn；SQL 绑定；migration append-only（user_version=5）；electron-free services；真库只读快照法；打包带双镜像环境变量；ecs-relay/ 子目录自含（独立 node_modules/node --test，零污染 DevHub 门禁）；android 工程在 DevHub\android 禁挪走。
