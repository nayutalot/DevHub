# deepseek-managed E2E 验收报告（DM 批，2026-09-14/15）

> 任务书：docs/briefs/dm-dsh-managed.md；设计全案：docs/27-deepseek-managed-design.md。
> 协议级真机验证（provider/库模式；隔离 DEVHUB_HOME 临时实例承载 settings DB——
> 桌面常驻实例零触碰，毕后 health×3 全过 uptime 连续递增）。
> runner：run-e2e.mjs（本目录）；wire 级诊断工具：wire-probe.mjs。
> 证据：evidence/（e2e-log.jsonl 全程、t1-timeline 流式时序、t2-messages 工具面、
> t3-pause kill 阶梯、identity-observed-messages 同一性、launch-verify-10.json、
> caps-managed/reverted 两态）。

## 验证序列（任务书 §2）

| 步 | 结果 | 证据 |
|---|---|---|
| 键置 1 | 门开（provider=deepseek-official, model=deepseek-v4-flash） | e2e-log gate |
| caps | mode=managed granted=[reply]，evidence 带版本哨兵两层 | caps-managed.json |
| startManagedSession | 真实 spawn 574ms；initialize 握手 serverInfo `deepseek-harness-sdk-runtime` v0.0.1；nativeId=`session-ee998ab6-…` | t1-start.json |
| firehose 流式落投影 | assistant chunk 逐条投影（'收到'→'。'→'收到。'），全部先于 idle 边沿到达；T2 二回合 43 段逐字 delta 跨 200ms+ 时序 | t1-timeline.json / t2-messages.json |
| sendReply 第二条 | live 连接 session/prompt executed（evidence=live-prompt） | t2-reply.json |
| idle 收尾 | turn/end reason completed（wire 形态 `{kind}` 对象）→ waiting_input；session.status idle | e2e-log |
| observed 同一性 | 同 sessionId 出现于 observed 扫描（`~/.dsh/sessions` 同根同布局）；readMessages 重建 8 条（roles user,user,assistant,user,assistant,tool,tool,assistant） | identity-observed-messages.json |
| kill 阶梯 | pause=终止进程（无 wire cancel 如实）；shutdown→taskkill 温和→/T /F；**零孤儿 runtime 进程**（powershell 扫描实证） | t3-pause.json |
| 键归 0 | caps 回 observed（legacy evidence 逐字节）；spawn 拒绝 | caps-reverted.json |

## launch-verify 十条（docs/27 §5）

1. bin 可 spawn 性 **PASS+发现**——DSH loader 从 **config 文件目录**解析裸插件
   说明符（HROOT 外 config 全部 ERR_MODULE_NOT_FOUND，docs/27 §1.3 假设需修正）；
   桥接 = DevHub 渲染目录内 `node_modules` junction → `<HROOT>/examples/node_modules`
   （官方解析根，18/18 插件在位复核），零写 HROOT；boot-to-initialize ~3s（冷）
   /574ms（暖 spawn）。
2. initialize 往返 **PASS**——serverInfo name/version 哨兵核对每次 spawn 强制；
   credential seam harness 自取（缺 key 态未模拟以避免触碰用户凭据，如实注记）。
3. 首回合全链 **PASS**——firehose 在线粒度实锤（chunk 逐条到达非终态一次性）；
   packChunks 打包不影响在线推送。
4. 会话落盘位置 **PASS**——`~/.dsh/sessions` 同根，observed 扫描器以同 sessionId
   可读（同一性结构保证兑现）。
5. 优雅取消缺口 **PARTIAL**——kill 阶梯 Windows 下零残留树；mid-turn kill 时点
   尚无持久化内容可重建（0 条，如实记录；无损坏）；wire cancel 协议缺失已文档化。
6. approval never **PARTIAL**——approval/asked 全程未触发（bash 工具在
   workspace-write 下运行）；T2 工作区=home 时 Windows ACL 沙箱 temp-root 约束
   （temp 须在 workspace 外）致 bash 启动失败并如实上屏——部署注记：生产
   workspace 应指向具体项目目录；无挂起。
7. shutdown 自杀 **PASS**——应答后 runtime 自退，dispose 路径实测毫秒级；
   落盘 flush 由 persistence 读回验证。
8. 并发会话 **DEFERRED**——真机并行 prompt 超出 3 条推理预算；sessionId 隔离
   由夹具（dsh-104/105 外来会话事件计数不串投影）结构化覆盖。
9. stdout 洁净度 **PASS**——全部投影均源自解析成功的 JSON-RPC 通知行；非协议
   字节零出现（夹具单测加守）。
10. 版本漂移哨兵 **PASS**——每次 spawn 强制 name/version 核对；HROOT 版本
    0.1.0-rc.5 记录在案；漂移→结构化拒绝（dsh-102/106 夹具证明）。

## 真实推理消耗（如实）

- E2E 三条最小 prompt：T1（直接回复，~1.5s）、T2（bash 工具+沙箱注记）、
  T3（数数，mid-turn 终止）。
