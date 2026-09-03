# DevHub 需求说明（Phase 1）

## 1. 项目定位

DevHub 是运行在开发者个人 Windows PC 上的 **Development Control Plane**（开发控制平面）：
统一**发现 / 管理 / 关联** Windows、WSL、Docker、Git、开发项目与开发服务。

- **Project 是一等公民。** 其他资源（Git 仓库、运行环境、容器、服务、端口）围绕 Project 建立关系，而不是孤立罗列。
- DevHub 回答的核心问题：
  - 我有哪些项目？它们分布在哪个盘 / 哪个 WSL 发行版？
  - 某个项目关联了哪些仓库、运行时、容器、服务？
  - "谁占用了 8080 端口？"——它属于哪个环境、哪个进程、哪个项目？
  - 我本机的开发工具链是否健康？两套环境（Windows / WSL）版本是否一致？
- **不是 AI 产品，不是工具启动器。** 不集成大模型，不做 launcher 式的"快捷按钮合集"。

## 2. Phase 1 范围：四个模块 + SQLite 持久化

Phase 1 只做以下四个视图，全部真实数据、无 mock：

### 2.1 Dashboard

统计卡片网格 + 最近使用项目 + 异常警告列表：

| 数据项 | 来源 |
| --- | --- |
| Projects 数量 | projects 表 |
| Git dirty 仓库数 | repositories 表（is_dirty） |
| Docker 容器数（running/total） | containers 表 + docker adapter |
| WSL 状态（发行版列表 / 不可用原因） | wsl adapter |
| 本地服务（监听端口）数 | services 表 |
| 最近使用项目 | projects.last_opened_at 排序 |
| 异常警告 | 聚合各模块 error_summary 与降级状态 |

### 2.2 Projects

- **自动发现**：扫描 `scan_root`（种子值 `F:\Active_Project`）下的一级目录，识别含 `.git`、`package.json`、`pyproject.toml` 等标志物的目录为候选项目。
- **手动添加**：可添加扫描根之外的任意目录为项目。
- **项目可关联**：Windows 路径、WSL 路径、Git 仓库、Docker 容器、运行时（runtime_hint）、服务（端口归因自动回链）。
- **详情页**：展示项目的完整关系（Location / Git / Runtime / Docker / Services 分区块）。
- **操作**：Open Folder（资源管理器）、Open VS Code、Open Terminal、Open in WSL、Git Status。全部经 Main Process exec 内核以受控方式打开。

### 2.3 Environment

检测 **Windows 与 WSL 两套工具链**，同一组工具双环境对比：

- 检测项：Node / npm / pnpm / Python / Git / Docker / CMake / GCC / VS Code 等。
- 每项显示：版本号、是否安装（installed / missing / error）、可执行文件路径、诊断信息。
- **Environment Doctor**：输出真实诊断结论，本机已知基线包括：
  - Python 3.9 与 3.13 并存（需提示默认解释器歧义）；
  - WSL 内 Node 18.19.1 与 Windows Node 24.15 不一致（跨环境开发需注意）；
  - Docker CLI 已安装但 daemon 经常不可用（降级显示状态，不报错）；
  - Git 2.54。

### 2.4 Services

综合四个数据源建立 **port → process → environment → project 归因链**：

- Windows 进程与 TCP 端口（netstat / Get-NetTCPConnection）
- WSL 进程与端口
- Docker 容器端口映射
- 能直接回答："谁占用了 8080？"——端口、PID、进程名、命令行、所属环境（windows / wsl / docker）、归属项目。
- 支持按端口搜索与手动 refresh。

### 2.5 持久化

- SQLite（Electron 内置 `node:sqlite` 的 `DatabaseSync`，零原生编译依赖）。
- 14 张表 + 参数绑定 + migration 机制，见 docs/03-database.md。

## 3. 非目标（明确不做）

- 不做本地 AI、不集成任何大模型。
- 不做 Portainer、GitKraken、VS Code 的复制品（不做容器编排 UI、不做 Git 图形化操作台、不做编辑器）。
- 不追求一次实现所有模块：Phase 1 只做上述四视图。
- 不做多人协作 / 云同步 / 账号体系。
- 不做资源修改类操作（不改系统配置、不杀进程、不写注册表）。

## 4. 后续扩展（Phase 1 之后，仅登记方向）

Git 深度集成（log/diff）、Docker 管理（启停/日志）、WSL 管理（发行版操作）、
Skills、MCP servers、Archive（项目归档）、Devices（远程设备）、
Resource Graph（基于 resources/relationships 的全局关系图）、Backup、Automation。
