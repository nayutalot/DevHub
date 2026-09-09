# 末次重打包任务书：M3-E1+LR1+RW1 全合后的在役包更新（CP3b 依赖修复兑现）+ 常驻换装 + 实启动验证

> 背景（HANDOFF 2026-09-10 中途态 ②）：当前在役安装包=02:16 CP4 版，打包时主仓
> 缺 pdfjs-dist/@napi-rs/canvas（external 化未报错）→ **PDF 识别残缺**。此后 main
> 已并入：M3-E1（aadf9a4）+ LR1（33dd0ae，白名单 104）+ RW1（9eba8ac，Android-only
> 不影响桌面包）+ 真库 007 补丁（B1 批，**须已完成**——本批开工前置）。
> 执行者：omni-agent，直接在主树 F:/Active_Project/DevHub 构建（常驻已下线，
> node_modules 含 CP3b 依赖已验证在位）。

## 0. 主控已核事实（勿重复侦查）

- main=9eba8ac（或更新 docs commit），门禁已绿：tsc 0 / fast 100 / full 190 / mcp 27。
- package.json dependencies 含 `pdfjs-dist ^6.3.289` + `@napi-rs/canvas ^1.0.9`，
  node_modules 双包在位（asar 会带上——dependencies 口径）。
- electron-builder 缓存在位（%LOCALAPPDATA%\electron-builder\Cache：nsis/winCodeSign/
  7zip/downloads）+ node_modules/electron/dist 在位——**离线可打包**；若 builder 仍试图
  联网下载且失败：设 `HTTPS_PROXY=http://127.0.0.1:7897`（若该端口未监听则如实上报，
  不硬等）。踩坑先例：GitHub 直连被墙时 electron-builder 需代理。
- 常驻已下线（本批开工先 tasklist 复核 DevHub.exe/electron.exe 零进程）。
- 真库=C:/Users/sakuya/AppData/Roaming/DevHub/devhub.db 已补 007（B1 批；
  开工前只读复核 archive_runs 两列在——`node -e` better-sqlite3 PRAGMA table_info）。

## 1. 执行序

1. 预检：常驻零进程；真库 007 两列在；`npx tsc --noEmit` 0 error。
2. 构建：`npm run dist`（先 electron-vite build 再 electron-builder --win；产物
   dist/win-unpacked + NSIS 件）。构建时长如实记录。
3. 产物核验（asar 内容证据，`npx asar list` 或解包抽查）：
   - **PDF 依赖在包内**：app.asar 内 node_modules/pdfjs-dist 与 @napi-rs/canvas
     目录存在（或 asar list 可见其文件）——本批核心验收点；
   - LR1 在包内：asar 内 out/main 或 resources 路径 grep `reviewService`/
     `review_pre_json` 任一标识；
   - M3-E1 在包内：grep `spawn_session`/`SPAWN_REJECTED` 任一标识；
   - CP4 在包内：grep `reminderEngine`/`contest_reminder_log` 任一标识。
4. 换装（部署窗口内一气呵成）：
   - 旧版备份：dist/win-unpacked → dist/win-unpacked.bak-<YYYYMMDD-HHMM>；
     根五件（exe/yml 等安装器产物）按 W1 先例归一更新（旧的移 .bak 同目录或记录）；
   - 拷入新版 win-unpacked；
   - 起新常驻：`cmd //c start "" "F:\Active_Project\DevHub\dist\win-unpacked\DevHub.exe"`；
   - `curl -s http://127.0.0.1:8746/v1/health` → 200（重试 ≤5 次/间隔 3s）。
5. 实启动验证（面向用户的在役面）：
   - health 200 + 进程稳定（30s 后复测仍 200，单主进程）；
   - /v1/agents REST 面 200（设备/会话投影可读）；
   - 真库无锁错误：常驻运行 1 分钟后日志/journal 无 database locked（日志位置
     %APPDATA%\DevHub\ 下如有；没有则跳过并注明）；
   - **不做的**：不点 UI、不发真实通知、不动 ECS、不跑 smoke（本批只验在役面）。
6. 收尾：不产仓内提交（dist 不入库，确认 .gitignore）；备份不删。

## 2. 铁律

- 不改源码；四门禁不跑（已在本树绿过）；卡死重试 ≤2。
- 换装失败（起不来/health 不 200）→ 回滚：杀新进程、恢复 win-unpacked.bak、
  重启、复验 health，如实上报（常驻不许长期缺席）。
- 凭据零入日志。

## 3. 汇报

构建时长+产物路径；asar 四项内容证据（PDF 依赖/review/spawn/reminder 的 grep
输出）；备份路径；常驻起停时间戳+health 200 实录（两次）；回滚是否启用（预期否）。
