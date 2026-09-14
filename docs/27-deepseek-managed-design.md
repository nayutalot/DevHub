# 27 — deepseekManaged 设计提案：DeepSeek Harness 控制面直连（DSH-SCOUT 批产出）

> 批次：DSH-SCOUT（侦察批，零启动零编码）。任务书：docs/briefs/dsh-scout.md。
> 用户目标（原话）：「app端与deepseek harness的直连是重点，深挖deepseekharness的系统文件，再上github上找，无论通过什么方式，都必须实现类似zcode的远程控制」。
> 证据基线：本地安装 D:\Apps\deepseek-harness（@deepseek-ai/dsh 0.1.0-rc.5，全源码在位）+ 上游 GitHub/npm 检索（§3）。所有 文件:行号 均相对 D:\Apps\deepseek-harness\（下称 HROOT），DevHub 侧相对仓库根。本批未运行任何 dsh 进程；凭据三零已守（仅确认键名）。

---

## 1. 控制面协议地图（每条带 文件:行号）

### 1.1 候选 A：`packages/acp/acp`（@deepseek-ai/dsh-acp 0.1.0-rc.5）

**形态**：不是独立 bin，是 Cordis 插件。`apply(ctx, config)` 在 `ctx.agents` 上开一个 `AgentSideConnection`，stdin/stdout 就是协议线（HROOT/packages/acp/acp/src/index.ts:105-112、349-353）。inject=['agents']（index.ts:44）。

**传输帧格式**：标准 ACP = JSON-RPC over ndjson stdio。`ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))`（index.ts:349-352）。依赖 `@agentclientprotocol/sdk` 0.25.1（HROOT/packages/acp/acp/package.json:35）——即 Zed 官方 ACP SDK。stdout 保留给协议帧，诊断只走 stderr（HROOT/packages/examples/acp-demo/README.md:45）。

**JSON-RPC 方法全集**（agent 侧应答）：

| 方法 | 行为 | 证据 |
|---|---|---|
| `initialize` | 单版本 agent：返回 PROTOCOL_VERSION、agentInfo `deepseek-harness-acp/0.0.1`、promptCapabilities 全 false（image/audio/embeddedContext）、authMethods=[] | index.ts:234-245 |
| `authenticate` | no-op（无鉴权方法通告） | index.ts:247-249 |
| `session/new` | 新建 agent；cwd 必须绝对路径；`additionalDirectories`/`mcpServers` 非空即拒 | index.ts:251-275、430-436 |
| `session/prompt` | 文本块串接为一条 user 消息；resource_link 拍平为 `[resource_link name=… uri=…]` 文本；**每会话同时只允许 1 个在途 prompt**；等待整个 agent idle 才返回 | index.ts:277-336（在途互斥 :280-282，内容校验 :283-287，idle 等待 :322-333） |
| `session/cancel` | 取消指定会话，在途 prompt 结算为 `cancelled`；未知 id no-op | index.ts:338-344 |
| `session/update`（通知，agent→client） | **唯一更新变体 `agent_message_chunk`**：只对已提交（committed）`assistant/message` 的非空 text 块逐块发一条；raw delta、reasoning、tool、plan、title、usage 一概不上线 | index.ts:155-196（:152-154 注释明言）、README.md:29,34,80 |
| `session/request_permission`（请求，agent→client） | 桥持有的 approval 请求转一次性 allow-once/reject-once 两选项问答；绝不从应答推断持久授权 | index.ts:215-229 |

**stopReason 映射**（codec.ts:14-34）：completed→end_turn；max-tokens→max_tokens（但 prompt 级结算时归一为 end_turn，index.ts:331）；aborted→end_turn；interrupted→cancelled；blocked/error→end_turn。

**生命周期**：连接拥有全部会话——client 断开→quiesce：拒新会话/prompt→取消并结算全部在途→drain continuable 子代→并行 dispose（index.ts:355-414）。无 per-session close。

**落盘关系**：ACP 自身不落盘；会话日志由组合里的 persistence 插件决定。官方示例组合 persistenceRoot 默认 `./.sessions`（HROOT/examples/acp-agent/cordis.yml:56）。

**与 Zed ACP 公开规范对照**：规范源 https://agentclientprotocol.com（v1/v2 双版本；JSON-RPC、initialize 版本协商、session/new、prompt turn、session/request_permission——见 §3 检索）。本地 0.1.0-rc.5 差异清单：
1. 不支持 `session/load`（v1）/`session/resume`（v2）——README 明言 fresh sessions only（README.md:78）；
2. 不通告任何 agentCapabilities 除 baseline promptCapabilities（无 fs/terminal/mcp/session 能力，README.md:24）；
3. `session/update` 只发一种变体（agent_message_chunk），远少于规范定义的 tool_call/tool_call_update/plan/thought 等变体族；
4. permission 只有一次 allow-once/reject-once 两选项（规范的 option kind 集合子集）。
5. **上游已演进**：master 分支的桥已支持 session/list、session/resume、session/close、session/setConfigOption，并通告 `mcpCapabilities:{http:true}`、`sessionCapabilities:{close,list,resume}`、动态 image prompt 能力（§3 检索证据）。即本地 0.1.0-rc.5 是能力面更窄的旧形态。

