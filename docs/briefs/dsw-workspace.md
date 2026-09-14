# DSW 批任务书：DeepSeek managed 工作区生产旋钮（RD run3 阻断修复）

> 背景：RD run3（acceptance/mobile-chat-relay-e2e/run3/）定位：spawn 在真实生产环境确定性失败——`deepseekProvider.startManagedSession` 的 cwd/workspaceRoot 默认=**用户 home 根**（deepseekProvider.ts:765/deepseekManagedConfig.ts:139 默认值）→ dsh 沙箱 temp-root 撞 Windows ACL → initialize 30s 超时 → COMMAND_NOT_EXECUTABLE（ECS remote_commands #145/#146；手动 plain-node 同配置秒答=运行时本体无罪）。`managedWorkspacePath` 仅有 smoke 注入缝、**无生产旋钮**。基线 main=DM 合并后 main；门禁 fast 132/full 232。

## 0. 工作区与纪律

- worktree：主仓根 `git worktree add worktrees/dsw-workspace -b agent/dsw-workspace main`；`npm install`。
- 每 commit 即 push 分支（直连优先 socks5h://127.0.0.1:1081 兜底重试循环）；绝不 push main；绝不 --no-verify；凭据三零。
- 小批纪律：改动面收在 settings 键+config 渲染+provider cwd+单测；**零架构扩张**。

## 1. 修法

1. settings 键 `deepseek_managed_workspace`（ALLOWED_KEYS；Mimosa：env→path 复用 resolveHomeDir 既有边界函数）。
2. **默认值=安全目录**：`%APPDATA%\DevHub\dsh-workspace`（经 paths 既有边界解析，DEVHUB_HOME 策略感知；目录按需创建 0700 语义）；**绝不默认 home 根**。用户可设任意已存在目录（不存在则结构化错误+人话文案，绝不静默建在奇怪位置）。
3. `deepseekManagedConfig`：渲染 cordis.yml `sandbox-policy.workspaceRoot` 与 spawn cwd 均取「键值 ?? 默认」；smoke 注入缝保持向后兼容。
4. spawn 表单/详情 ⓘ 如实显示生效工作区路径（「工作区：<路径>」一行，用户面可见 agent 在哪读写）。
5. 单测：默认解析/显式键覆盖/不存在目录结构化拒/键=0 全链逐字节不变。

## 2. 门禁与验证

- typecheck 0 + fast 全绿（基线 **132/132**）+ full 全绿（基线 **232/232**）+ build。
- provider 级真机验证（隔离实例单实例窗口纪律，毕还原常驻 health×3）：键=1+默认工作区 → startManagedSession → **initialize 秒答**（对照 run3 的 30s 超时）→ 一条最小 prompt 完成（真实推理 1 条）→ 键归 0。证据追加 acceptance/deepseek-managed-e2e/（run3-fix 子目录）。

## 3. 汇报

commits / 门禁数字 / 真机验证证据（initialize 时延对照）/ 推理消耗 / 偏差如实。**手机全链 E2E 归主控后续 RD run4，本批不做。**
