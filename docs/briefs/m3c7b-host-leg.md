# M3-C7b 桌面修复批任务书（host 腿请求处理器 + 轮换 grace 镜像 + error 回程 + App 崩溃包裹 + 桌面孤儿清账）

> C2d 定案三缺口的桌面/App 侧半边。修后 R-B2 App 列表/R-B4 合法 200/R-B5 指令门/R-B6 result 回流解锁。#9（relay 模式设备自管理协议通道）=待用户裁决不在本批。
> 基线：main @ c99a2fa（smoke 169 / mcp 27 / :core 183 / :app 40）。

## 0. 占用资源

- worktree `F:/Active_Project/DevHub-worktrees/c7b-host-leg`（分支 `agent/c7b-host-leg`，自 main 切）；npm install + android/local.properties 复制 + JAVA_HOME jbr
- **8746+双进程名互斥（门禁时段）**：跑 smoke/mcp 前双杀（当前常驻在跑，杀掉属预期勿重启——C2e 拉起）
- 不碰 ECS（零连接，归并行批 c7a）、模拟器、dist

## 1. 主控已查明事实链（C2d 实证）

1. **#8 host 腿缺 E→H 请求响应面**：relayClient `routeFrame` 无 `agent_list/session_list/message` 分支（git -S 全史从未有）→ App REST 数据面请求全部 10s 超时。协议面已有（docs/18 §7.1 G5：列表/详情/消息），纯实现缺口。修向：routeFrame 增三处理器，接本地 agentControlService/gateway 等价逻辑（语义对齐本地 REST 面；只读投影类请求，鉴权沿用设备腿已建立的信任）
2. **桌面 remote_devices 无 grace**：轮换后 v1 在桌面侧即刻失效（R-B5/R-B4 命令帧面阻断根）。修向：桌面镜像 ECS 300s 宽限（轮换时刻+宽限窗内 v1 仍认；窗外拒）。存储按现有 schema 走 **migration append-only**（新列/新表均可，禁止改旧迁移）
3. **H→E error 帧仅关联 host 请求**：命令被桌面拒时不回程设备→设备 90s 等待超时。修向：先读 docs/18 error 帧语义——若协议允许设备向回程则照协议实现；若空白=最小实现（error 帧回程设备该命令请求 id）+KDoc 标注空白点，不扩帧面
4. **App 崩溃（高优小修）**：`GatewayConfigScreen.kt:293` 「测试连接」GatewayApi 构造在 try 外，`TlsPinning.kt:95` normalizeBody 的 IllegalArgumentException 杀进程（复现向量=输入框残留拼接非法指纹体）。修向：构造入 try + 结构化错误提示（保存门不受影响，勿动）
5. **桌面孤儿清账**：remote_devices #38/39/40/41/42/43 孤儿行（C2c/C2d 产物）→ 经桌面侧通道置 revoked（m3c2-revoke-row.ps1 夹具模式改造或等价 DB 脚本；SQL 绑定；前后快照留汇报）

## 2. 任务

1. worktree 自建 → 五项修复（#3 先读 docs/18 error 语义）
2. 测试：routeFrame 三处理器单测（对齐既有 relayClient 测试模式）；grace 镜像三态（窗内认/窗外拒/无轮换恒认）；崩溃包裹用例（非法指纹体→结构化错误非崩溃）
3. 分支门禁全跑：typecheck / smoke:fast / smoke 全量 169 / mcp 27 / gradle `:core:test :app:testDebugUnitTest :app:assembleDebug`（含 App 崩溃修）
4. 增量提交接力，每 commit 即 push `agent/c7b-host-leg`

## 3. 铁律

修法不偏离 §1；docs/18 空白只标注不扩帧面；migration append-only；凭据三零；绝不 --no-verify；不为绿而绿；收尾进程清零（常驻勿启）。

## 4. 汇报（四分类）

五项 diff 摘要+测试清单+docs/18 空白点标注原文+清账前后快照+分支门禁表+push 状态。