**field 证据**：官方仓库 Discussion #4691（多租户平台以 DSH 为推理后端跑 ACP）确认「桥只发 agent_message_chunk，工具调用拿不到」是社区实测痛点（§3）。

### 1.2 候选 B：`packages/sdk/*`（@deepseek-ai/dsh-sdk-{protocol,jsonrpc-server,client} 0.1.0-rc.5）

**形态**：stdio JSON-RPC 子进程 SDK 三件套。server 是插件（`sdk-jsonrpc-server`），client 是进程管理器（`HarnessClient`）。与 acp 不是同一协议：**这是 DSH 自有 wire，比 ACP 富一个量级**。

**B-1 protocol 类型表**（HROOT/packages/sdk/protocol/src/types.ts）：

| 方向 | 方法 | payload | 行号 |
|---|---|---|---|
| client→server 请求 | `initialize` | `{cwd, provider, model, maxTokens?}` → `{serverInfo:{name,version}}`（name 恒 `deepseek-harness-sdk-runtime`） | :16-31、:101-102 |
| client→server 请求 | `session/prompt` | `{sessionId, contentBlocks: ContentBlock[]}` → `{messageId}`（sessionId 未知则惰性建会话） | :34-46、:101-102 |
| client→server 请求 | `shutdown` | 无参 → `{}` | :104 |
| server→client 通知 | `session.event` | `{sessionId, event: SessionEvent}` —— **整个会话日志事件封包原样上线** | :51-56 |
| server→client 通知 | `session.status` | `{sessionId, status:'idle'\|'running'}` | :59-64 |
| server→client 通知 | `subagent.started` | `{parentSessionId, childSessionId}` | :66-72 |
| server→client 通知 | `subagent.finished` | `{provider, agentId, parentSessionId, childSessionId, status:'ok'\|'error', stopReason, lastAssistantMessage?}` | :74-90 |

**B-2 传输帧**（transport.ts）：newline-delimited JSON-RPC 2.0。请求帧 `{jsonrpc:'2.0', id:'req_<uuid去杠>', method, params}`（:121-156）；响应 `{id, result}` / `{id, error:{code,message}}`；通知 `{jsonrpc:'2.0', method, params}`（:158-160）。未知方法→-32601，handler 抛错→-32603（:229、236）；**畸形行静默忽略**（:205-208）；**入站帧不校验 `jsonrpc` 字段**（:201-224 只看 id/method/error/result 键）。stdIO 双流由调用方注入。

**B-3 jsonrpc-server 插件**（HROOT/packages/sdk/server/src/）：
- `apply(ctx, config)` 挂 `JsonRpcLineTransport(process.stdin, process.stdout)`（index.ts:53-62）；`shutdown` 应答写出后 flush→dispose 根 runtime→exit 0（index.ts:66-83）。
- 事件扇出（server.ts）：`ctx.on('session/event')` → **对 runtime 内每个会话的每条日志事件** notify `session.event`（:71-74）；`agent/status`→`session.status`（:75-77）；`session/created`（有 parentSession）→`subagent.started`（:78-86）；`subagent/end`（仅 local）→`subagent.finished`（:87-103）。
- `initialize`：provider 无适配器时若恰为 `deepseek-official` 则自动挂 `@deepseek-ai/dsh-llm-deepseek`，否则报错（:120-123）。
- `session/prompt`：惰性 getOrCreateSession（:203-216、218-235），`createUserMessage` + `agent.followup(message)`，立即返回 `{messageId}`（:132-143）。
- **方法面缺口**：`handleRequest` 只有 initialize/session/prompt/shutdown 三个（:190-201）——**无 session/cancel、无 approval 问答方法**（见 §5 红线下放）。

**B-4 client API 面**（HROOT/packages/sdk/client/src/）：
- 低层 `HarnessClient`（client.ts:184-261）：`start()` spawn（options: command/args/cwd/env，stdio 全 pipe，stderr 留 400 行尾巴 :27-28、:206-210）；`initialize()`/`prompt(sessionId, contentBlocks)`（:268-275、:283-290）；`request(method, params, timeoutMs)` 带放弃式超时（:301-333）；`subscribe(filter)`/`subscribeSessionTree(sessionId)`（从 subagent.started 血缘做客户端侧会话树过滤 :361-372、:408-430）；`close()` = shutdown 请求→stdin EOF→SIGTERM→SIGKILL 阶梯（:380-401，dispose.ts）。**无 wire 级 cancel**（:179-183 注释自述）。
- 高层 `DeepSeekHarness`/`HarnessSession`（api.ts:22-195）：默认 `provider:'deepseek-official'`、`model:'deepseek-v4-flash'`（:40-41）；`session(id?)` 零流量句柄；`run()` 依次：subscribeSessionTree → prompt → 等第一条 `agent/inbox/spliced` 事件包含自己的 messageId（durable 回执）→ 持续收 `session.event` → 直到 `session.status:'idle'` → 返回 `{events, notifications, finalResponse}`（:146-195）。**这就是 DevHub 要抄的消费循环**。

**与 acp 的关系**：不同协议、不同目标。acp=对外互操作（Zed 生态），SDK=程序化驱动（Python/JS SDK 共用同一 runtime 协议——client.ts:8-9 自述与 python/sdk 的 `HarnessClient` 是 design twin）。

