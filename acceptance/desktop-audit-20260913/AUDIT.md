# D-Aud 桌面端三向审计报告（美观度 / 交互性 / 性能）

- 日期：2026-09-13；分支 `agent/desktop-audit`（基于 main a183700）；零代码改动（工具脚本 cd p.mjs / ui-helper.ps1 为审计器，非产品代码）。
- 审计对象：DevHub 桌面端 Electron renderer（源 `src/renderer/src/` views 13 + components 12 + lib 6 + App/OverlayApp + global.css 2003 行，合计约 1.1 万行）；在役常驻 dist/win-unpacked/DevHub.exe。
- 方法三轨：① 静态代码全走查 ② UI 走查（截图+交互抽样）③ 性能快测。
- 结论速览：**P0×0，P1×3，P2×13，P3×10**（美观 P2×4/P3×4；交互 P1×3/P2×6/P3×3；性能 P2×3/P3×3，其中 1 条为基线记录）。

## 0. 方法与偏差（如实）

- **护栏执行**：走查开始前前台探测 = Windows 锁屏（LockApp），光标 6 秒内零移动、且全程 27 分钟不变——用户不在场，非活跃使用，判定空闲窗口。
- **交互方式偏差（重要）**：原计划 computer-use 鼠标/键盘走查，但锁屏持有前台，`SetForegroundWindow` 被系统拒绝（不允许从锁屏夺焦点）。为不对锁屏/登录面做任何输入注入，**改为 CDP 零注入方案**：带 `--remote-debugging-port=9222` 重启一次 DevHub，经 DevTools 协议做 hash/DOM 导航、`Page.captureScreenshot` 截图、DOM 级交互抽样（click/input 事件均为页面内事件，零 OS 鼠标键盘注入）。未降级为"只截当前屏"——逐视图截图与交互抽样全部完成。测毕常驻已按无参方式拉回（health×3=200，9222 无监听）。
- 启动测量首次尝试因 `cmd start` 引号问题未拉起（DevHub 离线约 70 秒），即改 PowerShell `Start-Process` 恢复并重测 ×3。
- 会话详情 "Load more messages" 的运行时触发验证未完成（库内会话消息数均 <100），该条以代码逻辑入册（逻辑无歧义）。
- 凭据红线：全篇无配对码/token/key 入册（Agents 配对、ApiHub key、Relay 指纹均未触碰真实凭据面）。

## 1. 美观度桶

### P2

- **A1 文案语言系统性混用（已知线索 relativeTime 实锤，且范围更大）**
  - 定位：`lib/format.ts` relativeTime（"N 分钟前/刚刚"）vs 全英文表头（AgentsView "Last activity"）；徽章内混排 "verified 刚刚"、"last probe: 刚刚"（AgentsView.tsx L294/L394）；视图级分裂——Dashboard/Projects/Services/Environment/Docker 全英文 vs ApiHub（"ApiHub 接口中心"全中文）/Versions（"版本中心"中文表头+英文按钮 Check All/Update）/Contests（中文为主+New Contest 英文按钮）；ProjectDetailView 成功 toast "已打开"（L62）vs 失败英文（L64）；ContestDetailView 同屏 "取消编辑 / Edit"、"Delete" 与 "归档" 并排（L190-213）。
  - 证据：截图 02/11/12/08；代码行如上。
  - 修法：定一份 UI 语言规范（建议以现有"开发者工具英文壳+中文域内容"或全中文二选一），先统一 relativeTime/徽章时间词/toast。
  - 改动面：纯 UI（多文件文案）；若上 i18n 层则含逻辑。
- **A2 会话表所有行常驻蓝底，选中态对比度失效**
  - 定位：AgentsView.tsx L481 每行 `className="row-hit"`；global.css L527-529 `.table tr.row-hit { background: rgba(0,122,204,0.18) }` 无 hover/选中条件——本意应是可点击行的 hover 提示，实际变成全体常亮。
  - 证据：截图 14（810 行选中高亮与普通行差异微弱）。
  - 修法：`.row-hit` 仅保留 hover 着色，选中态专用 `.agents-row-selected` 加左侧 2px accent 边线。
  - 改动面：纯 UI（CSS 一处 + 类名语义）。
- **A3 内部规格编号泄漏到用户面**
  - 定位：AgentsView 面板标题 "PROVIDERS（D1/D2/D7 — 健康四值…）"、"Sessions（D3 —…）"（L1164/1173/1195/1202/1218/1229/1240/1245）；ArchiveView "History (archive_runs, latest 100 — includes imported legacy records)"（L415）；DeepSeek Harness healthDetail 直接渲染整段内部探测日志（截图 11 黄色大块："harness detected: root present… (never fabricated)"）。
  - 证据：截图 11/14；代码行如上。
  - 修法：用户面文案重写（编号进 tooltip 或 docs 链接）；healthDetail 默认折叠进 ExpandableText。
  - 改动面：纯 UI。
