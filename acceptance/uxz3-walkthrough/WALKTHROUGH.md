# UX-Z3 走查记录：对话 v2 运行态层（E16 计时器 + E19a 活动 pill + E21 运行中 composer + statusDetail 终态族）

> 批次：UX-Z3（docs/briefs/uxz3-runtime.md；规格 docs/28 §6 运行态节 + §7 增量矩阵）。
> 走查环境：headless 模拟器 DevHub_API_35（emulator-5554，API 35，`-no-window` 零打扰），
> APK = 本批 assembleDebug 产物（= 覆盖 dist 的 DevHub-Android-0.1.0-debug.apk，
> sha256 = dc590461477927c1f361669da892307056e404e63c1791d3e05282a164bd8355，11,849,939 字节）。
> 网关 = **本批新代码起的本地夹具网关**（gateway-runner-uxz3.mjs，worktree 内 node 直启
> httpServer + 临时 DEVHUB_HOME 播种 + 回环 18791 控制面；端口 18790；走查结束已
> taskkill（PID 39752），模拟器已 `adb emu kill`，零常驻遗留）。
> **running 态 = 真实事件管道**：控制面调用与桌面 managed 面同一 `applySessionStatus` /
> `persistMessage`（真实落库 + 真实 session.status_changed / message.appended 事件 →
> 真实 WS 推送 → App SessionRunRegistry 锚点登记 + 消息回流），非 DB 直改摆拍。
> 凭据三零：9 张截图逐张核对——零 token / 零配对码（配对码仅键盘输入，从不出现在
> 任何截图）/ 零指纹；laurdasktop 主机名与 C:/code/devhub 假路径同 Z2 先例非凭据；
> 「信息可能不是最新」=夹具 home 无监控管线的真实 stale 投影（不伪造）。

## 逐项销账（docs/28 §6 运行态节 / 任务书四件）

| 任务书 # / 规格 | 结果 | 证据 |
|---|---|---|
| #1 E16 计时器·开始沿（to:'running' 起） | PASS：01 图 waiting_input 零计时器；/running 真实沿后 02 图「已工作 4 秒」（沿 01:49:05 → 截图 01:49:09，±1s） | 01/02 |
| #1 E16 计时器·走字 | PASS：03 图「已工作 32 秒」→ 04 图「已工作 1 分 2 秒」（宿主墙钟 63s，±1s）；每秒重组走字 | 02/03/04 |
| #1 E16 计时器·停沿冻结（五终态值停） | PASS：05 图 waiting_input 停沿「已工作 12 秒」冻结（区间 12s=沿距实测）；06 图 failed「已工作 6 秒」；07 图 paused「已工作 6 秒」——数值停不走字 | 05/06/07 |
| #1 E16 计时器·降级「运行中…」（锚点不可考不伪造） | PASS：08 图会话 B（播种即 running，App 首观测无翻转沿）→ 只显「运行中…」无任何数字，绝不拿 lastActivityAt-startedAt 冒充 | 08 |
| #1 E16 observed 不显 | PASS：09 图 observed 会话（running 态）整块零计时器零 pill，状态照旧走徽章 | 09 |
| #2 E19a pill·白名单口径（先真实样本后定） | PASS：白名单=Read/Edit/Write/MultiEdit/NotebookEdit/apply_patch（zcode 真库 tool_usage 37,273 行 / 52 工具名全集 + 投影面 16,874 段实测定音；Bash/PowerShell 可能触文件但判定不了不入表——绝不猜） | 代码面 + :core 单测 8 枚 |
| #2 E19a pill·文件类计数 | PASS：04 图「已进行 3 次文件操作」= Read/Edit/Write 命中（同窗 TodoWrite/mcp__left_click 不入文件数） | 04 |
| #2 E19a pill·非文件不去重如实计数 | PASS：03 图「运行中 · 第 2 步」（Bash+WebSearch 两次调用逐次计数）；05 图「本轮完成 · 7 次操作」= 2+5 与消息流工具行数一致 | 03/05 |
| #2 E19a pill·pill 计数与消息流 tool 行数一致 | PASS：03 图 pill=2 步 ↔ 消息流 2 枚工具 chip（Bash/WebSearch）；04 图 pill 文件数=3 ↔ 流内 Read/Edit/Write | 03/04 |
| #2 E19a pill·无 tool 行降级 | PASS：02 图 running+锚点可考但零 tool 行 → 无 pill（「运行中…」降级语义由计时器行承载）；08 图无锚点 → 不画数字（窗口不可归属，不伪造） | 02/08 |
| #2 E19a pill·完成态转场 | PASS：05 图「本轮完成 · 7 次操作」（waiting_input）；06 图 failed「本轮出错结束」；07 图 paused(zcode cancelled 同义)「本轮已取消」 | 05/06/07 |
| #2 deepseek 双写去重（载体裁定） | 单测锁：assistant 折叠行+role='tool' 行并存时只按 role='tool' 计（2 次调用=2 不=4）；zcode 形态（toolInvocation 挂 assistant 行）按 assistant 计——真实样本形态直锁（ToolActivityPillTest） | :core 单测 |
| #3 E21 运行中 composer 保持可用 | PASS：02/03/04/08 图 running 期间 composer 在位可用、占位=「提出后续修改要求」（v4 形态）；05/06/07 图非 running 回「输入消息…」；既有 reply 通道/ControlGate 零触碰 | 02/03/04/05/08 |
| #4 statusDetail 终态族人话 | PASS：05 图「turn/end (seq 901)」→「本轮已结束（第 901 条事件）」；「turn completed (resultType: success)」→「本轮已完成」（05 图）；06 图「zcode event: turn.failed」→「本轮出错结束」；07 图「turn completed (resultType: cancelled)」→「本轮已取消」；08/09 图「turn/start (seq N)」→「新一轮任务开始（第 N 条事件）」；02 图「zcode event: turn.started」→「新一轮任务开始」 | 02/05/06/07/08/09 |
| 验收③ observed 零计时器零 pill | PASS：09 图（observed+running 双门同验） | 09 |
| 验收⑤ statusDetail 面零工程串直出 | PASS：9 张图全部 statusDetail 均为人话（词表命中）；表外串零吞码原样透出由单测锁（unknown reason/resultType/事件型三例） | 全部 + 单测 |
| 红线·C 档零出现 | PASS：记忆 pill/撤销/diff 统计/赞踩（C 档）零出现；未知工具名如实计入步数不猜文件数 | 全部 |
| 红线·ControlGate/会话门不动 | PASS：visibleControls 语义零改动（diff 面无 ControlGate 变更）；observed 零控件现状保持 | 代码面 |
| 红线·桌面零改动免换装 | PASS：本批 diff 全部在 android/ 与 acceptance/（桌面 src/ 零触碰） | git diff main |
| U1-U5/P1-P3/Z2 已落面不回退 | PASS：composer/复制钮/statusDetail 人话通道/段控列表全部原样在位（01/05 图同屏可见） | 全部 |