### 1.3 可运行形态（spawn 什么）

| 载体 | argv | 证据 | 状态 |
|---|---|---|---|
| 源码 tsx（仓内） | `node --import tsx HROOT/packages/examples/acp-demo/src/bin.ts --config <cordis.yml>` | 根 package.json:139 `demo:acp` 同款；bin.ts:24-29 parseArgs `-c/--config`（默认 ./cordis.yml），stdin EOF→dispose+exit | checkout 有 node_modules；需 Node≥22.19+tsx |
| 已构建 generic bin | `node HROOT/packages/examples/jsonrpc-demo/lib/bin.js <cordis.yml>`（bin 名 dsh-jsonrpc-agent） | jsonrpc-demo/package.json:16-17；runner.ts:20-54：argv[2] 或 `$DSH_CORDIS_CONFIG`（env 优先）；stdin EOF/SIGTERM/SIGINT dispose | lib/bin.js 已在 checkout 构建（ls 实证） |
| 打包单文件 exe | `dsh-jsonrpc-agent-pkg-<platform>-<arch>` | python/sdk-runtime/src/deepseek_harness_runtime/__init__.py:6-10 | **只有 linux/macos**（:34 平台表无 win32）——本机不可用 |
| node 闭包（dev-only） | `node <pkg>/runtime/node/node_modules/@deepseek-ai/dsh-sdk-jsonrpc-demo/lib/packaged-bin.js`，Node≥22.19 | __init__.py:131-154 | 需跑 scripts/build-exe-for-python-sdk.ts 生成，checkout 未含 |
| 已构建 acp bin | `node HROOT/packages/examples/acp-demo/lib/bin.js --config <cordis.yml>` | acp-demo lib/bin.js 已构建（ls 实证） | 同 tsx 形态等价，免 tsx 依赖 |

**配置加载纪律**：runtime 必须显式 config，无内置回退（runner.ts:31-36 usage 自述）；`$DSH_CORDIS_CONFIG` env 优先于 argv（:24-29）。bin 的 stdout 全 reserved for 协议，树里不得挂 stdout logger（sdk/server/src/index.ts:4、acp-demo README:45）。

### 1.4 `apps/cli`（bin `dsh`）

- modes 三种：`profile`（默认）/`plugin`（pnpm 转发）/`dump-config`（apps/cli/src/bin.ts:29-53、args.ts:21-48）。launcher flags：`--profile <name>`、`--patch <path>`（可重复）、`--dump-config`、`--dump-default-config`（args.ts:131-134）；`web` 是 `--profile web` 硬别名（args.ts:156）。
- **没有 acp/server/jsonrpc 启动模式 flag**。常驻控制面的正路是 profile=插件栈（`$DSH_HOME/profiles/<name>` 存 cordis patch 层，boot/app-boot/src/profile.ts:5）或直接 spawn example bin（§1.3）。
- 一次性：`dsh --profile headless "task"`（args.ts:66-67 help 示例）——直连 core 入口，**不挂 apiproxy**（HROOT/packages/host/apiproxy/README.md 末节自述）。与常驻 server 无进程级关系：一个是 profile 组合差异，不是同一 bin 的 flag。
- 凭据/模型加载：product profile 组合挂 `@deepseek-ai/dsh-settings-file`（`$DSH_HOME/settings.yaml`，热重载）与 `@deepseek-ai/dsh-credentials-local`（`$DSH_HOME/.credentials.yaml`，env→managed 文档→.env 阶梯）（HROOT/packages/bundle/base/cordis.patch.yml:74-90；credentials-local/src/index.ts:52 `CREDENTIALS_FILENAME='.credentials.yaml'`）。`$DSH_HOME` env 覆盖默认 `~/.dsh`（home-paths/src/index.ts:12-19）。
- 本机实证（只验存在性与键名，值未读）：`~/.dsh/.credentials.yaml` 顶层键 = `MICU_API_KEY`、`DEEPSEEK_API_KEY`；`~/.dsh/settings.yaml` 顶层节 = `ui-onboarding`/`llm-pi-ai`/`agent-presets`/`ui-conversation`/`agent-default-model`；`~/.dsh/sessions/`、`profiles/`、`storages/` 在位。

### 1.5 候选 C：`packages/host/*`（webserver + apiproxy）备选通道

- `@deepseek-ai/dsh-host-webserver`：node:http 插件，register HTTP/upgrade 路由；bind 只允许 127.0.0.1 或 0.0.0.0；**无 TLS、无鉴权、无 origin 策略**（webserver/README.md）。
- `@deepseek-ai/dsh-host-apiproxy`：Web GUI 的完整 API 面——四象限 wire（POST `/api/<method>` 请求、响应、SSE 下行帧、POST `/api/respond` 应答），方法含 session.create/prompt/cancel/history/models/selectModel/updateQueue/search/fork、workspace.*、settings.*、credentials.*、llm.*（apiproxy/README.md）。
- 评估：方法面最全（唯一原生带 session.cancel 与队列编辑的通道），但要求整套 web profile（浏览器 GUI 全栈组合），鉴权姿态是本机浏览器 loopback same-origin；SSE 单向下行 + POST 上行的有状态会话语义与 DevHub 的「每会话一个子进程 stdio」模型正交；且 pending-interaction 表只处理 questions、无 approval 条目（apiproxy/README.md 已知限制节）。**作为 managed 直连通道过重且引入 HTTP 暴露面**——列为备选不推荐（§4）。

