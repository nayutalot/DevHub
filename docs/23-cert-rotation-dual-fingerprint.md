# 23. 证书轮换双指纹窗口设计（CERT 批 Phase A 产出 → 主控裁决 → Phase B 实施记录）

> 状态：**已裁决（2026-09-14 主控：D1–D5 全按本设计推荐项）**；Phase B 已实施——桌面 feed
> 信任代码+单测门禁全绿、ECS 新证书已暂存（未部署）、App 侧零代码确认（§7.2）。
> 任务书 = docs/briefs/cert-dual-fingerprint.md；分支 agent/cert-dual。
> 纪律：ECS 侧证据为 SSH 只读侦察 + staging 目录内生成（在役证书/caddy 零触碰）；
> 私钥零落仓零入日志（仅指纹/公钥面入册）。

## 0. 死线与结论速览

- 在役叶证书 notAfter **2026-12-04 19:28:46 GMT**；任务书死线 **2026-11-20 前开窗**（HANDOFF §5 第 4 条）；ECS 服务器时间 2026-09-14（本 Phase 实测 UTC）→ 剩余 ~81 天。
- 三消费面结论一览：
  | 消费面 | 信任机制 | 双指纹窗口就绪度 | 窗口期动作 |
  |---|---|---|---|
  | App（pin-TM） | 自定义 TrustManager，叶 SPKI ∈ 配置指纹列表（任一匹配） | **代码+单测已全链就绪** | 用户在配置页追加第二枚指纹（纯数据操作） |
  | 桌面 host-leg wss | node:https 注入 `tls{ca, checkServerIdentity}` 双保险 | **已就绪**（pins 文件多行） | fingerprints 文件追加新 pin 行（+视 D2 更新 ca.pem） |
  | 桌面 updater feed | **无**——Chromium net 栈拒私有 CA，X11 起静默检查即撞墙 | **已补齐（Phase B §7.1：分区 session verify-proc pin，门禁全绿）** | 无需用户动作（读同一 fingerprints 物料；M2 换装即生效） |
- **材料修正（重要）**：任务书候选解「`session.defaultSession.setCertificateVerifyProc`」经 electron-updater@6.6.4 原包取证，**覆盖不到 updater 流量**——6.6.4 全部更新请求走独立分区 session `session.fromPartition("electron-updater", {cache:false})`（§3.3 实证）。正确落点 = 对该分区 session 设 verify proc。方向不变、作用域修正。

## 1. ECS 证书现状实证（SSH 只读，2026-09-14）

### 1.1 证书形态

- **不是裸自签叶，是私有 CA 签发的叶证书**：
  - 叶：`CN=devhub-relay-ip`，`BasicConstraints: critical, CA:FALSE`，`KeyUsage: critical, Digital Signature, Key Encipherment`，`EKU: TLS Web Server Authentication`，SAN = **仅 `IP Address:59.110.149.11`**，key = **ECDSA P-256（prime256v1）**，签名 `ecdsa-with-SHA256`。
  - CA：`CN = "DevHub Relay Root CA (self-signed, no domain)"`，`CA:TRUE`，ECDSA P-256，**与叶同有效期** `2026-09-05 19:28:46 GMT → 2026-12-04 19:28:46 GMT`（90 天）。
  - 生成器：docs/ecs-relay-deploy/gen-ip-cert.sh（支持 `CA_KEY`/`CA_CERT` 复用已有 CA、`DAYS`、`KEY_ALGO=ec|rsa`、`OUT_DIR` 参数化——轮换操作直接复用）。
- 指纹（服务器 `/etc/devhub-relay/tls/` 在档文件 + 本 Phase 现算对拍）：
  - SPKI sha256（pinning 消费形态）：`sha256/a07f7ab77bc2f21ba8d5e868cad30156d721aa11a8b85843973575a672aa50d0`（spki-sha256.txt 在档 + `openssl x509 -pubkey | openssl pkey -pubin -outform DER | openssl dgst -sha256 -binary | base64` 现算 = **`oH96t3vC8huo1ehoytMBVtchqhGouFhDlzV1pnKqUNA=`**，与 App 存量用户指纹逐字节一致——存量指纹即当前在役证书 SPKI）。
  - 证书整体 sha256：`sha256/938bb1483954c530090aea73e6a8c0f63f20ad990d7c3099e7aa188f35e79ada`（cert-sha256.txt；仅人工核对用，勿混入 pin）。
