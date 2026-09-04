# 隧道配置指南（双方案：A = NatPierce / B = ECS + frp，推荐 B）

> 本文初版随 AC8 批次成文（NatPierce，现方案 A）；AC9 批次按母智能体规格复核
> 补全（新增 Windows `setx` 系统级 / `set` 会话级设置示例，§3.1），并对照代码
> 实况逐条核实。2026-09-04 隧道批次新增**方案 B：ECS + frp（推荐）**（§7），
> 已实测端到端（见 `acceptance/agents-mobile/ac8-blocked.md` §5）；NatPierce
> 内容原样保留为方案 A。两方案同属 L5 第三方隧道，对 DevHub 而言边界完全一致
> （docs/15 §8：只传输不替代鉴权，凭据外置）。
> 变量命名与三态投影行为以代码实况
> `src/main/services/agentControl/natpierce.ts` 为准（AC9 批次复核一致：
> `NATPIERCE_ENDPOINT` / `NATPIERCE_ACCOUNT` / `NATPIERCE_TOKEN`，见
> `NATPIERCE_ENV_KEYS` 常量）。网关端口默认 8746 以
> `gateway/httpServer.ts` 的 `GATEWAY_DEFAULT_PORT` 为准（AC9 复核一致）。

## 1. NatPierce 在 DevHub 中的角色（边界，先读）

NatPierce 是 **L5 第三方隧道**，DevHub 对它的全部预期只有一件事：**把你桌面端
的 Remote Gateway（默认 `127.0.0.1:8746`）透传到公网，让外网手机能连上来**。

三条不变式（docs/15 §8 零改动引用）：

1. **只传输，不替代鉴权。** 隧道只是 TCP/HTTP 透传。手机连上来之后，应用层的
   安全全部照旧生效：设备 Bearer Token（桌面只存哈希）+ 防重放
   （`X-DevHub-Timestamp` ±300s 窗口 + `X-DevHub-Nonce` 10 分钟 LRU 去重）+
   授权矩阵 + 能力验证门 + 指令 300s TTL。NatPierce 不持有、看不到、也不需要
   任何 DevHub 凭据。
2. **DevHub 不启动、不安装、不修改 NatPierce。** 隧道进程由用户自己运行。
   DevHub 只做两件事：读你外置的环境变量做「配置齐备性」投影；对 endpoint 做
   一次出站健康探测（`reachable` 布尔，3s 超时、60s 缓存）。
3. **凭据外置。** endpoint/account/token 只从环境变量读取，绝不入仓库、绝不入
   settings 表、绝不入日志；DevHub 的任何投影（`agents:gatewayStatus` /
   `/v1/diagnostics`）只输出 `configured` / `reachable` 布尔与「只含变量名的
   hint」文案，零配置值。

## 2. 你需要自备什么

- 一个可用的 NatPierce 服务端地址（公网可达的 endpoint URL，`http://` 或
  `https://`）；
- 该服务上的账号（account）；
- 该服务签发的访问凭据（token）。

三者全部由你自己向 NatPierce 服务方获取，DevHub 不代理、不代办。

## 3. 环境变量清单（与 `natpierce.ts` 实现逐字一致）

| 变量名 | 含义 | 示例形态 |
| --- | --- | --- |
| `NATPIERCE_ENDPOINT` | 隧道服务端地址（`http://` 或 `https://`，仅此两种协议） | `https://np.example.com` |
| `NATPIERCE_ACCOUNT` | NatPierce 账号标识 | — |
| `NATPIERCE_TOKEN` | NatPierce 访问凭据 | — |

三态投影（`agents:gatewayStatus` 的 `natpierce` 字段，`computeNatPierceStatus`）：

- 三者全未配置 → `{ configured: false }`（与 AC2 契约形状逐字节一致，smoke
  ac2-87 deepEqual 锁定）；
- 部分配置 → `configured: false` + `hint`（hint 只列缺失的**变量名**，绝不包含
  任何值）；