### 1.6 44 型事件词表 × 控制面流出 × zcodeProtocol 对照

词表权威：`KNOWN_SESSION_EVENT_TYPES` 44 项（HROOT/packages/core/session/src/known-event-types.ts:19-64，生成物）。事件封包：`{type, seq(会话内单调), time(epoch ms), data, ignorable?, sourceEventSeqs?, surfaceOp?}`（types.ts:404-440）。

经控制面的流出情况：

| DSH 事件 | ACP 线上形态 | SDK `session.event` | zcode 对应 payload.type |
|---|---|---|---|
| assistant/message | `agent_message_chunk`（逐 text 块，committed only） | 原样（含 content[]、usage） | message.upserted / part.upserted |
| assistant/chunk（流式 delta，StreamChunk） | **不上线** | 原样（delta 在 turn/step 维度） | part.delta / model.streaming |
| tool/call（callId,name,arguments） | **不上线** | 原样 | tool.updated |
| tool/result | **不上线** | 原样 | tool.updated |
| approval/asked / approval/decided | 折变为出站 `session/request_permission` 请求（非事件流） | **原样事件，但无应答方法** | permission.requested / permission.resolved |
| turn/start、turn/end（reason） | turn/end 折变为 prompt 的 stopReason | 原样 | turn.started / turn.completed(turn.failed) |
| user/message | 不上线 | 原样 | message.upserted(user) |
| agent/inbox/spliced | 不上线 | 原样（SDK client 用它做 prompt 回执判据，api.ts:225-229） | turn.steerQueued 语义近邻 |
| step/start、step/end、request/header、todo/write、compaction/*、llm/retry*、session/title、subagent/descriptor、command/*、hook/*、plan/mode、sandbox/mode、goal/change、schedule/change… | 全部不上线 | **44/44 全量 firehose**（server.ts:71-74 直通 ctx.on('session/event')） | state.updated / checkpoint.created 等部分对应 |
| agent/status（非日志事件） | 无 | `session.status` 通知 | state.updated |

**与 DevHub zcodeProtocol ndjson 的逐字段对照**（基准 src/main/services/agentControl/providers/zcodeProtocol.ts）：

| 维度 | zcode appserver | DSH SDK runtime | 帧级兼容结论 |
|---|---|---|---|
| 帧基座 | ndjson over stdio，**无 `jsonrpc` 字段**（zcodeProtocol.ts:5-11、57-78） | ndjson JSON-RPC 2.0（transport.ts:121-160） | DevHub `parseZcodeFrame`（:85-123）按 id/method/result/error 键判定、不要求 jsonrpc 字段 → **DSH 入站帧可被现有解析器零改动解析**；DevHub 出站请求需补 `jsonrpc:'2.0'`（SDK transport 入站同样不校验该字段，transport.ts:201-224，故不改也不炸，但应改以合规范） |
| id | string\|int（服务端反向 "server-1"） | string（`req_<uuid>`） | 同为 string\|int 域，isZcodeFrameId 直接覆盖 |
| 握手 | 无 initialize | `initialize` 请求（cwd/provider/model） | 新增一步，纯增不改 |
| 事件通知 | `session/event` params `{sessionId, seq, eventId, turnId, deliveryKind, payload{type,resultType,…}}` | `session.event` params `{sessionId, event:{type, seq, time, data}}` | `extractSessionEvent`（:251-271）读 params.sessionId+payload.type → DSH 侧薄适配：`event` 字段顶替 `payload` 槽，seq 取 `event.seq`。**结构同构，改动点收敛在一个适配函数** |
| 状态判定 | turn.started/completed/failed + permission.requested 等映射 9 值状态（evalZcodeEventStatus :290-320） | turn/start→running；turn/end reason{completed,max-tokens,aborted,interrupted,blocked,error}→waiting_input/paused/failed；session.status idle→waiting_input | 判定表可直接平移（reason 词表见 codec.ts:14-34） |
| turn 收尾沿 | isTurnTerminalEvent（:326-328） | `session.status:'idle'` 或 turn/end 事件 | SDK 多给一个权威 idle 信号（更好） |
| 反向请求 | 服务端→客户端请求必须应答（:127-182） | **SDK 协议无服务端反向请求**（4 通知全是 notification）；approval 问答在 ACP 侧才有 | DevHub 的 respondToServerRequest 机制对 DSH SDK 是冗余防御（保留不碍事） |
| 流式粒度 | part.delta 逐 token | assistant/chunk 逐 delta（全量事件直通） | 对齐甚至更全 |
| 取消 | session/stop | **无 cancel 方法** | 缺口：只能 kill 子进程（close 阶梯）——见 §5/§6 |

---

## 2. 网上检索（来源 URL + 与本地 0.1.0-rc.5 差异）

1. **npm `@deepseek-ai/dsh`** — https://www.npmjs.com/package/@deepseek-ai/dsh 及 registry.npmjs.org 元数据：dist-tag latest=0.1.5-rc.1、next=0.1.5-rc.2、alpha=0.1.5-alpha.2；版本线 0.0.1-rc.x → 0.1.0-rc.2/3/6/7/8 → 0.1.1-rc.x → 0.1.2-rc.1 → 0.1.3-alpha.x → 0.1.5-rc.x。**本地 0.1.0-rc.5 落后约 5 条 minor 线**（且 0.1.0-rc.5 未在 registry 版本列表可见段中，rc.6/7/8 在其后）。
2. **GitHub 主仓** — https://github.com/deepseek-ai/deepseek-harness（master apps/cli/package.json version=0.1.5-rc.2，raw 实证）。
3. **SDK 协议稳定性** — master 的 packages/sdk/protocol/src/types.ts 与本地逐方法一致：3 请求 + 4 通知同名同位，仅新增 `SdkEncodedImageBlock`（prompt contentBlocks 的内联 image 编码，png/jpeg/webp/gif）——**SDK wire 自 rc.5 以来未破坏性变更**，本设计对版本漂移有韧性。
4. **ACP 桥上游演进** — master packages/acp/acp/src/index.ts（raw 实证）：新增 session/list、session/resume、session/close、session/setConfigOption；通告 mcpCapabilities.http、sessionCapabilities{close,list,resume}、动态 image prompt 能力；实现拆分出 session.ts。**即 ACP 路线在旧版本上是残废、在新版本上才够用**。
5. **ACP 规范** — https://agentclientprotocol.com（[overview](https://agentclientprotocol.com/protocol/v1/overview)、[initialization](https://agentclientprotocol.com/protocol/v1/initialization)、[schema](https://agentclientprotocol.com/protocol/v1/schema)；v1→v2 将 session/load 改名 session/resume）。DSH 本地桥是规范的窄子集（差异清单 §1.1）。
6. **第三方集成实证** — 官方仓库 Discussion #4691「ACP: the bridge emits only agent_message_chunk — tool calls and …」：多租户 agent 平台把 DSH 当推理后端跑 ACP，实测拿不到工具调用事件，只能重建最终文本。与本地源码判读完全一致。
7. **官方门户/生态** — https://www.deepseek.com/harness/en/（developer preview，源码同发）；Python SDK README（pip install deepseek-harness-sdk，装同版本 runtime bundle，newline-delimited JSON-RPC over stdio——与 JS client 互为 design twin）；InfoQ 2026-08 报道开源；DataCamp/腾讯云等安装教程（npm i -g @deepseek-ai/dsh）。第三方社区：HenryZ838978/deepseek-harness fork（诊断向）、deepseek-harness-cli 0.4.0 PyPI（诊断/校验向，非控制面）。
8. **检索无果项**（如实记录）：未发现任何第三方「移动端远程控制 DSH」的现成实现；未发现 @agentclientprotocol/sdk 0.25.1 与本地用法不兼容的报告；未发现 DSH win32 单文件 runtime exe 的分发渠道（上游只产 linux/macos）。

**结论**：本地源码是主证据源；上游确认 SDK 协议稳、ACP 桥在升级、生态里无人已做 DevHub 要做的事（zcode 式远程控制）——自研对接是蓝海且可行。

---

## 3. 选型建议：acp vs sdk vs host API

| 维度 | A：acp（dsh-acp-demo） | **B：sdk jsonrpc（推荐）** | C：host webserver+apiproxy |
|---|---|---|---|
| 传输/进程模型 | ndjson stdio 子进程（标准 ACP） | ndjson JSON-RPC stdio 子进程 | HTTP+SSE 本机服务（暴露面） |
| 事件覆盖 | 1 种更新变体（committed 文本）；无 tool/reasoning/delta | **44/44 全量 + session.status + 子代理血缘** | 方法面全但事件粒度面向 GUI |
| 流式 | 无（整回合committed才发） | assistant/chunk 逐 delta | SSE 下行（GUI 语义） |
| 会话生命周期 | create/prompt/cancel；无 resume（本地版） | create/prompt/shutdown；**无 cancel**；无 resume | create/prompt/**cancel**/queue/fork 全 |
| approval | 出站 request_permission 问答（allow/reject once） | 无方法（approval/asked 只是事件） | questions 有；approval 条目缺 |
| 与 zcodeProtocol 同构度 | 低（语义被拍平） | **高（firehose+status+血缘，同构度接近 1:1）** | 中（HTTP 形态不同） |
| 维护面 | 依赖 @agentclientprotocol/sdk 版本演进；上游桥变动大 | 自有 wire，rc.5→master 零破坏；client 侧代码 DevHub 自持 | 依赖整个 web profile 组合稳定性 |
| Windows 可运行 | dsh-acp-demo lib/bin.js 已构建可 spawn | dsh-jsonrpc-agent lib/bin.js 已构建可 spawn | 同左（web profile） |
| 风险 | 上游 #4691 证明能力不足是结构性的 | 无 cancel 是唯一硬缺口（§5 缓解） | 暴露面+重量+GUI 耦合 |

