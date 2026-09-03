# DevHub

Windows 桌面开发环境控制中心 —— 一个运行在开发者个人 PC 上的 **Development Control Plane**：
统一发现 / 管理 / 关联 Windows、WSL、Docker、Git、开发项目与开发服务。
**Project 是一等公民**，其他资源围绕 Project 建立关系。

Phase 1：Dashboard / Projects / Environment / Services 四视图 + SQLite 持久化，全部真实数据、无 mock。

Phase 2 / M2：**只读 MCP Server**（stdio transport）——外部 AI（ZCode / Claude Code / Codex 等
MCP Client）通过 MCP 协议读取 DevHub 对开发环境的真实认知。12 tools（全 READ_ONLY）+ 6 resources
+ 4 prompts + 权限框架。设计权威见 `docs/08-mcp-design.md`。

## 技术栈

| 项 | 选型 |
| --- | --- |
| 运行时 | Electron 44.1.1 |
| 构建 | electron-vite 5 + Vite ^7 + TypeScript（严格模式） |
| UI | React 19 |
| 数据库 | `node:sqlite`（DatabaseSync，零原生依赖） |
| MCP | `@modelcontextprotocol/sdk` 1.30.0 + `zod` 4.5.4（stdio transport，独立 Node 进程） |
| 源 | npmmirror（依赖 + Electron 二进制镜像） |

## 目录结构

```
DevHub/
├─ docs/                 设计文档（00 约束合同 … 07 开发计划、08 MCP 设计），编码的权威依据
├─ scripts/
│  ├─ smoke.mjs          smoke 测试 harness（用例只增不减）
│  ├─ run-mcp.mjs        MCP Server 进程入口（stdio；logger 镜像改道 stderr）
│  └─ fetch-electron.mjs 经 npmmirror 镜像下载 Electron 二进制
├─ src/
│  ├─ main/              主进程：core(exec/paths/logger) / adapters / services / db / ipc
│  │  └─ mcp/            MCP Server（server / permissions / transport / projection / tools / resources / prompts）
│  ├─ preload/           sandbox 化 preload（仅暴露 invoke）
│  ├─ renderer/          React UI（index.html + src/main.tsx）
│  └─ shared/            IPC 契约与类型（main/renderer 共用）
├─ electron.vite.config.ts
├─ tsconfig.json
└─ package.json
```

## 开发命令

```bash
npm install --registry=https://registry.npmmirror.com   # 安装依赖
node scripts/fetch-electron.mjs                          # 下载 Electron 二进制（npmmirror 镜像）
npm run dev        # 启动开发模式（electron-vite dev）
npm run build      # 产出 out/
npm run typecheck  # tsc --noEmit
npm run smoke      # node scripts/smoke.mjs
npm run mcp        # node scripts/run-mcp.mjs（MCP Server，stdio）
```

## MCP Server（只读）

- 启动：`npm run mcp`（即 `node scripts/run-mcp.mjs`）。进程经 stdin/stdout 走 JSON-RPC，
  stdout 只承载协议帧 —— logger 镜像与就绪日志全部走 stderr（`DevHub MCP server ready`）。
- 数据：与 Electron 主进程共享同一 SQLite（`%APPDATA%\devhub\devhub.db`，WAL +
  busy_timeout=5000）；App 未运行不影响 MCP。设置 `DEVHUB_HOME` 可指向隔离数据目录
  （便携 / 测试模式）。
- 12 tools（全部 READ_ONLY）：`devhub.environment.detect` / `devhub.environment.doctor` /
  `devhub.projects.list` / `devhub.projects.get` / `devhub.services.list` /
  `devhub.services.inspect` / `devhub.docker.status` / `devhub.docker.containers` /
  `devhub.wsl.status` / `devhub.wsl.distributions` / `devhub.git.status` /
  `devhub.dashboard.summary`。
- 6 resources：`devhub://dashboard` `devhub://environment` `devhub://projects`
  `devhub://services` `devhub://docker` `devhub://wsl`（面向 LLM 的 Markdown）。
- 4 prompts：`devhub.diagnose_environment` `devhub.inspect_project` `devhub.find_port_owner`
  `devhub.review_development_environment`。
- 归因纪律：端口 / 容器归因不到项目时显式返回 `"unknown"`，绝不猜测。

### 接入配置（mcpServers 片段）

MCP Client 会以**精简环境变量**启动 stdio server：请一律用绝对路径（Windows 建议正斜杠）；
`run-mcp.mjs` 入口已自动补种 Windows 默认 `PATHEXT`（M3 验收发现：精简 env 缺 PATHEXT 时
where.exe 工具链探测会静默退化）。可选 env：`DEVHUB_HOME`（隔离/便携数据目录）、
`DEVHUB_LOG_LEVEL`（日志阈值）。以下示例为本机真实路径。

ZCode（用户级 `~/.zcode/cli/config.json` 或项目级 `.zcode/config.json` 的 `mcp.servers`
嵌套键；schema 严格，未知键会被静默丢弃）：

```json
{
  "mcp": {
    "servers": {
      "devhub": {
        "command": "node",
        "args": ["F:/Active_Project/DevHub/scripts/run-mcp.mjs"]
      }
    }
  }
}
```

> 同作用域的 `.agents/mcp.json` 是回落形态（仅当该作用域 `.zcode` 未定义任何 MCP server
> 时生效），键为顶层 `mcpServers`，字段同名。

Claude Code（`claude mcp add devhub -- node F:/Active_Project/DevHub/scripts/run-mcp.mjs`
或项目 `.mcp.json`，键为顶层 `mcpServers`）：

```json
{
  "mcpServers": {
    "devhub": {
      "command": "node",
      "args": ["F:/Active_Project/DevHub/scripts/run-mcp.mjs"]
    }
  }
}
```

Codex（`~/.codex/config.toml`）：

```toml
[mcp_servers.devhub]
command = "node"
args = ["F:/Active_Project/DevHub/scripts/run-mcp.mjs"]
```

> 设计文档是唯一权威：修改行为前先改 docs/，见 `docs/00-execution-constraints.md`。

## Phase 2/3（已落地）：Agent Control / Mobile

把 DevHub 扩展为「开发控制平面 + 本机 AI Agent 统一监控与受限遥控面」：五家本机 Agent
（Codex / Claude Code / Kimi / ZCode / DeepSeek Harness）的会话与事件真实汇聚到新增的
Agents 视图（7 状态 + 脱敏投影，绝不猜测实时态）；Electron Main 内嵌 Remote Gateway
（默认 127.0.0.1、默认关闭）经 NatPierce 隧道连接 Android 手机（工程位于 `android/`，
Kotlin + Compose + Room + OkHttp + Keystore，第一版无 FCM），实现 waiting_input →
手机通知 → 手机回复的端到端闭环；控制仅限 reply/pause/resume 且必须能力真实验证
（ZCode 首版全部 observed 全禁）；MCP 本期零改动。设计权威：需求 `docs/11`、
架构 `docs/12`、数据库（migration 004）`docs/13`、API `docs/14`、安全 `docs/15`、
批次计划 `docs/16`。

已落地：五家 Provider 适配（`src/main/services/agentControl/providers/`，健康探测 +
会话/事件汇聚 + reply/pause/resume 受控执行）、托盘常驻摘要（`traySummary.ts`）、
Agents 视图、Remote Gateway（`agentControl/gateway/`，配对 + 事件投递）、
Android App（`android/`）、NatPierce 配置面（`natpierce.ts` 外置配置投影）；
文档索引 `docs/11`–`docs/16`。
