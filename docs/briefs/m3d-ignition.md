# M3-D 72h 稳定期点火批任务书（常驻重启+T0+巡检起跑）

> 前置（主控确认才派发）：C8a 已合 main 四门禁全绿已推；R-B 表已收口至"除用户裁决项外全过"（R-B2/3/4/6/7/9+R-B8 协议等价面全 PASS；R-B5 managed 回流与 R-B8 UI 面=#9 用户裁决项不阻塞稳定期观察）。
> 本批=点火+首周期确认，**72h 观察期本身无人值守**（巡检面=m3d-watch 自动落 ndjson，后续会话 --summary 巡检）。

## 0. 占用资源

- 8746+常驻（本批独占；模拟器不用；ECS 零连接——巡检全走公网只读面）
- 分离巡检进程：`node scripts/m3d-watch.mjs`（只读 GET+SSH --deep 不可用属可接受降级）
- 不跑门禁不改代码；零仓内提交

## 1. 任务

1. **账面清理**：`node acceptance/agents-mobile/m3c8a-orphan-revoke.mjs` 幂等复跑（门禁 uxa-147 会产生配对残留行；#46/#52 在役勿动由脚本语义保证——快照留汇报）
2. **常驻重启**：纯生产形态起 `F:\Active_Project\DevHub\dist\win-unpacked\DevHub.exe`（现包=main 桌面全量，05:57 构建>C7b 合入；C8a 零桌面改动无需重打包）→ curl 8746 health 200 → 核 PID+镜像名 DevHub.exe → 等 relay 重连（≤90s）→ m3d-watch 单周期 connected=true
3. **T0 点火**：删除旧 t0.txt（D 批测试值）→ 分离进程起 72h 巡检：
   ```
   PowerShell: Start-Process -WindowStyle Hidden node -ArgumentList 'scripts/m3d-watch.mjs','--t0','--loop','15','--out','C:\Users\sakuya\AppData\Local\DevHub\m3d-watch\watch-m3d-72h.ndjson'
   ```
   （工作目录=F:/Active_Project/DevHub；**全新独立 ndjson** 与历史测试周期隔离）
4. **首周期确认**：≥20s 后读新 ndjson 首行 JSON——四检查应全 ok（gateway ok/relay connected=true/publicRelay ok/cert ~88 天）→ 原文留汇报
5. 记录：T0 ISO 时刻、72h 预计终点（T0+72h）、巡检进程 PID（node）+确认进程存活（tasklist）

## 2. 铁律

不改代码不跑门禁；ECS 零连接；凭据三零；巡检进程必须分离存活（agent 退出不连带——Start-Process 独立进程非作业子进程）；失败重试 ≤2。

## 3. 汇报（四分类）

T0 ISO+72h 终点+首周期 JSON 原文+巡检进程 PID+账面清理快照+常驻终态（PID/connected）；后续巡检命令一行（`node scripts/m3d-watch.mjs --summary <ndjson>`）。
