# DevHub UI 信息架构（Phase 1；S2-S4 批次按 docs/09 §8/§9 追加视图）

## 1. 视觉风格

- **深色开发者工具风格**，参考 VS Code Dark+ / GitHub Dark 色系。
- 色彩令牌（CSS variables，Step 7 落地为全局样式）：

| 令牌 | 值（参考） | 用途 |
| --- | --- | --- |
| `--bg` | #1e1e1e | 内容区背景 |
| `--bg-panel` | #252526 | 侧边栏 / 卡片 / 面板 |
| `--bg-elevated` | #2d2d30 | 悬浮 / 下拉 |
| `--border` | #3c3c3c | 分隔线 |
| `--fg` | #d4d4d4 | 主文字 |
| `--fg-dim` | #858585 | 次要文字 |
| `--accent` | #0e639c / #007acc | 主操作 / 选中态 |
| `--status-ok` | #4ec9b0 | installed / running / done |
| `--status-warn` | #cca700 | warn / dirty |
| `--status-err` | #f14c4c | error / failed |

- 字体：UI 用系统无衬线；版本号 / SHA / 端口 / 路径用等宽字体（Consolas / Cascadia Mono）。

## 2. 整体布局

```
┌──────────────────────────────────────────────────┐
│ Topbar: DevHub · <当前视图名>        (窗口控制区) │
├──────────┬───────────────────────────────────────┤
│ Sidebar  │  Content（当前视图）                   │
│ ◈ Dashboard                                        │
│ ◈ Projects   固定宽度侧边栏：图标 + 文字，          │
│ ◈ Environment 高亮当前项；不折叠。                  │
│ ◈ Services                                         │
│ ◈ Skills / ApiHub / Versions (S2/S3)               │
│ ◈ Docker (S4)                                      │
│ ◈ Archive（S5 已启用）                              │
│ ◈ Agents（AC5 已启用）                              │
│ ◈ Contests（CP2 已启用，赛程钉）                     │
└──────────┴───────────────────────────────────────┘
```

- 导航顺序（CP2 起最终形态）：Dashboard / Projects / Environment / Services /
  Skills / ApiHub / Versions / Docker / Archive / Agents / Contests（CP2 批次
  追加 Contests，docs/22 §2/§4）。
- 数据获取统一走 `window.devhub.invoke(channel, payload)`（单一网关，docs/04）。

## 3. 视图信息架构（Phase 1 四视图 + S2-S4 追加视图）

### 3.1 Dashboard

- 统计卡片网格（一行 3–4 张）：Projects 总数 / Git dirty 仓库数 / Docker 容器数（running/total）/ WSL 状态 / 本地服务数。
- 最近使用项目列表（last_opened_at 倒序，Top 5，可点击进 Projects 详情）。
- 异常警告列表（severity 图标 + 标题 + 详情；如 Docker daemon unreachable）。

### 3.2 Projects

- 左右分栏：左侧项目列表（搜索框 + 列表项：名称、路径摘要、dirty 标记）；右侧详情。
- 详情分区块：
  - **Location**：win_path / wsl_path / last_opened_at
  - **Git**：remote、branch、head_sha、ahead/behind、dirty 文件数、last_status_at
  - **Runtime**：runtime_hint、关联 environment
  - **Docker**：关联容器（name/image/state/ports）
  - **Services**：归因到该项目的端口列表
- 操作按钮组：Open Folder / Open VS Code / Open Terminal / Open in WSL / Git Status。
- 列表上方操作：Add Project（手动添加对话框）、Rescan。

### 3.3 Environment

- Windows 与 WSL **双栏对比表**：同一工具一行，左 Windows 值、右 WSL 值。
- 列：Tool / Version / Installed / Path（截断悬停）/ 状态点。
- WSL 不可用时右栏显示结构化降级文案（`DEGRADED: <原因>`），不留空白（约束 #26）。
- Doctor 诊断卡片列表：severity 徽标 + 标题 + detail + suggestion（真实诊断：
  Python 3.9 vs 3.13 并存、WSL Node 18 vs Win Node 24、Docker daemon 状态等）。
- **WSL 发行版卡片区（S4，docs/09 §8.2）**：每发行版一张卡（state 徽章 / WSL 版本 /
  default 标记），卡上系统概要（uptime / mem used/total，取自 `wsl:distroStats`
  的一次 /proc 复合读取；探测不到隐藏不猜）+ 动作按钮：Boot（无害幂等，直接执行）、
  Terminate（CONFIRM_REQUIRED 两段式，确认弹窗列出该发行版当前监听端口 impacts）。
  docker-desktop 系由 Docker Desktop 管理：只显示状态，不给动作、不取数。

### 3.4 Services

