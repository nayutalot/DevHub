# CP4 任务书：ContestPin 提醒系统（引擎+通知+补发去重+UI）

> 系列权威：docs/22-contestpin-design.md §7 / charter §八。前置=CP1-CP3b 已合
> （main≥680dc35；008 表 contest_reminders/contest_reminder_log 已建；通道 97）。
> 执行者：omni-agent，worktree `F:/Active_Project/DevHub-worktrees/contestpin`，分支
> `agent/contestpin-cp4`（自 main 切出）。本任务书自包含。

## 0. 纪律（红线，同 CP3b）

常驻在线：只准 `npx tsc --noEmit` + `node scripts/smoke.mjs --tier=fast`；**绝不跑
全量 smoke/mcp/任何打 8746 的脚本**（需网关的测试自起隔离实例）；不启动 electron；
凭据三零；增量提交每 commit 即 push origin agent/contestpin-cp4；不 merge 不
push main。全量门禁+换装由主控执行。

## 1. 交付物

### 1.1 引擎（`services/contestpin/reminderEngine.ts`，electron-free 纯逻辑）

1. `computeDue(reminders, nodes, nowSec)`：对每条 enabled 提醒计算计划触发时刻：
   - offset_kind=before_days：`节点日 - N 自然日` 的当日 **09:00 本地**（date 精度
     节点按自然日语义；exact 精度按 start_at 秒级减 N*86400）；
   - before_hours：start_at - N*3600（仅 exact 节点合法，date/month 节点拒绝——
     BAD_PAYLOAD 或 flag）；
   - at_time：start_at 时刻本身。
   - done 节点/已过期超 1 自然日的计划不产 due；返回 [{reminderId,nodeId,fireAt,fireKey}]，
     fireKey=`r<reminderId>@<fireAt 自然日桶或秒桶>`。
2. `scanCatchUp(state, nowSec)`：启动/恢复/时钟变化后扫描——due 已过且
   contest_reminder_log 无该 fire_key → 待补发列表（幂等去重根在 log 表
   UNIQUE(reminder_id,fire_key)）；补发窗口上限（默认 48h，更早的错过不再补，
   记 skipped 统计）。
3. fire 落账：触发即 INSERT log 行（fire_key 冲突=已发过，跳过）；节点 done 后
   该节点全部提醒停扫。

### 1.2 通知与调度（`src/main/notifyWire.ts` 新 electron import 位 + 接线）

4. **全仓首个 Notification**（Electron Notification；AppUserModelID 已设
   index.ts:41）：`setNotifyApplier` 注入缝（service 侧 electron-free 调接口）；
   通知点击 → 复用 CP2 的 focusMainWindowApplier 导航 `contest:<id>`（openInMain
   同款）。通知失败（系统禁专注助手等）降级 in-app 记录，不抛。
5. 调度：主进程模块级 `setInterval`（60s 桶扫描句柄，**unref + runQuitTeardown
   最前清理**，trayRefreshTimer 先例）；`powerMonitor` on('resume')/on
   ('shutdown') + `system-clock-changed`（Electron 44 事件名以实测为准）触发
   立即重扫补发。关机/退出后不承诺实时提醒（charter 原文）。
6. in-app 记录：`contest_reminder_log` 即账本；renderer 侧 ContestView 顶栏小铃铛
   显示近 24h 已触发/待办计数（轮询现有通道聚合，不加新推送面）。

### 1.3 通道 +3（97→100）+ 提醒规则 UI

7. `contestpin:reminderUpsert` {nodeId, rule?}（offset_kind/value/channel/enabled；
   UNIQUE 冲突=更新）；`contestpin:reminderDelete` {id, confirmed?}（两段式，impacts=
   log 行数）；`contestpin:reminderLogList` {limit?}（READ_ONLY 近期触发账本）。
   三件套+docs/04+计数 4 处就地更新。
8. ContestDetailView 节点卡：提醒编辑器（预设 7/3/1 天快捷+自定义
   before_days/before_hours/at_time + 通道 windows/in_app 多选+启停）；闹钟
   铃铛面板（近触发列表）。三态无 mock。

### 1.4 smoke（fast）

9. `cp4-engine`：computeDue 全分支（date 自然日 09:00/exact 秒级/before_hours
   拒绝 date 节点/done 停扫/过期窗口）/scanCatchUp（补发去重/48h 窗外 skip）/
   fire 落账幂等；`cp4-reminder-crud`：upsert/UNIQUE 更新/delete 两段式。
   计数 97→100（4 处就地）。

## 2. 完成定义

tsc 0 + smoke:fast 全过 + 红线自查（notifyWire 外零新 electron import/计时器
句柄化可清理/SQL 绑定/零真实通知触发——测试全注入 fake applier）+ 最终消息：
commit 列表/验证摘要/偏差清单/**实机验证清单**（真实 Windows 通知弹出/点击导航/
休眠恢复补发/时钟变化重扫——留主控换装后验）。
