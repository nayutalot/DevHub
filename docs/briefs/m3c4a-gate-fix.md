# M3-C4a 门禁排障批任务书（smoke 167/168 + mcp A05 两红 → 分支四门禁全绿 + gradle 补跑）

> 主控已查明事实链见 §1，你从结论续做、不重复侦查。
> 基线：main @ a53ff7d（已含 C3a ddd6bbc / C3b adb056e）。门禁应为：tsc 0 / smoke 全量 **168**（fast 82）/ mcp 27/27（main 干净树；分支上 26/27+A12 环境性=惯例）/ gradle `:core:test`=**183** + `:app:assembleDebug` 绿。

## 0. 占用资源清单（机器资源登记）

- **worktree**：`F:/Active_Project/DevHub-worktrees/gate-fix`（分支 `agent/gate-fix`，自 main 切；在 `F:/Active_Project/DevHub` 下执行 `git worktree add F:/Active_Project/DevHub-worktrees/gate-fix -b agent/gate-fix main`）
- **端口 8746 + 进程名互斥（本批独占）**：每次跑 smoke/mcp 前 `taskkill //IM DevHub.exe //F` + `taskkill //IM electron.exe //F`（**两种都必须杀**——残留 dev-electron 占 8746 曾把 smoke 卡死 15min+）；跑毕**不要**重启常驻（常驻重启属后续批）
- 并行批提示：dist-v3 批在同机打包（不占端口不启动应用）；如见其瞬时 electron 进程误杀无碍但勿反向被其干扰
- 不碰：主仓工作区（F:/Active_Project/DevHub 树内零修改，一切在 worktree）、dist/、ECS、模拟器

## 1. 主控已查明事实链

1. **mcp A05**（scripts/mcp-acceptance.mjs:334）断言 `environment.doctor` 给 ≥2 warning 且必含三条真实基线：`windows-python-path-order`、`version-mismatch:node:*`（win vs wsl 主版本差）、`docker-daemon-unreachable`
2. 9-6 20:19 失败报告 `acceptance/mcp-scenario-report.json`：26/27，failed=["A05"]；**同批 environment.detect 输出显示 docker-desktop WSL 发行版在跑** → 当时 Docker daemon 很可能在线 → `docker-daemon-unreachable` 不触发 → **A05 瞬态环境红假设**
3. 主控已实测（晚 21 点+）：docker daemon 现**不可达**（`docker version` 连不上 npipe）、python PATH 顺序 Python39 在 Python313 前（基线成立）、wsl node v18.19.1 vs win v24.15.0（基线成立）→ **三基线现已全部成立，A05 大概率复跑即绿**
4. **smoke 全量 167/168**：失败用例名未识别（识别跑三次被打断）；怀疑面=C3b（adb056e 动了 AgentsView/共享类型）或环境残留（当时有 electron 残留被清）
5. A12 在任务分支必红（branch 断言，**惯例勿改断言**）——分支上 mcp 预期=26/27 且唯一红=A12；A05 也红才算真问题
6. smoke/mcp 均纯 Node 直载 TS 源码（Node ≥23.6 原生类型剥离，无需先 build）；worktree 无 node_modules（主控已核）→ 需 `npm install`

## 2. 任务

1. 建 worktree（见 §0 命令）→ cd 进去 → `npm install`
2. 复现序列：`npm run typecheck` → `npm run smoke:fast`（预期 82/82）→ 跑前杀双进程 → `npm run smoke`（全量 168，**识别那 1 条失败用例名**）→ `npm run mcp`（预期 26/27 仅 A12 红；若 A05 红 → 读 note() 打印的 checks 列表，定位哪条基线断了）
3. **分支判定与处置**：
   - A05 绿 → 环境瞬态结案（汇报写证据链，勿改任何断言）
   - smoke 失败用例在 worktree 稳定复现 → 定位根因（C3b 真回归 vs 测试自身脆弱）→ 最小 diff 修复（代码或测试；**改测试断言必须在汇报中给出根因论证，主控复核**）；修不动=如实上报不硬修
   - smoke 在 worktree 168/168 绿 → 判环境残留结案：再复跑一次确认稳定绿即结案（主仓当时的残留已被清）
4. gradle 补跑：`cd android && ./gradlew :core:test :app:assembleDebug`（:core 预期 183 全绿；local.properties 已在树内勿动）
5. 增量提交接力：每 commit 即 `git push -u origin agent/gate-fix`

## 3. 铁律

- 凭据三零（零入仓库/日志/汇报）；绝不 --no-verify；**不为绿而绿**（改断言必须附根因；A12 断言勿动）
- 单点卡死重试 ≤2 轮；门禁整体挂三次=中断四分类上报
- 收尾进程复查：`tasklist | grep -iE 'devhub|electron'` 为空 + `netstat -ano | grep :8746` 无监听

## 4. 汇报（四分类：完成/部分/阻塞/发现）

- smoke 失败用例名+根因+修复 diff 摘要（或环境性结案证据链）
- A05 结论单独一节（复跑数字+checks 证据）
- 四门禁分支终态表（tsc / smoke:fast / smoke 全量 / mcp / gradle :core+assembleDebug）
- 分支名+最终 commit+push 状态