**推荐：B（SDK jsonrpc 直连）**。理由：(1) 用户目标「类似 zcode 的远程控制」的核心是**全事件流式可见**，只有 SDK 给 44 型 firehose + 流式 delta；(2) 与既有 zcodeProtocol 管道（parse→extract→eval→recordEvent→segments）近乎同构，DevHub 侧增量是一个适配层而非新管道；(3) 上游把 SDK 当对外契约维护（Python/JS 双 client），稳定性承诺最强；(4) ACP 在本地版本上连 zcode 的下限（tool 事件可见）都够不着。ACP 保留为未来互操作选项（若上游 0.1.5+ 装机后想接 Zed 生态再评估）。host 通道不用于 managed。

---

## 4. deepseekManaged 设计草案

### 4.1 授权门（settings 键）

对齐 `kimi_managed_enabled` 先例（src/main/services/agentControl/providers/kimiManagedConfig.ts:34、98-115）：

- 键 `deepseek_managed_enabled`，值恰为 `'1'` 才授权真机 managed（'true'/'yes' 一律视为停用，绝不宽松解析）；缺行/非 '1' = observed-only，provider 行为与现状逐字节一致。每调用读取，运行期翻转即时生效。
- 理由面与 kimi 完全同构：真实推理消耗 + `~/.dsh` 写入必然发生，默认停用、显式授权、键回 0 即撤销。
- 可选第二键 `deepseek_managed_model`（形如 `deepseek-official/deepseek-v4-flash`，initialize 的 provider/model 路由；缺省用 runtime 默认 deepseek-official/deepseek-v4-flash，api.ts:40-41）。**凭据零接线**：harness 自己经 credential seam 解析 `DEEPSEEK_API_KEY`（python runtime bundled cordis.yml:16-19 环境阶梯自述）——DevHub 不读不写不注入任何 key（红线；本机 `~/.dsh/.credentials.yaml` 已有 DEEPSEEK_API_KEY 键名实证）。

