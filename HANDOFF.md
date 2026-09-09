# DevHub 会话交接文档（2026-09-10 04:3x 收口版——前中途态五项已全部执行完毕）

> **✅ 2026-09-10 凌晨会话已把 02:5x 中途态五项全部收口**（详见 §2 台账"凌晨收口会话"行）：
> 1. M3-E1 门禁已跑全绿（tsc 0/fast 98/full 188【首跑 1 例 flake 复跑自愈未定位】/mcp 27/ecs-relay **110**=RW0 11+M3-E1 2 修正口径）；
> 2. LR1 已合 main（33dd0ae，冲突四文件双侧保全，白名单 100→**104**，fast 100/full 190/mcp 27）+ **真库 007 已补**（备份 devhub.db.bak-pre007-20260910-034000；两列+两种子；user_version=8 未动；注：本仓用 node:sqlite 非 better-sqlite3）；
> 3. RW1 已合 main（9eba8ac，Android-only：wake 帧对+submitWakeHost+AgentsScreen 唤醒卡；:core 204/:app 60/assembleDebug 绿）——**待用户真关机 S5 唤醒实测**；
> 4. ECS M3-E1 已部署（0003 表重建 4 行保全+CHECK 七值+relay_meta v3；selfcheck 83+1SKIP×2；亚秒停机；wake 面//etc 物料零触碰；备份 /root/relay-*-preM3E1-20260910-025705.*）；
> 5. **末次重打包+换装完成（04:02 常驻在役）**：asar 四项证据全过（**pdfjs-dist 416 条+napi-canvas 原生件=CP3b PDF 残缺修复兑现**+review/spawn/reminder 标识）；health×3 同 PID 稳定+REST 三面 200+零锁；验证遗留设备 #70 已按 CP1 先例撤销（active 回到恰好在役三台 #46/#52/#53）；
> 6. **卫生批已合 main（aa9dc8e）**：三连幻影事故根治——ac6 系 8746 固定口全改每用例随机口，**真实常驻握 8746 时全量 190/190**（验收真身已过；此后全量门禁常驻在线可跑）。
> ⚠️ **唯一悬置：GitHub push 被网络阻塞**（直连墙+7897 代理进程活但上游隧道坏）——本地 main=aa9dc8e ahead 7 + 分支 agent/smoke-port-hygiene，后台重试循环在推（2h 视野）；网络恢复自动补推，**恢复会话先查 `git status -sb` 是否 ahead 归零**。

## 0. 新会话开工须知（用户令：严格约束工作流）

- **主控只 plan/review/merge + 只读核验；一切执行派 omni-agent，一 Agent 一 Worktree 一任务**——排障任务书必须携带主控已查明的事实链；主控 review 拦截架构偏移（本会话两次实证：否决"CA 入 App"；发现第七缺口 GatewayApi REST TLS）
- **多并发常态 3**：每批派发后主动盘点并行面；资源登记互斥（端口/模拟器/常驻/ECS/gradle 各归一批）；冲突批排队注明原因；同树串行
- 增量提交接力+每 commit 即 push 分支；门禁绿才 push main；任务书落盘 docs/briefs/ 先入册；绝不 --no-verify；凭据三零
- 端口铁律：门禁前双杀 DevHub.exe+electron.exe；毕后常驻由后续批拉起；核对 PID/镜像名
- 阻塞上报前必实测；mcp 27/27 在 main 干净树；门禁链包装命令勿加 `./gradlew --stop`（Windows 退出码 1 假阴性）

## 1. 当前状态一句话

**凌晨收口会话毕其功：main=aa9dc8e（M3-E1+LR1+RW1+卫生批全合，白名单 104，门禁 tsc 0/fast 100/full 190/mcp 27/ecs-relay 110）**；常驻在役=04:02 末次重打包版（**PDF 依赖修复兑现**，health 稳定）；ECS=M3-E1 版（七值 action+selfcheck 83+1SKIP+RW0 wake 面）；真库 schema v8+007 两列已补；三连幻影事故已根治（全量门禁常驻在线可跑）；**唯一悬置=GitHub push 网络阻塞（后台循环重推中）**。RW1 按钮就绪待用户真关机 S5 实测；ContestPin 下一步=CP5 Agent 模式。

