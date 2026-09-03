# DevHub Phase 1 开发计划（9 Steps）

> 每步开工前重读 docs/00-execution-constraints.md；每步完成必须 `npx tsc --noEmit && node scripts/smoke.mjs` 全绿。
> 约束 #27：smoke 用例每步至少 +1，只增不减。

## Step 0 —— 设计文档 + 脚手架 + 依赖（本步）

**交付物**
- docs/00–07 全套设计文档 + README.md
- 脚手架：package.json / electron.vite.config.ts / tsconfig.json / src 骨架（main、preload、renderer 占位）/ scripts/smoke.mjs / scripts/fetch-electron.mjs / .npmrc / .gitignore
- npm 依赖安装（npmmirror）+ Electron 44.1.1 二进制下载（npmmirror 镜像）

**验收**
- `node_modules/electron/dist/electron.exe` 存在
- `node -e` 验证 node:sqlite DatabaseSync 可建表
- `npx tsc --noEmit` 全绿；`node scripts/smoke.mjs` 输出 `1/1 passed`

## Step 1 —— shared 契约

**交付物**：`src/shared/` 下定义 IPC channel 白名单常量、Result envelope 类型、各 channel 的 payload/result TypeScript 类型（与 docs/04 一一对应）。
**验收**：tsc 全绿；smoke 新增用例：断言白名单 channel 常量表恰好包含 21 条且无重复。

## Step 2 —— core 执行内核 + smoke 起步

**交付物**：`src/main/core/exec.ts`（参数数组 spawn、默认 15s 超时、UTF-16LE BOM/UTF-8 双解码、exit code 捕获、结构化返回、launchViaStartProcess）、`paths.ts`、`logger.ts`。
**验收**：smoke 新增用例：exec 真实执行一个静态字面量命令（如 `node -e` 打印固定文本）并断言 stdout/exitCode；超时用例断言 EXEC_TIMEOUT。

## Step 3 —— SQLite 14 表 + migration

**交付物**：`src/main/db/database.ts`（node:sqlite 封装）+ `migrations/001_init.sql`（docs/03 全量 DDL + 种子数据）+ migration runner（user_version 字面量管理）。
**验收**：smoke 新增用例：临时目录建库 → 断言 `user_version = 1` 且 14 张表存在 → 断言种子 settings（scan_root=`F:\Active_Project`、theme=dark）。

## Step 4 —— 五个只读 Adapter

**交付物**：adapters/windows、wsl、git、docker、fs；全部只读、结构化返回、单项失败返回 DEGRADED 不抛异常（约束 #19/#25）。
**验收**：smoke 新增用例：git adapter 对本仓库外任一真实目录返回结构化结果；docker adapter 在 daemon 不可用时返回结构化降级状态而非错误；fs 发现器对临时构造的目录树返回预期项目列表。

## Step 5 —— Service 层编排

**交付物**：扫描编排（full/projects/services/environment + cancel）、端口归因（port→process→environment→project）、Environment Doctor、projects/settings/dashboard service；唯一写库层（约束 #20），同步维护 resources/relationships（docs/05 规则）。
**验收**：smoke 新增用例：对临时 DB + 临时扫描根跑 projects 扫描，断言项目/仓库/关系边落库正确；Doctor 对已知基线输出结构化 checks。

## Step 6 —— 主进程入口 + IPC 网关 + preload

**交付物**：`src/main/index.ts` 真实化（窗口生命周期、单实例锁）、`src/main/ipc/gateway.ts`（白名单分发 + envelope）、`src/preload/index.ts`（contextBridge 仅暴露 invoke；contextIsolation 开、nodeIntegration 关、sandbox 开）。
**验收**：smoke 新增用例：gateway 对未注册 channel 返回 CHANNEL_NOT_ALLOWED envelope；tsc 全绿；`electron-vite build` 成功产出 out/。

## Step 7 —— Renderer 四视图

**交付物**：React 19 四视图（Dashboard/Projects/Environment/Services），深色主题、侧边栏导航、每视图 loading/empty/error 三态（约束 #23/#24），全部数据来自 `window.devhub.invoke`。
**验收**：tsc 全绿；smoke 新增用例（Renderer 纯函数/格式化逻辑）；`electron-vite build` 成功。

## Step 8 —— 真实启动验收 + 自检修复

**交付物**：真实启动应用（dev 或 build 产物），四视图逐一目视验证三态与真实数据；截图；问题清单与修复。
**验收**（约束 #5）：应用真实启动、SQLite 文件落盘且 user_version=1、Dashboard 数字与真实系统一致（如 Docker daemon 不可用则显示结构化降级）、Services 能回答"谁占用了 <port>"、四个 open 类操作真实生效。全量 smoke（至此累计全部用例）通过。