- 文件清单（ls 实测）：`ca.crt`(0644) / `ca.key`(0600 root) / `ca.srl` / `server.crt`(0644 caddy) / `server.key`(0600 caddy) / `server.csr` / 两个指纹 txt。

### 1.2 caddy 挂载与链形态

- caddy **2.6.2**（systemd 在役 `/usr/bin/caddy run --environ --config /etc/caddy/Caddyfile`）。
- `/etc/caddy/Caddyfile` 关键面：全局 `auto_https off` + `default_sni 59.110.149.11`（无 SNI 握手默认证书，零 ACME）；站点 `https://59.110.149.11:443` 显式 `tls /etc/devhub-relay/tls/server.crt /etc/devhub-relay/tls/server.key`；路由：`/relay/*`、`/v1/*` → `http://127.0.0.1:8443`；`/updates/*` → `file_server`，root `/var/lib/devhub-updates`（X11 批 generic feed：`latest.yml` + `DevHub Setup 0.1.0.exe` + blockmap 在役实测）；其余 404。
- **服务链形态 = leaf-only**（本机 `openssl s_client -connect 59.110.149.11:443` 实测：链中仅 `s:CN=devhub-relay-ip`，`unable to verify the first certificate`）——客户端侧链构建依赖本地 trust store 的 CA（App pin-TM 不需要；桌面 host-leg 靠 ca.pem；即 docs/19 §10 双保险形态）。

## 2. 三消费面信任机制侦察（代码实证）

### 2.1 App（pin-TM）：双指纹全链已就绪，窗口期零代码

- **存储**：`gateway_config.pinFingerprints TEXT`，注释明写「非机密物料，逗号/换行分隔」（android/app/src/main/java/com/devhub/mobile/data/db/DevHubDb.kt:27,39；v3 migration :290）。**已天然多值——无字段迁移需求**。
- **录入 UI**：GatewayConfigScreen「证书指纹（高级，可选）」多行输入框，label 明写「SPKI sha256 指纹（sha256/<hex>，逗号/换行分隔；双指纹轮换窗口）」（android/app/src/main/java/com/devhub/mobile/ui/screens/GatewayConfigScreen.kt:207-225 附近）；空指纹引导文案（同文件 :190-201）引用 C2c 真机实录——自签 IP 证书不填指纹直到连接层 fail-closed「Trust anchor not found」（另见 android/core/src/test/kotlin/com/devhub/mobile/core/ErrorPresentTest.kt:52）。
- **保存门**：PinFingerprintSaveGate.check 逐条 fail-fast，归一化逗号串返回；两条目单测 `rotation window two entries pass joined normalized in order`（android/app/src/main/java/com/devhub/mobile/data/PinFingerprintSaveGate.kt:35-49；android/app/src/test/kotlin/com/devhub/mobile/data/PinFingerprintSaveGateTest.kt:71）。
- **连接层**：ConnectionManager.parsePinning（逗号/换行/分号拆分，android/app/src/main/java/com/devhub/mobile/connect/ConnectionManager.kt:430-440）→ :core `TlsPinningConfig`（列表归一化去重、`matches` = 任一匹配即信任、双指纹窗口语义注释，android/core/src/main/kotlin/com/devhub/mobile/core/TlsPinning.kt:15-16,25-42）→ `RelayTlsTrust.PinTrustManager.checkServerTrusted` 判**叶证书 SPKI sha256 ∈ pins**，链深度不作要求（caddy leaf-only 实测 chainLen=1），`getAcceptedIssuers()` 空、信任锚=指纹列表绝非 CA（android/app/src/main/java/com/devhub/mobile/data/remote/TlsPinningOkHttp.kt:33-88；docs/19 §10.2/§10.5 红线：自签 CA 绝不入 App）。
- **注入面**：ApiProvider.relayPinning（android/app/src/main/java/com/devhub/mobile/data/ApiProvider.kt:88-95）+ RelayPairingClient / RelayHealthProbeFactory / ConnectionManager.rebuildRelayClients（grep 命中同链路）。
- **单测已覆盖双指纹窗口**：TlsPinningTest.kt:57 `dual fingerprint window - old and new both trusted, third rejected`；TlsPinningOkHttpTest.kt:54 `checkServerTrusted honors rotation window - any of old plus new pins matches`。
- **结论**：App 侧窗口期唯一动作 = 用户在既有高级字段追加新指纹（数据操作，零发版零编码）。运维前置 = 核实在役用户装机 APK 已含该能力（相关 commit 54b5024/f11c79e/d49fb25 均 2026-09-05~07 合入；dist/DevHub-Android-0.1.0-debug.apk 时间戳 09-14 晚于全部 commit，但用户存量装机版本号无法从仓库实证，列为开窗前置检查项 §4-②）。