## 2. C2c→C2e 修复弧线台账（本会话续）

| 批 | 结果 |
| --- | --- |
| C2c 复跑 | 判部分：4 App 缺口根因（pinner 空洞/baseUrl 不切/轮换帧竞态自毁/指纹 fail-open）；R3 真帧+⑧ 双拒面 PASS |
| C6c 六项+C6d | 全合（8276d3a）：pin-TM 单点信任（pinner 全仓退役）、REST base 模式切换+诚实撤销、pair 腿 rotation 捕获、指纹保存门、watch db 路径、配对码清空；GatewayApi pin-TM+ApiProvider 注入（第七缺口，主控 review 发现）；smoke 169/:app 40 |
| C2d 复跑 | R-B 未全过但三修联验全 PASS+三跨层缺口定位（#10 ECS 投递缺失/#8 host 腿处理器缺/#9 设备自管理协议空白）；TLS pin 面首次真测过 |
| C7a ECS | 投递两腿（pair 窗 5s 冲刷+重连补偿，零新帧）；91→97 测试；孤儿 #2-7 清账；3.1s 停机部署 |
| C7b 桌面 | host 腿三处理器+grace 镜像（migration 006）+error 回程（复用 command_ack，docs/18 空白标注）+App 崩溃包裹+桌面孤儿清账；smoke 172/:app 47 |
| **C2e 终验** | **R-B2/3/4/7/9 PASS + R-B8 协议等价三面 PASS**；R-B3 头号判据过（跨 grace 墙存活）；R-B5 指令门 PASS（70ms 回执）+managed 回流未达（App spawn 走 REST 被拒=契约项）；**R-B6 host 断链闭环 PASS+app-off FAIL（sync 引导死锁=C8a 修中）**；常驻已重打包换装（05:57 main 版，schema v6） |
| C8a | **完成**（4f7c8a8 合并）：RelaySyncEngine 化——§6.1.2 契约引导（hello 必发 sync_request，早退违约修复）+requestId §3.11 强制；:core 183→**189**；R-B6 app-off 活体复验**全过**（fresh 全量回填 0→21792、杀 App→3 夹具事件→重连游标正确→零丢失连续推进至 21834、双侧 ack 落盘、held 清零）；桌面存量 37 行清账（active 仅剩 #46/#52 在役） |
| M3-D 点火 | **T0=09-07 08:49 本地起跑**：巡检 node PID 31300 分离进程 15min 周期、独立 ndjson、首周期四检查全 ok；**12h 定时巡检自动化已建（窗毕自删+自动终报）** |
| 窗内尾巴 W1/W2 | W1 dist 根五件归一（09-07 19:02 构建、常驻零扰动实证同 4 PID/uptime 连续）+dist-v3/gate-fix 清理；W2 docs/18 三处实现层增补注合入（90206f6 纯插入） |
| 用户裁决（09-07 晚） | **#9=B**（复用 WS command 通道补设备自管理+managed spawn，闭环 R-B5/R-B8；**先文档后编码，编码部署等窗毕**）；**GitHub Release 压后**（终报过→B 复验→安装包更新→统一发）；dist-final worktree 留窗毕清 |
| M3-E0 文档批（2c6bfbb 合入） | B 裁决四件套落档：docs/18 §5.3（spawn_session+revoke_device，能力门/终态语义/帧形零扩展/零新 REST 端点）+docs/20 R-B5/R-B8 判据（标"待 M3-E 复验"）+docs/21 §7/§8（裁决原文+硬时序+Release 条件链）+m3e1-self-mgmt.md 实施任务书（**开工前置=M3-D 终报通过；窗内零编码零部署**） |
| **凌晨收口会话（09-10 03:0x-04:3x）** | **五面三波全绿**：①M3-E1 门禁全绿（ecs-relay 口径修正=110）+ECS 部署零回滚（0003 表重建/亚秒停机/selfcheck 83+1SKIP×2）；②LR1 合并 33dd0ae（104 通道/fast 100/full 190/mcp 27）+真库补 007（B1 批）；③RW1 合并 9eba8ac（review 过+独立复跑）+卫生批合并 aa9dc8e（**真实常驻握 8746 全量 190/190=幻影根治验收过**）；④末次重打包 37s+换装 04:02（asar 四项证据：pdfjs 416 条/napi-canvas 原生件/review/spawn/reminder；health×3 同 PID；零锁）；⑤设备账面微清理（#70 撤销+审计，active 恰好三台）。**悬置：push 网络阻塞后台循环重推** |

