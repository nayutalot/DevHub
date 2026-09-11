# X2 批任务书：X 批 origin 修正——桌面重打包+常驻换装

> 背景（主控已查明）：X 批 origin 修正（chatglm.site→zcode.z.ai）已合 main=37bc891 并已推；该常量跑在桌面主进程（zcodeLinkProvider），**不重打包换装不生效**。X 批门禁期间常驻 DevHub.exe 已被双杀且未拉回（本批负责拉起）。Android 面零改动——**不出新 APK**（dist 现有 28923f35 为最终待装件，属 W 批内容）。

## 1. 重打包（主仓 main=37bc891 干净树）

- 工作目录：F:/Active_Project/DevHub（主仓；勿在 worktree 打包）。
- 命令（Git Bash）：
  ```
  ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
  ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
  npm run dist
  ```
- 已知坑（踩坑台账）：@electron/get 的 SHASUMS256.txt 校验恒联网（cacheMode Bypass）——若卡住/超时，加 `HTTPS_PROXY=http://127.0.0.1:7897` 重试（7897 本机代理；若其上游坏，可停手如实上报）。electron-builder 产 NSIS 需要 latest.yml 的 publish 配置已在仓内，勿改。
- 时间戳纪律：构建完成时间须晚于合入 37bc891（自然满足，汇报带构建时间）。

## 2. asar 四点验证（dist/win-unpacked/resources/app.asar）

1. 二进制 grep 含 `https://zcode.z.ai`（新常量值在册）。
2. 二进制 grep `https://zcode.chatglm.site` **零命中**（源码注释里的 chatglm.site 字样无 https:// 前缀，不算命中；有 https:// 前缀命中=旧常量残留=失败）。
3. 回归点：`pdfjs-dist` 条目与 `@napi` / napi-canvas 原生件仍在（CP3b 修复不回退）。
4. review/spawn/reminder 标识仍在（先例四项证据口径）。

## 3. dist 根五件归一 + 换装

- NSIS 根五件（exe/blockmap/latest.yml 等本批新构建产物）落 dist/ 根，形态与在役版一致（W1 纪律）；`dist-cp6/` 备料目录勿碰。
- 换装：启动 `dist/win-unpacked/DevHub.exe`（分离/后台），然后：
  - `curl http://127.0.0.1:8746/health` 连续 3 次、间隔数秒，同 PID 稳定 + 200；
  - 端口/进程核验（tasklist 镜像名 DevHub.exe）；
  - 零锁：无第二实例残留。

## 4. 红线与汇报

- 绝不 --no-verify（本批无 commit 代码改动；若 dist 产物不入 git 则无 commit，仅汇报）。
- 凭据三零；汇报不含任何 sid/hash 值。
- 汇报：①构建起止时间与耗时 ②asar 四点验证逐条结论 ③dist 根五件文件名+sha256 ④换装 health×3 回执（含 PID）⑤任何偏差如实。
