# CP1 任务书：ContestPin 数据层 + IPC + contestService（M1）

> 系列权威：docs/22-contestpin-design.md（设计）/ docs/briefs/contestpin-charter.md（用户原文）。
> 执行者：omni-agent，worktree `F:/Active_Project/DevHub-worktrees/contestpin`，分支
> `agent/contestpin`（自 main=CP0 合并点切出，已含 docs/22/03/04 预告）。
> 本任务书自包含：不需要另读会话上下文；引用的文件:行号以 worktree 内为准。

## 0. 时窗红线（最高优先级，违反即事故）

M3-D 72h 稳定性观察窗运行中（至 2026-09-10 08:49），本批在观察窗内执行：

- **禁止**：跑全量 smoke（`node scripts/smoke.mjs` 不带 --tier）/ mcp-acceptance /
  gradle / adb / electron / `npm run dev` / 打包；杀或重启任何进程（尤其
  DevHub.exe、electron.exe、node 巡检）；绑定/占用 8746 端口；SSH/ECS 任何操作；
  `git push main` / merge（主控审后合并）。
- **允许**：`npx tsc --noEmit`；`node scripts/smoke.mjs --tier=fast`（纯 Node
  临时库夹具，零进程零端口）；worktree 内 npm install（首次，无 node_modules）。
- 门禁链（全量 smoke/mcp/真实启动）窗毕终报通过后由主控另行安排，不在本批。

## 1. 已查明事实链（审计 2026-09-09，勿重复考古，直接用）

- **迁移机制**：`src/main/db/migrate.ts` 按文件名 `^(\d+)_.*\.sql$` 升序应用序号
  > user_version 的文件（:40-45），每文件单事务（:93-106）；`setUserVersionLiteral`
  字面量 switch 现 case 1..6（:53-76），漏注册运行期 throw（:74）；SQL 文件内禁止
  `PRAGMA user_version`。**007 已判给 LR1（docs/03 §4.4 条目 8），本批用 008**。
- **smoke 迁移断言**：`scripts/smoke.mjs` 现断言 fresh 库 applied=6、user_version=6
  （:584-597 附近，"就地更新+注记"是唯一授权模式）；step1 通道计数断言 exactly 70
  （:112 附近，前例 68→70 就地更新）。
- **IPC 三件套**：`src/shared/channels.ts` IPC_CHANNELS 数组（:36-132，头部计数
  注记 :16-34）→ `src/shared/types.ts` ChannelContract（:1900-1982）+
  AssertContractCoversWhitelist（:1984-1989，编译期强制全覆盖）→
  `src/main/ipc/handlers.ts` createHandlerRegistry（:293 Record 全覆盖；网关拒绝
  :310-337）。变更类两段式先例：docker:action（:676-683）、archive:run
  （:722-735）——`confirmed?` 缺省回 `{ confirmRequired: true, impacts }`。
- **Service 范式**：electron-free 模块函数，db 经 `getDatabase()` 单例（DEVHUB_HOME
  环境变量驱动，`src/main/db/index.ts:19-26`），内部助手 `db: DatabaseSync` 首参；
  错误 `ServiceError(code, message)`（`src/main/services/internal.ts:21-28`）；
  时间戳 unix 秒 nowSec()（internal.ts:13-15）；SQL 全参数绑定。CRUD 模板=
  `src/main/services/projectService.ts`。
- **资源图**：`src/main/services/resourceGraph.ts` ResourceType 联合（:21-30，只扩
  联合零表改）；`registerResource`（:45-68 存在则更新 display_name）、`relate`
  （:82-87 INSERT OR IGNORE）、`deleteResource`（:90-92，边 FK CASCADE）。调用先例
  projectService.ts:445/490/501-505。**关系边：source=contest，target=project，
  relation_type 复用 'uses'**（docs/22 §2.3 裁决）。
- **settings**：`src/main/services/settingsService.ts` ALLOWED_KEYS 白名单（:21-38，
  现 13 键），越键 → ServiceError('DB_ERROR')；upsert ON CONFLICT（:56-61）。
- **资源视图范式**：三态强制（loading/empty/error）+ 无 mock（合同 #23/#24）——
  本批只做 service+IPC，UI 视图归 CP2+，不涉及。

## 2. 交付物清单（全部在 worktree 分支上增量提交）

1. **`src/main/db/migrations/008_contestpin.sql`**：7 张表，DDL 要点见 docs/22
   §2.1 表（列名/枚举 CHECK/UNIQUE/索引以 docs/22 为准，含 idx：contest_nodes
   (contest_id)、contest_reminders(node_id)、contest_import_jobs(material_id)、
   contests(archived)）；settings 种子 `contestpin_default_mode`='two_stage'、
   `contestpin_overlay_enabled`='0'，WHERE NOT EXISTS；**不含 PRAGMA user_version**。
2. **`src/main/db/migrate.ts`**：setUserVersionLiteral 补 case 8（+头部版本注释
   如有同步）。
3. **`src/main/services/resourceGraph.ts`**：ResourceType 追加 'contest'（带注释
   引 docs/22）。
