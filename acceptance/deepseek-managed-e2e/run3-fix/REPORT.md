# run3-fix REPORT — DSW 批真机验证（DeepSeek managed 工作区生产旋钮）

> 批次：DSW（docs/briefs/dsw-workspace.md §2）。验证主体：run3 阻断修复——
> spawn cwd/workspaceRoot 默认曾=用户 home 根 → dsh 沙箱 temp-root 撞 Windows
> ACL → initialize 30s 超时 → COMMAND_NOT_EXECUTABLE（acceptance/mobile-chat-
> relay-e2e/run3/）；本批默认改安全目录 `%APPDATA%\DevHub\dsh-workspace`
> （DEVHUB_HOME 策略感知）+ 显式键 + caps workspace 用户面显示。
> 分支 agent/dsw-workspace（commit d129a47 修法 + 本证据 commit）。

## 验证序列（provider 级；隔离 DEVHUB_HOME 临时实例，常驻实例零触碰）

| 步骤 | 结果 | 证据 |
|---|---|---|
| 键=1 + 工作区键缺行 → 默认解析 | PASS：`= <DEVHUB_HOME>\dsh-workspace`；门读取零写盘（目录 spawn 前不在位） | e2e-log.jsonl、m0-workspace.json |
| caps（新面） | PASS：mode=managed granted=[reply] **workspace=<默认工作区>** | caps-managed.json |
| M0 initialize 时延微探针（零推理） | **PASS：spawn→应答 587ms；write→应答 77ms**（run3 = 30000ms 预算耗尽）；serverInfo `deepseek-harness-sdk-runtime/0.0.1` 哨兵过；shutdown 应答后 exit 0（25ms） | m0-initialize.json |
| M0 工作区按需创建 | PASS：ensure created=true（0700 语义），目录在位 | m0-workspace.json |
| T1 startManagedSession（真实推理 1/1） | **PASS：全程 613ms**（spawn+initialize+prompt 受理；run3 失败的正是本调用） | t1-start.json |
| T1 回合流式 | PASS：3 段 assistant 投影「收到」「。」「收到。」；前两段先于 idle，committed 段与 idle 同毫秒到达（ms 分辨率并列，非回归——DM 批同款竞态事实） | t1-timeline.json |
| observed 同一性 + 工作区运行期实锤 | PASS：observed listSessions 见同一 sessionId；**harness projectKey 目录 = `--C-Users-...-devhub-dsw-fix-PLY2LB-dsh-workspace--`（spawn cwd 归一化编码，含安全目录段；run3 同位证据 = home 根编码）** | identity-observed.json |
| 键归 0 可撤销 | PASS：caps 回 observed（workspace 键不携带，legacy 逐字节形态）；startManagedSession 结构化拒绝（reason 点名键名） | caps-reverted.json、e2e-log.jsonl |
| 常驻实例还原 health×3 | PASS：uptime 5746→5748→5750 连续递增（零触碰） | health-x3.json |

## initialize 时延对照（任务书指定入册项）

| | run3（修复前） | run3-fix（本批） |
|---|---|---|
| spawn cwd | 用户 home 根 | `%APPDATA%\DevHub\dsh-workspace`（隔离实例下=DEVHUB_HOME 同策略解析） |
| initialize | **30000ms 超时耗尽** → COMMAND_NOT_EXECUTABLE | **587ms 全程应答（write→应答 77ms）**，提升 ~51×（以 30000/587 计） |
| startManagedSession | 失败 | 613ms 全链受理 + 回合完成 |

## 推理消耗（如实）

- 整轮验证 runner 重跑 2 次（第 1 次 runner 自身 identity 断言过严失败在验证后段，
  T1 回合已完成；第 2 次全绿）→ **共消耗 2 条最小 prompt**（"请直接回复：收到。
  不要使用任何工具。"）。M0 微探针零推理（initialize+shutdown，无 prompt）。
- 垃圾会话：`~/.dsh/sessions/` 新增 2 个 projectKey 目录（两个临时 home 令牌各一，
  observed 面可见）。

## 凭据三零

- 零读取 `~/.dsh/.credentials.yaml`；spawn env 只增 `DSH_CORDIS_CONFIG`（配置路径）
  + shell 式代理路由 env（非凭据，DM 批同款）；全部证据文件零 key 值。

## 偏差与限制（如实）

1. runner 首跑 identity 断言写严（要求 snapshot.workdir=工作区；实测 projcache
   identity.cwd 缺行 → workdir=n/a，DM 批同款）→ 改用 projectKey 目录编码断言
   （证据力更强：harness 侧 cwd 编码直接可查）；重跑一次产生上列 2 条消耗。
2. T1 committed 消息与 idle 同毫秒到达（`all before idle=false` 的 ms 并列），
   与 DM 批「43 段先于 idle」的流式证据不矛盾——本轮仅 3 段短回复，粒度粗。
3. 默认工作区实际落位随隔离实例为 `%TEMP%\devhub-dsw-fix-*\dsh-workspace`
   （DEVHUB_HOME 感知即修法语义）；生产桌面实例下落 `%APPDATA%\DevHub\dsh-workspace`，
   由 dsh-102 夹具断言与 paths 边界单测锁定。
4. 手机全链 E2E 归主控 RD run4（本批不做）；mobile 侧已带 workspace 显示面
   （AgentsScreen 启动面板 + SessionDetailScreen ⓘ 弹层）与解析单测。

## 门禁（修法 commit d129a47）

- typecheck 0；fast **132/132**；full **232/232**；build ✓；
- Android（mobile 面改动）：`:app` **177**（基线 176+1 新增 workspace 解析单测）
  0 失败；`:core` **316** 0 失败。
