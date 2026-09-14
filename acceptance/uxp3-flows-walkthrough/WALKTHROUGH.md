# UX-P3 走查记录：流程引导层（连接合一页 + 开始对话一键化 + 空态 CTA + 唤醒联动）

> 批次：UX-P3（docs/briefs/uxp3-flows.md）。走查环境：headless 模拟器 DevHub_API_35（emulator-5554，API 35），
> APK = 本批 assembleDebug 产物（与 dist/DevHub-Android-0.1.0-debug.apk 同一构建产物）。
> APK sha256 = a01f86497940ed2c252addf6964dc075996eec0ab2e3d7ed7a7ec7e73a710520（11,366,867 字节，2026-09-15 落 dist）。
> 走查与 P2 不同点：**本轮电脑侧有真实 DevHub 主机**（dist/win-unpacked 0.1.0，gateway 127.0.0.1:8746，
> 模拟器经 10.0.2.2 直连），连接类状态为真实投影：●已连接 / ◌连接中 / ↻连不上重试中(第 n 次) / ✕未连接
> 全部真实命中；⚠云端降级态（电脑不在线）不可真实命中（见偏差节）。
> 凭据盘查：截图 08 中真实配对码已做黑框遮蔽后入册；27/28 中的码为故意输错的假码（ZZZZZZZZ/QQQQQQQQ，
> 非真实凭据）；零 token/指纹/URL 令牌明文——凭据三零达标。
> 走查后已把桌面端设备清理说明：走查在桌面侧注册了多台 uxp3-probe-* 测试设备（自动化 probe，见偏差节）。

## 门禁

| 门禁 | 结果 |
|---|---|
| :app 单测 | 163 → **176**（+9 ConnectFlowPolicyTest、+4 AgentsAutoSpawnTargetTest）全绿 |
| :core 单测 | 315 → **316**（+1 SPAWN_TASK_PLACEHOLDER 锁）全绿 |
| assembleDebug | PASS（产物即本页 sha256） |
| 首装 funnel | 见下节，逐步记录 |
| 三态错误 e2e | 还没配对=真实命中；连不上=真实命中（chip+单页文案两形态）；电脑不在线=relay ⚠态未命中（偏差），local「电脑没开机」人话=真实命中 |
| 旧路由深链回归 | PASS：pairing 路由（401 流转）渲染同一单页；gateway 路由=连接设置本体；devhub://session/{id} 冷热路径直达 |

## 首装 funnel（清 App 数据=全新安装，逐步记录）

前置：adb 全新安装 + 预授 POST_NOTIFICATIONS（系统权限弹窗不占 App 输入次数）。
桌面侧经 /v1/pairing/create（docs/14 §B 预留的自动化端点，仅 127.0.0.1）取真实一次性配对码。

| 步 | 画面 | 动作（人工输入/点击） | 截图 |
|---|---|---|---|
| 0 | 冷启即「连接电脑」单页（非两页流） | 0 次 | 07 |
| 1 | 单页：电脑地址默认 10.0.2.2（模拟器回环）零修改 | 输入 8 位配对码（1 次输入） | 08 |
| 2 | [连接] 一键完成「保存配置+claim」（原 保存并继续→配对页→连接 三步并入） | 点 [连接]（2） | 09 |
| 3 | 安全须知（一次，P13 四事实原样） | 点 [我知道了]（3） | 09 |
| 4 | 落「对话」tab：chip ●已连接 + 真实会话行 | — | 10 |
| 5 | 开始对话 | 点助手 tab（4）→ [开始对话]（5）→ 输入首条消息（6，输入框自动聚焦键盘弹起）→ [开始]（7），按钮即「正在创建…」 | 12/13/14/15 |
| 6 | 跳入新对话气泡流；消息「ping - reply with one word.」真实送达桌面 Codex 会话（桌面 rollout 落盘 + 对话列表行预览=该消息，截图 21 行 2） | — | 16 |

**输入次数口径（如实）**：
- 启动→看见对话列表 = **3 次**（配对码/连接/我知道了；任务书 ≤5 达标，docs/26 §6-P3 口径）。
- 启动→首条消息送达桌面 = 实测 **7 次**：其中 2 次（助手 tab + [开始对话]）因本机桌面有 200 条历史会话、
  对话页空态 CTA 未真实出现而多出（见偏差 1）。**全新桌面（无历史会话）场景 = 6 次**：配对码/连接/
  我知道了/去助手CTA（对话空态按钮，一步带入并自动展开输入框）/消息/开始。
- 若以「不计安全须知确认（系统级一次性，docs/26 §5.1-⑤ 合规必要保留）」口径 = **5 次业务输入**，≤5 成立；
  严格逐次点击口径下超出 1 次，属安全须知确认的固有成本，如实上报不做口径修饰。

## 三态错误 e2e（docs/24 §2.2 矩阵）

