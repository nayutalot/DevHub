# D4 批任务书：桌面端体验整改第二批（交互 P2×5 + P3×2）

> 依据：D-Aud 桌面审计 `acceptance/desktop-audit-20260913/AUDIT.md`（先完整读交互桶/性能桶条目）。已修（D1/D3/B3/D2）不重做。本批修：**I4/I5/I7/I9/I10/I6** 六条；**I8（目录选择器，需主进程+白名单）、I11（快捷键）、I12（Toast 队列）、F6（relativeTime tick）留 D5**。
> 只动 `src/renderer`；主进程零触碰（含 I8 的 IPC 不做）。

## 0. 红线

- 行为契约：既有功能语义不变（删除/扫描/撤销等操作结果不变，只改交互路径与资源纪律）；D1-M2 loadMore、D3 轮询降频、D2 中文文案全部保持。
- 既有单测 0 改 0 删；门禁：`npm run typecheck`（0）+ `npm run smoke:fast` 全绿 + `npm run build` 成功。跑 smoke 前双杀 DevHub.exe+electron.exe（现役 X9 PID 33808——毕后勿拉回，主控排 X10 终换装）。
- 凭据三零；运行时验证用 CDP 零注入（先例工具在 audit 目录）；验证毕常驻无参拉回 health×3=200。

## 1. 修复面（每主题一 commit）

1. **D4-M1 Contests 首屏收纳**（I4）：BackupPanel 默认折叠（对齐 DraftReviewPanel/MaterialImportPanel 收纳模式），比赛列表+分页回首屏。
2. **D4-M2 Skills toggle 去双重确认**（I5）：直接 toggle+可撤销 toast 或仅异常态弹确认（危险向 real-dir 已禁用为前提）；保留既有开关结果语义。
3. **D4-M3 Services 先 list 后 refresh**（I7）：进入先 `services:list` 渲染缓存，后台 refresh 完成原位更新（Dashboard F6 同款模式）。
4. **D4-M4 轮询/循环资源纪律**（I9+I10）：ProjectsView.startScan 与 ProjectDetailView.rescanGit 的 `for(;;)` 循环加卸载取消（cancelled 标志出循环）；DraftReviewPanel 收起时停 3s 轮询（展开才挂轮询子组件，MaterialImportPanel 同款对照）。
5. **D4-M5 表格行键盘可达性**（I6）：Agents 会话行 tabIndex+Enter/Space 触发+role（对齐 OverlayApp 正确做法）；截断文本补 title 提示。

## 2. 交付

- Worktree：`F:/Active_Project/DevHub-worktrees/d4int`，分支 `agent/desktop-d4-interact`（自 main 建；无 node_modules 先 npm install）。
- 每模块 commit+push（墙期 SOCKS 配方同前；绝不 --no-verify）。
- 运行时验证（CDP 零注入）：M1 折叠态截图、M3 进入即有数据、M4 卸载后轮询停止（CDP 计数）、M5 键盘 Tab+Enter 可触发；毕后常驻无参拉回 health×3=200。
- 汇报：逐模块 diff+对应 AUDIT 条目号、门禁数字、运行时验证结论、push 回执、偏差如实。
