# Z2 批任务书：zcode 子会话终态证据侦查+如实投影（桌面侧）

> 背景（主控已查明事实链，从结论续做）：U2-M4 实查在役桌面 DB（%APPDATA%\DevHub\devhub.db）：子会话行 338/341 status='unknown' 且无 ended_at——zcode 监控面对子会话无任务终态证据，App 子会话列表只能如实显「未知」（U2 已做 App 侧归一，桌面零触碰）。**本批=桌面侧补终态证据，让子会话状态不再是恒 unknown。**
> 相关事实：zcodeProvider 读 `~/.zcode/cli/db/db.sqlite`（CLI 与桌面同库，Z1 侦察 REPORT.md）；会话对象含 status 字段（Z1 run3 create 响应 `session{...,status}`）；桌面 session 表（docs/13 schema）有 status 列但子会话行恒 unknown；子会话=zcode 子代理会话（双判据过滤，scripts/cleanup-zcode-subagent-sessions.mjs 同域）。

## 0. 红线

- 28 条合同；exec.ts 唯一 spawn；SQL 绑定；migration append-only（**本批预期零 migration**——读既有表/列；确需先停手上报）。
- **诚实纪律（本批最高红线）**：状态投影只消费真实证据；证据不足 → unknown 如实保留，绝不猜/绝不把 unknown 美化成终态。
- **DB 副本泄漏红线（09-10 事故）**：侦查活库用副本时，副本一律放仓库外临时目录（如系统 temp），用毕即删；**绝不入 acceptance/、绝不 commit**；采样值脱敏（会话标题/内容 masked）。
- 令牌三零；android/ 零触碰；本批只动 `src/main`+`scripts`+（如需）docs。
- 门禁：`npm run typecheck`（0）+ `npm run smoke:fast` 全绿 + 改投影逻辑则 `npm run smoke` 全量全绿；新增用例允许（计数联动更新点全枚举，历史教训 ac2-84）。跑 smoke 前双杀 DevHub.exe+electron.exe（现役 X4 PID 17344——**毕后由主控排换装，勿拉回**；若你改动后无桌面行为变化也勿拉回，主控统一处置）。

## 1. Phase 1：证据侦查（只读，先行，结论决定 Phase 2 形态）

对 `~/.zcode/cli/db/db.sqlite`（副本、仓库外）：
1. session 表 schema 全列清点 + 子会话行（338/341 域）各列值分布（status/updated_at/生命周期类列有无值）；
2. 库内有无其他终态证据源：事件/turn/message 表的时间戳与类型（Z1 事件枚举 turn.completed 等在 CLI 库的落盘形态）、session_input.status、approval_status；
3. 结论三选一（写进汇报与代码注释）：A=库内有可靠终态证据未被投影消费 → Phase 2 接线；B=证据部分可靠（如仅 completed 有、cancelled 无）→ Phase 2 只接可靠部分+其余如实 unknown；C=库内确无证据 → **停手上报**（如实报告「无证据可消费」，附选项建议，勿硬造）。

## 2. Phase 2：接线（仅 Phase 1 结论 A/B 时）

- zcodeProvider 投影层消费证据 → 子会话行 status 落真实终态（done/failed 等按库内语义映射，映射表进代码注释+单测）；unknown 仅剩真无证据行；
- smoke：fixture 夹具用例（假 db/假行）锁映射表+边界（无证据→unknown）；计数联动全枚举；
- 若涉及 schema 注释/docs/13 出入，docs 同步一小节。

## 3. 交付

- Worktree：`F:/Active_Project/DevHub-worktrees/z2status`，分支 `agent/zcode-child-terminal`（自 main 建）。
- 增量 commit+push（墙期 SOCKS 配方：`ssh -i ~/.ssh/devhub_ecs -D 127.0.0.1:1081 -fN root@59.110.149.11` 后 `git -c http.proxy=socks5h://127.0.0.1:1081 push`；bind already in use=已在跑直接用）；绝不 --no-verify。
- 汇报：Phase 1 三选一结论+证据清单（脱敏）、（若接线）diff 概览+映射表、门禁数字、push 回执、偏差如实。**Phase 1 结论 C 时只交侦查报告即可停手**。
