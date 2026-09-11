# DevHub Android App 全流程 UX 审计（U-Aud 批）

- 日期：2026-09-12
- 被审物：`dist/DevHub-Android-0.1.0-debug.apk`（sha256 前缀 57d486f7，= android main tip b520f71，含 T1 遥控合并）
- 环境：AVD DevHub_API_35（emulator-5554，1080x2400），桌面常驻 DevHub 在役网关（127.0.0.1:8746 本地模式），App 经 10.0.2.2:8746 完成真实配对（配对码经网关回环 REST `POST /v1/pairing/create` 签发，一次性、已消费、已过期；截图已打码）。
- 方法：UI Automator 走查 + 截图 + 源码比对（只读，零代码改动）。全流程真实 Gateway 数据，未使用夹具演示模式（设置里 demo 入口仅抓到入口本身，见 18 号截图，无 [fixture] 面进入）。
- 证据目录：本目录 01–28 号 PNG（01/03/04/19/20 已对配对码、relay endpoint 打码）。

## 评估总览

| 维度 | 结论 |
|---|---|
| 信息密度与层级 | 会话列表密度好；详情页头部三段横幅（capabilities+provider 卡）占屏过高 |
| 加载/空/错误三态 | 空态（远程工作区）好；错误态普遍直接吐原始错误码/异常（见 P1-3/P2-6） |
| 文案诚实与一致性 | 诚实性优秀（observed/managed/排队/未接入全如实）；但开发者行话大量漏到用户面 |
| 操作步数 | 高频动作（看会话→回看）两步可达；遥控入口三处布局合理 |
| 视觉一致性 | 主体一致；破坏性操作误用主色、中英混排不一致 |
| 可发现性 | T1 工作区卡顶部固定+齿轮管理入口，可发现性好；「打开遥控」无 Ready 时反馈弱 |
| 冗余与重复 | 详情页头部信息与诊断页重复；capabilities 行重复出现于每个详情页 |

---

## P0（阻断/误导）

_无完全阻断级问题。最接近 P0 的是 P1-1（横屏内容空白）与 P1-2（等待输入假可供性），因均有绕行路径（竖屏使用/仅 observed 面），降为 P1，但建议优化批优先处理。_

## P1（严重体验问题，建议本批修）

1. **横屏下会话详情转录区完全空白**
   - 证据：`26-landscape-child-detail.png`（对照竖屏 `24-child-detail.png`、横屏正常的列表 `27-landscape-child-list.png`）
   - 定位：SessionDetailScreen 消息列表区；旋转（Activity 重建）后头部/徽章/横幅/滑杆正常渲染，气泡区持续空白不恢复（等待>4s 仍空）。
   - 建议：旋转重建后按 sessionId 重载消息（或保留 ViewModel 状态+重新触发 load），并检查消息列表在 landscape 的高度/测量逻辑。
   - 改动面：纯 UI 偏逻辑（状态保持/重载），中等。

2. **observed 只读会话挂「等待输入」徽章 = 假可供性**
   - 证据：`05-sessions-list.png`（#766 黄框高亮+等待输入）、`06-session-detail-top.png`（详情无任何 composer/控件）
   - 定位：SessionsScreen 状态徽章 vs SessionDetailScreen 控制门（observed 零控件现状）。列表召唤用户输入，详情页却无任何输入途径，也无解释为何不能输入（Kimi 原因卡只在详情内且未直接回应「等待输入」）。
   - 建议：observed 会话把「等待输入」改为「等待对方输入（本端只读）」类文案，或徽章旁加锁定角标。
   - 改动面：纯 UI。

