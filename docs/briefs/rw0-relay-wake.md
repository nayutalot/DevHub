# RW0 任务书：RemoteWake——Relay 原生「唤醒 Windows」帧 + Pi SSH 执行器

> 需求（用户 2026-09-09 深夜）：手机 App 远控树莓派发 WoL 魔术包唤醒 Windows。
> 系列代号 RW。本批=RW0（ECS Relay 侧）；RW1（App 侧）门控 M3-E1 合并后另发。
> 执行者：omni-agent，worktree `F:/Active_Project/DevHub-worktrees/rw0`，分支
> `agent/rw0-relay-wake`（从 main 切出）。本任务书自包含。

## 0. 已实测事实链（主控 2026-09-09 深夜，勿重复考古）

- **拓扑**：App ↔ ECS Relay（443 WSS，设备鉴权=relay_devices token，docs/18 十六帧协议）
  ↔ Windows 桌面（WS 常驻）。**树莓派经反向 SSH 隧道挂到 ECS `127.0.0.1:2222`**
  （Pi→ECS 以 root+密钥 xxYsOyju 登录维持 `-R 2222:localhost:22`，systemd/autossh
  托管，重连自愈；**Pi 自带 WiFi 上联**（192.168.31.x 网段家庭路由），不依赖
  Windows——PC 关机后隧道存活，链路成立）。
- **Pi 侧**：用户名 `Raspberr5`（注意大小写）；`192.168.137.50`=其有线口，网线
  直连 Windows I226-V 网卡（Windows 侧 192.168.137.1，ICS）。wol 工具已装（用户
  陈述；具体是 wakeonlan/wol/ether-wake 未验——**执行器三者按序探测**，env 可覆盖）。
- **Windows 目标 MAC**：`B0:82:E2:4B:1A:81`（I226-V）。Windows 侧 WoL 驱动已全开
  （WakeOnMagicPacket=1 + **WakeOnMagicPacketFromS5=1** + S3 可用无 S0 干扰）。
- **ECS→Pi 认证**：ECS `/root/.ssh/id_ed25519`（密钥在 ECS 本机磁盘，0600）。
  **注入 Pi authorized_keys 一步被 Pi 密码阻塞（主控已试 Raspberr5/raspberry5/pi
  ×raspberry/Raspberry 全拒）**——执行器必须把「SSH 认证失败」作为一等结构化
  错误面（pending-key 状态），不能掩盖；密钥注入由主控在用户补凭据后完成。
- **ecs-relay 服务**：Node TS（`ecs-relay/` 目录自含包，97 测试；部署=/opt/devhub-relay
  + systemd devhub-relay.service + EnvironmentFile /etc/devhub-relay/env；现有监听
  443(WSS caddy 前置)/8443/7500(frps)）。**ECS 纪律：凭据零入仓零日志**；env 文件
  是唯一配置注入点。

## 1. 设计裁决（主控定，docs/18 增补为本批交付）

1. **新帧对（relay 原生，绝不转发桌面）**：`wake_host`（App→Relay 请求）/
   `wake_result`（Relay→App 应答）。命名/字段风格逐字对齐 docs/18 既有帧（requestId
   §3.11 语义沿用）。**桌面离线不是错误**——该帧在桌面 WS 不在线时正是主用例。
2. **执行链**：Relay 收帧（设备已鉴权会话）→ 快路径：若桌面会话在线 →
   `wake_result{status:'already_on'}` 零执行；否则 spawn `ssh -p <port> <user>@127.0.0.1
   -i <key> -o BatchMode=yes -o ConnectTimeout=5 'wakeonlan <MAC> || wol <MAC> ||
   ether-wake <MAC>'`（**参数数组零 shell 拼接**，MAC 严格 `^[0-9A-Fa-f:]{17}$`
   校验，port/user/key/MAC 全部来自 env，仓库零硬编码）→ 按 exit code/输出映射
   `sent` / `ssh_auth_failed` / `ssh_unreachable`（隧道死）/ `wol_tool_missing` /
   `unknown_error` + latencyMs。
3. **安全**：仅已鉴权设备会话可发；每设备限速（默认 15s 冷却，env 可调）；审计行
   落 relay 库（沿用既有 security/audit 表风格，含 deviceId/status/latency）；
   rate-limit 超限回 `rate_limited` + retryAfterMs。
4. **env 增项**（/etc/devhub-relay/env，部署时主控加，代码只读 env+缺省禁用）：
   `WAKE_ENABLED=0|1`（缺省 0——未配置即整帧回 `disabled`）、`WAKE_TARGET_MAC`、
   `WAKE_PI_SSH_PORT=2222`、`WAKE_PI_SSH_USER=Raspberr5`、`WAKE_PI_KEY_PATH=/root/.ssh/id_ed25519`、
   `WAKE_COOLDOWN_S=15`。
5. **测试**：ecs-relay 既有 97 测试全保 + 新增（fake child_process/注入式 exec，
   覆盖：already_on 快路径/全错误映射/限速/审计/env 校验/MAC 校验拒绝）；
   **真实 SSH 路径不在单测范围**（密钥注入未完成，e2e 留主控）。

## 2. 交付物清单

1. `ecs-relay/src/`：wake 帧处理 + 执行器模块（electron 无关的纯 Node；SSH spawn
   用注入式 runner 便于测试）；帧注册进协议分发（对齐既有 16 帧接线位）。
2. `ecs-relay` 测试：上述新增用例，计数就地更新（97→97+N）。
3. `docs/18-ecs-relay-protocol.md`：新帧对小节（帧表 +1 行组、时序、错误枚举、
   安全语义、env 清单）——**纯追加**。
4. `docs/04-ipc-api.md` 不动（这是 relay 协议非桌面 IPC）。桌面侧零改动。
5. 部署脚本/说明：`ecs-relay/deploy/` 下补 env 模板行 + systemd 无需变更声明；
   **实际部署由主控执行（review 后），你不 SSH**。

## 3. 完成定义

1. `cd ecs-relay && npx tsc --noEmit`（或包内等价 typecheck）0 error；
2. `npm test`（或既有测试命令）全过含新增；3. 红线自查：凭据零字面量（env 名可以，
   值不行）、参数数组无 shell 拼接、审计与日志无 key/token；4. 最终消息：commit
   列表+测试摘要+偏差清单+「主控部署 checklist」（env 行内容+重启命令+验证帧手工
   测试法）。

## 4. 纪律

增量提交每 commit 即 push origin agent/rw0-relay-wake；不 merge 不 push main；
不 SSH/ECS；不动主仓与其他 worktree；不可调和冲突停下上报。
