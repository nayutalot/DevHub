# X10 批任务书：D4 后桌面重打包+常驻换装（桌面交互线终换装）

> 背景：D4（交互整改五模块）已合本地 main=4feefaf。常驻在役为 X9 版（无 D4 改进）——换装使 D4 进在役。Android 零涉——**不出 APK**（待装件仍=6fcd774f）。

## 1. 重打包（主仓本地 main=4feefaf 干净树）

- 命令（Git Bash）：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ npm run dist`
- 坑：卡住→HTTPS_PROXY=http://127.0.0.1:7897 重试一次；rename 残留→手工清 win-unpacked/win-unpacked.tmp；现役常驻（X9 PID 33808）先 taskkill DevHub.exe；勿死等超 10 分钟。时间戳须晚于 4feefaf。

## 2. asar 验证（grep -F）

1. `backupCollapsed` 或 BackupPanel 折叠标记命中（D4-M1）。
2. `abortedRef`/`:focus-visible` 或 `aria-label` 增量证据命中（D4-M4/M5）。
3. 回归点：`agents-row-selected`/`docker-confirm-impacts`/`LazyView`/`pruneStaleServices`/`ensureZcodeCliConfig`/`managedProbeHysteresisMs`/pdfjs-dist/@napi-rs/canvas。

## 3. dist 根五件归一 + 换装

- 新 NSIS 产物落 dist/ 根；dist-cp6/ 与 DevHub-Android-0.1.0-debug.apk 勿动。
- PowerShell Start-Process 分离启动 dist/win-unpacked/DevHub.exe → curl http://127.0.0.1:8746/v1/health ×3 同 PID 稳定 200 → tasklist 单实例。

## 4. 汇报

零 commit；凭据三零。汇报：构建起止+耗时、asar 逐条带命中数、根五件 sha256、health×3 含 PID、偏差如实。
