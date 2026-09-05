# devhub-relay — DevHub ECS Relay 服务（M2-R2）

ECS Relay 服务：**16 帧 WS 中继 + REST 中继 + 配对 + 命令排队 + 事件缓存 + 审计**（独立目录，
零污染 DevHub 门禁）。协议权威 = `docs/18-ecs-relay-protocol.md`；架构权威 =
`docs/19-ecs-relay-architecture.md`（§5 服务设计）；实施计划 = `docs/20-ecs-relay-plan.md` §2.2。

- 运行时：Node 22 LTS（开发机 Node 24；**不用 24 独有 API**）+ `node:http` + 自研 WS 服务端
  （`gateway/ws.ts` 编解码移植蓝本，零运行时依赖）+ `node:sqlite`（`relay.db` 独立库，独立迁移）。
- 安全基线：TLS 永远在反代终结（服务只绑 `127.0.0.1:8443`）；SQL 全参数绑定（约束 #11）；
  日志/审计零凭据（约束 #13/#14）；ECS 只验「设备注册过」，命令校验权在 Windows（docs/19 §3）。

## 目录

```
ecs-relay/
├─ package.json / tsconfig.json / .gitignore     # 自含（独立 node_modules，不 junction 主仓）
├─ sql/0001_init.sql                             # relay.db schema（docs/19 §5.3，8 表）
├─ scripts/
│  ├─ migrate.mjs                                # 独立迁移脚本（幂等，relay_meta.schema_version）
│  ├─ backup.sh                                  # 每日滚动备份（sqlite3 .backup × 7 份）
│  ├─ smoke.mjs                                  # 启动冒烟（裸进程 → health → 优雅停机）
│  └─ loadtest.mjs                               # 64 连接压测演练脚本（docs/19 §5.5 / docs/20 §2.2 验收线③）
├─ deploy/
│  ├─ devhub-relay.service                       # systemd 单元（Restart=always，加固项齐）
│  ├─ devhub-relay.env.example                   # 注册码 EnvironmentFile 模板（0600）
│  ├─ devhub-relay-backup.{service,timer}        # 每日 03:15 备份 timer
│  ├─ Caddyfile / nginx.conf                     # 443 反代实例化版（模板权威 = docs/ecs-relay-deploy/）
├─ src/
│  ├─ server.ts      # node:http 装配 + upgrade 分路（/relay/device|/relay/host）+ host 注册 + 优雅停机
│  ├─ ws.ts          # 自研 WS 服务端编解码（掩码/分片/1MB/1002/1003/1009/ping-pong，ws.ts 移植）
│  ├─ rest.ts        # REST 面 5 端点 + 防重放 + 限流 + stale 降级 + 405
│  ├─ auth.ts        # 注册表校验（sha256+timingSafeEqual）+ 防重放 + 限流三件套（auth.ts 蓝本）
│  ├─ pairing.ts     # 配对码落表/校验/作废/claim 限流（TTL 300s/一次性/失败 5 次作废）
│  ├─ forwarder.ts   # 中继编排：帧路由/扇出/排队投递/ack 中继/踢线/恢复
│  ├─ cache.ts       # relay_events 缓存：幂等插入/hasGaps/TTL 72h/容量两级淘汰
│  ├─ store.ts       # node:sqlite 访问层（? 绑定；WAL；busy_timeout 5000）
│  ├─ audit.ts       # relay_audit（pairing/auth/command/device/relay 五类，detail 零凭据）
│  ├─ config.ts      # env 配置（测试/演练可覆盖 TTL 等参数，缺省=生产值）
│  ├─ errors.ts      # RelayError + docs/18 §8.2 HTTP/WS 错误映射
│  └─ selfcheck.mjs  # 部署自检（docs/19 §5.7 清单，见下）
└─ test/
   ├─ fixtures/frames.json   # 16 帧契约 fixture（R1/R2/R3 对拍共用，逐帧标注 docs/18 出处）
   └─ *.test.mjs             # node --test（76 用例）
```

## 门禁（本目录自含，独立于 DevHub 四门禁）

