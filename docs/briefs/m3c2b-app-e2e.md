# M3-C2b 批任务书（App 经公网 Relay 全表重跑：R-B2..R-B8 + R3 信标真帧 + TLS 拒绝面）

> C2 版重跑批。与 C2 的差异根源：三缺口已修（C3a：relay WS pair 传输 / TLS pin 通配符崩溃 / R5.3 事件驱动刷新）+ C3b 已上（token 轮换 300s 宽限 / disconnect deviceId 单一语义 / RelayPanel 事件刷新），main @ a53ff7d 已含两批（C3a ddd6bbc / C3b adb056e）。
> **开工前置（两并行批完成才可开工）**：①门禁全绿（gate-fix 批：tsc 0 / smoke 168 / mcp 27/27 / gradle `:core:test`=183+`assembleDebug` 绿）；②桌面常驻 v3 win-unpacked 上线（dist-v3 批构建+部署完成）。
> 权威判据：docs/20 §3 R-B 表（逐条对照勿自造标准）；模拟器先行（物理真机复跑后续单独安排）。

## 0. 占用资源清单（机器资源登记）

- **模拟器 1 台**（用毕即关）
- **桌面常驻 = v3 win-unpacked**（main 全量含 C3a/C3b renderer 修复；v2 不合格——缺 pair WS 传输/TLS pin 修/R5.3/面板刷新）：开头先重启一次剥离 `--remote-debugging-port=9222`（纯生产形态；settings 已持久化会自动重连，重连后 connected=true 复验）——之后除 R-B6 host 断链步骤外不动
- **App = android `assembleDebug` 新构**（C3a 后 main；不可复用 C2 期旧 APK）
- **ECS**：只读观测（journalctl/audit/health/sqlite SELECT）+ R-B7 若需手动触发轮换的既定通道（见 §1⑥）；零代码/零配置/零数据改动
- 段外端口：无新监听需求
- 截图目录：`acceptance/agents-mobile/m3c2b-*.png`（截图不出现配对码/token/指纹全值）

### ECS 侧实测事实（2026-09-06 C2b 筹备批预检，直接引用勿复测全项）

- 服务 devhub-relay active（18:02:39 CST 起，C3b 版）；selfcheck **77/77 ALL GREEN**（含 C3b §11「token 轮换宽限三态 + disconnect 单一语义」13 项）；证书剩余 89 天（2026-12-04T19:28:46Z 到期，≥14 天）
- SPKI 实测：sha256/`a07f7ab7...72aa50d0`（前 16+后 8；127.0.0.1:443 与 59.110.149.11:443 双视角一致）；证书 CN=devhub-relay-ip、签发者 DevHub Relay Root CA
- journal 近 24h：62 行，error/fail/fatal 面 **0 条**
- audit 近 24h：53 条，无宽限窗异常（生产未发生旧 token 宽限认证事件；宽限三态由 selfcheck §11 覆盖）；`token_rotation_applied`×1（配对即轮换）、`device_revoked`×1、`auth_failed denied`×1（revoke 后再连被拒 = DEVICE_REVOKED 实证）、`relay_cache_evicted`×1（ttl_payload 12335 行，负载测试期正常 TTL 清扫）
- `relay_hosts` 仅 1 行：id=3 `main-desktop` status=**active**（enrolled 13:39:38，last_seen 20:18:05 +08）
- `relay_devices` 仅 1 行：id=1 / win_device_id=34 / `m3c2-standin-client` / android / **revoked** / token_version=2 / 无 grace 残留（paired 16:39:42，revoked 17:09:45）
- **#34 处置决定（已定，按此执行）**：保持 revoked——撤销即拒不可复活，**不复用、不清理**；留作 401 DEVICE_REVOKED 负面素材（§1⑥ 步骤一）。C2b 一律**新配对码新设备**（注意 claim 限流 5 次/5min/源）
- **#31/32/33**：ECS relay_devices **无残留行**，无需清；Windows remote_devices 侧 revoked 留观行属桌面侧 DB，不阻塞本批，勿动
- 预检时点 host 腿瞬时离线（gate-fix 批并行跑门禁 taskkill 所致，非异常）——开工时 ⓪ 步以 connected=true 复验为准

## 1. 任务（按 R-B 序；每条判据以 docs/20 §3 为准）

**⓪ v3 常驻就位**：确认 DevHub.exe 为 v3 win-unpacked → 重启剥离 debug port → connected=true 复验 → 起点 T0。

