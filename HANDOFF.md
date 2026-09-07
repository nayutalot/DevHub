# DevHub 会话交接文档（2026-09-07 上午，M3-D 72h 运行中·T0=09-07 08:49:27·终点 09-10 08:49）

> 交接范围：……（前史见 git log/docs/HANDOFF 旧版）→ 四轮联调修复弧线（C2b/C2c/C2d/C2e + C6a-d/C7a/C7b/C8a 共 9 修复批）→ **R-B 表收口至"除用户裁决项外全过" → M3-D 72h 已点火**。**72h 窗内新会话只做巡检（一行命令见 §4.1），勿动常驻/巡检进程/ECS。**

## 0. 新会话开工须知（用户令：严格约束工作流）

- **主控只 plan/review/merge + 只读核验；一切执行派 omni-agent，一 Agent 一 Worktree 一任务**——排障任务书必须携带主控已查明的事实链；主控 review 拦截架构偏移（本会话两次实证：否决"CA 入 App"；发现第七缺口 GatewayApi REST TLS）
- **多并发常态 3**：每批派发后主动盘点并行面；资源登记互斥（端口/模拟器/常驻/ECS/gradle 各归一批）；冲突批排队注明原因；同树串行
- 增量提交接力+每 commit 即 push 分支；门禁绿才 push main；任务书落盘 docs/briefs/ 先入册；绝不 --no-verify；凭据三零
- 端口铁律：门禁前双杀 DevHub.exe+electron.exe；毕后常驻由后续批拉起；核对 PID/镜像名
- 阻塞上报前必实测；mcp 27/27 在 main 干净树；门禁链包装命令勿加 `./gradlew --stop`（Windows 退出码 1 假阴性）

## 1. 当前状态一句话

**M3-D 72h 稳定期运行中（T0=2026-09-07 08:49:27 本地，终点 09-10 08:49）**：巡检进程 node PID 31300（分离，15min 周期）落 `%LOCALAPPDATA%\DevHub\m3d-watch\watch-m3d-72h.ndjson`，首周期四检查全 ok（gateway/relay connected/publicRelay/cert 88.8 天 pin match）；常驻=main 桌面全量包 PID 39856 connected=true；R-B 表 6 PASS+R-B6 app-off 复验全过（C8a）——**残项仅用户裁决项**（R-B5 managed 回流/R-B8 UI 发起面=#9；R-B7 触发面=裁定标注）。

## 2. C2c→C2e 修复弧线台账（本会话续）

| 批 | 结果 |
| --- | --- |
| C2c 复跑 | 判部分：4 App 缺口根因（pinner 空洞/baseUrl 不切/轮换帧竞态自毁/指纹 fail-open）；R3 真帧+⑧ 双拒面 PASS |
| C6c 六项+C6d | 全合（8276d3a）：pin-TM 单点信任（pinner 全仓退役）、REST base 模式切换+诚实撤销、pair 腿 rotation 捕获、指纹保存门、watch db 路径、配对码清空；GatewayApi pin-TM+ApiProvider 注入（第七缺口，主控 review 发现）；smoke 169/:app 40 |
| C2d 复跑 | R-B 未全过但三修联验全 PASS+三跨层缺口定位（#10 ECS 投递缺失/#8 host 腿处理器缺/#9 设备自管理协议空白）；TLS pin 面首次真测过 |
| C7a ECS | 投递两腿（pair 窗 5s 冲刷+重连补偿，零新帧）；91→97 测试；孤儿 #2-7 清账；3.1s 停机部署 |
| C7b 桌面 | host 腿三处理器+grace 镜像（migration 006）+error 回程（复用 command_ack，docs/18 空白标注）+App 崩溃包裹+桌面孤儿清账；smoke 172/:app 47 |
| **C2e 终验** | **R-B2/3/4/7/9 PASS + R-B8 协议等价三面 PASS**；R-B3 头号判据过（跨 grace 墙存活）；R-B5 指令门 PASS（70ms 回执）+managed 回流未达（App spawn 走 REST 被拒=契约项）；**R-B6 host 断链闭环 PASS+app-off FAIL（sync 引导死锁=C8a 修中）**；常驻已重打包换装（05:57 main 版，schema v6） |
| C8a（运行中） | sync 引导死锁修（契约先行 §3.11/§6.3）+R-B6 app-off 单面复验+桌面存量行清账 |

## 3. 项目事实基线（main=93d0d04 已推）

