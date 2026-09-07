# M3-E0 文档批任务书（#9 裁决 B 落档：协议修订 + 验收标准更新 + 裁决记录 + 实施任务书草案）

> **用户裁决原文（2026-09-07，逐字保真入档）**：#9 选 B——复用现有 WS command 通道，补齐设备自管理和 managed spawn，闭环 R-B5/R-B8。**先更新协议、任务书和验收标准，编码与部署等 72 小时稳定期结束后再做，期间不要干扰常驻和巡检**；GitHub Release 暂不发布，等稳定性终报通过、B 方案完成复验、安装包更新后再统一发布。
> 本批=纯文档（docs/18/20/21 + 任务书草案），**零代码零部署零运行时触碰**（M3-D 窗内纪律）。基线 main @ 5c2fa0d。

## 0. 占用资源

- worktree `F:/Active_Project/DevHub-worktrees/docs-e0`（分支 `agent/docs-e0`，自 main 切；纯 docs 无 npm）
- 无端口/ECS/常驻/巡检进程任何触碰；每 commit 即 push；绝不 --no-verify

## 1. 任务四件

**① docs/18 协议修订（规范性，非增补注——本批有用户裁决授权）**：
- 先通读 §3.9（command/command_ack 帧语义）与 §5（命令目录）结构，在命令目录新增小节「设备自管理与 managed spawn 命令（M3-E；用户裁决 2026-09-07 #9=B）」，最小面定义：
  a. `spawn_session`（managed 会话启动，设备经 WS command 发起；参数/回执对齐既有命令帧形）
  b. `revoke_device`（设备自撤销；语义=ECS 注册表 revoked+disconnect(revoked)，复用既有撤销链）
  c. 设备列表/诊断查询：评估是否走既有 §7.1 G5 读面（agent_list/session_list/message 已有）——若 G5 已覆盖读取需求，只补 spawn/revoke 两命令，不重复定义读端点（最小面原则）
- §7.1 G5 处加交叉引用注（设备自管理动作走 §5 WS command 面，不新增 REST 端点——B 裁决本义）
- errorCode 命名域（§8.2）如需新增条目（如 SPAWN_REJECTED）一并定义
- 每处标"（用户裁决 2026-09-07 #9=B）"+日期；帧形零扩展（复用 command/command_ack）

**② docs/20 §3 验收标准更新**：R-B5 managed 回流判据改为"经 WS command `spawn_session` → accepted → 真实推理回流"；R-B8 主链判据补"经 WS command `revoke_device`（或桌面 UI）→ disconnect(revoked) → 401 DEVICE_REVOKED"；两处标"待 M3-E 实施后复验（docs/18 M3-E 修订）"。不改其他行。

**③ docs/21 裁决记录**：新增两条——#9=B（含编码/部署等窗毕的时序约束）+ GitHub Release 压后条件链（稳定性终报通过→B 方案复验→安装包更新→统一发布）。格式对齐 docs/21 既有条目风格。

**④ 实施任务书草案 `docs/briefs/m3e1-self-mgmt.md`**：B 方案实施批任务书（自包含），封面标**「开工前置=M3-D 72h 终报通过（≥09-10 08:49）；窗内零编码零部署」**。内容：App 侧 WS command spawn/revoke 接线（替换现 REST spawn 误走面）、桌面 host 腿命令处理器扩展、ECS 透传若需、测试面（:core/:app/smoke）、分支门禁、活体复验计划（R-B5 managed 回流+R-B8 主链，判据引 docs/20 修订后原文）、收尾含安装包更新（为 Release 统一发布备料）。风格对齐 m3c6c/m3c7b 任务书。

## 2. 铁律

docs/18 修订严格限于 B 裁决授权面（勿夹带离线补投/#16 专用帧形等未裁项）；最小面原则（G5 已覆盖的读面不重复定义）；帧形零扩展；绝不 --no-verify；主仓工作区零修改。

## 3. 汇报（四分类）

四件 diff 摘要+关键原文摘录（docs/18 新小节/docs/20 两行/docs/21 两条）+自查声明（授权面/最小面/零夹带）+push 状态。
