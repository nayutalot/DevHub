# M3-C1 批任务书（host 首装注册 + relayClient 公网接线 + R-B1/R-B3 host 腿）

> 前提已实测：S1 已开——本机 openssl -CAfile 验证链 0 (ok)、HTTPS https://59.110.149.11/v1/health 公网 200（ca.crt 已取回本地 /tmp/devhub-relay-tls/ca.crt，公开物料）。
> 目标：Windows relayClient 真实连上公网 Relay（R-B1 正式化 + R-B3 host 腿 ≥5 分钟零断连），为 M3-C2/C3（App 联调+TLS 三拒）铺轨。

## 0. 占用资源清单（机器资源登记）

- **DevHub.exe 常驻**：可能需要重启（接线后生效验证）——操作前确认无并行批占用；重启后 curl 8746 health 200
- **ECS 59.110.149.11**：SSH `ssh -i ~/.ssh/devhub_ecs -o BatchMode=yes root@59.110.149.11`；只做注册 curl（在 ECS 本机执行，注册码零外泄）与 relay_hosts dormant 行清理（`DELETE FROM relay_hosts WHERE id IN (那两行)`——先 SELECT 确认）；**绝不碰** caddy/frps/安全组/devhub-relay 代码
- 本地凭据文件 `%LOCALAPPDATA%\DevHub\relay\`：credential/指纹（0600，不入仓库/日志/汇报）
- 不改仓内代码（若发现必须改码才能启用，停下上报——那是新批次的活）

## 1. 任务

### ① host 首装注册（注册码不出 ECS）
在 ECS 上执行注册（远端管道，注册码不回显不落盘）：
```
ssh ... 'source /etc/devhub-relay/env && curl -s --cacert /etc/devhub-relay/tls/ca.crt -X POST https://59.110.149.11/relay/host -H "Authorization: Bearer $RELAY_REGISTRATION_CODE" -d "{\"hostName\":\"main-desktop\"}"'
```
→ 201 {hostId, credential}。**credential 不打印**：直接经 SSH 管道写入本地 `%LOCALAPPDATA%\DevHub\relay\credential`（权限最小化；格式先读 R1 代码确认——见 ②）。

### ② relayClient 接线（先读码再动手）
只读 `src/main/services/agentControl/relayClient/config.ts`（主仓 main=527a464），确认三件事的**确切消费形态**：
- credential 文件路径与 JSON 形状（hostId/credential 字段名）
- 指纹配置文件路径与格式（`sha256/...`；双指纹数组形态？）——写入 SPKI：`sha256/a07f7ab77bc2f21ba8d5e868cad30156d721aa11a8b85843973575a672aa50d0`
- relay_enabled/relay_endpoint 两个 settings 键的合法值形态与**设置通道**（IPC 面？MCP settings 工具？桌面设置 UI 是否已有 relay 字段？）
然后按码接线：写 credential、写指纹、设置 relay_endpoint=`wss://59.110.149.11/relay/host`、relay_enabled=1。**设置通道调查清楚再动**：优先 IPC/MCP 正规通道；无通道则上报"需 Windows 设置 UI/IPC 扩展批"（不擅自直写活库——真库写红线）。

### ③ R-B1 正式化 + R-B3 host 腿
- R-B1：`openssl s_client` 验证链 0(ok) + health 200 JSON 里 `upstream.connected=true`（接线成功后自动为 true）——两证据都进汇报
- R-B3 host 腿：relayClient 出站 wss 保持 ≥5 分钟零断连（观察日志/诊断面 gatewayStatus.relay 投影；心跳 tokenVersion 确认）；期间 ECS `journalctl -u devhub-relay` 无 error
- 顺手：清 relay_hosts 两行 dormant（§0），清后 selfcheck 不受影响确认

### ④ 汇报后状态
relay 保持启用（M3-C2 App 联调要用）；若你判断有风险（如常驻 CPU/异常日志），如实标注。

## 2. 铁律

- 凭据三零（零打印/零入库/零入日志）；注册码零出 ECS；绝不 --no-verify（本批无仓内提交，若迫不得已改码=停手上报）
- 失败重试 ≤2 次换路径；四分类汇报：必带注册结果（hostId 可报，credential 不可）、三件接线物的落盘路径与格式出处（config.ts 行号）、R-B1 双证据、R-B3 时长与零断连证据、设置通道调查结论、dormant 行清理确认
