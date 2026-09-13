# B3 批任务书：services 表无界累积修复（D3-F3 查实的主进程真 bug）

> 背景（D3 侦察实锤，从结论续做）：`src/main/services/servicesService.ts` 的 services 表无界增长——①upsert 业务键 (port, origin, pid)：pid 漂移/瞬时端口每次扫描产生新行；②全 src/main 零 `DELETE FROM services`；③`SERVICE_RECENCY_SECONDS`（15 分钟新鲜度）只用于 dashboard 统计，`LIST_SERVICES_ALL_SQL` 无 WHERE/上限全量返回。实测 662 行（61 行 ≤15 分钟新鲜，最老 273 小时），单调增长中，Services 视图 656 行 DOM 即其投影。
> 用户可见症状：Services 视图被数百行陈旧记录淹没，新鲜服务（61 行）淹没其中——**这才是 bug 的用户面**。

## 0. 红线

- 只动 `src/main/services/servicesService.ts`（+如需 docs）；android/ 零触碰；**migration 零**（不加列不改表；清理与过滤走查询面）；绝不 --no-verify。
- 数据纪律：本表是扫描观测缓存非账本——**清理语义只动 services 表自身**，绝不触及审计/会话/命令等其他表；先备份意识（清理逻辑上线首跑量级写入汇报）。
- 行为契约：dashboard 统计语义不变；services:list 返回「新鲜服务」语义与 SERVICE_RECENCY_SECONDS 对齐（15 分钟内活跃=新鲜），陈旧行不再淹没视图；扫描 upsert 不再为 pid 漂移造新行。
- 门禁：`npm run typecheck`（0）+ `npm run smoke:fast` 全绿 + 改 servicesService 则 `npm run smoke` 全量全绿（services 域有用例族，计数联动全枚举）。跑 smoke 前双杀 DevHub.exe+electron.exe（常驻当前离线——X7 后被 D3 门禁双杀，**毕后勿拉回**，主控排 X8 终换装）。

## 1. 修复面（主控定案，两件）

1. **upsert 键修复**（止增）：业务键 (port, origin, pid) → **(port, origin)**（同端口同来源的服务=同一逻辑服务，pid 漂移应 UPDATE 现行而非 INSERT 新行；pid 作为可变属性列更新）。既有 smoke services 用例逐一核对（锁了 pid 行为的按新语义更新）。
2. **读取面 recency 过滤**（治存量）：`services:list` 默认只返回 lastSeenAt ≤ SERVICE_RECENCY_SECONDS 的行（与 dashboard 统计同语义）；可选 `?all=1` 或独立通道保留全量（若 App/其他调用方需要全量——先 grep 调用方判定，无调用方需要则不留）。**存量清理**：加一条启动时+每日定时的裁剪（DELETE lastSeenAt 超过 7 天的行——7 天=可回看的历史窗口，主控裁决值），量级首跑入汇报。
3. docs/05（resource model）services 语义一小节同步（若该文档记载了 services 表语义）。

## 2. 交付

- Worktree：`F:/Active_Project/DevHub-worktrees/b3svc`，分支 `agent/services-accum-fix`（自 main 建；无 node_modules 先 npm install）。
- commit 分主题（upsert 键/读取过滤+裁剪）+push（墙期 SOCKS 配方同前）。
- 汇报：diff 概览、门禁数字、存量清理首跑量级（裁剪前/后行数）、调用方 grep 结论、push 回执、偏差如实。