### 2.2 桌面 host-leg wss：注入式双保险，双指纹已就绪，机制零改动

- **为何能连自签**：不是绕过校验——node:https 请求注入 `tls{ca, checkServerIdentity}` 两件（src/main/services/agentControl/relayClient/wsClient.ts:502 注入缝定义、:557-568 应用）。且 TLS 会话缓存强制关闭 `maxCachedSessions: 0`（:561-567），否则 Node https.Agent 会话复用会整体跳过 checkServerIdentity（M3-C1b 实测勘误）——**每次握手全新校验**。
- **校验语义**：`buildRelayTlsCheckServerIdentity(pins)`（src/main/services/agentControl/relayClient/index.ts:385-400）= 默认规则（主机名/IP SAN、过期）先行，默认拒即拒；再取 `cert.raw`（叶 DER）→ `X509Certificate.publicKey.export({type:'spki',format:'der'})` → sha256 hex ∈ pins（**任一命中即过 = 双指纹窗口语义**）。勘误在档：`cert.fingerprint256` 是整证书摘要非 SPKI，绝不可混用（:383）。
- **信任物料**（用户外置文件，重连热装载）：`%LOCALAPPDATA%\DevHub\relay\fingerprints`（每行一枚 `sha256/{hex}`，`#` 注释，≥1 枚否则结构化失败；src/main/services/agentControl/relayClient/config.ts:23-27,177-186,226-236）+ `%LOCALAPPDATA%\DevHub\relay\ca.pem`（**明确不采用 pin-only 绕链验证**——缺 CA = 结构化失败提示补放，config.ts:287-297 与 loadRelayTlsTrust 全程）。装载时机：attemptConnect 每次连接尝试重读（index.ts:413-428；退避 ≤60s 自动生效，无需重启）。
- **窗口期物料策略**：fingerprints 追加新 pin 行（两行并存）；ca.pem——若 D2 选新 CA key，则窗口期 = 旧 CA + 新 CA **双 PEM 拼接单文件**（Node `tls.createSecureContext({ca})` 接受多 PEM 字符串：本 Phase 本机 node 实测 `tls.createSecureContext({ca: caA + '\n' + caB})` OK，且 loadRelayTlsTrust 把整个文件读成单 string 原样传 `ca`（config.ts）——语义零改动）；若 D2 选同 key 换期 CA，ca.pem 单替换即可。收敛期移除旧 pin 行/旧 CA。
- **结论**：机制零改动，纯数据/物料操作。

### 2.3 桌面 updater feed：唯一缺口，需 Phase B 新代码

**现状与撞墙实证**

- feed 面：编译期常量 `DEVHUB_UPDATE_FEED_URL = 'https://59.110.149.11/updates/'`（src/main/updaterWire.ts:41）；electron-updater 动态 import + `setFeedURL({provider:'generic', ...})`（:87,109）；打包态启动 60s 静默检查（:44,167-175）；dev 态全链禁用（:66-72）。
- 撞墙：X11 在役打包实例首验 `net::ERR_CERT_AUTHORITY_INVALID`（brief:3 在档）——Chromium net 栈不信任私有 CA。本 Phase 本机复现同墙：openssl「unable to verify the first certificate」（leaf-only 链）+ Windows schannel curl `SEC_E_UNTRUSTED_ROOT (0x80090325)`。**latest.yml 检查与安装包下载当前即全失败**（App 打包实例的 updater 是三消费面唯一现在就不通的）。

**下载路径取证（electron-updater@6.6.4 原包，本仓锁版 package-lock.json:3427-3428）**

