# UX-P1 批任务书：消费级文案层落地（词表 ~105 条+三态文案+X9+诊断拆分）

> 背景：docs/24 设计规范（UX-R 批，已合 main）获主控裁决通过——§9 五裁决点：①三改名批准（会话→对话/配对→连接/撤销→解绑）②用户面定名**「云端连接」**（docs/24 暂用「云中转」字样随落地一并改；Relay 字样仅技术折叠区保留）③attached ⓘ 归类照规范 ④扫码即连不立项 ⑤我的页层级照规范。本批=**P1 文案层**：纯字符串/文案常量落地，零结构改动（X2 ModeBadge 列表隐藏归 P2）。基线 main=UX-R 合并后 main。

## 0. 工作区与纪律

- worktree：主仓根 `git worktree add worktrees/uxp1-copy -b agent/uxp1-copy main`；`cp /f/Active_Project/DevHub/android/local.properties android/local.properties`；gradle 需 `JAVA_HOME="D:/Apps/JetBrains/IntelliJ IDEA 2026.1/jbr"`。
- 每 commit 即 push 分支（直连优先 socks5h://127.0.0.1:1081 兜底重试循环）；绝不 push main；绝不 --no-verify；凭据三零。
- 资源：gradle 归本批；**模拟器与常驻运行时窗口归并发 RD 复验批**（本批零运行时需求，不 taskkill 任何 DevHub/模拟器）。

## 1. 落地范围（docs/24 §2 词表终稿+docs/25 ★ 项为准）

1. **docs/25 全部 ★ 项（约 105 条）**逐条落地：屏内硬编码字符串+strings.xml+:core 文案常量（InteractionHonesty/CapabilitiesExplain/ErrorPresent 等）——以 docs/24 §2.1 映射表为终稿口径，「云中转」全部作「云端连接」。
2. **常驻通知**（Top1 反人类点）：「Relay · wss://… · 已连接（心跳 30s，服务端 seq…，upstream…）」→「DevHub 运行中 · 已连接电脑」级别人话（数值全部移出通知面，技术值保留在连接帮助技术详情折叠）。
3. **三态可判断性文案**（docs/24 §2.2 矩阵逐格）：还没配对/网络不通/电脑不在线三态互斥文案+动作出口字样落地（状态条/电脑卡/连接帮助）。
4. **X9 401 人话化+diagnosticsSnapshot 拆分**（docs/25 对应条目）：401 错误人话 headline（技术细节折叠保原值）；诊断页 key=value 直出移折叠，常态面给人话行。
5. **指令回执人话**（Top4）：「pause/resume/approve 已接受（commandId=…）」「已入离线队列（幂等）」→「已暂停/已继续/已同意 · 电脑已确认」「电脑不在线，消息会在上线后自动送达」（commandId/幂等字样进折叠）。
6. **唤醒失败文案**（Top2）：「需在 ECS 配置 WAKE_ENABLED=1」→人话（唤醒功能未开启：需在电脑端开启远程唤醒；技术原值进折叠）。
7. **单测期望串联动**：:app/:core 受影响期望逐条更新（语义不回退——「不伪造状态/observed 只读/等待输入·只读」等既有锁定语义只换说法不换判定）。

## 2. 红线（docs/24 §1 七条不可逾越，逐条过）

不伪造状态（离线/降级琥珀态显性保留）；凭据纪律不变；会话门语义不模糊（可以对话/仅查看与 mode 真值一一对应）；协议/字段零改动（endpoint 解析/wss 强制/idempotency 不动）；诚实折叠零吞码（翻译不删除，技术原值全进折叠）；演示模式标注不弱化；**X2 ModeBadge 结构零改动（归 P2）**；导航结构零改动（四标签不动，归 P2）。

## 3. 门禁与产物

- typecheck 0（如涉）+ :app/:core 单测全绿（基线 **146/303**，期望串联动如实）+ `assembleDebug`。
- **新 APK 落 dist**：覆盖 `dist/DevHub-Android-0.1.0-debug.apk` 登记 sha256（dist 根五件/dist-cp6 勿动）。
- 验收自检（代码级）：`grep` 全 :app 用户面无协议词直出（白名单=技术详情折叠区/ⓘ 技术侧/开发者选项内字符串）；三态矩阵文案在位。
- 模拟器目视验证不做（归 P2/P3 后统一走查批）。

## 4. 汇报

commits / 落地条数（★ 实数）/ 门禁计数 / APK sha256 / grep 自检结果（残留白名单外协议词应为 0）/ 偏差如实（docs/25 条目若有落不了地的依赖 P2/P3 项，列清单归 P2/P3）。
