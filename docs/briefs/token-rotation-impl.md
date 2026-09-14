# token_rotation 补投实施任务书（草稿——决策点留孔位，主控/用户裁决后填孔生效）

> 上游：`docs/token-rotation-replay-proposal.md`（W3 批产出：现状实证 + docs/18 §3.14.1 修订
> 提案 + 决策点 D1–D7）。**前置条件：D1–D7 全部裁决完成，本文孔位回填后方可开工；未裁决
> 不得启动本批。** 本批为编码+部署批（与 W3 纯文档批分离），范围以裁决结果自适应裁剪
> （§1.1 三档范围）。
> 基线：main @ 9da1a22（提案与本文同源侦察分支 agent/docs-token-rotation）。

## 0. 资源占用（开工时建）

- worktree：主仓根 `git worktree add worktrees/<批名> -b agent/rot-impl main`（批名由主控定）。
- 不占本地端口（ecs-relay 测试自带 `:memory:`/随机端口）；不碰模拟器/dist；ECS 单元独占
  （部署窗口内）。
- 只读源 = 主仓 `ecs-relay/`；桌面侧（若范围含乙档）= `src/main/services/agentControl/relayClient/`。

## 1. 范围（按 D2 裁决三档；孔位【D2：__】）

### 1.1 范围裁剪表

| 裁决档 | relay 侧 | 桌面侧 | App 侧 | docs/18 |
| --- | --- | --- | --- | --- |
| 甲：接受现状 | 零编码 | 零编码 | 零编码 | §3.14.1 增补（纯文档）+ README #11 更正 |
| 乙：桌面重轮换 | 【孔位 D1-乙 时 +0005 表】 | rotationBridge 触发器（periodic backlog + grace_expired 审计源；连接态门控【孔位 D2-乙 前置信号方案】） | 零改动（单调门已兜底） | §3.14.1 增补 + §5.3 值域注记 |
| 丙：E→H 新帧 | 新帧双端 + 补投失败告知 | wsClient/relayClient handler | 零改动 | §3.0 帧表 +1 行组 + §3.14.1 |

- 甲档 = 纯文档批：只做 docs/18 §3.14.1 增补 + `ecs-relay/README.md` 偏离单 #11 更正
  （现文「离线设备不补投」与 C7a 修②不符，证据链见提案 §1.3），无部署。
- 乙/丙档 = 编码批：继续 §2–§5。

### 1.2 决策点回填清单（开工前逐项填）

- 【D1 pending 存储位置：甲内存 / 乙新表 relay_pending_rotations / （丙 audit 复用已不推荐）】
- 【D2 重启缺口处置：甲 / 乙 / 丙】（决定 §1.1 范围档）
- 【D3 补投条数上限：单槽（推荐）/ 多条队列】
- 【D4 过期 rotation：绝不越窗（推荐维持）/ 其他（若非维持，须附 docs/18 §3.14 权威值修订）】
- 【D5 交界规则：寿命单源 grace_expires_at + 撤销即清 + 新凭据准入即清（推荐确认）/ 否决】
- 【D6 schema 递进（仅 D1-乙）：sql/0005 append-only + ensureSchema + relay_meta（推荐）/ 其他】
- 【D7 安全边界：三防线维持（推荐）/ 修改意见】

## 2. 实施序（乙/丙档适用；甲档跳至 §5）

1. **worktree + 再基线**：`cd ecs-relay && npm install`；`npm run typecheck`；
   `npm test`（node --test）与 `npm run selfcheck` 计数记录为基线。参考基线：M3-E1 时点
   node --test 99 / selfcheck 83+1SKIP（docs/briefs/ecs-m3e1-deploy.md:25）——**以开工时实测
   为准，提案基线仅作漂移参照**。
2. **relay 侧实现**（按 D1/D3/D5 孔位结果）：
   - D1-乙：`sql/0005_pending_rotations.sql`（**仅元数据列：device_id、token_version、issued_at、
     expires_at、state；UNIQUE(device_id)；明文帧绝不入列——C-1 红线**）+ store/forwarder 接线；
     `npm run migrate` 幂等验证。
   - 补投路径改动锚点：`ecs-relay/src/forwarder.ts`（pendingRotations 登记点 :1084、补投
     :216-226、清扫 :606-626、撤销清 :1109、新凭据准入清 :167）——改动须保持五锚点语义
     与 D5 交界规则一致。
   - 审计动作沿用 `token_rotation_flushed`（detail.source 取值扩展现值域时同步 selfcheck 断言）。
3. **桌面侧实现**（乙档）：`src/main/services/agentControl/relayClient/rotationBridge.ts`——
   触发器接线（grace_expired 审计为源 + 连接态门控）；**绝不动 L3 落库面**
   （agentControlService.rotateDeviceToken 语义不变）；新 Token 明文红线不变（仅返回值一次性
   流转，agentControlService.ts:1846-1847）。
