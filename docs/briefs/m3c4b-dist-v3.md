# M3-C4b dist 重打包 v3 批任务书（main 全量含 C3a/C3b renderer 修复；只构建不部署）

> 前版 v2=主仓 `dist/win-unpacked` @ 9-6 15:07（C1c 期构建，**不含** C3a relay WS pair 传输/TLS pin 通配符修复/R5.3 事件驱动、C3b 宽限/面板刷新）。v3=main @ a53ff7d 全量。
> 配方参考：docs/briefs/m3-dist-repack.md（v1 批任务书，步骤可复用，**但本批只构建、不部署、不启动产物**——部署+换装归后续批）。

## 0. 占用资源清单（机器资源登记）

- **worktree**：`F:/Active_Project/DevHub-worktrees/dist-v3`（**detached**：在 `F:/Active_Project/DevHub` 下执行 `git worktree add --detach F:/Active_Project/DevHub-worktrees/dist-v3 main`）
- **无端口占用**（不跑门禁——8746+进程清理归并行批 gate-fix 独占）；**不启动打包产物**（绝不拉起 DevHub.exe/electron.exe）
- 不碰：主仓 `dist/`（只读勿动）、ECS、模拟器、主仓工作区
- electron-builder 缓存在 %LOCALAPPDATA% 机器级共享，无需重下

## 1. 任务

1. worktree 内 `npm install` → `npm run typecheck`（0 错，防环境差异）→ `npm run dist`（electron-vite build + electron-builder --win）
2. **包内修复证据**（asar 解包或 out/ 产物 grep，至少 4 条各配 grep 输出）：C3a 标识（如 `RelayPairingClient`/relay pair WS 传输）、TLS pin 通配符修复标识、R5.3 事件驱动标识（事件驱动刷新相关）、C3b 标识（轮换宽限 300s/grace 常量、RelayPanel 事件刷新）
3. 版本核验：`dist/win-unpacked/DevHub.exe` 存在+大小+构建时间戳；NSIS exe+latest.yml 版本行
4. **收尾进程复查**：`tasklist | grep -iE 'devhub|electron'` 为空、`netstat -ano | grep :8746` 无监听（builder 不得留进程；若并行批的 taskkill 误杀 builder 子进程导致构建失败，重试一次并汇报）
5. **零仓内提交**（dist 目录 gitignored；detached worktree 无分支无 push）——交付物=worktree 内产物+汇报

## 2. 铁律

- 不改任何源码；不改主仓 dist/（后续批从 `F:/Active_Project/DevHub-worktrees/dist-v3/dist/` 取产物）
- electron-builder 网络问题（winCodeSign 下载等）重试 ≤2 次，仍挂=换镜像/离线缓存路径建议并四分类上报

## 3. 汇报（四分类）

- 产物路径+大小+时间戳（win-unpacked 与 NSIS exe 分列）
- 包内修复 grep 证据 ≥4 条
- 进程/端口清零声明；磁盘占用变化