- 生产恒用 ElectronHttpExecutor：node_modules/electron-updater/out/AppUpdater.js:196（`app == null` 分支 = 生产接线态，updaterWire 未传 app）。
- **全部 HTTP 走独立分区 session**：out/electronHttpExecutor.js:6 `NET_SESSION_NAME = "electron-updater"`；:8 `session.fromPartition("electron-updater", { cache: false })`（缓存复用，注释明言「differential downloader can call this method very often」）；:54-56 `require("electron").net.request({ ...options, session: this.cachedSession })`。检查（latest.yml downloadToBuffer，AppUpdater.js:626）、blockmap 差分（:653）、安装包下载同路。
- 推论（材料修正）：Chromium net 栈证书校验按 session 挂 verify proc——**设 defaultSession 管不到 updater 流量；必须对 `session.fromPartition("electron-updater", {cache:false})` 设 proc**（Electron 按 partition 名复用同一 session 对象，主进程先行调用取得同一实例、proc 常驻）。X11 观测到的 `net::ERR_*` 错误串本身即佐证请求走 Chromium net 栈（Node https 会给 `UNABLE_TO_VERIFY_LEAF_SIGNATURE` 类错误码，形态不同）。

**候选解权衡（采纳与否 = 决策点 D3）**

| 选项 | 机理 | 权衡 |
|---|---|---|
| **A. 分区 session `setCertificateVerifyProc` + feed host SPKI pin（推荐）** | proc 按 hostname 分流：非 `59.110.149.11` 一律回调默认 `verificationResult`（零干预）；命中 feed host 则解析 `verificationRequest.certificate.data` → node:crypto `X509Certificate` → SPKI sha256 ∈ pin 集才放行（语义镜像 host-leg buildRelayTlsCheckServerIdentity，默认规则/SAN/过期不豁免） | 应用级、不污染系统信任库、零 http 降级、零域名依赖；爆炸半径最小（仅 updater 分区，renderer/defaultSession 零触碰）。风险：electron-updater 升版换 session 面 → 缓解 = package-lock 锁版 + 单测夹具断言 + 版本升级检查单 |
| B. A + defaultSession 同设 | 对未来 electron-updater 改回 defaultSession 的漂移更稳 | renderer 全部 https 面过自定义 proc，爆炸半径变大 |
| C. 系统信任库导入 ca.crt | `certutil -addstore root` | 污染系统全局信任（任何程序都信任该 CA）、需管理员、违背「不污染系统信任库」方向 |
| D. feed 走 http 明文 | — | 违背零降级红线，否决面 |
| E. 公共可信 CA | 需域名（ACME）或公共 IP 证书 | U1 已裁决永久不购域名（docs/21 §1）；公共 CA 签发 IP 证书的短效方案与既有裁决/运维形态冲突 |
| F. 更换分发渠道（GitHub Releases 等） | — | 仓库 private + 客户端 token 面已否决（updaterWire.ts:39 注记） |

**Phase B 实测面**：fake 自签 CA+叶证书夹具 + 本地 https server，断言 proc 三态（pin 命中放行 / pin 不符拒绝 / 非 feed host 透传默认校验），零真网络；proc 回调码语义（0 放行 / 非 0 拒）以夹具实测为准并在代码注释锚定。

## 3. 双指纹窗口方案（按 D1-A/D2/D3-A 推荐形态展开；裁决变更则相应章节微调）

### 3.1 App 信任集形态与第二指纹录入

- 形态 = **既有 pinFingerprints 多值字符串**（存储/UI/保存门/连接层/单测五层就绪，§2.1）。「第二指纹录入」= 用户在 GatewayConfigScreen 高级字段追加一行（或逗号）新 SPKI 指纹 → 保存门归一化为两枚并存；「收敛」= 删除旧指纹行。**零 schema 迁移、零新 UI、零代码**。
- 不采纳（本轮否决面，如实留痕）：配对/命令通道下发指纹更新——指纹更新面本身依赖 relay 信任链，ECS 被挟持即可换 pin，pin 独立信任价值退化为 TOFU；且无需求驱动。

### 3.2 桌面 feed 信任解法

= §2.3 选项 A（D3 裁决）。实现落点建议：新 wire/模块（与 relayClient 的 pin 归一化复用或镜像），`app.whenReady` 早段对 `session.fromPartition("electron-updater", { cache: false })` 设 proc（先于 60s 静默检查）；pin 集来源与 host-leg fingerprints 文件同源同语义（同一物料文件，零第二真相源）；拒绝路径结构化日志（零凭据零堆栈）。

