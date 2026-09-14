# Phase A——kimi 0.42.0 只读复核差异清单（0.36 → 0.42 漂移面）

> KM 批 docs/briefs/km-kimi-managed.md §1。方法：TEMP 沙箱 HOME（`C:\tmp\kimi-phase-a\home`，
> USERPROFILE 重定向；写入全部落在沙箱）+ `--help`/`--version`/失败路径探针，**全程零推理**
> （沙箱 config.toml 指向 `https://sandbox.invalid/v1`，网络必然失败；真实 ~/.kimi-code 只读）。
> 本机 CLI：`C:\Users\sakuya\.kimi-code\bin\kimi.exe`，`--version` → `0.42.0`（exit 0）。
> 复核时间：2026-09-14。

## 1. 维持不变面（kimiProvider 现有假设全部成立）

| 依赖面 | 0.42.0 实测 | provider 假设 | 结论 |
| --- | --- | --- | --- |
| exe | `~/.kimi-code/bin/kimi.exe`（旁有 fd.exe/rg.exe） | 同 | 一致 |
| `--version` | stdout `0.42.0`，exit 0 | `/(\d+\.\d+\.\d+)/` 解析 | 一致 |
| session_index.jsonl | 每行 `{sessionId, sessionDir, workDir}`；sessionDir 正斜杠 | parseKimiSessionIndex | 一致 |
| sessions 布局 | `<home>/sessions/wd_<workdirslug>/session_<uuid>/{state.json, agents/<agent>/wire.jsonl, logs/, notify/}` | readKimiState/wireFilesOf | 一致 |
| state.json 键 | `{id, version, cwd, createdAt, updatedAt, archived, agents:{main:{homedir,type}}, custom, lastTurnReason}`（+新增键，见 §2） | KimiStateJson 读键 | 一致 |
| 终态线索 | 失败回合实测 `lastTurnReason:"failed"`；wire `turn.ended` reason=`failed`（带 `error{code,message,name,retryable}`） | 终态确认双源 | 一致 |
| 消息投影源 | `context.append_message`（role=user）+ `context.append_loop_event(content.part type=text)` | projectKimiWireMessage | 一致 |
| config.toml 结构 | `default_model` / `[providers.*]`(type/base_url/api_key) / `[models."p/m"]` / `[thinking]` | projectKimiConfig | 一致 |

## 2. 漂移面（0.42 新增/变化；provider 按设计兼容）

1. **state.json 加键**：`version:2`、`isCustomTitle`——增量字段，provider 读键不受影响。
2. **wire 新行型**（provider 一律不据此产生状态，兼容面按设计成立）：
   `runtime.set_binding`、`prompt.completed`（finishedAt/reason）、
   `token_counting.turn_recorded`、`turn.step.retrying`（网络重试，实测退避 0.5s→34s 指数）、
   `turn.step.interrupted`。
3. **新托管可用 CLI 面**（0.36 基线注释未覆盖；Phase B 真机通道的参数来源）：
   - `-p, --prompt <prompt>`：一次性非交互 prompt，`--output-format text|stream-json`；
   - `-S, --session [id]` / `-c, --continue`：resume（**实测 resume 不建新会话**，
     turn 增量落同一 wire.jsonl、turnId 递增、state.json updatedAt 推进——provider
     终态确认的两条证据源都命中）；
   - `stream-json` = stdout NDJSON 事件流（首行 `{"role":"meta","type":"system.version",...}`，
     重试期持续输出 `turn.step.retrying` 事件）→ 可喂 spawnManaged 心跳；
   - `session list --json`、`doctor config`、`acp`（stdio ACP server）、`export/fork/vis`。
4. **home 重定向环境变量 `KIMI_CODE_HOME`**（二进制串证据 60 处；实测 `KIMI_CODE_HOME`
   优先于 USERPROFILE 决定 `.kimi-code` 位置）。生产 wiring 不用它（零注入红线）；
   侦察价值：后续批次的沙箱化缝隙。
5. **`-p` 模式权限形态**：实测落 `permission.set_mode mode="auto"`（非交互免审批）→
   真机 prompt 必须为纯文本指令（E2E 用「只回 token」指令，零工具调用）。
6. **resume 工作区规则**：`-S <id>` 在会话 workDir 之外拒绝
   （`Session "…" was created under a different directory. cd "<dir>" && kimi -r <id>`）→
   argv 通道 spawn cwd 必须对齐 `state.json.cwd`（kimiProvider sendReplyManagedArgv 已实现，
   km-2 夹具锁定）。
7. **失败面形态**：`-p` 失败 exit 1、stderr `error: failed to run prompt: provider.connection_error`，
   重试至多 10 次（`turn.step.retrying` max_attempts=10）→ 门注入 idle 60s（默认 15s 会被
   34s 级退避误杀）、lifetime 300s。

## 3. 不可托管形态（排除记录）

- 裸 `kimi`（TUI）+ 管道 stdin：实测仍启动 TUI（workspace 信任门「Trust this folder?」+
  TTY 依赖）→ **stdin 注入不是 0.42 的真机 managed 形态**。0.36 时代夹具验证的
  spawnArgs+writeStdin 通道保留给夹具（key=0 行为逐字节不变），真机通道走一次性 argv。

## 4. Phase B/C 据此定形

- 门源模板：`['-S','{sessionId}','-p','{prompt}','--output-format','stream-json']`
  （`{sessionId}`/`{prompt}` 由 provider 替换；cwd=state.json.cwd）。
- 探测证据 = `--version`（真实 CLI 版本）+ config.toml 可读性（只 stat 不读内容）。
- 证据文件：本目录 `e2e-report.md`（真机序列）；沙箱现场 `C:\tmp\kimi-phase-a`（仓外）。
