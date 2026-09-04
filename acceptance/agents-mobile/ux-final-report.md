# DevHub App 体验整改（R1–R11）最终验收报告

> 收口批次：C（交互诚实化与验收编排）。基线 f42a2d6（含批次 A 服务端 + 批次 B App）。
> 实测环境：AVD DevHub_API_35 → 公网隧道 59.110.149.11:8746 → 常驻桌面 DevHub
> （migration 005，主控重打包版）→ 真实 Codex CLI。日期 2026-09-04。
> 分批报告：批次 A/B 结论由主控合并门禁覆盖，本报告为整批收口 + C 批新增证据。

## 1. R1–R11 逐条验收

### R1 思维链可折叠 — **过**
- 标准：含思维链首屏不显示长推理原文；展开后完整可见；无思维链不回归；smoke 分段用例（A 批已过）。
- 证据（C 批真数据复跑）：`ux-c-r7-r10-detail-zcode-firstscreen.png`（「💭 思维链 · 183 字 ▸」默认收起，
  同屏其余消息无长推理原文）；`ux-c-r1-thinking-expanded.png`（点按展开，完整思维链可见）。
  子会话详情同形态（`ux-c-r2-child-detail.png`：65 字思维链折叠行）。

### R2 子智能体会话入口 — **过（含 C 批契约修复）**
- 标准：从父会话一步进入子会话并看到完整消息；子会话不进默认列表；smoke 父子链用例（A 批已过）。
- **C 批发现并修复跨批缺陷**：批次 A 网关把 `childSessions` 嵌在 `session` 视图内
  （`body.session.childSessions`），批次 B App 在顶层解析 → 真实网关下入口永不出现
  （夹具联调未暴露）。修复 `Dtos.parseSessionDetail` 双形态兼容（App 侧，服务端冻结不动）。
- 证据：父会话 #295（38 个子会话）`ux-c-r2-children-entry.png`（入口「🤖 子智能体会话 (38)」）→
  `ux-c-r2-children-list.png`（L1 层级标注 + 状态 + 已结束照常可点）→ `ux-c-r2-child-detail.png`
  （下钻子会话完整消息）。子会话未出现在默认列表（`ux-c-e2e-01-app-launched.png` 可交叉印证）。

### R3 归档与删除 — **过（含 C 批契约修复）**
- 标准：归档后默认不可见、开关下可见；删除后两端不可达且源文件原样；smoke 三端点用例（A 批已过）。
- **C 批发现并修复跨批缺陷**：批次 A 投影字段 = `archivedAt`（unix 秒，仅归档行出现），
  批次 B App 解析布尔 `archived` → 真实网关下"已归档"徽标/取消归档菜单永不出现。
  修复 `Dtos.parseSession`（`archived = optBoolean("archived") || optLong("archivedAt")>0`）。
- 证据（真实数据全回路）：`ux-c-r3-longpress-menu.png`（长按菜单，文案写明"仅移除 DevHub 记录"）→
  `ux-c-r3-delete-confirm.png`（删除二次确认；本验证取消未删真实数据）→
  `ux-c-r3-archived-away.png`（归档后默认列表该行消失，服务端 archived_at 落库）→
  `ux-c-r3-archived-visible.png`（开关下「已归档」徽标）→ 取消归档后服务端 archived_at=null、
  App 缓存 archived=0（双端核实）。源文件零触碰（仅 DevHub 投影行，红线保持）。

### R4 会话列表识别 Agent — **过**
- 标准：一眼区分五家；过滤 chips 生效；R11 头像色一致。
- 证据：`ux-c-e2e-01-app-launched.png`（真实列表：固定色板+首字母徽标 Z/C、providerLabel、
  五家 chips）；`ux-c-r4-filter-codex.png`（Codex 过滤 106 条生效）；气泡头像同色
  （`ux-c-e2e-10-roundtrips-complete.png`）。

### R5 刷新延迟 — **过（p95=4.76s ≤ 5s；详见 ux-c-latency-report.md）**
- 标准：公网全链路新消息出现延迟 p95 ≤ 5s；断 WS 兜底轮询工作；打点附报告。
- 证据：真库只读快照 + App logcat 打点，4 次真实 Codex 往返：源→App 可见 p50=2.70s、
  p95=4.76s（4/4 ≤5s）；库→App 可见 p50=1.4s / max 2.76s；服务端两段 db-to-ws
  p50=535ms / p95=941ms（含回填上界）、source-to-db 活跃段 p50=1s / max 2s。
  完整三段表+瓶颈归因+改造前后定性对比：`ux-c-latency-report.md`。
- 断 WS 兜底：App 断网入离线队列、重连补发语义为既有 AC8 面（未回归，本轮公网全程在线）。

