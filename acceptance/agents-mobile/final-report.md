# DevHub Phase 2/3（Agent Control / Mobile）最终报告

> 批次：AC9 终验收文档批次（分支 `ac9-docs`，基线 `b8a819a`）。
> 性质：**骨架 + 已定事实填充**。已定事实均标注仓内证据路径；所有待 AC8 e2e
> 收尾与 AC9 终验确认的数字/结论以显式 **`TODO-AC8`** / **`TODO-AC9`** 占位
> 标记，供母智能体合并后填充替换。
> 数字口径声明：本报告不重跑全量 smoke（AC9 文档批次铁律），回归数字引用
> 仓内存档记录并注明来源。

---

## 1. Phase 2/3 各批次改动文件

> 说明：仓库历史在 worktree 化时收敛为单基线提交 `b8a819a`（Phase1 + MCP +
> 并库 S1-S6 + AgentControl AC0-AC7b + AC8 中段），**无法从 git 历史反推各
> AC 批次的逐文件改动**。本节按各批次任务摘要整理模块归属；逐文件详单见各
> 批次报告存档于会话记录。各批次摘要已对照 wt 仓库现状核实（核实点随行
> 标注）。

| 批次 | 内容摘要 | 改动模块（现状核实） | smoke 用例段 |
| --- | --- | --- | --- |
| AC0 | Provider/数据源审计盘点 | 产出盘点结论（随 AC1 文档落定）；代码零改动 | — |
| AC1 | Agent Control 设计文档（docs/11-16） | `docs/11..16-agent-control-*.md` | — |
| AC2 | 数据层：migration 004 + IPC 白名单 68 | `src/main/db/migrations/004_agent_control.sql`（已核实存在）；IPC 白名单 **68 条**（`src/shared/channels.ts` 实数核实）；共享类型 | ac2-81..88 |
| AC3 | Provider 框架：spawnManaged + Codex + Claude Code | `src/main/core/exec.ts`（spawnManaged）；`agentControl/providerRegistry.ts`；`providers/codexProvider.ts`、`providers/claudeProvider.ts`；监控管线 `eventPipeline.ts` / `monitorRegistry.ts` | ac3-89..104 |
| AC4 | Kimi + ZCode + DeepSeek 三家接入（WIRED 五家收口） | `providers/kimiProvider.ts`、`providers/zcodeProvider.ts`、`providers/deepseekProvider.ts`（`WIRED_PROVIDER_IDS` 五家已核实） | ac4-105..116 |
| AC5 | 托盘 + Agents 视图 | 托盘 `traySummary.ts`；`src/renderer/src/views/AgentsView.tsx` | ac5-117..119 |
| AC6 | Remote Gateway（HTTP/WS/配对/鉴权/防重放） | `agentControl/gateway/{httpServer,auth,pairing,ws}.ts`；会话列表服务端过滤 + Load more（100→200 封顶） | ac6-121..136 |
| AC7 | Android App（前台服务 + WS + 通知 + deep link） | `android/app/src/main/java/com/devhub/mobile/**`（connect/MainActivity 等） | —（真机验收） |
| AC7b | Gateway SDK + code-only 安全收紧 | gateway 侧收紧 + Android 网络栈；`GATEWAY_LOCAL_ONLY` 回环校验 | ac7b-137..138 |
| AC8（中段→e2e） | Codex 托管会话 + 真机端到端 + NatPierce 投影 | `providers/codexProvider.ts`（managed 最小路径 + 持久连接）；`natpierce.ts`；Android `ConnectionManager.kt` 主线程修复；`docs/natpierce-setup.md` | ac8-139..140 |
| 安全修复 | skills doctor crlf 越界跳过等加固回归 | `src/main/services/skills/doctor.ts`（contained-in-vault 校验） | sec-fix（未编号） |

> `TODO-AC9`：合并后由母智能体以各批次报告存档核对/补全本表逐文件详单链接。

## 2. Phase 1 / MCP / Skills / Archive 回归结果

- **smoke**：基线记录 **140/140**（来源：基线提交 `b8a819a` 提交信息
  「smoke 140/140」+ `acceptance/agents-mobile/ac8-blocked.md` §2「140/140
  基线内」），含 Phase 1 / 并库 S1-S6（s1-40..s5-80）与 MCP 相关旧用例全部。
  - 口径差异注明：母智能体会话记录为 **141/141**（疑含合并批次新增用例）。
    本报告以仓内存档为准 → **`TODO-AC9`**：合并后重跑一次 smoke 终验并回填
    最终数字。