3. **错误呈现直接吐原始异常/错误码（多屏）**
   - 证据：`20-relay-test-error.png`（「无法连接 Relay（TLS/网络层）：java.net.SocketTimeoutException: failed to connect to /<打码> (port 443) from /10.0.2.15 …」——异常类名+本机内网 IP+端口直出）
   - 定位：GatewayConfigScreen 测试连接错误区；同类模式遍布 DeviceScreen（`[CODE] message` 模板，源码 DeviceScreen.kt:79）与 composer 提交状态（SessionDetailScreen「被拒绝：[code] msg」）。
   - 建议：统一错误文案层：用户面给一句人话+建议动作，原始异常/错误码收进可展开的「技术细节」。
   - 改动面：含逻辑（错误分类映射），中等。

4. **T1「电脑离线」文案误导（Queued 态）**
   - 证据：`05/12/16` 号截图（顶部横幅「已连接·心跳 30s」与卡片「电脑离线：请求已排队」同屏并存）
   - 定位：WorkspaceLinkCardView.Queued 文案（WorkspaceLinkCardView.kt:82）。状态机里 queued:true/发送失败/10s 超时都落 Queued；手机↔网关明明在线，用户读到的却是「电脑离线」，与心跳横幅自相矛盾。实际离线方是桌面侧 ZCode 工作区链路。
   - 建议：改为「桌面 ZCode 链路未就绪：请求已排队，就绪后自动送达」，与心跳横幅语义解耦。
   - 改动面：纯 UI。

5. **通知权限弹窗拒绝后每次冷启动重复弹**
   - 证据：`01-cold-start-first-screen.png`（首装首启）、`16-t1-requesting.png`（拒绝后再次冷启动仍弹）
   - 定位：MainActivity 冷启动权限请求流程；未记录「已拒绝」状态、无前置上下文说明。
   - 建议：拒绝后不再自动弹（或仅再提示一次且给出价值说明「用于会话事件提醒」），改在设置页提供入口。
   - 改动面：含逻辑，小。

## P2（应修，次优先）

1. **详情页 capabilities 行是开发者行话**：`mode=observed granted=[] evidence=managed face unconfigured: settings key zcode_managed_model is empty…(caps stay observed)`——settings key、缩写、英文原句直出（`06/08/24` 号截图）。建议译成用户语言+「为什么」折叠。纯 UI+少量映射逻辑。
2. **「打开 ZCode 遥控」点击无导航只插入一行排队文案**（`09-remote-webview.png`），且该行说「再试」却无重试按钮。建议排队态点击给 toast/内联反馈+立即重试按钮。纯 UI。
3. **远程工作区条目删除无确认/无撤销**（`15-delete-confirm.png`：点垃圾桶即消失）。建议加确认对话框或 5s undo snackbar。纯 UI+小逻辑。
4. **设备页字段名中英混排**：设备名/配对时间（中文）vs status/lastSeen/tokenVersion/deviceId（原始 JSON key）（`17/21` 号截图）。建议全部本地化。纯 UI。
5. **「撤销本设备」用绿色主按钮样式**——破坏性操作视觉上像主推操作（`17` 号）。虽有诚实后果说明，仍建议 error 色系+确认框。纯 UI。
6. **网关配置/Relay 表单 helper 文案引用内部文档**：「docs/19 §11」「docs/19 §7.1」「docs/19 §10.5 属预期」（`19/20` 号）。建议去掉章节号，保留规则本身。纯 UI。
7. **Relay endpoint placeholder 泄示例生产 IP**（已打码，`19/20`）。建议改 `wss://your-relay-host`。纯 UI。
8. **子会话列表状态徽章全为「未知」，父列表同会话却是「已完成」**（`23` vs `05`）——状态映射两套不一致。建议统一状态机投影。含逻辑。
9. **网关配置页无返回按钮**，同 App 其他堆叠页（配对/远程工作区/详情）都有「< 返回」（`18` vs `03/12`）。建议补齐。纯 UI。
10. **relay 模式 GET /v1/devices 的 NOT_FOUND 文案缺口（已知项，抓现状）**：本环境 relay 连接在 TLS 层即失败（未配指纹），NOT_FOUND 现场不可达；代码确认 DeviceScreen 错误面 = `[NOT_FOUND] gateway: no route for …` 原样直出（DeviceScreen.kt:79 模板 + GatewayApi.kt:266）。建议随 P1-3 错误文案层一并处理。含逻辑。

