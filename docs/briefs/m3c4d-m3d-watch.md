# M3-C4d M3-D 巡检面搭建批任务书（72h 稳定期监测工具，只搭建不启动）

> 背景：C2b 全过后启动 M3-D 72h 稳定期（T0 记时+巡检）。本批把巡检工具搭好并只读试跑验证，**不启动 72h 运行、不重启常驻、不跑 C2b**。
> 工具定位：scripts/ 下独立运维脚本（与 smoke/mcp-acceptance 同级的 tooling），**不是应用代码**——不触碰 src/main 的 spawn 架构约束（exec.ts 唯一 spawn 是应用内约束，与本脚本无关）。

## 0. 占用资源清单（机器资源登记）

- **worktree**：`F:/Active_Project/DevHub-worktrees/m3d-watch`（分支 `agent/m3d-watch`，自 main 切；纯 Node 零新依赖，无需 npm install）
- 端口：**只读 GET 不监听**（对 8746 的探测是发请求不是绑定——与并行批 gate-fix 的门禁运行零冲突）；不杀任何进程
- **ECS 只读**（可选 --deep 模式 SSH；ECS 单元当前空闲归你；零改动）
- 不碰：常驻进程、模拟器、主仓工作区、dist/

## 1. 任务：`scripts/m3d-watch.mjs`（纯 Node .mjs，零新依赖）

单周期检查项（每项产出 ok/degraded/down + 详情，汇总一行 JSON）：
1. **本地网关**：GET `http://127.0.0.1:8746/v1/health` 200？（当前常驻 DOWN=预期 down，脚本报 down 而非崩溃——错误路径要能跑通）
2. **relay host 腿**：从主仓源码研究本地查询面（settings relay_enabled 的 REST 读法；若有 relay 连接状态面/日志标记 `%LOCALAPPDATA%\DevHub\logs` 里 relayClient connected 标记则用之）→ 输出 `relay.connected: true/false/null(常驻不在)`
3. **公网 relay 可达**：HTTPS GET `https://59.110.149.11/<健康路径>`——健康路径从 ecs-relay/ 源码查明（selfcheck 用的那个）；TLS 用 `%LOCALAPPDATA%\DevHub\relay\ca.pem` 做 CA（Node https 指定 ca，勿用 rejectUnauthorized:false）
4. **证书余量**：从握手 peer cert 读 valid_to 算剩余天数（<14 天=degraded，与 selfcheck 证书日历口径一致；当前基线约 89 天/notAfter 2026-12-04）
5. **--deep（可选模式）**：SSH `ssh -i ~/.ssh/devhub_ecs root@59.110.149.11` 读 journalctl 近 N 小时 error 计数（只读；凭据零入输出）

运行形态：
- 默认单周期：一行 JSON 到 stdout + 追加 `%LOCALAPPDATA%\DevHub\m3d-watch\watch.ndjson`（仓外，零仓库污染；--out 可覆盖）
- `--loop <分钟>` 自循环；`--t0` 写 T0 标记文件（ISO 时间）+打印；`--summary <ndjson>` 汇总（周期数/ok 率/首个与最后错误/网关 down 时段数）
- 退出码：全 ok=0；有 degraded/down=1（供调度告警）
- 零密钥零 token；IP/路径可硬编码（公网面）

## 2. 本批验证（只读，不启动 72h）

1. 单周期跑一次：预期输出 gateway:down（常驻 DOWN 属实）+ relay 公网 ok + cert ~89 天——**这条 JSON 附进汇报**
2. `--summary` 对刚产出的 ndjson 跑通
3. `node --check scripts/m3d-watch.mjs` 语法过；不跑四门禁（gate-fix 批独占）；不改任何测试断言
4. commit + push 分支 `agent/m3d-watch`

## 3. 铁律

- 只读探测零副作用；ECS 零改动；绝不杀进程/占端口；凭据三零；绝不 --no-verify
- 源码研究结论（健康路径/日志标记）写进脚本头注释，M3-D 启动批直接可用

## 4. 汇报（四分类）

- 脚本用法面（flags 表）+ 实测单周期 JSON 行 + summary 输出
- relay 状态查询面的研究结论（REST 路径或日志标记是什么、连通态怎么判）
- 分支 push 状态；T0 文件与 ndjson 的落点说明
