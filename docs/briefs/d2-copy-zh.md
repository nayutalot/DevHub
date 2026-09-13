# D2 批任务书：桌面端用户面文案语言统一（中文为主，D-Aud A1）

> 主控裁决（原 known-limitations §6.1「用户定夺目标语言」项，按自主推进令裁决，**用户可翻**）：**用户面文案统一为中文**（与手机端一致、与用户语言一致），技术名词/provider 名/命令/路径/协议词保留英文原文；**内部日志/结构化错误 technical 面不入本批**（错误呈现层 U1 已定「headline 人话+technical 原样」纪律，保持）。
> 依据：D-Aud AUDIT.md A1（文案中英系统性混用：panel 标题英文+说明中文混排、徽章内"verified 刚刚"、relativeTime 中文输出混英文界面等）。先完整读 AUDIT.md A1 与相关截图。
> 只动 `src/renderer`；主进程零触碰。

## 0. 红线

- **行为零变化**：纯文案/展示层；不改逻辑/路由/数据处理；零 migration。
- **smoke 断言联动全枚举**：smoke.mjs 锁定 UI 文案的断言逐一核对更新（历史教训：断言连锁更新点要全枚举）；既有单测 0 改 0 删（renderer 无测试基建则如实注记）。
- 文案质量：统一后中文文案要通顺自然（机翻感=不合格）；术语表先建后译（provider 名/Codex/ZCode/Relay/WebSocket 等保留英文；「容器/镜像/会话/配对/归档」等统一译法）。
- 凭据三零；门禁：`npm run typecheck`（0）+ `npm run smoke:fast` 全绿 + `npm run build` 成功。跑 smoke 前双杀 DevHub.exe+electron.exe（常驻现役 X8 PID 33588——毕后勿拉回，主控排 X9 终换装）。

## 1. 实施面

1. **术语表**（先行，入 AUDIT 附注或独立小节）：保留英文清单（provider 名/Codex CLI/ZCode/Relay/WebSocket/HTTP 方法等）+ 统一译法表（container=容器/image=镜像/session=会话/pairing=配对/archive=归档/refresh=刷新 等）。
2. **全量清扫**：src/renderer 全视图+组件的用户面字符串逐文件过（AUDIT A1 已列混用热点；以 grep 系统扫全量为准勿只修热点）：panel 标题/按钮/占位符/toast/空态与错误态文案/徽章；relativeTime 中文输出保持（统一后不再突兀）。
3. **smoke 断言联动**：grep smoke.mjs 全部锁 renderer 文案的断言，逐条按新文案更新（枚举清单入汇报）。
4. **运行时验证**：重启常驻（CDP）抽查 3-4 个视图截图确认无残留英文混排+无布局破坏（中文比英文宽，注意按钮/徽章溢出）。

## 2. 交付

- Worktree：`F:/Active_Project/DevHub-worktrees/d2copy`，分支 `agent/desktop-d2-copy`（自 main 建；无 node_modules 先 npm install）。
- 按视图组分 commit+push（墙期 SOCKS 配方同前；绝不 --no-verify）。
- 汇报：术语表、改动文件/字符串量级、smoke 断言联动枚举清单、门禁数字、运行时截图结论、push 回执、偏差如实。
