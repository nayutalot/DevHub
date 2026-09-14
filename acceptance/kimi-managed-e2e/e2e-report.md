# KM 批真机 E2E 证据——Kimi Code managed 通道（授权落地）

> 批次：docs/briefs/km-kimi-managed.md（Phase A/B/C）。授权：用户 2026-09-14
> 「推进 kimicode 适配」= known-limitations §1.5 等待解除（真机 managed 必然写
> `~/.kimi-code` + 消耗少量真实推理）。日期 2026-09-14。分支 agent/km-kimi-managed。
>
> **凭据纪律声明**：本目录全部文件经逐文件盘查（`grep -iE "sk-|api[_-]?key|bearer|authorization"`），
> 零凭据；`~/.kimi-code/config.toml` 的 api_key 全程未读取、未投影（DevHub 零注入；
> kimi CLI 用自己的 config）。原始会话文件（wire.jsonl 含对话内容）按纪律只录
> **路径 + 字节数 + sha256 前 16 位**，不入内容。

## 1. 真机边界与窗口纪律（单实例锁）

- 常驻 DevHub.exe（打包件）PIDs 记录后 taskkill：20800/27856/27864/28148/28188
  （electron.exe 无）。验证窗口内常驻全程下线。
- 临时实例：`DEVHUB_HOME=C:\tmp\km-e2e\home`（隔离库，独立 settings/DB）。
- 窗口收尾：taskkill 临时实例 → 无参拉回常驻 → `/v1/health` ×3（见 §5）。

## 2. Phase A 差异清单

见 `phase-a-0.42-review.md`（0.36→0.42 漂移面 7 项 + 维持不变面 8 项 + TUI/stdin
不可托管排除记录）。要点：真机 managed 形态定案为一次性 argv
`kimi -S {sessionId} -p {prompt} --output-format stream-json`（cwd 对齐 state.json.cwd）。

## 3. Provider 级真机 E2E（生产 wiring 同款 driver）

Driver = worktree 生产模块原装组合：`createKimiProvider({ managedGate: readKimiManagedGate })`
+ 隔离 DEVHUB_HOME settings（运行期翻转键值）+ 真实 `~/.kimi-code`。原始日志：
`driver-run.log`（仓内副本，已盘凭据）。逐序列：

| # | 操作 | 实测 |
| --- | --- | --- |
| S0 | probeHealth（只读） | `{"installed":true,"version":"0.42.0","exePath":"C:\\Users\\sakuya\\.kimi-code\\bin\\kimi.exe","health":"ok"}` |
| S1 | 键缺行（默认停用）→ getCapabilities | `mode=observed, granted=[]`，evidence=既有红线文案（键=0/缺行行为与未接线逐字节一致） |
| S2 | 键=1（**运行期翻转，无重启**）→ getCapabilities | `mode=managed, granted=["reply"]`，evidence=`kimi managed face enabled (kimi_managed_enabled=1): kimi --version ok (0.42.0); config.toml readable; reply = one-shot "kimi -S <id> -p <text>" with session-file terminal confirmation` |
| S3 | 真实 sendReply（最小 prompt，**真实推理②**） | `{"ok":true,"status":"executed","detail":"kimi session file terminal state: state.json lastTurnReason=completed"}`，耗时 11772ms |
| S4 | readMessages 投影 + describeDiagnostics | 7 条投影（含 assistant `DEVHUB-KM-E2E-OK`）；诊断 note=`managed one-shot prompt channel enabled (kimi_managed_enabled=1, real inference authorized)` |
| S5 | 键=0（**可撤销证明**）→ getCapabilities | `mode=observed, granted=[]`（与 S1 同款证据） |

### ~/.kimi-code 写入路径级证据（会话 `session_a27c3211-c3d2-44e2-b247-b28eab0d4e08`）

