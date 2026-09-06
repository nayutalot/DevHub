# DevHub 会话交接文档（2026-09-07 凌晨，M3-C6c 修复批运行中·C2c 判"部分"待 C2d）

> 交接范围：……（前史见 git log/docs/HANDOFF 旧版）→ M3-C4 四门禁全绿+push+v3 常驻 → C2b 未达（两缺口）→ C6a/C6b 修复双合+门禁绿+push fe306b9 → **C2c 复跑判"部分"（四缺口根因闭环+R3/⑧/R-B7 PASS）→ C6c 六项修复批运行中**。**新会话从 §4 续接（C6c 在跑先收割）。**

## 0. 新会话开工须知（用户令：严格约束工作流）

- **主控只 plan/review/merge + 只读核验；一切执行派 omni-agent，一 Agent 一 Worktree 一任务**——排障任务书必须携带主控已查明的事实链；主控 review 拦截架构偏移（本会话实证：否决"CA 入 App"修法，docs/19 §10.2 权威）
- **多并发常态 3**：每批派发后主动盘点并行面；资源登记互斥（端口/模拟器/常驻/ECS/gradle 各归一批）；冲突批排队注明原因；同树串行
- 增量提交接力+每 commit 即 push 分支；门禁绿才 push main；任务书落盘 docs/briefs/ 先入册；绝不 --no-verify；凭据三零
- 端口铁律：门禁前双杀 DevHub.exe+electron.exe；毕后常驻由后续批拉起；核对 PID/镜像名
- 阻塞上报前必实测；mcp 27/27 在 main 干净树（A12 真实语义=断言注册项目主树）

## 1. 当前状态一句话

**C2c 判"部分"：C6a 修2/C6b 验证 PASS + R3 真帧/⑧ TLS 双拒面/R-B7 口径全 PASS；但四个 App 侧缺口（pinner 空洞/数据面 baseUrl 不切/轮换帧竞态自毁/指纹配置 fail-open）阻断 R-B2 完整与 R-B3/4/5/8——C6c 六项修复批运行中，合入后 C2d 聚焦复跑（含撤销 ECS 遗留 #2/3/4），全过启 M3-D。**

## 2. M3-C4→C2c 战果台账（本会话续）

| 批 | 结果 |
| --- | --- |
| 门禁两红（C4a） | 均环境性结案零改动：smoke 干净环境 168/168×2（旧红=electron 残留）；mcp A05=跑时 Docker 在线致基线断，复跑 27/27 |
| C4b/C4c/C4d | v3 产物（口径修正：v3-v2 增量=C3b renderer+7 行）；ECS 预检 77/77 基线修正；m3d-watch 巡检工具合入 |
| 四门禁+push | main 干净树 tsc 0/smoke 168/mcp 27/gradle 183 → push 973eeb3..7a6260b；八分支全清 |
| v3 换装（C5a） | PASS：纯生产形态常驻+relay 自动重连 connected=true 首探即成+信任三物在位 |
| C2b 全表 | **未达**：缺口①TLS 信任锚空（四步实验闭环）+②REST 签发绕 L3；R-B9 App 错指纹 PASS；主控否决子代理"CA 入 App"建议（违反 docs/19 §10.2 pin-only）裁 pin 锚化 |
| C6a/C6b 修复 | 双合（8421375/0214b42）+门禁绿（smoke 169/:app 9）+push fe306b9；ECS 重部署 611ms 窗口常驻 20s 自愈 |
| C2c 复跑 | **部分**：**C6b PASS**（last_seen +90s 双查）+**C6a 修2 PASS**（换装 fe306b9 重建常驻后 2s 同步）+**R3 PASS**（退避徽标+29s 重连真帧）+**⑧ PASS**（App 错指纹结构化拒不崩+host 错指纹 m3d-watch 独立检出 SPKI MISMATCH+恢复自愈）+R-B7 按口径标注；未达四缺口见 §4 C6c；R-B4 未跑（token 明文不可安全取得=凭据红线）、R-B5/6/8 主链受锁屏+bug#2 阻断；模拟器事故 2 次均恢复（配方第 3 步重拉 35s boot） |
| C2c 遗留 | ECS relay_devices **#2/3/4 active 留待 C2d 经修复后通道撤销**（=R-B8 主链活体验证）；桌面 #38/39/40 同；常驻=fe306b9 重建版（v4 内容）运行中 connected=true；dist 根 NSIS 仍旧 v3（收尾统一） |

