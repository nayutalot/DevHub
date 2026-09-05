# M3-P0b 批任务书（smoke 分层：快速档/全量档）

> 依据：docs/briefs/m3-deploy-plan.md §2（用户已认可的四项技术建议之四，"M2 合并后择机"=现在）。基线 main=93406da，smoke **164/164**。

## 0. 占用资源清单（机器资源登记）

- **worktree**：`F:\Active_Project\DevHub-worktrees\smoke-tiers`，分支 `agent/smoke-tiers`（自 93406da 创建；**主仓 checkout 正被并行批占用，绝不碰**）
- **端口 8746-8755 + DevHub.exe 常驻**：跑门禁期间独占——跑 smoke 前 `taskkill //IM DevHub.exe //F`，跑完 `cmd //c start "" "F:\Active_Project\DevHub\dist\win-unpacked\DevHub.exe"` 恢复 + `curl http://127.0.0.1:8746/v1/health` 确认 200（端口铁律）
- 不用模拟器；不碰 android/、ecs-relay/、MCP

## 1. 任务

1. `scripts/smoke.mjs` 拆两档：**快速档**（纯逻辑/单元类用例，目标 <2min）+ **全量档**（默认=现行为，含 Gateway/e2e/端口类）。**164 条一条不删不改用例本体**（append-only 铁律）——分层=用例/段标记或分组，允许的编辑仅限：加 tier 标记、CLI 分档入口、必要的段结构微调（不改断言语义）。
2. CLI：`--tier=fast|full`，默认 full（现行为零变化）；package.json 加 `"smoke:fast": "node scripts/smoke.mjs --tier=fast"`。
3. 分类方法：按用例依赖面归类（拉起 Gateway/占 8746-8755/起子进程的 → full；纯函数/编解码/解析类的 → fast）。边界拿不准的归 full（保守）。
4. 全量档计数断言保持动态计算（R1 批设计），fast 档打印自己的计数行。

## 2. 门禁（全绿才算过）

1. `npm run typecheck` 0 错
2. 全量档 `npm run smoke`：**164/164，与分层前逐段一致**（对拍输出）
3. 快速档实跑计时 **<2min**，汇报实测数字
4. `npm run build` 绿
5. mcp-acceptance：先 commit（树净）再 `node scripts/mcp-acceptance.mjs` 27/27
6. 端口铁律全程遵守（§0）

## 3. 铁律与汇报

- 只动 `scripts/smoke.mjs` + `package.json`（+必要注释）；绝不 --no-verify
- 增量提交 + 每次 commit 后 `git push origin agent/smoke-tiers`
- 汇报四分类：已完成并验证/仅本地验证/环境阻塞/待用户；必带分支+SHA+各门禁数字+fast 档实测时长+快速/全量用例数分布+推送状态