### 3.3 host-leg 是否需改

- **机制零改动**（§2.2）。窗口期物料：fingerprints 文件两行（旧+新）；ca.pem 按 D2——新 CA key → 双 PEM 拼接（已实证 Node 接受）；同 key 换期 → 单替换。收敛回单 pin/单 CA。
- 红线沿用 docs/19 §10.4：窗口期信任集**不得**出现旧+新之外的第三枚；收敛必须单指纹。

### 3.4 ECS 续期操作流程（Phase B 只生成/暂存；部署另行批次）

1. **生成**：gen-ip-cert.sh 参数化跑法（D1/D2/D4/D5 决定 `CA_KEY`/`CA_CERT`/`DAYS`/`KEY_ALGO`），`OUT_DIR=/root/cert-rotation-staging/`，目录 0700、私钥 0600；私钥零外传零入日志；`spki-sha256.txt`/`cert-sha256.txt` 指纹入册（公开物料）。
2. **暂存校验**：`openssl x509 -noout -text` 复核（SAN=IP:59.110.149.11、EKU serverAuth、CA:FALSE、notBefore/notAfter）；`openssl verify -CAfile ca.crt server.crt`；确认在役 443 未受影响（`openssl s_client` 仍回旧证书）。
3. **备份**（部署批内）：`tar` 打包 `/etc/devhub-relay/tls/`（root 0600，仅存服务器本地）；记录当前 Caddyfile 无需变更（证书路径不变，仅换文件内容）。
4. **部署时点**（12-04 notAfter 前 ≥3 天，且须晚于开窗确认）：cp 暂存新 server.crt/server.key → `/etc/devhub-relay/tls/`（属主/权限对齐：caddy 可读）；`systemctl reload caddy`；三消费面验证（App 握手、host-leg 重连 ≤60s 自动装载、`curl --cacert` 新 CA 拉 latest.yml 200）。
5. **回滚**：备份回 cp + `caddy reload`（分钟级）；窗口期双指纹保证回滚后旧指纹仍在客户端信任集，零断链。
6. **收敛**：观察期 ≥1 周后客户端删旧指纹（App 用户删行 / 桌面 fingerprints 删行）+ 旧 CA（如适用）；服务器暂存目录按凭据纪律处置。

### 3.5 时间窗排程（挂历日，2026）

| 里程碑 | 时点 | 动作 | 责任面 |
|---|---|---|---|
| M1 代码就绪 | 09 月内（Phase B） | 桌面 feed-pin 实现+单测；（App 预计零代码）门禁全绿 | Phase B 批 |
| M2 发布换装 | M1 后、≤10 月中 | 桌面新版发布；App 双指纹版下发/换装（含核实用户 APK 能力） | 运维/用户 |
| M3 **开窗** | **≤11-20（死线）** | 用户把新 SPKI 写入 App 高级字段 + 桌面 fingerprints；按 D2 更新 ca.pem；验证旧证书下双指纹握手正常 | 用户+运维 |
| M4 **轮换部署** | **12-01 前（notAfter 12-04 19:28 GMT 前 ≥3 天）** | §3.4 部署流程 + caddy reload + 三面验证 | 运维批 |
| M5 收敛 | M4 + ≥1 周 | 客户端删旧指纹/旧 CA；服务器暂存处置 | 用户+运维 |
| 兜底 | — | 若 M4 延迟，12-04 19:28 GMT 起全 TLS 面握手失败（App/host-leg/feed 均拒过期证书，属验收三拒语义）——M3 越早兜底余量越大 | — |

## 4. 决策点清单（交主控裁决，不代答）

**D1 新叶证书是否换新密钥对（= 双指纹窗口是否真开）**
- A. 换新 key（新 SPKI → 指纹变 → 按本设计开窗）【推荐】：gen-ip-cert.sh 默认语义即「重新生成新密钥对」；docs/19 §10.4 原文流程即此；顺带全链实战验证轮换机制（90 天节奏每季要用）；私钥暴露面收敛。
- B. 复用旧 key（SPKI 不变 → 指纹不变 → 无需窗口，仅替换证书文件）：零客户端动作，但轮换机制永无实战验证、密钥年龄持续增长；**若选 B，本任务双指纹窗口主体失义、Phase B 大半作废**——须想清。

