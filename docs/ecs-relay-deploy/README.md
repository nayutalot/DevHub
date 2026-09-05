# DevHub ECS Relay 部署物料 —— 无域名 IP TLS（U1 已裁决 2026-09-05）

> 用户裁决：**永久不购买域名**。统一使用 ECS 公网 IP `59.110.149.11` + 自签 IP 证书 TLS。
> 裁决全文见 `docs/21-ecs-relay-pending-decisions.md` §1.1；信任模型架构权威见
> `docs/19-ecs-relay-architecture.md` §10（§11 = 明文时间盒禁令）；本目录是部署操作与模板层。
> 约束 #13 同款红线：私钥/凭据绝不入仓库、不入日志、不入审计。

## 0. 目录内容

| 文件 | 用途 |
| --- | --- |
| `gen-ip-cert.sh` | openssl 一键生成自签 IP SAN 证书（默认 EC P-256，`KEY_ALGO=rsa` 得 RSA 4096），90 天有效期，输出 `sha256/{hex}` SPKI 指纹与续期提示 |
| `Caddyfile.template` | Caddy 443 反代模板（`/relay/*` WS 透传 + `/v1/*` REST → `127.0.0.1:8443`），与 docs/19 §5.6 形态一致 |
| `nginx.conf.template` | 等价 nginx 版模板（Caddy/nginx 二选一） |
| `README.md` | 本文件：部署步骤 + 验收 + 客户端信任配置示例 |

前提：Relay 本体已按 docs/19 §5.6 部署并只绑 `127.0.0.1:8443`（TLS 永远在反代终结，Relay 不感知）。

## 1. 生成证书（ECS 上执行）

```bash
sudo ./gen-ip-cert.sh                 # 默认：EC P-256 / 90 天 / /etc/devhub-relay/tls / IP=59.110.149.11
# 可选：sudo KEY_ALGO=rsa DAYS=90 ./gen-ip-cert.sh
```

产出（`$OUT_DIR` 默认 `/etc/devhub-relay/tls`）：

- `server.crt` / `server.key` —— 443 装载；SAN 含 `IP:59.110.149.11`（**无 IP SAN 即部署失败**）；
- `ca.crt` —— 自签根 CA，分发客户端（curl --cacert / relayClient ca 装载）；`ca.key` 永不外传；
- `spki-sha256.txt` —— **SPKI SHA-256 指纹（`sha256/{hex}`）= 客户端 pinning 唯一消费形态**
  （OkHttp `CertificatePinner` 与 Node `tls.checkServerIdentity` 比对的都是 SPKI 摘要；
  `cert-sha256.txt` 仅人工核对用，勿混用）；
- 续期提示：90 天到期 = 全链路握手失败（三拒之「过期证书被拒」）。到期前重跑本脚本，
  按 docs/19 §10.4 双指纹窗口轮换（见 §5）。

## 2. 分发指纹（公开物料，可入配置；私钥绝不）

把 `spki-sha256.txt` 内容（形如 `sha256/3f9a…` 的单行）分发给两端客户端：

- **Android App**：写入注入式 `TlsPinningConfig(fingerprints)`（`:core` 模型，`sha256/{hex}`
  或等价 base64 形态；构造时格式错误 fail-fast）。relay 模式接线属 R3 批
  （docs/20 §2.3）；本批已落 `:core` 模型 + OkHttp 注入缝（null=现行为不变）。
- **Windows relayClient**：写入其指纹配置文件（R1 批实现装载；见 §4 Node 示例）。
- 形态约定：`sha256/` 前缀 + 64 位小写十六进制（大写自动归一化；base64 亦可，
  解码后必须恰为 32 字节）。

## 3. 反代装载（Caddy / nginx 二选一）+ 防火墙

```bash
# Caddy 路线
sudo sed "s|{TLS_DIR}|/etc/devhub-relay/tls|g" Caddyfile.template | sudo tee /etc/caddy/Caddyfile
sudo systemctl reload caddy

# nginx 路线（与上二选一）
sudo sed "s|{TLS_DIR}|/etc/devhub-relay/tls|g" nginx.conf.template \
  | sudo tee /etc/nginx/sites-available/devhub-relay
sudo ln -sf /etc/nginx/sites-available/devhub-relay /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

安全组：S1 新增 443/tcp（`docs/ecs-security-group-policy.md` §4）；80 **永久保持关闭**
（无 ACME/HTTP-01 需求，U1 否决域名路径）。Relay 本体监听面不变：`127.0.0.1:8443`。

## 4. 客户端信任配置示例（设计示例，非仓库代码）

**Node relayClient（R1 批实现时参考；`tls.checkServerIdentity` 覆写 + CA 指纹校验，注入式）：**

```js
// fingerprints = ["sha256/<旧 SPKI hex>", "sha256/<新 SPKI hex>"]  // 双指纹窗口，任一匹配即信任
import tls from "node:tls";
import crypto from "node:crypto";

