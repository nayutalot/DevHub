# M3-C8a 修复批任务书（App sync 引导死锁修复 + R-B6 app-off 单面复验 + 桌面存量行清账）

> C2e 终验唯一 FAIL：R-B6 app-off 补发——**App 侧既有 sync 引导死锁**（与 C7a/C7b 修复无关）。修过即 R-B 表收口至"除用户裁决项外全过"→M3-D T0 点火。
> 基线：main @ c834c6f（smoke 172 / mcp 27 / :core 183 / :app 47 / ecs-relay 97）。

## 0. 占用资源

- worktree `F:/Active_Project/DevHub-worktrees/c8a-sync`（分支 `agent/c8a-sync`，自 main 切）；npm install + android/local.properties 复制 + JAVA_HOME jbr
- 门禁时段 8746+双进程名互斥（常驻杀掉属预期，复验段自拉起——**桌面代码本批零改动，现包仍有效**）
- 复验段：模拟器 1 台全新无 CA；ECS 只读（SSH `~/.ssh/devhub_ecs`）；截图 `acceptance/agents-mobile/m3c8a-*.png`；证据分支 `agent/m3c8a-evidence`

## 1. 主控已查明事实链（C2e 实证）

- **死锁链**：`sendRelaySyncRequest()` 对 `after<=0` 早退（ConnectionManager.kt:729 附近）→ fresh install 游标永 0 → sync_request 永不发 → gapFill 仅由 hasGaps 的 sync_response 触发→依赖 sync_request→确定性引导死锁。后果：补发永不启动、held 队列只增（批内实测 held=870+）、`event_ack_state` 永不落盘。**桌面侧回填本身正常**（夹具事件 21710-21712 经常驻全部到达 ECS relay_events 已验证）——纯 App 侧游标引导问题
- **修向前置=读 docs/18 §3.11（sync_request/response 语义）与 §6.3（事件序）**：若契约已定义 fresh/无游标设备的补发引导（如 hello 携 sequence 或首帧全量 sync）→ 照契约实施；若契约空白 → 最小实现（如 hello.sequence 作游标初值、或 after<=0 时发全量 sync_request 让 ECS 回最新水位）+ KDoc 标注空白点，**不扩帧面**
- **复验判据（R-B6 app-off 原判据）**：杀 App → 期间桌面产生 ≥3 事件（synthetic 夹具模式）→ 重连 → sync_request 发出（游标>0）→ 补发到达零丢失（sequence 连续断言）→ event_ack 落盘、held 队列消化
- **桌面存量行清账**：remote_devices 存量 active 行（#2-7/10-37/44/45，先前批次遗留）经 m3c7b-orphan-revoke.mjs 同模式脚本清账（前后快照；#46 在役勿动、#47 已 revoked 勿动）

## 2. 任务

1. worktree 自建 → 读契约 → 修 sync 引导 + 单测（fresh 游标引导/已有游标不回退/held 消化/ack 落盘至少四例）
2. 分支门禁全跑：typecheck / smoke:fast / smoke 全量 172 / mcp 27 / gradle `:core:test :app:testDebugUnitTest :app:assembleDebug`
3. **单面活体复验**（分支 APK 即可，内容=修复本身）：拉起常驻（现包有效）→ 模拟器配对（新配对码，零孤儿预期）→ R-B6 app-off 判据全过截图/JSON 证据
4. 桌面存量行清账（快照留汇报）
5. 增量提交接力 push `agent/c8a-sync`；证据入 `agent/c3c8a-evidence`→笔误更正：`agent/m3c8a-evidence`

## 3. 铁律

修法不偏离 §1（契约空白=最小实现+标注不扩帧面）；凭据三零；绝不 --no-verify；不为绿而绿；ECS 零写；卡死 ≤2；收尾：常驻保持运行（M3-D 待命）、模拟器关、进程清零复核。

## 4. 汇报（四分类）

diff 摘要+契约结论（§3.11/§6.3 是否已有引导语义）+单测清单+分支门禁表+**R-B6 app-off 复验判据逐条证据**+清账快照+push 状态+环境终态（常驻 connected=true）。
