# DS 批任务书：DeepSeek Harness 真机侦察+可行适配

> 背景：known-limitations §1.2——deepseekProvider 为骨架+只读目录探测（getCapabilities 恒 observed+空集，`DEEPSEEK_NOT_INTEGRATED_NOTE`），因「源码重建形态 monorepo，无用户侧 sessions 目录」未接入。harness 根=settings `deepseekHarnessRoot` → 默认 **D:\Apps\deepseek-harness**（@deepseek-ai/dsh-root 0.1.0-rc.5，pnpm monorepo，AGENTS.md/CLAUDE.md/apps/packages/scripts）。**用户 2026-09-14 令「推进对 deepseekharness 的适配」=§1.2 解除路径等待的授权（真机探测）**。基线 main=876d916。

## 0. 工作区与纪律

- worktree：主仓根 `git worktree add worktrees/ds-harness -b agent/ds-harness main`（Phase A 纯读盘可不装依赖；Phase B 若动码再 `npm install`）。
- 每 commit 即 push 分支（直连 `git -c http.proxy= -c https.proxy= push` 优先，socks5h://127.0.0.1:1081 兜底重试）；绝不 push main；绝不 --no-verify；凭据三零。
- **本批零运行时需求**（常驻窗口归并发 KM 批独占）；**绝不启动/运行任何 harness 进程或脚本**（probeHealth 既有红线延伸到侦察全程）。

## 1. Phase A：monorepo 只读侦察（结论每条带 文件:行号/路径证据）

对 `D:\Apps\deepseek-harness`（settings 可覆盖，先读实值）侦察：

1. **布局清单**：apps/*、packages/*、scripts/* 各包名与职责（package.json name/bin/入口）；根 AGENTS.md/CLAUDE.md 性质（AI 助手指令文件≠产品文档，如实区分）。
2. **会话事实源搜索**（核心）：任何 sessions/进度/对话/任务持久化——用户侧目录（~/.*/AppData）、repo 内 storage/db/jsonl/json、日志布局；CLI/server 入口（bin 字段/argv 解析）与其状态落盘路径。
3. **控制面评估**：有无可编程接口（stdin 协议/server 端口/IPC 文件）可支撑 managed（对齐 zcode app-server 评估口径）。
4. **可行性判定**：observed（listSessions/readMessages/startMonitor 对真实布局）可行路径；managed 可行/不可行结论；**若数据源需先运行 harness 才生成→停在此处上报裁决，绝不代答运行**。

## 2. Phase B：按判定落地

- **有可验证数据源** → 最小 observed 适配：deepseekProvider 九方法对真实布局实现 listSessions/readMessages/startMonitor（只读解析，绝不伪造、绝不启动进程）；health/evidence 更新为实接描述；新判定语料进单测（夹具目录，脱敏样本）。
- **无可验证源** → 不写码；known-limitations §1.2 更新为本次侦察结论（缺什么、解除条件），汇报裁决请求。

## 3. 门禁

- 动码才跑：typecheck 0 + smoke fast 全绿（基线 **125/125**，新增夹具用例如实计数）+ build；纯文档批零门禁。
- 边界：kimi/zcode/codex/claude 面零触碰；settingsService 仅在读 deepseekHarnessRoot 既有键（零新键，除非适配必需且说明理由）；Android 零涉。

## 4. 汇报

Phase A 侦察报告（布局/事实源/控制面/可行性判定，证据链）/Phase B 落地面或裁决请求/门禁数字/偏差如实。
