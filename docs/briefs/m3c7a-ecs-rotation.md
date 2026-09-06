# M3-C7a ECS 修复批任务书（轮换投递补偿 + 孤儿设备清账 + 重部署）

> C2d 定案：C6c bug#3 修复无缺陷，**帧结构性不可达**（缺口#10，ECS 侧实现缺口）——服务端内部可修，不扩协议帧面（docs/18 §3.14 精神：轮换帧允许投递于该设备任一活跃 device-leg 连接，C6c 批 KDoc 注）。修后 R-B3 自毁链应断、R-B5/R-B6 大半解锁。
> 基线：main @ c99a2fa；ecs-relay test 91 / selfcheck 77(root)。

## 0. 占用资源

- worktree `F:/Active_Project/DevHub-worktrees/c7a-ecs-rotation`（分支 `agent/c7a-ecs-rotation`，自 main 切；ecs-relay/ 内 npm install）
- **ECS 单元独占**（部署+清账+复验；SSH `~/.ssh/devhub_ecs` root@59.110.149.11）
- 本地不占端口不跑四门禁（8746 归并行批 c7b 独占，它会杀常驻属预期）；不碰模拟器/dist

## 1. 主控已查明事实链（C2d 三设备 #5/#6/#7 确定性复现）

- `handlePairAccepted` 发完 pair_accepted **即刻服务端关闭裸连接且从不注册 deviceConns**；桌面 pairingBridge 同秒发 token_rotation H→E；ECS 仅向已连接设备转发、**无队列无补偿**→帧静默丢弃→App 恒持 v1→grace 300s 到期 401→自毁（R-B3 最长单连 278s/315s，无一 >300s）
- 修向（主控裁，**零新帧**，两条腿都做）：
  ①**裸 pair 窗冲刷**：pair_accepted 发送时若该设备已有未投递的 token_rotation（或同秒到达窗口内），在关闭裸连接**之前** flush 投递（App 侧 PairLegFrameRouter 已就位接帧）
  ②**重连补偿**：设备 WS admit 时若 token version < current 且在 grace 窗内 → admit 后立即补投 token_rotation(当前 token)——任何路径漏投的安全网
- 语义红线：补偿只在 grace 窗内（窗外仍 401 token_rotation_grace_expired 不动摇）；selfcheck §11 三态断言零回退；audit 补投事件记 source（如 `compensation`/`pair-window`）可追溯
- **孤儿清账**：ECS relay_devices #2/3/4/5/6/7 六行 active 孤儿（v2 明文无人持有，撤销通道阻断）→ SQL `UPDATE ... SET status='revoked'` + relay_audit 逐行 `device_revoked(source='orphan-cleanup-batch')`（SQL 绑定；改前 SELECT 快照留汇报；#1 已 revoked 勿动）

## 2. 任务

1. worktree 自建 → 两条投递腿实现 + 单测（pair 窗冲刷时序/重连补偿/窗外不补偿三态至少三例）→ 全套 ecs-relay test 绿（91+新增）
2. 孤儿清账（先快照后改；改后 SELECT 复核六行 revoked+audit 六行）
3. 重部署（docs/ecs-relay-deploy README runbook；失败照 README 回滚）+ selfcheck 全绿（77+若加项照实报）+ journal 部署后零 error + 两表终态快照
4. 增量提交接力，每 commit 即 push `agent/c7a-ecs-rotation`

## 3. 铁律

ECS 除 devhub-relay 部署与上述清账 SQL 外零改动；SQL 绑定；凭据三零（token/指纹全值零入汇报）；绝不 --no-verify；卡死 ≤2。

## 4. 汇报（四分类）

两腿 diff 摘要+测试数字；清账前后快照对照表；部署要点（停机窗/selfcheck 实测数/journal）；分支 push 状态。**活体 R-B3 复验留 C2e**（本批常驻被并行门禁批杀属预期）。
