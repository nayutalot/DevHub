# X3 批任务书：zcode 托管两轨批——桌面重打包+常驻换装

> 背景：T2（zcode 托管 provider）+T2b（renderer 设置卡）+T2c（误报消除）已合 main=c2d7fca。桌面常驻现为 X2 版（X 批 origin 修正版）——**不换装 T2 功能不生效**。Android 面零改动（T1 已在 57d486f7 APK 中）——**不出 APK**，dist 待装件不变。

## 1. 重打包（主仓 main=c2d7fca 干净树）

- 工作目录 F:/Active_Project/DevHub（勿用 worktree）。
- 命令（Git Bash）：
  ```
  ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
  ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
  npm run dist
  ```
- 已知坑：@electron/get SHASUMS256 校验恒联网，卡住/超时→加 `HTTPS_PROXY=http://127.0.0.1:7897` 重试一次；再失败停手如实上报（勿死等 >10 分钟）。

## 2. asar 验证（dist/win-unpacked/resources/app.asar）

1. 含 `zcode_managed_model`（settings 键在册）。
2. 含 `session/create` 且含 `ZcodeManagedSettingsCard` 或「ZCode 托管模型」（协议面+renderer 卡都在）。
3. 回归点：pdfjs-dist 条目+@napi/canvas 原生件仍在；review/spawn/reminder 标识仍在。
4. 本机 grep 若为 ugrep：域名/常量类固定字符串用 -F 模式（转义点模式有误报先例）。

## 3. dist 根五件归一 + 换装

- NSIS 根五件新产物落 dist/ 根；dist-cp6/ 勿碰；dist 现有 DevHub-Android-0.1.0-debug.apk（57d486f7）勿动。
- 换装：taskkill 现役 DevHub.exe（X2 版）→ 启动 dist/win-unpacked/DevHub.exe（分离）→ `curl http://127.0.0.1:8746/v1/health` ×3（间隔数秒）同 PID 稳定 200 → tasklist 核验单实例。
- 时间戳纪律：构建完成时间须晚于 c2d7fca 提交时间。

## 4. 红线与汇报

- 无代码改动无 commit（产物 git 外）；凭据三零（汇报零 sid/hash/零完整遥控 URL/零 API key）。
- 汇报：①构建起止+耗时 ②asar 四点逐条（带命中数）③根五件文件名+sha256 ④health×3 回执含 PID ⑤偏差如实。