**D2 CA 侧策略（现役 CA 与叶同日 2026-12-04 到期，必须同步处理——否则新叶过 12-04 链验证失败/旧链到期双雷）**
- A. 全新生成 CA（gen-ip-cert.sh 默认）：桌面窗口期 ca.pem 双 CA 拼接、收敛删旧；App 零感知（pin-only 不装 CA）。
- B. 复用旧 CA key 重签 CA 证书（`CA_KEY`/`CA_CERT` 传参，脚本已支持）：CA 公钥不变，ca.pem 单替换（新旧叶同链同钥）；CA 证书本体仍须更新（到期校验针对证书非公钥）。
- C. **A 或 B 基础上把 CA 有效期拉长（如 ≥5y）+ 叶维持短有效期**【推荐】：一次性把轮换节奏降为「只轮叶」；CA 是私有信任根且私钥仅存 ECS 0600，长有效期风险可控。

**D3 updater feed pin 采纳与作用域**
- A. 采纳：`session.fromPartition("electron-updater",{cache:false}).setCertificateVerifyProc`，仅 feed host 分流 SPKI pin【推荐】：最小爆炸半径；6.6.4 取证路径（§2.3）；锁版+夹具兜版本漂移。
- B. A + defaultSession 同设：抗 electron-updater 未来版本漂移，代价 = renderer 全部 https 面过自定义 proc。
- C. 不采纳（C–F 候选均有红线冲突，见 §2.3 表）。

**D4 是否顺带换 key 类型**
- 现状叶+CA 均 ECDSA P-256——「换 ECC」议题实际不存在，现状即 ECC。
- A. 维持 EC P-256【推荐】：OkHttp/Node/Electron 全兼容，无变更收益。B. P-384：无威胁模型需求。C. RSA4096：性能劣化无理由。

**D5（衍生）叶有效期 DAYS**
- A. 维持 90d（现状节奏，每季全流程）。B. 180d【推荐，配 D2-C】：窗口运维减半。C. 365d+：pinning 模型下可辩护，但私钥长期暴露与轮换演练频率下降。

## 5. 偏差与未尽事项（如实）

1. brief 写基线 main=fa10681，实际 main=22cab48——22cab48 即 brief 自身的合入 commit，无实质代码漂移（git log 确认）。
2. brief 候选解「defaultSession.setCertificateVerifyProc」经 electron-updater@6.6.4 原包取证修正为**分区 session**作用域（§2.3 材料修正）；方向不变。
3. 「不填=Trust anchor not found」真机实证以仓库在档实录引用（GatewayConfigScreen.kt:190-201 引 C2c 实录、ErrorPresentTest.kt:52）；本 Phase 未重复真机连接实验（Phase A 零写操作纪律下无必要，在役面未动）。
4. 在役用户 APK 是否已含双指纹字段无法从仓库实证（装机版本属运维面），列为 M2/M3 前置检查项（§3.5-②）。
5. electron-updater verify proc 的回调码语义（0/非 0）与 fromPartition 先行创建的 session 复用行为，按 Electron 文档设计、Phase B 以 fake 夹具实测锚定（§2.3）。
6. 本机 Node 多 PEM `ca` 实证用临时目录（/tmp），未入仓；测试 CA 即弃。

## 6. 主控裁决落档（2026-09-14）

主控裁决原文：「CERT D1-D5：**全按你的推荐**——D1=A 换新 key；D2=C 且明确取『**全新 CA**（新 key，有效期 5 年）+ 短叶 180d』；D3=A 仅 updater 分区 session 设 verify proc；D4=维持 ECDSA P-256；D5=叶 180d。」

| 决策点 | 裁决 | 落地面 |
|---|---|---|
| D1 叶证书密钥 | **A 换新 key**（新 SPKI → 双指纹窗口真开） | ECS 暂存叶证书新密钥对（§7.3）；App/桌面窗口物料按 §3.5 排程 |
| D2 CA 策略 | **C = 全新 CA（新 key，5 年 1825d）+ 短叶** | ECS 暂存新 CA（§7.3）；窗口期桌面 ca.pem = 旧 CA + 新 CA 双 PEM 拼接（Node 多 PEM `ca` 已实证）；收敛删旧 CA |
| D3 feed pin | **A 仅 updater 分区 session** 设 verify proc | `session.fromPartition("electron-updater",{cache:false})`；defaultSession/renderer 零触碰（§7.1） |
| D4 key 类型 | **维持 ECDSA P-256**（叶+CA 均 EC） | 暂存件按 P-256 生成 |
| D5 叶有效期 | **180d** | 暂存叶 notBefore/notAfter 2026-09-14 → 2027-03-13 |

