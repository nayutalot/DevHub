# X5 批任务书：Z2 后桌面重打包+常驻拉回

> 背景：Z2（子会话终态接线）已合 main=c127ff6。常驻现为离线（Z2 门禁双杀未拉回）——本批重打包并拉回在役。Android 面零改动——**不出 APK**（待装件仍=47158b8f）。

## 1. 重打包（主仓 main=c127ff6 干净树）

- 命令（Git Bash）：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ npm run dist`
- 坑：卡住→HTTPS_PROXY=http://127.0.0.1:7897 重试一次；rename 残留→手工清 win-unpacked/win-unpacked.tmp（常驻已杀应无 EPERM）；勿死等超 10 分钟。时间戳须晚于 c127ff6。

## 2. asar 验证（grep -F）

1. `evalZcodeTurnStatus` 与 `turn_usage` 命中（Z2 接线在位）。
2. 回归点：`ensureZcodeCliConfig`、`zcode_managed_model`、`ZcodeManagedSettingsCard`、pdfjs-dist、@napi-rs/canvas、review/spawn/reminder。

## 3. dist 根五件归一 + 换装

- 新 NSIS 产物落 dist/ 根；dist-cp6/ 与 DevHub-Android-0.1.0-debug.apk 勿动。
- 启动 dist/win-unpacked/DevHub.exe（分离）→ curl http://127.0.0.1:8746/v1/health ×3 同 PID 稳定 200 → tasklist 单实例。

## 4. 红线与汇报

- 零 commit；凭据三零。汇报：构建起止+耗时、asar 验证逐条带命中数、根五件 sha256、health×3 含 PID、偏差如实。
