# M3-C6b ECS 修复批任务书（relay_hosts.last_seen 心跳刷新 + 重部署）

> 修复 C2b 批发现#4（观测盲区）。根因已定位，你从结论实施。
> 基线：main @ a8cdbf6；ECS 实测基线 selfcheck 77/77、ecs-relay test 89。

## 0. 占用资源清单（机器资源登记）

- **worktree**：`F:/Active_Project/DevHub-worktrees/c2c-fix-ecs`（分支 `agent/c2c-fix-ecs`，自 main 切；ecs-relay/ 子目录自含依赖，npm install 在 ecs-relay/ 内）
- **ECS 单元独占**（部署+复验；SSH `~/.ssh/devhub_ecs` root@59.110.149.11；root 密码从未用过勿用）
- **本地不占端口不跑四门禁**（8746 归并行批 c2c-fix-local 独占——它会杀常驻，属预期）；不碰模拟器/dist/主仓工作区
- 本地常驻（DevHub.exe）状态不归你管、勿杀勿启

## 1. 主控已查明事实链

- 现象：`relay_hosts.last_seen_at` 仅 admit 时更新，heartbeat 帧不刷新——实测 last_seen 龄 508→543s 不推进（host 腿实际在线），活性观测盲区曾误导排障
- 根因：ecs-relay `src/forwarder.ts:699-701` heartbeat 处理无 touchHost 调用
- 修法：heartbeat 处理补 touchHost（SQL 绑定惯例；对齐既有 last_seen 写路径）
- **last_seen 活体推进验证挪到 C2c 复跑批**（本批期间常驻可能被并行门禁批杀掉、heartbeat 断续不可控）——本批验证=单测+部署+selfcheck+journal

## 2. 任务

1. worktree 自建 → ecs-relay/ 内 npm install → 修复 forwarder.ts heartbeat touchHost
2. 单测：heartbeat 刷新 last_seen（含"admit 后第二帧心跳也刷新"）；全套 `ecs-relay test` 跑绿（89+新增）
3. **重部署 ECS**：按 docs/ecs-relay-deploy README 既有 runbook（git 同步/scp/服务重启三步以 README 为准）；部署窗口内 relay 重启→本地常驻自动重连（已验证机制，无需干预）
4. 部署后复验：devhub-relay active + 版本标识；selfcheck 全绿（77 或含新增项照实报数）；journal 部署后零 error；`relay_devices`/`relay_hosts` SELECT 只读快照（行数/状态不变——hostId=3 行应在、#34 revoked 行应在）
5. 增量提交接力，每 commit 即 push `agent/c2c-fix-ecs`

## 3. 铁律

- ECS 除 devhub-relay 服务代码部署外零改动（安全组/密钥/其他服务勿碰）；SQL 绑定；凭据三零（私钥只在 ECS）
- 部署失败回滚：保留旧版本产物/回退步骤照 README，失败即恢复旧版并四分类上报
- 绝不 --no-verify；单点重试 ≤2

## 4. 汇报（四分类）

- 修复 diff 摘要 + 测试数字（89+新增）；部署过程要点（版本标识/停机窗口秒数）
- selfcheck 实测数 + journal 复验 + 两表快照；分支 push 状态