### 4.2 spawn 形态与 HOME/env 纪律

```
command: process.execPath（Electron 主进程内置 Node）
args: [
  <HROOT>/packages/examples/jsonrpc-demo/lib/bin.js,   // 已构建 generic bin（同机 checkout 实证存在）
  <DevHub 写入的 cordis.yml 绝对路径>                    // 或 env DSH_CORDIS_CONFIG=…（env 优先，runner.ts:24-29）
]
env: process.env 透传 + 可选 DSH_HOME（见下）；
stdio: ['pipe','pipe','pipe']；stdout=协议线，stderr=滚动尾巴(≤400 行,client.ts:28)。
```

- **首选同机 checkout 的已构建 bin**（零安装、零 tsx 依赖）；备选 `node --import tsx …/src/bin.ts`（等价、多一层 tsx）。HROOT 用 settings 键（如 `deepseek_harness_root`）或默认 `D:\Apps\deepseek-harness` 探测（存活性探测=文件在位检查，绝不 spawn 探测——kimi doctor 先例）。
- **DSH_HOME 纪律（live/observed 同一性的关键）**：DevHub 写入的 cordis.yml 挂 `session-persistence-jsonl` 且 `root: !!js dshHomePath('sessions')`（base bundle 同款，bundle/base/cordis.patch.yml:98-102；dshHomePath 由 app-boot 提供，boot/app-boot/src/index.ts:770，解析 `$DSH_HOME` env 或 `~/.dsh`）。spawn env **不设 DSH_HOME** → 会话落 `~/.dsh/sessions/` 与 observed 投影同根。若未来要沙箱化，再统一改设 DSH_HOME 到 DevHub 管理目录（同时 observed 扫描面同步改，两处联动）。
- cordis.yml 骨架（DevHub 侧模板，参照 python bundled runtime cordis.yml:1-49 + base bundle）：`sdk-jsonrpc-server` + `agent-core`（@deepseek-ai/dsh-agent-spine-demo）+ `llm-deepseek` + `sessions`（persistence, root=dshHomePath('sessions')）+ `session-checkpoints` + `subprocess`/`bash`（**必须 dsh-bash-sandbox + sandbox-policy workspace-write**，禁 danger-full-access 默认）+ `settings`/`credentials`（settings-file/credentials-local → 复用用户既有 ~/.dsh 凭据与模型选择）+ `token-meter`/`compaction-basic`。**不挂 stdout logger**（stdout 是协议线）。
- bash/文件工具的沙箱模式可用 `DSH_PERMISSION_MODE` env 显式钉住（examples/acp-agent/cordis.yml:27-31 先例：mode 与 approval policy 同源）。

### 4.3 会话生命周期（create→send→stream→end）

DevHub 侧不引入 @deepseek-ai/dsh-sdk-client 依赖（零 npm 依赖原则），按 wire 自实现薄 client（复用 JsonRpcLineTransport 语义 + 既有 parseZcodeFrame）：

