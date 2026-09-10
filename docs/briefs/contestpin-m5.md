# CP5 任务书：ContestPin Agent 模式——自动（codex managed）/手动（任务包导出导入）双路径

> 设计权威=docs/22 §8（Agent 模式）；charter=docs/briefs/contestpin-charter.md §六。
> 执行者：omni-agent，worktree `F:/Active_Project/DevHub-worktrees/cp5`，分支
> `agent/contestpin-cp5`（从 main 切出）。桌面-only 批：ecs-relay/android 零改动。

## 0. 主控已核事实链

- main 门禁基线：tsc 0 / fast 100 / full 190 / mcp 27；白名单 **104**。
- **能力矩阵（docs/22 §8 审计）**：codex=唯一 managed（reply/pause/resume 逐方法验证，
  纯文本输入）；kimi=observed+可选 managed reply（spawnArgs 未配置即 unsupported）；
  claude-code/zcode/deepseek=恒 observed。
- **复用锚点（不绕过不自建）**：L3 `startProviderManagedSession`
  （src/main/services/agentControl/agentControlService.ts ~L1449，现成能力门/幂等/审计）；
  监控管线+readMessages 提取；monitorRegistry 取消令牌（作用域=本任务及其托管会话）；
  codexProvider consumeManagedTrigger `{task,requestId}` 文件交接先例（任务包 JSON 风格参照）。
- **管线挂点**：contest_import_jobs 既有 stage 状态机+draft 核对界面（CP3b 落地）；
  importCreate 的 mode 枚举现 two_stage|multimodal——**agent/manual_pack 归本批**
  （docs/22 §5 原文预留）。识别结果一律走既有 validated/核对管线。
- 前置物料：worktree `npm install`（主仓 node_modules 不复制；CP3b 依赖
  pdfjs-dist/@napi-rs/canvas 在 package.json dependencies，npm ci 可得）。

## 1. 设计裁决（主控定，docs/22 §8 权威内细化）

1. **通道 4 条**（docs/22 §3 预告命名）：`contestpin:agentStatus`（READ_ONLY 任务态
   投影）/ `contestpin:agentSubmit`（变更：建 Agent 任务行+托管会话）/ 
   `contestpin:exportPack`（READ_ONLY 生成任务包 JSON 落用户选择目录——路径经
   renderer 对话框+preload 先例）/ `contestpin:importPack`（变更：任务包结果导入→
   同一 draft 核对管线，绝不直写生产行）。白名单 104→**108**，docs/04 就地更新。
2. **自动路径**：agentSubmit 仅对能力验证新鲜的 managed provider 生效（能力陈旧/
   observed → 结构化拒绝 AGENT_UNAVAILABLE 类错误码，不静默降级）；任务文本=材料
   本地文字提取+结构化指令（零文件内容外发超出材料文字本身——与 CP3 识别同一面）；
   托管会话回流经监控管线抽取进 draft；取消=monitorRegistry 令牌只杀本任务。
3. **手动路径**：exportPack 产出 {任务说明, 材料清单, 材料文字} JSON（**零凭据零
   key**，manifest 同款红线）；importPack 解析→校验（形状/材料存在性）→建 draft 走
   核对界面；**不静默覆盖**。
4. **状态机**：任务行复用 contest_import_jobs（mode='agent'/'manual_pack'）或独立
   轻表——**以最小侵入为准，若需新表走 migration 009**（append-only 纪律，docs/03
   预告补一行）；stage 流转对齐既有九值语义，不推翻 CP3b 状态机。
5. **UI**：材料/导入界面加 Agent 双路径入口（自动=Provider 选择+能力态如实展示+
   提交/取消；手动=导出包/导入包按钮）；三态强制零 mock；能力不足如实降级文案
   （「无可用自动 Provider 时两阶段模式完整可用，不用模拟成功代替闭环」——设计红线）。
6. **零改动面**：agentControlService 的能力门语义不改（只消费）；ecs-relay/android/
   docs/18 零触碰；exec.ts 唯一 spawn 纪律（codex 会话由既有 L3 面，本批零新 spawn 点）。

## 2. 交付物清单

1. 后端：contestAgentService（或并入既有 contestpin service 面）——submit/status/
   export/import 四面 + 能力门消费 + 取消令牌 + 审计对齐既有 contestpin 风格。
2. migration（如需 009）+ migrate.ts switch case 9 + docs/03 条目。
3. 4 通道 + handlers + docs/04 追加节（108 就地更新）+ smoke 全量更新：
   - cp5-agent-submit：能力门拒绝（observed/陈旧）+ fake provider 注入式 happy
     path（回流→draft）+ 取消只杀本任务；
   - cp5-pack：export 形状（零凭据断言）+ import 校验/不覆盖/导入走 draft；
   - 计数断言就地更新（104→108）。
4. renderer：双路径入口 UI（三态强制）。
5. docs/22 §8 落地注记（对齐 CP3b/CP4 先例）。

## 3. 门禁与铁律

- 每 commit 即 push `agent/contestpin-cp5`（**GitHub 墙期用 ECS SOCKS 配方**：
  `ssh -i ~/.ssh/devhub_ecs -D 127.0.0.1:1081 -fN root@59.110.149.11` +
  `git -c http.proxy=socks5h://127.0.0.1:1081 push ...`，用毕杀 ssh 进程——
  HANDOFF §7 台账配方）；绝不 --no-verify。
- 门禁：`npx tsc --noEmit` 0 + `node scripts/smoke.mjs --tier=fast`（100+新增）+
  `--tier=full`（190+新增）+ `node scripts/mcp-acceptance.mjs` 27（干净树）。
- **真实 codex 实测（设计表「窗毕 codex 实测」）留主控复验步**——分支门禁全用
  fake provider 注入（零真实推理零配额消耗）；真实实测主控在合并后单独安排。
- 约束 #4/#28：与 docs/22 §8 不可调和处停手上报；smoke 只增不减；凭据三零。

## 4. 汇报

diff 摘要（service/migration/channels/UI/smoke）+ 门禁计数表（tsc/fast/full/mcp）+
能力门语义对照说明 + push 状态。
