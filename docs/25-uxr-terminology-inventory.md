# 25 — UX-R 交付一：全量术语与文案清点（人话词表）

> 批次：UX-R（docs/briefs/uxr-design.md §1）。基线 main=de60406（KC 合并后，U-Aud/U1-U5 已修面在位）。
> 方法：逐屏扫 :app 全部 Compose 屏 + 共享组件 + 通知 + 错误呈现层 + 经由 :app 直显的 :core 文案常量（strings.xml 仅 3 条，其余为硬编码字符串）。只读码+既有截图（acceptance/agents-mobile/ux-audit-20260912/ 28 张、acceptance/mobile-chat-relay-e2e/shots/ 14 张），零编码零模拟器。
> 凭据纪律：本清点零 token/零指纹值；凡涉 key/令牌/指纹字样只记录位置不录值。
> 配套：IA 提案=docs/26-uxr-ia-interaction-proposal.md；设计规范=docs/24-mobile-ux-redesign.md。

## 0. 问题定性图例

| 标记 | 含义 |
|---|---|
| 【协议】 | 协议词/字段名泄漏到用户面（Relay/心跳/granted/commandId/SPKI/gateway…） |
| 【码】 | 英文状态码/异常类名直出（timeout、[AUTH_INVALID_TOKEN]、NullPointerException…） |
| 【内部】 | 内部工程语/纪律语外泄（夹具、不排队不伪成功、监控管线、批次号、本地防抖…） |
| 【直译】 | 英文词直接作中文 UI 词（Agents、provider、endpoint、stale、remote） |
| 【无引导】 | 空态/错误态只陈述事实，无下一步动作 |
| 【密度】 | 单条文案术语密度过高，普通用户不可读 |
| 【保留】 | 现文已合格或属产品名，词表锁定为终稿 |

改动优先级：★=P1 文案层即可改（改词即生效）；☆=依赖 IA/流程（P2/P3 承载）。

---

## 1. 主框架与连接状态条（MainTabs.kt）

| # | 现文 | 位置 | 定性 | 人话提案 |
|---|---|---|---|---|
| M1 | 会话（底栏 tab） | MainTabs.kt:69-70 | 【保留】 | 对话（与微信用词一致；提案见 docs/26 §3） |
| M2 | Agents（底栏 tab） | MainTabs.kt:75-76 | 【直译】★ | 助手 |
| M3 | 诊断（底栏 tab） | MainTabs.kt:82-83 | 【内部】【无引导】☆ | 并入「我的 → 连接帮助」（P2 IA；P1 期保留原 tab 不动） |
| M4 | 设备（底栏 tab） | MainTabs.kt:88-89 | 【内部】☆ | 并入「我的」（P2 IA） |
| M5 | Relay 已连接，电脑离线（命令将排队） | MainTabs.kt:133 | 【协议】【密度】★ | 已连上云中转，但电脑不在线——消息会在电脑上线后自动送达 |
| M6 | Relay 已连接 · 心跳 {n}s | MainTabs.kt:136 | 【协议】（心跳）★ | 已连接（云中转）；心跳数值移出常态（进诊断高级区） |
| M7 | 已连接 · 心跳 {n}s | MainTabs.kt:138 | 【协议】（心跳）★ | 已连接 |
| M8 | 连接中… | MainTabs.kt:141 | 【保留】 | 连接中… |
| M9 | 退避重连（第 {n} 次，{x}s 后） | MainTabs.kt:143 | 【协议】（退避=backoff）★ | 连接断开了，正在自动重试（第 {n} 次，约 {x} 秒后） |
| M10 | 未配对 | MainTabs.kt:144 | 【直译】【无引导】★ | 还没连接电脑（附「去连接」动作，直达连接流程） |
| M11 | 未启动 | MainTabs.kt:145 | 【内部】★ | 未连接（附「去连接」动作；Idle 语义对用户只应是「未连接」） |
| M12 | 网关配置（状态条右侧入口） | MainTabs.kt:155 | 【协议】（网关）★ | 连接设置 |

## 2. AI 助手页（AgentsScreen.kt）+ 文案常量（core/InteractionHonesty.kt）

