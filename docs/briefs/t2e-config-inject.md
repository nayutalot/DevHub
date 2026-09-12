# T2e 批任务书：zcode 托管密钥注入机制改版——env 注入 → CLI 配置文件注入（设计级消除污点链）

> 背景（主控已查明，从结论续做）：
> - push 钩子全树跨文件 L3 仍标 `zcodeProvider.ts:1158 [medium] 跨文件污点`（T2d 薄委托没断链——数据流本身还在：`decryptProfileKey→apiKeyPlain→buildManagedSpawnEnv→spawnManaged(env)`）。commit 钩子增量扫/ push 钩子全树扫，深度不同已被实测证实。
> - **根治=消除数据流本身**：Z1 侦察实证（acceptance/agents-mobile/zcode-appserver-scout-20260912/REPORT.md Q2）CLI 无头失败时 stderr 自述「Create C:\Users\sakuya\.zcode\cli\config.json with an explicit model provider before running ZCode.」——**CLI 官方推荐机制就是配置文件**，且密钥明文本就存在于 `~/.zcode/v2/config.json`（ApiHub zcode 适配器既有写面，全项目史从未被扫描器标记）。本批把托管密钥从 spawn env 改为写 `~/.zcode/cli/config.json`，spawn env 零密钥。
> - 副作用全为正：密钥不再进进程环境；与桌面 ZCode 配置方式对齐；T2d 的 buildZcodeCliEnv/buildManagedSpawnEnv 随 env 注入退役（git 史保留）。

## 0. 红线

- 28 条合同；凭据三零；android/ 零触碰；migration 零；绝不 --no-verify；绝不碰 .mimosa/。
- **写用户 `~/.zcode/cli/config.json` 是本批核心设计**，但必须：①已存在则**合并**（保留用户既有字段，只 upsert model provider 相关键——复用/仿照 adapters.ts 的 applyConfig 家族原子写模式：tmp+rename、幂等）②不存在则创建（父目录不存在则 mkdir recursive）③写入内容零日志零审计；④失败（不可写/磁盘错）→ 结构化 unconfigured reason，绝不半写。
- smoke fast 基线 **113/113 计数不得变**（用例就地改断言，不增删用例数）；新增纯函数单测允许在既有测试类内加 case。

## 1. 实施步骤

1. **侦察 CLI 配置 schema（先行，决定实现形态）**：静态反混淆 `C:/Users/sakuya/AppData/Local/Programs/ZCode/resources/glm/zcode.cjs`（12.6MB bundle，grep `config.json`/`cli/config`/`createModelAdapter`/`model_config_missing` 上下文），确认 `~/.zcode/cli/config.json` 的确切 schema（是否与 v2/config.json 的 providerId/baseURL/kind + key 同形，`config.model` 字段形态）。**同时**可最小活体验证：临时目录 + `--cwd`/env 引导下起 app-server，确认「带合法 config 文件时启动不再报 model_config_missing」（纯配置加载校验，**零推理任务**）。schema 侦察失败或形态远超预期 → 停手上报（勿猜 schema 硬写）。
2. **zcodeManagedConfig 改版**：`readZcodeManagedConfig` 产出改为「CLI 配置注入计划」（settings 键 model + ApiHub 活动档案 baseURL/kind/providerId + 解密 key → 目标文件内容），新增 `ensureZcodeCliConfig(deps)`（读-合-写原子 upsert；deps 注入 readFile/writeFile/homeDir 供 smoke）；**删除** buildManagedSpawnEnv/buildZcodeCliEnv 与 provider 的 env 注入（ZCODE_MODEL/BASE_URL/API_KEY/<PROVIDER>_API_KEY 全部不再注入——spawn env 回归 process.env 透传）。快照 reason 文案同步（如「cli config write failed: …」）。
3. **zcodeProvider**：startManagedSession 前调 ensureZcodeCliConfig，成功才 spawn；spawn env 注入面删除。
4. **smoke 就地更新**：t2z-104（env 断言→config 文件内容断言：fake home 下文件被写、键值对、既有用户字段保留、幂等二次写同结果）、t2z-107（fixture env 注入断言→ensureZcodeCliConfig 内容断言）；其余 zcode 用例核对（计数不变）。
5. **门禁**：`npm run typecheck`（0）+ `npm run smoke:fast`（113/113）。
6. **commit**（连同本任务书；worktree 树含修复后代码，增量钩子实测会放行）。**push 不要做**——主控会用带外扫描预验证后自行推送（避免用户侧弹窗）。

## 2. 汇报

schema 侦察结论（字段清单+证据行）、diff 概览、门禁两数字、commit sha（不 push）、偏差如实。若步骤 1 停手：上报侦察到的形态与阻塞点。
