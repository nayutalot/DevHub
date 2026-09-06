# DevHub 会话交接文档（2026-09-07 清晨，C2e 终验过·C8a sync 修运行中·M3-D 点火在望）

> 交接范围：……（前史见 git log/docs/HANDOFF 旧版）→ C2c/C2d 两轮未达（共 10 缺口根因闭环）→ C6a-C6d/C7a/C7b 六修复批全合 → **C2e 终验：R-B 表 6 PASS/2 部分（残项=1 新缺陷+用户裁决项）→ C8a（sync 引导死锁修）运行中，过即 M3-D T0**。**新会话从 §4 续接（C8a 在跑先收割）。**

## 0. 新会话开工须知（用户令：严格约束工作流）

- **主控只 plan/review/merge + 只读核验；一切执行派 omni-agent，一 Agent 一 Worktree 一任务**——排障任务书必须携带主控已查明的事实链；主控 review 拦截架构偏移（本会话两次实证：否决"CA 入 App"；发现第七缺口 GatewayApi REST TLS）
- **多并发常态 3**：每批派发后主动盘点并行面；资源登记互斥（端口/模拟器/常驻/ECS/gradle 各归一批）；冲突批排队注明原因；同树串行
- 增量提交接力+每 commit 即 push 分支；门禁绿才 push main；任务书落盘 docs/briefs/ 先入册；绝不 --no-verify；凭据三零
- 端口铁律：门禁前双杀 DevHub.exe+electron.exe；毕后常驻由后续批拉起；核对 PID/镜像名
- 阻塞上报前必实测；mcp 27/27 在 main 干净树；门禁链包装命令勿加 `./gradlew --stop`（Windows 退出码 1 假阴性）

## 1. 当前状态一句话

**C2e 终验里程碑：自毁链断（>300s 跨墙存活 ~18min）、host 腿真数据 200、rotation v2 经 pair 窗冲刷到达 App、command 回执 70ms、host 断链回流 6s、撤销协议等价三面活体（401 DEVICE_REVOKED 新口径）、零孤儿——R-B 表 6 PASS / R-B5 部分（managed spawn=契约项）/ R-B6 部分（app-off=新缺陷 C8a 修中）/ R-B8 UI 面（#9 用户裁决）。C8a 过 → M3-D T0。**

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

1. **收割 C8a**（运行中，任务书 m3c8a-sync-bootstrap.md）→ review（契约结论重点核）→ merge → main 门禁 → push
2. **M3-D T0 点火**（C8a 过后）：重置 t0（%LOCALAPPDATA%\DevHub\m3d-watch\t0.txt）→ 分离进程起 `node scripts/m3d-watch.mjs --loop 15`（日志仓外 ndjson）→ 首周期入档确认 → 72h 窗（至 ~09-10 同时刻）；期间各会话用 `--summary` 巡检；**判据面**=gateway/relay/publicRelay/cert 全 ok 率、网关 down 时段、journal error（--deep）
3. dist 根 NSIS 统一（现 win-unpacked=main 版、NSIS 仍 v3——收尾批一次 electron-builder 全套）
4. worktree 清理尾巴：dist-v3（detached 旧基线）、gate-fix 目录残留（core.jar 句柄）
5. docs 增补批（择机）：docs/18 §3.14 轮换投递两腿语义 + §3.11 sync 引导（C8a 结论）+ §3.0 #16 error 回程——均已有 KDoc 标注，正式入册待修符合并

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
