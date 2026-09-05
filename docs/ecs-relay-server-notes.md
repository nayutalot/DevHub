# ECS Relay 服务实现笔记（M2-R2，ecs-relay/）

> 批次：M2-R2（docs/20 §2.2），分支 `agent/ecs-relay-server`（基线 28e0f38）。
> 服务落位 = DevHub 仓内子目录 `ecs-relay/`（主控裁决形态）：自含 package.json/tsconfig/
> 独立 node_modules（不 junction 主仓）/自含 .gitignore，零污染 DevHub 四门禁；
> 其 selfcheck 不进 DevHub 门禁（G11「永远存在的未验证区」隔离原则）。
> 详细偏离单与对拍须知 = `ecs-relay/README.md`「实现面注记与偏离单」（10 条）；本文件为索引。

## 1. 交付物对照（docs/20 §2.2 范围逐项）

| 范围项 | 落点 | 状态 |
| --- | --- | --- |
| Node 22 LTS + node:http + 自研 WS（ws.ts 移植） | `ecs-relay/src/ws.ts`（掩码/分片/1MB/1002/1003/1009/ping-pong/close 回显逐行移植；两腿同一连接类） | ✓ |
| node:sqlite 独立库 + 独立迁移 | `src/store.ts` + `sql/0001_init.sql`（docs/19 §5.3 八表）+ `scripts/migrate.mjs`（幂等，relay_meta.schema_version） | ✓ |
| 模块 server/ws/rest/auth/pairing/forwarder/cache/store/audit | `src/` 十二模块（+config/errors） | ✓ |
| 缓存淘汰（TTL 72h + 容量两级） | `src/cache.ts`：全 ack+72h 删 payload → 元数据行 7 天整行删；软 25k 行/100MB → 硬 50k 行/200MB；capacity 删前审计 `relay_cache_evicted`（hasGaps 语义） | ✓ |
| 命令排队/过期 | `src/forwarder.ts`：host 离线 queued:true（幂等应答）、上限 100/设备 1000/全局 → RELAY_QUEUE_FULL、TTL 300s 过期置 expired + COMMAND_EXPIRED 回流、同 key 异 payload → COMMAND_KEY_CONFLICT、终态重试返回原结果（docs/14 §B.5） | ✓ |
| 限流三件套（同参 docs/14 §B.4） | `src/auth.ts`：鉴权失败 5/60s/源、常规 120/min/设备（120 次放行 off-by-one 语义）、claim 5/5min/源；REST + WS upgrade + host 注册三处接线 | ✓ |
| 错误映射 docs/18 §8 | `src/errors.ts`：26 码 HTTP/WS 双面映射 + Retry-After | ✓ |
| systemd 单元 + Caddy 反代模板（整合 docs/ecs-relay-deploy/） | `ecs-relay/deploy/`（service + backup timer + Caddyfile/nginx 实例化版；模板权威不重写） | ✓ |
| .backup 每日滚动备份 | `scripts/backup.sh`（sqlite3 .backup × 7 份）+ timer | ✓ |
| selfcheck.mjs（docs/19 §5.7 清单） | `src/selfcheck.mjs`（59 项，见 §3） | ✓ |
| 帧集 fixture | `ecs-relay/test/fixtures/frames.json`（16 帧 + hostControlFrames，逐帧标注 docs/18 出处章节，R1/R3 对拍共用） | ✓ |
| 不做（裁决） | TLS 终结/多租户/approve 语义理解——均未实现（approve 纯透传，e2e 有透传断言） | ✓ |

## 2. 门禁数字（本批实测）

| 门禁 | 结果 |
| --- | --- |
| `tsc --noEmit`（自含 tsconfig，erasable-only） | 0 错误 |
| `node --test` | **76/76 全绿**（编解码 11 + 鉴权 12 + 配对 8 + 缓存 7 + 中继编排 20 + REST 10 + e2e 8），全程 ≈7s |
| 启动冒烟 `npm run smoke` | 裸进程 → /v1/health 200 → 优雅停机 exit 0 |
| `npm run selfcheck` | **59/59 ALL GREEN**（docs/19 §5.7 七项清单 + 容量预算护栏） |
| `npm run loadtest` | 64 条长连 74ms 建立完毕；63 扇出 × 200 突发首达延迟 p50=2ms/p95=3ms（2C2G 实机 RSS 待部署演练取值，脚本已备） |

