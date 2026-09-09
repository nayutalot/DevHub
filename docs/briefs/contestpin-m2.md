# CP2 任务书：ContestPin 悬浮窗 + 主界面比赛视图 + 托盘（M2）

> 系列权威：docs/22-contestpin-design.md（§4 悬浮窗 + §3 通道）/ charter §三 §四。
> 执行者：omni-agent，worktree `F:/Active_Project/DevHub-worktrees/contestpin`，分支
> `agent/contestpin`（**CP1 六提交之上继续**，主控已 review 通过）。本任务书自包含。

## 0. 时窗红线（最高优先级）

M3-D 72h 观察窗运行中（至 2026-09-10 08:49）：
- 允许：worktree 内编码/文档、`npx tsc --noEmit`、`node scripts/smoke.mjs --tier=fast`、
  `git push origin agent/contestpin`。
- 禁止：`npm run dev`/任何 electron 启动/打包、全量 smoke/mcp/gradle/adb、杀起进程、
  占 8746、SSH/ECS、merge/push main、--no-verify。
- 悬浮窗的真实启动验证（7 能力逐项目视）**留窗毕**由主控执行；本批只交付代码+
  类型/纯 Node 验证，并在最终消息附「窗毕验证清单」。

## 1. 已查明事实链（审计 A，2026-09-09；行号以 worktree 当前代码就近核对）

- 主窗口创建：`src/main/index.ts` createWindow（webPreferences 钉死
  sandbox/contextIsolation/`../preload/index.js`）——悬浮窗原样复用同款 webPreferences。
- preload 唯一暴露 `window.devhub.invoke`（`src/preload/index.ts`）——**不写第二个
  preload**（CJS 构建形态已钉死）。
- hash 路由先例：`loadRenderer(win, hash)` + App.tsx initialTarget 解析（`#agents`
  先例）；`showMainWindow`（restore→show→focus）second-instance 与托盘共用。
- **单实例收紧点（本批必做）**：index.ts 三处
  `mainWindow ?? BrowserWindow.getAllWindows()[0]` fallback（约 :125/:138/:149）改为
  显式判空+销毁态检查，保证悬浮窗存在时 second-instance/托盘"打开 DevHub"永不误选
  悬浮窗（不得对悬浮窗做 show/focus/loadRenderer）。
- 退出：`quitGuarantee.ts` 状态机（5s 硬上限+3s 看门狗）；清理挂载点=
  `runQuitTeardown`（index.ts）**最前**（与 trayRefreshTimer 并列、先于
  closeDatabase；ref'd 定时器回调会经 getDatabase() 惰性重开已关闭 DB，必须最先清）。
  主窗口 close=hide 守卫 + window-all-closed 不 quit——悬浮窗 close 事件挂同一
  isQuitting 守卫（close=hide 语义，退出路径由 destroyOverlay 兜底）。
- 托盘：`trayWire.ts` checkbox 模式（monitor/autostart 先例=settings 键+
  rebuildContextMenu）；`lastMenuState` 去抖；TrayDeps 注入先例 index.ts:304-311。
- electron import 白名单（autostartWire.ts:6-8 纪律注记）：index.ts / keyStoreWire.ts /
  ipc/gateway.ts / autostartWire.ts / trayWire.ts——新增 `overlayWire.ts` 后更新该
  注记（+docs/12 文件清单若有列）。**handlers.ts 不得 import electron**：openLink /
  openInMain 等 electron 动作经注入 applier（autostartWire `setAutoStartApplier`
  先例：wire 层 setXxxApplier(实现)，handlers 调接口函数）。
- settings：白名单已含 `contestpin_overlay_state`/`contestpin_overlay_enabled`
  （CP1）；`contestpin_overlay_state` 值格式（CP1 smoke 已锚定）：
  `{"bounds":{"x":1,"y":2},"collapsed":false}`（x/y/width/height+collapsed）。
- CSP `default-src 'self'`（index.html）——overlay 样式仅 style 属性级内联。
- 轮询：`src/renderer/src/lib/usePolling.ts`（主窗口隐藏时照常工作）。
- CP1 已有：contestService（CRUD/节点/linkProject）+ 9 通道（计数断言=79，
  **计数位点共 4 处**：step1/step6/s4-68/ac2-84——CP1 批注记，更新时全改）。

## 2. 交付物清单

### 2.1 主进程

1. **`src/main/overlayWire.ts`**（新文件，唯一新 electron import 位）：
   - `initOverlay()`（whenReady 后由 index.ts 调）：读 settings
     `contestpin_overlay_enabled`，为 '1' 时创建悬浮窗：`new BrowserWindow({
     frame:false, alwaysOnTop:true, skipTaskbar:true, resizable:true, show:false,
     minWidth/minHeight 合理值, webPreferences: 同款 })`，loadRenderer 同款 hash
     `'overlay'`，ready-to-show 后 show。
   - `setOverlayEnabled(bool)`：开=创建/show，关=hide（或销毁，选一并注明理由）；
     settings 持久化经 contestService/overlayStateService 助手（wire 层不写 SQL）。
   - `setOverlayCollapsed(bool)`：按 collapsed 态 setSize 调整窗口高度（宽度不变）。
   - `destroyOverlay()`（quit 清理用）：destroy 窗口+清 screen 监听+清防抖句柄，
     同步非阻塞。
   - screen 层：创建/恢复时 `screen.getDisplayMatching(bounds)` 校验 + workArea 裁剪
     （显示器变化后回可见区）；监听 `display-removed`/`display-metrics-changed` 主动
     relocate（bounds 为 DIP，勿自行换算 DPI scale factor）。
   - close 事件：preventDefault + hide（isQuitting 时放行退出路径）。
   - move/resize 防抖（≥500ms）→ saveOverlayState。
   - **注入 applier**：`setOpenExternalApplier`（shell.openExternal）与
     `setFocusMainWindowApplier`（showMainWindow + loadRenderer hash `contest:<id>`
     导航）；index.ts 接线处注册生产实现；electron 白名单注记更新。
