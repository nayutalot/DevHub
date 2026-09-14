# UX-P2 走查记录：导航 IA 重排（四标签→三标签）

> 批次：UX-P2（docs/briefs/uxp2-ia.md）。走查环境：headless 模拟器 DevHub_API_35（emulator-5554，API 35），
> APK = 本批 assembleDebug 产物（同 dist/DevHub-Android-0.1.0-debug.apk，sha256 见提交记录）。
> 走查时电脑侧无真实 DevHub 主机 → 连接类状态为「连接中/连不上重试中」真实投影（不伪造状态的走查口径）。
> 凭据盘查：全部截图仅含模拟器本地值（设备 ID 1、gateway=b1-fake-gw 既有测试假值、10.0.2.2:18746 模拟器回环缺省），
> 零 token/配对码/指纹明文——凭据三零达标。

## 走查矩阵（docs/briefs/uxp2-ia.md §3 口径）

| 口径 | 结果 | 证据 |
|---|---|---|
| 三标签可达（≤2 tap） | PASS：对话/助手/我的=1 tap；诊断=chip 1 tap（或「我的→诊断连接问题」2 tap）；连接设置=2 tap；这台手机=2 tap；演示模式=2 tap；开发者选项=2 tap | 01/03/04/05/06/11/12 |
| 四标签移除后无死入口 | PASS：底栏仅三标签；诊断/设备屏本体经「我的」与状态 chip 全部可达；旧 main?tab=diagnostics/device 由 normalizeTab 兼容映射（单测锁） | 01/02/03/06/10/12 |
| 「我的」页全入口 | PASS：电脑连接状态卡（我的电脑+未连接 chip+连接设置/诊断连接问题动作行）、连接设置、诊断连接问题、这台手机、消息提醒（展开 P1 文案原样）、电脑页面管理、演示模式开关、开发者选项折叠（设备 ID/令牌版本/连接原串/退避重连+最近错误原文） | 03/04/05/10/11/12 |
| 对话列表新行形态 | PASS：置顶 ZCode 工作区卡（灰底）+provider 过滤 chips 次级行+行=头像+标题+时间+9 值状态角标（「运行中」）；X2：session_mode 徽章（ModeBadge）列表行已隐藏；stale/归档降副文案（本机缓存行无消息缓存，预览位空属真实数据态） | 01 |
| 深链/返回栈回归 | PASS：devhub://session/129 热路径直达详情；BACK 栈序 详情→电脑连接状态页→我的（tab 态保留） | 07/08/09 |
| 状态 chip 五态 | 本轮真实命中：◌连接中（01/02）与 ↻连不上·重试中(第 n 次)（03/04/09/11/12，n 随退避递增）+「诊断连接问题」动作出口；●已连接/⚠云端降级/✕未连接由单测与 P1 文案迁移覆盖（模拟器无真实主机不摆拍） | 01/03 |
| U1-U5 已修面 | PASS：U1-M3 ErrorPresentation+技术细节折叠（02/05/06/12）；U1-M6 解绑红字按钮+确认（05）；ⓘ/渐隐/删除确认屏本体零改动（未入镜，代码未触碰） | 02/05/06/12 |

## 截图清单

1. `01-sessions-tab-row-form.png` — 对话 tab：三标签+状态 chip（◌连接中）+置顶卡+chips 次级行+新行形态
2. `02-agents-tab.png` — 助手 tab：离线 U1-M3 错误面（唤醒卡未出现=非 relay 在线态正确条件置顶）
3. `03-mine-tab.png` — 我的 tab 全貌：chip 连不上态+动作出口；电脑卡；全入口列表
4. `04-mine-dev-options-expanded.png` — 开发者选项展开（技术原值折叠区）
5. `05-device-screen-from-mine.png` — 这台手机（路由目的地+返回钮+解绑红字）
6. `06-connection-status-page.png` — 状态 chip 点开=电脑连接状态页（连接帮助本体）
7. `07-deeplink-session-detail.png` — devhub://session/129 直达详情
8. `08-back-stack-after-deeplink.png` — BACK→电脑连接状态页（栈序正确）
9. `09-mine-tab-retained-after-back.png` — 二次 BACK→我的 tab 保留
10. `10-remote-manage-from-mine.png` — 我的→电脑页面管理（remote-manage 本体）
11. `11-mine-notification-entry.png` — 消息提醒展开（P1 文案原样+开启通知权限）
12. `12-gateway-from-mine.png` — 我的→连接设置（表单+诊断连接问题+体验演示模式完好）
