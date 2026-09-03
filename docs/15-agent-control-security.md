# DevHub Agent Control 安全设计（docs/15）

> Phase 2/3 Agent Control / Mobile 设计，约束基线同 docs/00；migration/历史文档零改动。
> 本文是 AC 域的安全权威：威胁模型 / 配对 / 设备凭据 / 传输 / 授权矩阵 / 审计 /
> 数据红线 / MCP 隔离 / NatPierce 边界 / Mimosa 钩子适配。
> 参数（TTL/限流/窗口）与端点语义的 API 权威在 docs/14 Part B，两文一致。

---

## 1. 威胁模型简表

| # | 威胁 | 面 | 防御 |
| --- | --- | --- | --- |
| W1 | 本机其他进程探测/调用 Gateway | 127.0.0.1 监听 | 远程面默认关闭（`gateway_enabled=0` 零监听）；本机进程本已拥有与 DevHub 同级的本机权限面，Gateway 不放大它；仅本机端点加回环校验（`GATEWAY_LOCAL_ONLY`） |
| W2 | 经 NatPierce 隧道的公网入口 | 隧道端口 | 不替代鉴权（§8）：全端点 Bearer 设备 Token + 防重放 + 限流；不开路由器端口 |
| W3 | 配对码爆破 | `/v1/pairing/claim` | 码空间 32^8 ≈ 1.1×10^12 + TTL 300s + 一次性 + 限流 5 次/5min + 失败 5 次码作废（§2） |
| W4 | 设备 Token 被盗 | 任意 REST/WS | Token 只存 SHA-256（库泄漏不可逆推）；撤销即拒 + 活跃 WS 立断；Keystore 存储（§3） |
| W5 | 重放攻击 | 全部受保护端点 | 时间戳 ±300s + nonce LRU 10min（docs/14 §B.4） |
| W6 | 消息/通知/日志泄漏凭据 | 事件、消息、审计、日志 | 脱敏红线（§6）：尾 4 位 + 长度；DB 只存脱敏投影，完整内容按需从源读取 |
| W7 | 第三方 Agent 数据源投毒（伪造会话文件诱导 DevHub 行为） | providers 数据源 | 只读解析 + 逐行 try-parse 容错；解析产物仅生成**观察类事件**，绝不从数据源内容派生任何本机执行（执行只来自显式用户动作） |
| W8 | 撤销设备继续操作 | REST/WS | 内存 + DB 双查；撤销后首个请求 401 `DEVICE_REVOKED`，已建立 WS 服务端立即关闭（§4） |
| W9 | 指令重放/重复执行 | `/v1/sessions/*/reply|actions` | idempotency_key UNIQUE + expires_at（docs/14 §B.5） |

## 2. 配对安全

- **一次性短时效码**：8 字符 Crockford Base32（去除易混淆 I/L/O/U，32 符号表），码空间
  32^8 ≈ 1.1×10^12；TTL 300 秒；**即用即废**（claim 成功、过期、作废后均不可再用）；
  桌面同时至多 1 个活跃码，新码签发即废旧码。
- **防爆破**：claim 端点同源限流 5 次/5 分钟（429 `AUTH_RATE_LIMITED`）；
  单码连续失败 5 次 → 码作废（须重新签发）；全部尝试写 `security_audit_logs`。
- 码明文只在签发瞬间（IPC `agents:pairingCreate` 返回）与 claim 请求中出现：
  **不入日志、不入审计 detail、不入 DB**。

## 3. 设备身份与凭据

- Token：256-bit CSPRNG（`node:crypto.randomBytes`），base64url 编码下发；
  `remote_devices.token_hash` 只存 SHA-256——**明文 Token 绝不落库、绝不落日志**
  （红线，§6）。
- Android 存储：Android Keystore 加密保护 Token（裁决 6 技术栈锁定）；Keystore
  不可用时显式报错，绝不降级明文存储。
- **Token 轮换**：v1 实际路径 = 「撤销 + 重新配对」即完成凭据更换（设备行不复用，
  新设备行新 Token）；WS 协议预留 `{ type:'token_rotation', newToken, tokenVersion }`
  服务端推送帧（客户端持久化新 Token 后回 ack、旧 Token 失效），v1 不暴露触发 UI
  （backlog，docs/14 §B.2）。