## 3. 项目事实基线（main=6062cd0 已推；终局门禁 tsc 0/smoke 172/mcp 27/:core **189**/:app 47/ecs-relay 97）

- 门禁基线（终局）：tsc 0 / smoke **172**（fast 83）/ mcp 27/27 / :core **189** / :app **47** / ecs-relay **97** / selfcheck 77(root 口径)
- ECS：C7a 版 active（投递两腿）；证书余 88 天 notAfter 2026-12-04；relay_devices active=win46（在役）+revoked 9
- 桌面常驻：main 桌面全量 win-unpacked（05:57 构建，schema v6）运行中 connected=true（主 PID 39856）；**dist 根五件已归一**（09-07 19:02 构建=W1）；备份链 v1/v2/v3/v4-fe306b9；dist-final worktree 留窗毕清
- 设备账面：ECS win46 active+revoked 9；桌面 active 仅 #46/#52 在役（37 存量行已清账）；配对零孤儿

## 4. ⚠️ 未决项（按序处理）

0. **「赛程钉 ContestPin」比赛模块已立项·开工中**（用户 2026-09-09 指令，当晚新会话已开工）：权威任务书=`docs/briefs/contestpin-charter.md`（逐字原文，32a484c）——八节全规格（管理/多节点/悬浮窗/提醒/两阶段识别/多模态/Agent/备份打包）。**进度（09-09 晚）**：三面只读审计完成 → CP0 文档批已合 main（9067e8e：docs/22 设计书+docs/03 008 预告【007 留 LR1】+docs/04 CP1 通道 70→79 预告+m1 任务书）→ **CP1 数据层批已完成并过主控 review**（agent/contestpin 分支 6 commits 22d023d..5c7395d 已推：008 迁移 7 表+9 通道 79+contestService+fast 用例；主控独立复跑 tsc 0 error+fast 85/85；**合 main 等窗毕全量门禁**）→ **CP2 悬浮窗批已完成并过主控 review**（分支累计至 9ab2752：overlayWire/renderer 比赛视图+OverlayApp/tray checkbox/单实例三处收紧/通道 79→84/fast 88→88 全过；review 发现折叠态重启高度错位已回修 9ab2752）→ **CP3a 识别客户端+配置批派发中**（m3a 任务书 2bc33f7：openaiClient 传输注入/识别配置 KeyCrypto envelope/通道 84→88，零联网 fake transport 测试）。**⚠️ CP1 事故（已闭环，见 §4 条目 2）**：uxa-147 误标 fast 档打真实网关 3 次配对→幻影设备行已撤销+审计落库+ECS 核对干净；档位已归位 fast→full。**✅ 窗毕队列全执行完毕（09-09 深夜）**：M3-D 终报落档（§4.1）→ 幻影设备撤销（§4.2）→ 全量门禁（双杀后 tsc 0/smoke **181/181**/mcp 27/27；android+ecs-relay 对分支零改动免跑有据）→ **CP1+CP2+CP3a 合 main（20b160d）** → 真库 008 迁移（6→8，先备份）→ 打包（21:50）→ 常驻换装（21:51 起）→ 实启动验证：悬浮窗渲染/折叠往返/位置记忆/单实例/openInMain/openLink（Chrome 实开）全过；**发现热修级缺陷**：主窗口同文档 hash 导航不重载（openInMain 落 Dashboard、托盘 #agents 同病）→ hotfix1（4622c0b，App.tsx hashchange 监听）合 main=551ccb2，重打包（22:28）换装复验**直达比赛详情通过**（详情视图节点精度语义 date/exact/tbd 全对）。**遗留用户日常验证项**：拖动/缩放/托盘菜单点击/多显示器拔插/DPI/干净退出（代码路径均已 review）。**✅ CP3b 已完成合 main=8bf1cc1（09-10 01:1x）**：材料导入（sha256 去重/限额）+pdfjs-dist 文本链接+@napi-rs/canvas 页转图（双依赖实测可用零降级）+两阶段管线（逐阶段重试/取消晚到丢弃双守卫/指纹缓存/精度禁提升）+核对界面（字段级来源/相似 diff/两段式）+9 通道 88→97+preload +pathForFile（webUtils，约束 #18 字面偏差已注记——Electron 44 移除 File.path 的官方路径）；门禁 tsc 0/fast 94/**全量 184/184**/mcp 27/27；重打包（**踩坑：GitHub 直连墙时 electron-builder 需 HTTPS_PROXY=http://127.0.0.1:7897**）换装 01:19，常驻 97 通道+悬浮窗 collapsed 恢复正确。**实机待用户**：录入真实识别 API 凭据后走查材料导入/真实识别质量（smoke 全 fake transport，未验真实端点效果）。**ContestPin 下一步=CP4 提醒+通知**（reminderEngine 纯逻辑+notifyWire+补发去重）。**✅ CP4 已收官合 main=d3f82aa（09-10 02:2x）**：due 引擎（date=自然日 09:00 桶/exact=秒桶/done 停扫）+fire_key 账本幂等+48h 补发窗+全仓首个 Notification（notifyWire 注入缝+powerMonitor resume/时钟防御注册）+teardown 最最前 shutdownNotifyWire+3 通道 97→**100**+提醒 UI 三件（铃铛/节点卡编辑器/账本面板）；门禁 tsc 0/fast 96/**全量 186/186**/mcp 27；重打包（挂代理）换装 02:16；**实机验证**：两发 at_time 提醒账本精确触发（60s 桶窗内）+Windows 通知平台登记 com.devhub.app AUMID（toast 管线到达 OS 实证；视觉呈现留用户目视，专注助手抑制按设计降级留账本）；测试节点/规则已清理。month 精度 before_days 跳过+flag（docs/22 §7.1 注记）。**ContestPin 下一步=CP5 Agent 模式**（codex managed 唯一自动候选+导出导入任务包）。