测试端口纪律：全部 127.0.0.1 + 端口 0（OS 随机高端口），绝不占 8746-8755，绝不监听 0.0.0.0。

## 3. selfcheck ↔ docs/19 §5.7 清单对照

1. 帧编解码一致性 = fixture 16 帧 35 样例进程内 round-trip + 16 帧全部经真实套接字走通
   （hello/pair/pair_accepted/agent_list/session_list/message/command/command_ack/
   command_result/sync_request/sync_response/heartbeat/token_rotation/disconnect/error +
   register_pairing 控制帧）。
2. 配对全流程 = register_pairing → 裸连接 pair（明文码不出 device leg）→ pair_accepted
   （Token 一次性过境，sha256 落库）→ Bearer 重连。
3. 命令排队/过期 = queued:true 幂等应答（专用短 TTL 实例验证 COMMAND_EXPIRED 回流）。
4. 缓存淘汰与 hasGaps = 容量两级两级触发 + TTL 72h payload 淘汰 + 缺号/元数据行双场景
   hasGaps=true。
5. 限流三态 = REST 鉴权失败 5/60s → 429 + Retry-After（真实 HTTP）+ 三件套窗口语义。
6. 重启恢复 = 优雅停机（POSIX SIGTERM / Windows stdin 指令缝）→ 同库重启 → 排队状态行持久 →
   设备补发（QueueReplay）→ host 上线投递 → ack 回流。
7. 红线断言 = relay.db 字节级 + 进程日志 + relay_audit.detail 抽样：零 Token/码/凭据/注册码明文。
8. 容量预算护栏 = 生产默认值断言（127.0.0.1:8443、≤64 连接、TTL 300s、队列 100/1000、缓存
   25k/50k、payload 72h）。

## 4. 关键实现裁定（详见 ecs-relay/README.md 偏离单 10 条）

- **event 帧双 `type` 键裁定**（对拍关键字段）：判别 `type:'event'` + 事件类型在 `eventType`
  （docs/18 §3.6 示例 JSON 重复键非法；fixture meta.conventions 为三线对拍权威）。
- **token_rotation 需 `deviceId`**：docs/18 §3.14 帧形无路由目标，ECS 要求 R1 发送侧携带
  Windows 侧设备 id，否则 BAD_PAYLOAD（sha256(newToken) 两平面同步所需）。
- **register_pairing 控制帧**：docs/19 §4.5 要求的 host 腿同步消息（pairing_codes 落表）。
- **host 首装注册 = POST /relay/host**：部署面操作（一次性注册码 → 256-bit Relay 凭据）。
- **排队命令持久化边界**：auth（Token 明文）绝不落盘（docs/19 §8 红线）→ 持久层只存脱敏
  payload + 幂等状态行；重启恢复 = 状态行 + 设备补发（docs/18 §3.8 QueueReplay）。
- **upgrade socket allowHalfOpen=true**：对端 FIN 只触发 'end' → 已加 end→destroy 缝
  （半开连接假活防线，W-R8 的套接字层补强）。

## 5. R1/R3 对拍接口清单（契约面）

- fixture：`ecs-relay/test/fixtures/frames.json`（三批只读共用；修订须回 docs/18 广播）。
- R1 需实现：`register_pairing`/`register_pairing_ack`、`token_rotation` 携带 `deviceId`、
  三步恢复序（hello.sequence 回填 + 排队投递接收 + 实时恢复）、`sync_request{after,deviceId}`、
  command auth 校验（Windows 侧同源 auth.ts）。
- R3 需实现：RelayCodec 按 fixture 帧形解析（尤其 event 帧 eventType 字段）、累计 ACK
  （sync_request/heartbeat lastAckedSeq 只前进）、queued:true 期间挂起重试。