4. **`docs/05-resource-model.md`**：资源类型枚举表补 contest 行（随批入册）。
5. **`src/main/services/settingsService.ts`**：ALLOWED_KEYS 追加
   `contestpin_overlay_state`、`contestpin_overlay_enabled`、
   `contestpin_default_mode`。
6. **`src/shared/channels.ts`**：追加 docs/04「ContestPin 追加」节的 9 条
   （contestpin:list/get/create/update/delete/archive/nodeUpsert/nodeDelete/
   linkProject），计数注记 70→79（CP1 批次注记）。
7. **`src/shared/types.ts`**：Contest 域类型（ContestListItem/ContestView/
   ContestDetailView/ContestNodeView/patch 类型）+ ChannelContract 9 行（payload/
   result 与 docs/04 表逐字一致）。
8. **`src/main/ipc/handlers.ts`**：9 条 handler 注册块；delete/nodeDelete 两段式
   （impacts=节点/材料关联/提醒计数）；list 支持 query 模糊+status 筛选+archived
   缺省排除。
9. **`src/main/services/contestpin/contestService.ts`**（可拆 nodes.ts 等，目录
   自定但必须 electron-free）：list/get/create/update/delete/archive/nodeUpsert/
   nodeDelete/linkProject。业务规则：
   - name 必填非空；year 可空，给定时 1990..2100 整数；URL 字段仅 http/https，
     否则 ServiceError('BAD_PAYLOAD')；status 缺省 'watching'。
   - nodeUpsert 校验：precision='tbd' → start_at 必须为 null；precision∈
     {exact,date,month} → start_at 必填；end_at 给定时 ≥ start_at；kind 缺省
     'custom'；tz 缺省 'local'（自由文本，IANA 名不强校验）。**禁止把 precision
     从低精度提升**：更新已有 node 时 precision 'date'/'month'/'tbd' 不得改为
     'exact' 除非 payload 显式携带原文 raw_text 依据（docs/22 §2.2）。
   - create/delete 维护 resources：create 登记 contest 节点（display_name=name，
     ref_id=行 id 十进制字符串）；update 改名同步；delete 先显式 deleteResource
     再删行（projectService.ts:501-505 先例）。
   - linkProject：projectId 非空时 registerResource('project', id)（已存在幂等）
     + relate(contestRes, 'uses', projectRes)；null 时删 uses 边（定位边删除先例
     projectService.ts:565-566）。projectId 不存在 → ServiceError('NOT_FOUND')。
   - delete 两段式：无 confirmed 回 impacts（nodes 计数+reminders 计数+materials
     引用计数）；confirmed 后级联删（表 FK CASCADE 已兜底，日志记数）。
10. **`scripts/smoke.mjs`**：计数断言 70→79（就地+注记"CP1 +9"）；迁移断言
    applied=7、user_version=8（就地+注记）；新增 fast 档用例（registerCase 第 3 参
    'fast'，临时库 makeTempHome 范式 :542-552 + closeDatabase 重置）：
    - cp1-crud：create→get→update→archive→list（query/status/archived 过滤）→
      delete 两段式（先 confirmRequired+impacts，再 confirmed 删除+级联核验）。
    - cp1-nodes：nodeUpsert 精度校验四分支（tbd 强制 null / date 允许无时刻 /
      缺 start_at 拒绝 / date→exact 无 raw_text 拒绝）+ nodeDelete。
    - cp1-resource-edge：linkProject 建 uses 边→get 返回关联→unlink 删边→
      delete contest 后 resource 节点与边均不存在。
    - cp1-migration-fresh：并入既有迁移断言用例（不另开重复用例，就地扩展其
      断言到 7 表存在性检查 contests/contest_nodes 等）。
11. **`docs/04-ipc-api.md`**：ContestPin 追加节 9 行状态改「CP1 已落地（79）」，
    节首计数文字同步；文件头部/正文其他 70 计数引用一律更新为 79。
12. **`docs/03-database.md`**：§4.4 条目 9 状态改「已落地」；§5 表清单 19→26 张
    （+7，注明 008）；若正文有 user_version 终值描述同步为 8。

## 3. 验证协议（本批完成定义）

1. `npx tsc --noEmit` → 0 error。
2. `node scripts/smoke.mjs --tier=fast` → 全过（含新增 cp1-* 用例；既有用例零
   删改，仅两处授权"就地更新"计数/迁移断言）。
3. 自查红线：grep 新增 SQL 无字符串拼接（全 `?` 绑定）；无 electron import 进
   services/contestpin/；无新 spawn/child_process；无凭据/密钥字样落日志。

## 4. 提交纪律

- 增量提交接力（每完成一块一 commit），消息 `feat(contestpin): …` / 
  `docs(contestpin): …`；**每 commit 即 push 分支 agent/contestpin**；绝不
  --no-verify；不 merge、不 push main。
- 完成后最终消息回报：commit 列表、验证两条命令的实际输出摘要、与任务书的
  偏差清单（如有）、遗留项。