1. ~~**M3-D 72h 观察**~~ ✅ **已终止并落档（2026-09-09 21:00 用户令「观察结束」，提前 ~12h 终止）**：**终报数据：240/240 周期 100% ok、零 malformed、零错误、零网关下线时段、证书余量 86.3 天**；首周期 09-07 08:49:27（T0）、末周期 09-09 20:34 本地（覆盖 ~59.75h/计划 72h；巡检进程与 12h 自动化均已不在=CronList 空、无残留需清）。**判定：稳定性观察通过（全程零故障）→ 解锁 M3-E1/LR1/ContestPin 合并门禁/常驻换装/Release 条件链**（Release 本身仍待用户一句话）。ndjson 留档 `watch-m3d-72h.ndjson`。
2. ~~CP1 幻影设备清理~~ ✅ **已闭环（09-09 21:0x）**：桌面库 uxa-147-phone 三行（#54/55/56=CP1 事故产物）经生产函数 `revokeDevice(id, true)` 撤销（=应用内 agents:deviceRevoke 同路径），审计行 747/748/749（device_revoked/success）落库；**active 账面恢复为恰好在役三台**（#46/#52 模拟器+#53 V2507A 真机，未触碰）；**ECS 侧 relay_devices 核对零 uxa-147 行**（active=2/revoked=8，未受扰动）——双端干净。
2. **#9 裁决后收尾批**：设备自管理通道实现 + App managed spawn 接 WS command face（R-B5 回流/R-B8 UI 面闭环）→ 单面复验（**决策简报已交用户：A admin REST / B WS command 扩权（主控荐）/ C 桌面独占**）
3. ~~dist 根 NSIS 统一~~ ✅ 已毕（W1：根五件=09-07 19:02 构建，常驻零扰动实证；dist-final worktree 留存=产物在 git 外）
4. ~~worktree 尾巴~~ ✅ 已毕（dist-v3 移除+gate-fix 目录句柄释放删除成功）
5. ~~docs/18 增补注入册~~ ✅ 已毕（W2 合入 90206f6：§3.0#16/§3.11/§3.14 三注，纯插入零规范性改动）
6. ~~dist-final worktree 处置~~（窗毕顺手清，见 §4.3）；GitHub Release 发布与否待用户一句话（条件链：M3-D 终报通过 ✅ → M3-E1 B 方案复验 → 安装包已更新 ✅（09-09 22:28 根五件）→ 统一发布）