```bash
npm install          # 独立 node_modules（仅 devDependencies：typescript + @types/node）
npm run typecheck    # tsc --noEmit（自含 tsconfig，erasable-only TS，Node strip-only 可直载）
npm test             # node --test（76 用例：编解码/鉴权/配对/缓存/排队/REST/e2e）
npm run smoke        # 启动冒烟：裸进程 → /v1/health → 优雅停机（exit 0）
npm run selfcheck    # docs/19 §5.7 清单 59 项全过（部署时与版本升级后必跑，结果人工留存）
npm run loadtest     # 64 连接压测演练（部署机上执行取 RSS 实测；本机已验：64 连接 74ms 建立完毕、
                     #   63 扇出 × 200 突发首达延迟 p50=2ms/p95=3ms）
```

端口纪律：测试/冒烟/自检全部绑 `127.0.0.1` + 端口 0（OS 随机高端口），绝不占 8746-8755，
绝不监听 0.0.0.0。

## selfcheck 覆盖（docs/19 §5.7）

| # | 清单项 | 落点 |
| --- | --- | --- |
| 1 | 帧编解码一致性（16 帧 fixture 逐帧 round-trip） | 进程内 codec + 全部 16 帧经真实套接字走通 |
| 2 | 配对全流程（register_pairing → pair → pair_accepted → 重连） | 子进程真实服务 |
| 3 | 命令排队/过期（queued:true / COMMAND_EXPIRED 回流） | 短 TTL 专用实例 |
| 4 | 缓存淘汰与 hasGaps（TTL 72h + 容量两级 + 洞显式标注） | 进程内 + 断言 |
| 5 | 限流三态（5/60s 源、120/min 设备、5/5min claim） | 真实 HTTP + 进程内窗口 |
| 6 | 重启后排队命令恢复（停机 → 同库重启 → 补发 → 投递） | SIGTERM/stdin 停机 → 重启 → 投递 → ack 回流 |
| 7 | 红线断言（DB/日志/审计抽样零 Token/码/凭据明文） | 字节级扫描 + relay_audit 抽样 |
| — | 容量预算护栏（docs/19 §5.5：≤64 连接、TTL、队列上限） | 生产默认值断言 |

## 部署（目标：59.110.149.11，Ubuntu 24.04，2C2G/3Mbps）

> TLS 终结与证书物料权威 = `docs/ecs-relay-deploy/`（U1 已裁决无域名 IP TLS + 双端指纹
> pinning，docs/19 §10）。本节只做 Relay 本体 + 反代装载编排；安全组动作按
> `docs/ecs-security-group-policy.md` §4 执行（S1 新增 443；80 永久关闭）。

```bash
# 0) Node 22 LTS（NodeSource；需 ≥22.18——type stripping 默认启用；22.6–22.17 在 ExecStart
#    追加 --experimental-strip-types。Ubuntu 24.04 自带 nodejs 包过旧，不可用）
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs sqlite3

# 1) 目录与用户
sudo useradd -r -s /usr/sbin/nologin devhub-relay
sudo install -d -o devhub-relay -g devhub-relay -m 750 /opt/devhub-relay /var/lib/devhub-relay
sudo rsync -a --exclude node_modules --exclude data ecs-relay/ /opt/devhub-relay/   # 仓库内 ecs-relay/
sudo chmod 755 /opt/devhub-relay/scripts/backup.sh
cd /opt/devhub-relay && sudo -u devhub-relay npm install --omit=dev

# 2) 证书（自签 IP SAN；模板权威 = docs/ecs-relay-deploy/，此处引用不重写）
sudo ./docs/ecs-relay-deploy/gen-ip-cert.sh          # 输出 /etc/devhub-relay/tls（server/ca/spki 指纹）
# 指纹分发：spki-sha256.txt → Android TlsPinningConfig（R3）+ relayClient 指纹配置（R1）

# 3) 注册码（外置凭据红线：0600，仅此项；用后可移除）
echo "RELAY_REGISTRATION_CODE=$(openssl rand -hex 32)" | sudo tee /etc/devhub-relay/env
sudo install -m 600 -o devhub-relay -g devhub-relay /etc/devhub-relay/env /etc/devhub-relay/env

# 4) systemd
sudo cp deploy/devhub-relay.service deploy/devhub-relay-backup.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now devhub-relay devhub-relay-backup.timer

# 5) 反代（Caddy / nginx 二选一；实例化版在本目录 deploy/）
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy

# 6) host 首装注册（Windows relayClient 侧执行一次；docs/19 §2.2）
curl -X POST https://59.110.149.11/relay/host \
  --cacert ca.crt -H "Authorization: Bearer <注册码>" -d '{"hostName":"home-pc"}'
# → 201 {hostId, credential}；credential 存 %LOCALAPPDATA%\DevHub\relay\credential（0600，不入仓库/日志）

# 7) 验收
sudo -u devhub-relay npm run selfcheck   # 59 项全过
curl --cacert ca.crt https://59.110.149.11/v1/health   # 200 {ok,name,version,upstream}
```

