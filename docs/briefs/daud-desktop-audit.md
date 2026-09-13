# D-Aud 批任务书：桌面端（Electron renderer）美观度/交互性/性能三向审计

> 用户令：优化 DevHub 桌面端——美观度、交互性、性能等常见方向。本批=审计批（产出分级 findings 清单），实现批待主控复核清单后另派。
> 复用 U-Aud 成功节奏（手机端）：分级清单（P0 阻断/P1 严重/P2 应修/P3 打磨）+截图证据+每条「定位/修法一句话/改动面预估」。

## 0. 红线（最高优先）

- **零代码改动**；零凭据入册（配对码/token/密钥尾号全部 masked）。
- **UI 输入注入护栏（09-10 教训）**：动鼠标/键盘前必须探测前台是否用户活跃使用中（游戏/全屏应用/用户数秒内活动痕迹）——活跃则立即降级零交互模式（只截当前屏+静态代码审计），并在报告注明「交互走查降级待空闲窗口」；空闲则可谨慎走查（每步操作前复查前台）。
- 常驻 DevHub（X6 版 PID 11548）**允许重启用于启动性能测量**（影响秒级，测完必须拉回+health×3 验证）；除此之外零触碰桌面其他应用。
- 模拟器/真机零涉；本批纯桌面。

## 1. 审计范围与方法

**视图清单**（src/renderer/src/views 全量）：Dashboard/Projects/Environment/Services/Agents（会话列表/事件流/设备）/ApiHub/版本中心/归档（Archive，含 LlmReview+ZcodeManaged 设置卡）/设置相关/ContestPin 悬浮窗（如可安全唤起）/托盘交互。

**方法三轨**：
1. **静态代码审计**（零交互，先做）：views/components 全走查——布局体系与间距一致性、文案语言一致性（已知线索：relativeTime 中文混英文）、加载/空/错误三态完备性、交互模式（按钮层级/确认流/反馈）、React 反模式（缺 key/memo 的长列表、无谓 re-render、内联大对象）、路由与导航效率。
2. **谨慎 UI 走查**（前台空闲时）：computer-use 逐视图截图（美观度证据）+交互抽样（点击延迟/反馈感）；每视图记录「第一眼观感+可改进点」。
3. **性能快测**：①启动时长（杀常驻→分离启动→health 200 时刻，×3 取中位，对比 uptimeSec 推算）②窗口内存（tasklist WS）③大列表面（Agents 会话列表 200 条封顶下的滚动/筛选响应主观流畅度）④bundle 体积（out/ 产物尺寸）。测毕常驻拉回 health×3。

## 2. 产出

- 证据：`F:/Active_Project/DevHub-worktrees/daud/acceptance/desktop-audit-20260913/`（截图+AUDIT.md）。
- AUDIT.md：**三桶分列**（美观度/交互性/性能）×四级（P0~P3），每条=定位（视图/组件/文件行）+截图或代码引用+修法一句话+改动面预估（纯 UI/含逻辑/含主进程）；「设计决策注记（非缺陷）」单列（如主题深色钉死若属决策）。
- Worktree：`F:/Active_Project/DevHub-worktrees/daud`，分支 `agent/desktop-audit`；commit 证据+push（墙期 SOCKS 配方同前）；绝不 --no-verify。
- 汇报：三桶×四级计数+P0/P1 逐条摘要（主控规划直接输入）、证据清单、push 回执、偏差如实（含交互走查是否降级）。