## 走查矩阵（docs/28 §7 增量矩阵新增两行）

| 组件态 | 结果 |
|---|---|
| 运行态计时器 | ✓ running 区间走字（02/03/04）；observed 不显（09）；降级「运行中…」真实可走（08）；停沿冻结（05/06/07） |
| 活动 pill | ✓ N 次操作口径（03/04/05）；降级不画数字（02/08）；完成/出错/取消转场（05/06/07） |

## 截图清单（acceptance/uxz3-walkthrough/shots/）

1. `01-session-idle-no-timer.png` — 会话 A waiting_input 基线：零计时器零 pill（无据不画）+ composer「输入消息…」
2. `02-timer-ticking-4s.png` — 真实 running 沿 +4s：「已工作 4 秒」走字 + composer「提出后续修改要求」（E21）+ statusDetail「新一轮任务开始」（zcode event 词表）+ 零 tool 行无 pill（降级语义在计时器行）
3. `03-pill-generic-steps.png` — 「已工作 32 秒」+「运行中 · 第 2 步」（非文件不去重如实计数）↔ 消息流 2 枚工具 chip 对照
4. `04-pill-file-ops.png` — 「已工作 1 分 2 秒」+「已进行 3 次文件操作」（白名单命中 Read/Edit/Write；TodoWrite/mcp__ 不入文件数）
5. `05-stop-completed-frozen.png` — waiting_input 停沿：计时冻结「已工作 12 秒」+「本轮完成 · 7 次操作」+ statusDetail「本轮已结束（第 901 条事件）」
6. `06-stop-failed.png` — failed 停沿：「已工作 6 秒」冻结 +「本轮出错结束」pill + statusDetail「本轮出错结束」（zcode event 词表）+「已失败」徽章
7. `07-stop-cancelled.png` — paused 停沿（zcode cancelled 同义）：「已工作 6 秒」冻结 +「本轮已取消」pill + statusDetail「本轮已取消」+「已暂停」徽章
8. `08-degraded-running-no-anchor.png` — 降级路径实证：播种即 running 的会话 B 首观测无翻转沿 → 只显「运行中…」无数字（绝不伪造计时），composer 保持「提出后续修改要求」可用
9. `09-observed-no-strip.png` — observed 会话（running 态双门同验）：整块零计时器零 pill + 「仅查看」徽章 + 零 composer（observed 零控件现状）

## 走查方法与夹具（透明化）

- `gateway-runner-uxz3.mjs`：本批新代码（worktree 源码 node --experimental-strip-types
  直载）在临时 DEVHUB_HOME 播种的只读夹具网关——agent_providers 五家目录行（zcode 置
  managed caps + workspace）、agent_sessions 3 行（A=走查主体 waiting_input、B=播种即
  running 的降级样例、C=observed running）、settings（gateway_enabled/gateway_port=18790/
  zcode_managed_model=zcode/glm-5-turbo）；**回环 18791 控制面**按需触发真实
  applySessionStatus（开始沿/五终态停沿）与 persistMessage（assistant 行 toolInvocation
  段，真实 message.appended 事件驱动 App 回流）——与桌面 managed 面同一落库+事件管道。
  真机 provider/凭据零触碰；走查后网关进程已 taskkill、模拟器已关闭，零常驻。
- 配对码经 /v1/pairing/create 真实签发、仅 adb keyboard 输入（截图零码）。
- 计时器 ±1s 对照方法：宿主 curl 触发时刻（`date +%H:%M:%S`）vs 截图内计时读数
  （02 图 4s/03 图 32s/04 图 62s 与宿主墙钟逐帧吻合）；停沿冻结值 = 沿距实测
  （05 图 12s、06/07 图 6s 与触发序列一致）。
- 事件指纹幂等注记（如实留档）：applySessionStatus 同载荷重放会被 deriveEventId 去重
  （docs/12 语义 1 重放幂等）——走查中同会话多轮触发以词表内不同 detail 串区分轮次；
  App 侧逻辑与去重无关（consume 侧无状态合成）。
