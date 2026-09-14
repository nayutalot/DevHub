# KM 批任务书：Kimi Code 真机 managed 通道接入（授权落地）

> 背景：known-limitations §1.5——kimiProvider managed 通道代码+夹具假进程验证全就位，唯一缺口=真机端到端（真实托管启动必然写 `~/.kimi-code` 且消耗少量真实推理）。**用户 2026-09-14 令「推进对 deepseekharness，kimicode 的适配」=§1.5 解除路径等待的用户授权**。本机 CLI 现为 **kimi 0.42.0**（`~/.kimi-code/bin/kimi`；代码基线注释 0.36.0——参数/布局须复核）。基线 main=876d916，门禁 typecheck 0+fast 125。

## 0. 工作区与纪律

- worktree：主仓根 `git worktree add worktrees/km-kimi -b agent/km-kimi-managed main`；`npm install`。
- 每 commit 即 push 分支（直连 `git -c http.proxy= -c https.proxy= push` 优先，socks5h://127.0.0.1:1081 兜底重试）；绝不 push main；绝不 --no-verify。
- **凭据红线**：`~/.kimi-code/config.toml` 的 api_key 绝不入日志/证据/汇报（既有 maskKey 尾 4 位纪律）；DevHub 零凭据注入（kimi CLI 用自己的 config，managed spawn 不搬 key）。
- **本批独占常驻运行时验证窗口**（单实例锁）；并发 DS 批零运行时需求。

## 1. Phase A：kimi 0.42.0 只读复核（TEMP 沙箱，零推理）

- 对 managed 通道依赖面逐项复核：probe/握手参数、托管 spawn 参数、stdin/stdout 交互形状、sessions/logs 目录布局与 state.json 终态线索——用 TEMP 沙箱 HOME/目录探测（`--help`/`--version` 级零推理命令优先），与 kimiProvider.ts 现有假设出**差异清单**（0.36→0.42 漂移面）。
- 只读；**绝不在此阶段触发真实推理**。

## 2. Phase B：生产接线（授权门模式，对齐 zcodeManagedConfig 先例）

- settings 键 `kimi_managed_enabled`（ALLOWED_KEYS，默认 **0=停用**；Mimosa 纪律：命名避开 `.request(` 形态、env→path 复用既有边界函数）。
- providerRegistry 生产 options 接线：键=1 时注入真机 managedProbeArgs/spawn 参数（Phase A 复核后的值），=0 维持现状（observed+空集+evidence 说明）。关闭时结构化折叠，绝不半开。
- 文案：CapabilitiesExplain/诊断面如实（managed 授权开/关两态证据文本）。

## 3. Phase C：真机 E2E（按授权执行）

- 单实例锁窗口纪律：taskkill 常驻→临时实例（DEVHUB_HOME 隔离库）→验证→taskkill→无参拉回常驻 health×3。
- 序列：键置 1 → getCapabilities 翻 `managed`（granted 含 reply，evidence 带真实 CLI 版本）→ **真实 sendReply 最小 prompt**（推理消耗最小化：一条短指令即止）→ 真实 reply 回流落库+投影证据（真实推理，非夹具）→ ~/.kimi-code sessions/logs 写入发生（路径级证据，零内容凭据）→ 键置 0 回归 observed（可撤销性证明）。
- 异常面：CLI 缺失/非零退出/超时→结构化失败（禁仅凭进程退出判成功的既有红线）。
- 证据入 `acceptance/kimi-managed-e2e/`（**入册前逐文件盘凭据**——sessions 原始文件若含 key/对话内容，脱敏或只录路径+哈希）。

## 4. 门禁

- typecheck 0 + smoke fast 全绿（基线 **125/125**，新增 settings 门/夹具用例如实计数）+ `npm run build`。
- Android 零改动（App 启动按钮由 capabilities.mode==managed 数据驱动自动出现，§8.1 既有结论）；ECS 零触碰；OverlayApp/ContestPin 零触碰；不出 APK。

## 5. 汇报

commits / 门禁数字 / 0.36→0.42 差异清单 / E2E 逐序列证据（capabilities 翻转→真实 reply→可撤销）/ 推理消耗如实（次数+量级）/ 偏差如实。