- **mcp-acceptance**：**22/22**（来源：`scripts/mcp-acceptance.mjs` 用例注册
  实数核实 = 22；HANDOFF.md S6 终验记录同值）。
- **四门禁基线**：`npx tsc --noEmit` / smoke / mcp-acceptance / build 全绿
  （S6 终验记录，HANDOFF.md §4；AC 批次按同口径逐批复验）。
  **`TODO-AC9`**：合并后四门禁终跑结果回填。

## 3. 各 Agent 实际验证状态表

| Agent | 通道 | 实际验证状态 | 关键证据 |
| --- | --- | --- | --- |
| Codex | managed + observed | **managed 会话 + 手机 reply/pause/resume 真机握手通过**：app-server 握手实测 158 protocol methods（managed 能力集 [reply,pause,resume]）。真机端到端（模拟器 10.0.2.2 回环路径）全链路通过：托管会话发起 → 列表 → 系统通知 → deep link → 手机回复 202 → 真实推理 → 消息回流 → WS ack 全 acked | `acceptance/agents-mobile/ac8-blocked.md` §2（nativeId `01a06803-727a-79c3-9b91-79db4fce78b9`、会话 #328、commandId `cmd-d0c6cf35-313e-420f-ad24-1a525c561f4e`、16 事件序列、event_deliveries 121 行全 acked）；`ac8-e2e-06/07/08/09/10/12/13-*.png` |
| Claude Code | observed | observed 通道接入（转录解析 + 增量消费）；attached 模式 reply 未授予（hooks 无输入注入 API，能力验证门收缩为空集）；状态判定实测多为 unknown | `src/main/services/agentControl/providers/claudeProvider.ts` 头注释与 L645；docs/12 §8.2 |
| Kimi | observed + 夹具 managed | observed 通道接入（wire.jsonl 判定表实机语料后定）；managed 通道**夹具全验证、真机端到端未验证**（真实托管必写 `~/.kimi-code` 红线，待用户授权场景） | `kimiProvider.ts` 头注释「真机 managed 探测跳过」；smoke 夹具用例（ac4 段） |
| ZCode | observed-only | 首版全部 observed（非公开 CLI 无控制通道）；approval 判定源已接但本机语料无 pending 形态；两库（db.sqlite + tasks-index.sqlite）51/51 任务覆盖 | `zcodeProvider.ts` 头注释（实测取值全集） |
| DeepSeek Harness | 未接入 | 骨架 + 能力检测（源码树 detected → health）；显式「未接入」文案；绝不伪造 | `deepseekProvider.ts`（`DEEPSEEK_NOT_INTEGRATED_NOTE`） |

> 数字口径注明：母智能体会话记录 Codex 握手为 **157 methods**；仓内存档
> （`ac8-blocked.md` §2、`codexProvider.ts` 头注释「AC8 实测
> 0.153.0-alpha.5 全集 158 方法」）为 **158**。本表以仓内存档为准。
> **`TODO-AC8`**：AC8 e2e 收尾复跑后回填最终 methods 数与能力集。

## 4. 哪些能手机回复

- **Codex（唯一已验证可回复的 provider）**：managed 会话经手机
  `POST /v1/sessions/{id}/reply` → 202 → provider 执行 → `command.result`
  回推 → 第二次真实推理回流，全链路已在模拟器回环路径实测通过（证据见 §3
  Codex 行）。**`TODO-AC8`**：AC8 e2e 终态与隧道下复验确认后回填结论。
- **Kimi**：实现已就位（spawnManaged + writeStdin + 终态轮询确认），仅夹具
  验证，真机回复未验证（见 docs/known-limitations.md §1.5）。
- **Claude Code / ZCode**：不可回复（observed-only，能力门空集）。
- **DeepSeek**：未接入。
- 安全边界：远程面只有 reply/pause/resume 三种会话动作，能力验证门服务端
  二次校验；能力过期（>300s）→ 403 `AGENT_CAPABILITY_MISSING`（真机实测，
  `ac8-e2e-13-pause-attempt.png`）。

## 5. APK 路径

- 标准产物路径：`android/app/build/outputs/apk/debug/app-debug.apk`
  （debug 变体；applicationId `com.devhub.mobile`）。
- **`TODO-AC8`**：wt 工作副本内当前无 gradle 构建产物（未跑 build）；合并后
  由母智能体回填实际构建产物的绝对路径、版本号与构建时间。

## 6. NatPierce 待用户填写项

> 全部为用户外置凭据，DevHub 零代管（docs/15 §8）。配置方法详见
> `docs/natpierce-setup.md`。

