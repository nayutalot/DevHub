# M2-R1 收尾批任务书（relay-client smoke 段 + 四门禁 + 终提交）

> 派发基线：worktree `F:\Active_Project\DevHub-worktrees\relay-client`，分支 `agent/relay-client`，HEAD=**26d8249**（八模块代码全完成，树净）。基线 main 侧事实见 HANDOFF.md §4。
> 本任务书为权威版本（HANDOFF §5.1 的落盘副本+补充）；与 HANDOFF 冲突时以本文档为准。

## 0. 占用资源清单（机器资源登记）

- **端口 8746-8755**：smoke 门禁期间独占（需先杀 DevHub.exe 常驻）
- **段外端口 127.0.0.1:18443 类**：smoke 新段的内存 Relay 桩（严禁碰 8746-8755 段内做桩）
- **DevHub.exe 常驻实例**：跑 smoke 前 `taskkill //IM DevHub.exe //F`，跑完立即恢复：`cmd //c start "" "F:\Active_Project\DevHub\dist\win-unpacked\DevHub.exe"` + `curl http://127.0.0.1:8746/v1/health` 确认 200（端口铁律，§2）
- 不使用模拟器；不碰 android/；不碰 ecs-relay/
- 收尾时不得留孤儿 node 进程/端口占用

## 1. 任务

### ① smoke 新段（append-only）

- 位置：`scripts/smoke.mjs` **尾部追加新段**，模式照 ac6 段写法；用例名前缀 `nb-r1-*`
- 帧数据源：`ecs-relay/test/fixtures/frames.json`（16 帧 fixture，权威出处，逐字段对拍，不得手抄帧）
- 内存 Relay 桩：监听 127.0.0.1:18443 类段外端口
- 用例覆盖（至少）：
  1. 16 帧 round-trip 逐帧对拍 fixture（R1 wsClient 编解码 ↔ fixture 字段同一性）
  2. 重连退避参数（1s→60s cap、±20% 抖动、倍增+截断语义，randomSource seam 注入断言）
  3. 断线回填幂等（watermark 前向只进）
  4. 命令排队→上线投递（host 离线 `command_ack{status:'queued'}` → 上线后投递）
  5. 同幂等键重试返回原结果（commandDownlink 幂等重放）
  6. token_rotation 落库+宽限窗口
  7. 撤销踢线（kick injection）
  8. 凭据零入日志/DB 抽样（relay token/pairing code 明文不出现在日志与 DB）
- 计数断言：smoke append-only 铁律——总用例数断言若受影响，就地更新并在提交信息注明（156 基线→新数）

### ② 四门禁（全绿才算过）

1. 跑 smoke 前 taskkill DevHub.exe；跑完恢复常驻+curl 200（见 §0）
2. `tsc` 0 错
3. `smoke`：156 基线 + 新段全绿
4. `build` 全绿
5. `mcp-acceptance`：**先 git commit（树净再跑，A12 教训）**，27/27

### ③ 缺陷处理

- 门禁失败→最小修复→重跑受影响门禁；每 fix 一 commit

### ④ 终提交

- `git commit -m "test(relay): relay-client smoke segment + gates green (M2-R1 wrap)"`

## 2. 铁律

- docs/00 全 28 条合同
- smoke append-only（只增不删不改旧用例；计数断言就地更新+注明）
- **零触碰**：MCP / android / ecs-relay 子目录
- 增量提交纪律：每完成 2-3 个用例立即 git commit；**每次 commit 后立即 `git push origin agent/relay-client`**（防本地丢失，GitHub 增量推送纪律）
- 绝不 `--no-verify`；不无限重试推送（失败记录错误继续本地工作，报告标注未上传项）
- 范围纪律：只动 `src/` + `scripts/`（+必要 test 桩注释）

## 3. 汇报格式（四分类）

- 已完成并验证 / 仅本地验证 / 环境阻塞 / 待用户——逐项列出
- 必带：分支名 + 终 commit SHA + 各门禁数字（smoke X/Y、mcp Z/Z、tsc、build）+ 常驻恢复确认（curl 200）+ 推送状态