- **A4 越批次私造 token 回退值，颜色偏离权威色板**
  - 定位：global.css L1953-1978 `var(--text-dim, #9aa4b2)`（--text-dim 未定义，≠ --fg-dim #858585）；MaterialImportPanel.tsx L597-598 进度条 `var(--border,#888)/var(--accent,#4a7dff)/var(--err,#d55)`（--err 未定义；#4a7dff≠--accent #0e639c）；DraftReviewPanel.tsx ConfirmFaceModal 内联 `var(--border,#888)`；ArchiveView/global.css review-advisory 区同样式。
  - 证据：截图 12（草稿确认区边框色）；grep 全局 `var(--` 回退值清单。
  - 修法：统一替换为 --fg-dim/--accent-bright/--status-err 权威令牌，删尽 ad-hoc 回退。
  - 改动面：纯 UI。

### P3

- **A5 确认流三套形态并存**（native window.confirm×9 处 / 应用内 modal×3 处 / Docker window.prompt——后者已升 P1 见 I1）：统一为 cp-modal 式应用内确认组件。改动面：含逻辑（交互层统一组件）。
- **A6 空态图标语义错位**：EmptyState 一律圆斜杠"禁止"图标（截图 12"尚未导出"、Agents 空事件流），语义应为"空"而非"禁"。修法：换中性空盒图标或分域小图标。纯 UI。
- **A7 全站零过渡动画**：hover/按钮态瞬变（global.css 无 transition）。修法：统一 `transition: background-color .12s, border-color .12s`。纯 UI。
- **A8 Versions 未检测前全"未知"但 Update 可点**：初检前 "最新/目标" 全 "—"（截图 08）。修法：state=unknown 且 lastCheckedAt=null 时禁用 Update 并提示先 Check All。纯 UI+微逻辑。

## 2. 交互性桶

### P1

- **I1 Docker 容器 Remove 必然不可用（window.prompt 在 Electron 抛异常）**
  - 定位：DockerView.tsx L54 `window.prompt(...)`；grep 证实 preload/main 无任何 prompt 覆写。Electron 不支持 window.prompt（chromium 桥未实现，抛 "prompt() is and will not be supported."），异常被 runAction catch 兜住 → 用户只见错误 toast，**删除容器功能整体不可用**（两段式第一段已消耗）。
  - 证据：代码唯一 prompt 调用点；无运行时覆盖路径。docs/09 §8.1 要求"输入容器名匹配"。
  - 修法：改应用内 modal + 文本输入匹配（复用 ApiHub import-overlay / Archive DOUBLE_CONFIRM 模式）。
  - 改动面：含逻辑（renderer 内，不动主进程协议）。
- **I2 会话详情 "Load more messages" 实为"重载第一页"**
  - 定位：AgentsView.tsx L161-206 useCursorStream——`loadMore` 与 `refresh` 同为 `setTick(t=>t+1)`（L204-205），tick 在 deps 中 → effect 重跑执行 `cursorRef.current = undefined; setList([])`（L165-166）→ 游标与列表全重置，再拉 after=undefined 第一页；L177 的 append 分支（manual=true）为永不可达死代码。事件流同 hook 同隐患。
  - 证据：代码逻辑链完整；运行时未触发因无 ≥100 消息会话（偏差已注明）。
  - 修法：loadMore 改为手动追加路径 `once(true)`（保留轮询 tick 语义），或 effect 拆分"初始化"与"追加"。
  - 改动面：含逻辑（局部 hook 重写）。
- **I3 深链/路由脱钩：9/11 视图无 hash 路由，视图导航不回写 hash**
  - 定位：App.tsx L55-61 initialTarget 仅解析 `#agents`/`#contest:<id>`，其余全落 Dashboard；navigate（L81）不写 location.hash。运行时证据：CDP 截图回执 viewTitle 已切到 Projects…Contests 而 hash 停在 #services；F5/重开即丢视图态（托盘"查看 Agent 摘要"是唯一在用深链）。
  - 修法：navigate 同步写 hash + initialTarget 全视图映射（不必引 router）。
  - 改动面：含逻辑（小：App.tsx 两处）。

### P2