- 另有 wire 诊断探针 1 条完成回合（input 2203 / output 2 tokens）+ 1 条 LLM
  网络挂起尝试（无完成证据）+ 1 条 cwd 守卫拒绝（零推理）。
- 垃圾会话：`~/.dsh/sessions` 新增 2 个 E2E 会话（T1/T3）+ 若干探针会话
  （验收口径，docs/27 §6）。

## 环境事实与偏差

- **网络**：api.deepseek.com 本机直连超时；验证经用户系统代理路由
  （NODE_USE_ENV_PROXY+HTTPS_PROXY=127.0.0.1:7897，runner 以普通 shell 方式
  设置；路由非凭据；provider 代码零注入——生产透传用户 shell 环境）。
- **turn/end reason wire 形态**：`{kind:'completed'}` 对象（docs/27 §1.6 假设
  字符串）；deepseekProtocol 已双形态容忍 + dsh-101 断言锁定。
- **sessionId↔cwd 绑定守卫**（runtime 行为实测）：同 id 异 cwd 结构化拒绝
  （turn/end error）；DevHub 每回合新生成 id 不受影响。
- **默认 workspace=home 的沙箱约束**：bash 工具要求 temp root 在 workspace 外
  （Windows ACL）；生产建议将工作区指向项目目录（settings 注入缝已在）。

---

## run5-fix 追验（2026-09-15，RD run5 双缺陷修复后）

> 证据：run5-fix/（verify-log.jsonl 全程、t1-t3-evidence.json 逐回合三证、
> caps-managed/reverted）；诊断工具：repro-run5.mjs（双场景复现）、resume-probe.mjs
> （resume 语义 wire 级精查）。

### 缺陷 A（阻断）根因链与修复

- **复现实锤**（repro-run5.mjs 双场景）：live 近距离 sendReply 全通（wire mtime
  推进+投影增量）；idle 杀后回退路径 `one-shot resume` 报 **executed 但零内容**。
- **wire 级根因**（resume-probe.mjs）：新 runtime 对已持久化 sessionId 的
  session/prompt——spliced 回执照发 + turn/start → **turn/end reason error
  「already has a persisted log on disk that does not match this live session」**
  → status idle。旧回退的 receipt+idle 双判据据此全真 → **假 executed**；且回退
  连接 noticeRoute 不接 sink → 零投影。SDK 协议无 session/resume（docs/27 §1.2
  早已断言），同 id 回退在协议上不可行。
- **触发时序**（run5 t-latency.txt）：msg2 首发距 spawn 251s > idle 180s → live
  连接被 spawnManaged idle-timeout 树杀 → 全部 msg2 落入假回退。
- **修复**：① idle 180s→**1800s**、lifetime→**7200s**（真人节奏 251s/782s 全落
  live 窗口）；② one-shot resume 路径整体废除——死会话 sendReply = 显式结构化
  失败（detail 如实陈述 no session-resume wire 事实），live prompt 失败竞态同样
  显式失败，绝不假成功。

### 缺陷 C（UX）根因与修复

- **根因**：每 text-delta 独立 nativeMsgId（`chunk-<seq>`）+ L3 persistMessage
  INSERT OR IGNORE（append-only）→ 13 段=13 条气泡。
- **修复**：① provider 侧同 turn+step 的 delta 累积投影共用
  `assistant-t<N>s1`（handle.streaming 累积态；committed 终态覆盖同一条；
  turn/step 缺失漂移回退独立身份绝不猜合并）；② persistMessage 改 **upsert**
  （ON CONFLICT(session_id, native_msg_id) 覆盖 content/segments；五家既有投影
  面无重复投影，语义等价）；③ message.appended 事件指纹 →
  `nativeMsgId:内容长度`（增长步新事件驱动 App refresh，同内容重放零重复）。

### 多回合真机验证（run5-fix-verify.mjs；生产默认门，恰 3 条最小 prompt）

| 回合 | sendReply | 流式增量（单气泡） | wire mtime/size | observed seq 游标 |
|---|---|---|---|---|
| T1（spawn） | — | 3 段「第一→第一回合」 | …4105562/4215B | 8 |
| T2 | live executed | 3 段「第二→第二回合」 | …4107166/5260B | 22 |
| T3 | live executed | 3 段「第三→第三回合」 | …4107801/6214B | 36 |

三证交叉：wire mtime/size 逐回合推进 ✓、事件 seq 游标 8→22→36 逐回合推进 ✓、
每回合恰一个 assistant 气泡 id（t1s1/t2s1/t3s1）回合内增长 ✓（部分增量与状态沿
同毫秒到达——严格小于注记如实）。kill 阶梯收尾 22ms、零孤儿 runtime 进程
（powershell 扫描）、键归 0 caps 回 observed（legacy 形态逐字节）、常驻实例
health×3 过（uptime 连续递增零触碰）。

### 消耗（如实）

3 条最小 prompt（每回合一条，回复各 5 字内）；验证窗口内 `~/.dsh/sessions` 新增
1 个会话（session-9c172304…）。