- 端口归因表格，列：Port / PID / Process / Origin / Project / CommandLine（截断）。
- 顶部：端口搜索框（数字过滤，前端过滤 services:list 的 port 参数或本地过滤）+ Refresh 按钮（触发 services:refresh）。
- Origin 列以徽标区分 windows / wsl / docker；Project 列可点击跳转项目详情。

### 3.5 Docker（S4，docs/09 §8.1）

- 数据源：`docker:overview` 单次探测三合一（info + containers + images）。
- **daemon 状态横幅**：online → 轻量信息行（client/server 版本）；down →
  `Docker: daemon unreachable (engine-down)` 降级横幅 + 结构化 reason 可展开
  （ExpandableText），容器/镜像区显示引导空态，绝不白屏（约束 #26）。
- 容器表：Name / Image / State 徽章 / 端口映射 / 关联项目（归因不到显式 unknown）；
  每行动作：Start / Stop / Restart（CONFIRM_REQUIRED 两段式 —— 第一段返回 impacts
  （容器现状/发布端口/关联项目）经确认弹窗展示，确认后带 `confirmed` 重发）+
  Logs（内联日志面板：tail 100/200/500 选择、Reload/Close；输出超 64KB 提示截断，
  ok:false 显示结构化原因）。
- 镜像表：Repository / Tag / ID / Size / Created（CreatedSince 优先），表头带
  简要统计（count + dangling 悬空镜像数）。
- remove 强确认（DOUBLE_CONFIRM）与 shutdownAll 留待后续批次（任务书 S4 范围为
  start/stop/restart 与 terminate/boot）。

## 4. 三态规范（约束 #24）

每个视图（及详情子区块）必须实现：

| 状态 | 表现 |
| --- | --- |
| loading | 骨架屏或居中 spinner，禁止布局跳动 |
| empty | 空态插画/图标 + 一句说明 + 引导动作（如 Projects 空态提供 Rescan / Add） |
| error | 错误图标 + `error.code` + `error.message` + Retry 按钮（数据来自 Result envelope） |

数据获取模式：视图挂载即 invoke；对 scan/refresh 类操作轮询 `scan:status` 直到终态后重新拉取数据。

### 4.1 Contests（比赛视图，CP2，docs/22 §2/§4）

- 左右分栏（仿 Projects）：左侧列表（搜索框按名称/年份、状态筛选、含已归档开关、
  分页 20/页）+ 右侧详情。列表行显示名称/年份/状态徽标/归档标记 + dueNode 一行
  摘要（临近节点 + 剩余天数）。
- 新建/编辑表单：名称（必填）/年份（可空，缺少年份不编造）/届次/主办方/备注/
  状态（watching/registered/submitted/completed/given_up）/三链接 URL（仅
  http/https，service 校验）。
- 详情区块：信息（备注/三链接/时间戳）、时间节点列表（kind 标签 + label +
  precision 感知时间展示——`date` 显示"日期 · 未注明具体时刻"、`tbd` 显示
  "时间待定"、`month` 仅年月；done 标记 + 当前节点/过期未完成红标 + 节点增删改，
  低精度→exact 需原文依据）、关联项目选择器（resources `uses` 边）。
- 删除为 CONFIRM_REQUIRED 两段式确认弹窗（展示 impacts：节点/材料/提醒计数）；
  归档/取消归档即时生效。
- 全部数据经真实 IPC 无 mock（约束 #23），loading/empty/error 三态（约束 #24）。

### 4.2 比赛悬浮窗（#overlay，CP2，docs/22 §4）

- 同一 renderer 产物按 hash 分流：`#overlay` 渲染精简 OverlayApp（无侧栏/顶栏），
  `#contest:<id>` 进主窗口比赛详情（悬浮窗卡片 / 后续通知入口共用导航）。
- 展开态：紧凑卡片列表（比赛名/年份 + dueNode（过期 → "过期未完成"红标）+
  日期 + 剩余天数 + 官网/报名/提交入口按钮）。折叠态：单行摘要（比赛计数 +
  最近节点），切换经 `contestpin:overlaySetCollapsed`。
- 整窗 CSS `-webkit-app-region: drag` 拖动区，按钮/卡片交互位 no-drag；卡片
  主体点击 → `contestpin:openInMain`。数据 usePolling 轮询 `contestpin:list`
  （5s，主窗口隐藏时照常工作）。三态强制（约束 #24）。
- 窗口行为（主进程 overlayWire）：置顶/无边框/不进任务栏，位置尺寸记忆 +
  显示器变化回可见区，close=hide，退出随 teardown 销毁；开关 = 托盘
  「比赛悬浮窗」checkbox（settings `contestpin_overlay_enabled`）。
