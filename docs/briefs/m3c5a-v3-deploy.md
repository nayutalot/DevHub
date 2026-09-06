# M3-C5a v3 换装批任务书（部署 dist v3 + 重启常驻 + relay 自动重连验证）

> 前置（主控已确认才派发）：main 干净树四门禁全绿（tsc 0/smoke 168/mcp 27/gradle :core 183+assembleDebug）；v3 产物就绪 `F:/Active_Project/DevHub-worktrees/dist-v3/dist/`（win-unpacked DevHub.exe 245MB + NSIS Setup + latest.yml，sha256 已录 C4b 汇报）。
> v3 验收口径（C4b 考古修正）：v3=main 全量，Windows 包相对 v2 的真实增量=C3b fix3 renderer（RelayPanel 勾选态回刷 DB 真值）；C3a 修复主体在 Android/ECS 侧，**不以此责 Windows 包**。`app-update.yml` 内 dummy URL 无害（应用无 electron-updater 依赖）。

## 0. 占用资源清单（机器资源登记）

- **8746 + DevHub.exe 常驻 + 主仓 dist/**：本批独占（门禁已毕，D 批巡检工具只读 GET 无冲突）
- 不碰：ECS（零改动零连接需求——验证走公网只读面）、模拟器、主仓工作区源码、四门禁
- 测毕**常驻保持运行**（后续 C2b 批依赖）

## 1. 任务

1. **备份**：主仓 `dist/win-unpacked`（v2）→ 改名 `dist/win-unpacked.bak-v2-20260906`（旧 bak-20260906 是 v1 勿动）
2. **换装**：`F:/Active_Project/DevHub-worktrees/dist-v3/dist/win-unpacked/` 整目录拷入主仓 `dist/win-unpacked/`；同批把 dist-v3 的 `DevHub Setup 0.1.0.exe`/`DevHub 0.1.0.exe`/latest.yml/blockmap 覆盖主仓 `dist/` 根（替换 9-5 旧 v1 件）
3. **启动常驻（纯生产形态，无 debug port）**：`taskkill //IM DevHub.exe //F`（若残留）→ `cmd //c start "" "F:\Active_Project\DevHub\dist\win-unpacked\DevHub.exe"`
4. **验证四件套**（每件留证据进汇报）：
   a. 进程：`tasklist` 有 DevHub.exe + 记 PID + **核镜像名确为 DevHub.exe 非 electron.exe**（残留 electron 伪装常驻的教训）
   b. 网关：`curl http://127.0.0.1:8746/v1/health` 200
   c. **relay 自动重连**（核心判据）：settings 持久化 enabled=1+endpoint → 等重连（退避可能 1-3 分钟，轮询 ≤5 分钟）→ 在主仓跑 `node scripts/m3d-watch.mjs` 单周期：期望 `gateway.status=ok` + `relay.connected=true`（source=ecs-upstream）+ `publicRelay.status=ok` + `cert.status=ok`——**该 JSON 行原文附汇报**
   d. 信任三物在位：`%LOCALAPPDATA%\DevHub\relay\`（credential/fingerprints/ca.pem 三文件存在即可，内容零入汇报）
5. **失败处置**：v3 起不来或 health 不 200 → 恢复 v2 备份重启常驻（保机器有常驻）→ 四分类上报 FAIL；重连不成功（connected≠true）→ 重启常驻重试 ≤1 次，仍不成立=如实上报（附带 m3d-watch JSON + ECS 侧事实留主控查），**不展开修码**
6. 零仓内提交（dist 整目录 gitignored）；worktree dist-v3 本批后仍保留（主控统一清）

## 2. 铁律

- 不改源码不跑门禁；ECS 零连接零改动；凭据三零；指纹只报 16+8 短值
- 拷贝用 robocopy 或 cp -r 保完整；换装失败必须回滚 v2 不留半装态

## 3. 汇报（四分类）

- 四件套证据（PID+镜像名/curl 200/m3d-watch JSON 行/三物在位）
- v2 备份路径 + 新增产物清单（大小+sha256 摘选）+ 常驻终态（运行中 PID）
- 磁盘占用变化；失败路径的话附回滚声明