## P3（打磨）

1. 会话气泡 markdown 不渲染：表格竖线、`##` 标题、`**` 加粗原样直出（`06/08`）；行内 code 有芯片样式，渲染不完整更显割裂。建议至少支持标题/加粗/表格。纯 UI+渲染库。
2. 诊断页桌面端 providers 显示为「1/2/3/4」+key=value 串，无 provider 名称、无健康色（`22`）。建议名称+红绿灯徽章。纯 UI。
3. 子会话标题=系统提示词首行截断（「你是 DevHub 项目…」），噪声大（`23`）。建议标题提取规则（如首个任务句）。含逻辑。
4. 配对页/网关配置页说明文案含「模拟器经 10.0.2.2 访问」——模拟器专属说明不应出现在正式文案（`02/18`）。纯 UI。
5. 「仅接受 http(s)://，其余一律拒绝（BAD_PAYLOAD）」暴露错误码（`12/13`）。文案收编进 P1-3 错误层。纯 UI。
6. 保存并继续 / 测试连接两颗等权绿色主按钮，主次不分（`02/18/19`）。测试连接建议降为 outlined。纯 UI。
7. 详情页头部（capabilities 行+provider 原因卡）固定占屏 ~25%，长转录可视区被压缩（`06`）。建议折叠 capabilities 行为 ⓘ 弹层。纯 UI。
8. 会话列表 provider 筛选 chips 横向截断无渐隐提示（第 5 枚只露一角，`05`）。纯 UI。

## 设计决策注记（非缺陷）

- **主题钉死深色**：Theme.kt 注释明确「唯一 scheme 不随系统切换」（D 批决策，浅色下状态栏图标对比失败）。系统切浅色 App 保持深色（`28` 号截图验证）。若未来要跟随系统，需连状态栏样式一起做。
- **T1 卡 Ready/Unavailable 两态本环境不可达**：桌面侧 ZCode 工作区链路离线（Queued 持续），Ready（全屏打开真实工作区）与 Unavailable（结构化错误+重试钮）未能实拍；WebView 全屏路径已用手工条目验证（`14`）。建议优化批在桌面链路就绪时补拍这两态。
- **Codex「启动托管会话」未实点**：会在桌面生成真实托管会话进程，超出本批只读纪律；按钮可发现性本身良好（`10` 号）。

## 走查覆盖对照

| 任务清单项 | 覆盖 | 截图 |
|---|---|---|
| 1 冷启动→首屏 | 已覆盖（未配对→配置页；已配对→直达 Sessions） | 01,16,05 |
| 2 会话详情 | 已覆盖 observed 面（Kimi+ZCode）；managed 面未触发（不启动真实托管会话） | 06,07,08,24,25 |
| 3 Agents 页 | 已覆盖五家卡+两入口+徽章 | 10,11 |
| 4 T1 新面 | Queued 三处实拍；manage 屏+增删条目+WebView 全屏；Ready/Unavailable 环境受限 | 05,09,12,13,14,15,16 |
| 5 设备/网关/配对 | 已覆盖；relay NOT_FOUND 代码级确认+现场受限 | 02,03,04,17,18,19,20,21 |
| 6 诊断/子会话 | 已覆盖 | 22,23,24,25 |
| 7 横竖屏/主题/返回键 | 横屏 P1 抓获；主题=钉死深色（决策）；返回键抽查（WebView→manage、详情→列表）正常 | 26,27,28 |

## 环境与配对说明（零凭据）

- 配对码经桌面网关回环 REST 签发（一次性、TTL 300s、已消费），正文与截图均已打码；设备 Token 仅存模拟器 Keystore，本报告零 token/指纹。
- 桌面常驻进程与 UI 全程未触碰；所有 UI 自动化限于模拟器内。
