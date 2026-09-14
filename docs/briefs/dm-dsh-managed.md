# DM 批任务书：DeepSeek Harness managed 实装（SDK jsonrpc 直连，zcode 对标）

> 背景：用户目标「必须实现类似 zcode 的远程控制」；DSH-SCOUT 判定 **GO**（docs/27 设计全案已合 main，主控裁决：SDK jsonrpc 直连+授权门+cordis.yml DevHub 渲染+kill 阶梯+approval v1 钉 never）。本批=实装+真机验证。基线 main=DSH-SCOUT 合并后 main；门禁 typecheck 0+fast 129+full 226。

## 0. 工作区与纪律

- worktree：主仓根 `git worktree add worktrees/dm-dsh-managed -b agent/dm-dsh-managed main`；`npm install`。
- 每 commit 即 push 分支（直连优先 socks5h://127.0.0.1:1081 兜底重试循环，隧道半死先 taskkill //F //IM ssh.exe 重建）；绝不 push main；绝不 --no-verify。
- **凭据三零**：harness 自取 `~/.dsh/.credentials.yaml` 的 DEEPSEEK_API_KEY——DevHub **零读取零注入零日志**；cordis.yml 渲染物不含任何凭据字段。
- **真实推理已授权但最小化**：E2E 用最小 prompt（1-3 条），消耗如实入册。
- **本批独占常驻运行时窗口**（真机 E2E 复验归主控后续 RD 复验，本批做 provider/协议级验证）。

## 1. 实装范围（docs/27 §4 设计草案为纲）

1. **`deepseekProtocol.ts`**（对齐 zcodeProtocol 形态）：ndjson JSON-RPC 2.0 帧编解码（jsonrpc:'2.0'/id=req_<uuid>，入站不校验 jsonrpc 字段的兼容）；请求 initialize{cwd,provider,model,maxTokens}/session/prompt{sessionId,contentBlocks}/shutdown；通知消费 session.event（44 型 firehose，event→payload 槽薄适配进既有 eventPipeline/messageSegments）、session.status（idle|running；「回执→idle」收尾语义）、subagent.started/finished。**优先复用 zcode 帧解析器的可共用部分**（docs/27 结论：parseZcodeFrame 可零改动解析），抽公共或薄适配由你按最小侵入定。
2. **`deepseekManagedConfig.ts`**：settings 键 `deepseek_managed_enabled`（恰 '1' 授权，默认停用；键=0 行为逐字节不变——KC 的 one-shot spawn/observed 全保）+可选 `deepseek_managed_model`；cordis.yml 渲染（sdk-jsonrpc-server+agent-spine+llm-deepseek+persistence root=dshHomePath('sessions')+sandbox workspace-write+approval never+**无 stdout logger**——协议通道洁净红线）；spawn 模板=Electron 内置 node+`packages/examples/jsonrpc-demo/lib/bin.js`（env DSH_CORDIS_CONFIG 指渲染物；路径经 settings `deepseekHarnessRoot` 解析，env→path 复用 resolveHomeDir 既有边界）；**版本漂移哨兵**（bin.js 存在性+initialize 握手版本字段核对，失配结构化拒绝）。
3. **deepseekProvider managed 接线**：caps 翻转（键=1→managed+granted reply，evidence 带版本证据）；startManagedSession 走协议 live 会话（惰性 create→prompt 合一）；sendReply 对 live 会话走 prompt、对已死会话回退既有 one-shot resume（两态并存，诚实 evidence 区分）；stop=kill 阶梯（shutdown→EOF→SIGTERM→SIGKILL，docs/27 sdk client 参考实现）+双超时；无 wire cancel 如实呈现（取消按钮语义=终止进程）。
4. **审批流如实**：approval policy never v1——UI/ⓘ 如实标注「自动模式下工具调用不询问，工作区写入范围受限」；launch-verify 十条（docs/27 §5）逐条验证并留证据。
5. **夹具单测**：假 dsh 脚本覆盖 initialize/prompt/firehose 流式/status idle 收尾/kill 阶梯/版本哨兵拒/键=0 逐字节不变（对齐 kc/km 夹具风格）；smoke 计数如实。

## 2. 门禁与真机验证

- typecheck 0 + smoke fast 全绿（基线 **129/129**）+ **full 档全绿（基线 226/226）** + build；Android 零改动（caps 数据驱动自动出现，不出 APK）。
- **协议级真机验证**（隔离 DEVHUB_HOME/临时实例，单实例锁窗口纪律；毕还原常驻 health×3）：键置 1→caps managed→startManagedSession 真实 spawn→**firehose 流式增量落投影**（assistant/chunk 到达时序证据，非终态一次性）→sendReply 第二条→status idle 收尾→observed 同会话可见（同一性证明）→kill 阶梯→键归 0 回归。真实推理消耗如实。
- **launch-verify 十条逐条**留证据（docs/27 §5）；E2E 证据入 `acceptance/deepseek-managed-e2e/`（盘凭据后入册）。

## 3. 汇报

commits / 设计偏差（对照 docs/27 逐条）/ 门禁数字（fast/full）/ 真机验证逐序列证据（流式时序/同一性/可撤销）/ launch-verify 十条结果表 / 推理消耗如实 / 偏差如实。
