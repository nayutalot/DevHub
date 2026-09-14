# CERT 批任务书：证书轮换双指纹窗口（Phase A 侦察设计 → 主控裁决 → Phase B 实现）

> 背景：ECS relay 证书 notAfter **2026-12-04**，轮换须在 **2026-11-20 前开双指纹窗口**（HANDOFF §5 遗留）。三消费面：①App（pin-TM，用户手填指纹，真机实证「不填=Trust anchor not found」）；②桌面 host-leg wss（信任机制待侦察）；③**桌面 updater feed（X11 实证 `net::ERR_CERT_AUTHORITY_INVALID`——Chromium net 栈不信任自签 IP 证书，updater 静默检查现在就撞墙）**。候选解法已登记：Electron `session.defaultSession.setCertificateVerifyProc` 应用级 pin（不污染系统信任库、零 http 降级）——是否采纳由 Phase A 定。基线 main=fa10681。

## 0. 工作区与纪律

- worktree：主仓根 `git worktree add worktrees/cert-dual -b agent/cert-dual main`；`npm install`（Phase B 才需要）。
- SSH 只读侦察配方：`ssh -i ~/.ssh/devhub_ecs root@59.110.149.11`（Phase A 只读；**Phase B 的 ECS 写操作=仅生成/暂存新证书，绝不部署、绝不动在役证书与 caddy**）。
- 每 commit 即 push 分支（直连 `git -c http.proxy= -c https.proxy= push` 优先，socks5h://127.0.0.1:1081 兜底）；绝不 push main；绝不 --no-verify；凭据三零（指纹/公钥可入册，**私钥零落仓零入日志**）。

## 1. Phase A：侦察+设计（先文档，产出即停等裁决）

1. **现状实证（每条带 文件:行号）**：ECS 证书形态（openssl 看 SAN/有效期/自签或 CA 链/key 类型；caddy 挂载点）；App 侧 pin 实现（指纹字段存储/pin-TM 校验文件）；桌面 host-leg wss TLS 信任机制（为何 Node 侧能连自签——pin/CA 注入/拒绝策略？）；updater feed TLS 面细节。
2. **设计书**（docs/ 新章）：双指纹窗口方案——App 信任集形态（第二指纹录入 UI？字段迁移？）、桌面 feed 信任解法（setCertificateVerifyProc pin vs 其他候选，列权衡）、host-leg 是否需改、ECS 续期操作流程（生成/暂存/备份/回滚/部署时点）、**时间窗排程**（App 双指纹版发布 → 用户装机 → 11-20 前开窗 → 12-04 前轮换）。
3. **决策点显式列出**（信任集形态/feed pin 采纳/新证书是否同 CA/是否顺带换 RSA→ECDSA 等），每点选项+推荐+理由，**交主控裁决不代答**。
4. 产出 commit 推分支后**汇报即停**——主控裁决后再继续 Phase B。

## 2. Phase B（裁决后）：实现

1. App 双指纹信任+单测；2. 桌面 feed 信任解法+单测（fake 证书夹具，零真网络）；3. ECS 生成新证书**暂存**（/root/cert-rotation-staging/，0600，含 sha256 指纹入册——绝不触碰在役证书/caddy）；4. 门禁全绿（桌面 typecheck+fast〔基线 121〕+build；:app/:core〔基线 146/301〕）；5. 边界：在役 relay 证书/caddy 配置零改动、OverlayApp 零触碰、不出 APK（最终待装件另批）。

## 3. 汇报

Phase A：证据链+设计要点+决策点清单。Phase B：commits/门禁数字/暂存指纹/E2E 证据/偏差如实。
