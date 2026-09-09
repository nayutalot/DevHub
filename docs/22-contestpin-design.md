# 22 赛程钉 ContestPin 模块设计（CP 系列）

> 权威任务书：`docs/briefs/contestpin-charter.md`（用户原文逐字，32a484c）。
> 本文 = 开工只读审计（2026-09-09 三面并行：窗口/托盘、数据库/IPC、ApiHub/密钥/Agent）
> 产出的实施设计；与源码冲突时以源码+实测为准并回写本文。
> 时机约束：M3-D 72h 观察窗内（至 2026-09-10 08:49）只做隔离编码 + 纯 Node 单测
> （tsc + smoke `--tier=fast`），不跑全量 smoke/mcp/`:app` 门禁、不动常驻/ECS/8746。

## 1. 总体架构（全部沿用既有分层，零新进程零新服务）

- **Service 层 electron-free**：`src/main/services/contestpin/` 下全部纯 Node 模块
  （db 经 `getDatabase()`、时间戳 unix 秒、SQL 参数绑定、`ServiceError` 结构化错误），
  smoke 直测（`makeTempHome` 临时 DEVHUB_HOME 范式）。
- **Electron 胶水只在 wire 层**：新增 `src/main/overlayWire.ts`（悬浮窗）与
  `src/main/notifyWire.ts`（Windows 通知）两个文件；electron import 白名单
  （autostartWire.ts:6-8 纪律注记）扩为 7 文件，docs/12 文件清单同步。
- **Renderer 只经 `devhub:invoke` 白名单网关**：新 channel 组 `contestpin:*`，
  注册三件套 = shared/channels.ts + shared/types.ts ChannelContract +
  ipc/handlers.ts（编译期全覆盖断言强制）；无广播 channel，长任务轮询（先例
  versions:job / archive:status）。
- **不依赖 ECS Relay / Remote Gateway / Android**：模型请求主进程直发用户配置的
  API；单实例锁 `requestSingleInstanceLock` 语义不变（悬浮窗不得被"打开 DevHub"
  误选，见 §4.6）。

## 2. 数据模型（migration 008；007 已判给 LR1，ContestPin 从 008 起）

### 2.1 迁移文件 `008_contestpin.sql`（+ migrate.ts 字面量 switch 补 case 8）

7 张新表 + settings 种子；fresh 库迁移后 applied=7、`PRAGMA user_version`=8。
SQL 文件内禁止 `PRAGMA user_version`（docs/03 §4.3）；种子一律 WHERE NOT EXISTS。

| 表 | 要点 |
| --- | --- |
| `contests` | name/year(可空)/edition/organizer/note/status/archived/official_site/signup_url/submit_url/created_at/updated_at；status CHECK IN ('watching','registered','submitted','completed','given_up') |
| `contest_nodes` | contest_id FK CASCADE；kind CHECK IN ('signup_start','signup_deadline','payment_deadline','contest_start','contest_end','submit_deadline','custom')；label（自定义节点名/原文节点名）；start_at/end_at INTEGER unix 秒可空；tz TEXT 默认 'local'（IANA 名）；precision/raw_text/done/done_at/source CHECK IN ('manual','imported','agent') |
| `contest_reminders` | node_id FK CASCADE；offset_kind CHECK IN ('before_days','before_hours','at_time') + offset_value + channel CHECK IN ('windows','in_app')；UNIQUE(node_id,offset_kind,offset_value,channel)；enabled/last_fired_at |
| `contest_reminder_log` | 补发去重账本：reminder_id/node_id/fire_at/fire_key，UNIQUE(reminder_id,fire_key)（fire_key=到期桶标识，跨重启/休眠恢复补发不重复） |
| `contest_materials` | sha256 TEXT UNIQUE（重复文件不重复创建）；original_name/stored_path（`getDataDir()/contestpin/materials/`）/size_bytes/pages/kind CHECK IN ('pdf','image','other')/imported_at |
| `contest_import_jobs` | 两阶段状态机：mode CHECK IN ('two_stage','multimodal','agent','manual_pack')；stage CHECK IN ('imported','preprocessed','vision_done','text_done','validated','draft','confirmed','failed','cancelled')；vision_config_id/text_config_id/vision_fingerprint/params_json/result_json/error_json/progress |
| `contestpin_configs` | 识别配置：name/role CHECK IN ('vision','text','multimodal')/base_url/model/key_sealed（KeyCrypto envelope JSON，复用 apihub keyStore 加解密，绝不落明文）/timeout_ms/last_test_at/last_test_ok/last_test_usage_json；UNIQUE(name,role) |

