# KC 批任务书：kimiProvider startManagedSession 补齐（手机远程对话最后一环）+ Relay endpoint 陷阱修复

> 背景：RD 批端到端实证（acceptance/mobile-chat-relay-e2e/）精确定位「手机远程对话」阻断链：①**主缺陷**——App「启动托管会话」→ spawn_session → `agentControlService.ts:1764` 抛 COMMAND_NOT_EXECUTABLE（"does not implement managed session start"），因 **kimiProvider 从未实现 startManagedSession**（全仓仅 codexProvider.ts:1135、zcodeProvider.ts:1268 实现；kimi managed 通道=reply-only，kimiManagedConfig gate 只授 `['reply']`）→ SPAWN_REJECTED；连锁=App 输入门（ControlGate.kt:47 session_mode!=observed 才开 reply）使全部 Kimi 会话只读。②次缺陷 P2——`RelayEndpoint.kt:16` 恒拼 `/relay/device`，parse 接受带路径输入致 `/relay/device/relay/device` 404。基线 main=RD 证据 commit 之后的 main。

## 0. 工作区与纪律

- worktree：主仓根 `git worktree add worktrees/kc-kimi-spawn -b agent/kc-kimi-spawn main`；`npm install`。
- 每 commit 即 push 分支（直连优先 socks5h://127.0.0.1:1081 兜底重试）；绝不 push main；绝不 --no-verify；凭据三零（kimi api_key 零读取零日志，maskKey 既有纪律）。
- **本批独占常驻运行时窗口**（E2E 复验用）；gradle 零涉（Android 零改动——spawn 成功即 managed 会话，App 输入门数据驱动自动开）。

## 1. 主缺陷：startManagedSession（kimi）

- 先读 codex/zcode 两实现与 spawn_session 契约面（docs/18 §5.3、docs/12 §5、agentControlService startProviderManagedSession 调用形状、App 端 spawn 表单字段），设计 kimi 等价形态（**先文档注记后编码**，设计写进 provider 头注释）。
- kimi 现实约束（KM 批已证）：kimi 会话由一次 `-p` 运行物化（state.json/wire.jsonl 落盘）+ `-S {sessionId}` resume 续聊；argv 模板 `['-S','{sessionId}','-p','{prompt}','--output-format','stream-json']` 已真机验证；resume 强制 cwd=会话 workDir；TUI/管道 stdin 有信任门不可用。
- 设计候选（agent 按契约面定，不伪造）：startManagedSession 产出「已注册的 managed 会话」（spawned/pending 态记录，含 workDir 约定），首次 sendReply 以 `-p` 物化会话再续 resume；或 spawn 即带首条消息一次性物化——**选型须与 spawn_session 契约及 App 交互序列自洽**（用户启动后是否立即输入？启动→输入→回复的时序），如两难列出取舍交主控。
- 红线继承：失败结构化（禁仅凭退出码判成功）、KIMI_CODE_HOME 生产零注入、exec.ts 唯一 spawn、managedProbe/gate 键语义不变（`kimi_managed_enabled=0` 时行为逐字节不变）。
- 夹具单测：假 kimi 脚本覆盖 spawn→首条→续聊→终态→失败五段（对齐 KM 批夹具风格）。

## 2. 次缺陷 P2：RelayEndpoint 路径拼接陷阱

- Android 侧 `RelayEndpoint.kt`：保存层拒绝带路径的 endpoint（结构化错误+人话文案「填裸地址，不要带 /relay/device 路径」）或归一化剥除——按既有 UX 纪律选型，文案全中文。
- :app 单测覆盖（带路径拒/裸地址过）。

## 3. 门禁

- 桌面：typecheck 0 + smoke fast 全绿（基线 **129/129**，新增如实计数）+ full 档全绿（基线 **224/224**；spawn 是协议面）+ build。
- 安卓（仅 P2 触碰）：:app/:core 全绿（基线 **146/301**，JAVA_HOME jbr）。
- 运行时自证（本批窗口）：键置 1→provider 级 startManagedSession→sendReply→真实回复（最小 prompt 推理）→键归 0；**完整手机 E2E 由主控在合并后另派 RD 复验**（本批不做模拟器全链）。

## 4. 汇报

commits / 设计选型与取舍（时序自洽说明）/ 门禁数字（fast/full/:app/:core）/ 运行时自证证据 / 推理消耗如实 / 偏差如实。
