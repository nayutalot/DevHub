# UX-Z2 走查记录：对话 v2 结构层（段控工作区列表 + composer-first + 模型弹层三态 + 相对时间/复制钮/statusDetail 收口）

> 批次：UX-Z2（docs/briefs/uxz2-structure.md；规格 docs/28 §4/§5）。
> 走查环境：headless 模拟器 DevHub_API_35（emulator-5554，API 35，`-no-window` 零打扰），
> APK = 本批 assembleDebug 产物（= 覆盖 dist 的 DevHub-Android-0.1.0-debug.apk，
> sha256 = 9b27d2b6f01d7f95b14ffa67c04ad3474a793abfd5262c3d4d541861f4869b37，11,416,019 字节）。
> 网关 = **本批新代码起的本地夹具网关**（gateway-runner.mjs，worktree 内 node 直启
> httpServer + 临时 DEVHUB_HOME 播种；端口 18790；走查结束即 taskkill，零常驻遗留）。
> 走查完成后网关进程与模拟器均已关闭；模拟器 App 残留本地 10.0.2.2:18790 配置
> （pm clear 后重配的测试态；生产 relay 配对已随 pm clear 清除——模拟器为走查专用测试设备）。
>
> 凭据三零：12 张截图逐张核对——零 token / 零配对码（配对码仅键盘输入，
> 从不出现在任何截图）/ 零指纹；出现的 laurdasktop=本机主机名（UX-Z1 06/07 先例
> 非凭据）、C:/code/devhub 等路径=夹具假路径；「信息可能不是最新」=夹具 home 无监控
> 管线的真实 stale 投影（不伪造）。

## 走查矩阵（docs/28 §7 增量矩阵逐行）

| 口径 | 结果 | 证据 |
|---|---|---|
| 对话 tab 段控「最近对话｜工作区」 | PASS：二分段 FilterChip；默认=最近对话（现状零回归）；置顶 ZCode 工作区 WebView 遥控卡并存（§4.1 职责分离） | 01/02 |
| E1 汇总行「N 个工作区 · M 个对话」 | PASS：「4 个工作区 · 7 个对话」 | 02 |
| E2 工作区卡（图标/名称/路径/N 个对话/chevron/＋新对话） | PASS：📁 图标恒定（E2b 本地/远程 tag=C 档零出现）；名称=路径尾段；路径全拼展示（中段省略函数已装，短路径直出）；N 个对话；▾ 展开任务行；卡内「＋ 新对话」 | 02/03 |
| 分组/排序（docs/28 §4.2） | PASS：devhub(3)→contestpin(2)→blog(1) 按最近活动降序；workdir 缺失会话入「未分组」组且恒排尾部、绝不丢弃 | 02 |
| E3 「更新于 X」相对时间 | PASS：「更新于 9 分钟前 / 10 分钟前 / 2 天前」；组内任务行「9 分钟前/13 分钟前/1 小时前」（TimeFmt.rel 与桌面 relativeTime 同口径，:app 单测 7 枚锁） | 02/03 |
| E2e 任务行 | PASS：标题+状态角标（运行中/等待输入/已完成）+相对时间，点行进详情=既有路由 | 03 |
| composer-first 新建页（P3 升级迁移） | PASS：「＋ 新对话」（表头/工作区卡内）与助手页「开始对话」三动线全部进入；问候语+大输入框+chips+模型行+工作区行+开始钮 | 04/05/09 |
| E4 问候语时段人话 | PASS：16:51 →「下午好」（13–18 桶）；输入非空后隐藏（05 图）；文案池无称呼不伪造 | 04/05 |
| E8 chips 四枚点击仅填入 | PASS：「代码解读」点击 → 输入框=「给我讲讲这个项目的结构」，未自动发送 | 05 |
| E6 工作区选择器（只读降级） | PASS：「工作区：C:/code/devhub（在电脑上配置，这里只展示）」——E6' 切换=C 档不画可点入口 | 04 |
| E10 模型弹层·可选面 | PASS：当前模型「zcode/glm-5-turbo · ZCode · 当前使用」勾选态只读展示；候选「GLM 系列模型」灰显（×managed 键过滤，DeepSeek 不在册不出）；「切换/管理模型请在电脑上操作」静态指引（E10'/E11=C 档不画死按钮/可选勾） | 06 |
| 模型弹层·托管停用态 | PASS：managed_model 键清空后 →「模型在电脑上配置后可用 + ZCode 行 + 指引」，无勾选无候选；composer 行文案「在电脑上配置后可用」 | 07 |
| 模型入口三态之「不画」 | 无 managed provider → modelSheetState=null 入口不画（:core 单测锁；本环境恒有 managed zcode，模拟器不摆拍无 managed 形态） | 单测 ComposerFirstTest |
| 助手页「开始对话」跳转（autoOpenComposer 复用） | PASS：助手 tab 按钮 → 切对话 tab + 打开新建页 + 聚焦（跨 tab 一次性语义） | 08/09 |
| E20a 复制钮 | PASS：每条气泡尾注「复制」；点击 →「已复制」1.5s 回执；赞/踩=C 档零出现 | 10/11 |
| statusDetail 工程串收口 | PASS：deepseek 沿形态「turn/end (seq 806)」→「本轮已结束（第 806 条事件）」（core.StatusDetailHumanize 查表，未命中零吞码） | 12 |
| 深链零破坏 | PASS：devhub://session/4 直达会话详情（标题/徽章/人话 detail 完整） | 12 |
| C 档零出现红线 | PASS：附件/@///$ /本地远程 tag/记忆 pill/撤销/赞踩/「管理模型」跳转钮——12 张图+代码面均无入口 | 全部 |
| ControlGate/会话门语义 | 未触碰：详情页控件走既有 caps 门；演示模式夹具全部 observed→composer 不可达（诚实） | 代码面 |

