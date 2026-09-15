# DM2 批任务书：caps 自愈探针+投影双写去重（DeepSeek 远程对话收尾）

> 背景：RD run6（acceptance/mobile-chat-relay-e2e/run6/）——spawn/首回合/二回合/单气泡/live 窗口/同一性全 PASS；剩两处精确留证：**①relay 态 caps verifiedAt>300s 后 send 一律拒（探针仅助手页打开触发），纯手机长间隔对话无自愈路径**（msg3 实证，通用缺口非 DeepSeek 专属）；**②回合投影双写**（firehose 路径与 wire-scan 刷新路径各写一份同文本回合→App 两组相同气泡，agent_messages 29392-29395；native_msg_id 去重未跨路径生效）。基线 main=run5-fix 合并后 main；门禁 fast 133/full 234/:app 177/:core 316。

## 0. 工作区与纪律

- worktree：主仓根 `git worktree add worktrees/dm2-capsws -b agent/dm2-capsws main`；`npm install`；`cp /f/Active_Project/DevHub/android/local.properties android/local.properties`；gradle JAVA_HOME jbr。
- 每 commit 即 push 分支（直连优先 socks5h://127.0.0.1:1081 兜底重试循环）；绝不 push main；绝不 --no-verify；凭据三零。

## 1. 修法一：caps 过期自愈（relay 态长间隔对话）

- **触发面**（App 侧，:app）：会话详情（managed）发送被拒且拒绝码=caps 过期族（「能力未验证或已过期」）时——自动发起一次能力重探（既有探针通道），探针成功后**自动重发一次原消息**（一次性自愈重试，重试仍拒则按既有错误呈现，绝不循环重试风暴）；重试期间按钮态「正在重新验证能力…」人话。
- **兜底面**（桌面侧可选，若 App 侧不足）：managed 会话详情打开期间低频（≥120s）caps 重探——按改动面最小者落地，两案取舍写进头注释。
- 约束：探针/重试绝不伪造能力（仍以真实验证结果为准）；非 caps 过期族拒绝不走自愈；单测锁定触发码族+一次性语义。

## 2. 修法二：投影双写去重（桌面）

- firehose 路径与 wire-scan 刷新路径对同回合的 user/assistant 行写入了重复投影（native_msg_id 不同键）。修法：统一回合内消息的身份键（如 sessionId+turn+step+role 派生），双路径同键→upsert/去重生效（对齐 run5-fix 的 persistMessage upsert 既有机制）；已双写的存量行不在本批清理范围（如实注记）。五家既有投影回归零变化（zcode/kimi/claude/codex 单测保持）。

## 3. 门禁与验证

- typecheck 0 + fast 全绿（基线 **133/133**）+ full 全绿（基线 **234/234**）+ build；:app/:core 全绿（基线 **177/316**，自愈/去重单测如实增改）。
- provider 级真机验证（隔离实例窗口纪律，毕还原常驻 health×3）：① managed 会话间隔 >5min（模拟 caps 过期）后 sendReply 自愈重试成功真实推理（或桌面兜底面生效证据）；② 连续回合投影无重复行（firehose+wire-scan 双路径同回合仅一份）。
- 证据追加 acceptance/deepseek-managed-e2e/run6-fix/。推理最小 prompt（≤3 条）。

## 4. 汇报

commits / 两修法取舍说明 / 门禁数字（fast/full/:app/:core）/ 真机验证证据（自愈时序+去重行数对照）/ 推理消耗 / 偏差如实。**手机 E2E 归主控 RD run7，本批不做。**