3. **三线批次完成态（09-10 04:3x 全收口）**：**M3-E1 已完成+门禁+部署全闭环**（main 含之；ECS 在役七值 action）。**LR1 已合并**（33dd0ae：007+四态 envelope+4 通道→白名单 104；真库已补 007 两列）。**RW1 已合并**（9eba8ac：App 唤醒按钮全链——**待用户真关机 S5 实测**，或再跑 ECS /root/wake-verify.mjs）。**卫生批已合并**（aa9dc8e：幻影根治）。**末次重打包已换装**（04:02 在役，PDF 依赖修复兑现）。R-B5/R-B8 活体复验（真 ECS+真机）与 App 安装（assembleDebug APK 在 m3e1 worktree 产出；rw1 worktree 亦有新 APK 含唤醒按钮）留后续批。**CP5（Agent 模式）/CP6（备份打包）= ContestPin 下一步**。
4. **RemoteWake RW 系列（新立项 09-09 深夜，用户令；09-10 用户更正落档）**：手机 App 经 ECS 反向隧道 SSH 到树莓派发 WoL 唤醒 Windows。**✅ 执行层已由用户建成并端到端实测通过**：Pi（用户名=**raspberry**，主机名 Raspberr5；**WiFi 独立上行**，PC 关机隧道存活）的 systemd `wol-tunnel.service` 维持到 ECS `127.0.0.1:2222` 反向转发；ECS `~/.ssh/config` 有 `pi` 别名（127.0.0.1:2222/User raspberry，公钥已在 /home/raspberry/.ssh/authorized_keys）；Pi 侧 `wake-windows` 远端命令发魔术包到 **b0:82:e2:4b:1a:81**（Windows I226-V，S5 魔包唤醒已开）。**RW0 relay 批运行中**（worktrees/rw0，分支 agent/rw0-relay-wake；已按更正简化：执行器 spawn `ssh pi wake-windows`（env WAKE_COMMAND 可覆盖），状态枚举 sent/already_on/exec_failed/timeout/rate_limited/disabled，env 精简为 WAKE_ENABLED/WAKE_COMMAND/WAKE_COOLDOWN_S；帧对 wake_host/wake_result+限速+审计+docs/18 追加）；RW1（App 面）门控 M3-E1 合并。**✅ RW0 已部署并端到端验证（09-10 00:0x，用户「执行」授权链走完）**：合并 main=2fe483e（relay 108/108+root tsc/fast 91）→ ECS 文件同步（备份 relay-backup-preRW0-*.tgz）→ env 3 行 → **服务用户 SSH 物料**（/etc/devhub-relay/{ssh_config,wake_key,wake_known_hosts} 0600 devhub-relay；**踩坑：服务缺 HOME+ProtectHome=yes→ssh 不读 ~/.ssh，必须 -F 绝对路径**；wake_key 公钥经 root 通路装入 Pi）→ WAKE_COMMAND=`ssh -F /etc/devhub-relay/ssh_config pi wake-windows` → **帧验证全过：真实 relay 配对（ecsDeviceId 11）→ already_on 快路径 / 冷却 rate_limited(14995ms) / 桌面离线真实执行 sent(511ms,exit0) / 审计行零敏感物**。测试设备双端已撤销（relay #11+桌面 #66）。**待用户**：真关机 S5 唤醒实测（RW1 App 按钮后从手机触发，或再跑 wake-verify）。

## 5. 裁决与待办（#9/Release 已裁，余下排队不代答）

**已裁（2026-09-07，docs/21 正式入档归 M3-E0 批）**：
- **#9 = B**：复用 WS command 通道补设备自管理+managed spawn，闭环 R-B5/R-B8——先文档（M3-E0 在跑）后编码（**等 M3-D 窗毕**）
- **GitHub Release 压后**：稳定性终报通过 → B 方案复验 → 安装包更新 → 统一发布

**仍待用户**：
1. **固定管理 IP** → ECS 加固收口
2. docs/21：离线设备 token_rotation 补投（docs/18 修订）
3. docs/21 旧三项（FCM/Kimi/hooks/delivery）
4. **证书轮换 2026-11-20 前双指纹窗口**（notAfter 12-04）
5. 物理真机复跑插期（需用户手机）

