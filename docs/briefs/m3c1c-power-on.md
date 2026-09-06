# M3-C1c 批任务书（dist 重打包 v2 + ca.pem 落盘 + UI 启用 relay + R-B1/R-B3 host 腿验收）

> 前提：main=020548b 已含 C1b 全部代码（TLS 装载+设置 UI+会话缓存修复）；credential/fingerprints 已在 `%LOCALAPPDATA%\DevHub\relay\`；ECS 服务+TLS+443 就绪；hostId=3 已注册。本批把整链点亮并出 R-B1/R-B3 证据。

## 0. 占用资源清单（机器资源登记）

- **DevHub.exe 常驻全生命周期**：重打包部署换新常驻（旧=当前 win-unpacked；现 bak-20260906 已有，本轮可覆盖不另备份，或增量备份轮换）
- **worktree** `F:\Active_Project\DevHub-worktrees\dist-repack2`（构建用，完成即清）
- **ECS**：只读观测（journalctl/health），零写操作
- 不占 8746-8755 监听（不跑主仓门禁）；不碰 android/ecs-relay 代码

## 1. 任务（顺序）

### ① ca.pem 落盘
`scp -i ~/.ssh/devhub_ecs root@59.110.149.11:/etc/devhub-relay/tls/ca.crt` → 写 `%LOCALAPPDATA%\DevHub\relay\ca.pem`（PEM 原样；公开物料；与 fingerprints 同级）。落盘后 `openssl x509 -in ca.pem -noout -subject` 留证。

### ② dist 重打包 v2（main=020548b）
worktree → npm install → typecheck 0 → `npm run dist` → 产物核验：asar 内 grep `loadRelayTlsTrust`/`maxCachedSessions`（C1b 代码在包内证据）；部署换常驻（杀→换→起→curl 200）。

### ③ UI 启用 relay（computer-use 驱动设置界面）
新常驻启动后：DevHub 应用 → Agents 视图 → 「远程中继（Relay）」分组 → 确认指纹状态行就绪（1 枚/文件名）→ 填 `wss://59.110.149.11/relay/host`（wss:// 前缀）→ 开 relay_enabled 开关。截图存 `acceptance/desktop/relay-*.png`（截图零凭据——界面本身不显示 credential）。
- computer-use 不可用/UI 形态与预期不符 → 停手上报（勿改码勿直写库）

### ④ R-B1 正式化 + R-B3 host 腿（M3-C 门槛证据）
- R-B1 双证据：①`openssl s_client -connect 59.110.149.11:443 -CAfile <ca.pem>` → Verify return code 0(ok)；②`https://59.110.149.11/v1/health` → 200 且 `upstream.connected=true`（relayClient 出站连上后 ECS 侧自动翻真）
- R-B3 host 腿：保持 ≥5 分钟零断连——UI relay 运行态行 connected/hostId=3 + ECS `journalctl -u devhub-relay --since <启动时刻>` 零 error + relay_hosts id=3 last_seen_at 持续刷新（观测两次间隔 ≥2min）
- 心跳确认：journal 里 heartbeat/last_seen 活动证据
- 若连接失败：收集 UI 告警行/lastError + journalctl 排查（常见：指纹不匹配/CA 错/凭据失效），修环境物不改码；重试 ≤2 轮后仍失败=四分类上报环境阻塞附全证据

### ⑤ 收尾
- 汇报后 relay 保持启用（M3-C2 依赖）；worktree 清理；零仓内提交（若产生 acceptance 截图，单独 commit 推 `agent/m3c1c-evidence` 或标注未提交）

## 2. 铁律与汇报

- 凭据三零（credential 零打印；ca.pem/指纹公开可写可验）；UI 截图零凭据；绝不 --no-verify
- 汇报四分类+每步证据（ca.pem subject、asar grep、UI 截图路径、R-B1 双证据、R-B3 时长+journal 摘要、relay 终态）