settings 种子：`contestpin_default_mode`（'two_stage'）、`contestpin_overlay_enabled`（'0'）。
运行期键（不种子）：`contestpin_overlay_state`（bounds+collapsed JSON，service 直写）。

### 2.2 时间语义裁决（审计确认全库无先例，本节为权威）

- `precision`：**'exact'**=原文给到时刻；**'date'**=仅日期 → 展示必须标"未注明具体
  时刻"，存储取该时区当日 00:00，**提醒与悬浮窗不得按精确时刻处理，识别校验禁止
  date→exact 提升**；**'month'**=仅年月（start_at 取当月 1 日）；**'tbd'**=时间待定
  （start_at/end_at NULL，原文明说待定）。
- 缺少年份：contests.year NULL，不编造；校内/全国不同截止：同比赛多 node（label
  +raw_text 区分依据）；时间范围：start_at+end_at 成对。
- 提醒策略（contest_reminders）与 precision **分开保存**（charter §三）；'date'
  精度节点的 before_days 提醒按自然日计算，不出现"截止时刻前 N 小时"语义。

### 2.3 资源关系（零表改动）

`resourceGraph.ts` ResourceType 追加 `'contest'`（docs/05 §41-46 扩展方式）；
比赛关联 Project = resources 登记 contest 节点 + relationships 复用 `uses` 边
（source=contest, target=project，INSERT OR IGNORE 幂等；删除比赛显式删节点清边，
projectService.ts:501-505 先例）。比赛字段不进 projects 表。

## 3. IPC 通道（`contestpin:*`，分批落地、smoke 计数就地更新）

### CP1（M1，9 条，白名单 70→79）

| channel | payload | result | 读写 |
| --- | --- | --- | --- |
| `contestpin:list` | `{ query?, status?, archived?, limit?, offset? }` | `{ items: ContestListItem[], total }` | READ_ONLY |
| `contestpin:get` | `{ id }` | ContestDetailView（nodes/materials/reminders/project 关联） | READ_ONLY |
| `contestpin:create` | `{ name, year?, edition?, organizer?, note?, status?, officialSite?, signupUrl?, submitUrl? }` | ContestView | 变更 |
| `contestpin:update` | `{ id, patch }` | ContestView | 变更 |
| `contestpin:delete` | `{ id, confirmed? }` | CONFIRM_REQUIRED 两段式（先回 impacts：节点/材料/提醒计数） | 变更 |
| `contestpin:archive` | `{ id, archived: bool }` | ContestView | 变更 |
| `contestpin:nodeUpsert` | `{ contestId, node? }`（带 id=更新） | ContestNodeView | 变更 |
| `contestpin:nodeDelete` | `{ id, confirmed? }` | CONFIRM_REQUIRED 两段式 | 变更 |
| `contestpin:linkProject` | `{ contestId, projectId: number \| null }` | `{ linked: bool }` | 变更 |

### 后续批次预告（落地时逐批入 docs/04，计数就地更新）

- CP2 悬浮窗 +4：`overlayState`(READ_ONLY) / `overlaySetEnabled` / `openInMain` /
  `openLink`（http/https 校验后 shell.openExternal，胶水在 wire 层）。