| # | 现文 | 位置 | 定性 | 人话提案 |
|---|---|---|---|---|
| A1 | Agents（页标题） | AgentsScreen.kt:116 | 【直译】★ | AI 助手 |
| A2 | 发生未知错误：请重试（{异常类名}） | AgentsScreen.kt:108 | 【码】★ | 出了点问题，请重试（类名进「技术细节」折叠） |
| A3 | 加载失败：$error（错误对象直出） | AgentsScreen.kt:123 | 【码】【无引导】★ | 统一走 ErrorPresentation（人话+技术细节折叠），附「重试」 |
| A4 | 暂无 provider 投影 | AgentsScreen.kt:124 | 【协议】【内部】【无引导】★ | 空态：还没有发现 AI 助手。请确认电脑上 DevHub 正在运行；连接正常后点「重新扫描」 |
| A5 | 唤醒 Windows（按钮） | AgentsScreen.kt:219-227 | 【直译】★ | 唤醒电脑 |
| A6 | 冷却中 {n}s（按钮态） | AgentsScreen.kt:222 | 【内部】★ | 请等 {n}s |
| A7 | 未连接：唤醒仅在 Relay 已连接时可用（不排队、不伪成功） | AgentsScreen.kt:203,241 | 【协议】【内部】★ | 还没连上电脑，无法唤醒；先在「我的 → 连接设置」检查连接 |
| A8 | 唤醒超时（timeout）：15s 内未完成，可稍后重试 | AgentsScreen.kt:207,272 | 【码】★ | 唤醒超时：电脑没响应，稍后可再试 |
| A9 | 冷却中：{n}s 后可再试（本地防抖，以 relay 实际判定为准） | AgentsScreen.kt:248 | 【内部】【协议】★ | 操作太频繁：{n} 秒后可再试 |
| A10 | 唤醒指令已发出（sent，{ms}ms）。「已发出」≠「已开机」，以主机实际状态为准 | AgentsScreen.kt:260 | 【码】【内部】★ | 唤醒指令已发出，电脑开机需要一点时间；是否上线以「我的 → 电脑状态」为准 |
| A11 | Windows 已在线（already_on），无需唤醒 | AgentsScreen.kt:262 | 【码】★ | 电脑已经在线，不用唤醒 |
| A12 | Relay 冷却窗拒绝（rate_limited）：需 {x}s 后重试 | AgentsScreen.kt:264-265 | 【协议】【码】★ | 操作太频繁：请 {x} 秒后再试 |
| A13 | Relay 未启用唤醒功能（disabled）：需在 ECS 配置 WAKE_ENABLED=1 | AgentsScreen.kt:267 | 【协议】【内部】★（最严重级） | 远程唤醒功能未开启：需要在服务器设置中打开（操作方法见帮助）；WAKE_ENABLED=1/ECS 收进技术细节 |
| A14 | 唤醒执行失败（exec_failed）：{stderr 摘要} | AgentsScreen.kt:270 | 【码】★ | 唤醒失败：这台电脑可能不支持远程开机（技术摘要进折叠） |
| A15 | granted: reply / pause / resume | AgentsScreen.kt:318 | 【协议】★ | 可执行：回复、暂停、恢复（走 core.CapabilitiesExplain.grantedLabel） |
| A16 | 已启动（commandId={id}） | AgentsScreen.kt:390,417 | 【协议】★ | 对话已创建（commandId 进技术细节） |
| A17 | 已受理（{status}，commandId={id}）；会话列表稍后出现新会话 | AgentsScreen.kt:394,419 | 【协议】【直译】★ | 已提交：对话创建中，稍后在「对话」列表出现 |
| A18 | 已排队（电脑离线）：连接恢复后自动启动 | AgentsScreen.kt:397 | 【保留】（已人话；微调） | 电脑不在线：已暂存你的请求，它上线后自动开始 |
| A19 | 启动被拒绝：[{code}] {msg} | AgentsScreen.kt:422 | 【码】★ | 见 H19 拒绝文案表（人话头+码折叠） |
| A20 | 网络不可达，未启动 | AgentsScreen.kt:424 | 【无引导】★ | 网络不可用：对话没有创建，请检查网络后再试 |
| A21 | 启动异常：请重试（{类名}） | AgentsScreen.kt:429 | 【码】★ | 启动出了问题，请重试（类名进折叠） |
| A22 | 演示数据（夹具）：此页能力展示仅示意，控制动作不可用 | AgentsScreen.kt:452 | 【内部】★ | 演示模式：这里是示例数据，按钮不可操作 |
| H1 | 托管会话可交互；外部会话只读 | InteractionHonesty.kt:20 | 【协议】（托管/外部会话）★ | 你发起的对话可以回复/暂停/恢复；电脑上自己开的对话只能看 |
| H2 | 启动托管会话（按钮） | InteractionHonesty.kt:23 | 【协议】★ | 开始对话（spawn→新建对话 映射，任务书 §1） |
| H3 | 确认启动 | InteractionHonesty.kt:24 | 【保留】微调 | 开始 |
| H4 | 托管任务（将作为首条消息发给 Agent） | InteractionHonesty.kt:26 | 【协议】【直译】★ | 想让它先做什么？（会作为第一条消息发出） |
| H5 | 启动中… | InteractionHonesty.kt:27 | 【保留】微调 | 正在创建… |
| H6 | observed 会话：纯观察模式，不提供任何远程控制（服务端亦全禁）。 | InteractionHonesty.kt:30 | 【协议】★ | 这个对话只能查看：手机端不能操作，请在电脑上操作 |
| H7 | 无控制能力 | InteractionHonesty.kt:33 | 【密度】★ | 仅查看 |
| H8 | 等待输入 · 只读 | InteractionHonesty.kt:44 | 【保留】微调 | 等电脑回复 · 本机只读 |
| H9 | 转录只读，无输入通道：「等待输入」指该会话正在等待桌面端输入；本端仅观察，请到桌面侧回复。 | InteractionHonesty.kt:51 | 【协议】（转录）★ | 「等待输入」是说电脑那头在等人输入；这台手机只能看，请在电脑上回复 |
| H10 | 打开 ZCode 遥控 | InteractionHonesty.kt:70 | 【直译】（遥控）★ | 在电脑上打开 ZCode 页面 |
| H11 | 打开遥控 | InteractionHonesty.kt:71 | 【直译】★ | 打开电脑页面 |
| H12 | 转录只读 · 控制经 ZCode 遥控页 | InteractionHonesty.kt:72 | 【协议】（转录）★ | 这里只能看内容 · 操作要去 ZCode 页面 |
| H13 | 控制经 ZCode 遥控页（ZCode 自家认证） | InteractionHonesty.kt:73 | 【内部】★ | 操作会跳到 ZCode 自己的登录页 |
| H14 | 正在获取 ZCode 遥控链接… | InteractionHonesty.kt:74 | 【保留】微调 | 正在获取电脑页面… |
| H15 | ZCode：官方未提供控制通道，DevHub 只能观察，回复/暂停/恢复不可用。 | InteractionHonesty.kt:107 | 【协议】（控制通道）★ | ZCode：官方还没有开放手机控制，只能查看 |
| H16 | Claude Code：hooks 无输入注入 API，回复（reply）无可验证执行路径，当前只读观察。 | InteractionHonesty.kt:110 | 【协议】【密度】★ | Claude Code：暂无可靠的手机回复通道，只能查看 |
| H17 | Kimi：托管通道已实现但真机授权验证留待用户裁决，当前只读观察。 | InteractionHonesty.kt:113 | 【内部】★ | Kimi：手机控制功能已开发但尚未开通，暂时只能查看 |
| H18 | DeepSeek Harness：未接入（无可验证会话/控制接口），无会话数据源。 | InteractionHonesty.kt:116 | 【协议】【密度】★ | DeepSeek：还没接入手机端 |
| H19 | 启动被拒绝：该 provider 无托管通道或并发已达上限（SPAWN_REJECTED）/ 该 provider 未授予 managed 能力（COMMAND_NOT_EXECUTABLE）/ provider 能力未验证或已过期…（AGENT_CAPABILITY_MISSING）/ 启动被拒绝 [{code}] {raw} | InteractionHonesty.kt:143-153 | 【协议】【码】★ | ① 创建失败：这个助手的对话通道不可用或数量已达上限；② 创建失败：该助手暂不支持在手机上开始对话；③ 创建失败：助手状态未验证，请先在电脑端刷新；④ 创建失败（原码进「技术细节」） |