运维：`journalctl -u devhub-relay -f`（结构化日志，零凭据）；备份在 `/var/lib/devhub-relay/backups/`
（滚动 7 份，0600，绝不离机）；relay.db 可丢（host 回填即恢复，事实源永在 Windows）。

## 与 docs/18/19 的实现面注记与偏离单（R1/R3 对拍必读）

1. **event 帧双 `type` 键裁定**：docs/18 §3.6 示例中判别键与事件类型同为 `type`（JSON 重复键
   非法）。fixture（`test/fixtures/frames.json` meta.conventions）裁定：判别 `type:'event'`
   （§3.0 总表 #6 / docs/19 §7.2 RelayCodec 帧清单），事件类型承载于 **`eventType`** 字段
   （§4.1 改名的值语义保留）。R1/R3 须按此对拍；契约修订须回 docs/18 广播（docs/20 §2.4）。
2. **token_rotation 路由字段**：docs/18 §3.14 H→E 帧形无路由目标，ECS 无法定位 relay_devices
   行（sha256(newToken) 两平面同步，docs/19 §2.4）。实现要求帧携带 **`deviceId`**（Windows 侧
   `remote_devices.id`），缺失 → error BAD_PAYLOAD（注册表零改动）。R1 发送侧需带该字段。
3. **host 控制帧 `register_pairing`**：docs/19 §4.5 pairingBridge 明文要求的同步消息
   （`{pairingId, code_hash, expiresAt}` → `pairing_codes` 落表；审计动作
   `pairing_code_registered` 即 docs/19 §5.3 所列）。属 host 腿控制面，不计入 16 帧协议面
   （fixture 中单列于 `hostControlFrames`）。
4. **host 首装注册端点**：docs/19 §2.2「relayClient 首次连接携带注册码 → 签发 Relay 凭据」。
   实现为 `POST /relay/host`（与 WS upgrade 同路径、GET/POST 分离；一次性注册码 Bearer；
   鉴权失败限流同参）。它属部署面操作，不在 docs/18 §7.1 设备 REST 五端点范围内。
5. **requestId 内部重写**：设备/REST 发起的 agent_list/session_list/message 中继帧，ECS 以
   内部 UUID 重写 requestId 路由 host，回宿时回显客户端原 requestId（防跨设备 requestId 碰撞
   抢答；客户端可见契约 = 「响应帧原样回显」不变）。command 帧原样中继（幂等路由走
   `(deviceId, idempotencyKey)` + `request_id` 列）。
6. **排队命令的持久化边界**：命令帧内嵌端到端 `auth`（Token 明文）受 docs/19 §8 红线约束
   绝不落盘——排队持久层只存脱敏 payload + 幂等状态行；完整帧仅在内存（重启即失）。重启后
   恢复路径 = 状态行持久（queued）+ 设备 QueueReplay 同 key 补发（docs/18 §3.8）→ ECS 刷新
   内存帧 → host 上线按 `requested_at` 序投递。selfcheck 第 6 项即此链路。
7. **WS close 帧附 reason**：服务端 close 帧附 UTF-8 reason（≤123B，RFC 6455 §5.5.1 允许；
   gateway/ws.ts 蓝本为 code-only）。便于「pair required」等关闭原因端侧诊断。
8. **relay_commands 追加列**：在 docs/19 §5.3 草案之上追加 `session_ref`/`request_id`/
   `payload_fingerprint`（幂等冲突判定与 ack 路由所需；append-only，不改既有列）。
9. **stdin `shutdown` 指令缝**：bin 直载模式下 stdin 收到 `shutdown` 行触发与 SIGTERM 同一
   优雅停机路径（Windows 无信号投递，冒烟/自检用；systemd stdin=/dev/null 无影响）。
10. **测试参数缝**：TTL/淘汰/限流上限等可用 `RELAY_*` env 覆盖（`src/config.ts`），缺省 =
    生产值原样；生产部署不设这些变量即为 docs/18/19 权威值。
