# RD 批任务书：手机远程对话经 Relay 端到端实证

> 背景：用户问「能不能做手机远程对话」。现状=App 气泡对话 UI+managed spawn/回复链+Relay 远程通道三层全在役；旧公网隧道时代 Codex 真实对话实证过（p95 4.76s），迁 Relay 后指令面/协议等价过（R-B5 门/R-B8）但**完整对话链从未端到端补验**（codex 腿 09-10 被用户终裁烂尾）。本批=用 **Kimi managed**（09-14 已真机 provider 级验证+用户已授权少量真实推理）在**模拟器经真实 Relay**补齐端到端实证。基线 main=04c7c7c，常驻 X12 版（含 KM/DS）在役。

## 0. 工作区与资源登记

- worktree：`git worktree add worktrees/rd-mobile-chat -b agent/rd-mobile-chat main`（若零代码改动则 worktree 可选，证据目录直接落主仓 acceptance/ 由主控提交——先留工作区备用）。
- **资源登记**：本批独占「模拟器+常驻运行时窗口」；ECS 仅按既有配对通道使用（零配置变更）；推理消耗=Kimi 真实推理少量（已授权，最小 prompt）。
- 凭据三零：配对码一次性面照旧、api_key 零入册；截图入册前逐张盘凭据（会话内容可入册，key/token 零出现）。

## 1. Phase A：预检（只读）

1. 模拟器盘点：`adb devices`；在役配对设备（桌面库 #46/#52 模拟器）状态；模拟器上 DevHub APK 版本（旧则装 `dist/DevHub-Android-0.1.0-debug.apk` sha256 cd6d8caf）；模拟器挂了→按 HANDOFF §7 SDK CLI 重拉配方，修不活则降级为「真机路径留用户+汇报」。
2. 链路预检：常驻 relay host-leg 连接态（`/v1/health` upstream.connected / ECS relay_audit connection_opened）；模拟器 App 的 relay 配对与 `kimi_managed_enabled=1` 置位（E2E 后归 0 恢复）。
3. App 现状确认：Agents 页 kimi 卡「启动托管会话」按钮出现（capabilities.mode==managed 数据驱动）。

## 2. Phase B：端到端对话实证（核心交付）

1. 模拟器 App（relay 模式）→ Agents → 启动 Kimi 托管会话。
2. 手机端发送 **≥3 条**真实消息（一条闲聊+一条明确指令+一条追问上下文的问题——验证多轮上下文连续性）。
3. 判定面：每条消息真实推理回流上屏（非夹具非本地投影）；消息延迟打点（源 occurredAt→App 可见，对齐 R5 延迟源口径）；会话气泡/状态徽章/输入框全链 UI 正常；桌面侧同会话投影一致（观察者视图）。
4. 证据：`acceptance/mobile-chat-relay-e2e/`——逐条延迟数字+关键屏截图（配对态/会话列表/对话流/桌面投影对照）+relay_audit 命令行记录（command_relayed action=spawn_session 等）。
5. E2E 毕：`kimi_managed_enabled` 归 0，常驻 health×3 复核。

## 3. 缺陷处置边界

- 验证中发现的**阻断缺陷**（如 relay 模式回复链断/会话门误拒）：小修（≤20 行、语义零扩张）可就地修+门禁+入证据；超小修→如实上报缺陷链（现象+根因定位+文件:行号），由主控立批，**不扩scope硬修**。
- 门禁（若动码）：typecheck 0+smoke fast 全绿（基线 129/129）。

## 4. 汇报

能否实现的最终判定（PASS/FAIL+判据）/逐条延迟数字/截图清单/缺陷与处置/Kimi 推理消耗如实/偏差如实。
