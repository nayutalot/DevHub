# M2-R3 收尾批任务书（android-relay 门禁实跑 + 模拟器四类截图 + 终提交）

> 派发基线：worktree `F:\Active_Project\DevHub-worktrees\android-relay`，分支 `agent/android-relay`，HEAD=**6a80ae8**（全功能块完成；该提交含中断前已截的 `acceptance/agents-mobile/relay-01-mode-select.png`，四类截图只差三类，门禁是否实跑过需重验）。
> 本任务书为权威版本（HANDOFF §5.2 的落盘副本+补充）；与 HANDOFF 冲突时以本文档为准。

## 0. 占用资源清单（机器资源登记）

- **模拟器 1 台**（AVD 自选现存可用的；结束后关掉不留常驻）
- **桌面常驻 Gateway 127.0.0.1:8746**：local 模式回归的连接对象——**绝不杀 DevHub.exe 常驻**（与 R1 批互斥资源，本批只作客户端连接）
- **不占用** 8746-8755 监听（只作为客户端连 8746）；不用段外监听端口
- Gradle 构建产物在 worktree 内；不碰主仓 dist/
- 收尾不留孤儿进程（模拟器/gradle daemon 可留默认状态）

## 1. 任务

### ① 门禁实跑

- `gradlew :core:test :app:assembleDebug`
  - JAVA_HOME=`D:\Apps\JetBrains\IntelliJ IDEA 2026.1\jbr`；local.properties 已在位
  - 基线：:core 107 全绿（若新测试已加则以提交记录为准）；assembleDebug 出 APK
- 汇报全绿数字 + APK 路径；失败→最小修复（每 fix 一 commit）→重跑
- 注意：上轮中断可能已跑过部分门禁，一切以本轮实跑结果为准

### ② 模拟器冒烟 + 四类截图（不做真实 relay 连接，端到端归 M3）

1. **local 模式回归**：连桌面常驻 Gateway 127.0.0.1:8746，验证既有功能不回退（事件流/命令通路冒烟级即可）
2. **relay 模式 UI 验收**（不真连公网）：
   - 模式选择页（已有 relay-01，可复用或重截）
   - relayUrl + wss 校验：输入 `ws://` 被拒
   - 降级态徽标：`upstream:disconnected`
3. 四类截图存 worktree `acceptance/agents-mobile/relay-*.png`：
   - 01 模式选择 / 02 relay 配置与 wss 校验拒绝态 / 03 降级态徽标 / 04 local 模式回归正常态
   - **控制门恒空一类也要截**（approve/interrupt 控件在能力恒空时不显示——截"不显示"这个事实）
   - 数据来源如实标注（哪张是模拟器实截/哪张复用上轮）；截图零凭据（relayUrl 用占位、不出现真实 token/指纹）

### ③ 终提交

- `git commit -m "test(app): relay dual-mode gates + emulator evidence (M2-R3 wrap)"`

## 2. 铁律

- **只改 `android/` + `acceptance/`**；observed 目录零控件
- 桌面常驻不杀（§0）；绝不 `--no-verify`
- 增量提交纪律：门禁全绿一 commit、截图一类一 commit 均可；**每次 commit 后立即 `git push origin agent/android-relay`**（GitHub 增量推送纪律）
- 推送失败记录错误不无限重试，报告标注未上传项
- 不做真实 relay 连接（公网/ECS 零触碰——部署联调归 M3，且动阿里云需用户另行授权）

## 3. 汇报格式（四分类）

- 已完成并验证 / 仅本地验证 / 环境阻塞 / 待用户——逐项列出
- 必带：分支名 + 终 commit SHA + :core 测试数字 + assembleDebug 结果 + APK 路径 + 四类截图路径清单 + 模拟器已关确认 + 推送状态
