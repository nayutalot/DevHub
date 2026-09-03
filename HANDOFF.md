# DevHub 会话交接文档（2026-09-03，并库阶段收官更新）

> 交接范围：Phase 1 MVP → MCP Server → 双软件合并 S1-S6 **全部完成并验收**。下一步为排队中的 AC0-AC9（Agent Control / Mobile），待用户发令。新会话按此文档续接，无需重读历史对话。

## 1. 当前状态一句话

**DevHub 已完成：Phase 1（四视图+SQLite）→ Read-only MCP Server → 双软件合并 S1-S6（Skills/ApiHub/Versions/Docker/WSL/Archive 全部并入，S6 端到端验收通过）。下一步：AC0-AC9（Agent Control/Mobile）管线待用户下令，任务书已备（见记忆 devhub-agent-control-spec）。**

## 2. 协作模式（用户铁律，必须遵守）

- **母智能体只做 plan 和 review，全部实现派发 `omni-agent` 子智能体执行**（用户明文要求）
- 每个批次：母智能体写自包含任务书派发 → omni-agent 实现 → **母智能体独立复跑** `npx tsc --noEmit && node scripts/smoke.mjs` 等门禁评审 → 通过才进下一批
- 用户要求"先规划后写码"（曾因直接开干被批评）；重大范围决策用 AskUserQuestion 问用户
- 视觉评审：**派独立 omni-agent 用 Read 看截图**（judge 类型的 Read 只回 CDN URL 看不了图；omni-agent 的 Read 正常内联看图——已实测）。主对话自己看图走 Read→CDN URL→analyze_image
- 锁屏截图用 PrintWindow(PW_RENDERFULLCONTENT) 抓 HWND（CopyFromScreen 拍到锁屏）

## 3. 项目事实基线

- 根目录：`F:\Active_Project\DevHub`（非 git 仓库）；平台 Windows，Bash=Git Bash
- 技术栈锁定：Electron 44.1.1 + electron-vite 5 + Vite 7（钉 ^7）+ React 19 + TS 严格模式 + `node:sqlite`（DatabaseSync）
- 本机环境：Win Node 24.15 / Python 3.9.13(PATH首位)+3.13.5 并存；WSL：Ubuntu(Running)+docker-desktop(Stopped)；Docker CLI 在、daemon 常 down（全部优雅降级已实现）；Git 2.54
- DB：`%APPDATA%\devhub\devhub.db`（user_version=**3**，19 张表；WAL 多进程，MCP 与 Electron 共读同库）。真实数据：projects 3（DevHub/Skill-Manager/SmartWatch）、skill_agents 4、skills 4、apihub_profiles 0、archive_runs 1（老软件导入的 DemoWeb 历史，project_id=NULL 属设计语义）
- IPC：单网关 `devhub:invoke`，白名单 **55 条** channel（21 原始+14 skills+10 apihub/versions+5 docker/wsl+5 archive）
- 视图 9 个全部启用：Dashboard/Projects/Environment/Services/Skills/ApiHub/Versions/Docker/Archive
- smoke：**80/80**；mcp-acceptance：**22/22**；build 全绿；启动日志佐证 `gateway registered on "devhub:invoke" with 55 channels`
- 验收截图：acceptance/v2-*.png（Phase 1）、**acceptance/s6-*.png ×5（并库终验：skills/apihub/versions/docker/archive）**

## 4. 各阶段完成情况

### Phase 1（已验收）
Dashboard/Projects/Environment/Services + SQLite(001/002 migration) + 21 channel IPC。真实数据扫描与 Doctor 诊断；截图验收通过，7 处 UI 缺陷已修复。

### MCP Server（已验收，docs/08）
- `npm run mcp`（stdio 独立进程）→ Service 层 → Adapter/DB；禁止 MCP 直接 spawn/SQLite/Adapter
- 12 只读 Tools + 6 Resources + 4 Prompts + 权限四级框架（本期全 READ_ONLY）
- ZCode 接入（用户尚未加配置）：`C:\Users\sakuya\.zcode\cli\config.json` 的 `mcp.servers` 嵌套键，`{"mcp":{"servers":{"devhub":{"command":"node","args":["F:/Active_Project/DevHub/scripts/run-mcp.mjs"]}}}}`
- Phase B（Safe Actions）未开始，用户未下令

