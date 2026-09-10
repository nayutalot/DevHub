# S 批任务书：「远程工作区链接」自动抓取+推送——ZCode 遥控链接零操作直达手机

> 需求（用户 2026-09-11，原话纠偏：「远程控制居然要我在电脑旁边粘贴链接，那我远程的意义
> 在哪？改成应用自己抓，然后直接推送到 app 上」）：App 端零手工——自动获取当前有效的
> ZCode 移动遥控 URL 并出现在「远程工作区」屏。
> 架构裁决（主控定，R 批侦察证据 acceptance/agents-mobile/zcode-url-source-20260911-0415/）：
> **App 经 relay 发新命令 `workspace_link` → 桌面 commandDownlink 处理器从磁盘三文件
> 重建 URL → command.result 回流 → App 自动建/更新置顶条目一点即开**。纯拉取模型
> （URL 凭据成分静态，t 为时间戳 nonce——App 需要时取，永远新鲜且有效）。
> 执行者：omni-agent，worktree `F:/Active_Project/DevHub-worktrees/wlink`，分支
> `agent/workspace-link`（自 main 切出）。三栈批：桌面 TS + App Kotlin + ecs-relay。

## 0. R 批已查明事实链（勿重复侦查，细节读证据目录）

- **URL 结构**：`https://zcode.chatglm.site/remote/v4?sid=<deviceSid>&hash=<passHash>&t=<ms>&mid=<deviceMid>&name=<deviceName>&app_version=3.11.2`。
- 三来源：`~/.zcode/v2/setting.json`→`webRemoteControlExternalRelayDevice.deviceSid`（明文）；
  `~/.zcode/v2/credentials.json`→键 `web-remote-control:external-relay:pass_hash`＝信封
  `enc:v1:<iv_b64url>.<tag_b64url>.<ct_b64url>`（AES-256-GCM，**tag 在中间**）；密钥=
  `sha256("zcode-credential-fallback:win32:C:\\Users\\<user>:<user>")`（env
  `ZCODE_CREDENTIAL_SECRET` 可覆盖——读取顺序 env 优先）；`~/.zcode/v2/telemetry-state.json`
  →`deviceMid`。三成分 60s 双采样均静态。
- app_version 从 ZCode 读不到就常量 3.11.2（带 TODO 注记）；name=设备名（hostname）。
- **令牌红线**：sid/hash/mid/完整 URL **绝不入日志/审计/证据**（relay_audit 与桌面
  security_audit 的 payload 均不得含 URL；证据一律 <TOKEN:len:sha8> 脱敏——R 批先例）。
- ZCode 无本地端口（0 LISTEN）——不存在更轻的查询面，磁盘重建即最短路径。
- relay 命令面扩 action 先例=M3-E1（docs/18 §5.3；ECS 白名单+CHECK+桌面处理器+App）。

## 1. 设计裁决（主控定）

1. **新 action `workspace_link`**（docs/18 §5.1 七值→八值，值域扩展零新逻辑分支）：
   payload `{}`（无参数）；result `{ provider:'zcode', url, deviceName }`。**审计红线**：
   relay/桌面审计 payload_json 只记 `{provider}`，URL 与其任何子串零落库（上行 redact
   纪律——desktop 侧 result 事件构造时即脱敏审计面）。
2. **桌面** `src/main/services/agentControl/zcodeLinkProvider.ts`（electron-free 纯函数：
   fs 读取器注入式供测试）+commandDownlink 处理器（授权矩阵：READ 类能力门——任何已
   配对设备可查询；文件缺失/解密失败→结构化 `ZCODE_LINK_UNAVAILABLE` 带 reason，绝不
   partial URL）。**零持久化**：URL 仅内存构造即发；不写 settings/DB。
3. **ecs-relay**：`RELAY_ACTIONS` +`workspace_link`；**sql 0004** 表重建扩 action CHECK
   （照 0003 先例，append-only）；forwarder 测试+2；selfcheck 步扩（八值中继/未知仍拒）。
4. **App**：ConnectionManager `submitWorkspaceLink()`（command 流复用
   submitCommand 面形态——ack→result 取 url）；RemoteWorkspaceScreen 顶部固定
   「ZCode 工作区」智能条目：tab 打开时**自动请求**（结果缓存到条目；离线桌面=排队
   提示照 relay 语义）→ 条目点击直接打开 WebView。**零粘贴路径保留**（手动条目照旧）。
5. **零改动面**：App pin-TM/relay 连接层不动；桌面 spawn/幂等体系不动；docs/04 不涉
   （relay 协议非桌面 IPC）——docs/18 §5.1/§5.3 就地更新。

## 2. 交付物清单

1. 桌面：zcodeLinkProvider（含 enc:v1 AES-GCM 解密、密钥派生 env 优先、三文件解析）
   +处理器+smoke 用例（fake fs 注入：三文件齐→URL 形状断言（值脱敏断长度/前缀）；
   缺文件/坏信封→ZCODE_LINK_UNAVAILABLE；审计面断言零 URL 子串）。
2. ecs-relay：白名单+0004+测试+selfcheck（node --test 110→112+；selfcheck 计数就地更新）。
3. App：submitWorkspaceLink+单测（fake ws：ack/result 映射+超时+NotConnected）；
   RemoteWorkspaceScreen 智能条目+自动请求+测试（:app 72→≥76）。
4. docs/18 §5.1 帧表+§5.3 追加注记（八值；workspace_link 语义与审计红线）。

## 3. 门禁与铁律

- 桌面：tsc 0+smoke fast/full+mcp 27（mcp 前停常驻铁律）；:app/:core+assembleDebug；
  ecs-relay node --test。每 commit 即 push（墙期 ECS SOCKS 配方，1082，用毕杀）；
  绝不 --no-verify。
- **部署留主控**（本批零部署）：ECS 0004+白名单、桌面换装、APK 分发——合并后主控另派。
- 令牌三零最高优先级；卡死重试 ≤2；架构冲突停手上报。

## 4. 汇报

三栈 diff 摘要+门禁计数表+审计脱敏验证说明+push 状态。
