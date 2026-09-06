# M3-C2 批任务书（App 经公网 Relay 联调：R-B2..R-B8 + R3 信标遗留 + TLS 拒绝面）

> 前提已就绪：host 腿 hostId=3 公网 wss 持续在线（17min+ 零断连）；R-B1 已过；App（main=973eeb3 构建的 APK 或现有 assembleDebug）双模式就绪；R3 信标徽标本批补真实端到端截图。
> 权威判据：docs/20 §3 R-B 表（逐条对照勿自造标准）；模拟器先行（物理真机复跑后续单独安排）。

## 0. 占用资源清单（机器资源登记）

- **模拟器 1 台**（用毕即关）；**DevHub.exe 常驻**：开头先重启一次剥离 `--remote-debugging-port=9222`（纯生产形态；settings 已持久化会自动重连，重连后 connected=true 复验）——之后除 R-B6 host 断链步骤外不动
- **ECS**：只读观测（journalctl/audit/health）+ R-B7 若需手动触发轮换的既定通道（见 §1⑦）；零代码/配置改动
- 段外端口：无新监听需求
- 截图目录：`acceptance/agents-mobile/m3c2-*.png`（零凭据：配对码用后即焚可入镜？**不可**——截图不出现配对码/token/指纹全值）

## 1. 任务（按 R-B 序；每条判据以 docs/20 §3 为准）

**⓪ 常驻纯化**：重启剥离 debug port → connected=true 复验 → 起点 T0。

① **R-B2 公网配对**：桌面 Agent 控制签发配对码（relay 模式经 register_pairing）→ 模拟器 App 切 relay 模式（`wss://59.110.149.11`——App 侧 relayUrl 形态以 R3 实现为准）→ 输码 pair → pair_accepted → 双侧设备列表可见（origin=relay）→ **post-pairing 自动轮换发生（token_version=2）**——App 侧 SecureStore/诊断面 + 桌面设备页/audit 证据。
② **R-B3 设备腿**：App 经公网 wss 保持 ≥5 分钟零断连（心跳 30s、App 诊断面 + journal 零 error）；**R3 信标遗留**：连接建立后断网（模拟器 airplane/wifi off）→ 截 `upstream:disconnected`/退避徽标图 → 恢复网络 → 自动重连成功截图（这就是 M2-R3 缺的真帧证据）。
③ **R-B4 防重放/限流**：REST 面同 nonce 重放 401/窗外 401/合法 200（可用 curl 对公网 443 以设备 token——token 不入命令行历史/截图，经临时文件或环境变量传）；命令帧面同 nonce 重放被拒 AUTH_REPLAYED。
④ **R-B5 指令门**：observed 会话发 command → `command_ack rejected COMMAND_NOT_EXECUTABLE`；managed 会话 send_message → accepted → 真实推理回流（事件到达 App）。
⑤ **R-B6 断链补发（必跑，frp 版欠账）**：杀 App → 期间桌面产生 ≥3 事件 → 重连 sync_request 补齐零丢失（sequence 连续性断言）；host 断链（重启常驻）→ 期间 App 发命令 → queued → host 上线投递 → result 回流。
⑥ **R-B8 撤销踢线**：桌面 revoke 该设备 → disconnect(revoked) 到达 App 停止重连 → 再连 401 DEVICE_REVOKED → ECS 注册表 revoked 证据。
⑦ **R-B7 token 轮换**：先查 R1 rotationBridge 的触发通道（设置面/自动周期/手动 API）；有既定通道→手动触发：Keystore 原子更新→heartbeat tokenVersion 确认→旧 token 宽限后 401；**无既定通道→如实标注"触发面未实现，轮换协议已由 nb-r1-160/selfcheck 覆盖"不算失败**（docs/20 该项以手动触发为前提，触发面属 R1 范围裁决遗留）。
⑧ **TLS 拒绝面（R-B9 可先行部分）**：App 高级指纹项填**错误指纹**→握手被拒（错误可诊断）；host 侧换错误 fingerprints 文件→relayClient 拒连+告警（**测毕立即恢复原指纹并复验 connected**）；过期证书面=标注"由 nb-c1b-165 临时证书路径+selfcheck 证书日历覆盖，生产证书 2026-12-04 到期后首验"。

## 2. 铁律

- 配对码/token/凭据零入截图/命令行历史/汇报（token 经环境变量或临时文件，用毕删）；测毕恢复一切环境物（指纹文件/常驻形态）
- 每条 R-B 独立小节汇报：判据原文→实际证据→PASS/部分/未达+原因；判据不达=如实标 FAIL 不粉饰
- 单条卡死重试 ≤2 轮，换条继续（顺序无强依赖处）；整体超时或三次卡死=中断四分类上报
- ECS 零改动；桌面常驻除 ⓪/⑤ 外不重启；零仓内代码提交（截图可 commit 到 `agent/m3c2-evidence` 推送）

## 3. 汇报

四分类+逐条 R-B 表格（判据/证据/PASS 状态）+截图清单+环境恢复声明+发现的问题清单（供后续批修复，如 UI toggle 刷新缺口）。