**排程确认（M1–M5 挂历，§3.5 原文生效）**：M1 代码就绪（本批，2026-09-14 桌面面完成）→ M2 发布换装（≤10 月中，App 双指纹版 + 桌面 feed-pin 版；含在役 APK 能力核实）→ M3 **≤2026-11-20 开窗**（客户端写入旧+新双指纹 + 双 CA ca.pem）→ M4 **≤2026-12-01 轮换部署**（notAfter 12-04 19:28 GMT 前 ≥3 天；caddy 切载 + reload）→ M5 观察 ≥1 周收敛回单指纹/单 CA。

## 7. Phase B 实施记录（2026-09-14）

### 7.1 桌面 feed TLS 信任（唯一代码面）

- 新增 `src/main/services/updateCenter/feedTrustProc.ts`（纯 Node，零 electron/electron-updater import，smoke 系统 Node 直载同款）：`createFeedCertVerifyProc({feedHost, loadPins, log?, nowSec?})`——非 feed host **原样回放 `errorCode`**（成功 0 回放 0 / 失败码逐位回放；不依赖未文档化码）；feed host：pin 集现读（热装载）→ 叶证书 PEM（`certificate.data`）→ SPKI sha256 ∈ pins → 有效期窗（`validStart/validExpiry` epoch 秒，界缺失 fail-closed）→ 接受/拒绝。回调码 = Electron 官方语义 `callback(0)` 接受 / `callback(-2)` 拒绝（node_modules/electron/electron.d.ts:13338-13345）。
- 接线 `src/main/updaterWire.ts`：打包态（dev 禁用门之后、动态 import 之前）对 **`session.fromPartition("electron-updater", {cache:false})`** 挂 proc——分区名按锁版 electron-updater@6.6.4 取证锚定（`out/electronHttpExecutor.js:6,8,54-56`；包根不 re-export，**升版须复核**，失配 = fail-closed 撞墙可诊断绝不静默放行）；pin 源与 host-leg **同源同解析**（`relayClient/config.ts` 的 `parseRelayFingerprintFile` 读同一 `%LOCALAPPDATA%\DevHub\relay\fingerprints`，多行 = 双指纹窗口任一匹配）；失败结构化日志非阻塞。
- fake 证书夹具（公开物料，`src/main/services/updateCenter/__fixtures__/feedtrust/`：ca-a/leaf-a、ca-b/leaf-b，EC P-256）+ smoke 新增 4 用例（fast 档，零真网络）：
  1. 三态核心：pin 命中接受(0) / pin 不符拒绝(-2) / 非 feed host 透传 errorCode（含 loader 零调用证明——分流在先）；
  2. 双指纹窗口：旧+新任一命中即过 / 仅旧集新叶拒（开窗前）/ 仅新集旧叶拒（收敛后）；
  3. 有效期窗：过期拒 / 未生效拒 / 界缺失 fail-closed（nowSec 注入）；
  4. fail-closed：pin 集缺失/空/坏 PEM/缺 data 拒 + host 归一。
- 产物验证：`out/main/index.js` 含分区串与安装日志串（bundle 命中）。

### 7.2 App 侧零代码确认（裁决口径：双指纹五层已就绪，不写代码）

| 层 | 实证（文件:行号） |
|---|---|
| 存储 | `android/app/src/main/java/com/devhub/mobile/data/db/DevHubDb.kt:27,39`（`pinFingerprints TEXT` 多值）；migration :290（v3） |
| 录入 UI | `android/app/src/main/java/com/devhub/mobile/ui/screens/GatewayConfigScreen.kt:207-225`（多行高级字段，label「逗号/换行分隔；双指纹轮换窗口」）；空值引导 :190-201 |
| 保存门 | `android/app/src/main/java/com/devhub/mobile/data/PinFingerprintSaveGate.kt:35-49`；双条目单测 `PinFingerprintSaveGateTest.kt:71` |
| 连接层 | `ConnectionManager.kt:430-440` → `android/core/src/main/kotlin/com/devhub/mobile/core/TlsPinning.kt:25-42`（任一匹配）→ `TlsPinningOkHttp.kt:64-75`（PinTrustManager 叶 SPKI ∈ pins） |
| 单测 | `TlsPinningTest.kt:57` / `TlsPinningOkHttpTest.kt:54`（双指纹窗口断言在档） |

