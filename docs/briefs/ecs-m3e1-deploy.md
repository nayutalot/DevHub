# ECS M3-E1 部署任务书：relay 七值 action + sql 0003 表重建 + 线上验证

> 依据：HANDOFF（2026-09-10 02:5x）中途态 ④——M3-E1 已合 main（aadf9a4，已推），
> ECS 侧部署未做。本批=把 main 树的 ecs-relay 代码 + 0003 迁移落到 ECS 并验证。
> 执行者：omni-agent（SSH 执行；**ECS 纪律：零 Agent 常驻、凭据零入仓零日志**）。
> 主控已实测前置（2026-09-10 本会话）：服务 active、wake.ts 在役、WAKE env 3 行在位、
  relay_commands 现存 4 行（重建须保全）。

## 0. 已实测事实链（主控 2026-09-10，勿重复侦查）

- **登录**：`ssh -i ~/.ssh/devhub_ecs root@59.110.149.11`（无密码；Windows 侧无别名）。
- **现网状态**：devhub-relay systemd active；`/opt/devhub-relay/src/` 含 RW0 全量
  （wake.ts/server.ts/store.ts 等 13 文件）；`/etc/devhub-relay/env` WAKE 三行在位；
  `/etc/devhub-relay/{ssh_config,wake_key,wake_known_hosts}` 0600 devhub-relay（RW0 物料，
  **部署不得触碰**）。
- **relay.db**：`/var/lib/devhub-relay/relay.db`；表 {pairing_codes, relay_connections,
  relay_events, relay_audit, relay_devices, relay_hosts, relay_commands, relay_event_acks,
  relay_meta}；PRAGMA user_version=0（**relay 库不用 user_version 记迁移**——先查
  relay_meta 内容确认 0001/0002 的在册方式，0003 照同风格记录，防重复应用误判）。
- **本批增量（main 树 vs 现网差异）**：`ecs-relay/src/forwarder.ts`（RELAY_ACTIONS
  五值→七值）、`ecs-relay/sql/0003_self_mgmt_actions.sql`（表重建：relay_commands_v3
  建→逐行复制→换名→重建索引）、`ecs-relay/src/selfcheck.mjs`（M3-E 步）、
  `ecs-relay/test/forwarder.test` 两用例等——**以 `git diff` 实际文件清单为准**
  （对比基线=现网 /opt/devhub-relay 与 main 树 ecs-relay/ 的 diff，逐文件核对）。
- **门禁基线**：main 树 ecs-relay node --test **99**（97+2）/ selfcheck **83+1SKIP**
  （M3-E1 分支自跑已绿；本批服务器侧复验 selfcheck，本地 99 由并行门禁批覆盖）。
- **先例**：RW0 部署（HANDOFF §4.4）备份 relay-backup-preRW0-*.tgz + 3.1s 级停机
  （C7a 先例）——重启窗口可接受。

## 1. 执行序（每步留证，输出到汇报）

1. **预检**：systemctl is-active + curl 本机 health（8443 面）+ relay_meta 全量读出
   （迁移在册方式）+ relay_devices/relay_commands 计数快照（对账基线）。
2. **备份**：`/var/lib/devhub-relay/relay.db` → `/root/relay-db-backup-preM3E1-<ts>.db`；
   `/opt/devhub-relay` → `/root/relay-backup-preM3E1-<ts>.tgz`（对齐 RW0 命名）。
3. **代码同步**：main 树 `ecs-relay/`（F:/Active_Project/DevHub/ecs-relay/，**只读源**）
   → /opt/devhub-relay/（src/sql/test/package.json 按仓库结构；先 diff 后覆盖；
   **绝不触碰 /etc/devhub-relay/ 任何文件**）。package.json 依赖若无新增免 npm install，
   有则服务器 npm install（离线优先 --offline，失败再registry）。
4. **构建**：按现网既有流程（tsc 产物或部署脚本——查 /opt/devhub-relay 内既有构建方式
   照做；RW0 部署即此路径）。
5. **SQL 0003**：sqlite3 应用 `sql/0003_self_mgmt_actions.sql`（事务包裹；应用后
   核验：action CHECK 含七值、行数=快照对账 4 行全保、索引在）+ relay_meta 照既有
   风格记录 0003。
6. **重启**：`systemctl restart devhub-relay`；is-active + journalctl 无新错 +
   curl health。
7. **验证**：selfcheck（预期 83 通过+1SKIP，含 M3-E 步：七值 action 中继/未知 action
   仍 BAD_PAYLOAD）+ wake 面存活（env 三行 + /etc 物料未动 + journal 无 wake 报错；
   **不发真实 wake 帧**——真实链路留用户真关机实测）+ relay_devices 计数对账
   （应=快照，本批零设备增减）。
8. **回滚预案**：selfcheck 红或服务异常 → 恢复备份 tgz+db → restart → 复验 health →
   如实上报（不硬撑）。

## 2. 铁律

- 绝不触碰 /etc/devhub-relay/（env 与 RW0 SSH 物料）；绝不删备份；停机窗口内完成重启。
-凭据零入日志/汇报（token/密钥路径可写，内容零出现）。
- 任何与任务书预期不符（行数对账不平/selfcheck 计数偏差）→ 停步上报，不带病推进。

## 3. 汇报

部署时间线（各步时间戳）+ 对账表（relay_commands 行数前后/selfcheck 计数/health）+
代码同步清单（diff 文件列表）+ 回滚是否启用（预期否）。
