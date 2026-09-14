# X-L 批任务书：本地命令协议方案②——本地模式遥控取链 T1 结构性 Queued 根治

> 背景：U4 回归实证 T1 卡本地模式结构性 Queued——本地网关 `ws.ts` 对 workspace_link 帧静默忽略无 ack。Z3 结论 B：本地模式缺双端命令面（App 本地帧解析器无 command 结算+网关无路由）；可复用资产 `beginWorkspaceLink`/`completeWorkspaceLink`/`buildZcodeWorkspaceLinkDefault` 已登记。U5 当时裁决方案①（诚实文案「本地模式不提供 ZCode 遥控取链」+WorkspaceLinkModePolicy local 不取链门）——**本批即方案②落地，U5 的 local 否定门随真实传输面就位而反转**（relay 路径逐字节不变）。基线 main=3f66c62。Z3 证据：acceptance/agents-mobile/ 下 z3 目录。

## 0. 工作区与纪律

- worktree：主仓根 `git worktree add worktrees/xl-localcmd -b agent/xl-local-cmd main`；`npm install`。
- **先文档后编码**（Phase A 文档 commit → 主控合批前 review；Phase B 实现commit(s)）。
- 每 commit 即 push 分支（墙期→`git -c http.proxy=socks5h://127.0.0.1:1081 push origin agent/xl-local-cmd`）；绝不 push main；绝不 --no-verify；凭据三零（链 URL 含 sid/hash 属会话凭据——落日志/审计零子串，复用 S 批脱敏口径）。
- **资源互斥（本 Wave 登记）**：本批独占「常驻运行时验证窗口」与 gradle（X-U 批不用 gradle 也不碰任何 DevHub 实例）。

## 1. Phase A：docs/18 增补章（本地模式 workspace_link 请求面）

- 帧形：对齐本地 ws 既有 ndjson 形态（侦察 ws.ts 现有帧与 relay 侧 beginWorkspaceLink 请求形状后取最小扩展；**零新 REST 端点**）；ack/result 结算语义（成功/失败/超时）。
- **红线入册**：token_rotation/event 帧绝不夹带本地通道（本地无 token 概念，撞 S 批红线）；链来源=桌面磁盘三文件重建（与 relay 同源），**绝不伪造/绝不 fabricate**；本地通道零凭据存储。
- U5 策略修订记录：local 否定门→经本地网关取链（诚实文案同步反转）。

## 2. Phase B：双端实现

1. **桌面侧**：ws.ts 路由 workspace_link 请求帧→复用 Z3 登记资产重建链→ack/result 帧（失败结构化：文件缺失/未配对 zcode 等如实投影，绝不假成功）。
2. **App 侧**：本地帧解析器结算 result→喂既有「ZCode 工作区」智能卡流（T1 卡 Queued 根治：本地模式不再结构性排队）；诚实纪律保持（observed 转录只读不冒充）。
3. **U5 反转**：WorkspaceLinkModePolicy local 分支改「经本地网关取链」；三入口「本地模式不提供」文案更新；U5 十个单测相应改写（语义反转有据）。
4. **relay 路径零变化自证**：relay 模式请求路径逐字节不变（单测锁）。

## 3. 门禁与验证

- 桌面：typecheck 0 + smoke **fast 全绿（基线 116/116）** + **full 档全绿（基线 209）**（新协议面跑全量）。
- 安卓：:app/:core 全绿（基线 **137/301**，新增/改写如实计数；gradle 需 JAVA_HOME jbr+local.properties 复制；链尾勿加 --stop）。
- 运行时验证（桌面 ws 帧级端到端）：单实例锁窗口纪律——taskkill 常驻→临时实例（DEVHUB_HOME 隔离库）起本地网关→发 workspace_link 请求帧→断言 ack/result 与链 URL 结构→taskkill→无参拉回常驻 health×3。模拟器端到端可选（relay 配对环境复杂，不作硬门禁）。
- 回归点：relay 模式智能卡取链（E2E 面已验收的路径不回退，以单测/代码路径断言为口径）。

## 4. 边界

ECS 零触碰、零 ssh；relay 面（ecs-relay/+relayClient）零触碰；exec.ts 零新 spawn；OverlayApp/ContestPin 零触碰；不出 APK（收官统一出最终待装件）。

## 5. 汇报

Phase A/B commits / 门禁数字（fast/full/:app/:core）/ ws 帧级端到端证据（请求→ack 断言值）/ U5 反转清单（改写了哪些测试与文案）/ 偏差如实。