- CP3 识别管线 +~12：configList/Save/Delete(confirm)/Test、materialsList、
  importCreate/Status/Cancel/Retry、draftList/Update/Confirm(confirm)/Discard(confirm)。
  （CP3a 批次注记：config 四条 +4 已落地，白名单 84→88，docs/04 已入册；
  余 +8 归 CP3b。）
- CP4 提醒 +2、CP5 Agent +3~4（agentStatus/agentSubmit/importPack/exportPack）、
  CP6 备份 +2。全量落地后 70→约 101（LR1 另 +4）。

## 4. 悬浮窗（CP2）

### 4.1 窗口本体（`src/main/overlayWire.ts` 新文件）

`new BrowserWindow({ frame:false, alwaysOnTop:true, skipTaskbar:true, resizable:true,
show:false, webPreferences: 同款 sandbox/contextIsolation/preload })`——复用
`out/preload/index.js` 与唯一 `devhub:invoke` 网关，**不写第二个 preload**。
关闭=hide（挂与主窗口同款 isQuitting 守卫）；退出=destroy + 计时器清理挂
`runQuitTeardown` 最前（先于 closeDatabase；收尾 5s 硬上限内同步完成）。

### 4.2 页面路由：同一 renderer 产物 + `#overlay` hash（仿 `#agents` 先例，
index.ts:71-86 loadRenderer + App.tsx:39-42 initialTarget）——App 分流渲染精简
OverlayApp（usePolling 轮询 contestpin:*），不动 electron.vite 多入口。

### 4.3 位置/尺寸/折叠记忆：move/resize 防抖 → contestService 直写 settings
`contestpin_overlay_state`（service 层唯一写库，不经 renderer settings:set）；
启动恢复时 `screen.getDisplayMatching(bounds)` 校验 + workArea 裁剪（显示器
被拔/分辨率变化后回到可见区；Electron bounds 为 DIP，Windows DPI 缩放天然对齐，
不自行换算）。监听 `display-removed`/`display-metrics-changed` 主动 relocate。

### 4.4 置顶/拖动/缩放/折叠：alwaysOnTop + CSS `-webkit-app-region: drag` +
resizable(min/max) + 折叠=renderer 状态 + setSize + 持久化。CSP `default-src
'self'` 约束下样式仅 style 属性级内联。

### 4.5 托盘开关：trayWire.ts 菜单 checkbox（仿 monitor/autostart 模式，
settings 键 `contestpin_overlay_enabled` 即时生效）+ TrayDeps 注入 + lastMenuState
扩展。点击比赛 → `contestpin:openInMain` → main 侧 `showMainWindow()` +
loadRenderer hash `contest:<id>`（ViewTarget 扩展）；主窗口隐藏时照常恢复。

### 4.6 单实例收紧（审计风险 1）：index.ts:125/138/149 三处
`mainWindow ?? BrowserWindow.getAllWindows()[0]` fallback 改为显式判空 + 销毁态
检查，保证 second-instance/托盘"打开 DevHub"永远指向主窗口，悬浮窗永不被加载
主应用页面。

## 5. 材料导入与三模式识别管线（CP3）

- **统一任务管理/结果结构/字段校验/来源回溯/人工核对**：三模式（①视觉→文本
  两阶段默认 ②直接多模态 ③Agent）共用 contest_import_jobs 状态机与核对界面；
  默认模式记 settings `contestpin_default_mode`。
- **两阶段状态机**：imported→preprocessed→vision_done→text_done→validated→
  draft→confirmed（failed/cancelled 可从任一阶段进入；文本阶段失败单独重试、
  视觉结果可人工修正后重整理）。
- **来源映射**：finding 级 `{ field, materialId, page, excerpt }` 全程保留；缺失
  留空、模糊/冲突标记待核对；**不编造年份/时刻/官网**；通知内指令只作文档内容。
