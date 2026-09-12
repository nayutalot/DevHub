# U2 批任务书：App 体验整改第二批（剩余 P2×5 + P3 可修×6）

> 依据：U-Aud 审计清单 `acceptance/agents-mobile/ux-audit-20260912/AUDIT.md`（已合 main；**条目编号以该文件为准**）。U1 已修 P2#3/4/5/9/10；本批修剩余 P2#1/2/6/7/8 + P3#2/3/4/5/6/7/8。**P3#1（气泡 markdown）不做**——需渲染库选型属产品决策，留独立批。
> 纯 Android 面（android/ 唯一改动域）；桌面零触碰。

## 0. 红线

- 28 条合同；凭据三零；诚实纪律不退步（文案改动不得虚构能力；技术原值可折叠绝不吞码——U1 ErrorPresent 模式）。
- WebView 安全面、relay 帧协议面零触碰。
- 既有单测锁文案/数字逐一核对；新增纯逻辑单测（capabilities 译码映射、子会话状态归一、标题提取）。
- 门禁：`cd android && ./gradlew :app:testDebugUnitTest :core:test :app:assembleDebug`（JAVA_HOME 未设用 `D:/Apps/JetBrains/IntelliJ IDEA 2026.1/jbr`；链尾勿加 --stop）。

## 1. 模块面（串行 commit，每模块对应 AUDIT 条目）

1. **U2-M1 capabilities 卡人话化+头部压缩**（P2#1+P3#7，截图 06/08/24）：
   - 新增译码纯函数（:core，单测锁）：mode/granted/evidence/reason → 用户语言（例：`observed`→「观察模式」；`managed face unconfigured: settings key zcode_managed_model is empty`→「托管未启用：尚未在桌面端填写 ZCode 托管模型」）；译码表穷举现有 evidence/reason 形态（grep provider 代码全集合），未知形态兜底「详见技术信息」。
   - 详情页头部：capabilities 行折叠为一行摘要+ⓘ 弹层（弹层内=人话明细+技术原值折叠区）；provider 原因卡同压缩。目标=头部常态占屏显著缩小（对照 06 号）。
2. **U2-M2 遥控按钮排队态反馈**（P2#2，截图 09）：Queued/失败态点击不再只插一行文案——内联状态行附「重试」按钮（复用既有取链请求路径）+点击主体仍可导航 WebView（手工条目路径已证可用）；状态语义沿用 U1-M4 分层文案。
3. **U2-M3 文案卫生**（P2#6+P2#7+P3#4+P3#5，截图 02/12/13/18/19/20）：
   - helper 文案去「docs/19 §x」章节引用（保留规则本身语义）；
   - relay endpoint placeholder `wss://your-relay-host`（去生产 IP 示例）；
   - 配对/网关页去「模拟器经 10.0.2.2 访问」类模拟器专属说明（通用表述）；
   - BAD_PAYLOAD 等错误码直出收编进 U1 ErrorPresent（码进技术细节，headline 人话）。
4. **U2-M4 子会话面**（P2#8+P3#3，截图 05/23）：
   - 状态归一：查明子会话列表与父列表两套状态映射差异（投影源/判定函数），统一为同一状态机投影（归一纯函数+单测；「未知」仅作真无法判定时的兜底并如实）；
   - 标题提取：子会话标题改为任务语义提取（去系统提示词形态首行——「你是…」开头/含换行的取首个非系统句；纯函数+单测；提取不出如实回退原截断）。
5. **U2-M5 视觉打磨**（P3#2+P3#6+P3#8，截图 02/05/18/19/22）：
   - 诊断页 providers 行：数字 id → catalog displayName（AGENT_PROVIDER_CATALOG）+健康色徽章（health 三态）；
   - 「测试连接」降 outlined（保存并继续唯一主按钮）；
   - 筛选 chips 横向滚动边缘渐隐（falloff 遮罩）。

## 2. 交付

- Worktree：`F:/Active_Project/DevHub-worktrees/u2ux`，分支 `agent/ux-u2-fixes`（自 main 建后先读 AUDIT.md 全文+对应截图文件名核对）。
- 每模块 commit+push（墙期 SOCKS 配方：`ssh -i ~/.ssh/devhub_ecs -D 127.0.0.1:1081 -fN root@59.110.149.11` 后 `git -c http.proxy=socks5h://127.0.0.1:1081 push origin agent/ux-u2-fixes`；bind already in use=已在跑直接用）；绝不 --no-verify。
- 出包：app-debug.apk 复制 `F:/Active_Project/DevHub/dist/DevHub-Android-0.1.0-debug.apk`（记录 sha256+时间戳；dist-cp6 勿碰）。
- 汇报：逐模块 diff+对应 AUDIT 条目号、:app/:core 测试数、APK sha256、push 回执、偏差如实（译码表穷举集合列清单一并汇报供主控复核覆盖率）。
