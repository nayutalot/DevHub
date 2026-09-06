# DevHub 会话交接文档（2026-09-07 凌晨，M3-C6 修复批并行·C2b 已判未达待复跑）

> 交接范围：……（前史见 git log/docs/HANDOFF 旧版）→ M3-C4 四门禁全绿+push+v3 常驻 connected → **C2b 全表重跑判"未达"（两缺口根因闭环）→ M3-C6a/C6b 修复批并行中**。**新会话从 §4 未决项续接（两修复批在跑则先收割）。**

## 0. 新会话开工须知（用户令：严格约束工作流）

- **主控只 plan/review/merge + 只读核验；一切执行（写码/改测试/部署/排障/UI 驱动/重打包）派 omni-agent，一 Agent 一 Worktree 一任务**——排障任务书必须携带主控已查明的事实链
- **多并发是默认形态**：每批派发后主控主动盘点可并行面凑满（常态 3 个子代理同时跑）；派发前按机器资源登记核对互斥（端口/模拟器/常驻/ECS/gradle 缓存各归一批），冲突批排队注明"待 X 合入后再派"；同树/同文件批次必须串行；运行中计数长期=1 即主控失职（资源依赖型单发要注明排队原因）
- 增量提交接力+每 commit 即 push 分支；主控合并 main 后门禁绿才 push main；任务书落盘 docs/briefs/ 且先入册；绝不 --no-verify；凭据三零
- 端口铁律（升级版）：跑门禁前 `taskkill //IM DevHub.exe //F` 加 `taskkill //IM electron.exe //F`；跑毕恢复常驻+curl 200 并核对 PID/镜像名
- 阻塞上报前必实测；mcp 全量 27/27 在 main 干净树跑（A12 真实语义=断言注册项目主树在 main 且干净，任务分支也会绿——不要误判）

## 1. 当前状态一句话

**C2b 全表重跑判"未达"：两独立缺口根因闭环（①App TLS 信任锚空+叶-only 链→正确指纹也拒；②REST 配对签发绕过 L3 不同步 ECS）→ M3-C6a（本地修：TLS pin 锚化+L3 对齐）/C6b（ECS 修：heartbeat touchHost+重部署）并行中；R-B9 App 错指纹面 PASS、R-B7 按裁定标注、环境零残留。**修复合入后 C2c 复跑→M3-D。

## 2. M3-C4/C2b 战果台账（本会话续）

