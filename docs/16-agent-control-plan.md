# DevHub Agent Control 开发计划（docs/16，AC2–AC9 批次）

> Phase 2/3 Agent Control / Mobile 设计，约束基线同 docs/00；migration/历史文档零改动。
> 每批开工前重读 docs/00 全部 28 条；每批完成必须四门禁全绿
> （`npx tsc --noEmit` + `node scripts/smoke.mjs` + `electron-vite build` + mcp-acceptance 22/22）。
> smoke 用例只增不减（约束 #27）；文档与实现偏差必须如实上报（约束 #6/#28）。

---

## 1. 批次表（AC2–AC9）

### AC2 —— 数据层 + 白名单（先行批）

| 项 | 内容 |
| --- | --- |
| 范围 | migration 004（8 新表 + 4 settings 种子，docs/13 §4/§6）；migrate.ts 补 case 4（docs/13 §3）；agentControl service/repository 骨架（建表可用、provider 目录常量、getDatabase 接线）；IPC 白名单追加 13 条 agents: channel + ChannelContract 增行（docs/14 §A）；resourceGraph ResourceType/RelationType 扩值；settingsService.ALLOWED_KEYS 6→10；shared/types.ts ErrorCode 增 17 值 |
| 交付物 | `src/main/db/migrations/004_agent_control.sql`；`src/main/services/agentControl/`（agentControlService / providerRegistry / redact 骨架）；channels.ts / types.ts / handlers.ts / settingsService.ts / resourceGraph.ts / migrate.ts 更新；smoke 新增 migration 004 双路径 + 白名单 68 断言 |
| 涉及文件 | 上述 + `scripts/smoke.mjs`（step1/step6/s4-68 三处 55→68 就地更新，s4-68 注明模式授权） |
| 门禁 | tsc / smoke / build / mcp-acceptance |
| 验收 | fresh 库 user_version=4 且 8 新表存在；v3 库升级既有 19 表数据零改动（T1）；未注册 case 4 的负向护栏（T2）；68 条白名单三处断言全绿 |

### AC3 —— Provider 框架 + Codex + Claude Code

| 项 | 内容 |
| --- | --- |
| 范围 | AgentProvider 接口落地（docs/12 §4 九方法）；monitorRegistry（Map + cancel token，walker 先例）；eventPipeline（7 类型 / event_id 派生 / 去重 / 先落库后投递 / sequence AUTOINCREMENT）；exec.ts spawnManaged（docs/12 §3 契约全文：参数数组、无 shell、stdin 可写、增量回调、心跳空闲超时 + 总生命周期上限、taskkill /T 树杀）；codexProvider（bin\<hash> 发现 + app-server 托管 + rollout jsonl 观察降级）；claudeProvider（hooks 合并写入 + 备份 + 恢复 + env.* 零改动 + 独立内部回环回调 listener（docs/12 §8.2）+ 转录观察） |
| 交付物 | providers/codexProvider.ts、providers/claudeProvider.ts、monitorRegistry.ts、eventPipeline.ts、exec.ts 追加导出；hooks 恢复脚本/动作；smoke：jsonl 增量/轮转/截断/不完整 JSON、spawnManaged 超时与树杀、hooks 夹具写入备份恢复 |
| 涉及文件 | `src/main/core/exec.ts`、`src/main/services/agentControl/**`、smoke |
| 门禁 | tsc / smoke / build / mcp-acceptance |
| 验收 | 真实 Codex 会话被观察到（health + sessions 落库）；app-server 失败 → observed 降级（T6）；hooks 写入后 settings.json 其余键（含 env.ANTHROPIC_BASE_URL）逐字节不变且可恢复（T7） |

### AC4 —— Kimi + ZCode + DeepSeek + 事件管线收口

| 项 | 内容 |
| --- | --- |
| 范围 | kimiProvider（session_index.jsonl 解析 + spawnManaged 托管 stdin reply + 进程退出≠失败终态判定）；zcodeProvider（db.sqlite 只读快照 + schema 白名单防御 + observed-only）；deepseekProvider（骨架 + 能力检测 + 未接入显式文案）；事件管线全链路收口（7 事件、未确认不删、补发） |
| 交付物 | providers/kimiProvider.ts、zcodeProvider.ts、deepseekProvider.ts；redact.ts 全量脱敏规则；smoke：Kimi 解析与红线（T9/T10）、ZCode 只读不变性（mtime/hash 断言，T11）、DeepSeek 文案（T12）、事件 sequence/去重/补发（T13/T14） |
| 涉及文件 | `src/main/services/agentControl/**`、smoke |
| 门禁 | tsc / smoke / build / mcp-acceptance |
| 验收 | 五家 provider 全部可探测（DeepSeek 显式未接入）；ZCode 探测前后第三方库字节级不变；waiting_input 事件可真实产生并落库 |

### AC5 —— 托盘 + 自启 + Agents 视图