- **缓存失效**：`vision_fingerprint = sha256(材料) + '@' + hash(vision 配置
  base_url+model)`——材料或视觉配置任一变化即重跑视觉；中间结果与处理参数
  （页范围/跳过文字页）存 params_json/result_json。
- **文字 PDF 补充**：本地提取文字+超链接（依赖裁决：`pdfjs-dist` 纯 JS，页转
  图走 `@napi-rs/canvas` 预编译二进制；CP3 落地时以实测为准，若 canvas 不可行
  降级为"图片材料+文字 PDF 本地提取"两支，扫描 PDF 页转图记为已知限制）。
  "文字页跳过视觉读取"= 用户显式选项，不静默改变两阶段流程。网址优先级：原文
  > PDF 超链接 > 可解码二维码（二维码解码为可选增强，首版可缺省关闭）。
- **限制**：默认单文件 20MB / 单批 20 份 / 50 页（params 可调）；Promise 并发 +
  AbortController 取消，不持 DB 长事务、不阻塞主进程与既有 Agent 监控。
- **重复与合并**：UNIQUE(sha256) 文件级去重；相似比赛/延期通知展示新旧差异，
  用户确认后才合并，**不静默覆盖**；确认前草稿不进正式提醒。

## 6. OpenAI 兼容客户端与识别配置（CP3）

- `services/contestpin/openaiClient.ts`：electron-free、传输层注入（默认原生
  fetch + AbortSignal.timeout，仿 versionCenter/github.ts 范式）；Chat
  Completions 非流式，messages 支持 `image_url`（data URL base64，vision）；
  错误分类结构化：AUTH / RATE_LIMIT / TIMEOUT / BAD_RESPONSE /
  IMAGE_UNSUPPORTED / NETWORK；**usage 仅服务真实返回才标实测**（无 usage 字段
  → 'unknown'）。与 LR1 客户端不耦合（LR1=纯文本无鉴权 advisory；ContestPin=
  vision+鉴权+多配置超集，后续去重合并留作重构，本期不共享未落地代码）。
- 连接测试按角色分别测（vision 发 1x1 测试图、text 发 ping），写 last_test_ok/
  last_test_usage_json；鉴权/限流/超时/格式错误/图片不支持各有分类文案。
- **密钥红线**：key_sealed 只用 apihub keyStore `KeyCrypto`（生产=safeStorage，
  不可用即 KEYSTORE_UNAVAILABLE 拒绝，**绝不回退 base64**——plaintextKeyCrypto
  是模块默认值，必须显式经 `getKeyCrypto()` 取注入实现）；Renderer 只见掩码
  （maskKey 尾 4 位）；key 不进日志/备份/仓库/错误对象。
- **外部工具活动配置隔离**：识别配置独立于 `apihub_profiles`（后者语义=切换写
  外部文件）；ContestPin 绝不触碰 `apihub:switch` 与 ZCode/Codex 活动配置。

## 7. 提醒系统（CP4）

- `services/contestpin/reminderEngine.ts`（纯逻辑：due 计算/补发扫描/去重判定，
  可 smoke 直测）+ `notifyWire.ts`（Notification——全仓首用，AppUserModelID 已
  设置；powerMonitor resume/system clock change 事件触发重算）。
- 主进程模块级计时器句柄（仿 trayRefreshTimer），runQuitTeardown 最前清理；
  启动/休眠恢复/时间变化后扫 `contest_reminder_log` 缺口补发，fire_key 去重；
  节点 done 后停提醒；不承诺关机/彻底退出后实时提醒（charter §八原文）。
- 通知点击 → 主窗口对应比赛详情（同 §4.5 导航）。

## 8. Agent 模式（CP5）

- **能力矩阵（审计实测）**：codex = 唯一 managed（reply/pause/resume 逐方法
  验证，纯文本输入）；kimi = observed + 可选 managed reply（spawnArgs 未配置即
  unsupported）；claude-code/zcode/deepseek = 恒 observed 空能力集。