- 三者齐备 → `configured: true`，且 `reachable` 由对 `NATPIERCE_ENDPOINT` 的
  一次 `GET` 健康探测给出（任意 HTTP 状态码都算「可达」；3s 超时；结果缓存
  60s；endpoint 未配置时零出站）。

读取规则（`readNatPierceConfig`）：值经 trim；空串视同未配置。

### 3.1 设置方法（Windows）

**方式 A：系统级永久（`setx`，写入用户环境变量，设置后需重启 DevHub 生效）**

```bat
setx NATPIERCE_ENDPOINT "https://np.example.com"
setx NATPIERCE_ACCOUNT  "<你的账号>"
setx NATPIERCE_TOKEN    "<你的凭据>"
```

> `setx` 不影响当前已打开的终端会话；重启 DevHub（从新进程继承环境）后生效。

**方式 B：会话级临时（cmd `set`，仅当前终端及其子进程可见，关窗即失效）**

```bat
set NATPIERCE_ENDPOINT=https://np.example.com
set NATPIERCE_ACCOUNT=<你的账号>
set NATPIERCE_TOKEN=<你的凭据>
```

在该终端里启动 DevHub 即可让本进程读到（适合先试通、再落永久）。

**方式 C：PowerShell 用户级永久**

```powershell
[Environment]::SetEnvironmentVariable('NATPIERCE_ENDPOINT', 'https://np.example.com', 'User')
[Environment]::SetEnvironmentVariable('NATPIERCE_ACCOUNT',  '<你的账号>',           'User')
[Environment]::SetEnvironmentVariable('NATPIERCE_TOKEN',    '<你的凭据>',           'User')
```

验证：DevHub → Agents 视图 → 网关状态（或手机 诊断 页 `GET /v1/diagnostics`）
看 `natpierce.configured / natpierce.reachable`。

安全提醒：`set`/`setx` 过的值会留在终端历史与注册表用户环境里，属你本机自有
面；**任何时候都不要把这三个值写进仓库文件、settings 表或任何日志**（§5）。

## 4. 如何把本机 127.0.0.1:8746 经隧道暴露给手机

以「NatPierce 客户端把本地端口映射到服务端」的通用形态为例（具体参数以你所用
NatPierce 版本为准）：

1. 桌面端开启 Remote Gateway：Agents 视图 → 网关设置 → 启用（settings
   `gateway_enabled=1`。**默认为 0 = 零监听**，不开启则远程面完全不存在；
   默认端口 8746，可用 `gateway_port` 改，端口占用时按 8747–8755 顺延回退）。
2. NatPierce 客户端添加一条 **TCP/HTTP 透传规则**：本地地址 `127.0.0.1`，本地
   端口 `8746`，映射到你的服务端域名/端口（例如 `https://np.example.com`）。
3. 手机的 App → 网关配置：**填隧道分配给你的地址**（主机 = 隧道地址对应的主机
   名，端口 = 隧道对外端口。**不能**再填 `10.0.2.2`/`127.0.0.1`——那分别是模拟
   器回环映射和手机本机）。保存并连接：若此前已配对，直接重连即可；未配对走
   8 位码配对。
4. 防火墙：DevHub 的 Gateway 只监听 `127.0.0.1` 回环（本机回环绑定），NatPierce
   客户端进程在本机内连它没有问题；**不要**为此在路由器上开任何端口映射。

## 5. 安全要点（每条都是硬约束）

- **凭据零落盘面**：`NATPIERCE_*` 三个变量只放环境变量（或系统密钥服务）；
  不入 git、不入 `settings` 表、不写进任何日志。若在终端里 `set`/`export` 过，
  注意 shell 历史文件。
- **不开路由器端口**：公网暴露的唯一入口是 NatPierce 隧道；任何「路由器端口
  转发直接打 8746」的做法都绕开本文边界，禁止。
- **App 侧仍需配对**：隧道打通 ≠ 能连上。手机必须持有效设备 Token（8 位码
  配对签发，桌面只存 SHA-256 哈希）；未配对设备在鉴权层即被拒（401）。撤销设备
  （`agents:deviceRevoke`）会立即掐断其活跃 WS 连接。
