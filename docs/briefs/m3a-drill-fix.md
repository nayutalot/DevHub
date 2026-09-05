# M3-A⑤ 收尾批任务书（loadtest 客户端读模式整改 + 仪表拆除 + ECS 验证）

> 背景：M3-A 部署已完成（服务在 ECS 跑、selfcheck 59/59），唯 loadtest ⑤ 段在 ECS 上失败。主控已完成完整根因侦查（证据链见 §1），**结论已定，不要重复侦查**，从修复实施开始。

## 0. 占用资源清单（机器资源登记）

- **ECS 59.110.149.11**：SSH 密钥 `~/.ssh/devhub_ecs`（`ssh -i ~/.ssh/devhub_ecs -o BatchMode=yes root@59.110.149.11`，密钥已装好，**绝不使用/出现任何密码**）；可操作 /opt/devhub-relay、`systemctl restart devhub-relay`；**frps（7000/8746）绝不碰**
- 本地无 8746-8755 端口占用（ecs-relay 自含，node --test 随机端口）；DevHub 主仓门禁零触碰
- 工作目录：`F:\Active_Project\DevHub`（**只动 `ecs-relay/` 子目录**），git 分支 `agent/m3a-drill-fix`（从当前脏树创建，改动会带过去）

## 1. 主控已查明的事实链（信任它，别重查）

1. relay 服务本身正确：ECS 上 selfcheck 59/59、node --test 76/76、扇出零丢失（63 设备×200 帧 ~1s 内全达）、排队/幂等/撤销/优雅停机全过
2. ⑤ 失败根因**不在服务器**，在 loadtest 客户端的病态模式：每设备只读首帧就停读 + 63 socket 单线程解析风暴 → 客户端接收缓冲黑洞 → `ss -tni` 见 4 条 socket `bytes_retrans:199` 永不确认；device#1 的 ack 帧写已达内核（write cb ok、buffered=0）但 tcpdump 证明从未上线——被黑洞吞掉。反证：客户端持续读的 drain 场景满分通过；换 devices[1] 发同型命令**瞬间拿到 queued:true ack**
3. 已修的服务器真缺陷（**保留，勿删**）：`forwarder.ts` handleCommand 新命令路径——先武装 `queuedMemory` 再 sendToHost（hostOnline 判定滞后于 socket 已死的写入竞态兜底：RST 后 close 事件未处理时 sendToHost 仍返回 true，命令走"等 host 回 ack"后永无回执；武装后 host 未回 ack 即死 → 下次 host 上线重投 + 设备 QueueReplay 重发取 queued 应答）；`handleHostCommandAck` 改为任意回执都清武装
4. 已加的可观测性（**保留**）：`ws.ts` 两处 onText 吞异常 catch 现在打印 `[ws] frame handler error ...` 到 stderr

## 2. 当前未提交状态清单（主控会话半成品，git status 可核）

| 文件 | 处置 |
| --- | --- |
| `src/forwarder.ts` | **保留**：武装兜底修复+ack 清理；**删除**：`[dbg] ackToDevice(1)...` 行、`[dbg] device#1 inbound...` 行（onDeviceText 开头） |
| `src/ws.ts` | **保留**：两处 catch 的 stderr 错误打印；**删除**：sendFrame 里的 d1 write 回调仪表（恢复为原简洁实现+保留 catch 打印） |
| `src/server.ts` | **删除**：completeUpgrade 里的 socket.end/destroy 猴补丁仪表块（恢复原样） |
| `scripts/loadtest.mjs` | **保留**：fail() 打印 childLog 尾巴；**重写 ⑤**（§3 规格）；删除全部 `[dbg]` 调试分支（recv 超时转储/非 event 帧打印/device#2 判别/LT_HOLD——LT_HOLD 可保留为 env 门控功能但默认关） |
| `scripts/loadtest-probe.mjs`（未跟踪） | 修或删：≤30 分钟内修不好（它在本地和 ECS 都报 server not ready、原因未明）就整文件删除，提交信息注明"诊断脚手架退役，证据已记录" |
| `scripts/loadtest-probe-A.mjs`（未跟踪） | 删除（二分残渣） |

## 3. loadtest ⑤ 重写规格（对齐真实 Android 客户端行为）

1. **持续读者**：④ 首延迟采样后，为每台设备挂后台持续读循环（消耗帧+计数），直到 ⑤ 结束——客户端 socket 永不饥饿（这是根因修复的核心）
2. 时序不变：host.destroy → 200ms → device#0 首发命令（idempotencyKey `lt-idem-1`）→ 总时限 5s 等 ack → 未到则 **QueueReplay 语义重发一次**（同 key 换 nonce）→ 再守 30s → 断言 `queued:true`
3. hostOnline 写入竞态（首发走中继无 ack）可能触发也可能不触发——两条路径都必须通过；触发时打印一行说明
4. 其余（优雅停机 exit=0、RSS 采样、预算对照输出）不变
5. `npm test` 的 `node --test test/` 在部分平台把目录当模块报错——如本地复现，改 package.json test 脚本为 `node --test`（自动发现），提交注明

## 4. 门禁与部署（顺序执行）

1. 本地：`node --test` 76 全绿；`npm run selfcheck` 59/59；`npm run loadtest` 全绿（⑤ 两条路径说明）
2. 提交到分支 `agent/m3a-drill-fix`（增量提交：仪表拆除一 commit、⑤ 重写一 commit、修复保留部分若需单独 commit 拆开；每次 commit 后 `git push origin agent/m3a-drill-fix`）
3. ECS 部署：tar 管道上传 src+scripts → chown devhub-relay → `systemctl restart devhub-relay` → `systemctl is-active` + `curl -s http://127.0.0.1:8443/v1/health`（200）
4. ECS 验证：selfcheck 59/59 + loadtest 全绿（记下 ⑥ 的 Linux RSS 数字——验收线③要的就是这个）
5. **若 ECS loadtest 仍失败**：停止修改，抓全证据（审计尾巴/childLog/ss -tni，必要时 tcpdump），按四分类上报"环境阻塞"，**绝不**超出 §2/§3 规定继续改服务器

## 5. 铁律

- 只动 `ecs-relay/`；绝不 --no-verify；增量提交+推送；SSH 一律 `-i ~/.ssh/devhub_ecs -o BatchMode=yes`，**任何密码/凭据零出现**（仓库/日志/报告）
- frps/systemd 其它单元零触碰；ECS 操作只限 §4.3 范围
- 汇报四分类：已完成并验证/仅本地验证/环境阻塞/待用户，必带分支名+SHA+各项数字+保留/删除清单+推送状态
