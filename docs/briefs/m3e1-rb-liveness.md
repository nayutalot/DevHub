# D 批任务书：R-B5/R-B8 活体复验（Release 条件链最后 ②）+ RW1 already_on 顺验

> 目的：docs/21 §8 Release 条件链 ②（B 方案复验，判据=docs/20 §3 修订原文）——
> M3-E1 已实现（七值 action 双端+App SelfRevokeFlow），本批=模拟器级活体复验
> （先例=「模拟器级公网 e2e 已过」，物理真机复跑是另一独立项不归本批）。
> 顺带：新 APK（含 RW1 唤醒按钮）实装 + wake already_on 快路径真实验。
> 执行者：omni-agent。资源：模拟器+ECS（只读断言+设备行终态）+常驻（只读）+adb。

## 0. 主控已核事实链（勿重复侦查）

- **常驻在役**：127.0.0.1:8746 health 200（04:02 末次重打包版，含 M3-E1 桌面侧
  spawn_session/revoke_device 处理器）；host 腿已连 ECS（relay_hosts=1）。
- **ECS relay**：M3-E1 版（七值 action CHECK+selfcheck 83+1SKIP）；wake 面在役
  （WAKE_ENABLED=1）；登录 `ssh -i ~/.ssh/devhub_ecs root@59.110.149.11`（只读断言用）。
- **App APK**：`F:/Active_Project/DevHub-worktrees/rw1/android/app/build/outputs/apk/debug/app-debug.apk`
  （03:09 构建=main 9eba8ac：M3-E1 App 面+RW1 唤醒卡）。
- **Provider 面账**（常驻 /v1/agents 实测）：Codex=managed（reply/pause/resume）、
  Claude Code=observed——R-B5 两腿判据的 provider 素材都在。
- **判据权威**（docs/20 §3）：
  - **R-B5**：observed 会话 command → `command_ack rejected COMMAND_NOT_EXECUTABLE`；
    managed 会话经 WS command `spawn_session` → accepted → **真实推理回流**（codex）。
  - **R-B8**：经 WS command `revoke_device` → `disconnect(reason=revoked)` 到达 →
    设备停止重连；再连 401 `DEVICE_REVOKED`；ECS relay_devices 同步 revoked。
- **配对/联调先例**：docs/briefs/m3c3a-app-relayjoin.md 起的 m3c 系流程 +
  acceptance/agents-mobile/ 证据结构（m3c8a 同款）；模拟器 SDK 路径
  `C:/Users/sakuya/AppData/Local/Android/Sdk`（adb/emulator 真身）；公网配对码由
  桌面签发（IPC agents:pairingCreate 同路径——进程外先例=rw0-e2e.mjs 用 node 直调，
  参照 ECS /root/rw0-e2e.mjs 或主仓 scripts 内先例；**不碰生产 UI 数据**）。
- **RW1 帧面**：wake_host→wake_result 六态（docs/18 §3.17）；桌面 host 腿在线 →
  期望 `already_on`（快路径零执行——**真关机 S5 实测是用户独立项，本批不做**）。

## 1. 执行序

1. **预检**：常驻 health；ECS relay 服务 active；adb devices；确认 8746 由常驻持有。
2. **模拟器+装包**：拉起既有 AVD（plugin android_preflight 或 SDK emulator 直起；
   离线→SDK CLI 重拉配方见 HANDOFF §7）；adb install 上述 APK；App 起来后走 relay
   模式配置（端点 59.110.149.11:443——App 内置 pin-TM，先例流程照 m3c 系）。
3. **配对**：桌面签发配对码→App claim→双方在线（relay_devices 新行 active）。
4. **R-B5-腿1（observed 拒绝）**：App 对 Claude Code（observed）会话发 command →
   断言 command_ack rejected `COMMAND_NOT_EXECUTABLE`（帧审计留证）。
5. **R-B5-腿2（managed spawn 回流）**：App managed spawn（spawn_session，codex）→
   accepted → command.result 带 sessionId → **真实推理回流**（消息/事件到达，
   计时；配额纪律=仅 1 次 spawn，任务文本极短如"回复 OK 两个字"）。
6. **R-B8（自撤销闭环）**：App SelfRevokeFlow（submitSelfRevokeRelay）→
   disconnect(revoked) 到达、App 停止重连（观察重连静默≥30s）→ 再触发连接 →
   401 DEVICE_REVOKED → ECS 侧 sqlite 只读断言该 device revoked。
7. **RW1 顺验**：重配对一台测试设备→App 唤醒卡（relay 模式连接区）点「唤醒
   Windows」→ 断言 `already_on`（常驻在线快路径；六态文案如实）。
8. **清理**：测试设备双端撤销核验（ECS revoked+App 侧无 active 残留）；模拟器
   关闭；不留任何配对码/测试行；全程证据落 `acceptance/agents-mobile/`
   （rb5-rb8-<ts>/ 子目录：帧审计/adb 截图/sqlite 断言输出/ECS relay_audit 行）。

## 2. 铁律

- ECS 只读断言（sqlite SELECT / journalctl）+本批测试设备行的终态 revoked——
  绝不改配置/不动 env/不重启服务。
- 真实推理仅 1 次（codex 配额）；失败重试 ≤2 且如实记录失败面。
- 凭据/token 零入证据文件（截图含 token 处打码或裁剪）。
- 常驻不重启不触碰（只读 REST 面）。
- 卡死重试 ≤2 后如实上报（判据未达=如实 FAIL，不为过关放宽）。

## 3. 汇报

R-B5 两腿+R-B8 三断言+RW1 already_on 逐条 PASS/FAIL（对照 docs/20 §3 原文）+
证据文件清单 + 设备清理对账 + Release 条件链 ② 是否满足的明确结论。