## 3. 对话列表（SessionsScreen.kt，现「会话」）

| # | 现文 | 位置 | 定性 | 人话提案 |
|---|---|---|---|---|
| S1 | 会话（页标题） | SessionsScreen.kt:185 | 【保留】微调 | 对话 |
| S2 | 演示数据·开 / 演示数据·关 | SessionsScreen.kt:190 | 【内部】★ | 演示模式（开关） |
| S3 | 演示数据（夹具）· 非真实 Gateway — 端到端验收归批次 C | SessionsScreen.kt:210 | 【内部】【协议】（批次号外泄）★ | 演示模式：显示的是示例数据，不是你的电脑 |
| S4 | 显示归档 | SessionsScreen.kt:283 | 【保留】微调 | 显示已归档 |
| S5 | 暂无会话（监控管线未产生会话或 Gateway 未连接） | SessionsScreen.kt:302 | 【协议】【内部】【无引导】★ | 空态：这里会显示电脑上的 AI 对话。还没有内容——① 确认电脑在线（看顶部状态）② 到「助手」开始第一个对话 |
| S6 | provider #{n}（回退名） | SessionsScreen.kt:373 | 【协议】【直译】★ | 未知助手 |
| S7 | 数据过期（stale） | SessionsScreen.kt:416 | 【直译】★ | 信息可能不是最新 |
| S8 | 归档失败/取消归档失败/删除失败：{原始 message} | SessionsScreen.kt:314,321,347 | 【码】【无引导】★ | 归档没成功，请重试 / 删除没成功，请重试（原 message 进折叠） |
| S9 | 删除（仅移除 DevHub 记录）（长按菜单） | SessionsScreen.kt:443 | 【保留】 | 删除（仅移除手机里的记录） |
| S10 | 「{title}」将从 DevHub 中删除：仅移除 DevHub 记录，不会改动你电脑上的任何源文件。此操作不可撤销。 | core/SessionListOps.kt:29-30 | 【保留】（U-Aud 后已合格） | 终稿锁定；微调「DevHub 记录」→「手机里的记录」 |

## 4. 对话详情（SessionDetailScreen.kt）

