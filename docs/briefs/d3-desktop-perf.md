# D3 批任务书：桌面端性能整改（D-Aud 性能桶 F1/F2/F3 + P3 注记）

> 依据：D-Aud 审计（acceptance/desktop-audit-20260913/AUDIT.md 性能桶+基线测量）。基线（修复前）：启动 health200 中位 1321ms；内存 5 进程 465MB→重视图 575MB；Agents 100 行滚动 169fps（已流畅，非瓶颈）；bundle 931KB JS 单包无分割。
> 只动 `src/renderer`+`electron.vite.config.ts`（如分割需要）；主进程/src/main 零触碰（F3 若查实为主进程数据累积，**停手上报**勿动主进程）。

## 0. 红线

- 行为不变纪律：性能修复不得改变功能语义（轮询合并不得丢事件新鲜度契约——Agents 事件流 2s 轮询的用户可感延迟保持同量级；hash 路由 D1-M3 刚修的行为必须保持——懒加载后深链/回写全部回归验证）。
- 既有单测 0 改 0 删；门禁：`npm run typecheck`（0）+ `npm run smoke:fast` 全绿 + `npm run build` 成功。跑 smoke 前双杀 DevHub.exe+electron.exe（现役 X7 PID 27748——毕后勿拉回，主控排 X8 终换装）。
- 修前后性能对比测量入册（同口径：启动×3 中位/内存/首屏 JS 体积）。

## 1. 修复面（先侦察后动，每主题一 commit）

1. **D3-F1 Agents 轮询器合并+列表 memo**（AUDIT F1：6-9 个 2s 轮询器+200 行无 memo）：
   - 侦察：清点 AgentsView 及子组件全部轮询器（对象/间隔/用途），判定哪些重复/可合并/可降频（事件流新鲜度契约不降）；
   - 列表行组件 memo 化（props 稳定性核查）+ 长列表渲染热点修复；
   - 修后用 CDP 实测轮询器数量与滚动帧率对比。
2. **D3-F2 bundle 代码分割**（AUDIT F2：931KB 单包）：
   - electron-vite 路由级懒加载（React.lazy/dynamic import per view）；**hash 深链+D1-M3 回写行为全回归验证**（11 视图逐个直达）；
   - 目标=首屏 JS 显著下降（测量入册，不设硬指标）；公共依赖提取（manualChunks 酌情）；
   - 懒加载失败兜底（加载态/重试，绝不白屏）。
3. **D3-F3 Services 656 行渲染异常查因**（AUDIT F3：62 records 渲染 656 行疑似累积）：
   - 侦察：62 条记录为何 656 行 DOM（每记录多行展开？状态累积重复 append？）；App 侧可修（key 稳定性/重复渲染/列表未清）→修；主进程数据源累积→**停手上报**；
   - 修后 DOM 行数对比入册。

## 2. 交付

- Worktree：`F:/Active_Project/DevHub-worktrees/d3perf`，分支 `agent/desktop-d3-perf`（自 main 建；无 node_modules 先 npm install）。
- 每主题 commit+push（墙期 SOCKS 配方同前；绝不 --no-verify）。
- 汇报：侦察结论（F1 轮询器清单/F3 查因）、diff 概览、门禁数字、修前后性能对比（启动/内存/首屏 JS/DOM 行数）、push 回执、偏差如实。