| 态 | 命中方式 | 文案（真实截屏） | 动作出口 | 截图 |
|---|---|---|---|---|
| 还没配对 | 「这台手机→解绑」确认 → 服务端 DEVICE_REVOKED（remote_devices.revoked_at 实录）→ App 清凭据 → 回「连接电脑」单页（经旧 pairing 路由，零破坏） | 还没连接电脑：先在电脑上生成配对码（连接页引导文案即此态出口）；解绑确认红字 | [连接]（重配对）/去连接 | 25/26 |
| 连不上 | ①桌面 gateway 进程停止 → WS 退避 | chip「↻ 连不上：重试中（第 5 次）」琥珀 + 「诊断连接问题」出口；连接帮助页技术详情折叠原值 | 诊断连接问题 | 21/23 |
| 〃 | ②单页填不可达地址（10.0.2.1）+ 8 位码 → claim IOException | 「连不上电脑：请确认电脑已开机、DevHub 正在运行，并在上方核对电脑地址」+ 技术细节折叠 | 核对地址/测试连接/诊断连接问题（同页三出口） | 27 |
| 码不对/过期 | ③真实地址 + 故意错码 → AUTH_INVALID_TOKEN | 「连接失败：码不对、已过期或已被使用——请在电脑上重新生成」+ 码框自动清空（M3-C6c #6） | 电脑上重新生成 | 28 |
| 电脑没开/不在线（local 姿态） | 同 ②（ConnectException 族） | 「请确认电脑已开机、DevHub 正在运行…」 | 同 ② | 27 |
| 电脑不在线（relay ⚠ 姿态） | **未真实命中**（偏差 2）：桌面 0.1.0 实例今日无 relay client 活动（日志零 relay 行），无法构成「App 已连云端 + 电脑 upstream 离线」前提；不摆拍 | chip ⚠「云端连接已连上，电脑不在线」+ WakeHostCard 联动出口由 wakeCardNeeded 纯函数单测 + 条件渲染代码路径承载（P2 同口径） | 唤醒电脑（WakeHostCard 接线三处：对话 tab/助手/我的/连接帮助页） | — |
| 重连回归 | 桌面重启 → App 自动恢复 ●已连接（电脑端：在线·最近事件实时刷新） | — | — | 24 |

## 旧路由深链回归（红线「路由零破坏」）

| 路由 | 验证 | 截图 |
|---|---|---|
| devhub://session/856 | 通知深链直达会话详情（observed 态「这里只能看内容」原样） | 17 |
| pairing（401 全局流转 navigate("pairing")） | 解绑后自动回「连接电脑」单页=旧路由兼容渲染同一单页（重定向到单页配对码折叠区语义） | 26 |
| gateway（我的→连接设置） | 已配对用户连接设置本体原样（模式 chips/host/端口/保存并继续/测试连接/G16/G17 全在） | 20 |
| 解绑→重配对闭环 | 单页再配对 → 安全须知 → 主框架 ●已连接（服务端 remote_devices 新设备 active） | 29 |

## 空态 CTA（docs/26 §4.3 五屏）与唤醒联动

| 屏 | 落地 | 走查 |
|---|---|---|
| 对话 | 一句事实（S5 原样）+ [去助手开始第一个对话]（切助手 tab+自动展开输入框） | 本机桌面有历史会话，空态未真实出现（偏差 1，不摆拍）；CTA 目的地/自动展开逻辑由 autoSpawnTargetId 单测锁 + 走查 12/13 证明其动作面真实可用 |
| 助手 | 一句事实（A4 原样）+ [诊断连接问题]→连接状态页；无手工重扫功能故不画「重新扫描」假按钮（A4 教训） | 同上，助手列表非空（偏差 1） |
| 我的-电脑 | 未连接 chip + [去连接] 按钮（出口=连接设置） | **真实命中**：gateway 停机时 电脑卡=我的电脑·未连接·[去连接] | 
| 电脑页面管理 | R3 既有合格（还没有条目+剪贴板指引），零改动核验 | 真实空态 | 
| 子任务 | C2「这个对话没有子任务」+ [返回对话] | 入口仅在 childSessions 非空时渲染（D5 既有条件），空态属竞态边缘，未自然命中（偏差 3，代码+单测承载） |
| 唤醒联动 | WakeHostCard 接线 4 处：对话 tab（新）/助手（既有）/我的（既有）/连接帮助页（新）；仅 relay 且电脑未确认在线时出现；local 模式全程正确不渲染（走查 10/12/18/21 佐证） | 卡本体渲染待 relay ⚠态（偏差 2） |

## 截图清单