| # | 现文 | 位置 | 定性 | 人话提案 |
|---|---|---|---|---|
| D1 | 会话 #{n}（回退标题） | SessionDetailScreen.kt:246 | 【保留】微调 | 未命名对话 |
| D2 | 演示数据（夹具）· 非真实 Gateway — 端到端验收归批次 C | SessionDetailScreen.kt:256 | 【内部】【协议】★ | 同 S3 |
| D3 | 数据过期（stale） | SessionDetailScreen.kt:284 | 【直译】★ | 同 S7 |
| D4 | ⓘ 能力说明 | SessionDetailScreen.kt:305 | 【密度】★ | ⓘ 这台手机能做什么 |
| D5 | 🤖 子智能体会话 ({n}) | SessionDetailScreen.kt:321 | 【协议】（子智能体）★ | 🤖 子任务 ({n}) |
| D6 | 点入查看层级与状态 ▸ | SessionDetailScreen.kt:328 | 【保留】微调 | 查看 ▸ |
| D7 | 回复（≤4000 字符）（输入框 label） | SessionDetailScreen.kt:384 | 【内部】★ | 输入消息…（仅当接近 4000 上限时显示剩余计数） |
| D8 | 已接受（commandId={id}） | SessionDetailScreen.kt:402 | 【协议】★ | 已发送 |
| D9 | 当前离线：已入离线队列，重连后自动补发（幂等） | SessionDetailScreen.kt:404 | 【内部】（幂等）★ | 当前断线：消息已暂存，恢复连接后自动发送 |
| D10 | pause 已接受（commandId=…） | SessionDetailScreen.kt:434 | 【码】【协议】★ | 已暂停（指令已发送） |
| D11 | 当前离线：pause 已入离线队列 | SessionDetailScreen.kt:435 | 【码】【内部】★ | 断线中：暂停指令已暂存，恢复后自动发送 |
| D12 | resume 已接受（commandId=…） | SessionDetailScreen.kt:458 | 【码】【协议】★ | 已恢复 |
| D13 | 当前离线：resume 已入离线队列 | SessionDetailScreen.kt:459 | 【码】【内部】★ | 断线中：恢复指令已暂存 |
| D14 | approve 已接受（commandId=…） | SessionDetailScreen.kt:485 | 【码】【协议】★ | 已批准 |
| D15 | 当前离线：approve 已入离线队列 | SessionDetailScreen.kt:486 | 【码】【内部】★ | 断线中：批准指令已暂存 |
| D16 | interrupt 已接受（commandId=…） | SessionDetailScreen.kt:510 | 【码】【协议】★ | 已中断 |
| D17 | 当前离线：interrupt 已入离线队列 | SessionDetailScreen.kt:511 | 【码】【内部】★ | 断线中：中断指令已暂存 |
| D18 | ⏬ 跳到最新 | SessionDetailScreen.kt:583 | 【保留】 | 终稿锁定 |
| D19 | 更早…（释放自动翻页）/ 更早…（加载中） | SessionDetailScreen.kt:696-698 | 【内部】★ | 松手查看更早消息 / 正在加载更早消息… |
| D20 | 最新 / 最旧（滑条两端） | SessionDetailScreen.kt:715,733 | 【保留】微调 | 最新 / 最早 |
| D21 | 接入能力（ⓘ 弹层标题） | SessionDetailScreen.kt:631 | 【密度】★ | 这台手机能做什么 |
| D22 | 接入深度：{托管接入/已挂接（hooks）/观察模式（只读）} | SessionDetailScreen.kt:634 + core/CapabilitiesExplain.kt:35-39 | 【协议】（hooks）★ | 连接方式：可以对话（managed）/ 电脑上接入（attached）/ 仅查看（observed）/ 状态未知；主显示面二态化「可以对话/仅查看」，细节进弹层（任务书 §1 capabilities 映射） |
| D23 | mode=… granted=[…] evidence=…（技术信息折叠区） | SessionDetailScreen.kt:659-661 | 【保留】（U2-M1 产物：技术原值折叠承载） | 终稿锁定：折叠区内原样保留 |

## 5. 连接电脑（PairingScreen.kt，现「配对」）

| # | 现文 | 位置 | 定性 | 人话提案 |
|---|---|---|---|---|
| P1 | 配对设备（页标题） | PairingScreen.kt:88 | 【保留】微调☆ | 连接电脑（消费级词；「配对」术语保留为二级表述） |
| P2 | 桌面 DevHub → Agents 视图 →「配对新设备」会签发 8 位一次性配对码（TTL 300s）。输入码即可配对（码即唯一定位）；码即用即废；claim 限流：同源 5 次 / 5 分钟。 | PairingScreen.kt:90-92 | 【协议】【密度】★ | 在电脑的 DevHub 上点「配对新设备」，会显示一个 8 位配对码（5 分钟内有效，用过即废）。在下面输入它即可连接；输错多次会暂时锁定 |
| P3 | 当前模式：Relay（配对经 wss 加密直连中继服务器）/ 当前模式：本地（REST claim → 桌面 Gateway） | PairingScreen.kt:95-96 | 【协议】【密度】★ | 连接方式：云中转（电脑不在身边也能用）/ 同一网络直连（手机和电脑连同一个 Wi-Fi） |
| P4 | 8 位配对码（Crockford Base32）（输入框 label） | PairingScreen.kt:104 | 【协议】★ | 输入 8 位配对码 |
| P5 | 设备名：{型号}（platform: android） | PairingScreen.kt:108 | 【码】★ | 手机名：{型号} |
| P6 | 高级选项（pairingId，通常无需填写） | PairingScreen.kt:113 | 【保留】微调 | 高级选项（通常无需填写） |
| P7 | 配对标识 pairingId（可选，如 pair-xxxxxxxx；须与活跃码精确匹配） | PairingScreen.kt:119 | 【保留】（折叠内技术原文） | 终稿锁定：折叠区内保留 |
| P8 | 配对失败：码无效/已过期/已被使用（一次性）[AUTH_INVALID_TOKEN] | PairingScreen.kt:196 | 【码】★ | 配对失败：码不对、已过期或已被使用——请在电脑上重新生成（码进折叠） |
| P9 | 尝试过于频繁（5 次/5 分钟），请 {x}s 后重试 [AUTH_RATE_LIMITED] | PairingScreen.kt:198 | 【码】★ | 尝试太频繁：请 {x} 秒后再试 |
| P10 | 桌面 Gateway 未启用（gateway_enabled=0）[GATEWAY_DISABLED] | PairingScreen.kt:200 | 【协议】【码】★ | 电脑上的 DevHub 没有打开「允许手机连接」开关，请到电脑端设置打开后重试 |
| P11 | 无法连接 Gateway：请先在「Gateway 配置」页测试连接 | PairingScreen.kt:205 | 【协议】★ | 连不上电脑：请先在「连接设置」里测试连接 |
| P12 | 配对异常：{message} | PairingScreen.kt:208 | 【码】★ | 配对出了问题，请重试（原 message 进折叠） |
| P13 | 安全须知四条（Keystore AES-GCM / WS 断开按 sequence 补齐 / reply·pause·resume） | PairingScreen.kt:237-241 | 【协议】【密度】★ | 人话重写保留四事实：①钥匙只存这台手机的加密存储，电脑端也不留底；②提醒通知只显示摘要；③App 被强制关闭时可能收不到实时提醒，重新连上会补齐；④手机端只能「回复/暂停/恢复」对话，不能执行命令或传文件 |

