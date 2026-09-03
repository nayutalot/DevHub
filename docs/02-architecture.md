# DevHub 架构设计（Phase 1）

## 1. 分层架构

```
Electron Main Process
 ├─ core/
 │   ├─ exec.ts        唯一 spawn 入口（参数数组、超时、结构化捕获、交互窗口启动）
 │   ├─ paths.ts       用户数据目录 / DB 路径 / 资源路径解析
 │   └─ logger.ts      结构化日志（脱敏，约束 #13）
 ├─ adapters/          只读探测层（约束 #19），返回结构化结果
 │   ├─ windows.ts     进程 / TCP 端口 / 已安装工具（PowerShell 静态字面量 + $env: 传参）
 │   ├─ wsl.ts         wsl.exe 探测：发行版列表、WSL 内进程与端口、WSL 工具链
 │   ├─ git.ts         git 探测：status / branch / head / ahead / behind（只读子命令）
 │   ├─ docker.ts      docker ps / port 映射；daemon 不可用时返回结构化降级状态
 │   └─ fs.ts          扫描根目录下的项目发现（.git / package.json / pyproject.toml）
 ├─ services/          编排层（约束 #16/#20）：扫描编排、端口归因、Environment Doctor、
 │                     取消（scan:cancel）、容错降级；唯一写 SQLite 的层
 ├─ db/
 │   ├─ database.ts    node:sqlite DatabaseSync 封装（WAL、参数绑定辅助）
 │   └─ migrations/    001_init.sql 起，PRAGMA user_version 字面量管理（约束 #11/#21）
 └─ ipc/
     └─ gateway.ts     唯一 IPC 网关：channel `devhub:invoke`，白名单分发（约束 #17）
            │
            │  IPC boundary — Result envelope: { ok: true, data } | { ok: false, error: { code, message } }
            ▼
Renderer (React 19, sandboxed preload — contextBridge 仅暴露 invoke，约束 #15/#18)
```

数据流向唯一：`Renderer → devhub:invoke → gateway(白名单) → service → adapter/core → 结构化结果 → Renderer`。
Renderer 永远不直接触达 adapter / db / exec。

### 1.1 paths 策略（跨进程 DB 对齐）

数据目录（DB 与日志的根）由 `src/main/core/paths.ts` 的 `getDataDir()` 按四级回落解析：

1. `process.env.DEVHUB_HOME` 覆盖（测试 / 便携模式；smoke 全部用例经它隔离）；
2. Electron main 进程内 `app.getPath('userData')`（动态 require 获取，生产运行形态）；
3. **纯 Node 进程回落（MCP Server / smoke 等系统 Node 场景）**：与 Electron userData 指向
   同一目录 —— Windows 为 `%APPDATA%/<应用数据目录名>`，非 Windows 为
   `~/.config/<应用数据目录名>`；应用数据目录名取 package.json 的
   `productName`（缺省 `name`），与 Electron `app.getName()` 推导规则一致；
4. 极端兜底（环境变量缺失 / package.json 不可读）：`<项目根>/data`。

第 3 级是 MCP 集成的关键前置：MCP Server 是独立 Node 进程（stdio transport，docs/08），
不依赖 Electron 运行。回落与 userData 对齐后，MCP 进程与 Electron 主进程共享同一
SQLite 文件（WAL + busy_timeout=5000 支持多进程读 + 单写者语义），避免 MCP 打开另一个空库。

## 2. exec 内核规则（src/main/core/exec.ts）

exec 是全项目唯一 spawn 入口（约束 #7），规则：

1. **参数数组**：`spawn(file, args[])` 形式，不设置 `shell: true`（约束 #8）。
2. **默认 15s 超时**：超时 kill 进程树，返回 `{ ok:false, error:{ code:'EXEC_TIMEOUT', message } }`（约束 #9）。
3. **双解码**：Windows 工具输出可能是 UTF-16LE BOM 或 UTF-8，内核先检测 BOM 再选择解码，兜底 UTF-8。
4. **结构化返回**：`{ stdout, stderr, exitCode, durationMs }`（约束 #10）；调用方负责转换为领域结果。
5. **launchViaStartProcess**：打开资源管理器 / VS Code / 终端等交互窗口时，统一走
   `Start-Process`（PowerShell 静态字面量，动态值经 `$env:` 传入，约束 #12）；
   不使用 `detached + stdio:'ignore' + unref` 组合。
6. **取消传播**：Service 层发起的扫描取消会终止仍在运行的 exec 调用。

## 3. 错误模型

- 领域错误统一结构：`{ code, message }`，code 取稳定枚举值：
  - `EXEC_TIMEOUT` 外部命令超时
  - `EXEC_FAILED` 外部命令非零退出（携带 exitCode 与 stderr 摘要）
  - `CHANNEL_NOT_ALLOWED` 未注册的 IPC channel
  - `NOT_FOUND` 目标项目 / 资源不存在
  - `DB_ERROR` SQLite 操作失败
  - `DEGRADED` 探测对象不可用（Docker daemon unreachable、WSL 未安装等），携带 `detail`
  - `BAD_PAYLOAD` 请求 / payload 形状非法（网关参数校验拒绝；Step 6 已实现，Step 7 决议同步入文档枚举）
  - `INTERNAL` 非领域意外异常的折叠码（message 无堆栈无路径细节，细节仅入主进程日志；Step 6 已实现，Step 7 决议同步入文档枚举）
- Adapter 不抛异常到 Service 之外：单项失败封装为 `DEGRADED` 结果，由 Service 汇总进 `scans.error_summary`（约束 #25）。
- IPC 网关把一切异常折叠为 `{ ok:false, error }` envelope，Renderer 永远收到可渲染的结构（约束 #14）。

## 4. 容错原则

- 扫描 = 多个独立探测步骤的编排；任何一步失败只影响自身，不中断整体（约束 #25）。
- Docker：CLI 存在但 daemon 不可用是常态而非异常，返回结构化状态 `daemon unreachable`，UI 正常渲染。
- WSL：未安装 / 无发行版时返回 `DEGRADED`，Environment 双栏对比中 WSL 侧显示不可用原因。
- 每次扫描在 `scans` 表留下 running → done/cancelled/failed 的完整生命周期记录。

## 5. 技术栈基线（已锁定，不可更改）

| 项 | 选型 | 备注 |
| --- | --- | --- |
| 运行时 | Electron 44.1.1 | 二进制经 npmmirror 镜像下载 |
| 构建 | electron-vite 5 + Vite 7 | **Vite 必须钉 ^7**：vite@8 与 electron-vite 不兼容 |
| UI | React 19 + TypeScript 严格模式 | |
| 数据库 | `node:sqlite`（DatabaseSync） | Electron 内置，零原生依赖 |
| 依赖源 | npmmirror | `registry.npmmirror.com`；Electron 走 `ELECTRON_MIRROR` |
