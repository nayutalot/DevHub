# DevHub 会话交接文档（2026-09-06 深夜，M3-C4 收官线·C2b 运行中）

> 交接范围：……（前史见 git log/docs/HANDOFF 旧版）→ M3-C3a/C3b 合并 → **M3-C4 批：两红环境性结案+四门禁全绿+push main+八分支清理+v3 常驻上线 connected=true**。**新会话从 §4 未决项续接（C2b 代理在跑则先收割其汇报）。**

## 0. 新会话开工须知（用户令：严格约束工作流）

- **主控只 plan/review/merge + 只读核验；一切执行（写码/改测试/部署/排障/UI 驱动/重打包）派 omni-agent，一 Agent 一 Worktree 一任务**——排障任务书必须携带主控已查明的事实链
- **多并发是默认形态**：每批派发后主控主动盘点可并行面凑满（常态 3 个子代理同时跑）；派发前按机器资源登记核对互斥（端口/模拟器/常驻/ECS/gradle 缓存各归一批），冲突批排队注明"待 X 合入后再派"；同树/同文件批次必须串行；运行中计数长期=1 即主控失职（资源依赖型单发要注明排队原因）
- 增量提交接力+每 commit 即 push 分支；主控合并 main 后门禁绿才 push main；任务书落盘 docs/briefs/ 且先入册；绝不 --no-verify；凭据三零
- 端口铁律（升级版）：跑门禁前 `taskkill //IM DevHub.exe //F` 加 `taskkill //IM electron.exe //F`；跑毕恢复常驻+curl 200 并核对 PID/镜像名
- 阻塞上报前必实测；mcp 全量 27/27 在 main 干净树跑（A12 真实语义=断言注册项目主树在 main 且干净，任务分支也会绿——不要误判）

## 1. 当前状态一句话

**四门禁权威全绿（tsc 0/smoke 168/mcp 27/gradle :core 183）已 push（origin=7a6260b）、八分支全清、v3 常驻上线 relay 自动重连 connected=true——C2b 全表重跑（App 真实公网入网 R-B2..R-B8+R3+TLS 拒面）代理运行中，全过即启 M3-D 72h。**

## 2. M3-C4 战果台账（本会话）

| 批 | 结果 |
| --- | --- |
| 门禁两红定位（C4a） | **均环境性结案零代码改动**：smoke 全量 worktree 干净环境 168/168×2（167/68 那条=当时 electron 残留）；mcp A05=瞬态（跑时 Docker Desktop 在线致 docker-daemon-unreachable 基线断，主控实测三基线已恢复预判命中，复跑 27/27） |
| 主控终验 | main 干净树全链四门禁全绿（:core 183/0/0 21:11 新鲜 XML 核验）→ **push 973eeb3..7a6260b（24 提交）** |
| dist v3（C4b） | 产物=main 全量；**口径修正：v3 相对 v2 真实增量=C3b fix3 renderer +7 行**（C3a 修复主体在 Android/ECS 侧）；app-update.yml dummy URL 无害 |
| C2b 筹备（C4c） | ECS 预检全绿：**selfcheck 实测 77/77（C3b 增 §11，基线 76→77）**、证书余 89 天、journal 24h 零 error；#34 revoked 留作 R-B8 负面素材不复活不清理；C2b 任务书 m3c2b-app-e2e.md 合入 |
| M3-D 巡检面（C4d） | `scripts/m3d-watch.mjs` 合入（单周期/loop/t0/summary；gateway+relay 腿+公网健康+证书余量+SPKI pin；研究结论：本地无 relay REST 面，host 腿真值=ECS 公网 /v1/health upstream.connected） |
| 清理 | 8 条 agent/* 分支本地+远端全删；worktree 只剩 dist-v3（待清）；10 个陈旧目录顺手清 |
| v3 换装（C5a） | **PASS**：v2 备份 bak-v2-20260906、sha256 逐一比对零差、常驻 PID 42740 纯生产形态（无 debug port）、网关 200、**relay 自动重连首探即成**（m3d-watch: gateway ok+connected=true+cert 89.3d+pin match）、信任三物在位 |

## 3. 项目事实基线（main 本地=origin=7a6260b）

- 门禁基线：tsc 0 / smoke **168**（fast 82）/ mcp **27/27** / :core **183** / ecs-relay test 89 + **selfcheck 77**（ECS 实测）
- ECS：devhub-relay C3b 版 active、caddy 443、SPKI 不变、notAfter **2026-12-04**（余 89 天；≤11-20 双指纹窗口）；relay_hosts 仅 hostId=3 active、relay_devices 仅 #34 revoked
- 桌面常驻：**v3 win-unpacked 运行中**（PID 42740，纯生产形态）；dist 备份链 bak-20260906(v1)/bak-v2-20260906(v2)；信任三物 `%LOCALAPPDATA%\DevHub\relay\`
- APK 新鲜就绪：`android/app/build/outputs/apk/debug/app-debug.apk`（21:11 门禁 gradle 构建，main 全量）
- M3-D 工具：`node scripts/m3d-watch.mjs`（--t0/--loop N/--summary；ndjson 落 `%LOCALAPPDATA%\DevHub\m3d-watch\`）

## 4. ⚠️ 未决项（按序处理）

1. **C2b 全表重跑收割**（代理运行中）：逐条 R-B 表四分类汇报→evidence 分支 agent/m3c2b-evidence 合入；发现的问题清单→修复批
2. **M3-D 72h 稳定期启动**（C2b 全过后）：重置 t0（现 t0.txt 为 D 批测试值）→ `--loop 15` 起跑 → 巡检节奏/中断判据按 docs/21 裁决
3. 清理尾巴：worktree dist-v3（C2b 后可清）；gate-fix 目录残留（core.jar 句柄，git 已注销纯磁盘）
4. C2b 修复项（若 R-B 表有 FAIL）→ 派修复批 → 复跑该条

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
