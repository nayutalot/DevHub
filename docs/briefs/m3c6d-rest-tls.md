# M3-C6d 微修批任务书（relay REST 数据面 TLS 信任：GatewayApi pin-TM 化 + ApiProvider 注入）

> 主控 review C6c 时发现第七缺口（C6c 批已如实圈为范围外风险①）：**GatewayApi（relay REST 数据面）pinner-only+系统信任——自签 IP 证书握手必败**（"Trust anchor not found"；pinner 在信任层之后救不了）。且 `ApiProvider.rest()` 的 GatewayApi **连 tlsPinning 都没传**（纯系统信任）。C2d 的 R-B2"App 侧列表可见"必撞此墙，故 C2d 前必须修。
> 基线：main @ 8276d3a（已含 C6c 六项；:app 32 / smoke 169）。

## 0. 占用资源

- worktree `F:/Active_Project/DevHub-worktrees/c6d-rest-tls`（分支 `agent/c6d-rest-tls`，自 main 切）；npm install + android/local.properties 复制 + JAVA_HOME jbr
- 门禁时段 8746+双进程名互斥（当前常驻不在跑——C6c 批已按纪律清零，维持勿启）
- 不碰 ECS/模拟器/dist

## 1. 事实链与修向（主控已核码）

1. `GatewayApi.kt:88-96`：`tlsPinning?.let { pinPatternFor(pinHost)?.let { certificatePinner(...) } }`——**唯一残留 pinner 消费面**（git grep 已核）。修向：tlsPinning 非 null 且 pattern 有效 → 改用 `RelayTlsTrust.sslSocketFactory(pinning)` 自定义 TM（信任锚=指纹，同 WS 面勘误语义；**不装 pinner**——AOSP 空洞）；HostnameVerifier 默认。`toCertificatePinner` 若因此零消费面 → 删除或标注 legacy（grep 定夺，删则同步清理其测试引用）。
2. `ApiProvider.kt` rest()：GatewayApi 构造未传 tlsPinning/pinHost。修向：relay 模式下从 Room 配置取 `pinFingerprints`（与 ConnectionManager.parsePinning 同源同规则）+ endpoint.host 作 pinHost 传入。**生命周期**：GatewayApi 的 client 在构造时固化 TLS 而 baseUrl 是动态 lambda——指纹配置变更后旧 client 失效，最小方案=按（mode+pinFingerprints 摘要）缓存键重建单例，或改 GatewayApi 收 pinningProvider lambda（择小者，汇报说明取舍）。
3. ConnectionManager.relayApi 已传 tlsPinning/pinHost（8276d3a L314-318）——GatewayApi 内部修好后自动受益，勿重复改。

## 2. 任务

1. worktree 自建 → 两处修复 + `toCertificatePinner` 处置
2. 测试：GatewayApi pin-TM 注入（配 pinning → 有自定义 TM 无 pinner；null → 全默认）+ ApiProvider relay 模式 pinning 传递与配置变更重建（照 RelayPairTlsClientTest 风格）
3. 分支门禁：typecheck / smoke:fast / smoke 全量 169 / mcp 27 / gradle `:core:test :app:testDebugUnitTest :app:assembleDebug`
4. 每 commit 即 push `agent/c6d-rest-tls`

## 3. 铁律

修向不偏离 §1；凭据三零；绝不 --no-verify；不为绿而绿；收尾进程清零（常驻勿启）。

## 4. 汇报（四分类）

两处 diff 摘要+生命周期取舍说明+toCertificatePinner 处置+测试清单+分支门禁表+push 状态。