## 6. 连接设置（GatewayConfigScreen.kt，现「Remote Gateway 配置」）

| # | 现文 | 位置 | 定性 | 人话提案 |
|---|---|---|---|---|
| G1 | Remote Gateway 配置（页标题） | GatewayConfigScreen.kt:124 | 【直译】【协议】★ | 连接电脑（设置） |
| G2 | 连接模式（显式选择，同一设备 Token 两模式通用）：· 本地模式：桌面 DevHub 开启 gateway_enabled（默认 127.0.0.1:8746）…· Relay 模式：经中继服务器（wss://，强制 TLS）——电脑不在同一内网时使用。 | GatewayConfigScreen.kt:126-129 | 【协议】【密度】★ | 选择怎么连电脑：①同一网络（手机和电脑连同一个 Wi-Fi）；②云中转（电脑不在身边时用，经加密服务器中转）。两种方式共用一把钥匙 |
| G3 | 本地模式（chip） | GatewayConfigScreen.kt:142 | 【直译】★ | 同一网络（直连） |
| G4 | Relay 模式（chip） | GatewayConfigScreen.kt:147 | 【协议】★ | 云中转（推荐） |
| G5 | 主机（输入框 label） | GatewayConfigScreen.kt:155 | 【直译】★ | 电脑地址 |
| G6 | 端口 | GatewayConfigScreen.kt:162 | 【保留】 | 端口（配「高级」收纳候选，P2 裁决） |
| G7 | Relay endpoint（输入框 label） | GatewayConfigScreen.kt:170 | 【协议】【直译】★ | 服务器地址 |
| G8 | 仅接受 wss://（ws:// 为明文，App 在保存与连接两层一律拒绝） | GatewayConfigScreen.kt:176 | 【内部】★ | 必须以 wss:// 开头（加密连接） |
| G9 | 使用与本地模式相同的设备 Token（凭据共用，无需重新配对）。 | GatewayConfigScreen.kt:189 | 【协议】★ | 两种方式共用同一把钥匙：切换后无需重新配对 |
| G10 | 提示：尚未配置证书指纹。自签 IP 证书不受系统默认信任…（Trust anchor not found）。 | GatewayConfigScreen.kt:199-204 | 【协议】【密度】★ | 若服务器使用自签证书，需要在下方「高级」里填入证书指纹，否则会连接失败（详细原因见技术细节） |
| G11 | 证书指纹（高级，可选）/ 收起证书指纹（高级） | GatewayConfigScreen.kt:209 | 【保留】（已是折叠态） | 终稿锁定 |
| G12 | SPKI sha256 指纹（sha256/<hex>，逗号/换行分隔；双指纹轮换窗口）（折叠内 label） | GatewayConfigScreen.kt:215 | 【保留】（折叠内技术原文） | 终稿锁定 |
| G13 | 已保存（Relay 模式）。/ 已保存。 | GatewayConfigScreen.kt:276 | 【保留】微调 | 已保存 |
| G14 | 连接成功：{name} v{ver}（运行 {n}s） | GatewayConfigScreen.kt:324,354 | 【密度】★ | 连接成功！对方 DevHub 运行正常（版本/运行时长进折叠） |
| G15 | 端口非法：请输入 1–65535 数字 | GatewayConfigScreen.kt:345 | 【保留】微调 | 端口号不对：请填 1–65535 的数字 |
| G16 | 打开连接诊断 | GatewayConfigScreen.kt:407 | 【保留】微调 | 诊断连接问题 |
| G17 | 进入演示模式（夹具数据 · 非真实 Gateway） | GatewayConfigScreen.kt:419 | 【内部】★ | 体验演示模式（示例数据，不是真实电脑） |
| G18 | 通知权限区块三句（已授权：会话事件…/用于会话事件提醒…/开启通知权限） | GatewayConfigScreen.kt:429-445 | 【保留】（U1-M5 产物，已人话） | 终稿锁定 |
| G19 | relay endpoint 必须为 wss://（ws:// 为明文，不承载真实配对；App 在保存与连接两层一律拒绝） | core/relay/RelayEndpoint.kt:34-37 | 【内部】【密度】★ | 服务器地址必须以 wss:// 开头（规则句保留，其余进技术细节） |
| G20 | relay endpoint 只填裸地址（wss://地址[:端口]），不要带 /relay/device 等路径：设备腿路径由 App 自动拼接 | core/relay/RelayEndpoint.kt:40-42 | 【协议】（设备腿）★ | 只填地址即可，不要带路径——App 会自动补全 |

## 7. 连接帮助（DiagnosticsScreen.kt，现「连接诊断」）

