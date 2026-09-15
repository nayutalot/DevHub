# DSN 批任务书：DeepSeek managed spawn 载体解析链（plain node 优先）

> 背景：RD run4 决定性隔离实验（acceptance/mobile-chat-relay-e2e/run4/）：同 cordis 渲染物同参数下，**plain node v24.15 秒答 initialize，electron 内置 node v24.19（ELECTRON_RUN_AS_NODE=1）被 harness cordis loader 拒**（`plugin tree failed to load: failed to apply loader entry include (cordis:include)`，vendor/loader/lib/index.js:91 ← app-boot/lib/index.js:238）——打包常驻 spawn 载体必须换 plain node。主控裁决=**探测链方案**。基线 main=RD run4 修复合并后 main（d5bbc46）；门禁 fast 132/full 232。

## 0. 工作区与纪律

- worktree：主仓根 `git worktree add worktrees/dsn-carrier -b agent/dsn-carrier main`；`npm install`。
- 每 commit 即 push 分支（直连优先 socks5h://127.0.0.1:1081 兜底重试循环）；绝不 push main；绝不 --no-verify；凭据三零。
- 小批纪律：改动面收在载体解析+诊断投影+单测；零架构扩张。

## 1. 修法：载体解析链（三级）

1. **显式键** `deepseek_managed_node`（ALLOWED_KEYS；路径存在性+可执行校验，env→path 复用 resolveHomeDir 既有边界）——开发者兜底旋钮。
2. **系统 node 探测**：`where.exe node` 单一来源（**对齐 npm 解析 AC9 单源先例**，勿做多候选回退）；取首个结果；spawn 前哨兵校验（`node --version` 一次成功后可缓存，失败/超时结构化拒绝）。
3. **降级**：前两级不可用→回落现状 ELECTRON_RUN_AS_NODE='1' 尝试，且 caps evidence/诊断面**如实标注「载体降级：需系统 Node.js（harness loader 不兼容 Electron 内置运行时）」**——绝不静默用必败载体。
- 生效载体与解析结果进诊断投影（哪一级命中的信息如实）。

## 2. 单测

夹具覆盖：显式键命中/where.exe 命中/两者皆无降级+evidence 标注/哨兵失败结构化拒；键=0 全链逐字节不变（既有 dsh-102/103 保持）。

## 3. 门禁与验证

- typecheck 0 + fast 全绿（基线 **132/132**）+ full 全绿（基线 **232/232**）+ build。
- provider 级真机验证（隔离实例窗口纪律，毕还原常驻 health×3）：本机 node 在位→解析链命中系统 node→startManagedSession→initialize 秒答（时延数字）→一条最小 prompt 完成→键归 0。证据追加 acceptance/deepseek-managed-e2e/run4-fix/。**手机 E2E 归 RD run5，本批不做。**

## 4. 汇报

commits / 解析链各级验证证据（本机命中级+时延）/ 门禁数字 / 推理消耗 / 偏差如实。