## 3. 项目事实基线（main=986cf10 已推）

- 门禁基线：tsc 0 / smoke **169** / mcp 27/27 / :core 183 + **:app 9** / ecs-relay test **91** / selfcheck **77**（root 口径；devhub-relay 用户=76+1SKIP 证书属主既知）
- ECS：C6b 版 active（touchHost 生效）；证书余 89 天 notAfter 2026-12-04（≤11-20 双指纹窗）；SPKI 不变
- 桌面常驻：**fe306b9 重建 win-unpacked**（01:01 构建，非代码变更换装）；备份链 bak-20260906(v1)/bak-v2-20260906(v2)/win-unpacked.v3-2048-bak(v3)
- C2c 新踩坑见 §7；APK 重建纪律：**dist 包时间戳必须晚于相关修复合入时间**（v3 教训：20:48 构建<23:51 合入→修2 假阴性）

## 4. ⚠️ 未决项（按序处理）

1. **收割 C6c 修复批**（运行中，任务书 m3c6c-fix-app4.md 六项）→ review（重点：bug#3 是否扩协议面）→ merge → main 四门禁 → push
2. **C2d 聚焦复跑**（C6c 后）：常驻重打包换装（含 C6c）→ 新模拟器（无 CA）重测 **TLS pin 面**（R-B2 完整+⑧ 正确指纹面）+ R-B3 ≥5min（自毁应消）+ R-B4/5/6 可得面 + **R-B8 主链活体（撤销 #2/3/4+#38/39/40）**；判据仍 docs/20 §3
3. **M3-D 72h**（C2d 全过）：t0 重置+m3d-watch --loop 15（#5 修复后 relay_enabled 面恢复）
4. dist 根 NSIS 统一重打包（收尾）；gate-fix 目录残留补删；worktree dist-v3/c6c-fix 批毕清
5. 待用户裁决不变：固定管理 IP/docs/21 旧三项+离线补投/证书日历

## 5. 待用户（只排队不代答）

1. **固定管理 IP** → ECS 加固收口；2. docs/21：离线设备 token_rotation 补投（docs/18 修订）；3. docs/21 旧三项（FCM/Kimi/hooks/delivery）；4. **2026-11-20 前双指纹窗口**；5.（新增建议）docs/18 §3.14 pair 期轮换帧投递语义增补（C6c 批已按"两腿都处理"实施）

## 6. 关键约束速查

28 条合同+docs/11-21+docs/briefs/m3c4*~m3c6c 全套；exec.ts 唯一 spawn；SQL 绑定；migration append-only；ecs-relay 自含；android 禁挪走；凭据零入仓/日志；ECS 零 Agent/零 Key；SSH `~/.ssh/devhub_ecs`。

## 7. 本段新增踩坑

- **Android 模拟器 offline**：plugin android_* 工具全挂（等设备回包）；恢复配方=adb CLI 真身 `C:/Users/sakuya/AppData/Local/Android/Sdk/platform-tools/adb.exe`（PATH 无）→ kill/start-server 无效则 taskkill emulator.exe+qemu → `emulator.exe -avd <名> -no-snapshot-load` 重拉（35s boot）→ App 重装重配；后台包装命令被终止会连带杀 qemu（两次事故均此型）
- **AOSP 链清洗 fallback**：非 Conscrypt 自定义 X509TrustManager 经 X509TrustManagerExtensions 清洁后返回**空链**→CertificatePinner 空洞拒连——JVM（BasicCertificateChainCleaner）语义不同测不出；pin-TM 与 certificatePinner 在 Android 结构性不兼容（C6c 修）
- **settings DB 在 %APPDATA%\DevHub\devhub.db**（非 %LOCALAPPDATA%；m3d-watch 曾读错致 relay_enabled=unknown）
- **dist 包版本-合入时间偏移**：打包时间戳早于修复合入=旧二进制假阴性（v3 之于 C6a）；每轮验收前核对构建时间戳
- API 35 CA 注入：`/system/etc/security/cacerts` 无效（Conscrypt 只读 APEX 库），需 zygote nsenter overlay `/apex/com.android.conscrypt/cacerts`（C2c 临时 provisioning 用毕即弃）
