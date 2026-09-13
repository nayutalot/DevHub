# B1 批任务书：Android 崩溃面全量扫查+修复（P0 同类泛化）

> 背景（主控已查明）：P0 热修（e3ec1a4）实证了一类闪退：UI 协程加载循环只捕窄异常+作用域无处理器→RuntimeException 直达进程。P0 修了六屏+三作用域，但**同类位点可能还有残留**。本批=系统性扫查 android/ 全部崩溃面并最小修复。
> P0 根因参照：模拟器 HTML 劫持端点复现法（acceptance/agents-mobile/ 有 P0 批方法；裸 ServerSocket 回非 JSON 2xx 即可复现）。

## 0. 红线

- 只动 android/；桌面零触碰（常驻 X5 在役勿动；本批纯 gradle 无需端口，无须杀常驻）。
- 最小修复纪律：只修「可崩溃/状态破坏」位点；绝不借机重构；行为不变处零 diff。
- 既有单测 0 改 0 删（新增允许）；门禁 `:app:testDebugUnitTest :core:test :app:assembleDebug`（JAVA_HOME 未设用 `D:/Apps/JetBrains/IntelliJ IDEA 2026.1/jbr`；链尾勿加 --stop）。
- 凭据三零；模拟器用毕即杀。

## 1. 扫查矩阵（逐类过，产出 findings 清单：位点+触发条件+严重级+修法）

1. **协程异常面**：全部 `launch`/`async`（Activity/Screen/Service/Controller/Manager）——异常会去哪？有无 catch/Handler/SupervisorJob？UI dispatcher 上的未捕获=闪退；
2. **JSON/解析面**：全部 org.json/字符串解析位（GatewayApi 已修，其余如 RelayFrames/FixtureProjection/push 载荷/配对响应）——畸形输入（数组 vs 对象/错型/空体/超长/深嵌套）抛不抛？
3. **`!!`/`check`/`require` 面**：全量清点（P0 已硬化 ConnectionManager 一部分），按「触发条件可达性」分级：可达未护栏=修，不可达=注记；
4. **Compose 组合期风险**：composable 内直接执行的逻辑（非 remember/calculated）有无抛点（列表 index/正则/日期解析）；
5. **服务生命周期面**：GatewayConnectionService onStart/onDestroy/重试循环的边界（null intent/快速重启）。
6. **运行时验证**（静态 findings 定修法后）：对每处修复构造对应畸形场景实测不闪（复用 P0 的裸 ServerSocket/畸形响应手法）。

## 2. 修复纪律

- 严重级 P0（可达闪退）与 P1（可达状态破坏）必修；P2（理论路径）注记可缓修——findings 清单全量上报，主控复核；
- 修法对齐 P0 先例：catch 兜底→ErrorPresent/诚实态，原异常收 technical 不吞码；缺依赖→结构化跳过。

## 3. 交付

- Worktree：`F:/Active_Project/DevHub-worktrees/b1sweep`，分支 `agent/bug-sweep-android`（自 main 建；android/local.properties 从主仓复制若缺）。
- findings 清单+修复按类分 commit+push（墙期 SOCKS 配方同前；绝不 --no-verify）。
- 出包：app-debug.apk → `F:/Active_Project/DevHub/dist/DevHub-Android-0.1.0-debug.apk`（覆盖；记录 sha256+时间戳；dist-cp6 勿碰）。
- 汇报：findings 清单（全量，含未修的 P2 注记）、diff 概览、:app/:core 测试数、APK sha256、push 回执、偏差如实。