1. `01-connect-first-launch.png` — 全新冷启直达「连接电脑」单页（系统通知权限弹窗为 API 33+ 既有行为）
2. `02-connect-single-page-full.png` — 单页全要素：方式 chips/地址/配对码/高级入口/连接+测试连接/诊断
3. `03-advanced-local-fold.png` — 高级折叠(local)：端口 8746/pairingId/体验演示模式（全可达零删除）
4. `04-relay-wss-enforced.png` — 云端连接表单：wss supporting text/自签指纹引导/证书指纹折叠
5. `05-relay-bare-address-rejected.png` — 非 wss 内联拒绝（保存与连接两层同函数语义）
6. `06-relay-path-rejected.png` — 带路径拒绝「只填地址即可，不要带路径」（测试连接触发 parse）
7. `07-funnel-1-connect-page.png` — funnel 第 0 步（全新安装）
8. `08-funnel-2-code-typed.png` — funnel 第 1 步：输入配对码（截图已做黑框遮蔽，凭据盘查处理后入册）
9. `09-funnel-3-security-notice.png` — funnel 第 2/3 步：[连接]→安全须知一次
10. `10-funnel-4-sessions-connected.png` — 配对成功：●已连接 + P2 会话行形态原样（真实数据）
11. `11-sessions-provider-filter.png` — provider 过滤 chips 真实过滤（Claude/Codex 子集，非空）
12. `12-agents-tab.png` — 助手页：Codex ●可以对话+「开始对话」主按钮；observed 四家原因卡原样
13. `13-spawn-inline-focus.png` — [开始对话]→内联输入框：placeholder「想让它先做什么？」+ EditText focused=true（键盘弹起）
14. `14-spawn-message-typed.png` — 首条消息已输入
15. `15-spawn-submitting.png` — [开始]提交（「正在创建…」态）
16. `16-session-message-delivered.png` — 跳入新对话气泡流：消息气泡+运行中+可以对话（回复未到见偏差 4）
17. `17-deeplink-session-856.png` — devhub://session/856 深链直达（observed 详情原样）
18. `18-mine-tab-online.png` — 我的：电脑卡在线态（无去连接按钮=条件渲染正确）
19. `19-remote-manage-r3-empty.png` — 电脑页面管理 R3 空态（既有合格零改动）
20. `20-gateway-route-regression.png` — 旧 gateway 路由=连接设置本体（已配对语义）
21. `21-backing-chip-retry.png` — ↻连不上重试中(第 5 次)琥珀 chip+诊断出口；行预览=手机所发消息（送达实证）；离线缓存 200 行
22. `22-mine-unconnected-go-connect.png` — 电脑卡未连接态+[去连接] CTA（空态 CTA 真实命中）
23. `23-connection-status-unreachable.png` — 连接帮助页（停机期间，技术详情折叠原值）
24. `24-reconnected-online.png` — 桌面重启后自动重连：电脑端在线/已连接
25. `25-unbind-confirm.png` — 解绑二次确认红字（U1-M6 不回退）
26. `26-401-redirect-connect-page.png` — 解绑→凭据清除→回「连接电脑」单页（旧 pairing 路由兼容）
27. `27-error-unreachable-host.png` — 三态：连不上电脑（电脑已开机/核对地址人话+技术细节折叠）
28. `28-error-wrong-code.png` — 三态：码不对/过期（重新生成）+码框自动清空
29. `29-repaired-main.png` — 解绑→重配对闭环：再次 ●已连接

## 偏差（如实）

1. **对话/助手两屏空态 CTA 未真实出现**：走查桌面有 200 条真实会话、4 个 provider，空态前置条件不成立；
   不摆拍（伪造空列表=伪造状态）。CTA 的动作半程（切助手 tab→自动展开输入框→[开始]→会话创建）经
   12-16 真实走查，目标判定 autoSpawnTargetId 有 :app 单测直锁。全新桌面场景两 CTA 将随空态自然出现。
2. **relay ⚠电脑不在线态未真实命中**：桌面 0.1.0 实例（dist/win-unpacked）今日日志零 relay client 活动，
   settings 虽存 relay_endpoint=wss://59.110.149.11（历史上游 seq=32021），无法在本轮构成「App 已连云端
   relay + 电脑 upstream 离线」的真实前提。该态文案/chip/WakeHostCard 联动出口由 P1/P2 已验收文案、
   wakeCardNeeded 纯函数单测与本批三处条件渲染接线承载；wake 卡在 local 模式全程正确不渲染（真实佐证）。
3. **子任务空态未自然命中**：「子任务」入口仅在 childSessions 非空时渲染（D5 既有条件，未改），
   空态属「子会话被删」竞态边缘；CTA（返回对话）为纯导航出口，:app 编译路径覆盖。
4. **「收到回复」未完成**：App 侧链路（创建会话 202→跳入气泡流→两条消息真实送达桌面 Codex 会话，
   codex rollout 落盘为证）全部走通；但桌面 Codex 模型后端 turn 停滞（两 turn 分别 25min/3min 零
   assistant 事件，rollout 行数冻结），回复未产生——属桌面侧模型后端问题，非 App 侧缺陷（回复链路此前
   已有 kimi-spawn-e2e/rd 批真实回复验收）；会话状态「运行中/可以对话」如实呈现，无伪成功面。
5. **桌面端测试设备残留**：走查经自动化端点注册了 uxp3-probe-*/uxp3-funnel/uxp3-repair 等测试设备
   （手机本体=设备 86 已解绑作废）；桌面侧设备列表留有 probe 记录，属本机测试痕迹，不影响生产。
6. **funnel 计数口径**：见 funnel 节——严格逐次点击口径下「启动→消息送达」为 6 次（全新桌面）/7 次
   （本机实测），超出 5 的部分为安全须知一次确认（合规必要）与真实数据导致的入口步；「启动→看见对话
   列表」=3 次达标。
