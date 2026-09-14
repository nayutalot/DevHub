# X-U 批任务书：electron-updater 自动更新启用（实现批）

> 背景：Release v0.1.0 已发布（GitHub 私有仓）——**GitHub provider 不可行**（私有仓资产下载需客户端 token，触凭据红线）。主控已裁 feed 形态：**ECS caddy 静态 generic feed**（`/updates/` 路径，挂既有 relay 域名 443——桌面 TLS 到 caddy 生产已在役，host 腿 wss 同源）。本批=桌面实现+门禁；**ECS 部署与更新链路实测归 X11 收官批**。基线 main=3f66c62。

## 0. 工作区与纪律

- worktree：主仓根 `git worktree add worktrees/xu-updater -b agent/xu-updater main`；`npm install`（新增依赖 electron-updater）。
- 每 commit 即 push 分支（墙期直连失败→`git -c http.proxy=socks5h://127.0.0.1:1081 push origin agent/xu-updater`，主控已验证）；绝不 push main；绝不 --no-verify；凭据三零；零新 spawn（exec.ts 唯一 spawn 不动；electron-updater 内部安装器调度属框架行为，注记即可）。

## 1. 实现范围

1. **feed 常量**：编译期常量（与 ZCODE_LINK_ORIGIN 同型，放既有常量组旁）= 既有 relay 基址 + `/updates/`；零凭据、可被 settings 覆盖不要求（保持最小）。
2. **main 面**：electron-updater 接线模块（独立文件，index.ts 薄挂）——`app.isPackaged=false` 全链禁用；启动后延迟 60s 静默检查一次（**仅发现新版时 toast 提示，绝不自动下载**）；失败结构化日志零打扰、绝不阻塞启动/退出链（quitTransition 零触碰）。
3. **设置页「检查更新」卡**：当前版本+检查按钮+三态（最新 / 发现新版 vX.Y.Z→人话更新说明位+「下载并安装」确认钮 / 检查失败结构化呈现不弹窗）；下载有进度；完成后确认→`quitAndInstall`（用户确认前置，绝不静默重启）。文案全中文按 AUDIT 附注 A 术语表。
4. **feed 装配脚本**：`scripts/build-updates-feed.mjs`——从 dist 根取五件+latest.yml，产出 `/updates/` 布局（目录清单打印）；**latest.yml path 字段差异核对落成断言**（HANDOFF 已注记 electron-builder 连字符形态差异——脚本内校验 path/filename 与实际文件一致，不一致即报错退出）；X11 收官批直接消费此脚本。
5. **单测**：版本比较/updateInfo 解析/path 字段兼容（连字符与点形态各一例）/dev 禁用门——进 smoke fast 档（fake feed，零网络）。

## 2. 门禁（全绿才汇报完成）

- typecheck 0 + smoke fast 全绿（基线 **116/116**，新增用例如实计数）+ `npm run build` 成功。
- **无运行时实例验证**（单实例锁互斥，Wave-2 的常驻窗口归 X-L 批独占；本批绝不 taskkill/启动任何 DevHub 实例、**不运行 npm run dist**、不动 dist/ 与常驻）。
- electron-updater 下载/安装链路实测留 X11（换装后对真 feed 跑检查→下载→安装→新版本号）。

## 3. 边界

Android 零涉（不 gradle）；ECS 零触碰、零 ssh；relay 面零触碰；docs/09 注记若涉及新 IPC 则纯插入；OverlayApp 悬浮窗零触碰。

## 4. 汇报

commits 清单 / 门禁数字 / feed 装配脚本用法一段（X11 要用）/ latest.yml path 核对结论（两种形态实测结果）/ 偏差如实。
