# M3-C2c 批任务书（App 经公网 Relay 全表复跑：C6a/C6b 修复验证 + R-B2..R-B8 + R3 真帧 + TLS 拒面）

> C2b 判"未达"后的复跑批。两缺口已修并合 main（PinTrustManager pin 锚化 + REST 签发 L3 对齐）+ ECS 已重部署（heartbeat touchHost）。判据权威仍=docs/20 §3 R-B 表原文，不自造标准。
> 新基线：smoke **169** / mcp 27/27 / :core 183 + :app 单测 9 / ecs-relay test **91** / selfcheck 77(root 口径)。

## 0. 占用资源清单（机器资源登记）

- **模拟器 1 台**（用毕即关）；**桌面常驻 v3**（⓪ 步拉起后除 R-B6 host 断链外不动）；**ECS 只读观测**（SELECT 可/写零容忍，SSH `~/.ssh/devhub_ecs` root@59.110.149.11）；8746 归本批
- **APK 必须重建**：`cd android && JAVA_HOME='D:/Apps/JetBrains/IntelliJ IDEA 2026.1/jbr' ./gradlew :app:assembleDebug`——**21:11 旧包不含 PinTrustManager 修复不可用**；新包安装前核构建时间戳
- 截图 `acceptance/agents-mobile/m3c2c-*.png`（零配对码/token/指纹全值入图）；证据分支 `agent/m3c2c-evidence`
- 工作站可能锁屏（Electron UIA 不渲染）：**配对码签发优先走 REST** `POST http://127.0.0.1:8746/v1/pairing/create`（C6a 修后与 IPC 同源同步 ECS；body/响应契约见 httpServer.ts）；仅当判据硬性要求桌面 UI 截图且会话锁死时，以等价证据（DB/REST/audit）替代并如实标注，勿伪造

## 1. ECS 侧实测事实（引用勿复测全项）

- selfcheck 77/77（root 口径；devhub-relay 用户口径 76+1SKIP 证书项属既知属主问题）；relay_hosts id=3 active；relay_devices 仅 #34 revoked；C6b 部署后 last_seen 已随心跳推进（快照龄 15-18s）
- #34 处置不变：保持 revoked 留作负面素材；C2c 一律新配对码新设备（claim 限流 5 次/5min/源）

## 2. 任务（按序；判据 docs/20 §3）

**⓪ 常驻拉起+双验证**：起 v3 常驻（纯生产形态）→ gateway 200 → m3d-watch 单周期 connected=true → **C6b 活体验证**：SSH 连续两次 SELECT relay_hosts.last_seen_at（间隔 ≥60s）断言推进。T0 起点。
**① R-B2 公网配对（主验证点=C6a 修1）**：REST 签发配对码 → App（新 APK）relay 模式真实 WS 裸连 pair → **TLS 握手应过**（PinTrustManager 叶 SPKI∈pins）→ pair_accepted{ecsDeviceId, deviceToken, tokenVersion} → SecureStore → 新 token 重连 → 双侧列表可见（origin=relay）→ post-pairing 轮换 token_version=2（App 诊断面+桌面/audit 证据）。
**② R-B3+R3 真帧**：≥5min 零断连（心跳 30s/journal 零 error）→ 断网→退避徽标截图→恢复→自动重连截图。
**③ R-B4** 防重放/限流（token 经环境变量/临时文件，用毕删）。
**④ R-B5** 指令门+R5.3 事件体感（<2s 顺带记录）。
**⑤ R-B6** 双向断链补发（杀 App 补事件零丢失 sequence 断言；重启常驻补命令 queued→投递→result 回流）。
**⑥ R-B7** 触发通道核查（rotationBridge——已知 manual/periodic 属后续批次）；无通道=如实标注"触发面未实现，协议已由 selfcheck §11 覆盖"不算失败。
**⑦ R-B8**：步骤一 #34 旧 token 已销毁不可复测→以 ECS 侧等价证据链入账（row revoked+audit device_revoked+auth_failed denied）；**断言口径=C3b 新语义 DEVICE_REVOKED**（非 C2 期 RELAY_DEVICE_UNKNOWN）；步骤二主链 revoke 当前被试设备→disconnect(revoked) 停止重连→再连 401 DEVICE_REVOKED→注册表 revoked。
**⑧ TLS 拒面**：App 错误指纹→握手拒+结构化可诊断+不崩（**兼 PinTrustManager 回归守护**）；host 侧错误 fingerprints→拒连+告警（测毕立即恢复并复验 connected）；过期证书面=selfcheck 证书日历覆盖标注。

## 3. 铁律

- 与 C2b 版相同：凭据零入截图/历史/汇报；每条独立小节（判据原文→证据→PASS/部分/未达）；卡死重试 ≤2 换条；三次卡死=中断四分类；ECS 零写；绝不 --no-verify；零代码提交（截图入证据分支）

## 4. 汇报（四分类）

逐条 R-B 表 + C6a/C6b 修复验证结论（R-B2 TLS 过=R-B2 主证据之一；⓪ last_seen 双查=R-B 表外独立小节）+ 截图清单 + 环境恢复声明 + 新发现问题清单 + 证据分支 push 状态。
