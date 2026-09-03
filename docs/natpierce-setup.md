# NatPierce 隧道配置指南（AC8，docs/15 §8 的用户侧落地）

> 本文初版随 AC8 批次成文；AC9 批次按母智能体规格复核补全（新增 Windows
> `setx` 系统级 / `set` 会话级设置示例，§3.1），并对照代码实况逐条核实。
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