- **透传不加密约束**：若 NatPierce 服务端是 `http://`（非 TLS），应用层 Token
  虽仍有效，但隧道段明文可见——尽量选 `https://` 的 endpoint。
- 防重放窗口依赖手机与桌面时钟基本一致（±300s）；穿越隧道不影响该机制。

## 6. 未配置 NatPierce 时：本地模式照常可用

三个环境变量全空时 DevHub 一切功能不受影响（`configured:false` 只是投影）：

- **同网段**：手机与桌面同一局域网时，App 网关配置直接填桌面内网 IP
  （如 `192.168.x.x`）+ `8746`；
- **Android 模拟器**：App 默认 `10.0.2.2:8746`（模拟器回环映射到宿主机
  `127.0.0.1`）——AC7/AC8 批次的端到端验收即走此路径，无需任何隧道。

AC8 的隧道下端到端与防重放公网回归因无真实凭据**未验证**，具体用例与解除条件
见 `acceptance/agents-mobile/ac8-blocked.md`。

## 7. 方案 B：ECS + frp（推荐，2026-09-04 批次新增并已实测）

### 7.1 架构

```
手机 / 模拟器（DevHub App）
        │  HTTP + WS（公网，明文段——见 7.5 弱点①）
        ▼
阿里云 ECS（公网 IP，例 59.110.149.11）—— frps（systemd 常驻）
        │  7000 控制连接（frp 自有协议 + token 认证）
        │  8746 对外监听（frps 收到连接后经隧道回源）
        ▼
家里 PC（出站反连，无需公网 IP / 不开路由器端口）—— frpc（登录自启常驻）
        │  回环（frpc 在 PC 本机连 127.0.0.1:8746）
        ▼
DevHub Electron（Gateway 绑 127.0.0.1:8746，零代码改动）
```

要点：Gateway 仍只绑 `127.0.0.1`（边界不变，docs/15 §9）；frpc 从 PC **出站**
连 ECS:7000（家庭 NAT 后无需任何入站映射）；ECS 在安全组放行 `7000/tcp`
（仅 frp 控制面）与 `8746/tcp`（对外服务面）。对 Gateway 而言一切经隧道的
请求来源都是 frpc 的回环连接——「隧道不改变任何安全决策」（docs/15 §8）。

### 7.2 ECS 侧：frps 部署概要

> 凭据一律占位符：`<FRP_TOKEN>` = `openssl rand -hex 32` 生成（ECS
> `/etc/frp/frps.toml` 与 PC `frpc.toml` 各存一份，**绝不入仓库/日志/截图**）；
> `<DASH_USER>` / `<DASH_PASS>` 为 dashboard 随机账密。

1. 下载 frp（github.com/fatedier/frp releases，linux amd64）解压至 `/opt/frp/`；
2. `/etc/frp/frps.toml`：
   ```toml
   bindAddr = "0.0.0.0"
   bindPort = 7000
   auth.method = "token"
   auth.token = "<FRP_TOKEN>"
   webServer.addr = "127.0.0.1"   # dashboard 只绑回环，仅 ECS 本地可看
   webServer.port = 7500
   webServer.user = "<DASH_USER>"
   webServer.password = "<DASH_PASS>"
   ```
3. systemd 单元 `frps.service`（`Restart=always`）→ `enable --now`；
4. 阿里云安全组放行 `7000/tcp` + `8746/tcp`；**22 端口建议只对你自己的 IP 开放**；
5. root 密码登录**保持开启、root 密码不改**（防锁死；SSH 建议另装密钥登录）。

### 7.3 PC 侧：frpc 常驻