- **I4 Contests 首屏被工具面板淹没**：识别设置/材料导入/备份与恢复（默认展开两大空态）/待核对草稿平铺在上，比赛列表+分页被挤出首屏（截图 12）。修法：BackupPanel 默认折叠（对齐 DraftReviewPanel/MaterialImportPanel 收纳模式）或 tab 化。纯 UI。
- **I5 Skills 矩阵每次 toggle 强制 native confirm**（SkillsView.tsx L225-235）：高频链接操作两次弹窗。修法：直接 toggle + 可撤销 toast（危险向 real-dir 已禁用），或仅 vault-missing/wrong-target 弹确认。含逻辑。
- **I6 可点击表格行无键盘可达性**：Agents 会话行 `tr onClick` 无 tabIndex/Enter/role（对比 OverlayApp L168-176 正确做法）。修法：行加 tabIndex+keydown 或改语义按钮；顺带截断文本 title 提示对键盘用户不可达的问题。纯 UI+微逻辑。
- **I7 Services 进入即全量重扫阻塞**：ServicesView.tsx L22-26 useAsync 先 `services:refresh`（真实 netstat/WSL/Docker 扫描，数秒）再 list，Loading 期间无数据可看；refreshAll 也会触发。修法：先 `services:list` 渲染缓存，后台 refresh 完成原位更新（Dashboard F6 同款）。含逻辑。
- **I8 目录/文件全靠手输绝对路径**：BackupPanel destDir、Skills importDialog sourceDir、Archive destRoot、MaterialImport manual_pack destDir 均无原生选择器。修法：新增一个 `dialog:pickPath` IPC + 四处接入。含主进程+renderer。
- **I9 扫描轮询循环卸载不停**：ProjectsView.startScan（L37-55）与 ProjectDetailView.rescanGit（L70-94）`for(;;) sleep+scan:status` 在视图卸载后继续空转至终态（状态写入有 seq 防护，纯浪费 IPC）。修法：cleanup 置 cancelled 标志出循环。含逻辑。

### P3

- **I10 折叠面板仍轮询**：DraftReviewPanel 收起时 usePolling 3s 空转（MaterialImportPanel 是展开才挂载的正确对照）。修法：展开才挂 polling 子组件。含逻辑。
- **I11 无键盘快捷键**（F5/Ctrl+R 刷新、Ctrl+1..9 切视图、/ 聚焦搜索）。纯 UI。
- **I12 Toast 无队列**：每面板独立 useToast，同屏多操作时 bottom-right 相互覆盖（AgentsView 6+ 面板）。修法：App 级单例 toast 队列。含逻辑。

## 3. 性能桶

- 基线环境：Windows 10（26200），2048×1152@100%，Electron 44.1.1 / Node 24.19 / v0.1.0。

### P2

- **F1 Agents 视图轮询面 × 重渲染面叠加**
  - 定位：AgentsView.tsx L1084-1116 挂载即 6 个 2s 轮询器（providers/sessions/events/devices/gateway/diagnostics），选中会话再 +3（detail/messages/events，L521-539）；会话表 100→200 行无 memo、无虚拟化，每次轮询新数组→全表 reconciliation。
  - 证据：代码；运行时滚动仍流畅（169fps、0 长帧，见 F4 基线）——成本在主进程 IPC 频率与 CPU 空转，非帧率。
  - 修法：devices/diagnostics 降频（≥10s）、行组件 React.memo、可见性暂停（视图不可见即停已由卸载保证，面板级 IntersectionObserver 可选）。
  - 改动面：含逻辑。
- **F2 renderer 单 bundle 931KB 无代码分割**
  - 定位：out/renderer/assets/index-*.js 931,463 B + index-*.css 36,778 B；13 视图全量同步 import（App.tsx），无 React.lazy。
  - 证据：out/ 产物实测；app.asar 57.6MB（含依赖）。
  - 修法：路由级 lazy+Suspense（与 I3 路由修正同批做收益最大）。
  - 改动面：含逻辑+构建配置。
- **F3 Services 表 656 行无上限渲染 + 疑似数据累积**
  - 定位：ServicesView 全量 sort+map（L124-152）；运行时 62 record(s) 的刷新却渲染 656 行——`services:list` 返回行数远超单次刷新记录数，疑似主进程保留历史取样未裁剪（或 WSL/Windows 重复归因），**建议主进程侧核查**；renderer 侧无渲染上限保护。
  - 证据：CDP DOM 计数 656 vs 头部 "last refresh saw 62 record(s)"。
  - 修法：renderer 加显示上限/分组去重；主进程核 per-port 采样生命周期。含逻辑（待查因）。

### P3（含基线记录）

