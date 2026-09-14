# D5 批任务书：桌面收官——审计清单终四小项+P3 打磨清零

> 背景：D-Aud 桌面审计（`acceptance/desktop-audit-20260913/AUDIT.md`=权威清单）经 D1（P1×3+美观快赢）/D3（F1/F2）/B3（F3）/D2（A1 文案）/D4（I4/I5/I6/I7/I9/I10）后，仅剩交互 P2 终三（I8/I11/I12）+性能 P3（F6）+美观 P3×4（A5/A6/A7/A8）。本批全修=桌面优化线整条清零。基线 main=ff06077。

## 0. 工作区与提交纪律

- worktree：主仓根 `git worktree add worktrees/d5 -b agent/desktop-d5-finale main`；cd 后 `npm install`（worktree 无 node_modules；卡→`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`）。
- 增量提交接力：每模块一 commit，每 commit 即 push 分支 origin；绝不 push main；绝不 `--no-verify`；钩子拦截如实上报主控勿硬闯。
- 凭据三零；Mimosa 纪律：新 IPC channel 命名避开 `.request(` 形态；零新 spawn（exec.ts 唯一 spawn 不动）；env→path 推导复用既有边界函数。

## 1. M1=I8 目录/文件选择器（唯一主进程改动面）

- 新增 IPC `dialog:pickPath`：main 侧 handler（Electron `dialog.showOpenDialog`，参数含 directory/file 模式与起始路径）+ preload 桥。docs/09 若有 channel 清单则追加一行注记（纯插入）。
- 四处 renderer 接入（**保留手输能力**，旁边加「浏览…」按钮，选中回填输入框）：BackupPanel destDir、Skills importDialog sourceDir、Archive destRoot、MaterialImport manual_pack destDir。
- 取消/失败语义=维持原值不报错。

## 2. M2=I11 键盘快捷键（App.tsx 级）

- F5 / Ctrl+R 刷新当前视图；Ctrl+1..9 切视图（顺序=侧栏序）；`/` 聚焦当前视图搜索框（无则忽略）。
- 输入框聚焦时 `/` 不抢占；零 router 依赖（I3 已收官的 useState 路由与 11 视图 hash 映射不回退，本批只是加监听）。

## 3. M3=I12 Toast 单例队列

- App 级唯一 toast 队列（provider/context；并发上限+排队，bottom-right 不再相互覆盖）；主窗口各视图局部 useToast 实例全部迁移。**OverlayApp 悬浮窗是独立窗口，保留自有 toast 不动**。
- API 形状尽量不变（show(msg,type)），各调用点反馈语义零变化。

## 4. M4=F6 relativeTime 时效刷新

- 全局低频 1min tick 仅驱动 relativeTime 消费组件重算。**format.ts 输出文本契约零触碰**（D2 批 smoke 断言联动 0 处口径——relativeTime 中文输出原样）。

## 5. M5=P3 美观四小项（AUDIT §1 P3）

- **A5 确认流统一**：剩余 native window.confirm×9 处 → 应用内确认组件（复用 DockerView modal / ApiHub import-overlay 形态）；确认时机与语义零变化；I5 Skills 直切裁决不回退（异常态一次确认保留，只换呈现形态）。
- **A6 EmptyState 图标**：禁止⃠ → 中性空态图标（可分域选型）。
- **A7 过渡动画**：统一 `transition: background-color .12s, border-color .12s`（只这两个属性，防滚动掉帧；性能基线 169fps 不回退）。
- **A8 Versions**：state=unknown 且 lastCheckedAt=null 时禁用 Update 并提示先 Check All。

## 6. 门禁与验证（全绿才汇报完成）

- 主仓门禁：typecheck 0 error + smoke fast 档全绿（基线 **115/115**；新增用例如实计数）+ `npm run build` 成功。
- CDP 运行时验证（零 OS 输入注入，D-Aud 先例）：taskkill DevHub.exe → 带 `--remote-debugging-port=9222` 启动 dist/win-unpacked/DevHub.exe → 逐条验证：
  1. Ctrl+1/2 与 F5 真实 keydown 生效（视图切换/刷新可断言）；
  2. toast 队列并发≥2 条不重叠（DOM 计数带阳性对照）；
  3. relativeTime 65~70s 后「刚刚」翻「N 分钟前」；
  4. 四处「浏览…」按钮渲染+通道调用断言（原生对话框目视留主控换装后手测）；
  5. 回归点：hash 深链 12/12、loadMore 真追加、Docker Remove modal、BackupPanel 默认折叠、会话行 role=button+焦点环。
- 测毕 taskkill → 无参拉回常驻 → `GET /v1/health` ×3 同 PID 200（活性路由 /v1/health，9222 无监听）。

## 7. 边界

- Android 零涉（不出 APK）；**不换装**（收官 X11 与 updater 批合一次做）；ECS 零触碰；不改路由机制本身。

## 8. 汇报

commits 清单 + 门禁数字（typecheck/fast 计数）+ CDP 逐条证据（DOM 断言值）+ 偏差如实 + 遗留（若有）。
