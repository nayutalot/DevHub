# run4-fix REPORT — DSN 批真机验证（DeepSeek managed spawn 载体解析链）

> 批次：DSN（docs/briefs/dsn-carrier.md §3）。验证主体：RD run4 决定性隔离实验的
> 正面修法——打包常驻 spawn 载体 ELECTRON_RUN_AS_NODE='1'（electron 内置 node
> v24.19）被 harness cordis loader 拒（`failed to apply loader entry include
> (cordis:include)`）→ initialize 永不应答 30000ms 超时；plain node v24.15 同参数
> 秒答。修法 = 载体解析链三级：显式键 `deepseek_managed_node` > `where.exe node`
> 系统单源探测（AC9 npm 解析同款纪律）> 降级 + 如实标注。
> 分支 agent/dsn-carrier（commit f7a1470 修法 + 本证据 commit）。

## 验证序列（provider 级；隔离 DEVHUB_HOME 临时实例，常驻实例零触碰）

| 步骤 | 结果 | 证据 |
|---|---|---|
| L2 解析链二级（本机主链） | **PASS：level=system，`C:\Program Files\nodejs\node.exe`（node v24.15.0）**，where.exe+哨兵全程 **164ms**；env `{}`（纯 node 零开关） | carrier-l2.json |
| L2 哨兵缓存 | PASS：第二次解析 182ms（哨兵命中缓存零重跑；where 按设计重探） | carrier-l2-cache.json |
| L1 显式键命中 | PASS：`deepseek_managed_node`=<系统 node> → **level=explicit**（0ms，哨兵缓存命中）；where 未被探测 | carrier-l1.json |
| L1 缺失文件 | PASS：键指向不存在路径 → 门读取**同步结构化拒**（零 spawn；人话点名键名+展开后路径） | carrier-l1-missing.json |
| L3 降级演示 | PASS（**注入缝演示，非真实缺 node**——如实标注 injected）：ELECTRON_RUN_AS_NODE='1' + 逐字标注「载体降级：需系统 Node.js（harness loader 不兼容 Electron 内置运行时）」 | carrier-l3-injected.json |
| caps（新面） | PASS：mode=managed granted=[reply] workspace=<默认安全目录>；**evidence 带「spawn carrier: level 2 system node via where.exe → …（node v24.15.0）」**；系统命中面无降级标注 | caps-managed.json |
| M0 initialize 时延微探针（零推理） | **PASS：spawn→应答 582ms；write→应答 82ms**（run4 同位 = 30000ms 预算耗尽 COMMAND_NOT_EXECUTABLE）；spawn 命令 = 解析链生效载体（**非 process.execPath**）；serverInfo `deepseek-harness-sdk-runtime/0.0.1` 哨兵过；shutdown 应答后 exit 0（25ms） | m0-initialize.json |
| T1 startManagedSession（真实推理 1/1） | **PASS：全程 780ms**（解析链载体 spawn + initialize + prompt 受理）+ 回合完成：3 段 assistant 投影「收到」「。」「收到。」 | t1-start.json、t1-timeline.json |
| observed 同一性 | PASS：observed listSessions 见同一 sessionId（mode=managed）；harness projectKey 目录 = spawn cwd 归一化编码（含 dsh-workspace 段） | identity-observed.json |
| 诊断投影 | PASS：describeDiagnostics control note 带 `spawn carrier: level 2 system node via where.exe → …`（命中级如实） | diagnostics.json |
| 键归 0 可撤销 | PASS：caps 回 observed（**evidence 与 DEEPSEEK_CONTROL_NOTE 逐字节相等**）；startManagedSession 结构化拒绝 | caps-reverted.json |
| 常驻实例还原 health×3 | PASS：uptime 2476→2478→2480 连续递增（零触碰） | health-x3.json |

## 时延对照（任务书指定入册项）

| | run4（修复前，打包常驻） | run4-fix（本批） |
|---|---|---|
| spawn 载体 | electron 内置 node v24.19（ELECTRON_RUN_AS_NODE='1'）→ cordis loader 拒 | **系统 node v24.15（where.exe 单源 + 哨兵放行）** |
| initialize | **30000ms 超时耗尽** → COMMAND_NOT_EXECUTABLE | **582ms 全程应答（write→应答 82ms）**，~51×（以 30000/582 计） |
| startManagedSession | 失败 | 780ms 全链受理 + 一条最小 prompt 回合完成 |

## 修法语义说明（如实）

本 runner 为库模式（plain node 进程）。M0/T1 的 spawn 命令**显式取自解析链生效载体
`carrier.command`（where.exe 解析的绝对路径），绝非 process.execPath**——打包常驻
场景同链路：解析链命中系统 node 后即不再依赖 process.execPath（其时为 electron.exe，
仅在三级降级形态被使用，且降级面带逐字标注）。run4 的失败机理（electron 载体被
cordis loader 拒）在本批由载体替换直接消除。

## 推理消耗（如实）

- 整轮验证 runner 一次跑通全绿 → **共消耗 1 条最小 prompt**（T1「请直接回复：收到。
  不要使用任何工具。」）。M0 微探针零推理（initialize+shutdown，无 prompt）。
- 垃圾会话：`~/.dsh/sessions/` 新增 1 个 projectKey 目录（临时 home 令牌，observed
  面可见）。

## 凭据三零

- 零读取 `~/.dsh/.credentials.yaml`；spawn env 只增 `DSH_CORDIS_CONFIG`（配置路径）
  + shell 式代理路由 env（非凭据，run3-fix 同款）；全部证据文件零 key 值（已扫描
  sk-/api_key/apikey/credential 模式，唯一命中为 runner 自述「zero credentials」字样）。

## 偏差与限制（如实）

1. L3 降级真机证据为**注入缝演示**（where 失败缝）——本机系统 node 在位，真实
   「无系统 node」场景无法在不破坏环境的前提下制造；单测 dsh-107 已用同款注入缝
   锁定降级面行为（env 开关 + 逐字标注 + caps/诊断投影），语义等价。
2. T1 第 3 段 committed 消息与 idle 同毫秒到达（`all before idle=false` 的 ms 并列），
   run3-fix 同款已知现象（短回复 3 段粒度粗，非流式回归）。
3. L2 缓存证明数字（164ms→182ms）不含哨兵重跑（哨兵缓存命中），where.exe 按设计
   每次重探（不缓存 where 结果——用户装机后无需重启即恢复；缓存的只有哨兵成功值）。
4. 手机全链 E2E 归 RD run5（任务书明示本批不做）；caps evidence 载体行随既有
   详情 ⓘ/启动面板 evidence 展示链路自然上屏，无新增 UI 面（改动面收在载体解析
   +诊断投影+单测）。

## 门禁（修法 commit f7a1470）

- typecheck **0**；fast **133/133**（基线 132 + dsh-107）；full **233/233**
  （基线 232 + dsh-107）；build ✓（electron-vite）。
