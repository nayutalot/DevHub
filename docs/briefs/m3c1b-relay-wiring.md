# M3-C1b 批任务书（relay 设置驱动面 + TLS 信任装载——改码批）

> 背景（C1 批已查明，信任勿重查）：IPC `settings:set`（handlers.ts L452-480）白名单已含 relay 两键且翻转即时生效（L474-478 → applyRelaySettings），但无任何对外驱动面；TLS 注入缝在 wsClient.ts L456-469，index.ts L360 `openRelayConnection({endpoint, credential})` 未传 tls。凭据/指纹文件已落盘（%LOCALAPPDATA%\DevHub\relay\credential + fingerprints，后者为 C1 约定名）。
> 基线 main=527a464。工作目录主仓 `F:\Active_Project\DevHub`，分支 `agent/m3c-relay-wiring`。改码范围：`src/main` + `src/renderer` + `scripts/smoke.mjs`（append-only 新段）。

## 0. 占用资源清单（机器资源登记）

- 本地门禁窗口：跑 smoke/mcp 前后端口铁律（taskkill DevHub.exe → 跑毕恢复+curl 200）
- 不碰 android/、ecs-relay/、ECS、DevHub.exe 除门禁窗口外
- 凭据红线：不读取/不打印 %LOCALAPPDATA%\DevHub\relay\credential；指纹是公开物料可用

## 1. 任务

### ① TLS 信任装载（src/main/services/agentControl/relayClient/）
- config.ts 新增 `loadRelayTlsTrust()`：读指纹文件 `%LOCALAPPDATA%\DevHub\relay\fingerprints`（每行一枚 `sha256/{hex}` 或 base64(32B)，注释/空行跳过，归一化小写 hex，格式错 fail-fast 抛带路径错误）+ 读 CA 文件 `%LOCALAPPDATA%\DevHub\relay\ca.pem`（可选存在；不存在时 ca 省缺——仅靠 pin 校验需绕默认链验证，**不采用**：无 CA 时抛结构化错误提示补 ca.pem，与 docs/19 §10 信任模型一致）
- index.ts `openRelayConnection` 调用点：endpoint 为 wss:// 且指纹/CA 就绪 → 构造 `tls: { ca, checkServerIdentity }`（先跑 `tls.checkServerIdentity` 默认规则（IP SAN 匹配），再 SPKI pin 比对（指纹集任一命中即过，双指纹窗口语义）；实现形态参照 docs/ecs-relay-deploy/README.md §4 Node 示例——SPKI DER 提取按 ws 库 peerCertificate 实测，勿照抄伪代码）；信任物缺失 + relay_enabled=1 → 结构化告警投影（statusProjector relay 状态面，不静默零连接也不崩）
- wsClient.ts 缝按现签名接，不破坏 16 帧/连接语义（nb-r1 段全部保持绿）

### ② 设置驱动面（src/renderer 设置视图）
- 设置页新增「远程中继（Relay）」分组：relay_enabled 开关、relay_endpoint 文本框（wss:// 前端校验，输 ws:// 红字拒绝——对齐 R3 App 行为）、指纹状态行（枚数+来源文件名，只读展示）
- 走既有 settings:get/set IPC（白名单已有），零新增 channel（PR12 纪律）；样式对齐现设置页

### ③ smoke 新段（append-only，scripts/smoke.mjs 尾部，用例名 `nb-c1b-*`）
- 指纹文件归一化（hex/base64/大小写/空行注释/fail-fast 格式错）
- ca.pem 缺失 → 结构化错误；齐备 → tls 对象构造 + checkServerIdentity 正/负用例（临时自签证书本地生成，端口段外；错指纹拒绝/对指纹通过/默认规则先行——IP SAN 不匹配即拒）
- 计数断言动态（沿用现机制），提交信息注明新增数

## 2. 门禁（全绿）

typecheck 0 错 / smoke 164+新增 全绿 / build 绿 / mcp-acceptance 27/27（先 commit 树净）。

## 3. 铁律与汇报

- 28 条合同；smoke append-only；exec.ts 唯一 spawn；不新增 IPC channel；凭据零读取
- 增量提交+每次 commit 后 push `origin agent/m3c-relay-wiring`
- 汇报四分类+分支 SHA+门禁数字+新增用例清单+CA/指纹文件最终路径约定（ca.pem 名单写进汇报，C1c 批要放文件）