| 项 | 内容 |
| --- | --- |
| 范围 | index.ts 生命周期改写（isQuitting / 关窗隐藏 / 托盘常驻 / 退出收尾顺序，docs/12 §10）；托盘图标资源新增；app.setAppUserModelId；login_autostart 落 setLoginItemSettings（注入胶水）；AgentsView（provider 卡 / 会话列表（9 值状态，对外展示 7 用户态）/ 详情 / 消息 / 事件 / 配对 / 设备 / Gateway 状态 / 诊断；四态强制 + 降级文案）；agents:deviceRevoke、agents:gatewayRestart 的 CONFIRM_REQUIRED 两段式 UI（agents:setAutoStart 直执行） |
| 交付物 | `src/main/index.ts`、`resources/tray.png`、`src/renderer/**/AgentsView`、handlers 补全；smoke：关窗进程存活 + 收尾（T20）、脱敏投影断言 |
| 涉及文件 | `src/main/index.ts`、`src/main/ipc/handlers.ts`、renderer 新视图、resources、smoke |
| 门禁 | tsc / smoke / build / mcp-acceptance |
| 验收 | 真实启动：关窗后进程与监控存活、托盘退出收尾干净（WAL 落盘）；Agents 视图四态 + 真实数据；自启开关生效 |

### AC6 —— Remote Gateway

| 项 | 内容 |
| --- | --- |
| 范围 | gateway/（httpServer + ws + auth + pairing）：13 REST 端点 + WS /v1/events 协议（hello/sync/event/ack/心跳/退避/token_rotation 预留帧）；Bearer Token 校验（SHA-256）、防重放（±300s + nonce LRU）、限流（docs/14 §B.4）；command 幂等/过期；审计落库；gateway_port/gateway_enabled 设置生效与端口顺延；模拟器 10.0.2.2 连通 |
| 交付物 | `src/main/services/agentControl/gateway/**`；smoke：配对全流程（T15）、Token/撤销即拒（T16）、防重放/限流（T17）、幂等/过期（T18）、授权矩阵（T19）、WS sync 补发 |
| 涉及文件 | `src/main/services/agentControl/gateway/**`、smoke |
| 门禁 | tsc / smoke / build / mcp-acceptance |
| 验收 | gateway_enabled=0 零监听；启用后本机 HTTP 客户端全端点行为与 docs/14 §B.1 表逐条一致；未授权/重放/限流路径全部结构化拒绝 |

### AC7 —— Android 工程

| 项 | 内容 |
| --- | --- |
| 范围 | 固定 `F:\Active_Project\DevHub\android`：Kotlin + Compose + Room + OkHttp + Keystore（裁决 6）；配对页 / 设备页 / 会话列表（9 值状态，对外展示 7 用户态）/ 详情（脱敏分页）/ 事件通知（前台服务 WS + 系统通知，触发条件见 docs/12 §6 语义 6，无 FCM）/ reply+pause+resume（按钮仅按服务端 CapabilitySet 显示）；断线重连退避（docs/14 §B.2 参数）；Keystore 存 Token |
| 交付物 | android/ 工程全量（Gradle 配置、Room schema、OkHttp WS 客户端、Compose 页面、单元测试）；**Android 批次门禁加成**：Gradle 构建 + 单元测试全绿 |
| 涉及文件 | `android/**`（新目录，不触碰既有 src/） |
| 门禁 | tsc / smoke / build / mcp-acceptance + **Gradle assembleDebug + test** |
| 验收 | 模拟器安装运行；配对→列表→详情→回复链路对回环 10.0.2.2:8746 打通；通知仅脱敏摘要 |

### AC8 —— NatPierce + 端到端

| 项 | 内容 |
| --- | --- |
| 范围 | NatPierce 隧道透传验证（用户自备凭据，外置配置，docs/15 §8）；端到端场景：**至少一个真实 Agent waiting_input → 手机通知 → 手机回复 → Agent 收到**（回环直连亦可先行验证）；隧道下全端点鉴权/防重放回归；UI 警告无 TLS 裸隧道 |
| 交付物 | 端到端验收记录（截图 + 事件/指令流水摘录）；NatPierce 配置指引（不入仓库凭据）；阻塞点记录（如缺真机/凭据，docs/16 §4） |
| 涉及文件 | 验收记录（artifacts/）；必要时 Gateway 配置提示微调 |
| 门禁 | tsc / smoke / build / mcp-acceptance（+ Android 构建若 AC7 遗留） |
| 验收 | 端到端闭环真实发生且证据留存；隧道侧未经配对的请求全部被拒 |

### AC9 —— 终验收

| 项 | 内容 |
| --- | --- |
| 范围 | 真实启动 Electron 全视图目视验收（含 Agents 视图与托盘）；截图集；交付物 SHA-256 清单；known-limitations 文档；最终报告（含偏差与阻塞记录汇总） |
| 交付物 | 截图、SHA-256 清单、known-limitations、最终报告 |
| 门禁 | 四门禁最后一次全量复跑（tsc / smoke / build / mcp-acceptance）+ Android 构建测试 |
| 验收 | 全部 21 条测试需求（docs/11 §9）逐条对照闭环或显式记录阻塞 |

## 2. 门禁纪律

