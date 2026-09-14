# W3 批任务书：离线设备 token_rotation 补投——现状实证+docs/18 修订提案（纯文档批）

> 背景：HANDOFF §5 待办（用户「全做」令解禁）：docs/21「离线设备 token_rotation 补投（docs/18 修订）」。主题：设备离线期间错过 token_rotation 帧后的补投机制。**零编码、零部署、零 ECS 触碰**——本批只产文档与设计，编码另立批（主控裁决决策点后派发）。

## 1. 产出三件

1. **现状实证（只读）**：`ecs-relay/` 代码 + docs/18 相关节 + 投递两腿现状（C7a pair 窗 5s 冲刷+重连补偿）——token_rotation 帧现在如何投递、设备离线错过后的**真实后果**（token 失配被拒？需重配对？以代码为准，绝不推断入册；每条结论带 文件:行号 证据）。
2. **docs/18 修订提案**（新章或增补节）：补投机制设计——候选形态（重连补偿扩展：per-device pending rotation 队列；幂等 fire_key 先例=CP4 账本；安全边界：补投帧认证/重放窗/帧形零扩展优先）；**设计决策点显式列出**（如：pending 存储位置〔relay 库新表 vs relay_audit 复用〕、补投条数上限、过期 rotation 是否补投、与既有 grace/重连补偿的交界）交主控/用户裁决，**不代答**。
3. **实施任务书草稿**（`docs/briefs/token-rotation-impl.md`）：按决策点留孔位；门禁/部署步骤预排（ECS 部署配方引用 RW0 先例：/etc/devhub-relay 物料 0600 + systemd ProtectHome/ProtectSystem 硬化约束 + 备份先行）。

## 2. 纪律

- worktree：主仓根 `git worktree add worktrees/w3-rot-docs -b agent/docs-token-rotation main`。
- 只读侦察：ecs-relay/ 只读不改；真实库与 ECS 零触碰（**不 ssh**）；凭据三零（引用 docs/18 脱敏口径）。
- 每 commit 即 push 分支；绝不 push main；绝不 `--no-verify`。

## 3. 汇报

现状结论（带 文件:行号 证据链）+ 决策点清单（每点含选项+推荐+理由）+ 产出文档路径 + 偏差如实。