### R6 Codex 交互 — **过（端到端真实验证）**
- 标准：App 内一键启动托管 Codex 会话并完成一次 reply 回流（模拟器+公网隧道）；外部 observed 会话零控件。
- 证据链（全部真实）：
  1. Agents 页 Codex 卡显示「启动托管会话」（R6.1 文案「托管会话可交互；外部会话只读」）：
     `ux-c-e2e-02-agents-r6-r7.png`；
  2. 点按钮 → 任务输入面板 → 输入 "Reply with exactly: UX-OK. Then stop."：
     `ux-c-e2e-03-spawn-panel-open.png` / `ux-c-e2e-04-spawn-task-typed.png`；
  3. 202 受理：spawn commandId = `cmd-204a1b54-1506-4f5c-825f-6959f4129346`
     （remote_commands 行 status=executed，result={nativeId, sessionId:506}，device_id=5）→
     App 自动跳入会话 #506 详情（managed 徽章 + reply/pause/resume 真实控件）：
     `ux-c-e2e-05-spawned-session-detail.png`；
  4. Codex 真实推理回复 "UX-OK" 回流手机（user/assistant 气泡）：
     `ux-c-e2e-06-spawned-session-flowback.png`；
  5. 事件链（`ux-c-e2e-07-db-evidence-chain.txt`）：session.started → session.status_changed(running)
     → command.result → 6×message.appended（含任务与 "UX-OK"）→ session.waiting_input；
  6. 追加 4 次手机 reply 全部 executed 并回流（UX-R1..UX-R4）：
     `ux-c-e2e-08/09/10`，commandId 见 §R5 表。
- 外部 observed Codex 会话保持零控件（会话级 ControlGate 未动；列表行"observed 只读"如实标注）。

### R7 observed 提示 — **过**
- 标准：四家任何界面不再出现"看似可交互"控件/文案；原因卡与 known-limitations §1 一致。
- 证据：Agents 页四家各带原因卡（ZCode=官方未提供控制通道 / Claude=hooks 无输入注入 API /
  Kimi=托管通道待用户授权真机验证 / DeepSeek=未接入），且仅 Codex 有启动按钮：
  `ux-c-e2e-02-agents-r6-r7.png`；会话详情 per-provider 原因卡（ZCode）：
  `ux-c-r7-r10-detail-zcode-firstscreen.png`；（Claude）`ux-c-r11-r8-claude-codeblock.png`；
  observed 会话零控件保持（ControlGate 未动，:core ControlGateTest 既有断言全绿）。
- 文案产品化为 :core `InteractionHonesty` 常量 + 12 例单测（与 known-limitations §1 逐条一致性断言）。

### R8 原指令渲染 — **过**
- 标准：plugin/skill 调用原文显示为可读 chip/标签；代码块不丢内容；smoke 替换用例（A 批已过）。
- 证据：工具调用 chip（🔧 Bash / 🔧 TaskOutput + 内容等宽底色）：
  `ux-c-r7-r10-detail-zcode-firstscreen.png` / `ux-c-r9-scrubber-drag-tooltip.png`；
  行内代码 chip（`Core/Src/main.c`、`0.0.0.0/0`、`443/tcp`）：
  `ux-c-r11-r8-claude-codeblock.png` / `ux-c-r8-inline-code-zcode.png`；
  围栏代码块样例引批次 B `ux-b-16-r11-r8-codeblock-claude.png`（真数据路径同一渲染器）。

### R9 进度条/快速定位 — **过**
- 标准：千级消息会话拖动 ≤2 次翻页命中；跳最新一键直达；不卡顿。
- 证据（真实长会话 #295 复跑）：拖动中（滑块值+内容随动）`ux-c-r9-scrubber-drag-tooltip.png`；
  「⏬ 跳到最新」FAB `ux-c-r9-jump-to-latest-fab.png`；拖动释放跳转后
  `ux-c-r9-after-jump.png`。拖动时间戳气泡的逐帧截图本次 screencap 与拖动竞态未抓到，
  引批次 B `ux-b-10-r9-scrubber-drag-tooltip.png`（同一 ScrubberBar 代码路径）为气泡形态证据；
  ScrubberMath 纯逻辑（≤2 页预算）:core 单测全绿。

### R10 默认展示最新 — **过**
- 标准：新开会话首屏即最新一轮；上滑可回溯最早。
- 证据：进会话即最新（#506 首屏=最新 UX-R4：`ux-c-e2e-10-roundtrips-complete.png`；
  #295 首屏=最新 18:21 消息：`ux-c-r7-r10-detail-zcode-firstscreen.png`）；
  上滑/scrubber 回溯到 09-03 早期消息（`ux-c-r9-after-jump.png`）。

### R11 用户/Agent 消息区分 — **过**
- 标准：一眼可分；四样例（长/短/代码块/日期边界）无样式回归。
- 证据：右绿我 / 左 provider 色气泡 + 时间尾注：`ux-c-e2e-10-roundtrips-complete.png`；
  长消息：`ux-c-r11-r8-claude-codeblock.png`（整屏级长气泡）；短消息：UX-OK/干完了吗；
  代码块：同上 + B 批 ux-b-16；日期分隔线引 B 批 `ux-b-12-r11-date-separator.png`
  （C 批真数据追打未命中边界帧，DateGrouping 纯逻辑 :core 单测全绿，如实注明）。

## 2. 六门禁结果汇总

