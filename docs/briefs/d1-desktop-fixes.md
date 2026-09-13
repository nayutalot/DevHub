# D1 批任务书：桌面端体验整改第一批（P1×3 + 美观快赢×3）

> 依据：D-Aud 桌面审计（已合 main，清单=`acceptance/desktop-audit-20260913/AUDIT.md`——先完整读）。本批修 P1 全部 3 条 + 美观快赢 3 条（A2/A3/A4）；其余 P2/P3 留后续批（A1 文案语言统一涉及全量 smoke 断言联动，主控另批）。
> 只动 `src/renderer`（Electron renderer 层）；主进程/src/main 零触碰（若发现必须动主进程，停手上报）。

## 0. 红线

- 28 条合同；凭据三零；零 migration；既有单测 0 改 0 删（新增允许——但先核对该批发现是否需要新增 renderer 测试基建，无则如实注记）。
- 门禁：`npm run typecheck`（0）+ `npm run smoke:fast` 全绿（fast 面=主进程为主，renderer 改动由 typecheck+build+运行时验证兜底）+ `npm run build`（electron-vite build 成功）。跑 smoke 前双杀 DevHub.exe+electron.exe（现役=审计批拉回的 PID 34260——毕后勿拉回，主控排 X7 换装）。

## 1. 修复面（模块化串行 commit）

1. **D1-M1 Docker Remove 功能修复**（I1，AUDIT 交互 P1#1）：`DockerView.tsx` L54 `window.prompt` 在 Electron 必抛→删除容器功能整体失效。改应用内输入匹配确认 modal（复用仓内既有确认流模式——先看 ApiHub/Archive 的确认交互形态对齐）；输入匹配语义保持（输错/留空=不删除）。
2. **D1-M2 loadMore 游标修复**（I2，`AgentsView.tsx` L161-206 useCursorStream）：loadMore 与 refresh 同为 setTick 导致游标/列表全重置、「加载更多」实为重载第一页、L177 append 分支死代码。修法：loadMore 走手动追加路径（保留既有列表+游标推进+append 分支生效）；refresh 语义不变；加载中防重入。
3. **D1-M3 hash 路由补全**（I3，`App.tsx` L55-61）：11 视图全映射 initialTarget + navigate 回写 hash（深链与刷新保持可用）；不改变既有 agents/contest 行为。
4. **D1-M4 美观快赢**（A2 row-hit 选中态失效/A3 内部规格号 D1、D2、docs 泄漏用户面/A4 私造 token 回退色→统一既有色板）：逐条对照 AUDIT 定位修复；A3 修法=用户面只留规则语义（Z3/U2-M3 同款先例）。

## 2. 运行时验证（门禁之外）

- 重启常驻（审计批同款 CDP 或直接无参启动均可）对 M1/M2/M3 做最小交互验证：Docker 删除确认 modal 可完成删除流（或无可删容器时验证 modal 打开形态）、会话列表 Load more 真追加（无 ≥100 消息会话则以网关返回页大小可触发为准或如实注记）、hash 深链直达任一视图+navigate 回写。验证完常驻**保持在役**（拉回无参版 health×3）。

## 3. 交付

- Worktree：`F:/Active_Project/DevHub-worktrees/d1fix`，分支 `agent/desktop-d1-fixes`（自 main 建）。
- 每模块 commit+push（墙期 SOCKS 配方同前；绝不 --no-verify）。
- 汇报：逐模块 diff+对应 AUDIT 条目号、门禁数字、运行时验证结论、push 回执、偏差如实。
- worktree 无 node_modules 先 npm install。