1. **每批四门禁**：`npx tsc --noEmit`（0 error）、`node scripts/smoke.mjs`
   （全部用例通过、只增不减）、`electron-vite build`（out/ 产出成功）、
   mcp-acceptance（22/22，MCP 零改动的回归证明）。
2. **Android 批次（AC7/AC8/AC9）追加**：Gradle `assembleDebug` + 单元测试全绿；
   无真机时模拟器（10.0.2.2）为准并记录。
3. **npm 缺失时定位真实 Node/npm 路径的纪律**：Git Bash PATH 可能缺 npm——
   优先 `where node` / `where npm`；失败则检查 `C:\Program Files\nodejs`、
   nvm 目录（`%APPDATA%\nvm`）、scoop/volta 安装路径，用绝对路径调用；
   禁止因此改系统 PATH 或安装新工具链；定位结果记入批次报告。
4. 约束 #2：门禁失败必须修复后重跑，禁止跳过或降级门禁。

## 3. 批次间依赖

```
AC2（数据层/白名单）→ AC3（框架+Codex/Claude）→ AC4（Kimi/ZCode/DeepSeek+事件）
→ AC5（托盘+视图）→ AC6（Gateway）→ AC7（Android）→ AC8（NatPierce+端到端）→ AC9（终验收）
```

AC3 与 AC4 内 provider 可并行；AC6 只依赖 AC2/AC3（事件管线与能力门）；
AC7 依赖 AC6 的端点契约（可按 docs/14 §B 冻结契约提前并行开发，联调在 AC8）。

## 4. 阻塞处理原则

- **缺 NatPierce 凭据/账号**：完成回环直连端到端（10.0.2.2），隧道路径标记阻塞点
  （具体缺什么、谁可解除），已验证部分照常交付。
- **缺 Android 真机**：以模拟器完成全部可测项；真机专项（通知显示、Keystore、
  前台服务保活）记录为待真机回归项。
- **某 Agent 接口不可用**（如 app-server 协议不识别、hooks 版本行为差异）：降级路径
  完成观察面，控制面记录阻塞与复验步骤；**绝不伪造接入状态**（docs/11 §4 纪律）。
- 阻塞必须落到批次报告：现象 / 已有证据 / 已完成部分 / 解除条件（约束 #28 精神）。

## 5. 已知风险清单（自 AC0 审计事实提炼）

| # | 风险 | 影响 | 缓解 |
| --- | --- | --- | --- |
| R1 | exec 长驻扩展（spawnManaged）：树杀残留、句柄/监听泄漏、心跳误杀活跃慢输出会话 | 托管子进程失控 / 误中断 | 双上限默认值 + 显式放宽参数；taskkill /T /F 复用 procGuard 范本；退出收尾顺序固定（docs/12 §10）；smoke 超时/树杀用例 |
| R2 | ZCode db.sqlite schema 变更（非公开 CLI） | 解析崩溃或错误投影 | 表/列白名单比对 → 不匹配即 unavailable + health_detail；只读快照；绝不猜测字段 |
| R3 | Claude hooks 共写 `~/.claude/settings.json`（与用户手工编辑、CC Switch、ApiHub env 写入并发） | 配置损坏 / env.ANTHROPIC_BASE_URL 被覆盖 | 写前重读整文件再合并、只动 hooks 键、备份 + 恢复动作、原子写；冲突列入 UI 与文档 |
| R4 | WAL 多进程/多连接并发（Gateway、monitorRegistry、未来清理） | busy / 写冲突 | 同进程共享单例 + 短事务 + 同步 API（docs/08 §2 论证）；busy_timeout 沿用 5000 |
| R5 | CSP 修订诱惑（renderer 直连 Gateway） | 攻击面扩大 / 违反锁定决策 | 铁律：Agents 视图只走 IPC 轮询（archive:status 先例）；build CSP `default-src 'self'` 零改动 |
| R6 | React 19 StrictMode 双挂载导致轮询/动作 promise 重复发起 | 重复请求 / 事件重复 | renderer 轮询去抖（effect cleanup + Abort 语义）；幂等由游标 + 服务端 event_id 兜底 |
| R7 | Codex exe hash 目录随更新变化；exe 不在 PATH | 探测失效 | bin\* 目录发现取最新 hash + --version 复核；探测失败 → degraded 结构化展示 |
| R8 | Kimi config.toml 明文 key 泄漏到新投影面 | 凭据外泄 | redact.ts 统一尾 4 位；smoke 假 key 全通道断言（T10）；审计/日志双重红线（docs/15 §6） |
| R9 | 事件表无限增长 | 磁盘膨胀 | v1 不清理（未确认不删优先）；acked 清理策略登记 backlog（保留期参数届时定义） |
| R10 | 配对码/Token 暴力面 | 未授权接入 | docs/15 §2/§3 全套参数 + 审计；gateway_enabled 默认关 |
| R11 | WS 长连在移动网络下频繁重连 | 事件风暴 / 电量 | 指数退避 + jitter 封顶 60s；sync 增量补发幂等（event_id 去重） |
| R12 | npm/工具链路径漂移导致门禁假红 | 批次误判 | §2.3 定位纪律，绝对路径调用并记录 |