| # | 门禁 | 结果 | 出处 |
| --- | --- | --- | --- |
| 1 | tsc | 0 错误 | 主控合并后已跑（本批零 TS 改动，引用） |
| 2 | smoke | 151/151 | 主控合并后已跑（含 A 批新增用例；引用） |
| 3 | build | 成功 | 主控合并后已跑（引用）；常驻实例即该产物 |
| 4 | mcp-acceptance | 22/22 | 主控合并后已跑（引用） |
| 5 | :core:test + gradle | **:core:test 100/100 全绿**（14 个测试类，含本批新增 InteractionHonestyTest 12 例）；**assembleDebug BUILD SUCCESSFUL**（本批门禁实跑，输出尾部见 §5） | 本批 |
| 6 | R5 打点对比 + R6 端到端 | 延迟报告 p95=4.76s 过（§R5）；R6 spawn+reply 全链路真实证据（§R6） | 本批 |

## 3. 本批改动文件清单（android/ 仅；未动 src/ 服务端）

| 文件 | 说明 |
| --- | --- |
| `android/core/.../InteractionHonesty.kt` | 新增：R6/R7 诚实化纯逻辑（managed 判定/按钮门/四家原因卡文案，known-limitations §1 摘取） |
| `android/core/test/.../InteractionHonestyTest.kt` | 新增：12 例单测（按钮门数据驱动 + 夹具恒 false + 原因卡文案一致性 + displayName 兜底） |
| `android/app/.../data/remote/Dtos.kt` | R6 spawn 响应 DTO+解析；**契约修复×2**：archivedAt 归档态、childSessions 嵌套形态兼容 |
| `android/app/.../data/remote/GatewayApi.kt` | `startManagedSession()`（POST /v1/providers/{id}/sessions；控制类刻意不进 ProjectionApi，夹具绝不伪造） |
| `android/app/.../ui/screens/AgentsScreen.kt` | R6.1 managed 卡文案；R6.2 启动面板+跳转会话；R7 原因卡；夹具模式无按钮 |
| `android/app/.../ui/screens/MainTabs.kt` | AgentsScreen 接入 onOpenSession 导航 |
| `android/app/.../ui/screens/SessionDetailScreen.kt` | R7.1 per-provider 原因卡（替代通用一句话）；**缺陷修复**：空会话轮询 after=null 回退 tail 拉取（否则新托管会话消息永不回流）；R5 打点（DevHubUx: reply_sent/msg_visible，零内容） |

另：`android/local.properties`（gitignored，不入库）修复 sdk.dir 转义错位以恢复本机构建。

## 4. 遗留与风险（如实）

1. **跨批契约错位两处（已修 App 侧）**：archivedAt / childSessions 嵌套。服务端（批次 A，
   已冻结在常驻实例）与批次 B 夹具联调之间的形态差未被 B 批发现；本批以真实网关逐屏复跑暴露并修复。
   建议 docs/14 契约页补"字段形态以服务端实现为准"的样例 JSON（文字修订属文档批，未动）。
2. **App 空会话轮询缺陷（已修）**：新 spawn 会话首屏为空时增量游标永不建立 → 消息回流缺失；
   修复为 after=null 时回退 last=200 尾拉。该缺陷在 B 批夹具下不可现（夹具会话预置消息）。
3. **WS delivery_state 全程 pending**（观察项，未越界修复）：App 经 REST 轮询取数功能无损，
   但 WS 在线投递标记未发生，影响未来 WS 驱动刷新（R5.3 App 侧未实施项）的前提与审计口径，
   留母智能体裁决（服务端面）。
4. **R9 拖动气泡逐帧截图**与 R11 **日期分隔线真数据帧**未捕获（screencap 与手势竞态），
   分别引批次 B ux-b-10 / ux-b-12 为形态证据；逻辑面 :core 单测覆盖。
5. smoke 断言 append-only：本批零改动既有断言。
6. Mimosa 钩子：本批零拦截记录；无 --no-verify。

## 5. 本批门禁原始输出（尾部）

```
$ gradlew :core:test        → BUILD SUCCESSFUL（junit 聚合：tests=100 failures+errors=0，14 个测试类）
$ gradlew assembleDebug     → BUILD SUCCESSFUL in 5s（40 actionable tasks: 9 executed, 31 up-to-date）
  app/build/outputs/apk/debug/app-debug.apk（10,940,800 bytes）→ adb install Success
```

## 6. 用户裁决项提醒（docs/17 §7 原文照录，本批未动手）

1. Kimi 真机 managed 启用（需授权写 `~/.kimi-code` + 消耗少量真实推理）。
2. Claude hooks 注册入口（注意：hooks 只带来审批事件，**不带来 reply 能力**）。
3. ZCode / DeepSeek 官方控制通道出现后的接入批次。
4. FCM/厂商推送、隧道 TLS（独立特性）。

补充裁决项（本批新产）：
5. WS delivery_state pending 现象（遗留 §4.3）——是否立服务端修复批。
6. App 侧 WS 驱动刷新（R5.3 剩余半程）是否立批——可将新消息可见 p95 从 4.76s 压向 ~1.5s。