function normalize(fp) {
  // 归一化到小写 hex：接受 sha256/<hex> 或 sha256/<base64(32B)>
  const body = fp.startsWith("sha256/") ? fp.slice(7) : fp;
  if (/^[0-9a-fA-F]{64}$/.test(body)) return body.toLowerCase();
  const buf = Buffer.from(body, "base64");
  if (buf.length === 32) return buf.toString("hex");
  throw new Error(`invalid fingerprint: ${fp}`); // fail-fast（与 :core TlsPinningConfig 同语义）
}
const pins = fingerprints.map(normalize);

const ws = new WebSocket("wss://59.110.149.11/relay/host", {
  headers: { Authorization: `Bearer ${relayCredential}` },
  tls: {
    ca: caCertPem, // 自签根 CA（server.crt 的签发链）
    checkServerIdentity(hostname, cert) {
      const err = tls.checkServerIdentity(hostname, cert); // 先走默认规则（IP SAN 匹配 59.110.149.11）
      if (err) return err;
      // spkiDer(peerCert)：取叶证书公钥的 SPKI DER。取法随库而异：
      //   node:https/tls —— socket.getPeerCertificate(true) 后由 X509Certificate(...) 提取公钥 DER；
      //   ws 包 —— peerCertificate(socket) 拿到证书对象后同上。
      const spkiHex = crypto.createHash("sha256").update(spkiDer(cert)).digest("hex");
      return pins.includes(spkiHex)
        ? undefined
        : new Error(`TLS pin mismatch for ${hostname}: ${spkiHex}`); // 双指纹窗口：任一匹配即信任
    },
  },
});
// 注：以上为注入位形态示例（指纹归一化 fail-fast + 默认规则 + SPKI pin 校验），
// 实现属 R1 批（docs/20 §2.1）；不得把 Relay 凭据/私钥写进此配置。
```

**Android（`:core` 模型 → OkHttp 注入缝；relay 模式接线属 R3 批）：**

```kotlin
val pinning = TlsPinningConfig(
    fingerprints = listOf("sha256/<旧>", "sha256/<新>"), // 双指纹窗口，任一匹配即信任
) // 构造即校验：格式错误抛 IllegalArgumentException（fail-fast）

val client = OkHttpClient.Builder()
    .certificatePinner(pinnerFrom(pinning)) // app 层转换；null = 现行为不变
    .build()
```

**运维调试（curl 显式信任自签 CA）：**

```bash
curl --cacert /path/to/ca.crt https://59.110.149.11/v1/health
```

## 5. 验收（M3 前置，docs/20 §3 R-B1/R-B9；docs/21 §1.1 第 5 条）

| # | 检查 | 命令/判据 |
| --- | --- | --- |
| 1 | 证书 SAN | `openssl x509 -in server.crt -noout -ext subjectAltName` 含 `IP:59.110.149.11` |
| 2 | 三端握手 | Android App（pinning 握手成功）、relayClient（checkServerIdentity 通过）、`curl --cacert ca.crt https://59.110.149.11/v1/health` → 200 |
| 3 | 错误证书被拒 | 指纹配置保持不变，装载另一张证书 → 三端握手全失败 |
| 4 | 错误指纹被拒 | 配置一枚不匹配指纹（或清空双指纹窗口）→ 三端握手全失败，错误可诊断（pin mismatch） |
| 5 | 过期证书被拒 | 装载过期证书（或时间前推演练）→ 握手失败（certificate expired） |
| 6 | 443 可达 | 外部探测 443 OPEN；8746/7000 按 docs/20 §4 迁移计划处理（不提前撤） |
| 7 | 浏览器告警属预期 | 浏览器访问 `https://59.110.149.11` 出告警 = **预期行为**（自签 IP 证书不受系统默认信任，docs/19 §10.5 / known-limitations §5.2）；**绝不**把告警当失败，也绝不声称浏览器默认信任 |

**证书轮换（docs/19 §10.4 双指纹窗口）**：重跑 `gen-ip-cert.sh`（新密钥对）→ 客户端指纹配置
写入 旧+新 双枚 → 反代切载 reload → 观察期后重分发仅含新指纹并收敛回单指纹。
全程不依赖 App 发版（指纹是配置数据）。

## 6. 红线与边界

- 私钥（`server.key` / `ca.key`）只存 ECS（0600），绝不入仓库/日志/审计/聊天记录；
- `ws://` 明文禁止作为正式方案——仅限 docs/19 §11 时间盒（M3 联调窗口内且配对码/端到端
  Token/Relay 凭据明文绝不出现于明文链路），过期即关闭；
- 本目录模板不改动 docs/14 本地直连路径语义（`127.0.0.1:8746` 本机兼容永久保留）；
- Node 示例仅为注入位设计参考（R1 批实现），不进仓库代码；App relay 模式接线属 R3 批。
