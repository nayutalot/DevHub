# UX-Z3 批任务书：对话 v2 运行态层（计时器+工具活动 pill）

> 背景：docs/28 规格运行态层（UX-Z1 主控裁决：计时器=running 态区间 to:'running' 起五终态停、断线/重启锚点不可考降级「运行中…」；活动 pill=toolInvocation 计数白名单口径「N 次文件操作」非文件不去重如实；observed 无 turn 概念不显计时器）。P1-P3/Z2 已落地。基线 main=Z2 合并后 main；门禁 fast 141/full 244/:app 184/:core 343。**纯 Android 批（桌面零改动免换装）**。

## 0. 工作区与纪律

- worktree：主仓根 `git worktree add worktrees/uxz3-runtime -b agent/uxz3-runtime main`；`cp /f/Active_Project/DevHub/android/local.properties android/local.properties`；gradle JAVA_HOME jbr。
- 每 commit 即 push 分支（直连优先 socks5h 兜底重试循环）；绝不 push main；绝不 --no-verify；凭据三零。

## 1. 落地范围（docs/28 运行态节为准）

1. **会话运行计时器**：会话详情头部「已工作 X 分 X 秒」——running 态区间（status_changed to:'running' 起、五终态值停；statusDetail 人话化既有通道消费）；断线/进程重启锚点不可考→降级「运行中…」不伪造计时；observed 会话不显。
2. **工具活动 pill**：turn 内 role='tool' 事件按白名单口径聚合「N 次文件操作」（docs/28 口径：文件类工具计数、非文件不去重如实计数；工具名白名单先小样本实测 8601 行 approval_status 教训——先看真实事件样本再定白名单，未知工具名聚合为「N 次操作」）。
3. **运行中流式态**：running 期间 composer 保持可用（对 live managed 会话=「提出后续修改要求」形态对齐 v4 截图——既有 reply 通道原样，不加新语义）。
4. **收尾人话**：回合终态（完成/出错/取消）statusDetail 人话（Z2 已建查表，补全终态族）。

## 2. 红线

不伪造（锚点不可考降级、无数据不画 pill）；ControlGate/会话门不动；U1-U5/P1-P3/Z2 已落面不回退；桌面零改动；C 档零出现。

## 3. 门禁与验证

- :app/:core 全绿（基线 **184/343**，如实增改）+ `assembleDebug`。
- 模拟器走查（headless，用 managed 真实 provider 或夹具网关造 running 态）：计时器走字/停止、pill 计数与真实事件对照、observed 不显、降级路径——截图入 `acceptance/uxz3-walkthrough/`（盘凭据）。
- 新 APK 覆盖 dist 登记 sha256。

## 4. 汇报

commits / 逐项对照 docs/28 运行态节销账 / 门禁数字（:app/:core）/ 走查截图清单 / APK sha256 / 偏差如实。