4. **单测**（每档至少）：
   - 现状回归：pair 窗冲刷时序 / 重连补偿 / 窗外不补偿三态（selfcheck §11 现有断言零回退，
     selfcheck.mjs:669-725）。
   - 新增：重启模拟场景（进程内重建 Forwarder → grace 重连 → 按 D2 档断言行为）；D1-乙时
     断言重启后元数据在库且明文面为零；乙档断言「设备不在线不派发重轮换」（锁死防线）。
5. **全绿门禁**：typecheck + node --test（基线+新增全过）+ selfcheck（基线+新增全过）。
   绝不 `--no-verify`；钩子拦截如实上报。

## 3. docs/18 修订（随码批同行）

- §3.14 追加 §3.14.1（文本以 `docs/token-rotation-replay-proposal.md` §2 为底稿，按裁决回填
  【待裁决】处）；帧表 #14 行「重发」列按 D2 结果更新（甲=「—（窗内内存补偿，契约外注记）」
  精神不变）。
- README 偏离单 #11 更正（ecs-relay/README.md:160-163）。
- 契约修订广播：docs/20 §2.4 流程（README 偏离单 #1 :136-137 同款纪律）。

## 4. ECS 部署（乙/丙档；甲档无部署。配方引用先例：RW0 + M3-E1）

> 先例锚点：docs/briefs/ecs-m3e1-deploy.md（执行序/备份/回滚全谱）+ HANDOFF §4.4 RW0
> （备份 relay-backup-preRW0-*.tgz + 3.1s 级停机，C7a 先例）。**本批不 ssh 侦察——部署窗口
> 由主控单独派发或随本批执行时按本节照做。**

1. **预检**：`systemctl is-active devhub-relay` + 本机 health（8443 面）+ relay_meta 迁移在册
   方式读出 + relay_devices/relay_commands 计数快照（对账基线）。
2. **备份先行**：`/var/lib/devhub-relay/relay.db` → `/root/relay-db-backup-pre<批名>-<ts>.db`；
   `/opt/devhub-relay` → `/root/relay-backup-pre<批名>-<ts>.tgz`（RW0 命名风格）。绝不删旧备份。
3. **代码同步**：主仓 `ecs-relay/`（只读源）→ `/opt/devhub-relay/`（src/sql/test/package.json
   先 diff 后覆盖）；依赖无新增免 npm install。**绝不触碰 `/etc/devhub-relay/` 任何文件**
   （env 与 RW0 SSH 物料 `ssh_config`/`wake_key`/`wake_known_hosts` 均 0600 devhub-relay，
   部署不得动——M3-E1 先例 :14-15）。
4. **SQL 迁移**（D1-乙 时）：sqlite3 事务应用 `sql/0005_pending_rotations.sql` → 核验表结构/
   索引 + relay_meta 按 0001–0004 同风格登记（**relay 库不用 user_version**，M3-E1 实测 :18-19）。
5. **重启**：`systemctl restart devhub-relay`（亚秒~3.1s 级窗口，C7a/M3-E1 先例量级）；
   is-active + `journalctl -u devhub-relay` 无新错 + health 200。
   systemd 硬化保持原样不验证不改：ProtectSystem=strict / ProtectHome=yes /
   ReadWritePaths=/var/lib/devhub-relay（deploy/devhub-relay.service:31-33）。
6. **验证**：服务器侧 selfcheck 全绿（预期 = §2.5 实测基线 + 新增数）+ wake 面存活
   （env 三行在位、/etc 物料未动、journal 无 wake 报错；**不发真实 wake 帧**）+ 设备计数对账
   （= 预检快照，本批零设备增减）。
7. **回滚预案**：selfcheck 红或服务异常 → 恢复 §4.2 备份（tgz + db）→ restart → 复验
   health → 如实上报。带病不推进：对账不平/计数偏差 → 停步上报。

## 5. 铁律（全档适用）

- 凭据三零：token/指纹/密钥全值零入日志/汇报/审计；测试用假 token（fixtures 现纪律）。
- 真实库与 ECS 零触碰（除 §4 部署窗口，且该窗口须主控派发）；绝不 ssh 侦察。
- 每 commit 即 push `agent/rot-impl`（绝不 push main）；commit message 沿仓库风格
  （`fix(ecs-relay): …` / `feat(relay): …` / `docs(18): …`）。
- selfcheck §11 三态断言零回退；16+2 帧协议面零改动（丙档新帧除外，且须 docs/18 §3.0 增补
  在先）。
- 卡死 ≤2 次上报，不硬闯。

## 6. 汇报（四分类）

范围档 + 决策点回填对照表；diff 摘要 + 测试数字（基线→终态）；部署要点（停机窗秒数/
selfcheck 实测/journal/对账表）；分支 push 状态 + docs/18 修订落点。
