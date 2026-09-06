# DevHub 会话交接文档（2026-09-06 晚，M3-C 中段·C2b 待跑·门禁两红待定位）

> 交接范围：……（前史见 git log/docs）→ M2 收官 → M3-A/B 部署+验收线③闭环 → C1 整链点亮（host 腿公网 17min+ 零断连）→ C2 联调（协议腿全绿/实证 App 三缺口）→ C3a/C3b 修复已合 main。**新会话从 §5 未决项续接。**

## 0. 新会话开工须知（用户令：严格约束工作流）

- **主控只 plan/review/merge + 只读核验；一切执行（写码/改测试/部署/排障/UI 驱动/重打包）派 omni-agent，一 Agent 一 Worktree 一任务**——排障任务书必须携带主控已查明的事实链
- **多并发是默认形态**：每批派发后主控主动盘点可并行面凑满（常态 3 个子代理同时跑）；派发前按机器资源登记核对互斥（端口/模拟器/常驻/ECS 单元各归一批），冲突批排队注明"待 X 合入后再派"；同树/同文件批次必须串行；运行中计数长期=1 即主控失职
- 增量提交接力+每 commit 即 push 分支；主控合并 main 后门禁绿才 push main；任务书落盘 docs/briefs/（含未跟踪任务书要先入册——A12 会被未跟踪文件打挂）
- 端口铁律（**升级版**）：跑门禁前 `taskkill //IM DevHub.exe //F` **加 `taskkill //IM electron.exe //F`**（dev 二进制名残留曾占 8746 卡死 smoke）；跑毕恢复常驻+curl 200（**核对 PID/镜像名**——残留 electron 会伪装常驻）
- 阻塞上报前必实测；凭据三零；绝不 --no-verify；mcp 全量 27/27 只在 main 干净树跑（任务分支 26/27+A12 环境性=惯例）

## 1. 当前状态一句话

**App 侧三缺口已修、协议侧宽限/语义已补、双双合入 main（本地 ddd6bbc）——但统一门禁出现两条未定位红（smoke 167/168 + mcp A05）、main 未推、桌面常驻 DOWN**。下一跳：定位门禁红 → 补齐门禁 → push → C2b 全表重跑（App 真实入网）→ M3-D 72h 稳定期。

## 2. M3-C 战果台账（本会话）

| 批次 | 结果 |
| --- | --- |
| C1 注册/接线调查 | hostId=3 注册（凭据/指纹/后补 ca.pem 落盘 %LOCALAPPDATA%\DevHub\relay\）；查明设置通道+TLS 装载两缺口 |
| C1b 驱动面+TLS 装载（020548b 合并） | loadRelayTlsTrust+SPKI pin+设置 UI 分组（零新 channel）；**白捡真安全修复：TLS 会话恢复跳过 checkServerIdentity（maxCachedSessions=0）**；smoke 164→168 |
| C1c 点亮 | dist 重打包 v2+UI 驱动启用 → **host 腿公网 17min+ 零断连、R-B1 双证据、四截图**（agent/m3c1c-evidence） |
| C2 App 联调 | 协议腿全绿（stand-in：pair 全链/origin=relay/轮换 v2/撤销同步/TLS 两拒）；**App 三缺口实证**（WS pair 传输缺失/pin 通配符崩溃/轮换孤儿化）+桌面两缺口（toggle 刷新/撤销自动化错位）；R-B 表 3 部分 5 未达（agent/m3c2-evidence） |
| C3a App 三修+R5.3（ddd6bbc 合并） | RelayPairingMachine/RelayPairingClient/PairingScreen 模式感知；pinPatternFor fail-fast；R5.3 事件驱动（最差 1.8s→0.1s，18×）；:core 167→**183** |
| C3b 协议补全（adb056e 合并） | 轮换 300s 宽限（迁移 0002+三态鉴权+grace 审计+窗满 superseded）+disconnect deviceId 单一语义+RelayPanel toggle 修复；ecs-relay 83→**89**/selfcheck 63→**76**；**ECS 已重部署全套复验绿** |
| 统一门禁（C3 合并后） | typecheck ✓ / smoke:fast 82/82 ✓ / build ✓ / **smoke 全量 167/168 ✖ / mcp A05 ✖ / gradle 未跑** |

## 3. 项目事实基线（main 本地=ddd6bbc，**领先 origin 4 提交未推**）

- 门禁基线（应为）：tsc 0 / smoke **168**（fast 82/full 86）/ mcp 27/27 / :core **183** / ecs-relay test **89** + selfcheck **76**（ECS 同套复验过）
- ECS：devhub-relay=C3b 版 active（8443）、caddy 443、S1 已开、SPKI=`sha256/a07f7ab7...50d0`、notAfter 2026-12-04；frps 兼容通道照旧
- **桌面常驻 DOWN**（交接时）；dist 现包=C1c 版（不含 C3b renderer 修复）；relay settings：enabled=1+endpoint 已持久化（常驻起来自动重连）
- Windows 侧测试残留：remote_devices #31/32/33 revoked 留观、#34 active（C2b 或复用或撤销）；ECS relay_hosts=1 行(main-desktop active)、relay_devices=1 行(#34 已 revoked)

## 4. ⚠️ 未决项（新会话按序处理，全部派子代理）

1. **定位门禁两红**（第一优先）：smoke 全量 167/168 失败用例未识别（识别跑三次被打断；怀疑 C3b 的 AgentsView/共享类型面或环境残留）+ mcp A05 详情；修复→四门禁+gradle 全绿
2. **push main**（门禁绿后，本地 4 提交：6c7d5f2 briefs/adb056e C3b/ddd6bbc C3a/HANDOFF 提交）
3. evidence 合入：agent/m3c1c-evidence(4d02ac7) + agent/m3c2-evidence(0ee2837) → main
4. 清理：worktree app-relayjoin；本地+远端分支 agent/m3c-relay-wiring/agent/app-relayjoin/agent/relay-protocol-fix（均已合）+ evidence 分支
5. **重启常驻**（dist 现包即可）→ 验证 relay 自动重连 connected=true；随后 dist 重打包 v3（含 C3b renderer 修复）择机换装
6. **C2b 全表重跑**（主任务，任务书可基于 docs/briefs/m3c2-app-e2e.md 修订：三缺口已修+宽限已上，App 走真实公网 pair）：R-B2..R-B8 全表+R3 信标真帧+R-B7 按新裁定（触发面未实现=如实标注）
7. **M3-D 72h 稳定期启动**（C2b 全过后 T0 记时；巡检脚本/日志面交子代理搭）

## 5. 待用户（只排队不代答）

1. **固定管理 IP** → ECS 加固收口（确认密钥可登→禁 root 密码→22 限源→3389 残留）
2. docs/21 追加裁决：离线设备 token_rotation 补投（契约空白；现按 401→重配对，协议扩展需修订 docs/18）
3. docs/21 旧三项（FCM 分期/Kimi 真机/hooks）；delivery 聚合语义
4. 证书轮换日历：**2026-11-20 前启动双指纹窗口**（notAfter 12-04，selfcheck 证书项 <14 天 FAIL 会兜底）

## 6. 关键约束速查

28 条合同+docs/11-21+docs/briefs/m3c*；exec.ts 唯一 spawn；SQL 绑定；migration append-only（ECS schema 已到 0002）；ecs-relay 子目录自含；android 禁挪走；私钥/凭据零入仓库/日志；ECS 零 Agent/零 Key；SSH 密钥 `~/.ssh/devhub_ecs`（密码勿用）。