1. **spawn + initialize**：子进程起后发 `{jsonrpc:'2.0', id, method:'initialize', params:{cwd:<workspace>, provider, model}}`；期待 `{serverInfo:{name:'deepseek-harness-sdk-runtime',…}}`。失败→kill 阶梯（EOF→SIGTERM→SIGKILL，client.ts:380-401 同款；Windows 降级 taskkill /T）。
2. **create（惰性）**：session/prompt 首发即建会话（server.ts:203-216）；DevHub 侧主动生成 sessionId（`session-<uuid>` 形态自定——wire 只要求 string 键）。无独立 create 方法，**create 与 send 合一**。
3. **send**：`session/prompt {sessionId, contentBlocks:[{type:'text', text}]}` → `{messageId}`（durable 回执 id）。
4. **stream**：订阅通知；以下沿喂既有管道：
   - `session.event`(event.type==='agent/inbox/spliced' 且含 messageId) → 回执确认（api.ts:225-229 判据）→ 置 running；
   - `session.event`(assistant/chunk) → 流式 delta → eventPipeline.recordEvent + messageSegments 增量（对接点与 zcode part.delta 相同，eventPipeline.ts:125-152 recordEvent 签名、messageSegments.ts:78 buildSegments）；
   - `session.event`(assistant/message / tool/call / tool/result / todo/write …) → 同库转录面（与 zcode message.upserted/tool.updated 同位）；tool/call 的 callId/name/arguments 直接映射 segments 的工具卡；
   - `session.event`(approval/asked) → 状态投影 approval_required（对齐 evalZcodeEventStatus :290-320 的 permission.requested→approval_required 位）；v1 客户端侧**无应答通道**（见 4.5）；
   - `session.event`(turn/end) + `session.status` → 终态判定：reason.completed→waiting_input（success）；max-tokens→waiting_input（注明截断）；aborted→paused；interrupted→paused；blocked/error→failed；`session.status:'idle'` 为回合消费收尾沿（isTurnTerminalEvent 对位）。
5. **end/回收**：DevHub 主动停 = 无 wire cancel → 直接走 kill 阶梯（子进程整体回收；会话日志已由 persistence 落盘，无损）。会话级优雅取消是唯一缺口（§6 launch-verify #5）。
6. **shutdown**：DevHub 退出/停用面 → `shutdown` 请求（应答后 runtime 自杀 exit 0，sdk/server/src/index.ts:76-83）→ 超时落 kill 阶梯。

### 4.4 managed 回复链与 observed 投影同一性

- live 会话落盘路径 = `~/.dsh/sessions/<projectKey>/<sessionId>/…`（persistence-jsonl README:10-26 项目目录布局；projectKey 由 cwd 归一化生成）——与 deepseekProvider observed 扫描根完全同构（deepseekProvider.ts:188-189、437-451）。**手机发起的 live 回合结束后，observed 视角自动看到同一会话**（同 root、同布局、同 session id）；managed 会话在注册表标记 providerKey=deepseek 且携带 sessionId，list 合并时以 sessionId 为同一性键去重。
- 注意时序：observed 是文件投影（轮询/重扫），live 期间以 managed 面为准，live 消亡后自然回落 observed（zcode/codex managed↔observed 同款模式，无新机制）。
- subagent 血缘：`subagent.started/finished` 通知提供 parentSessionId/childSessionId——手机端可折叠展示子代理活动（zcode 无此粒度，属增量能力，v1 可只记事件不建 UI）。

### 4.5 红线下放清单（approval/工具调用 gate）

1. **approval 无问答通道（SDK 协议事实）**：`approval/asked` 只是事件。因此 managed 启动的组合必须把 approval policy 钉为**永不挂起询问**的形态：`dsh-user-approval policy:'never'` 会自动拒绝越权操作（examples/acp-agent/cordis.yml:42-45 是 policy ask/never 二态先例；never=不问=拒绝是 harness 语义，launch-verify #6 复核），配合 sandbox workspace-write。手机端 UI 呈现 approval_required 状态如实（来自事件），但 v1 不承诺远程批准。
2. **若产品要远程批准**：两条后路——(a) 升级 harness 后评估 ACP 桥的 request_permission（allow-once/reject-once）；(b) cordis.yml 挂 web 宿主 question 面不合（过重）。v1 明确不做，键 `deepseek_managed_enabled` 的门语义即「接受自动拒绝策略」。
3. **bash/文件越权**：spawn 组合钉 `sandbox-policy mode:'workspace-write'` + cwd=DevHub 会话工作区；DSH_PERMISSION_MODE env 显式覆盖通道保留给高级用户。
4. **进程面**：managed 子进程纳入 exec.spawnManaged 双超时（idle/lifetime，kimiManagedConfig.ts:66-72 同构；idle 心跳源=任意入站通知，含 llm/retry——kimi 网络退避误杀教训平移）；总生命周期上限防止僵尸 runtime。
5. **stdout 污染**：组合不挂任何 stdout logger（协议线独占，sdk/server/src/index.ts:4）；stderr 尾巴进诊断不进协议。
6. **凭据三零**：DevHub 全程不触 `~/.dsh/.credentials.yaml`（键名确认除外）；DEEPSEEK_API_KEY 由 harness credential seam 自取；spawn env 不注入任何 key（zcodeManagedConfig 的 env 注入教训已退役，T2e 先例）。

### 4.6 DevHub 侧模块落位（实现批施工图，零编码本批）