（内容零录入——路径+尺寸+哈希；真实目录 `C:\Users\sakuya\.kimi-code\sessions\wd_ws_3d5a23cd99c9\session_a27c3211-c3d2-44e2-b247-b28eab0d4e08\`）

| 时点 | agents/main/wire.jsonl 字节 | sha256[:16] | state.json lastTurnReason / updatedAt |
| --- | --- | --- | --- |
| reply 前 | 99108 | be23eaa0dce5d67f | completed / 1789385253725 |
| reply 后 | 176421 | bcd341ced8d6a9b7 | completed / 1789385596345 |

wire.jsonl 增长 77313 字节 + state.json updatedAt 推进 + lastTurnReason=completed——
kimi CLI 真实托管启动与真实回合落盘的直接证据（新增 turn.prompt + turn.ended +
stream 事件行；0.42 新行型见 Phase A §2）。

### 推理消耗（如实）

- 真实推理共 **2 次，均为最小 prompt**：
  ① 11:27Z 前后 `kimi -p "Reply with exactly this token and nothing else: E2E-SEED-OK"`
  造 E2E 会话（assistant 回 `E2E-SEED-OK`，~10 token 量级输出）；
  ② S3 经 DevHub managed 通道 `sendReply`（assistant 回 `DEVHUB-KM-E2E-OK`，
  11.8s 回合，~10 token 量级输出）。
- 探测面（--version/caps/readMessages）零推理；Phase A 沙箱探针零推理
  （sandbox.invalid 必败配置）。

## 4. App 级 caps 投影翻转（真实 app 进程 × 生产 providerRegistry 接线）

临时实例 = **本 worktree dev 运行**（`npm run dev` + DEVHUB_HOME 隔离；注意：打包旧件
不含本批 wiring，其投影恒 observed——已识别并换装，见 §6 偏差）。网关驱动
（Bearer + 防重放头；设备行=隔离库种子）。日志：`app-level.log`。

- A1 键=0 → `/v1/agents` kimi(id=3) `capabilities.mode=observed`（默认停用投影）。
- A2 键=1（11:43:39Z，运行期）→ **同刻重验即翻** `mode=managed, granted=["reply"]`，
  evidence 带真实 `kimi --version ok (0.42.0)`（生产实例内真实探测，verifiedAt=1789386219）。
- A3 键=0（11:43:39.870Z）→ managed 投影按能力缓存语义保持至 11:48:22Z，
  **11:48:51Z 回归 `observed, granted=[]`**（verifiedAt=1789386531）——可撤销性 app 级
  证明；传播时滞 = 既有 CAPABILITY_REVERIFY_MIN_SEC=240s 重验节流 + 60s 探测节流
  （docs/12 §5 能力 TTL ≤300s 同款语义，zcode 先例同面，非本批引入）。

（逐时点原始 JSON 见 `app-level.log`；批前旧件误用的 observed 行已剔除，仅存本批
dev 实例观测。）

### 网关 reply 通道边界（如实）

`POST /v1/sessions/{id}/reply` 对 kimi 会话（monitor 发现型，`session_mode=observed`）
被既有门 `resolveCommandGate` 以 `COMMAND_NOT_EXECUTABLE (session is observed)` 拒绝——
这是 docs/12 §5 既有会话级语义（仅 DevHub 发起的 managed 行放行），**本批不改**
（改它=越界扩大任务范围）。provider 层 sendReply 真实通道已由 §3 全链证明；
「kimi 发现型会话的 session_mode 提升」留主控决策（产品语义层，非本批缺口）。

## 5. 窗口收尾（拉回常驻 + health ×3）

- 窗口内实例收尾：`taskkill /F /IM electron.exe`（dev 实例，PID 13528）；DevHub.exe 已不在。
- 无参拉回常驻打包件（无 DEVHUB_HOME 覆盖）后 `/v1/health` 连续 3 次：

```
health#1 pid=33704: {"ok":true,"name":"devhub","version":"0.1.0","uptimeSec":12}
health#2 pid=33704: {"ok":true,"name":"devhub","version":"0.1.0","uptimeSec":14}
health#3 pid=33704: {"ok":true,"name":"devhub","version":"0.1.0","uptimeSec":16}
```

同 PID 33704、uptime 单调——常驻单实例恢复（单实例锁窗口纪律闭环）。

## 6. 偏差记录（如实）

1. **app 级验证换装**：首次临时实例用打包旧件（`%TEMP%\3JIUEaeoBDLtOkqhLfHyjUlf8MA\DevHub.exe`，
   无本批代码）→ 投影恒 observed；改用 worktree dev 运行后完成验证。首次观察的
   observed 行不是本批失败——旧件本就没有门；如实入册。
2. **网关 reply 门**：session_mode=observed 的 kimi 会话在 REST reply 被既有门拒绝
   （§4 边界）；本批 E2E 的真实 reply 走 provider 生产 wiring（driver）完成。
3. **smoke 全量基线**：批前未单独跑 full（fast 基线 125/125 已钉）；批后 full 221/221
   （= 基线 219 + km-1 + km-2，append-only 推算）。
4. 隔离库种子（gateway_enabled/gateway_port/探针设备行）为 E2E 驱动面，非产品改动；
   设备 token 为一次性自铸件（sha256 入库，明文不留存、不入册）。
