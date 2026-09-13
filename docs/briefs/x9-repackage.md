# X9 批任务书：D2 后桌面重打包+常驻换装（桌面优化线终换装）

> 背景：D2（用户面文案统一中文，27 文件）已合本地 main=c458d47。常驻在役为 X8 版（无 D2 文案）。Android 零涉——**不出 APK**（待装件仍=6fcd774f）。

## 1. 重打包（主仓本地 main=c458d47 干净树）

- 命令（Git Bash）：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ npm run dist`
- 坑：卡住→HTTPS_PROXY=http://127.0.0.1:7897 重试一次；rename 残留→手工清 win-unpacked/win-unpacked.tmp；现役常驻（X8 PID 33588）先 taskkill DevHub.exe；勿死等超 10 分钟。时间戳须晚于 c458d47。

## 2. asar 验证（grep -F）

1. `仪表盘`（D2 中文 nav 名）与 `容器`（统一译法）命中。
2. 回归点：`agents-row-selected`/`docker-confirm-impacts`/`LazyView`/`pruneStaleServices`/`ensureZcodeCliConfig`/`managedProbeHysteresisMs`/`zcode_managed_model`/pdfjs-dist/@napi-rs/canvas。

## 3. dist 根五件归一 + 换装

- 新 NSIS 产物落 dist/ 根；dist-cp6/ 与 DevHub-Android-0.1.0-debug.apk 勿动。
- 启动 dist/win-unpacked/DevHub.exe（PowerShell Start-Process 分离；后台 bash 的 cmd start 有拉不起先例）→ curl http://127.0.0.1:8746/v1/health ×3 同 PID 稳定 200 → tasklist 单实例。

## 4. 汇报

零 commit；凭据三零。汇报：构建起止+耗时、asar 逐条带命中数、根五件 sha256、health×3 含 PID、偏差如实。