## 截图清单

1. `01-sessions-recent-segment.png` — 对话 tab·最近对话段：段控+置顶卡+7 条夹具会话行（9 值状态角标）
2. `02-workspaces-segment.png` — 工作区段全貌：汇总行+三组卡片+未分组尾部（组间最近活动降序+「更新于 X」）
3. `03-workspace-card-expanded.png` — devhub 卡 chevron 展开：3 条任务行（标题+状态角标+相对时间）+「＋ 新对话」
4. `04-composer-first-greeting.png` — 新建页：问候语「下午好」+大输入框+chips 四枚+工作区只读行+模型行+开始钮
5. `05-composer-chip-fill.png` — 「代码解读」点击填入（问候语随非空输入隐藏；未发送）
6. `06-model-sheet-available.png` — 模型弹层·可选面：当前模型勾选态只读+候选灰显+电脑管理指引
7. `07-model-sheet-disabled.png` — 模型弹层·托管停用态：「模型在电脑上配置后可用」（无勾选无候选）
8. `08-agents-tab-start-chat-jump.png` — 助手 tab：ZCode 卡「● 可以对话」+「开始对话」跳转按钮
9. `09-composer-after-agents-jump.png` — 跳转落点=对话 tab 新建页（跨 tab 一次性语义）
10. `10-session-detail-copy.png` — 会话详情：气泡尾注「复制」钮+状态徽章+常驻 composer
11. `11-copy-feedback.png` — 点击复制后「已复制」回执（1.5s 自恢复）
12. `12-deeplink-statusdetail-humanized.png` — devhub://session/4 深链直达+「本轮已结束（第 806 条事件）」人话收口

## 走查方法与夹具（透明化）

- `gateway-runner.mjs`：本批新代码（worktree 源码 node --experimental-strip-types 直载）
  在临时 DEVHUB_HOME 播种的只读夹具网关——agent_providers 五家目录行（zcode 置 managed
  caps + workspace）、agent_sessions 7 行（workdir 三组+未分组一组）、settings
  （gateway_enabled/gateway_port=18790/zcode_managed_model=zcode/glm-5-turbo）、
  agent_messages 4 行（复制钮样例）。真机 provider/凭据零触碰；走查后进程已 taskkill。
- 三态中的「无 managed 不画入口」以 :core ComposerFirstTest 单测为证（本环境
  zcode 恒 managed，模拟器不摆拍缺数据形态——不伪造纪律）。
- 停用态切换 = sqlite 直改夹具 home 的 zcode_managed_model 为空串（WAL 跨进程安全），
  重启 App 后agents 投影缺 managedModel → 停用态。