1. frp windows amd64 解压到机器本地目录 `%LOCALAPPDATA%\DevHub\frp\`
   （`frpc.exe` + `frpc.toml`，**该目录不入仓库**）；
2. `frpc.toml`：
   ```toml
   serverAddr = "<ECS 公网 IP>"
   serverPort = 7000
   auth.method = "token"
   auth.token = "<FRP_TOKEN>"

   [[proxies]]
   name = "devhub-gateway"
   type = "tcp"
   localIP = "127.0.0.1"
   localPort = 8746
   remotePort = 8746
   ```
3. 常驻启动：本机部署实测为 **HKCU Run 注册表键 + 隐藏启动器**
   （`HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 键 `DevHubFRP` →
   `wscript.exe <frp 目录>\frpc-run.vbs`；vbs 隐藏运行 `frpc-loop.cmd`——
   frpc 退出后 5s 自动重拉，等效 `Restart=always`；用户登录时自启）。
   注：`schtasks /ru SYSTEM` 方式需管理员提权，本部署环境为非提权 shell 故
   降级为用户级方案；有管理员权限时可用
   `schtasks /create /tn DevHubFRP /tr "<frpc.exe> -c <frpc.toml>" /sc onstart /ru SYSTEM /rl HIGHEST /f`；
4. 验证注册：ECS 上 `journalctl -u frps -n 20` 应见
   `new proxy [devhub-gateway] type [tcp] success` 与 `*:8746` 监听。

### 7.4 手机 / 模拟器侧

App 网关配置：主机 = **ECS 公网 IP**，端口 = `8746` → 测试连接（health 200）→
未配对则走 8 位码配对（桌面 Agents 视图「配对新设备」或桌面回环
`POST /v1/pairing/create` 签发）。已实测：模拟器（DevHub_API_35）以 ECS 公网
地址完成 health / 配对 claim / 会话与 Agents 真实数据 / WS 长连（心跳 30s）全链路
——证据 `acceptance/agents-mobile/tunnel-ecs-*.png` 与 ac8-blocked.md §5。

### 7.5 已知弱点与防线（如实声明）

1. **手机 → ECS 段为明文 HTTP/WS**（无 TLS）。防线（应用层，全部已实现并在
   公网路径实测）：设备 Bearer Token 可随时撤销（撤销即拒 + 掐断活跃 WS）、
   防重放（`X-DevHub-Timestamp` ±300s + nonce 10min LRU）、限流（鉴权失败
   5 次/60s/源、常规 120 次/min/设备、claim 5 次/5min/源）、指令 300s TTL +
   幂等键。**TLS 升级路径**（后续可选）：ECS 上以 Nginx/Caddy 做 TLS 终结反代
   `127.0.0.1:8746`（需域名 + 证书，App 端改填 `https://` 地址），或改用 frp 的
   `transport.tls`（frpc↔frps 段加密；App→ECS 段仍需反代补 TLS）。
2. **来源 IP 面失去区分度**：经任何隧道（frp / NatPierce 同理）到达 Gateway 的
   请求来源恒为 frpc 的回环地址——`/v1/pairing/create` 的
   GATEWAY_LOCAL_ONLY（非回环拒绝）在隧道形态下不会触发；「同源」限流实际按
   frpc 单点计。判定逻辑本身零变化（隧道不改变任何安全决策，docs/15 §8），
   但公网防护实质收敛为 Token + 防重放 + 限流三条应用层防线。
3. **frps 是公网入口**：frp 自身暴露 7000（token 认证保护）与 8746（仅转发）；
   ECS 需系统级日常维护（apt 安全更新）。frp token 泄露 = 隧道控制面沦陷
   （可注入任意代理），应按凭据红线保管，泄露即换 token 并重启两端。
4. **ECS 单点与带宽**：2C2G/3Mbps 固定带宽为实测配置；3Mbps 上行对消息型
   流量（文本事件流）充裕，对大文件类投影不适用（DevHub 远程面本就不含文件
   通道）。

### 7.6 与 DevHub 的边界（与方案 A 完全一致）

DevHub 不启动、不安装、不修改 frp；frp token 与 ECS 凭据属**用户外置凭据**，
不入仓库、不入 settings 表、不入日志（红线同 §5）。DevHub 侧零代码改动——
Gateway 仍绑回环、鉴权/防重放/限流/审计全按 docs/15 原样生效。
