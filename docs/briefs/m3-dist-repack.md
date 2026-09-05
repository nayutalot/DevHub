# dist 重打包批任务书（打包版 DevHub 含 relayClient）

> 背景：常驻 `F:\Active_Project\DevHub\dist\win-unpacked\DevHub.exe` 是旧版打包，**不含 relayClient**（M2-R1 并 main 于 b329deb）。M3 联调需要新版打包桌面端。基线 main @ 7aeb736。

## 0. 占用资源清单（机器资源登记）

- **worktree**：`F:\Active_Project\DevHub-worktrees\dist-repack`（`git worktree add F:/Active_Project/DevHub-worktrees/dist-repack 7aeb736`，detached 或临时分支均可）；构建在 worktree 内（npm install + npm run dist）
- **主仓 dist\ 目录 + DevHub.exe 常驻**：部署阶段独占——旧 win-unpacked 先改名备份（`win-unpacked.bak-<日期>`），新版就位后杀旧常驻、起新常驻、curl http://127.0.0.1:8746/v1/health 确认 200
- 不占 8746-8755 监听（不跑门禁）；不碰 ecs-relay/、android/、scripts/
- electron-builder 缓存在 %LOCALAPPDATA% 机器级共享，无需重下

## 1. 任务

1. worktree 内 `npm install`（或 npm ci）→ `npm run typecheck`（0 错，防环境差异）→ `npm run dist`
2. 产物核验：worktree `dist/win-unpacked/DevHub.exe` 存在；**relayClient 在包内**——在产物 `resources/app`（或 asar 解包/`out/main` 产物）grep 验证 relayClient 标识（如 `relayClient`/`relay_endpoint` 字符串、`markEventsAckedThrough` 函数名等任一可 grep 证据）
3. 部署：主仓 `dist/win-unpacked` → 备份旧版 → 拷入新版 → `taskkill //IM DevHub.exe //F`（若在跑）→ `cmd //c start "" "F:\Active_Project\DevHub\dist\win-unpacked\DevHub.exe"` → `curl -s http://127.0.0.1:8746/v1/health` 200 确认
4. 回归冒烟：curl /v1/health、/v1/agents（或任一既有 REST 面）200；确认设置面 relay 相关键可用（读 settings 的 REST 面 relay_enabled 字段存在即可，不启用）
5. **不产出仓内提交**（dist 目录不入库——确认 .gitignore 覆盖；若 worktree 有意外改动则丢弃）。本批交付物=部署态+汇报，无需 push

## 2. 铁律与汇报

- 不改任何源码；不跑四门禁；DevHub.exe 只在部署阶段动（并行 A⑥ 批已被告知不碰它）
- 失败重试 ≤2 次；electron-builder 网络问题（winCodeSign 下载等）换镜像/离线缓存路径上报
- 汇报四分类，必带：产物路径+版本标识、relayClient 在包内证据（grep 输出）、旧版备份路径、常驻 health 200 确认、settings relay 键可见确认、磁盘占用变化
