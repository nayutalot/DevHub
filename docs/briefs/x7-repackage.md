# X7 批任务书：D1 后桌面重打包+常驻换装

> 背景：D1（桌面体验整改 P1×3+快赢×3，纯 renderer）已合本地 main。常驻在役为 X6 版（无 D1 改进）——换装使 D1 进在役。Android 零涉——**不出 APK**（待装件仍=6fcd774f）。

## 1. 重打包（主仓本地 main 干净树）

- 命令（Git Bash）：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ npm run dist`
- 坑：卡住→HTTPS_PROXY=http://127.0.0.1:7897 重试一次；rename 残留→手工清 win-unpacked/win-unpacked.tmp；现役常驻在役须先 taskkill DevHub.exe（防 DLL 锁）；勿死等超 10 分钟。

## 2. asar 验证（dist/win-unpacked/resources/app.asar，grep -F）

1. `agents-row-selected` 命中（D1-M4 新样式类）。
2. `docker-confirm-impacts` 命中（D1-M1 modal）且 **window.prompt 零命中**（renderer bundle 内；若主进程/vendor 有历史命中需定位甄别，renderer 面必须零）。
3. 回归点：`ensureZcodeCliConfig`/`managedProbeHysteresisMs`/`zcode_managed_model`/pdfjs-dist/@napi-rs/canvas。

## 3. dist 根五件归一 + 换装

- 新 NSIS 产物落 dist/ 根；dist-cp6/ 与 DevHub-Android-0.1.0-debug.apk 勿动。
- 启动 dist/win-unpacked/DevHub.exe（分离）→ curl http://127.0.0.1:8746/v1/health ×3 同 PID 稳定 200 → tasklist 单实例。

## 4. 汇报

零 commit；凭据三零。汇报：构建起止+耗时、asar 逐条带命中数、根五件 sha256、health×3 含 PID、偏差如实。
