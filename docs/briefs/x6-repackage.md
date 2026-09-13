# X6 批任务书：B2 后桌面重打包+常驻拉回

> 背景：B2（托管面健壮性四修）已合本地 main=4c27235。常驻离线（B2 门禁双杀未拉回）。Android 面零改动——**不出 APK**（待装件仍=6fcd774f）。

## 1. 重打包（主仓本地 main=4c27235 干净树）

- 命令（Git Bash）：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ npm run dist`
- 坑：卡住→HTTPS_PROXY=http://127.0.0.1:7897 重试一次；rename 残留→手工清 win-unpacked/win-unpacked.tmp；勿死等超 10 分钟。时间戳须晚于 4c27235。

## 2. asar 验证（grep -F）

1. `managedProbeHysteresisMs` 与 `sinkErrors` 命中（B2 四修在位）。
2. 回归点：`ensureZcodeCliConfig`/`evalZcodeTurnStatus`/`turn_usage`/`zcode_managed_model`/`ZcodeManagedSettingsCard`/pdfjs-dist/@napi-rs/canvas。

## 3. dist 根五件归一 + 换装

- 新 NSIS 产物落 dist/ 根；dist-cp6/ 与 DevHub-Android-0.1.0-debug.apk 勿动。
- 启动 dist/win-unpacked/DevHub.exe（分离）→ curl http://127.0.0.1:8746/v1/health ×3 同 PID 稳定 200 → tasklist 单实例。

## 4. 汇报

零 commit；凭据三零。汇报：构建起止+耗时、asar 逐条带命中数、根五件 sha256、health×3 含 PID、偏差如实。
