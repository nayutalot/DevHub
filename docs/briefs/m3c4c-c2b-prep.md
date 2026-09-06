# M3-C4c C2b 筹备批任务书（ECS 预检只读 + C2b 全表任务书修订入册）

> C2b=R-B2..R-B8 全表重跑（App 真实公网入网），开工前置=门禁绿+常驻 v3 上线（两并行批在跑）。本批**只做筹备两件事，不跑 C2b 本体、不碰模拟器**。

## 0. 占用资源清单（机器资源登记）

- **ECS 单元独占**（SSH：`ssh -i ~/.ssh/devhub_ecs root@59.110.149.11`；root 密码从未用过勿用；ECS 零改动——只读观测，发现需修的=上报不动手）
- **worktree**：`F:/Active_Project/DevHub-worktrees/c2b-prep`（分支 `agent/c2b-brief`，自 main 切：`git worktree add F:/Active_Project/DevHub-worktrees/c2b-prep -b agent/c2b-brief main`）；纯 docs 无需 npm install
- 不占本地端口/模拟器/常驻；主仓工作区零修改

## 1. 任务A：ECS 预检（全只读，逐项记录实测值）

1. devhub-relay 服务 active + C3b 版本标识；`selfcheck` 重跑（预期 76 项全绿；证书日历项 notAfter 2026-12-04 距今 ≥14 天）
2. journalctl 近 24h error 面；audit 近 24h 轮换宽限（grace）条目有无异常
3. relay_hosts 行（main-desktop / hostId=3 / active？）+ relay_devices 行（#34 revoked 状态实核）逐行抄录
4. SPKI 指纹核验：openssl 实测 443 握手，确认仍为 `sha256/a07f7ab7...50d0`（全值不入汇报，前 16 hex+后 8 即可）
5. 结论**建议**（只建议不执行）：#34 是 C2b 复用还是撤销新配；#31/32/33 revoked 残留清不清

## 2. 任务B：C2b 任务书修订（落盘 `docs/briefs/m3c2b-app-e2e.md`）

基于 `docs/briefs/m3c2-app-e2e.md`（C2 版）修订，**判据权威=docs/20 §3 R-B 表逐条对照、不自造标准**，更新点：

1. 前提区：三缺口已修（C3a：WS pair 传输/TLS pin 通配符崩溃/R5.3 事件驱动 18×）+ C3b（轮换 300s 宽限/disconnect deviceId 单一语义/RelayPanel 事件刷新）→ 各 R-B 条目期望行为相应改写：R-B2 pair 走 App 真实 WS 传输；R-B7 旧 token 宽限 300s 后 401 + **触发面未实现=如实标注不算失败**（docs/20 该项以手动触发为前提，属 R1 裁定遗留）；R-B8 revoke → disconnect(revoked) + 再连 401 DEVICE_REVOKED
2. 环境区：桌面常驻=v3 win-unpacked（写明依赖"gate-fix+dist-v3 部署完成才可开工"）；ECS 侧事实**引用任务A实测结果**（host/device 行状态+#34 处置决定落进任务书）；App=android `assembleDebug` 新构（C3a 后 main）
3. R3 信标真帧（断网→退避徽标→恢复→自动重连截图）与 TLS 拒面（错误指纹双向）照 C2 版保留；模拟器 1 台先行不变
4. 任务书必须自包含：后续批 agent 只读此文件即可开工（资源清单/铁律/汇报格式俱全，风格对齐 m3c2-app-e2e.md）
5. commit + push 分支 `agent/c2b-brief`（任务书先入册纪律）

## 3. 铁律

- ECS 零改动零凭据；SSH 只用 `~/.ssh/devhub_ecs`；判据引用 docs/20 §3 原文
- 任务书内不得出现配对码/token/指纹全值示例（占位符即可）；绝不 --no-verify

## 4. 汇报（四分类）

- ECS 预检逐项表（服务/selfcheck/journal/audit/relay_hosts+relay_devices 行/SPKI 短值）+ #34 处置建议 + #31-33 建议
- 修订后任务书路径 + 与 C2 版差异清单 + 分支 push 状态
