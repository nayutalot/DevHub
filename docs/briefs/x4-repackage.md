# X4 批任务书：T2e 后桌面重打包+常驻换装

> 背景：T2e（密钥注入改版 env→CLI 配置文件）已合 main=d6d6ac2。常驻现为 X3 版（env 注入版 T2，功能等价）——按 dist 时间戳纪律换装使 T2e 进在役。Android 面零改动（U1/U2 已在 a004b94f APK）——**不出 APK**。

## 1. 重打包（主仓 main=d6d6ac2 干净树）

- 工作目录 F:/Active_Project/DevHub（勿用 worktree）。
- 命令（Git Bash）：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ npm run dist`
- 已知坑：①@electron/get 校验恒联网，卡住→加 HTTPS_PROXY=http://127.0.0.1:7897 重试一次；②**现役 X3 常驻正从 dist/win-unpacked 运行会锁 DLL（EPERM 先例）——先 taskkill DevHub.exe 再打包**；③Windows 目录 rename 残留→手工清 win-unpacked/win-unpacked.tmp 后重试（X3 先例，两次 EPERM 属正常）。
- 时间戳纪律：构建完成须晚于 d6d6ac2。

## 2. asar 验证（dist/win-unpacked/resources/app.asar，grep -F 固定字符串）

1. 含 `ensureZcodeCliConfig` 且含 `cli`+`config.json` 组合证据（T2e 新机制在位）。
2. **反向**：`buildManagedSpawnEnv` 与 `buildZcodeCliEnv` **零命中**（env 注入面已退役）。
3. 回归点：`zcode_managed_model`、`session/create`、`ZcodeManagedSettingsCard`、pdfjs-dist、@napi-rs/canvas、review/spawn/reminder 标识（X3 口径同）。

## 3. dist 根五件归一 + 换装

- 新 NSIS 产物落 dist/ 根；dist-cp6/ 勿碰；dist 的 DevHub-Android-0.1.0-debug.apk（a004b94f）勿动。
- 换装：启动 dist/win-unpacked/DevHub.exe（分离）→ `curl http://127.0.0.1:8746/v1/health` ×3（间隔数秒）同 PID 稳定 200 → tasklist 单实例核验。

## 4. 红线与汇报

- 无代码改动零 commit；凭据三零（汇报零 key/零完整 URL/零 sid/hash）。
- 汇报：①构建起止+耗时（含 EPERM 重试如实）②asar 验证逐条带命中数 ③根五件文件名+sha256 ④health×3 回执含 PID ⑤偏差如实。
