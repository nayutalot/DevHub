# DevHub 会话交接文档（2026-09-06 晨，M3-A 收官·M3-B 就绪·等 S1）

> 交接范围：项目重建 → Phase 1 → MCP → 并库 S1-S6 → AC0-AC9 → ECS+frp → UX R1-R11 → 夜间迭代 → IP TLS 裁决 → M2 三批收官 → **M3-A 部署+验收线③闭环（本会话）+ M3-B 服务端就绪 + P0a/P0b 落地 + dist 重打包**。新会话按本文档续接。

## 1. 当前状态一句话

**ECS Relay 已在 59.110.149.11 上生产就绪**：devhub-relay 服务（127.0.0.1:8443）+ 自签 IP TLS + Caddy 443 反代全部部署验证通过（服务端本地 R-B1 等价 200/WS 101/TLS1.3）；R2 验收线③（64 连压测+优雅停机+零丢失）真机闭环；桌面常驻已换含 relayClient 的新包。**唯一挡在 M3-C 联调前的 = S1 安全组 443 规则（用户控制台操作）**——加了它就能跑 R-B1..R-B9 全表。

## 2. 协作模式（用户铁律，滚动有效）

- 主控只 plan/review/merge，**执行一律派 omni-agent（含部署运维和排障——2026-09-06 用户当场纠偏）**；一 Agent 一 Worktree 一任务，机器资源登记互斥，主控独占 merge
- 增量提交接力（配额中断应对）；GitHub 增量推送纪律（子代理每 commit 即 push 分支；主控合并即 push main；汇报带分支+SHA；失败不无限重试）
- 端口铁律：smoke 需 8746-8755 空闲——跑前 taskkill DevHub.exe，跑毕恢复+curl 200；测试桩用段外端口
- mcp-acceptance 先 commit 树净（A12 会被未跟踪文件打挂——任务书也要先入册）
- 契约先行+fixture 对拍；任务书落盘 docs/briefs/；自主长跑：仅用户明示授权、红线不豁免、四分类收尾
- 排障任务书必须携带主控已查明的事实链（子代理从结论续做）；**ECS SSH：`ssh -i ~/.ssh/devhub_ecs -o BatchMode=yes root@59.110.149.11`（密钥直连；root 密码从未使用、勿用；加固收口时会禁密码登录）**

## 3. 本会话 M3 战果台账

| 批次 | 结果 |
| --- | --- |
| M3-A 部署（主控执行，已被纠偏） | Node 22.23.2+服务用户+systemd+127.0.0.1:8443+selfcheck 59/59 |
| M3-A⑤ loadtest 整改（agent/m3a-drill-fix→c86afe2） | ⑤ 客户端持续读者重写+hostOnline 写入竞态武装兜底+Caddyfile 三缺陷回写+探针退役 |
| M3-B TLS 装载（纯 ECS 态，无仓内分支） | 证书 SAN 验证过；**SPKI=`sha256/a07f7ab77bc2f21ba8d5e868cad30156d721aa11a8b85843973575a672aa50d0`；notAfter=2026-12-04（双指纹窗口 ≤2026-11-20 启动）**；Caddy 2.6.2 active 443 监听、80 关闭；本地 curl --cacert 200/WS 101/401 鉴权路径 |
| M3-A⑥ 活跃性修复+P0a（agent/m3a-liveness→362feac） | **终极根因三连修**：①TestWsClient/自检 WsClient 超时 waiter 泄漏（静默吞帧真凶）②服务器 hostOnline 僵尸窗口（TCP keepalive 5s 根治+重发路径同步 queued ack+武装帧保留）③证书日历 selfcheck 项（<14 天 FAIL）。ECS：selfcheck **64/64**、loadtest ×2 绿、**RSS 108.6/108.8MB**、竞态→重发→立即 queued:true 闭环 |
| M3-P0b smoke 分层（agent/smoke-tiers→7aeb736） | fast 80/full 84、append-only、fast 实测 27.4s、`npm run smoke:fast` |
| dist 重打包（无仓内提交） | 新包含 relayClient（asar 字符串级证据）；旧版备份 `dist/win-unpacked.bak-20260906`；常驻 health 200；relay_enabled 默认关 |
| 统一门禁（main 每次） | tsc 0 / smoke 164/164 / mcp 27/27 / build 绿 |

**main = 98910cb**（已推 GitHub）；本地+远端无残留分支/worktree。

## 4. 项目事实基线（main @ 98910cb）

- 门禁基线：tsc 0 / smoke **164**（fast 80/full 84，27.4s/207s）/ mcp 27/27 / :core 167 / assembleDebug；白名单 70；MCP 16 tools；migration 005（user_version=5）
- ecs-relay 自测：node --test **83**/selfcheck **64**（ECS root 跑）/loadtest 全绿
- 常驻=新打包版（relayClient 在包内、relay 未启用）；ECS：devhub-relay 8443 + caddy 443 + frps 兼容通道照旧
- 公网通道现役仍 frp(8746)；**443 服务端就绪，等 S1 放行**

## 5. 下一步（S1 后的 M3-C 编排，docs/briefs/m3-deploy-plan.md §5）

1. **用户控制台：S1 加 443/tcp**（80 保持关）——唯一硬阻塞
2. S1 后立即派：公网 R-B1（curl --cacert 外网 200）+ host 首装注册（注册码在 ECS `/etc/devhub-relay/env`，远端管道用、零打印；credential 落 `%LOCALAPPDATA%\DevHub\relay\credential`）+ relayClient 指纹配置（SPKI 见 §3）+ relay_enabled 启用联调
3. M3-C：R-B1..R-B9 全表+TLS 三拒（错误证书/指纹/过期）∥ M3-C2 R5.3 事件驱动刷新 ∥ R3 信标遗留（upstream:disconnected 真帧截图）
4. M3-D：72h 稳定 → M4 P1-P4（SG 动作全为用户人工）
5. ECS 加固收口（四建议之一）：等用户**固定管理 IP** → 确认密钥可登→禁 root 密码→22 限源→3389 残留核查（docs/ecs-security-group-policy.md）

## 6. 遗留与待用户

1. **S1 443/tcp 规则（控制台）——M3-C 唯一门槛**
2. **固定管理 IP**——22 收缩+ECS 加固收口用
3. 知情项：ECS relay_hosts 有 2 行 dormant 临时记录（凭据已弃，无安全影响，M3-C 可顺手清）；ECS selfcheck 证书项需 root 跑（或 M3-B 目录 o+x，未动）；dist 旧版备份 389M 在 `dist/win-unpacked.bak-20260906`（确认新版稳定后可删）
4. docs/21 既有三项（FCM/Kimi 真机/hooks）不阻塞；delivery 聚合语义小裁决仍挂
5. 旧已知项：relativeTime 中英混排、ZCode approval 判定源未实测、DeepSeek 未接入
6. Mimosa hook 持续报扫描结论不完整——不宣称项目安全，深审归用户

## 7. 关键约束速查

28 条合同（docs/00）+ docs/11-21 + docs/briefs/*（含 m3-deploy-plan v2）；exec.ts 唯一 spawn；SQL 绑定；migration append-only；ecs-relay/ 子目录自含；android 工程禁挪走；私钥/凭据零入仓库/日志/审计；ws:// 明文仅限 docs/19 §11 时间盒。
