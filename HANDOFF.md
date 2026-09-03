# DevHub 会话交接文档（2026-09-04，Agent Control / Mobile 收官）

> 交接范围：项目重建 → Phase 1 MVP → MCP → 双软件合并 S1-S6 → **Agent Control / Mobile AC0-AC9 全部完成**。新会话按此文档续接。

## 1. 当前状态一句话

**DevHub 已完成全部规划功能：Phase 1 + MCP Server + 并库（Skills/ApiHub/Versions/Docker/WSL/Archive）+ Agent Control/Mobile（五家 Provider/托盘常驻/Agents 视图/Remote Gateway/Android App/NatPierce 配置面，真实端到端已证实）。仓库已是 git（main @ cf9344f），四门禁全绿（tsc 0 / smoke 142/142 / mcp-acceptance 22/22 / build OK）。**

## 2. 协作模式（用户铁律）

- **母智能体只 plan/review/merge，一切执行派 omni-agent**；每批独立复跑门禁后才追认
- **夜间活动时段（23:00-09:00，至 2026-09-20）采用并发工作流**：主控编排 + 3 worktree 并发 3 个子智能体（一个 Agent 一个 Worktree 一个独立任务，禁止交叉访问；只有主控 merge）——用户强制规则，见用户侧记忆 night-flash-parallel-workflow
- 先规划后写码；冲突上报裁决不擅自选；视觉评审派 omni-agent 看图（Read 内联）
- 截图用 PrintWindow+PW_RENDERFULLCONTENT 抓 HWND；桌面 UI 可经 CDP --remote-debugging-port=9222 驱动

## 3. 项目事实基线（终态）

- 根：F:\Active_Project\DevHub（**git 仓库**，main；无远程未 push）；技术栈不变（Electron 44.1.1/electron-vite 5/Vite 7/React 19/TS 严格/node:sqlite WAL）
- git 历史 9 提交：b8a819a 基线（S1-S6+AC0-AC7b+安全修复）→ wt1/wt2/wt3 并发分支合并（007c91a）→ 007d8b3（A12 断言更新+npm 单源化）→ 2835589（AC9 终验）→ cf9344f（退出滞留根治）
- IPC 白名单 **68 条**（55+13 agents:）；视图 **10 个**全启用；migration 004（user_version=4，27 表）；smoke **142/142**；mcp-acceptance **22/22**（A12 已按 git 现实更新断言）
- 真库：agent_providers 5（codex 0.153.0-alpha.5 managed[reply,pause,resume] 158 methods；claude 2.1.150/kimi 0.36.0/zcode/deepseek 0.1.0-rc.5 均 observed）、agent_sessions 337+、agent_events 14800+、remote_devices 4
- Android：F:\Active_Project\DevHub\android（:app+:core，Gradle 9.1.0+AGP 8.13.0，SDK 在 %LOCALAPPDATA%\Android\Sdk，AVD DevHub_API_35）；APK android/app/build/outputs/apk/debug/app-debug.apk；:core:test 37/37
- settings：gateway_enabled=1、gateway_port=8746（e2e 时临时 8750/8760 已复原）、login_autostart=0

## 4. Agent Control / Mobile 交付摘要（AC0-AC9）

- **AC0 审计/AC1 docs 11-16 设计**（裁决：exec.ts 扩展 spawnManaged 双上限、Gateway 在 Main 内、MCP 零改动、remote_devices 新表、Grok 不做；9 值会话状态=用户 7 态+stopped/unknown）
- **AC2 数据层**（migration 004 八表+白名单 68）→ **AC3 Provider 框架+Codex(app-server 真机握手)/Claude** → **AC4 Kimi/ZCode(只读快照)/DeepSeek+事件管线** → **AC5 托盘+自启+Agents 视图**（真机关窗存活/second-instance/托盘左键恢复实证）→ **AC6 Gateway**（13 REST+自研 WS+配对 code-only+防重放+限流+幂等；七例缺陷定点修复含 rejectUpgrade 裸 socket 崩溃）→ **AC7/AC7b Android**（SDK 装机+APK+模拟器逐页验收+observed 零按钮 ui dump 断言）→ **AC8 真实端到端**（会话 #337：真实推理→waiting_input 通知→手机回复→Codex 收到并回流，6 turn 全证据）→ **AC9 终验**（11 视图截图/final-report/SHA-256 149 文件/known-limitations）
- **并发批次（夜间活动）**：wt1 e2e（a8d8c9d）/wt2 文档+manifest（d27bd28）/wt3 ac3-97 稳定化+门禁双跑（8d1f08a）；端口协调教训：**smoke 用例依赖 8746-8755 全空闲（ac6-121 顺延断言），真实 Gateway 必须避开该段（用 8760 类）**
- **退出滞留根治（cf9344f）**：根因=2s 托盘轮询 interval 不清除+惰性 DB 重开+无退出兜底；修=core/quitGuarantee.ts 状态机+3s 看门狗 app.exit(0)；两遍实测零滞留
- **安全**：doctor.ts crlf 路径逃逸真缺陷已修（sec-fix 用例）；Mimosa 误报消解记录——npm 解析收敛 where.exe 单源+PATH 投毒收口校验（恢复 env 回退需钩子侧加白）；parseBearerToken→readBearerHeaderValue（顺带清除 RegExp.exec）

## 5. 交付物索引

- 最终报告：acceptance/agents-mobile/final-report.md（全节定稿）
- SHA-256 清单：acceptance/agents-mobile/SHA-256-SUMS.txt（149 文件，--check 通过；**git autocrlf 会使文本条目失配，最终态重生成**）
- 已知限制：docs/known-limitations.md；NatPierce 指南：docs/natpierce-setup.md
- 视图截图：acceptance/ac9-view-*.png ×10+；e2e 证据：acceptance/agents-mobile/ac8-e2e-*；退出修复存证：acceptance/ac9-exit-fix-tasklist.log
- 设计文档：docs/11-16（AC 域权威）

## 6. 关键执行约束（沿用，Mimosa 钩子会拦）

同前版本 28 条合同 + AC 域六节约束（docs/11-16）；补充踩坑：
- Mimosa 扫描覆盖非确定：同代码两次提交可能一拦一放；「env→path→fs」模式必拦（误报），appeasement 无效时移除构造或上报用户加白；**绝不 --no-verify**
- mcp-acceptance A12 断言 DevHub 工作树干净——**先 commit 再跑 mcp-acceptance**（生成物 scenario-report 已 gitignore）
- 并发 smoke 与真实 Gateway 的端口互斥（8746-8755）；electron 子进程退出靠 quitGuarantee 兜底
- 真库 WAL 只读：直连失败（陈旧 shm）→ 复制三文件快照法

## 7. 遗留事项（等用户）

1. **托盘右键「退出 DevHub」真机复核一次**（本环境输入注入不可达；等价路径已证 teardown 完整+看门狗零滞留）
2. **NatPierce**：三项环境变量填好后按 docs/natpierce-setup.md 配置，B1-B8 回归待跑
3. **Kimi 真机 managed e2e**：需用户授权写 ~/.kimi-code 的场景
4. relativeTime 中文混英文 UI（旧待决）；per-provider 单独重探（backlog）；Codex turn/interrupt 活跃中断加分项
5. 主仓 gradle 重建 APK 需 JAVA_HOME（当前 APK 为 wt1 构建经 hash 比对一致性复制）