## 6. 关键约束速查

28 条合同+docs/11-21+docs/briefs/m3c4*~m3c8a 全套；exec.ts 唯一 spawn；SQL 绑定；migration append-only（桌面已到 006/ECS schema 0002）；ecs-relay 自含；android 禁挪走；凭据零入仓/日志；ECS 零 Agent/零 Key；SSH `~/.ssh/devhub_ecs`。

## 7. 踩坑台账（累计有效，新会话必读）

- **门禁包装**：链尾勿加 `./gradlew --stop`（Windows 退出码 1 → 假 FAILED 标记）；:core:test UP-TO-DATE 合法性按类文件哈希判（注释级改动字节码相同→跳过有效）
- **Android TLS**：AOSP 非 Conscrypt TM 清洁返回空链→certificatePinner 空洞拒连——pin-TM 与 pinner 结构性不兼容（pinner 已全仓退役）；自签必须 pin-TM 承载信任锚
- **dist 时间戳纪律**：打包时间戳晚于相关合入；桌面代码改动批后常驻必须换装（Android-only 批不用）
- **模拟器**：offline→plugin 全挂，SDK CLI 重拉配方（HANDOFF 旧版 §7 全文）；后台包装命令被杀连带 qemu；API 35 CA 注入需 zygote nsenter（一次性手段）
- **settings DB=%APPDATA%**\DevHub\devhub.db；adb/eumlator 真身路径 `C:/Users/sakuya/AppData/Local/Android/Sdk/`
- 旧坑仍有效：双杀清单含 electron.exe/PID+镜像名核验/schannel curl 不吃 --cacert/local.properties worktree 复制+JAVA_HOME jbr/mcp-acceptance.mjs 是验收真身/A12=主树语义/gradle 跨 worktree 句柄互斥/electron-builder latest.yml 需 publish 配置/worktree 无 node_modules 先 install
- **【8746 幻影三连（09-09 夜）→ 已根治（09-10 凌晨）】**：smoke 全量档用例曾硬编码 8746 打真实网关→常驻在线时在生产库造幻影配对行（三起均已撤销）——**卫生批 aa9dc8e 已根治**：gwCaseSetup 每用例分配 ephemeral 随机口，~94 处 bind/connect 字面量改走分配口/actualPort（21 用例），缺省值断言 14 行保留；验收=真实常驻握 8746 时全量 190/190。**此后全量门禁常驻在线可跑**（双杀纪律仍推荐但不再是正确性前提）
- **【@electron/get 离线打包假象（09-10 凌晨）】**：electron zip 虽缓存，SHASUMS256.txt 校验件恒 `cacheMode: Bypass`（必联网）——离线打包需 `electronDownload.isVerifyChecksum:false` 或预置 checksums；GitHub 直连墙+7897 代理上游坏时构建会卡死（本批靠直连恢复窗口 37s 完成）
- **【产品网关顺延语义（卫生批实证）】**：fallback 是**固定段 8747..8755**（httpServer.ts GATEWAY_PORT_FALLBACK_RANGE），非相对配置口 +1——用例改造按此对齐
- **【full 档 flake 1 例（09-10 门禁）】**：M3-E1 树首跑 187/188（用例名未捕获，复跑自愈）——后续会话若复现，带完整留档定位
- **【真库操作工具】**：本仓 DB 层=Node v24 内置 `node:sqlite`（DatabaseSync），**非 better-sqlite3**（node_modules 无此包）；进程外脚本走 DEVHUB_HOME/paths.ts 四级策略落 %APPDATA%\DevHub
- **【ECS systemd 硬化（RW0）】**：devhub-relay 服务 ProtectHome=yes/ProtectSystem=strict/ReadWritePaths=/var/lib/devhub-relay 且无 HOME——服务内 ssh 不读 ~/.ssh（别名/密钥/known_hosts 全失效，exit 255 毫秒级）；**解法=/etc/devhub-relay/ 下放 ssh_config+wake_key+wake_known_hosts（0600 devhub-relay）+ `ssh -F` 绝对路径**；root 手测通过≠服务内通过，必须以服务用户+同等沙箱验证