- 门禁基线：tsc 0 / smoke **172**（fast 83）/ mcp 27/27 / :core 183 / :app **47** / ecs-relay **97** / selfcheck 77(root 口径)
- ECS：C7a 版 active（投递两腿）；证书余 88 天 notAfter 2026-12-04；relay_devices active=1（win46 在役）/revoked=9
- 桌面常驻：main 重建 win-unpacked（05:57，含 host 腿+grace 镜像，schema v6）运行中 connected=true；备份链 v1/v2/v3/v4-fe306b9
- 设备账面：ECS win46 active（App Keystore 持有=合法在役）+win47 双侧 revoked；桌面存量 active 行清账归 C8a

## 4. ⚠️ 未决项（按序处理）

1. **M3-D 72h 观察（运行中，至 09-10 08:49）**：巡检一行命令 `node scripts/m3d-watch.mjs --summary "C:\Users\sakuya\AppData\Local\DevHub\m3d-watch\watch-m3d-72h.ndjson"`；**已建 12h 定时巡检自动化（窗毕自删+自动终报）**；巡检进程若随宿主重启丢失，用 Start-Process 同款重拉（**勿带 --t0**）；窗内勿动常驻/ECS/巡检进程/包
2. **#9 裁决后收尾批**：设备自管理通道实现 + App managed spawn 接 WS command face（R-B5 回流/R-B8 UI 面闭环）→ 单面复验（**决策简报已交用户：A admin REST / B WS command 扩权（主控荐）/ C 桌面独占**）
3. ~~dist 根 NSIS 统一~~ ✅ 已毕（W1：根五件=09-07 19:02 构建，常驻零扰动实证；dist-final worktree 留存=产物在 git 外）
4. ~~worktree 尾巴~~ ✅ 已毕（dist-v3 移除+gate-fix 目录句柄释放删除成功）
5. ~~docs/18 增补注入册~~ ✅ 已毕（W2 合入 90206f6：§3.0#16/§3.11/§3.14 三注，纯插入零规范性改动）
6. dist-final worktree 处置（产物已部署根件，worktree 可清——留待 M3-D 窗毕顺手）；GitHub Release 发布与否待用户一句话

## 5. 待用户裁决（只排队不代答）

1. **#9 relay 模式设备自管理协议通道**（docs/18 §7.1 G5 之外：设备列表/自撤销/诊断页端点——ECS admin REST vs WS revoke 命令 vs 桌面独占；连带 App managed spawn 接 WS command face 是否需 §5.1 增补）
2. **固定管理 IP** → ECS 加固收口
3. docs/21：离线设备 token_rotation 补投（docs/18 修订）
4. docs/21 旧三项（FCM/Kimi/hooks/delivery）
5. **证书轮换 2026-11-20 前双指纹窗口**（notAfter 12-04）
6. （建议）M3-D 观察期是否要定时自动巡检唤醒（cron 方案）

## 6. 关键约束速查

28 条合同+docs/11-21+docs/briefs/m3c4*~m3c8a 全套；exec.ts 唯一 spawn；SQL 绑定；migration append-only（桌面已到 006/ECS schema 0002）；ecs-relay 自含；android 禁挪走；凭据零入仓/日志；ECS 零 Agent/零 Key；SSH `~/.ssh/devhub_ecs`。

## 7. 踩坑台账（累计有效，新会话必读）

- **门禁包装**：链尾勿加 `./gradlew --stop`（Windows 退出码 1 → 假 FAILED 标记）；:core:test UP-TO-DATE 合法性按类文件哈希判（注释级改动字节码相同→跳过有效）
- **Android TLS**：AOSP 非 Conscrypt TM 清洁返回空链→certificatePinner 空洞拒连——pin-TM 与 pinner 结构性不兼容（pinner 已全仓退役）；自签必须 pin-TM 承载信任锚
- **dist 时间戳纪律**：打包时间戳晚于相关合入；桌面代码改动批后常驻必须换装（Android-only 批不用）
- **模拟器**：offline→plugin 全挂，SDK CLI 重拉配方（HANDOFF 旧版 §7 全文）；后台包装命令被杀连带 qemu；API 35 CA 注入需 zygote nsenter（一次性手段）
- **settings DB=%APPDATA%**\DevHub\devhub.db；adb/eumlator 真身路径 `C:/Users/sakuya/AppData/Local/Android/Sdk/`
- 旧坑仍有效：双杀清单含 electron.exe/PID+镜像名核验/schannel curl 不吃 --cacert/local.properties worktree 复制+JAVA_HOME jbr/mcp-acceptance.mjs 是验收真身/A12=主树语义/gradle 跨 worktree 句柄互斥/electron-builder latest.yml 需 publish 配置/worktree 无 node_modules 先 install