| # | 现文 | 位置 | 定性 | 人话提案 |
|---|---|---|---|---|
| Dg1 | 连接诊断（页标题） | DiagnosticsScreen.kt:90 | 【保留】微调☆ | 连接帮助（P2 并入「我的」） |
| Dg2 | 本机连接状态（WebSocket） | DiagnosticsScreen.kt:99 | 【协议】★ | 手机这头 |
| Dg3 | 连接面：Relay（wss://…）· 电脑端 disconnected | DiagnosticsScreen.kt:101-107 | 【协议】【码】（beacon 原词 disconnected 直出）★ | 电脑端：不在线 / 在线（原 beacon 词进折叠） |
| Dg4 | 状态：{diagnosticsSnapshot()}（心跳/seq/upstream disconnected 串） | DiagnosticsScreen.kt:110 + connect/ConnectionManager.kt:1667-1686 | 【协议】【密度】★ | 一行人话（已连接/连接中/重试中/未连接）+「查看技术详情」折叠（心跳、seq、upstream 词移入） |
| Dg5 | 桌面端诊断（/v1/diagnostics） | DiagnosticsScreen.kt:119 | 【协议】★ | 电脑那头 |
| Dg6 | installed={b} version={v} exeFound={b} dataSource={k} readable={b} control={note}（key=value 串） | DiagnosticsScreen.kt:142-146 | 【协议】【密度】★ | 逐行中文：已安装：是/否 · 版本 {v} · 程序文件：已找到/未找到 · 数据源：可读取/不可读（原始 key=value 进折叠） |
| Dg7 | gateway: enabled=… running=… port=… activeDevices=… lastError=… | DiagnosticsScreen.kt:153-157 | 【协议】【密度】★ | 电脑端服务：已开启/未开启 · 端口 {n} · 已连接设备 {n} 台（lastError 人话化，原文进折叠） |

## 8. 这台手机（DeviceScreen.kt，现「设备管理」）

| # | 现文 | 位置 | 定性 | 人话提案 |
|---|---|---|---|---|
| De1 | 设备管理（页标题） | DeviceScreen.kt:109 | 【保留】微调☆ | 这台手机（P2 并入「我的」） |
| De2 | 本机尚未配对 | DeviceScreen.kt:112 | 【无引导】★ | 这台手机还没有连接电脑（附「去连接」动作） |
| De3 | 设备 ID：{deviceId} | DeviceScreen.kt:120 | 【协议】☆ | 收进「高级信息」折叠（P1 期保留但降噪为次级色） |
| De4 | 网关：{gatewayName}（如 relay:host） | DeviceScreen.kt:124 | 【协议】★ | 连接方式：云中转（服务器 …）/ 同一网络（电脑地址 …） |
| De5 | 中继接入不提供设备列表查询：本设备以配对信息为准，撤销操作不受影响。 | DeviceScreen.kt:133 | 【协议】【密度】★ | 云中转方式下不显示服务器上的设备列表；不影响这台手机的任何功能 |
| De6 | 状态：{raw status}（如 active 原词） | DeviceScreen.kt:141 | 【码】★ | 在线 / 离线（原词进折叠） |
| De7 | 最近在线：{time}（从未） | DeviceScreen.kt:142 | 【保留】 | 终稿锁定 |
| De8 | 令牌版本：{n}（tokenVersion） | DeviceScreen.kt:143 | 【协议】★ | 隐藏进「开发者信息」折叠（任务书 §1 token rotation 映射） |
| De9 | 撤销本设备 / 撤销中… | DeviceScreen.kt:161 | 【保留】微调 | 解绑这台手机 / 解绑中…（解绑=消费级词，语义与「撤销」一致） |
| De10 | 撤销后：本机 Token 即被拒绝、WS 立即断开、凭据清除并回到配对页（桌面端可随时重新配对）。 | DeviceScreen.kt:164-166 | 【协议】★ | 解绑后：这台手机会立即断开并删除钥匙；以后要用需重新配对（电脑端随时可以重新配对） |
| De11 | 撤销即刻生效且不可恢复：设备 Token 永久拒绝（需重新配对才能继续远程控制）。 | DeviceScreen.kt:173 | 【协议】★ | 解绑立即生效且不可恢复：这台手机的钥匙将被永久作废，需重新配对才能继续使用 |
| De12 | 撤销已排队（电脑离线）：连接恢复后自动执行 | DeviceScreen.kt:190 | 【保留】微调 | 电脑不在线：解绑请求已暂存，恢复连接后自动完成 |

## 9. 子任务列表（ChildSessionsScreen.kt，现「子智能体会话」）

| # | 现文 | 位置 | 定性 | 人话提案 |
|---|---|---|---|---|
| C1 | 🤖 子智能体会话（页标题） | ChildSessionsScreen.kt:100 | 【协议】★ | 🤖 子任务 |
| C2 | 该会话没有子智能体会话 | ChildSessionsScreen.kt:130 | 【协议】★ | 这个对话没有子任务 |
| C3 | L{n} 子会话 | ChildSessionsScreen.kt:172（core/SessionListOps.kt:66） | 【协议】★ | 第 {n} 层 |
| C4 | 点入回看 ▸ | ChildSessionsScreen.kt:178 | 【保留】 | 终稿锁定 |

## 10. 电脑页面卡与全屏页（WorkspaceLinkCardView.kt / ZcodeRemoteOpenButton.kt / RemoteWorkspaceScreen.kt）

