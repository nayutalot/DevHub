# M3-A⑥ 批任务书（服务器活跃性修复 + P0a 证书日历，含 ECS 重部署）

> 依据：M3-A⑤ 批的 pcap 级根因定位（其汇报存档；本任务书 §1 已浓缩）。主控已定修复方案，按案实施勿改设计。
> 基线：main @ 7aeb736。工作目录主仓 `F:\Active_Project\DevHub`，分支 `agent/m3a-liveness`（自 main 创建）。**只动 `ecs-relay/`**。

## 0. 占用资源清单（机器资源登记）

- 本地：ecs-relay 自含门禁（node --test 随机端口），**不占 8746-8755、不碰 DevHub.exe**（并行 dist 批在管常驻，你别动它）
- ECS 59.110.149.11：SSH `ssh -i ~/.ssh/devhub_ecs -o BatchMode=yes root@59.110.149.11`（**任何密码绝不出现**）；可操作 /opt/devhub-relay + `systemctl restart devhub-relay`；**绝不碰** caddy 单元（M3-B 批成果）、frps、安全组

## 1. 根因回顾（A⑤ 批已实证，信任勿重查）

1. host socket 死亡（RST）后，**空闲事件循环不处理 close 事件**——本地实测 ≥15s、ECS ≥5s，窗口内 `hostOnline` 恒真（有流量刺激则 2-3ms 翻转）
2. `forwarder.ts` 排队态重复命令路径（约 392-404 行）：`sendToHost(僵尸)` 同步返回 true → **删除武装帧 + 审计 replayed + 不给设备任何 ack** → 设备重发也石沉大海
3. 表现：loadtest ⑤ 重发后 30s 无 ack（首发竞态已由 3341fb0 武装兜底覆盖，重发路径是新洞）

## 2. 修复方案（主控裁决，逐项实施）

### 修 1：重发路径同步 queued ack + 保留武装帧
`handleCommand` 排队态重复命令分支（existing.status==='queued' 且 hostOnline 且内存帧在）：
- `sendToHost(memory.frame)` 返回 true 时**不再删武装帧**（僵尸写兜底：真送达后 host 回执会经 handleHostCommandAck 清武装，已有逻辑）
- **并且无论 sendToHost 真假，都同步 `ackToDevice(deviceId, {type:'command_ack', requestId, idempotencyKey, status:'accepted', queued:true})`**——幂等且真实（命令此刻确实处于排队等待态；docs/18 §3.9 queued:true 语义）
- **前置核验**：先读 `src/main/services/agentControl/relayClient/commandDownlink.ts`（主仓，只读！）确认 R1 客户端对"多次 command_ack（先 queued 再 host 真回执）"的容忍性；若 R1 会因重复 ack 出错，停下来上报你的发现与替代建议，勿硬改
- selfcheck 新增用例：僵尸窗口内重发 → 设备收到 queued:true（可用 A⑤ 的确定性复现手法：destroy 后立即重发，不等 hostOnline 翻转）

### 修 2：TCP keepalive 根治僵尸窗口
ws.ts RelayConnection 构造（或 server.ts completeUpgrade）：对 socket 启用 `setKeepAlive(true, 5000)`（initialDelay 5s；Linux 默认间隔/次数即秒级探测）。RST 死连接将由内核探测浮出 error→close→hostOnline 翻转，不再依赖事件循环活跃度。
- 验证用例（selfcheck 或独立确定性复现）：destroy host → 无任何流量 → hostOnline/`upstream.connected` 在 ≤15s 内翻转（修复前本地 ≥15s 不翻转）；有条件的话连进 /v1/health 观察 upstream.connected

### 修 3：P0a 证书日历
`src/selfcheck.mjs` 新增检查项"证书剩余有效期"：
- 证书路径 env `RELAY_CERT_PATH`，默认 `/etc/devhub-relay/tls/server.crt`；文件不存在 → 该项 SKIP（输出注明，不算失败——开发机无证书）
- 解析 notAfter（node crypto X509Certificate 或 openssl 子调用均可）：剩余 **<14 天 → 该项 FAIL（退出码非 0）+ 醒目输出到期日**；≥14 天 → PASS 输出剩余天数
- 本地测试：node --test 用临时生成证书三档断言（1 天 FAIL / 13 天 FAIL / 30 天 PASS）——临时证书用 openssl 生成后清理

## 3. 门禁与部署（顺序）

1. 本地：`node --test`（76+新增）全绿；`npm run selfcheck`（59+新增项，开发机证书项 SKIP）全绿；`npm run loadtest` ×2 全绿（⑤ 现在：首发竞态→重发→**立即** queued:true）
2. 增量提交+每次 commit 后 `git push origin agent/m3a-liveness`
3. ECS：tar 上传 src+scripts → chown → restart → is-active + health 200 → selfcheck 全绿（证书项读真实证书，notAfter 2026-12-04 应 PASS 并输出剩余天数）→ loadtest 全绿（记 ⑥ RSS 数字）
4. 确定性复现验证 keepalive 生效：destroy host 后 idle 等 ≤15s，`/v1/health` 的 upstream.connected 翻转（把翻转耗时写进汇报）

## 4. 铁律与汇报

- 只动 `ecs-relay/`；R1 客户端代码只读；绝不 --no-verify；并行 dist 批在管 DevHub.exe，零触碰
- 汇报四分类，必带：分支+SHA、各门禁数字（含新增用例数）、ECS selfcheck/loadtest 数字+RSS、keepalive 翻转耗时、R1 容忍性核验结论、推送状态
