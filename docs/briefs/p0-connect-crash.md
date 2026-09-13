# P0-HOTFIX 批任务书：App 连接失败闪退——复现→根因→热修→出包

> **用户 P0 报告（09-13 凌晨）**：真机（V2507A，装 0423ad08=含 W+T1+U1~U5 全部）上「app 一旦没连上电脑就直接闪退」。**最后已知好用版=28923f35（W 批版，用户真机此前正常使用）→ 回归窗口=T1..U5 全部改动**。
> 主控已查明线索（供起点，非结论）：`ConnectionManager.kt` 存在 `db!!`/`api!!`/`wsClient!!`/`cachedConfig!!` 断言族（L343/437/439/475/523/976/1052-54/1347/1377/1389-1423/1453 等）——连接失败路径上若依赖未就绪（未配对/库未开/配置未载）即抛 KNPE，协程未捕获=进程闪退。需查明：①这些断言哪些在回归窗口内新增/被触及 ②协程作用域有无异常处理器 ③U5 WorkspaceLinkModePolicy null 模式默认开门在启动瞬窗的实际行为。

## 0. 红线

- 只动 android/；桌面零触碰（**常驻 X5 PID 53900 在役绝不 kill**——「没连上电脑」用不可达端点模拟，勿杀真网关）。
- 热修纪律：**最小修复**——目标是「连接失败永不闪退+如实呈现错误态」（U1 ErrorPresent 已有错误呈现层，接上即可），绝不借机重构；既有单测 0 改 0 删（新增允许）；relay/本地两模式正常路径行为不变。
- 凭据三零（配对码/token/logcat 采样脱敏）；模拟器用毕即杀。
- 门禁：`:app:testDebugUnitTest :core:test :app:assembleDebug`（JAVA_HOME 未设用 `D:/Apps/JetBrains/IntelliJ IDEA 2026.1/jbr`；链尾勿加 --stop）。

## 1. Phase 1：复现抓栈（先行，根因未明不动代码）

模拟器装 0423ad08，逐场景复现（logcat 挂着 `adb logcat *:E` + crash buffer），每场景记录崩溃栈或「未复现」：
- a) 全新未配对：直接冷启动（gateway 配置空/默认）→ 走查；
- b) 配置 relay 指向不可达端点（如 `wss://10.255.255.1` 或无效域名）→ 冷启动+前台等待 60s+后台切换；
- c) 配置 local 指向错误端口（如 10.0.2.2:9）→ 同上；
- d) 先正常配对连上（10.0.2.2:8746），再 `adb shell svc wifi disable`+`svc data disable` 模拟断网 → 观察断连路径；恢复网络观察重连路径；
- e) 若以上均不复现：静态审计 ConnectionManager 全部协程 launch/async 的异常处理（有无 CoroutineExceptionHandler/try 包裹）+ 回归窗口内 diff 的失败路径（`git log 28923f35..HEAD --oneline -- android/` 逐 commit 核对触及点），列「可疑点+推理」上报主控，同时继续 Phase 2 的防御性修复。
- **抓到栈 = 根因定案**；抓不到 = 以静态审计最高疑点做防御修复并如实标注「复现未遂，防御性修复」。

## 2. Phase 2：热修

1. 根因修复：按栈修（如 `!!` → 安全调用+结构化 no-op/日志；或给连接作用域挂 CoroutineExceptionHandler 兜底——闪退绝不发生，错误进 U1 ErrorPresent 呈现）；
2. 单测：新增回归锁用例（失败路径依赖未就绪时不抛、走诚实错误态）；
3. 复现验证：Phase 1 复现场景重跑 → 不再闪退 + 错误如实上屏。

## 3. 交付

- Worktree：`F:/Active_Project/DevHub-worktrees/p0crash`，分支 `agent/p0-connect-crash`（自 main 建）。
- 增量 commit+push（墙期 SOCKS 配方同前；绝不 --no-verify）。
- 出包：app-debug.apk → `F:/Active_Project/DevHub/dist/DevHub-Android-0.1.0-debug.apk`（覆盖；记录 sha256+时间戳；dist-cp6 勿碰）。
- 汇报：复现结果（场景×栈摘要）、根因、diff 概览、:app/:core 测试数、复现场景复验结论、APK sha256、push 回执、偏差如实。
- worktree 准备：android/local.properties 从主仓复制（若缺）。