| # | 现文 | 位置 | 定性 | 人话提案 |
|---|---|---|---|---|
| W1 | ZCode 工作区（卡标题） | WorkspaceLinkCardView.kt:68 | 【保留】（产品名） | 终稿锁定（图标+产品名，微信「文件传输助手」式固定卡） |
| W2 | 进入本页时自动获取桌面链接… | WorkspaceLinkCardView.kt:71 | 【保留】微调 | 正在准备电脑页面… |
| W3 | 正在从桌面获取当前链接… | WorkspaceLinkCardView.kt:74 | 【保留】 | 终稿锁定 |
| W4 | 已获取（{deviceName}）· 点击全屏打开 | WorkspaceLinkCardView.kt:78 | 【保留】微调 | 已就绪（{名字}）· 点击打开 |
| W5 | 桌面 ZCode 链路未就绪：请求已排队，就绪后自动送达 | WorkspaceLinkCardView.kt:87 | 【协议】（链路）★ | 电脑还没准备好：已记住你的请求，就绪后自动打开 |
| W6 | 桌面 ZCode 链路未就绪：链接请求已排队，就绪后再试 | ZcodeRemoteOpenButton.kt:81 | 【协议】★ | 电脑还没准备好：稍后再试（就绪后会自动打开） |
| W7 | 重试 | WorkspaceLinkCardView.kt:94 / ZcodeRemoteOpenButton.kt:184 | 【保留】 | 终稿锁定 |
| R1 | 远程工作区（页标题） | RemoteWorkspaceScreen.kt:139 | 【直译】☆ | 电脑页面（P2 并入「我的」管理入口） |
| R2 | 把电脑上复制的远程控制页链接…链接可能含动态会话令牌：仅存本机、绝不外发，展示时中段省略。 | RemoteWorkspaceScreen.kt:142-144 | 【密度】（安全提示部分保留）★ | 把电脑上复制的控制页链接（https://）存成条目，在这里全屏打开。链接可能带私人凭据：只存在手机里、绝不外发，显示时打码 |
| R3 | 空态引导（还没有条目。在电脑上复制…） | RemoteWorkspaceScreen.kt:170-171 | 【保留】（已合格：有下一步动作） | 终稿锁定 |
| R4 | 添加条目 | RemoteWorkspaceScreen.kt:203 | 【保留】微调 | 添加页面 |
| R5 | 标题（留空取链接主机名） | RemoteWorkspaceScreen.kt:207 | 【协议】★ | 标题（可不填） |
| R6 | 链接（https://…，仅接受 http(s)） | RemoteWorkspaceScreen.kt:214 | 【保留】微调 | 链接（http/https） |
| R7 | 仅接受 http(s):// 链接，其余一律拒绝 | RemoteWorkspaceScreen.kt:220 | 【内部】★ | 只能添加 http/https 开头的链接 |
| R8 | 从剪贴板填入（已检出链接）/（未检出 http(s) 链接） | RemoteWorkspaceScreen.kt:235 | 【保留】微调 | 从剪贴板粘贴 / 剪贴板里没有链接 |
| R9 | 删除条目确认（「{title}」将从本机列表移除…） | RemoteWorkspaceScreen.kt:275 | 【保留】（U1-M6 产物） | 终稿锁定 |
| R10 | 条目不存在（可能已被删除）。/ 返回列表 | RemoteWorkspaceScreen.kt:386-387 | 【保留】微调 | 页面不存在或已删除 / 返回 |
| R11 | 复制URL / 已复制 | RemoteWorkspaceScreen.kt:442 | 【保留】微调 | 复制链接 / 已复制 |
| R12 | 页面加载失败（{description}，code={n}）。请检查链接与网络后重试。 | RemoteWorkspaceScreen.kt:496-497 | 【码】★ | 页面加载失败：请检查链接和网络后重试（code/description 进折叠） |
| R13 | 证书校验失败，已阻止加载（绝不放行证书错误）。 | RemoteWorkspaceScreen.kt:509 | 【内部】★ | 证书异常，已停止加载（这是安全保护） |
| R14 | 最近打开 {time} / 从未打开 | RemoteWorkspaceScreen.kt:309 | 【保留】 | 终稿锁定 |

## 11. 通知（strings.xml / Notifier.kt / GatewayConnectionService.kt / core/EventNotification.kt）

