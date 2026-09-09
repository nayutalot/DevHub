# 卫生批任务书：smoke 全量档网关用例端口隔离（8746 固定端口 → 每用例随机空闲端口）

> 背景：三连事故（CP1 fast 误标 3 行 / hotfix 误启 9+3 行 / M3-E1+LR1 批 3 行，
> 均已撤销）根因=全量档 ac6-* 系用例**固定端口 8746**。常驻在线时占住 8746，
> 用例的 gwRequest/connect 直打常驻网关 → **生产库**造幻影配对行。
> 执行者：omni-agent，worktree `F:/Active_Project/DevHub-worktrees/hygiene`，
> 分支 `agent/smoke-port-hygiene`（从 main=33dd0ae 切出）。

## 0. 主控已查明事实链（勿重复侦查）

- 用例**已经 hermetic**：`gwCaseSetup`（scripts/smoke.mjs ~L7354）makeTempHome
  隔离 DEVHUB_HOME + 临时库——**库隔离不是病灶**；病灶仅在端口。
- 固定端口引用共 ~94 处（`gwRequest(8746`/`connect(8746`/`pairingCreateHttp(8746` 等），
  分布 ac6-121..136 系及可能的其他家族（含 M3-E1 新增 m3e1-* 用例——逐一审计）。
- `startGatewayEnabled`（~L7391）= settings gateway_enabled=1 → startGateway()，
  端口读 settings gateway_port（产品缺省 8746），占用时 +1 顺延（ac6-121 专测此行为）。
- 两类 8746 引用需区分：
  1. **bind/connect 类**（真监听/真请求）→ 必须改造为本用例随机端口；
  2. **缺省值断言类**（如 ~L4563 settings 默认表 `{gateway_port:'8746'}`、~L4939
     status 投影默认 port）→ **保留**（不 bind 任何东西，产品缺省就是 8746，hermetic）。
- 常驻现状：本会话常驻已下线（改造期间 8746 空闲，行为不变可对照）。

## 1. 设计裁决（主控定）

1. **改造模式**：`gwCaseSetup` 增加端口分配——`net.createServer()` 监听 port 0 取
   ephemeral 端口 p 后立即 close，`settingsSvc.setSetting('gateway_port', String(p))`
   后再由用例启动网关；返回值携 `{ port }`（=startGateway 后 `status.actualPort`，
   网关已起时优先 actualPort——顺延场景 p+1 如实）。**端口分配与网关启动间竞态**
   （p 被他人抢）由既有顺延逻辑兜底，actualPort 为准。
2. **用例内字面量替换**：所有 bind/connect 类 `8746` → setup 返回的 port 变量；
   `8747` 顺延断言同理改为 `p+1`（ac6-121 顺延/全占子场景改用 p..p+9 随机基座，
   先探测 p..p+9 全空闲再开测，被外部抢占→重选基座重试 ≤2）。
3. **ECONNREFUSED 子场景**（ac6-121(a)）：连随机 p（未监听）→ 仍 ECONNREFUSED，
   语义不变且对常驻在线免疫（这正是本批目的）。
4. **计数纪律**：用例零增零删零跳过（约束 #27——本批是改造不是新增）；
   fast/full 通过数必须与 main 基线一致（fast 100 / full 190）。
5. **零产品代码改动**：只动 scripts/smoke.mjs。若发现必须改产品代码才能隔离
   → 停手上报（说明卡点），不得顺手改 src/。

## 2. 验证序（分支上全跑）

1. `node scripts/smoke.mjs --tier=fast`（100/100）。
2. `node scripts/smoke.mjs --tier=full`（190/190）。
3. **幻影根治判据（本批验收真身）**：起一个占位 TCP listener 在 8746（node 一行
   `net.createServer().listen(8746)` 后台挂起）→ 再跑全量 → 必须 190/190 全绿 →
   杀 listener。绿=常驻在线场景下全量档不再触碰 8746（三连事故类别根治证明）。
4. `npx tsc --noEmit`（应 0——未动 TS，跑一遍防手滑）。

## 3. 铁律

- 每 commit 即 push `agent/smoke-port-hygiene`；绝不 --no-verify；不为绿而绿。
- 改造失败/语义对不上的个别用例：如实标注上报，不得删用例或放宽断言迁就。
- 主树零触碰；卡死重试 ≤2。

## 4. 汇报

diff 统计（替换处数/保留的缺省值断言处数及理由清单）+ 四步验证实测计数 +
占位 listener 实验实录（起止/端口/全量结果）+ push 状态。