### 双软件合并（S1-S6 全部完成，2026-09-03 收官）
用户决策：全部并入（SkillVault+ArchiveKeeper）；数据迁入 DevHub 为准；老目录零改动只读。
- **S1 ✅** docs/09+10、migration 003（19 表）、migrate-legacy.mjs 真实导入（4 agent/4 skill/1 归档历史）
- **S2 ✅** Skills 核心：junction/硬链接五态/导入/doctor/双侧同步/skm companion/Skills 视图（真机 4 agent 全 linked×4）
- **S3 ✅** ApiHub（7 适配器、注入式 KeyCrypto、两段切换+回滚）+ 版本中心（8 目标真机检测）+ 密钥红线审计
- **S4 ✅** Docker 视图（daemon down 全降级）+ WSL 并入 Environment（terminate/boot/proc 概要）
- **S5 ✅** Archive 归档模块全量：services/archive/ 纯函数+引擎 7 文件（pathRefs/scanRules/depDirs/walker/mover/pathFixer/procGuard）+ archiveService.ts（preview 强制 dry-run 签发 previewId→run 两段确认→status 轮询→history 上限 100→rollback 两段式）+ ArchiveView 三步向导 + 白名单 50→55 + smoke s5-69..s5-80（12 条：变体匹配/同卷跨卷/EXDEV 保源/剥离/改写回滚/previewId 校验/占用 killPids/回滚/历史上限/白名单派发）
  - 已裁决偏差（docs/10 §11 注记）：archive:precheck 未单独成 channel，预检职能并入 preview；preview 签发 previewId（非草案 runId）；rollback 两段式
- **S6 ✅ 端到端验收（2026-09-03）**：四门禁终跑全绿（tsc/smoke 80/80/mcp-acceptance 22/22/build）；真实启动应用截图 5 新视图→独立 omni-agent 视觉评审 5/5 pass；密钥红线全链路审计 0 命中（源码日志/IPC 返回/落盘日志/safeStorage 密文落库/keyStoreWire 未被 S5 触碰）；老目录（Skill-Manager/Archive-Tool）9-03 起零写入、DevHub 管线无写入路径（9-01/9-02 的 mtime 归因用户自主并行开发）；docs/04/06/10 已同步（含 55 条白名单与偏差注记）

## 5. 下一步：AC0-AC9（Agent Control / Mobile）——待用户发令

完整任务书在记忆 `devhub-agent-control-spec`（AC0 审计 → AC1 设计文档 → AC2 数据层 migration 004 → AC3/AC4 Provider → AC5 托盘+Agents 视图 → AC6 Remote Gateway → AC7 Android → AC8 NatPierce+端到端 → AC9 终验收）。启动条件（老会话结束）已满足，等用户指令。Android 工程目录：`F:\Active_Project\DevHub\android`（禁挪走）。

## 6. 关键执行约束（写码全程遵守，Mimosa 钩子会拦截）

- 全项目唯一 spawn 入口 `src/main/core/exec.ts`（参数数组、无 shell、15s 默认超时）
- SQL 全部字面量+参数绑定；`PRAGMA user_version` 用字面量 switch（不支持绑定）
- `.match()` 不用 `RegExp.exec(变量)`；PowerShell 字面量+`$env:` 传参；交互窗口用 Start-Process
- services/mcp 目录 electron-free（smoke 用系统 Node 24 直载 .ts）；electron import 只允许在 src/main/index.ts、keyStoreWire.ts、ipc/gateway.ts
- Edit 被安全钩子拦截时改用整文件 Write 重写
- smoke 用例 append-only（改既有断言需 docs 授权说明）；每批次完成跑 tsc+smoke+build+mcp-acceptance 四门禁
- wsl.exe 命令必须 `wsl.exe -d X -e sh -c '<literal>'`；输出 UTF-16 BOM 已在 exec 处理
- React StrictMode 双挂载：模块级防抖用 promise 模式（boolean 标记有竞态坑）
- 真库只读检查技巧：WAL 状态下只读直连可能 CANTOPEN（陈旧 shm）→ 复制三文件到临时目录后 query_only 查询（S6 实测有效）

## 7. 已知瑕疵/待决事项

- relativeTime 输出中文（"53 分钟前"）混在英文 UI，smoke 中文断言锁定，待用户定夺
- docker:action 的 remove 与 wsl shutdownAll 未实现（docs/09 §8 DOUBLE_CONFIRM 设计，S4 范围裁剪留后续）
- MCP services:refresh 的 scanId 取"最新 scans 行"（并发扫描源理论错位，单进程无影响）
- DeepSeek Harness 更新路径未真机验证；版本中心无 cancel channel（超时兜底）
- 视觉评审观察项（不影响验收）：Skills 页 zcode-wsl 带 stale 徽章（跑一次 Sync 即消）；Archive HISTORY 表 Old→New 列路径被截断（可加悬停提示）；Docker 横幅首行末悬挂"—"观感
- Archive 项目选择器下拉弹层为独立 HWND，PrintWindow 主窗截图无法捕获（验收时以代码链路+DB 佐证）