- **撤销即拒**：桌面 `agents:deviceRevoke`（CONFIRM_REQUIRED 两段式）/ 设备自撤销
  `DELETE /v1/devices/{id}`；撤销后 status=revoked（不可复活）、Token 立即失效、
  活跃 WS 服务端立即关闭、审计落库（`device_revoked`）。

## 4. 传输

- **本地 127.0.0.1 明文边界**：Gateway 默认监听回环、HTTP 明文。理由：回环流量
  不出主机，本机攻击者已拥有与 DevHub 同级的权限面（W1），TLS 在此不提供增量安全；
  该边界显式声明为设计决策而非疏漏。
- **NatPierce 隧道端到端 TLS 语义**：穿越公网的加密由隧道层承担（NatPierce 自带
  TLS 隧道时为端到端加密，DevHub 侧不做 TLS 终结）；若用户使用无 TLS 的裸隧道，
  UI 显式警告「隧道层未加密，凭据与会话内容可被隧道运营方观测」，责任边界写明。
- **防重放**：受保护请求必须携带 `X-DevHub-Timestamp`（±300s 窗口）与
  `X-DevHub-Nonce`（128-bit 随机，LRU 缓存 10 分钟）；重放 → 401 `AUTH_REPLAYED` +
  审计（`replay_rejected`）。豁免面与限流参数表见 docs/14 §B.4。

## 5. 授权矩阵（设备 × 动作，强制）

能力前提统一引用 docs/12 §5 能力验证门（`granted[]` 只含此刻真实验证存在的能力，
服务端在执行前二次校验，UI 不显示按钮只是第一道门）。

| 动作 | managed 会话 | attached 会话 | observed 会话 |
| --- | --- | --- | --- |
| reply | ✔（reply ∈ granted） | ✔（reply ∈ granted） | ✘ `COMMAND_NOT_EXECUTABLE` |
| pause | ✔（pause ∈ granted） | ✘ | ✘ |
| resume | ✔（resume ∈ granted） | ✘ | ✘ |
| 读会话/消息/事件（脱敏投影） | ✔ | ✔ | ✔ |
| 撤销**自身**设备 | ✔ | ✔ | ✔ |
| 撤销**其他**设备 | ✘ `DEVICE_FORBIDDEN`（仅桌面 IPC） | 同左 | 同左 |

ZCode 首版全部 observed（裁决 4）→ 对 ZCode 会话的 reply/pause/resume 全禁。
**六类禁止动作清单**（Gateway 侧不存在对应实现，请求一律拒绝）：

1. 任意远程命令执行（shell / exec / 任意进程启动——远程面只有 reply/pause/resume 三种会话动作）；
2. 文件读写 / 上传下载 / 目录列举；
3. 修改 Agent 或 DevHub 配置（含 ApiHub 切换、settings 写入、hooks 写入——hooks 只能桌面操作）；
4. 删除 / 终止会话或 provider；
5. 触碰 MCP 通道（MCP 与远程面无任何共享代码路径，§7）；
6. 撤销其他设备 / 管理他人 Token / 创建配对码（配对签发仅桌面 IPC，隧道侧 `pairing/create` 仅限回环诊断用，docs/14 §B.1）。

## 6. 数据红线（约束 #13 的 AC 具体化，全通道一致）

- **不落**：任何密钥 / Token / Cookie / 完整认证头 / 密码 / 环境变量值 / 认证缓存
  ——日志（logger）、通知、IPC payload、REST 响应、SQLite（含 agent_messages /
  agent_events / security_audit_logs）、错误消息，一律不含。
- **脱敏投影**：redact.ts 统一实现——匹配到疑似凭据（长随机串 / `api_key` /
  `token` / `authorization` 键值等模式）→ 尾 4 位 + 长度（`sk-…abcd (len 51)`）；
  通知摘要 ≤120 字符且只含 provider 名 + 会话标题 + 脱敏摘要。
