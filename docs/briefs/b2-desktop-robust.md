# B2 批任务书：桌面 T2 zcode 托管面健壮性审查+修复

> 背景：T2 新写的 zcode 托管面（zcodeProtocol.ts/zcodeProvider 托管半/zcodeManagedConfig.ts）从未对真实边界打磨——真实端到端留验收期间，先做静态健壮性审查+可测边界修复，降低首跑翻车面。协议事实权威=Z1 侦察 REPORT.md（acceptance/agents-mobile/zcode-appserver-scout-20260912/）。
> 本批=审查+最小修复；**真实 CLI 端到端仍不做**（留用户验收，绝不冒充已验）。

## 0. 红线

- 只动 src/main+scripts；android/ 零触碰；migration 零；exec.ts 唯一 spawn；令牌三零（apiKeyPlain/URL/sid 不入日志）。
- 最小修复纪律：只修有单测可锁的真实缺陷；风格性/理论性发现注记不上报修改。
- 门禁：`npm run typecheck`（0）+ `npm run smoke:fast` 全绿 + 改托管面则 `npm run smoke` 全量全绿。跑 smoke 前双杀 DevHub.exe+electron.exe（现役 X5 PID 53900——毕后勿拉回，主控统一排 X6 换装）。

## 1. 审查矩阵（逐项过，findings 分级：真缺陷必修/风格注记）

1. **连接生命周期**：spawnRpcConnection 的 pending 表泄漏面（超时后迟到响应已计数容忍——对；但 spawn 失败半初始化/proc.exited 后 dispose 重入/close 与 killTree 竞态）；
2. **turn 生命周期**：create 成功→subscribe 失败→send 失败各中间态的资源收尾（finalizeManagedSession 全路径覆盖？）；并发 spawn 同 workspace（-32010 之外我们侧的状态）；managedSessions/managedSessionIds 表增删对称性；
3. **事件消费**：handleManagedEvent 对未知 payload.type/缺字段的防御（should 已计数容忍——核）;turnInFlight 状态机与终态沿的单调性；
4. **配置面**：ensureZcodeCliConfig 并发调用（两 spawn 同时 ensure——幂等跳写是否原子安全）；readZcodeManagedConfig 在 ApiHub 档案半写状态的防御；
5. **探针面**：doctor 探针的 path 解析（resolveManagedCjsPath 各注册表/路径形态）；probe 失败→caps 回 observed 的迟滞（防抖：probe 瞬断导致 managed 卡翻转）；
6. **smoke 覆盖缺口**：上述修掉的每个缺陷必须有 fake 用例锁；顺带列出「无证据但可疑」清单供主控裁决。

## 2. 交付

- Worktree：`F:/Active_Project/DevHub-worktrees/b2robust`，分支 `agent/zcode-robust`（自 main 建）。
- 修复分主题 commit+push（墙期 SOCKS 配方同前；绝不 --no-verify）。
- 汇报：findings 清单（必修/注记分列）、diff 概览、typecheck/fast/full 三数字、push 回执、偏差如实。**发现架构级问题（如需改帧协议语义）停手上报勿擅动。**
- worktree 无 node_modules 先 npm install。