**用户操作口径（M3 开窗动作，纯数据操作）**：设置 → 网关配置（relay 模式）→「证书指纹（高级，可选）」→ 在既有指纹后**追加**一行新叶 SPKI 指纹（§7.3 的 `sha256/b18a84…` 或其 base64 形 `sYqEM0IJ…`，两种形态均接受）→ 保存（保存门归一化两枚并存）→ 重连即生效。收敛（M5）：删除旧指纹行。

### 7.3 ECS 新证书暂存物料清单（/root/cert-rotation-staging/，未部署）

生成日期 2026-09-14；目录 0700；私钥 `ca.key`/`server.key` 0600 仅存 ECS（零外传零入日志）。参数：新 CA（新 key，EC P-256，1825d）、新叶（新 key，EC P-256，180d，SAN=`IP:59.110.149.11`，EKU serverAuth）。

| 物料 | 值（公开物料可入册） |
|---|---|
| **新叶 SPKI sha256（开窗新增 pin）** | `sha256/b18a843342098a917ce9956d8bd6801edcf76972caa6e47a699ce1bb968a66fc` |
| 新叶 SPKI base64（App 可直贴形态） | `sYqEM0IJipF86ZVti9aAHtz3aXLKpuR6aZzhu5aKZvw=` |
| 新叶证书整体 sha256（人工核对用，勿入 pin） | `sha256/3879ee11f53333c45a74f375f877d41b3b8c7f8644a62f0a13fc4cb6e5a971d5` |
| 新叶有效期 | 2026-09-14 07:06:41 GMT → 2027-03-13 07:06:41 GMT（180d） |
| 新 CA SPKI sha256 | `sha256/634356a5ee2af49cf27f899327d1005e6e56f57060af9915035bacae738a0bec` |
| 新 CA 证书整体 sha256 | `sha256/0eb41cb213d213319143b9bc988600db5b4ca0080228949d1a80f6c118d58fc2` |
| 新 CA 有效期 | 2026-09-14 07:06:41 GMT → 2031-09-13 07:06:41 GMT（5y） |
| **旧叶 SPKI sha256（在役，窗口期保留 pin）** | `sha256/a07f7ab77bc2f21ba8d5e868cad30156d721aa11a8b85843973575a672aa50d0`（base64 = `oH96t3vC8huo1ehoytMBVtchqhGouFhDlzV1pnKqUNA=`） |
| 旧 CA 证书整体 sha256（在役，收敛期移除） | `sha256/938bb1483954c530090aea73e6a8c0f63f20ad990d7c3099e7aa188f35e79ada`（整体指纹面；旧 CA SPKI 未单独入册——桌面 ca.pem 以 PEM 文件整体替换/拼接，不消费 CA SPKI 数值） |
| 暂存件 sha256（公开 7 件，SHA256SUMS 在档） | ca.crt `d49a1aa0…` / server.crt `d323a74b…` / server.csr `e0b5331d…` / spki-sha256.txt `5a4dc073…` / cert-sha256.txt `451e6047…` / ca-spki-sha256.txt `7bbbf5fa…` / ca-cert-sha256.txt `ac20c1d3…` |

校验：`openssl verify -CAfile ca.crt server.crt` = OK；SAN/EKU/CA:FALSE 逐项核过。
在役面零触碰实证：服务器本机 `openssl s_client -connect 127.0.0.1:443` 仍回**旧叶**（`93:8B:B1:48:…:9A:DA`，notAfter 2026-12-04）；`/etc/devhub-relay/tls/` mtime 仍 2026-09-06 未动；caddy 未 reload。

**部署时点提醒（M4 ≤2026-12-01，另行批次）**：备份 `/etc/devhub-relay/tls/` → 换载暂存 server.crt/server.key + 新 ca.crt 备分发 → `systemctl reload caddy` → 三消费面验证 → 观察期收敛。窗口期桌面 `ca.pem` = 旧 CA + 新 CA 双 PEM 拼接（Node 多 PEM `ca` 已实证），App 与 feed-proc 均不消费 CA。
