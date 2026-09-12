# Z3 批任务书：workspace_link 本地面补齐（U4 回归发现的真缺口）

> 背景（U4 回归实锤，主控已复核源码定位，从结论续做）：本地模式（App 经本地网关 WS 直连）下 T1「ZCode 工作区」卡**结构性永远 Queued**：
> - 链路：App 本地 WS 发 workspace_link relay command 帧 → 网关 `src/main/services/agentControl/gateway/ws.ts` 对未知帧型**静默忽略**（永无 ack）→ App `ConnectionManager.kt:1330-1341` 超时入队 Queued；本地补发轮（ConnectionManager.kt:1403-1410）落 `COMMAND_NOT_EXECUTABLE (local face)`；
> - relay 面（用户真机）不受影响（ECS relay 转发 host 腿正常执行）；
> - 影响：本地模式（模拟器/同机）下卡误导性恒 Queued。U4 证据 acceptance/agents-mobile/ux-u4-regression-20260912/（06/07/08 号截图）。

## 0. 红线

- 28 条合同；exec.ts 唯一 spawn；SQL 绑定；migration 零（workspace_link 命令落库面已存在——remote_commands 0004 八值 action，主控认定本地执行走同一命令面即可复用）；绝不 --no-verify。
- **令牌三零**：本地面执行结果与 relay 面同一脱敏口径（result_json 只 {provider}，URL 绝不入库/日志/审计）。
- android/ 零触碰（App 侧 Queued→Ready 流转已就绪，网关补 ack 后自然流转；若 Phase 1 侦察结论指向必须动 App，停手上报）。
- 门禁：`npm run typecheck`（0）+ `npm run smoke:fast` 全绿 + 改 ws/命令面则 `npm run smoke` 全量全绿；新增用例计数联动全枚举。跑 smoke 前双杀 DevHub.exe+electron.exe（现役 X5 PID 53900——毕后勿拉回，主控排 X6 换装）。

## 1. Phase 1：侦察（只读，结论定形态）

1. 本地网关 ws.ts 现有帧型路由全清单：本地连接的设备都收发什么帧（既有哪些 action/命令已被处理、以何形态路由到 agentControlService/commandDownlink）；
2. relay 帧词汇（八值 action，docs/18）在本地网关的对应面：是全无、还是有部分已接（C7b host 腿三处理器是 relay 侧 wsClient 还是本地网关——查明边界）；
3. 结论两选一：A=本地网关有成熟的命令执行路由可挂 workspace_link → Phase 2 按同形态接线；B=本地网关命令面与 relay 语义结构性不兼容（如安全模型不同）→ 停手上报，转 App 侧诚实文案方案（本地模式显「本地模式不提供遥控取链」替代 Queued——由主控裁决后另派）。

## 2. Phase 2：接线（仅结论 A）

- ws.ts 对 workspace_link 帧型：ack 受理 → 调 `buildZcodeWorkspaceLinkDefault()`（zcodeLinkProvider 既有生产入口）→ 按既有命令结果形态回 command_result（result {provider, url, deviceName}，脱敏口径同 relay 面）；
- 幂等/落库：与 relay 面同一 remote_commands 命令面（若命令面耦合 relay 设备身份导致本地无法落库，可走最小差异并注明，绝不绕过脱敏口径）；
- smoke：新用例锁本地帧→ack→result {provider} 全链（fake ws；URL 断言只断形态前缀，值不入册）+ 无关帧静默忽略现状回归锁；计数联动全枚举。

## 3. 交付

- Worktree：`F:/Active_Project/DevHub-worktrees/z3local`，分支 `agent/ws-local-workspace-link`（自 main 建）。
- 增量 commit+push（墙期 SOCKS 配方同前）。
- 汇报：Phase 1 侦察结论（帧型路由清单摘要）、（若接线）diff 概览+门禁三数字、push 回执、偏差如实。**结论 B 时只交侦察报告即可停手**。
