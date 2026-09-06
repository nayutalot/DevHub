# M3-C6c 修复批任务书（C2c 四大缺口 + 两小项；纯本地代码零 ECS 改动）

> C2c 复跑（docs/briefs/m3c2c-app-e2e.md 执行记录）实证四缺口+两小项，根因全部闭环（事实链见 §1，你从结论实施不重复侦查）。修复合入后由 C2d 复跑批做活体验证。
> 基线：main @ e10d7ea（smoke 169 / mcp 27 / :core 183 + :app 9）。

## 0. 占用资源清单（机器资源登记）

- **worktree**：`F:/Active_Project/DevHub-worktrees/c6c-fix`（分支 `agent/c6c-fix`，自 main 切）；npm install + android/local.properties 从主树复制 + JAVA_HOME=`D:\Apps\JetBrains\IntelliJ IDEA 2026.1\jbr`
- **8746+双进程名互斥（门禁时段）**：跑 smoke/mcp 前双杀 DevHub.exe+electron.exe（当前常驻在跑，杀掉属预期勿重启——C2d 拉起）
- 不碰：ECS（零连接）、dist/、模拟器

## 1. 主控已查明事实链（C2c 批实锤，含证据位置）

**bug#1（pinner 空洞拒连，阻断 TLS pin 面）**：`RelayPairingClient.kt` L113-114 同时装 PinTrustManager（信任层已过）+ OkHttp certificatePinner；okhttp 4.12 `check$okhttp` 只对清洁链配 pin，而 AOSP X509TrustManagerExtensions 对非 Conscrypt 自定义 TM 的 fallback 在 checkServerTrusted 通过后返回**空链**（字节码+旁证：系统 CA 路径下同 pinner 拒绝结构非空）→ 空洞拒连。**修向（主控裁）**：pin-TM 激活时不装 certificatePinner（信任判定单点=checkServerTrusted）；HostnameVerifier 默认（IP SAN）保留作第二保险。**docs/19 §10.2 补勘误注**（实现层：pin-only 经自定义 TM 承载，CertificatePinner 在 Android 对自定义 TM 结构性不兼容——裁决语义"pin-only 不依赖系统信任链"不变）。

**bug#2（App 数据面不切 relay base）**：`ApiProvider.kt` 单例 baseUrlProvider 恒 `http://config.host:port` → relay 模式列表全打 10.0.2.2:8746 得 AUTH_INVALID_TOKEN（文案"gateway:"前缀=桌面网关实锤）；正确 ECS base 已存在于 `ConnectionManager.kt:314` relayApi。**波及**：会话/设备列表、DeviceScreen 自撤销——其 401 被 `err.httpCode!=401` 判断短路成"撤销成功"而 ECS 零撤销（已核码）。修向：按连接模式切 baseUrl（relay→https://relay endpoint）+ 自撤销 401 不得伪报成功。

**bug#3（轮换帧投递竞态→配对 ≤300s 系统性自毁，三设备 #38/39/40 确定性复现）**：时间线=01:04:05 device_paired+token_rotation_applied v2 **同秒**（设备常规 WS 尚未建）→ 01:04:39 grace admitted（App 带 v1 重连）→ 01:09:05 grace 到期 connection_closed → 01:09:08 grace_expired denied → 01:09:09 App onAuthFatal 清凭据。根因：pair WS 侧 RelayPairingClient 对 token_rotation 帧走 `else -> Unit` 丢弃分支 → App 恒持 v1。**先读 docs/18 §3.14 轮换语义**：若文档定义了帧投递通道则照文档修（首选：pair WS 与常规 WS 两条腿都处理 token_rotation 帧——帧本就发给该设备，持久化到 SecureStore）；若文档对此竞态空白，按"两腿都处理"实施并在汇报标注"协议文档空白点+建议 docs/18 增补"（勿扩协议面）。

**bug#4（指纹配置层 fail-open）**：空指纹 relay 模式保存放行（连接层才 fail-closed"Trust anchor not found"）；指纹残行（如丢 sha256/ 前缀）保存零校验、pair 时才 BAD_CONFIG。修向：保存时格式校验（复用 :core TlsPinningConfig 校验逻辑）+ relay 模式空指纹给引导文案（不硬阻断）。

**小项#5**：`scripts/m3d-watch.mjs` settings DB 路径错——实际库在 `%APPDATA%\DevHub\devhub.db`（非 %LOCALAPPDATA%），致 relay_enabled=unknown。修正路径（两处候选都探测取存在者）。

**小项#6**：配对失败后码输入框不自动清空（16 位拼接误输之源）。PairingScreen 失败回调清空。

## 2. 任务

1. worktree 自建 → npm install → 复制 local.properties
2. 六项修复（bug#1-#4 + 小项#5/#6），bug#3 先读 docs/18 §3.14
3. 测试：bug#1 补"pin-TM 激活时 builder 不装 pinner/装 pinner 于无 TM 路径"单测；bug#2 baseUrl 模式切换单测；bug#3 pair 腿 token_rotation 帧处理单测（fake WS 帧泵）；bug#4 保存校验单测——均入 :app/:core 现有测试文件风格；smoke 169 不回退（#5/#6 无 smoke 面）
4. 分支门禁全跑：typecheck / smoke:fast / smoke 全量 / mcp / gradle `:core:test :app:testDebugUnitTest :app:assembleDebug`
5. 增量提交接力，每 commit 即 push `agent/c6c-fix`

## 3. 铁律

- 修法不偏离 §1 裁定；docs/19 只加勘误注不改裁决语义；docs/18 若空白=标注建议勿自行扩协议
- 凭据三零；绝不 --no-verify；不为绿而绿；卡死重试 ≤2
- 收尾进程清零复查；常驻不恢复（C2d 负责）

## 4. 汇报（四分类）

- 六项 diff 摘要（文件/行为面/测试用例名）+ docs/19 勘误注与 docs/18 空白点标注原文
- 分支门禁终态表 + push 状态
