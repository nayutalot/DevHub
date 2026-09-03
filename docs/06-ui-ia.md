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
└──────────┴───────────────────────────────────────┘
```

- 导航顺序（AC5 起最终形态）：Dashboard / Projects / Environment / Services /
  Skills / ApiHub / Versions / Docker / Archive / Agents（十视图全部启用：
  Agents 随 AC5 托盘批次完成，docs/11 §5 / docs/16 §1 AC5 行）。
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