- **F4 启动时长基线（良好，无需修）**：杀常驻→分离启动→gateway `GET /v1/health` 200 时刻，×3 = 1336/1321/1321 ms，**中位 1321ms**（含 PowerShell 拉起 ~300ms 开销，同法同偏，公平中位）。
- **F5 内存基线**：5 进程（main/gpu/utility/renderer×2）常驻总 WS 启动稳态 ≈465MB（156.7+100.3+47.8+79.0+81.6MB）；重视图走查后（200 会话+200 事件+656 服务行）≈575MB（182.8+117.6+48.8+140.4+85.7MB）。Electron 常规范围，无泄漏征兆（重启回落）。JS 堆指标未采（Performance.enable 遗漏），实现批可补。
- **F6 relativeTime 无自动时效刷新**：非轮询视图的"N 分钟前"直到手动刷新才变（Dashboard Recent Projects）。影响小、与轮询机制取舍相关（见注记），如需修：低频全局 1min tick。纯 UI+微逻辑。

## 4. 设计决策注记（非缺陷）

- **深色钉死**：VS Code Dark+ 参照系（global.css 头注、docs/06-ui-ia），BrowserWindow backgroundColor #1e1e1e。若产品要浅色主题属新需求，需令牌层重构（所有视图色值已走 CSS 变量，改造面可控——但 A4 的私造回退值是先行债务）。
- **useState 路由、零 router 依赖**：docs/00 约束 #23/#24 明确自研。I3 修法在该决策内完成，不需引包。
- **轮询代替推送**（docs/14 §A.3 游标轮询、R6 promise 链）：架构决策。F1 只调频率与渲染面，不动机制。
- **内联 SVG 图标、无图标库**：风格统一度高，保持。
- **截断文本 tooltip + ExpandableText**：Step 8c F4 既定形态；键盘可达性缺口归入 I6 一并处理。
- **凭据脱敏纪律执行到位**（正面记录）：ApiHub key 仅尾 4 位、配对码一次性显示、Devices 表无 token 字段、Backup manifest 零凭据——本审计未在任何 UI 面发现凭据暴露。

## 5. 性能与走查原始数据

- 启动×3：1336 / 1321 / 1321 ms（→ health 200；测毕常驻拉回 health×3=200，uptimeSec 8 起表）。
- 滚动帧率（Agents 会话表 100 行，3s 合成滚动）：169.3 fps，长帧（>32ms）0，scrollHeight 5046px。
- Services 过滤（DOM input 事件 "8080"）：事件派发 0.5ms 级，即时出"No matches"空态；清除后全表 656 行恢复无卡顿。
- 会话表 Load more（sessions limit 机制）：100→200 行生效（服务端 limit 提升，正常）。
- 走查覆盖：11 个主视图 + 悬浮窗（折叠态，"赛程钉 · 1 项"）+ Agents 会话详情（点击行→面板 2 表加载）。
- 常驻状态收尾：PID 34260（无调试端口），health×3 = 200/200/200；9222 无监听。

## 6. 证据清单（本目录）

| 文件 | 内容 |
| --- | --- |
| screens/00-idle-lockscreen-before.png | 走查前护栏证据：锁屏+时间 22:27（用户不在场） |
| screens/01-dashboard.png | 全屏截图尝试（锁屏覆盖态，佐证未夺焦点） |
| screens/02-dashboard.png | Dashboard：stat 卡/警告区/relativeTime 中文混排 |
| screens/03-projects.png | Projects 主从布局 + 详情 |
| screens/04-environment.png | Environment 加载态 + WSL 卡 |
| screens/05-services.png | Services 过滤 "8080" No-matches 空态 |
| screens/06-skills.png | Skills vault 条+矩阵 |
| screens/07-apihub.png | ApiHub 全中文视图+key 掩码 |
| screens/08-versions.png | 版本中心中文表头/未知态/Update 可点 |
| screens/09-docker.png | Docker（daemon offline 降级横幅） |
| screens/10-archive.png | Archive 设置条+选择器（I1 无关，历史区空态） |
| screens/11-agents.png | Agents Provider 卡区：D1/D2/D7 标题泄漏、verified 刚刚、DeepSeek 内部日志块 |
| screens/12-contests.png | Contests 首屏被备份空态淹没（I4）、A6 禁止图标 |
| screens/13-agents-sessions.png | Agents 事件流表（滚动至中段） |
| screens/14-agents-session-detail.png | 会话表选中行（A2 对比度）+ 过滤工具条 |
| screens/15-overlay.png | ContestPin 悬浮窗折叠态 |
| cdp.mjs / ui-helper.ps1 | 审计工具（CDP 零注入走查 / 前台探测与全屏截图） |