2. **`src/main/index.ts`**：三处 getAllWindows()[0] fallback 收紧；runQuitTeardown
   最前加 `destroyOverlay()`；whenReady 后 initOverlay()；TrayDeps 增 overlay 开关。
3. **`src/main/trayWire.ts`**：菜单 checkbox「比赛悬浮窗」（checked=
   contestpin_overlay_enabled，点击 toggle→setOverlayEnabled+rebuild）；
   lastMenuState 扩展该键。
4. **`src/main/services/contestpin/overlayStateService.ts`**（electron-free，或并入
   contestService——执行者按内聚度定，偏差清单注明）：
   - `getOverlayState()`/`saveOverlayState(bounds, collapsed)`：JSON 校验（bounds 数值
     x/y/width/height+collapsed 布尔），非法持久化值拒绝并回默认（默认位置=null，
     由 wire 层居中主显示器）。
   - `validateExternalUrl(url)`：仅 http/https（拒绝 javascript:/file:/ftp:/空白），
     返回规范化 URL 或 ServiceError('BAD_PAYLOAD')。
5. **通道 +5（79→84）**：`contestpin:overlayState`(READ_ONLY：enabled+bounds+
   collapsed)、`contestpin:overlaySetEnabled`{enabled}、`contestpin:overlaySetCollapsed`
   {collapsed}、`contestpin:openInMain`{contestId}（applier 聚焦主窗口+导航）、
   `contestpin:openLink`{url}（service 校验后经 applier 打开默认浏览器）。三件套
   （channels/types/handlers）+ docs/04 CP2 五行状态翻「CP2 已落地（84）」+ smoke
   计数断言 4 处就地更新（79→84）。
6. **service 层 due-node 投影**：list/get 返回增 `dueNode`/`nextNode` 纯逻辑计算
   （临近优先：未 done 且 start_at 最近未来；全过期→dueNode 带 `overdue:true` 标记；
   done 后推进下一节点；tbd 无 start_at 排最后；precision 传递给展示层）。

### 2.2 Renderer（主窗口侧栏 + 悬浮窗）

7. **侧栏新增「比赛」视图**（`src/renderer/src/views/` 新 ContestView，仿现有视图
   布局/组件）：列表（搜索框+状态筛选+含归档开关+分页）、新建/编辑表单（名称/年份/
   届次/主办方/备注/状态/三链接 URL）、归档/删除（两段式确认弹窗展示 impacts）、
   详情（节点列表：kind 标签+label+时间按 precision 展示——date 显示"日期 ·未注明
   具体时刻"、tbd 显示"时间待定"+done 标记+节点增删改+关联项目选择器）。全部数据经
   真实 IPC，无 mock（合同 #23），loading/empty/error 三态（#24）。
8. **`#overlay` 悬浮窗 UI**（App.tsx initialTarget 扩展分流，新组件 OverlayApp）：
   - 紧凑卡片列表：比赛名+dueNode（含"过期未完成"红标）+日期+剩余天数+入口按钮
     （官网/报名/提交→contestpin:openLink）。
   - 折叠按钮：collapsed 态单行摘要；切换经 `contestpin:overlaySetCollapsed`。
   - 拖动区：CSS `-webkit-app-region: drag`（按钮/卡片点击区 no-drag）。
   - 点击卡片主体 → `contestpin:openInMain`。
   - usePolling 轮询 contestpin:list。
9. **主窗口导航 `contest:<id>`**：App.tsx ViewTarget 扩展（projectId 先例），
   initialTarget 解析进比赛视图详情态。

### 2.3 smoke（fast 档，纯 Node）

10. 新用例：`cp2-overlay-state`（save/get 往返+非法 JSON 回默认）、
    `cp2-openlink-guard`（validateExternalUrl 正反例）、`cp2-due-node`（临近优先/
    过期标记/done 推进/tbd 排后——夹具直调 service 断言）；计数断言 79→84（4 处，
    就地+注记）。

### 2.4 文档

11. docs/04（CP2 五行翻已落地+计数 84）、docs/02（electron 白名单 +overlayWire
    若有清单处）、docs/06（比赛视图+悬浮窗 IA 追加小节）。HANDOFF 不动（主控管）。

## 3. 完成定义

1. `npx tsc --noEmit` 0 error；2. `node scripts/smoke.mjs --tier=fast` 全过（用例数
   85→88，计数断言与 docs/04 一致=84）；3. 红线自查：services/contestpin 零 electron
   import、overlayWire 外无新 electron import、SQL 全绑定、无凭据日志；4. 最终消息
   附：commit 列表、验证输出摘要、**窗毕悬浮窗实启动验证清单**（置顶/拖动/缩放/折叠/
   位置记忆/多显示器拔插/DPI/托盘开关/close=hide/退出清理/单实例不误选/openInMain
   导航/openLink 浏览器/通知外无新面）、偏差清单。

## 4. 提交纪律

同 CP1：增量提交（`feat(contestpin): …`/`docs(contestpin): …`），每 commit 即 push
origin agent/contestpin；不 merge 不 push main；冲突不可调和项停下记录上报。