- **自动路径**（仅能力验证新鲜的 provider）：新 IPC `contestpin:agentSubmit` →
  L3 `startProviderManagedSession`（agentControlService.ts:1449 现成能力门/幂等/
  审计，不绕过不自建 spawn）；任务=材料本地文字提取+结构化指令纯文本注入；
  结果经监控管线+readMessages 提取 → 进同一 validated/核对管线，**不允许直接
  修改生产数据库**。
- **手动路径**（observed-only 或用户自选）：导出任务包（JSON：任务说明+材料
  清单/文字内容，风格参考 codexProvider consumeManagedTrigger `{task,requestId}`
  文件交接先例）→ 用户交给任意 Agent → `contestpin:importPack` 导入结果 → 同一
  校验/人工核对。
- 取消：monitorRegistry 取消令牌，只影响本任务及其托管会话，不终止其他任务。
- 无可用自动 Provider 时两阶段模式完整可用，不用模拟成功代替闭环。

## 9. 备份恢复（CP6）

- 导出：目标目录 = `manifest.json`（contests/nodes/reminders/materials 元数据，
  **结构性不含 contestpin_configs.key_sealed 与任何凭据**）+ `materials/` 附件
  文件夹复制（sha256 命名天然去重）；不破坏已有数据。
- 导入：manifest 解析 → 按 sha256/name+year 去重 → 待核对式导入（复用草稿核对
  界面），不静默覆盖。

## 10. 实施批次与验收

| 批 | 内容 | 验证（窗内=纯 Node） |
| --- | --- | --- |
| CP0 | 本设计 + docs/03/04 预告 + M1 任务书（docs 批） | 评审合入 |
| CP1 | 008 迁移 + resourceGraph/settings 扩展 + 9 channel + contestService CRUD/搜索/归档/关联 | tsc + smoke:fast（计数 79 + 迁移断言 + CRUD/精度/去重/资源边用例） |
| CP2 | overlayWire + #overlay 路由 + 托盘 + openInMain/openLink + 单实例收紧 | tsc + smoke:fast；**electron 实启动验证留窗毕**（悬浮 7 能力逐项目视） |
| CP3 | openaiClient + 识别配置 UI + 两阶段/多模态管线 + 核对界面 | tsc + smoke:fast + 隔离数据目录真实识别（需用户凭据，缺凭据明确标注） |
| CP4 | reminderEngine + notifyWire + 补发去重 | tsc + smoke:fast（引擎纯逻辑全测）+ 窗毕实机通知验证 |
| CP5 | Agent 自动/手动双路径 | tsc + smoke:fast + 窗毕 codex 实测 |
| CP6 | 备份恢复 + 打包 | 窗毕：全门禁（tsc/smoke 全量/mcp/:core/:app/ecs-relay）+ 真实启动验收 + 安装包（不替换在用程序、不发 Release） |

验收主线（charter §八）：手动新增→悬浮展示→点击官网→重启保留 → 两阶段识别/核对/
提醒 → 多模态+Agent → 备份打包。重点用例：日期精度、迁移、重复导入、延期合并、
部分页面失败、阶段独立重试、取消后晚到结果、缓存失效、Agent 能力不足、多窗口退出。

## 11. 红线核对表（28 条合同映射）

- 唯一 spawn=exec.ts（CP3 若引外部 PDF 工具必须走它；首选纯 JS 依赖零 spawn）；
  SQL 全参数绑定；migration append-only（007=LR1、008=ContestPin 已冻结）；
  Renderer 零系统权限/唯一网关；Service 唯一写库；资源关系走 resources+
  relationships；三态强制（比赛视图/悬浮窗/核对界面均 loading/empty/error）；
  smoke 只增不减（计数断言"就地更新+注记"唯一授权模式）；凭据三零（不入
  Renderer 返回值/日志/备份/仓库）；不擅自部署 ECS/发 Release/替换在用程序。