| # | 现文 | 位置 | 定性 | 人话提案 |
|---|---|---|---|---|
| N1 | 连接状态（通知渠道名） | res/values/strings.xml:5 | 【保留】 | 终稿锁定 |
| N2 | 会话事件（通知渠道名） | res/values/strings.xml:6 | 【保留】微调 | 消息提醒 |
| N3 | DevHub Agent 连接中（常驻通知标题） | res/values/strings.xml:7 | 【直译】（Agent）★ | DevHub 运行中（正文见 N4） |
| N4 | 常驻通知正文：{Relay/本地} · {wss://…或 IP:端口} · 已连接（心跳 30s，服务端 seq 12，upstream connected） | connect/GatewayConnectionService.kt:52-54 + ConnectionManager.kt:1667-1686 | 【协议】【密度】（常驻通知满屏协议词）★ | 已连接：电脑在线（云中转）/ 已连接（同一网络）/ 连接断开，正在重试…（地址、心跳、seq 移出通知面；通知点进可见详情） |
| N5 | 等待你的输入 / 等待你的处理 | core/EventNotification.kt:28,38 | 【保留】 | 终稿锁定 |
| N6 | 等待工具批准 | core/EventNotification.kt:29 | 【密度】★ | 请求你批准一个操作 |
| N7 | 会话已完成 / 会话已失败 | core/EventNotification.kt:33-34 | 【保留】微调 | 任务已完成 / 任务已失败 |
| N8 | DevHub：{label}（通知标题格式） | core/EventNotification.kt:63 | 【保留】 | 终稿锁定 |

## 12. 状态徽章与共享组件（components/StatusBadge.kt 等 + :core 文案常量）

| # | 现文 | 位置 | 定性 | 人话提案 |
|---|---|---|---|---|
| X1 | 运行中/已完成/已失败/等待输入/等待批准/已暂停/连接丢失/已停止/未知（9 值状态徽章） | components/StatusBadge.kt:26-34 | 【保留】（U2-M4 产物，已人话） | 终稿锁定 |
| X2 | managed / attached / observed 只读（ModeBadge 原英文直出） | components/StatusBadge.kt:99-101 | 【协议】★☆ | 列表行整体隐藏该徽章（session_mode→隐藏，任务书 §1）；详情 ⓘ 弹层内译「可以对话/电脑上接入/仅查看」 |
| X3 | 健康 / 降级 / 不可用 / 未知（HealthBadge 四态） | components/StatusBadge.kt:82-85 | 【密度】（降级）★ | 正常 / 不稳定 / 不可用 / 未知 |
| X4 | 💭 思维链 · {n} 字 | core/MessageSegments.kt:54 | 【直译】★ | 💭 思考过程 · {n} 字 |
| X5 | 今天/昨天/{M月D日}（日期分隔） | core/DateGrouping.kt:38-42 | 【保留】 | 终稿锁定 |
| X6 | 「我」（用户头像） | core/ProviderPalette.kt:13 | 【保留】 | 终稿锁定 |
| X7 | 连接超时…/TLS 证书校验失败…/主机名无法解析…/无法建立连接…/网络不可达…/发生未知错误…（IOException 族六态） | core/ErrorPresent.kt:52-80 | 【保留】微调（SSL 句配合 G10 人话化） | 终稿锁定+一处微调：「自签证书需在『证书指纹（高级，可选）』配置 SPKI sha256 指纹」→「服务器用了自签证书：需在连接设置 → 高级里填证书指纹」 |
| X8 | 登录已失效：请重新配对 / 请求被网关拒绝 / 当前会话未授予该操作能力 / 能力未验证或已过期… / 指令已过期 / 桌面暂无法获取 ZCode 工作区链接 / 当前接入点不提供设备列表… | core/ErrorPresent.kt:90-116 | 【保留】微调（「网关」→「电脑」） | 「请求被网关拒绝」→「电脑没接受这个请求：App 与电脑上的 DevHub 版本可能不匹配」；其余锁定 |
| X9 | 401 透传：[{code}] {message} | ui/AppState.kt:17-19（配对页 PairingScreen.kt:76-79 直显） | 【码】★ | 经 ErrorPresent.api(code, message) 人话化（AUTH 族已有「登录已失效：请重新配对」映射） |
| X10 | 配对失败表：码不存在或不正确…/码已过期（TTL 300s）…/码已作废…/Relay 已连通，但电脑端离线（upstream offline）…/电脑端应答超时…/桌面 Gateway 未启用（gateway_enabled=0）…/设备凭据被拒绝（{code}）… | core/relay/RelayPairing.kt:180-215 | 【码】【协议】（人话头已合格，[code] 尾巴直出）★ | 保留人话头；「[$code]」尾注移入技术细节折叠；TTL/gateway_enabled/upstream 词人话化（见 P2/P10/M5） |

## 13. 规模与覆盖统计

- 清点条目：**181 条**（主框架 12 + 助手页 22 + 诚实化常量 19 + 对话列表 10 + 对话详情 23 + 配对 13 + 连接设置 20 + 连接帮助 7 + 本机设备 12 + 子任务 4 + 电脑页面 21 + 通知 8 + 徽章与 core 常量 10）。其中：需改写约 129 条，「保留/微调后锁定」约 52 条；需改项里 P1 文案层即可生效约 105 条，依赖 P2（IA）/P3（流程）承载约 24 条。
- 覆盖面：:app 全部 11 个 Compose 屏 + 8 个共享组件 + 前台服务通知 + 事件通知 + :core 六个直显文案源（InteractionHonesty/CapabilitiesExplain/ErrorPresent/RelayPairing/EventNotification/SessionListOps）。strings.xml 仅 3 条（app 名+2 渠道名+1 通知标题），其余全部为硬编码字符串——与任务书预判一致。
- 屏级覆盖对照截图：每节均可与 ux-audit-20260912/01–28 号、mobile-chat-relay-e2e/shots/01–14 号截图对应（无凭据值入册）。

## 14. 「三态可判断性」约束核验（任务书 §1 硬约束）

人话化后用户必须能区分以下三态，每态文案（常态入口=顶部连接状态条 +「我的-电脑状态」卡）：

| 态 | 触发事实（代码真值） | 人话文案 | 用户动作出口 |
|---|---|---|---|
| 还没配对 | ConnState.Unpaired / SecureStore 无凭据 / DeviceScreen De2 | 还没连接电脑：先在电脑上生成配对码 | 「去连接」→ 连接流程（gateway→pairing） |
| 网络不通（手机侧/链路侧） | ConnState.Backing + lastError（UnknownHost/SocketTimeout/Connect）或探测 IOException | 连不上：请检查手机网络或电脑是否开机（第 {n} 次重试中，约 {x} 秒后） | 「诊断连接问题」→ 连接帮助页 |
| 电脑没开/不在线 | relay Connected + upstreamBeacon==disconnected；local ConnectException | 云中转已连上，但电脑不在线——消息会在电脑上线后自动送达；或「电脑连不上：请确认电脑已开机且 DevHub 在运行」 | 「唤醒电脑」（relay）/「重试」 |

约束满足说明：M5/M9/M10/M11 + X7/Dg3 组合后，三态在 UI 上有互斥文案与互斥动作出口；心跳数字移出常态不损失可判断性（Connected/Connecting/Backing/Unpaired 四态本身即互斥文案，详细数值保留在连接帮助页技术详情）。