- `providers/deepseekManagedConfig.ts`：授权门 + HROOT 探测 + cordis.yml 模板渲染 + 结构化 reason（零凭据）。
- `providers/deepseekProtocol.ts`：SDK wire 帧编码（带 jsonrpc:'2.0'）+ `extractDshSessionEvent(method, params)`（`event`→payload 槽适配）+ reason→9 值状态判定表（§4.3-4）。
- `providers/deepseekProvider.ts`：getCapabilities 授权门联动（门开→managed+reply caps；门关→现状 observed+空集）；spawnManaged 生命周期；事件消费循环。
- providerRegistry 接线（providerRegistry.ts:238-240 kimi 先例位）。

---

## 5. launch-verify 清单（静态提取不到、必须启动才能验）

1. **bin 可 spawn 性**：`node <HROOT>/packages/examples/jsonrpc-demo/lib/bin.js <config>` 在本机 Node/Electron 主进程下能否 boot（workspace 裸说明符经 HROOT/node_modules 解析是否闭合；lib 构建产物与源码是否同版）。备选 tsx 形态同验。
2. **initialize 往返**：serverInfo 是否确为 `deepseek-harness-sdk-runtime/0.0.1`；DEEPSEEK_API_KEY 缺失/有效两态的报错形态（credential seam 阶梯是否按 README 所述 env→.credentials.yaml）。
3. **首回合全链**：session/prompt → agent/inbox/spliced 回执 → assistant/chunk 是否真以 firehose 逐条到达（**packChunks 持久化打包是否影响在线 firehose 粒度**——静态无法确证 chunk 在线推送不被合并）。
4. **会话落盘位置**：dshHomePath('sessions') 在 DevHub spawn env 下是否确落 `~/.dsh/sessions/<projectKey>/…` 且 observed 扫描器可读（projectKey 归一化算法与 deepseekProvider 期望一致）。
5. **优雅取消缺口**：kill 阶梯在 Windows（taskkill /T /F）下能否不留 node 子进程树；回合中途 kill 后日志是否完整可被 observed 重建。
6. **approval policy 'never' 语义**：workspace-write 沙箱下越权 bash 是否自动拒绝而非挂起（approval/asked 是否根本不产生；若产生且挂起，需改组合策略）。
7. **shutdown 自杀**：shutdown 应答→exit 0 的实测时延；flush 是否保证日志完整。
8. **并发会话**：单 runtime 多 sessionId 并行 prompt 的 firehose 隔离（session.event 的 sessionId 过滤）与吞吐。
9. **stdout 洁净度**：整个组合启动/运行/退出是否有非协议字节窜入 stdout（组合插件矩阵相关，静态不可全证）。
10. **版本漂移哨兵**：若用户升级 HROOT（npm latest 0.1.5-rc.x），initialize serverInfo.version 变化 + 事件词表增长（KNOWN_SESSION_EVENT_TYPES 是生成物）需重跑 1-9；SDK 协议面 master 未变是当前信心来源。

---

## 6. 真实推理消耗预估（对齐 kimi 批口径：一次性探测必有消耗与垃圾会话）

- caps 探测：**零推理**（spawn+initialize+shutdown，无 prompt；provider 行为探测=文件在位检查）。harness 侧无会话产生（无 prompt 无会话）。
- 实现批联调：每条最小 prompt ≈ 1 回合 DeepSeek 推理（v4-flash 档，成本与 zcode/codex 联调同级；预估 <10 回合），产生垃圾会话若干（落 `~/.dsh/sessions`，observed 面可见——**建议联调期 spawn env 设 DSH_HOME 指向临时目录**，验收前切回默认做同一性验收，避免垃圾会话污染用户 observed 视图）。
- 运行期：消耗=用户真实使用（与 zcode managed 同位），DevHub 不增加背景推理。

## 7. GO/NO-GO 判定

**GO**（以 zcode 对标为标准）：

1. 用户目标的最小全集——手机发起/对话/流式接收/状态判定/转录——SDK 通道 100% 覆盖，且流式粒度（assistant/chunk delta + 44 型全事件）**超过** zcode managed 面的对等能力（zcode 26 型 payload）。
2. wire 与既有 zcodeProtocol 管道同构（§1.6 对照表），DevHub 侧增量≈1 个适配文件 + 1 个配置门文件 + provider 接线，无新管道、无新依赖。
3. spawn 载体已构建在位（lib/bin.js），Windows 可用（打包 exe 虽无 win32，但 node 载体不需要它）。
4. 协议稳定性证据充分：SDK 面自本地版本至 master 零破坏；上游以双语言 client 维护同一 wire。
5. live/observed 同一性有结构性保证（同 root 同布局同 id），非缝合。

**保留条件（非阻塞）**：
- 无 wire cancel（v1 以 kill 阶梯 + 双超时兜底；优雅取消留待上游 SDK 增方法后跟进）；
- approval 无远程问答（v1 钉 never+workspace-write，UI 如实呈现 approval_required）；
- HROOT 版本漂移需 launch-verify #10 哨兵兜底。

**NO-GO 项**：ACP 路线（本地版本能力不足，上游 #4691 实证）；host apiproxy 路线（重量与暴露面不成比例）。

—— 本批零启动零编码，未运行任何 dsh 进程；凭据仅确认存在性与键名。汇报毕，候主控裁决再立实现批。
