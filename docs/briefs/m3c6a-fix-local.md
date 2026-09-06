# M3-C6a 本地修复批任务书（App TLS 信任锚 pin 化 + REST 配对签发 L3 对齐）

> 修复 C2b 批实证两缺口。根因已由 C2b 批四步实验闭环（见 §1），你从结论实施，不重复侦查。
> 基线：main @ a8cdbf6（四门禁绿：tsc 0/smoke 168/mcp 27/:core 183）。

## 0. 占用资源清单（机器资源登记）

- **worktree**：`F:/Active_Project/DevHub-worktrees/c2c-fix-local`（分支 `agent/c2c-fix-local`，自 main 切）；npm install + **android/local.properties 从主树复制**（gitignored 仅 sdk.dir）+ JAVA_HOME=`D:\Apps\JetBrains\IntelliJ IDEA 2026.1\jbr`
- **8746+双进程名互斥（门禁时段独占）**：跑 smoke/mcp 前 `taskkill //IM DevHub.exe //F` + `taskkill //IM electron.exe //F`（**会杀掉常驻——预期内，勿重启**，C2c 复跑批负责拉起）
- 不碰：ECS（并行批 c2c-fix-ecs 独占）、dist/、模拟器
- gradle 与并行批无共享（对方纯 Node）

## 1. 主控已查明事实链（含设计权威裁决）

**缺口#1（阻断级）App TLS**：
- 现象：正确指纹也握手失败（`ws close -1 Certificate pinning failure`/RELAY_PAIR_CLOSED_EARLY）；caddy 443 只发叶证书（chainLen=1 实测）
- 根因（四步实验闭环）：`TlsPinningOkHttp.kt` 内 `RelayTlsTrust.DelegatingTrustManager.getAcceptedIssuers()` 返回空数组 → OkHttp CertificateChainCleaner 无信任锚 → clean([leaf]) 抛 "Failed to find a trusted cert"；**实验④：acceptedIssuers 给根 CA 后链清洗净成功**（ca.pem 叶-根签名验证通过）
- **设计权威（主控裁决依据，勿偏离）**：docs/19 §10 = 信任模型架构权威——**§10.2 Android=注入式指纹 pin-only**（TlsPinningConfig 任一匹配即信任；客户端不依赖系统信任链）；**§10.5 明列自签 CA 不分发给 App**（CA 仅运维 curl --cacert 用）。→ **C2b 批建议的"Android 装载根 CA"方案被主控否决（偏离裁决架构）**
- **正确修法**：信任锚=配置指纹本身——自定义 X509TrustManager.checkServerTrusted 按叶证书 SPKI ∈ 配置指纹列表判定（任一匹配即信任，不匹配=结构化拒绝）；HostnameVerifier 保持默认（IP SAN 校验=§10.1 双保险）；CertificatePinner 保留作强制层。**保持既有面**：错误指纹→握手拒+错误结构化可诊断+进程不崩（R-B9 已 PASS 面不回退）；指纹格式 fail-fast 不变；local 模式 null 配置零回归（D7/§10.2）
- 测试面：:core TlsPinningConfig 现有 183 内测试不回退；为 trust manager 补 JVM 单测（叶-only 链+正确 pin 握手过 / 错误 pin 结构化拒 / 空 pin 行为）——测试证书可用代码内生成或既有 fixture 模式

**缺口#2（一致性）REST 配对签发绕过 L3**：
- 现象：loopback REST `POST /v1/pairing/create` 签发码不触发 register_pairing，码到不了 ECS（5 次实测 pairing_codes 停在 id=7、无 pairing_code_registered 审计）；仅 UI/IPC 路径（agentControlService.createPairing:1005→notifyPairingIssued）同步
- 根因：httpServer.ts:631 直调 gateway/pairing.ts createPairingCode，绕过 L3
- 修法：路由改调 `agentControlService.createPairing`（与 IPC 同源）；响应契约不变；若 L3 依赖 IPC 上下文不可用则最小适配并说明。smoke 侧按既有 pairing 用例模式补一条（能断言 L3 被调/审计路径即可，勿造公网依赖）

## 2. 任务

1. worktree 自建（§0 命令）→ npm install → 复制 local.properties
2. 缺口#1 修复（android/app/src/main/java/com/devhub/mobile/data/remote/TlsPinningOkHttp.kt，94 行，先通读现状）+ 测试
3. 缺口#2 修复（src/main/services/agentControl/gateway/httpServer.ts:631 一带）+ smoke 用例
4. 分支门禁全跑：typecheck 0 / smoke:fast / smoke 全量（168+新增全绿）/ mcp 27/27 / `cd android && JAVA_HOME=... ./gradlew :core:test :app:testDebugUnitTest :app:assembleDebug`
5. 增量提交接力，每 commit 即 push `agent/c2c-fix-local`

## 3. 铁律

- **修法不得偏离 §1 设计权威**（pin-only；CA 不入 App）；架构疑问=停止上报不自行选择
- 凭据三零；绝不 --no-verify；不为绿而绿；单点卡死重试 ≤2 轮
- 收尾：tasklist 无 devhub/electron（门禁时段杀掉的常驻**不恢复**）、8746 无监听、worktree git status 干净

## 4. 汇报（四分类）

- 两缺口修复 diff 摘要（文件/行为面）+ 测试清单（新增用例名+数字：:core/:app/smoke）
- 分支门禁终态表 + push 状态；对 §1 设计裁决的遵循声明