- **完整上下文按需加载**：agent_messages 只存 `content_redacted`；完整内容经
  `source_ref` 指向 provider 原始数据按需读取（读取走桌面 IPC 鉴权面，远程侧
  永远只有脱敏投影——REST `messages` 返回的也是 contentRedacted）。
- **不上传**：API Key / Cookie / 密码 / 环境变量 / 认证缓存不出本机——远程端点
  无任何配置读取能力（§5 禁止动作 2/3）。
- **Kimi 红线**：`~/.kimi-code/config.toml` 明文 api_key 的任何投影只有
  尾 4 位 + 长度（apihub `apiKeyTail`/`apiKeyLen` 同款），smoke 用假 key 断言
  任何投影 JSON 序列化后不含全值（docs/11 T10）。

## 7. MCP 隔离声明

- MCP 本期**零改动**：`scripts/run-mcp.mjs` 既有 12 tools / 6 resources / 4 prompts
  不变；docs/09 §10 计划的 4 个只读 tool（devhub.skills.list 等）属遗留待办，
  **不在 AC 范围**（母智能体裁决 3）。
- 远程控制能力（Gateway / 配对 / 设备 / reply/pause/resume）**绝不注册为 MCP tool**，
  绝不与 MCP 共享传输、鉴权或代码路径；AC 事件与投影不新增任何 MCP 暴露面。

## 8. NatPierce 边界

- **只传输不替代鉴权**：NatPierce 是用户自备的 TCP 透传隧道；DevHub 不假设隧道
  可信——全端点鉴权、防重放、限流与直连完全一致，隧道存在与否不改变任何安全决策。
- **凭据外置**：NatPierce 的账号/Token 等凭据只来自环境变量或密钥服务 / 用户外置
  配置文件；**不入仓库、不入 settings 表、不入 DevHub 日志**（DevHub 甚至不读取
  其内容，仅提示用户自行配置隧道指向 `gateway_port`）。
- DevHub 不启动、不安装、不修改 NatPierce；仅展示隧道连通性提示（docs/11 §8）。

## 9. Mimosa 钩子约束适配

项目安全规约：出站仅 http/https + host 校验拒绝环回 / 私有 / 保留地址。AC 域的
例外与理由（逐项记录，实现批次按此对齐，不静默绕过）：

| 场景 | 约束适配 | 理由 |
| --- | --- | --- |
| Gateway 监听 127.0.0.1 | **入站绑定**，非出站连接，不在出站 host 校验射程内 | 远程面本设计即要求回环监听（裁决 2） |
| Codex app-server / Kimi 托管 | spawnManaged **stdio 管道**通信，非网络出站 | 长驻子进程契约（docs/12 §3），无网络面 |
| Claude hooks 回调 | 独立内部回环 listener（仅绑定 127.0.0.1，入站），hook 命令内嵌签发时生成的本地随机 secret（防本机其他进程伪造回调） | 本机回环入站，等价 W1 边界；与 gateway_enabled 解耦（docs/12 §8.2） |
| NatPierce 出站连接 | **例外放行**：出站 host 来自用户外置配置（用户显式行为的延伸），且该连接由 NatPierce 自身进程发起——DevHub 进程内无任何对 NatPierce 服务端的出站调用 | DevHub 自身代码零出站违例；隧道是用户工具，DevHub 只提示配置 |
| Android 访问 10.0.2.2 | 模拟器回环别名，属 Android 工程内网络配置 | 非本机 DevHub 出站 |
| AC 域其余代码 | 无任何新出站网络调用（不引入新域名白名单） | 监控/解析/落库全部本地 |

## 10. 审计日志（security_audit_logs，docs/13 §4.8）

- **记录**：pairing（签发/claim 成功/过期/作废/限流）、auth（失败/重放拒绝/限流）、
  command（accepted/rejected/executed/error）、device（paired/revoked）、
  gateway（started/stopped）；outcome（success/denied/error）+ 非敏感 detail
  （来源回环/隧道、限流计数、commandId 等）。
- **绝不记录**：Token 明文/哈希、配对码明文、消息全文、任何凭据值、用户会话内容
  （审计 detail 的 sessionId/commandId 等标识符除外）。
- 审计写入与业务写入同事务面（L3 单事务内完成，失败不阻断业务但显式记日志）。
