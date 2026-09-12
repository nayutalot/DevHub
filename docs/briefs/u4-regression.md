# U4 批任务书：横屏回归实证 + T1 Ready 态实拍 + markdown 实况抽查（只读验证批）

> 背景：①M1（U1）横屏气泡空白已修但待真链路回归实证（AUDIT 26 号场景）；②T1 卡 Ready/Unavailable 两态 U-Aud 时不可达（桌面 ZCode 链路离线持续 Queued）——**主控实测现在链路活着**（今日 277 条 web-remote-control 行，最新 22:51）；③U3 markdown 渲染已合但未实机走查。
> 本批=纯只读验证（零代码改动），实证入册。

## 0. 红线

- 零产品代码改动；零桌面端触碰（常驻 X5 PID 53900 与 ZCode.exe 均在役，**绝不 kill/重启/UI 自动化触碰桌面**）。
- **凭据入册红线**：配对码/遥控 URL（sid/hash/mid）绝不入截图与报告——截图后逐张检查，含明文凭据的先打码再入册；报告引用一律 masked。
- 模拟器用毕即杀；配对走网关回环 REST（U-Aud 先例 POST /v1/pairing/create），一次性码用后即废。

## 1. 验证项（每项截图+结论 PASS/FAIL）

1. **横屏回归（26 号场景）**：装 dist APK（47158b8f）→ 真实配对 → 开一个有消息的会话详情 → 竖屏截图 → 旋转横屏截图（**判据：气泡区仍可见消息，非空白**）→ 转回竖屏截图（状态保持）。PASS 判据三张齐+横屏非空。
2. **T1 Ready 态实拍**：会话列表顶部「ZCode 工作区」智能卡 → 自动取链应转 Ready（截图卡片态）→ 点击 → WebView 加载 z.ai 页（截图加载完成态）→ 返回键页内先退语义抽查。若链路此刻恰好断（Unavailable 态）→ 如实拍 Unavailable+重试按钮（也是有效证据，不强求 Ready）。
3. **markdown 实况抽查**：找 1-2 个含 markdown 形态（表格/标题/加粗）的真实转录消息 → 详情页截图（渲染效果 vs 原始竖线/井号直出的对比即可下结论）；找不到真实含 markdown 的消息则从诊断页/子会话抽查，实在没有如实记 SKIP+原因。
4. 顺带：U1-M2 只读徽章、U2-M1 capabilities ⓘ 弹层各拍一张实况（装机后的整体体验留档）。

## 2. 交付

- Worktree：`F:/Active_Project/DevHub-worktrees/u4reg`，分支 `agent/ux-u4-regression`（自 main 建）。
- 证据：`acceptance/agents-mobile/ux-u4-regression-20260912/`（截图+REPORT.md：逐项 PASS/FAIL+判据对照+偏差如实；截图编号引用）。
- commit+push 分支（墙期 SOCKS 配方同前）；绝不 --no-verify。
- 模拟器用毕即杀。
- 汇报：逐项 PASS/FAIL+关键截图说明、证据清单、push 回执、偏差如实。**FAIL 项如实报（这正是回归验证的价值），勿粉饰。**
