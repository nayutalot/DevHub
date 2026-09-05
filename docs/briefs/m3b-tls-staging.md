# M3-B 服务端批任务书（自签 IP 证书 + Caddy 443 反代装载，ECS）

> 前提事实：devhub-relay 已在 ECS 59.110.149.11 以 systemd 常驻（只绑 127.0.0.1:8443，health 200）。本批做 TLS 终结层：证书生成 + Caddy 安装装载。**S1 安全组 443 规则归用户控制台操作，本批只做服务端本地部分 + 本地验证；公网 R-B1 验收等 S1 后由主控做。**
> 并行批提示：另有一批正在改 /opt/devhub-relay 代码并可能 `systemctl restart devhub-relay`——你验证健康时若遇瞬时失败，先查 `systemctl is-active devhub-relay` 再重试；**绝不自己去 restart/stop devhub-relay**。

## 0. 占用资源清单（机器资源登记）

- ECS 59.110.149.11：SSH `ssh -i ~/.ssh/devhub_ecs -o BatchMode=yes root@59.110.149.11`（密钥直连可用，**任何密码绝不出现**）
- 可操作：`/etc/devhub-relay/tls`（新建）、Caddy 安装与 `/etc/caddy`、`systemctl reload/restart caddy`、443/tcp 监听
- **绝不碰**：`devhub-relay` 单元与 `/opt/devhub-relay`（并行批领土）、frps（7000/8746）、任何安全组/控制台操作
- 本地零资源占用（全部操作在 ECS）

## 1. 任务（物料权威 = docs/ecs-relay-deploy/README.md + ecs-relay/deploy/Caddyfile）

1. **证书**：上传 `docs/ecs-relay-deploy/gen-ip-cert.sh` 到 ECS 执行（默认参数：EC P-256 / 90 天 / IP SAN 59.110.149.11 / 输出 /etc/devhub-relay/tls）。验收：`openssl x509 -in server.crt -noout -ext subjectAltName` 含 `IP:59.110.149.11`；权限 server.key/ca.key 0600。
2. **Caddy 安装**：Ubuntu 24.04——优先 `apt-get install -y caddy`（universe 源）；不可用则官方二进制（注意国内网络，必要时走镜像/重试，安装后 `caddy version` 留档）。
3. **装载**：按 `ecs-relay/deploy/Caddyfile`（已是实例化版，若含 `{TLS_DIR}` 占位则 sed 替换为 /etc/devhub-relay/tls）→ `/etc/caddy/Caddyfile` → `caddy validate --config` → `systemctl reload caddy`（或 enable --now）。确认监听 `:443`（ss 查）。
4. **本地验证（不依赖 S1）**：ECS 上 `curl -s --cacert /etc/devhub-relay/tls/ca.crt https://59.110.149.11/v1/health` → 200 JSON；浏览器告警属预期不算失败。WS 路径可用 `curl --cacert ... -H "Connection: Upgrade" -H "Upgrade: websocket" ...` 至少确认非 5xx（或 openssl s_client 握手验证 TLS 层即可）。
5. **指纹产出**：`cat /etc/devhub-relay/tls/spki-sha256.txt` 内容（`sha256/` 前缀单行）写进汇报——这是公开物料（后续 App/relayClient pinning 配置的唯一消费形态）。**server.key/ca.key 绝不打印、绝不外传、绝不入任何文件。**
6. 证书 90 天有效期：把 notAfter 日期写进汇报（主控排轮换日历）。

## 2. 铁律

- 红线（约束 #13）：私钥零出 ECS；凭据零入仓库/日志/汇报
- 不做任何公网验收断言（443 对外开否由 S1 决定）；80 端口保持关闭
- 失败重试 ≤2 次换路径；再失败按四分类上报，不留半装状态（装不完则回滚 Caddy 配置）

## 3. 汇报（四分类）

已完成并验证/仅本地验证/环境阻塞/待用户。必带：证书 SAN 验证输出、caddy version、443 监听证据（ss）、本地 curl 200 JSON、**SPKI 指纹全文**、notAfter 日期、devhub-relay 全程未被本批触碰声明。