| 批 | 结果 |
| --- | --- |
| 门禁两红定位（C4a） | **均环境性结案零代码改动**：smoke 全量 worktree 干净环境 168/168×2（167/68 那条=当时 electron 残留）；mcp A05=瞬态（跑时 Docker Desktop 在线致 docker-daemon-unreachable 基线断，主控实测三基线已恢复预判命中，复跑 27/27） |
| 主控终验 | main 干净树全链四门禁全绿（:core 183/0/0 21:11 新鲜 XML 核验）→ **push 973eeb3..7a6260b（24 提交）** |
| dist v3（C4b） | 产物=main 全量；**口径修正：v3 相对 v2 真实增量=C3b fix3 renderer +7 行**（C3a 修复主体在 Android/ECS 侧）；app-update.yml dummy URL 无害 |
| C2b 筹备（C4c） | ECS 预检全绿：**selfcheck 实测 77/77（C3b 增 §11，基线 76→77）**、证书余 89 天、journal 24h 零 error；#34 revoked 留作 R-B8 负面素材不复活不清理；C2b 任务书 m3c2b-app-e2e.md 合入 |
| M3-D 巡检面（C4d） | `scripts/m3d-watch.mjs` 合入（单周期/loop/t0/summary；gateway+relay 腿+公网健康+证书余量+SPKI pin；研究结论：本地无 relay REST 面，host 腿真值=ECS 公网 /v1/health upstream.connected） |
| 清理 | 8 条 agent/* 分支本地+远端全删；worktree 只剩 dist-v3（待清）；10 个陈旧目录顺手清 |
| v3 换装（C5a） | **PASS**：v2 备份 bak-v2-20260906、sha256 逐一比对零差、常驻纯生产形态、网关 200、**relay 自动重连首探即成**（m3d-watch: gateway ok+connected=true+cert 89.3d+pin match）、信任三物在位 |
| C2b 全表重跑 | **未达**：R-B2 FAIL（缺口①TLS 根因四步实验闭环：TlsPinningOkHttp getAcceptedIssuers 空+caddy 叶-only 链→ChainCleaner 无锚）；R-B3/4/5/6 依赖链断未达；R-B7 触发面未实现按裁定标注；R-B8 步骤一等价证据链（#34 明文已销毁）+步骤二依赖断；**R-B9 App 错指纹面 PASS**（结构化拒+不崩=C3a 修2 公网回归过）。缺口②：httpServer.ts:631 REST create 绕 L3 码不到 ECS。另发现#4 ECS last_seen 不随 heartbeat、#5 #34 审计口径注释。**主控 review 否决了子代理"Android 装 CA"修法**（违反 docs/19 §10.2 pin-only 裁决），改裁 pin 锚化 |
| 环境 | 工作站锁屏致 Electron UIA 树不渲染（UI 路径封死，后续需 UI 的批须解锁会话）；evidence 3 截图已合（a8cdbf6）；常驻终态 PID 32240 connected=true（C6a 门禁会杀掉，C2c 拉起） |

## 3. 项目事实基线（main 本地=origin=703980b）

- 门禁基线：tsc 0 / smoke **168**（fast 82）/ mcp **27/27** / :core **183** / ecs-relay test 89 + **selfcheck 77**（ECS 实测）
- ECS：devhub-relay C3b 版 active、caddy 443、SPKI 不变、notAfter **2026-12-04**（余 89 天；≤11-20 双指纹窗口）；relay_hosts 仅 hostId=3 active、relay_devices 仅 #34 revoked
- 桌面常驻：**v3 win-unpacked 运行中**（PID 42740，纯生产形态）；dist 备份链 bak-20260906(v1)/bak-v2-20260906(v2)；信任三物 `%LOCALAPPDATA%\DevHub\relay\`
- APK 新鲜就绪：`android/app/build/outputs/apk/debug/app-debug.apk`（21:11 门禁 gradle 构建，main 全量）
- M3-D 工具：`node scripts/m3d-watch.mjs`（--t0/--loop N/--summary；ndjson 落 `%LOCALAPPDATA%\DevHub\m3d-watch\`）

## 4. ⚠️ 未决项（按序处理）

1. **收割 M3-C6a/C6b 修复批**（并行中）：review diff（C6a 严守 docs/19 §10.2 pin-only 裁决）→ merge 两分支 → main 干净树复跑四门禁 → push
2. **C2c 复跑批**（修复合入后）：重启常驻（C6a 门禁杀掉的）→ R-B2 起全表重跑（判据仍 docs/20 §3；#34 审计断言按 C3b 新语义 DEVICE_REVOKED；新设备新配对码——C6a 修复后 REST 签发即可用，UI 签发需解锁会话；顺带验证 C6b last_seen 活体推进）；任务书基于 m3c2b-app-e2e.md 修订
3. **M3-D 72h 稳定期启动**（C2c 全过后）：重置 t0 → `m3d-watch --loop 15` 起跑
4. 清理尾巴：worktree dist-v3/c2c-fix-local/c2c-fix-ecs（批毕）；gate-fix 目录残留（core.jar 句柄）
5. C2c 若仍有 FAIL → 如实入账 + 派修复批

## 5. 待用户（只排队不代答）

1. **固定管理 IP** → ECS 加固收口（确认密钥可登→禁 root 密码→22 限源→3389 残留）
2. docs/21 追加裁决：离线设备 token_rotation 补投（契约空白；现按 401→重配对，协议扩展需修订 docs/18）
3. docs/21 旧三项（FCM 分期/Kimi 真机/hooks）；delivery 聚合语义
4. 证书轮换日历：**2026-11-20 前启动双指纹窗口**（notAfter 12-04，selfcheck 证书项 <14 天 FAIL 兜底）

## 6. 关键约束速查

28 条合同+docs/11-21+docs/briefs/m3c4*/m3c5a/m3c2b 全套；exec.ts 唯一 spawn；SQL 绑定；migration append-only（ECS schema 0002）；ecs-relay 子目录自含；android 禁挪走；私钥/凭据零入仓库/日志；ECS 零 Agent/零 Key；SSH `~/.ssh/devhub_ecs`（密码勿用）。

## 7. 本段新增踩坑

- `android/local.properties` 被 gitignore——**worktree 跑 gradle 需从主树复制**（仅 sdk.dir 无凭据）；JAVA_HOME=`D:\Apps\JetBrains\IntelliJ IDEA 2026.1\jbr`
- `npm run mcp` 是常驻 server 入口（run-mcp.mjs）；**验收套件是 `node scripts/mcp-acceptance.mjs`**
- A05 类"真实机器基线"断言对环境漂移敏感（Docker Desktop 开关即红）——门禁红先查环境面再查代码面
- gradle `~/.gradle` 缓存跨 worktree 并发有句柄风险（gate-fix 目录 core.jar 至今占用删不掉）——gradle 批次默认互斥
- electron-builder 26 无 publish 配置不生成 latest.yml——解法 `--publish=never -c.publish.provider=generic -c.publish.url=<dummy>`（副作用 app-update.yml 含 dummy URL，无害）