① **R-B2 公网配对（期望行为已改写）**：桌面 Agent 控制签发配对码 → 模拟器 App 切 relay 模式（`wss://59.110.149.11`——App 侧 relayUrl 形态以 R3 实现为准）→ 输码 pair。**pair 必须走 App 真实 WS 裸连传输**（C3a 修1：`/relay/device` 无 Bearer 裸连 → hello → pair 帧 → pair_accepted{ecsDeviceId, deviceToken, tokenVersion} → SecureStore 落凭据 → 新 token 重连正式连接；禁止 REST claim 替代路径）→ pair_accepted → 双侧设备列表可见（origin=relay）→ **post-pairing 自动轮换发生（token_version=2）**——App 侧 SecureStore/诊断面 + 桌面设备页/audit 证据。
② **R-B3 设备腿 + R3 信标真帧**：App 经公网 wss 保持 ≥5 分钟零断连（心跳 30s、App 诊断面 + journal 零 error）。**R3 信标遗留（必出真帧）**：连接建立后断网（模拟器 airplane/wifi off）→ 截 `upstream:disconnected`/退避徽标图 → 恢复网络 → 自动重连成功截图（M2-R3 缺的真帧证据）。
③ **R-B4 防重放/限流**：REST 面同 nonce 重放 401 / 窗外 401 / 合法 200（curl 对公网 443 以设备 token——token 不入命令行历史/截图，经临时文件或环境变量传）；命令帧面同 nonce 重放被拒 AUTH_REPLAYED。
④ **R-B5 指令门**：observed 会话发 command → `command_ack rejected COMMAND_NOT_EXECUTABLE`；managed 会话 send_message → accepted → 真实推理回流（事件到达 App；R5.3 事件驱动后 <2s 体感可顺带记录）。
⑤ **R-B6 断链补发（必跑）**：杀 App → 期间桌面产生 ≥3 事件 → 重连 sync_request 补齐零丢失（sequence 连续性断言）；host 断链（重启 v3 常驻）→ 期间 App 发命令 → queued → host 上线投递 → result 回流。
⑥ **R-B7 token 轮换（期望行为已改写）**：先查 R1 rotationBridge 的触发通道（设置面/自动周期/手动 API）。有既定通道 → 手动触发：Keystore 原子更新 → heartbeat tokenVersion 确认（应 +1）→ **宽限实测**：旧 token 自新哈希生效起 300s 内仍认（窗内旧 token 请求成功）、窗外 401、新 token 恒 200（三态，ECS 侧语义已由 selfcheck §11 部署验证）。**无既定通道 → 如实标注"触发面未实现，轮换协议已由 selfcheck §11 宽限三态覆盖"，不算失败**（docs/20 §3 该项以手动触发为前提，触发面属 R1 范围裁决遗留）。轮换失败路径（拒更新）→ 重配对引导（docs/20 判据含此项，通道存在时才跑）。
⑦ **R-B8 撤销踢线（期望行为已改写）**：步骤一（负面预验，零成本）：App 临时改持 #34 旧 token（经临时文件/环境变量传，不入历史/截图）直连 → 应 401 DEVICE_REVOKED（revoked 不可复活语义实证）；步骤二（主链）：当前被试设备上桌面 revoke → **disconnect(revoked) 到达 App 停止重连**（C3b 修2 后 deviceId 单一语义，撤销不错位）→ 再连 401 DEVICE_REVOKED → ECS 注册表 revoked 证据（sqlite SELECT 只读）。
⑧ **TLS 拒绝面（R-B9 可先行部分）**：App 高级指纹项填**错误指纹** → 握手被拒且**错误可诊断、进程不崩**（C3a 修2 后 IP pattern 不再抛 IllegalArgumentException 死循环——本步兼作修 2 公网回归）；host 侧换错误 fingerprints 文件 → relayClient 拒连+告警（**测毕立即恢复原指纹并复验 connected**）；过期证书面=标注"由 selfcheck 证书日历覆盖，生产证书 2026-12-04 到期后首验"。

## 2. 铁律

- 配对码/token/凭据零入截图/命令行历史/汇报（token 经环境变量或临时文件，用毕删）；测毕恢复一切环境物（指纹文件/常驻形态）
- 每条 R-B 独立小节汇报：判据原文→实际证据→PASS/部分/未达+原因；判据不达=如实标 FAIL 不粉饰
- 单条卡死重试 ≤2 轮，换条继续（顺序无强依赖处）；整体超时或三次卡死=中断四分类上报
- ECS 零改动（SELECT 只读可，写零容忍）；桌面常驻除 ⓪/⑤ 外不重启；零仓内代码提交（截图可 commit 到证据分支推送）
- 绝不 `--no-verify`

## 3. 汇报

四分类 + 逐条 R-B 表格（判据/证据/PASS 状态）+ 截图清单 + 环境恢复声明 + 发现的问题清单（供后续批修复）。
