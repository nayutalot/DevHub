# DSH-SCOUT 批任务书：DeepSeek Harness 控制面深挖——协议地图+zcode 对标设计（侦察批，零启动零编码）

> 背景：用户目标「app 端与 deepseek harness 的直连是重点，深挖系统文件，再上 GitHub 找，无论什么方式，**必须实现类似 zcode 的远程控制**」——即手机经 DevHub 发起/对话/流式接收 DeepSeek Harness 会话（对齐 zcodeProvider managed 能力面）。DS 批已实装 observed（~/.dsh 会话投影）并定位两条控制面候选：**`packages/acp/acp`**（manifest 自述 "Automation-only Agent Client Protocol server ... over JSON-RPC stdio"）与 **`packages/sdk/dsh-sdk-{client,protocol,jsonrpc-server}`**（stdio JSON-RPC subprocess SDK）；均未验证。harness 根=D:\Apps\deepseek-harness（@deepseek-ai/dsh-root 0.1.0-rc.5）。本批=只读深挖+网上检索+设计产出；**零启动 harness、零编码**。

## 0. 工作区与纪律

- worktree：主仓根 `git worktree add worktrees/dsh-scout -b agent/dsh-scout main`（纯读盘+web 检索）。
- 每 commit 即 push 分支（直连优先 socks5h://127.0.0.1:1081 兜底重试循环）；绝不 push main；凭据三零——**`~/.dsh/.credentials.yaml`/settings.yaml 只确认存在性与键名，绝不读值入册**。
- **零启动**：不运行任何 dsh 进程/脚本（启动验证项列清单留实现批，本批从源码静态提取协议）。

## 1. 交付一：控制面协议地图（每条带 文件:行号 证据）

1. **`packages/acp/acp` 全解剖**：bin 入口与启动 argv；JSON-RPC 方法全集（请求/响应/通知：session 创建、发消息/prompt、流式事件订阅、取消、approval 问答）；传输（stdio 帧format：ndjson/LSP 式 header？）；鉴权/握手；会话↔`~/.dsh/sessions` 落盘关系；**与 Zed Agent Client Protocol（ACP）公开规范的同名方法对照**（若即标准 ACP，给出 spec 来源 URL 与差异清单）。
2. **`packages/sdk/dsh-sdk-{client,protocol,jsonrpc-server}`**：client API 面（create/send/subscribe/onEvent 签名）、protocol 类型表、与 acp 包关系（同一协议双载体？版本差？）。
3. **`apps/cli`（bin.ts）**：modes（profile/plugin/dump-config）之外有无可启动 server/acp 模式的 flag；`dsh` 一次性 `-p` 与常驻 server 的关系；模型/凭据加载路径（settings.yaml 键名）。
4. **`host/*`（webserver/apiproxy）**：有无可替代的 HTTP/WS 控制 API（备选通道评估）。
5. **事件流映射**：44 型权威事件词表（core/session known-event-types）中，哪些经控制面流出（assistant/message、tool/call、approval/asked…）、行格式与 zcodeProtocol ndjson 的逐字段对照。

## 2. 交付二：网上检索（GitHub/npm/官方文档）

- `@deepseek-ai/dsh*` npm 包、GitHub 上 deepseek harness/DSH 仓库/文档、ACP 公开规范（agent client protocol）、任何第三方集成示例；每条来源 URL+与本地版本（0.1.0-rc.5）差异要点。检索无果也如实记录（「仅本地源码可用」本身是结论）。

## 3. 交付三：zcode 对标设计提案（docs/ 新章）

- **选型建议**：acp vs sdk vs host API（传输/进程模型/维护面/与 zcodeProtocol 同构度），每项利弊+推荐。
- **deepseekManaged 设计草案**：spawn 形态（启动 argv+HOME/env 纪律）、会话生命周期（create→send→stream→end 与 DevHub eventPipeline/messageSegments 对接点）、managed 回复链与既有 observed 投影的会话同一性（live 会话落盘后 observed 视角能看到同会话）、授权门形态（对齐 `kimi_managed_enabled`/`zcode_managed_model` 先例的 settings 键）、红线下放清单（启动 harness 的审批流/工具调用是否需 gate）。
- **风险与未知清单**：静态提取不到、必须启动才能验证的点（逐条列「launch-verify」）；真实推理消耗预估。
- **GO/NO-GO 判定**：以 zcode 对标为标准的可行性结论。

## 4. 汇报

协议地图要点 / 选型推荐+理由 / 设计草案骨架 / launch-verify 清单 / GO-NO-GO / 偏差如实。**汇报后停，等主控裁决再立实现批。**
