# M3 集成联调与验收 —— 批次规划（主控草案 v1，2026-09-05）

> 权威依据：docs/20 §1（M3/M4 判据）、§3（R-B1..R-B9 验收表+TLS 三拒专项）、§4（G8 P1-P4 迁移编排）、
> `docs/ecs-relay-deploy/`（证书/反代/指纹物料）、`docs/ecs-security-group-policy.md`（S0-S6 人工操作）。
> 本文只做**批次编排与派发拆分**，验收判据以 docs/20 为准，不复制。
> HANDOFF §5.3 四项技术建议（用户已认可 2026-09-05）已全部编入：ECS 加固收口→M3-B 窗口；
> 证书日历→M3-P0a（本地先行）；R5.3→M3-C 并行批；smoke 分层→M3-P0b（本地先行）。

## 0. 批次总览与依赖

```
M2 合入完成（R1+R3 已并 main）
 └─► [本地先行批，零 ECS 依赖，可立即派]
      M3-P0a 证书日历（ecs-relay selfcheck 增强）
      M3-P0b smoke 分层（快速档/全量档）
 └─► [部署批，需用户授权 ECS SSH 会话]
      M3-A 服务部署（含 R2 验收线③ 部署演练）
      M3-B TLS 上 443 + ECS 加固收口（需用户：S1 控制台操作 + 固定管理 IP）
 └─► [联调批]
      M3-C 双端 wss 联调 R-B1..R-B9（含 TLS 三拒） ∥ M3-C2 R5.3 App 事件驱动刷新收尾
 └─► M3-D 72h 稳定期（T2）→ 达成后进 M4（P1-P4 按 docs/20 §4 编排，另出任务书）
```

## 1. M3-P0a 证书日历（本地代码批，worktree：agent/ecs-relay-server 或短任务直接主控派 omni-agent 独立 worktree）

- **任务**：ecs-relay `selfcheck.mjs` 新增检查项——读取部署证书（`/etc/devhub-relay/tls/server.crt` 或 `CERT_PATH` 环境变量指定），剩余有效期 **<14 天 → WARN 且 selfcheck 退出码非 0**（或按现有 selfcheck 告警分级惯例），绝不靠人记（PR4 风险缓解）。
- **实现要点**：openssl notAfter 解析或 node crypto X509Certificate；本地测试用临时生成证书（一天期/十三天期/三十天期三档断言）；`node --test` 全绿；不碰 DevHub 主仓门禁（ecs-relay/ 子目录自含）。
- **门禁**：ecs-relay 自测 node --test 全绿 + selfcheck 本地实跑（含新项输出）。

## 2. M3-P0b smoke 分层（本地代码批，谨慎度最高）

- **任务**：`scripts/smoke.mjs` 拆两档——**快速档**（单元/纯逻辑用例，目标 <2min，每批跑）+ **全量档**（Gateway/e2e/端口类，合并时跑）。156+ 基线（M2 合并后以实际数为准）**一条不删**（append-only 铁律）；分层=用例标记/分组，不改用例本体。
- **实现要点**：smoke.mjs 顶部用例注册处加 tier 标记（或分段函数），CLI 参数 `--tier=fast|full`（默认 full 保持现行为）；package.json scripts 加 `smoke:fast`；docs/00 约束面若需注记由主控裁决后补。
- **门禁**：全量档数字与分层前逐用例一致（对拍输出）；快速档实跑 <2min；四门禁全绿。

## 3. M3-A 服务部署（ECS SSH，**需用户授权会话**）

- 上传 `ecs-relay/` → Node 22 环境 → systemd 单元安装 → 只绑 `127.0.0.1:8443` → ECS 上 selfcheck 全绿（含 P0a 证书日历项，若证书未生成则该项跳过并标注）。
- **并入 R2 验收线③ 部署演练**：64 连接压测脚本跑一遍 ≤ 容量预算（docs/19 §5.5）+ 优雅停机零帧丢失（排队命令恢复）。
- 回滚：systemd stop + 目录移除，零残留；安全组零动作。

## 4. M3-B TLS 上 443 + ECS 加固收口（**需用户两项输入**）

- 证书/反代：ECS 上 `gen-ip-cert.sh` → Caddyfile 装载 → reload；`spki-sha256.txt` 指纹分发两端客户端（Windows relayClient 指纹配置 + App 注入式 TlsPinningConfig）。
- **用户操作①（控制台）**：S1 新增 443/tcp 规则（policy §4）；80 永久保持关闭。
- **ECS 加固收口（四建议之一，全人工/授权操作，policy 文档步骤）**：确认密钥可登 → 禁 root 密码登录 → 22 收缩固定管理 IP（**用户操作②：提供固定管理 IP**）→ 核查 3389 规则残留。
- 判据：R-B1（curl --cacert 200，upstream.connected=true）+ deploy README §5 验收表 1/2/6/7 项。

## 5. M3-C 双端联调（含 TLS 三拒）∥ M3-C2 R5.3 收尾

- **M3-C**：Windows relayClient 出站 wss + 真机（或模拟器先行）App relay 模式 → R-B1..R-B9 全表（docs/20 §3），**R-B6 断链补发必跑**（frp 版欠账）、R-B9 TLS 三拒专项（错误证书/错误指纹/过期证书三拒 + 双指纹窗口任一通过）。
- **M3-C2（并行 worktree 批）**：R5.3 App WS 事件驱动刷新补完（现轮询兜底为主→事件驱动为主），联调窗口内真机体感验证。
- 模拟器先行、物理真机复跑（真机 GMS/FCM 待用户项不阻塞本批——推送缺口 known-limitations §4.1 延续）。

## 6. M3-D 稳定期 → M4 门

- R-B1..R-B9 全过 + **72h 稳定无回退（T2）**记录（心跳/断连/丢帧巡检脚本或日志抽样）。
- 达成 → M4 P1-P4 按 docs/20 §4 另出任务书（P3 观察两周、P4 撤 8746/7000+S2-S6 收敛——SG 动作全为用户控制台人工）。

## 7. 待用户清单（不代答，只排队）

1. **ECS SSH 部署会话授权**（M3-A/M3-B 主控可代办的操作范围）
2. **S1 控制台操作**（443/tcp 规则）+ 时机
3. **固定管理 IP**（22 收缩用）
4. docs/21 既有三项（FCM 分期/Kimi 真机 managed/Claude hooks）——不阻塞 M3 前中期
5. delivery 聚合"全设备 vs 仅活跃"语义小裁决（HANDOFF §6.3）

## 8. 风险与红线速查

- 动阿里云安全组=用户控制台人工，主控/agent 绝不自动改（docs/00+审计铁律）
- 私钥/凭据零入仓库/日志/审计；`ws://` 明文仅限 docs/19 §11 时间盒
- 并行批资源登记：M3-C 占真机/模拟器+公网 443；M3-C2 占模拟器需错峰或共用协调
- smoke 分层若与后续批次冲突，分层批让路（它是"择机"项，docs/20 §5）