| 项 | 说明 | 状态 |
| --- | --- | --- |
| `NATPIERCE_ENDPOINT` | 隧道服务端地址（http/https） | 待用户填写 |
| `NATPIERCE_ACCOUNT` | NatPierce 账号 | 待用户填写 |
| `NATPIERCE_TOKEN` | NatPierce 访问凭据 | 待用户填写 |
| 隧道对外地址 | App 网关配置改填隧道分配的主机:端口 | 待用户提供隧道后填写 |

填写后复跑 `acceptance/agents-mobile/ac8-blocked.md` §1.3 解除流程（B1–B8）
并在该文件追加「已解除」记录。**`TODO-AC8`**：隧道下回归结果回填。

## 7. 未验证事项

1. **NatPierce 隧道下端到端与防重放公网回归**（B1–B8，见
   `ac8-blocked.md` §1；本地回环版本已全过）。
2. **Kimi 真机 managed 端到端**（真实托管必写 `~/.kimi-code`，待用户授权场景）。
3. **Codex turn/interrupt 活跃中断**（需在真实 turn 进行中打断，与「用量最小
   化 1-2 turn」冲突，失败不阻塞；`ac8-blocked.md` §2 如实记录未执行）。
4. **Android 后台连接稳定性长期验证**（续航/厂商杀后台策略；见
   docs/known-limitations.md §4.1）。
5. **Claude Code hooks 审批判定源实测**（hooks 未注册，判定源未活跃）。
6. **`TODO-AC9`**：合并后四门禁终跑（含 smoke 终数确认，见 §2 口径差异）。

## 8. 已知限制

全量见 **`docs/known-limitations.md`**（AC9 批次逐条对照代码核实收录：五家
provider 接入边界、MCP 4 只读 tool 遗留、桌面 UI 分页/重探/事件过滤、Android
无 FCM、NatPierce 凭据缺失、Phase 1/并库旧已知项 5 条；每条含影响面与解除
路径）。

## 9. 复现命令

### 9.1 桌面四门禁（仓库根）

```bash
npx tsc --noEmit            # 门禁 1：类型
node scripts/smoke.mjs      # 门禁 2：smoke 全量
node scripts/mcp-acceptance.mjs   # 门禁 3：MCP 验收
npm run build               # 门禁 4：electron-vite build
```

### 9.2 Android 构建（仓库根）

```bash
cd android
./gradlew.bat assembleDebug        # Windows；产物 android/app/build/outputs/apk/debug/app-debug.apk
```

### 9.3 模拟器配对 + 手机回复链路（AC8 已验证路径复现）

1. 启动桌面应用（`npm run dev` 或安装包），Agents 视图 → 网关设置 → 启用
   （`gateway_enabled=1`；默认端口 8746，仅绑 127.0.0.1）。
2. 启动 Android 模拟器（验收用镜像：DevHub_API_35 / API 35），安装 APK：
   `adb install android/app/build/outputs/apk/debug/app-debug.apk`。
3. App → 网关配置：主机 `10.0.2.2`（模拟器回环映射宿主机）、端口 `8746`，
   保存。
4. 桌面 Agents 视图 → 签发配对码（8 位 Crockford Base32，TTL 300s，一次性）；
   App 输入配对码完成 claim（限流 5 次/5min，失败 5 次码作废）。
5. 桌面 Agents 视图对 Codex 发起托管会话（trigger 文件
   `getDataDir()/tmp/agent-control/managed-turn.json`）→ 真实推理 → 手机收到
   `session.waiting_input` 系统通知 → 点按 deep link（`devhub://session/{id}`）
   → 详情页回复 → 202 → `command.executed` → 回复回流消息流。
6. 外网形态：按 `docs/natpierce-setup.md` 配置三项环境变量并把
   `127.0.0.1:8746` 透传公网后，App 网关配置改填隧道地址（其余步骤同上）。

> 本报告撰写批次（AC9 文档）铁律未运行任何上述运行时命令；§9 全部为复现
> 指引，执行结果由母智能体合并后回填（`TODO-AC8` / `TODO-AC9`）。

## 10. 交付物 SHA-256 清单

`acceptance/agents-mobile/SHA-256-SUMS.txt` 由
`node scripts/manifest-sha256.mjs` 生成（覆盖 acceptance 截图/证据、APK、
docs、关键脚本；`--check` 复核模式见脚本头注释）。**`TODO-AC9`**：终验合并
后在最终产物态重跑生成 + `--check`。
