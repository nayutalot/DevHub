# UX-P2 批任务书：导航 IA 重排——四标签→三标签（对话/助手/我的）

> 背景：docs/24 §3 IA 规范（主控已裁决通过）+UX-P1 文案层已落地（main）。本批=P2 结构层：底栏四标签（会话/Agents/诊断/设备）→**三标签（对话/助手/我的）**，诊断/设备并入「我的」，状态条→chip，会话列表行重排为微信聊天列表形态，X2 ModeBadge 列表行隐藏。基线 main=UX-P1 合并后 main。

## 0. 工作区与纪律

- worktree：主仓根 `git worktree add worktrees/uxp2-ia -b agent/uxp2-ia main`；`cp /f/Active_Project/DevHub/android/local.properties android/local.properties`；gradle 需 JAVA_HOME jbr。
- 每 commit 即 push 分支（直连优先 socks5h://127.0.0.1:1081 兜底重试循环）；绝不 push main；绝不 --no-verify；凭据三零。
- 资源：gradle 归本批；**模拟器可能被 RD 复验批占用**——本批代码门禁先行，模拟器目视走查排最后（走查前 `adb devices` 探测，被占则 15 分钟重试循环，最多 1 小时，超时如实上报改期）。

## 1. 落地范围（docs/24 §3 线框+docs/26 详案为准）

1. **底栏四→三**：对话｜助手｜我的。原 Agents→「助手」；诊断（DiagnosticsScreen）与设备（DeviceScreen）挂载点移入「我的」页入口；MainTabs 重构。
2. **「我的」页**（新）：电脑连接状态卡（设备名+在线态，点击=诊断页人话化入口）→列表：连接设置/诊断连接问题/唤醒电脑/这台手机/消息提醒/电脑页面管理（remote-manage）/演示模式/**开发者选项折叠**（设备 ID/令牌版本/心跳与 seq/指纹/诊断原文——P1 已人话化的内容原样迁入）。
3. **状态条→chip**：顶部状态 chip 五态（●已连接/◌连接中/↻重试中(第n次)/✕未连接/⚠云端连接已连上，电脑不在线）——点开=电脑连接状态页；P1 三态文案语义原样迁入。
4. **对话列表行重排**（微信聊天列表形态）：助手头像（provider 图标）+标题+最近消息预览+时间+状态角标（waiting/approval 高亮角标=QQ 待办）；provider 过滤 chips 移次级行；**X2**：session_mode 徽章列表行隐藏（详情 ⓘ 保留）；置顶「电脑」卡（ZCode 工作区卡灰底置顶样式）。
5. **助手页微调**：AI 助手卡二态（●可以对话/○仅查看）+「开始对话」主按钮+条件置顶「唤醒电脑」卡（P1 文案原样）。
6. **深链与路由零破坏**：devhub://session/{id}、children/{id}、remote/{id}、remote-manage 全保留；返回栈回归（诊断/设备从底栏移除后，其入口在「我的」内可达）。

## 2. 红线（docs/24 §1 七条+本批专项）

七条不可逾越逐条过；**U1-U5 已修面不得回退**（ErrorPresentation/等待输入·只读/ⓘ 弹层/渐隐/删除确认）；P1 词表文案原样迁入（不回退为协议词）；显式模式选择与 wss 强制纪律不损失；演示模式标注不弱化。

## 3. 门禁与验证

- :app/:core 单测全绿（基线 **146/303**，结构改动涉导航单测如实增改）+ `assembleDebug`。
- 深链/路由回归：既有导航单测矩阵全绿+新增「我的」入口可达断言。
- **模拟器目视走查**（代码门禁后）：三标签可达性（≤2 tap 口径抽验）+四标签移除后无死入口+「我的」页全入口过一遍+对话列表新行形态截图（≥6 张入 acceptance/uxp2-ia-walkthrough/，盘凭据后入册）。
- 新 APK 落 dist（覆盖登记 sha256）。

## 4. 汇报

commits / IA 落地面清单（逐项对照 docs/24 §3）/ 门禁计数 / 深链回归结果 / 走查截图清单 / APK sha256 / 偏差如实。
