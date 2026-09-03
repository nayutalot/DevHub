# DevHub Phase 2/3（Agent Control / Mobile）最终报告

> 批次：AC9 终验收文档批次（分支 `ac9-docs`，基线 `b8a819a`）。
> 性质：**骨架 + 已定事实填充**。已定事实均标注仓内证据路径；原 AC8 e2e
> 收尾与 AC9 终验确认的数字/结论以显式 **`TODO-AC8`** / **`TODO-AC9`** 占位
> 标记，**现已在 AC9 终验（2026-09-04，基线 HEAD `007d8b3`，工作树干净）
> 全部回填实跑数字**，回填处均注明取数来源。

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

> AC9 终验口径：本表为批次摘要 + 模块归属（现状核实），逐文件详单以
> `git log --stat`（基线 `b8a819a..007d8b3`）与各批次报告存档为准，不再
> 单独展开（AC9 终验裁决：模块归属粒度已满足验收需要）。

## 2. Phase 1 / MCP / Skills / Archive 回归结果

- **smoke**：基线记录 **140/140**（来源：基线提交 `b8a819a` 提交信息
  「smoke 140/140」+ `acceptance/agents-mobile/ac8-blocked.md` §2「140/140
  基线内」），含 Phase 1 / 并库 S1-S6（s1-40..s5-80）与 MCP 相关旧用例全部。
  - 口径差异已消解：**AC9 终验实跑 `node scripts/smoke.mjs` =
    141/141 passed**（2026-09-04，HEAD `007d8b3`；第 141 例 = 合并批次新增
    `sec-fix: skills doctor crlf fix` 用例），终数 **141/141**。
- **mcp-acceptance**：**22/22**（`scripts/mcp-acceptance.mjs` 用例注册实数
  核实 = 22；AC9 终验在终验提交落库（树净）后复跑确认 22/22，其中 A12
  「git.status 真实仓库 + 工作树干净」断言依赖树净，在 AC9 验收产物未提交前
  实跑为 21/22（A12 预期失败，原因 = 工作树含待提交验收产物，非代码缺陷），
  树净后复跑全绿）。
- **四门禁终跑（AC9 终验，2026-09-04，基线 HEAD `007d8b3`，工作树干净）**：
  1. `npx tsc --noEmit` → **PASS（0 错误）**
  2. `node scripts/smoke.mjs` → **141/141 passed**
  3. `node scripts/mcp-acceptance.mjs` → **22/22**（树净后终跑；过程口径见上）
  4. `npm run build`（electron-vite）→ **OK**（main 77 modules / preload 2 /
     renderer 49 modules 三 bundle 全过）

## 3. 各 Agent 实际验证状态表

| Agent | 通道 | 实际验证状态 | 关键证据 |
| --- | --- | --- | --- |
| Codex | managed + observed | **managed 会话 + 手机 reply/pause/resume 真机握手通过**：app-server 握手实测 158 protocol methods（managed 能力集 [reply,pause,resume]）。真机端到端（模拟器 10.0.2.2 回环路径）全链路通过：托管会话发起 → 列表 → 系统通知 → deep link → 手机回复 202 → 真实推理 → 消息回流 → WS ack 全 acked | `acceptance/agents-mobile/ac8-blocked.md` §2（nativeId `01a06803-727a-79c3-9b91-79db4fce78b9`、会话 #328、commandId `cmd-d0c6cf35-313e-420f-ad24-1a525c561f4e`、16 事件序列、event_deliveries 121 行全 acked）；`ac8-e2e-06/07/08/09/10/12/13-*.png` |
| Claude Code | observed | observed 通道接入（转录解析 + 增量消费）；attached 模式 reply 未授予（hooks 无输入注入 API，能力验证门收缩为空集）；状态判定实测多为 unknown | `src/main/services/agentControl/providers/claudeProvider.ts` 头注释与 L645；docs/12 §8.2 |
| Kimi | observed + 夹具 managed | observed 通道接入（wire.jsonl 判定表实机语料后定）；managed 通道**夹具全验证、真机端到端未验证**（真实托管必写 `~/.kimi-code` 红线，待用户授权场景） | `kimiProvider.ts` 头注释「真机 managed 探测跳过」；smoke 夹具用例（ac4 段） |
| ZCode | observed-only | 首版全部 observed（非公开 CLI 无控制通道）；approval 判定源已接但本机语料无 pending 形态；两库（db.sqlite + tasks-index.sqlite）51/51 任务覆盖 | `zcodeProvider.ts` 头注释（实测取值全集） |
| DeepSeek Harness | 未接入 | 骨架 + 能力检测（源码树 detected → health）；显式「未接入」文案；绝不伪造 | `deepseekProvider.ts`（`DEEPSEEK_NOT_INTEGRATED_NOTE`） |

> 数字口径已收口：**Codex methods 终数 = 158**（managed 能力集
> [reply, pause, resume]）。终验取数来源 = 真库只读快照
> （`acceptance/ac9-db-snapshot.mjs`，node:sqlite readOnly 直连
> `%APPDATA%\devhub\devhub.db` 的 `agent_providers` 表）：provider=codex 行
> `version = 0.153.0-alpha.5`、`capabilities_json` 含
> `evidence: "app-server handshake ok (158 protocol methods observed)"`、
> `health = ok`。仓内存档（`codexProvider.ts` 头注释、`ac8-blocked.md` §2）
> 与真库快照三处一致；早期会话记录的 157 为合并前旧值，不再采用。

## 4. 哪些能手机回复

- **Codex（唯一已验证可回复的 provider）**：managed 会话经手机
  `POST /v1/sessions/{id}/reply` → 202 → provider 执行 → `command.result`
  回推 → 第二次真实推理回流，全链路已在模拟器回环路径实测通过（证据见 §3
  Codex 行）。**AC8 收尾结论（终验确认）**：会话 #337 完成
  waiting_input → 系统通知 → 手机 deep link 回复 → Codex 真实收到并回流
  的真实端到端闭环，事件/ack 证据见 `ac8-blocked.md` §2 与
  `ac8-e2e-06/07/08/09/10/12/13-*.png`；隧道（NatPierce）形态仍待用户凭据
  （§6，外置依赖，非代码缺陷）。
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
- **AC9 终验回填**：最终产物 =
  **`F:\Active_Project\DevHub\android\app\build\outputs\apk\debug\app-debug.apk`**，
  10,819,083 字节，versionCode 1 / versionName 1.0（`output-metadata.json`），
  SHA-256 `81278d5a45ac739eebc0137c88823b49f13020139f65f7b404ea17521b454c19`。
  口径注明：AC9 终验尝试主仓 gradle 重建（`gradlew assembleDebug`），因验收
  环境 `JAVA_HOME` 未设且系统无 JDK（wt1/wt3 构建会话的临时 Java 环境未
  持久化）而不可行——如实记录为环境阻塞，非代码缺陷。采用 **wt1 分支构建
  产物**（AC8 真机 e2e 实际安装验证的同一 APK；wt1 android/ 代码与主仓
  HEAD 逐字节一致：`git diff a8d8c9d..HEAD -- android/` 为空），复制至主仓
  标准路径并以 SHA-256 固定。主仓路径下早于 wt1 android 修复的旧产物已被
  此最终产物覆盖。

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
并在该文件追加「已解除」记录。**终验状态**：仍待用户三项凭据（外置依赖，
非代码缺陷），归入 §7 未验证事项 #1。

## 7. 未验证事项

1. **NatPierce 隧道下端到端与防重放公网回归**（B1–B8，见
   `ac8-blocked.md` §1；本地回环版本已全过）。
2. **Kimi 真机 managed 端到端**（真实托管必写 `~/.kimi-code`，待用户授权场景）。
3. **Codex turn/interrupt 活跃中断**（需在真实 turn 进行中打断，与「用量最小
   化 1-2 turn」冲突，失败不阻塞；`ac8-blocked.md` §2 如实记录未执行）。
4. **Android 后台连接稳定性长期验证**（续航/厂商杀后台策略；见
   docs/known-limitations.md §4.1）。
5. **Claude Code hooks 审批判定源实测**（hooks 未注册，判定源未活跃）。
6. ~~合并后四门禁终跑~~ **已完成（AC9 终验）**：四门禁终跑全绿（tsc 0 /
   smoke 141/141 / mcp-acceptance 22/22 / build OK），结果已回填 §2。

## 8. 已知限制

全量见 **`docs/known-limitations.md`**（AC9 批次逐条对照代码核实收录：五家
provider 接入边界、MCP 4 只读 tool 遗留、桌面 UI 分页/重探/事件过滤、Android
无 FCM、NatPierce 凭据缺失、Phase 1/并库旧已知项 5 条；每条含影响面与解除
路径）。

## 9. 复现命令

### 9.0 终验基线与并发批次流程

```bash
git log --oneline -1    # AC9 终验基线 HEAD = 007d8b3
# （ac9: merge wt1-wt3 + A12 git-init assertion update + npm resolution
#   single-source (where.exe) with poison containment + untrack scenario report）
# 本终验批次自身的提交在此基础上前移（见 §10 同批 manifest 与提交哈希）。
```

并发批次（worktree）流程：主仓在 `F:\Active_Project\DevHub`（main），各批次
在独立 worktree 并行推进（`git worktree add ..\DevHub-wtN -b <branch>`）：
wt1 = `ac8-e2e`（真机端到端证据 + 修复）、wt2 = `ac9-docs`（本报告骨架）、
wt3 = `ac9-env`（ac3-97 稳定化 + android 构建 + npm 解析收敛）。各 wt 独立
跑四门禁后，由主仓一次 `git merge` 收敛（007d8b3），收敛后主仓复跑四门禁
终验（§2 数字即收敛后终跑）。注意：worktree 并发期间各仓各自持有构建产物
（APK/日志），交付物以主仓标准路径 + SHA-256 清单（§10）为准。

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

> AC9 终验已实际执行 §9.1 四门禁与 §9.2 的产物核验（结果见 §2/§5）；§9.3
> 配对/回复链路不再重复执行（AC8 会话 #337 真机端到端已闭环，证据见 §3/§4），
> 该节保留为完整复现指引。

## 10. 交付物 SHA-256 清单

`acceptance/agents-mobile/SHA-256-SUMS.txt` 由
`node scripts/manifest-sha256.mjs` 生成（覆盖 acceptance 截图/证据、APK、
docs、关键脚本；`--check` 复核模式见脚本头注释）。**AC9 终验回填**：已在
最终产物态（含 ac9-*.png 全视图截图、ac9 托盘/数据库取证脚本、最终 APK）
重新生成，**共 149 个文件**，`--check` 复核 **149/149 全部匹配**。
