# DevHub IPC API 设计（Phase 1）

## 1. 传输模型

- **单一网关 channel**：`devhub:invoke`（全局唯一，约束 #17）。
- 请求 payload：`{ channel: string, payload?: unknown }`。
- 响应（Result envelope，全局统一）：
  - 成功：`{ ok: true, data: T }`
  - 失败：`{ ok: false, error: { code: string, message: string } }`
- 网关按白名单分发到对应 service handler；未注册 channel 返回
  `{ ok:false, error:{ code:'CHANNEL_NOT_ALLOWED', message } }`。
- preload 经 contextBridge 仅暴露 `window.devhub.invoke(channel, payload)` 一个方法（约束 #18）。

## 2. 白名单（21 条 channel）

### 扫描（scan）

| channel | payload | result data |
| --- | --- | --- |
| `scan:start` | `{ kind: 'full' \| 'projects' \| 'services' \| 'environment' }` | `{ scanId: number }` |
| `scan:status` | `{ scanId?: number }`（缺省返回最近一次） | `ScanStatus`：`{ scanId, kind, rootPath, status: 'running'\|'done'\|'cancelled'\|'failed', startedAt, finishedAt, foundCount, errorSummary }` |
| `scan:cancel` | `{ scanId: number }` | `{ cancelled: boolean }` |

### 项目（projects）

| channel | payload | result data |
| --- | --- | --- |
| `projects:list` | `{}` | `ProjectSummary[]`：`{ id, name, slug, winPath, wslPath, runtimeHint, lastOpenedAt, updatedAt, hasGit, dirtyCount }`（`updatedAt` 为 Step 8c F5 补充的 projects.updated_at 投影） |
| `projects:get` | `{ id: number }` | `ProjectDetail`：summary + `repositories[]` + `containers[]` + `services[]` + `environments[]`（完整关系）。M2 增补（追加字段，renderer 不受影响）：`skills` / `mcpServers` / `archives` 三个 `{ notAvailable: true, reason: 'TABLE_EXISTS_NO_SERVICE' }` 显式占位（docs/08 §6.4：三张表已建但无 service 实现，不猜测）+ `relationships[]`（resources/relationships 读查询的关系边投影 `{ relation, direction, resourceType, refId, displayName }`） |
| `projects:add` | `{ winPath?: string, wslPath?: string, name?: string, description?: string, runtimeHint?: string }` | `ProjectSummary`（新项目） |
| `projects:remove` | `{ id: number }` | `{ removed: boolean }`（级联清理关系） |
| `projects:rescan` | `{ id?: number }`（缺省全量重扫） | `{ scanId: number }` |
| `projects:update` | `{ id, name?, description?, winPath?, wslPath?, runtimeHint? }` | `ProjectSummary`（更新后） |

### 项目操作（打开类，经 launchViaStartProcess）

| channel | payload | result data |
| --- | --- | --- |
| `projects:openFolder` | `{ id: number }`（优先 winPath，否则经 wsl 路径换算） | `{ opened: true }` |
| `projects:openVSCode` | `{ id: number, wsl?: boolean }` | `{ opened: true }` |
| `projects:openTerminal` | `{ id: number, wsl?: boolean }` | `{ opened: true }` |
| `projects:openWSL` | `{ id: number }`（要求有 wslPath 或所在发行版） | `{ opened: true }` |

### 环境（environment）

| channel | payload | result data |
| --- | --- | --- |
| `environment:detect` | `{}` | `{ environments: EnvironmentWithTools[] }`：每个环境 `{ id, name, kind, osVersion, detectedAt, tools: [{ tool, version, path, state, rawVersion }] }` |
| `environment:doctor` | `{}` | `{ checks: DoctorCheck[] }`：`{ id, severity: 'info'\|'warning'\|'error', title, detail, suggestion }`，如 Python 3.9/3.13 并存、Win Node 24 vs WSL Node 18 不一致、Docker daemon 状态 |

### 服务（services）

| channel | payload | result data |
| --- | --- | --- |
| `services:list` | `{ port?: number }`（可按端口过滤） | `ServiceRow[]`：`{ id, port, protocol, pid, processName, commandLine, workingDir, origin: 'windows'\|'wsl'\|'docker', projectId, projectName }`。M2 增补 `lastSeenAt`（services.last_seen_at；MCP devhub.services.inspect 的 snapshotAt 口径，renderer 不受影响） |
| `services:refresh` | `{}` | `{ records: ServiceRecord[], scanId: number }`（触发 services 扫描并回写归因；records 为本轮写入/更新的记录，scanId 取本次 kind='services' 扫描行 —— Step 5 决议同步） |

### 汇总与设置

| channel | payload | result data |
| --- | --- | --- |
| `dashboard:summary` | `{}` | `{ projectCount, dirtyRepoCount, dockerRunning, dockerTotal, wslStatus: { available, distros[], detail? }, serviceCount, recentProjects: ProjectSummary[], warnings: { severity: 'info'\|'warning'\|'error', title, detail }[] }`（Step 8c F5：`recentProjects` 内 `lastOpenedAt` 在项目从未打开过时回退为 `updatedAt`，保证相对时间可显示） |
| `settings:get` | `{ key: string }` | `{ key, value }` |
| `settings:set` | `{ key: string, value: string }` | `{ saved: true }` |
| `app:version` | `{}` | `{ appVersion, electronVersion, nodeVersion }` |

合计：3（scan）+ 6（projects CRUD）+ 4（open 类）+ 2（environment）+ 2（services）+ 4（dashboard/settings/app）= **21 条**。

## 3. 实现规则

- gateway 只做：校验白名单 → 参数校验（形状）→ 调 service → 包装 envelope → 捕获一切异常折叠为 `ok:false`（约束 #14）。
- 所有 open 类 channel 在执行前校验目标存在（项目 / 路径），不存在返回 `NOT_FOUND`。
- open 类全部经 exec 的 `launchViaStartProcess`（PowerShell 静态字面量 + `$env:` 传参，约束 #12）。
- `scan:start` 幂等：同一时刻只允许一个 running 扫描，重复调用返回当前 scanId。

## 4. 增补白名单（S2-S4 追加模式，docs/09 §9 权威）

Phase 1 的 21 条之上，合并批次按 docs/09 §9 的授权以追加模式扩展白名单（同一
`devhub:invoke` 网关与 Result envelope，规则不变）：S2 skills 14 条（21→35）、
S3 apihub 6 条 + versions 4 条（35→45）、S4 docker 3 条 + wsl 2 条（45→**50**）、
S5 archive 5 条（50→**55**，docs/10 全文权威）。
S2/S3 条目的 payload/result 契约见 docs/09 §9；S4 条目如下；S5 条目见本节末尾。

### Docker（S4，docs/09 §9 按文档命名 overview / logs / action）

| channel | payload | result data |
| --- | --- | --- |
| `docker:overview` | `{}` | info + containers + images 三合一：`{ status: { available, cliAvailable, daemonAvailable, clientVersion?, serverVersion?, reason? }, containers: [{ dockerId, name, image?, state?, ports[], project }], images: { available, reason?, images: [{ repository, tag, imageId, size, createdAt }], count, danglingCount } }`。daemon 不可用 → `available:false` + 空容器表 + images 结构化降级（常态而非异常，docs/02 §4） |
| `docker:logs` | `{ name, tail?, since? }`（name 为容器名/ID，白名单字符集 `[A-Za-z0-9][A-Za-z0-9_.-]{0,127}`；tail 非负整数、>500 截到 500、负数/非整数 BAD_PAYLOAD；since 为秒） | `{ ok, name, tail, text, truncated?, error? }`：只读拉取，stdout/stderr 合并，超 64KB 截断并置 `truncated:true`；daemon 不可用 → `{ ok:false, text:'', error: reason }` |
| `docker:action` | `{ name, action: 'start'\|'stop'\|'restart'\|'remove', confirmed? }`（action 枚举之外 BAD_PAYLOAD；docs/09 §8.3 CONFIRM_REQUIRED；夜间#1 批次落地 remove：DOUBLE_CONFIRM 档，UI 确认步要求输入容器名精确匹配，docs/09 §8.1） | 未带 confirmed → `{ confirmRequired: true, impacts: { name, image?, state?, ports[], project?, note? } }`（remove 分支 ports 恒空、note 声明数据面影响）；confirmed → `{ ok, name, action, detail?, error?, degraded? }`（成功后刷新 containers 缓存；remove 映射 `docker rm` 字面量、不带 -f —— running 容器由 daemon 拒绝；daemon 不可用 → `ok:false + degraded:true`） |

### WSL（S4，docs/09 §8.2/§9 授权随 Environment 扩展批次并入）

| channel | payload | result data |
| --- | --- | --- |
| `wsl:action` | `{ distro?, action: 'terminate'\|'boot'\|'shutdownAll', confirmed? }`（terminate/boot 的 distro 白名单 = 已知发行版列表，非白名单 BAD_PAYLOAD；夜间#1 批次落地 shutdownAll：CONFIRM_REQUIRED + 二次确认文案，全停语义、不接受 distro 参数，传了即 BAD_PAYLOAD） | terminate 未带 confirmed → `{ confirmRequired: true, impacts: { distro, state, listeningPorts: [{ port, address, pid, processName }], note? } }`（绝不执行）；confirmed → `{ ok, distro, action, detail?, error? }`。boot 无害幂等（`wsl.exe -d <distro> -e true`），直接执行返回 `{ ok, distro, action, detail?, error? }`。shutdownAll 未带 confirmed → `{ confirmRequired: true, impacts: { distros: [{ name, state }], dockerDesktopDistros[], note? } }`（将停的全部发行版清单，绝不执行）；confirmed → `wsl.exe --shutdown` → `{ ok, action: 'shutdownAll', runningBefore, totalBefore, detail?, error? }`（列表探测只读，绝不唤醒已停发行版） |
| `wsl:distroStats` | `{ distro? }`（缺省 = 全部发行版概要；有值 = 单发行版，须在已知列表内） | `{ available, reason?, sampledAt, distros: [{ name, state, version, isDefault?, managedByDocker?, stats, reason? }] }`：stats 为一次 /proc 复合读取 `{ memTotalKb, memFreeKb, memAvailKb, load1, diskTotal, diskUsed, diskAvail, diskPct, uptimeSec }`（取不到的字段 null，绝不硬造）；**仅对 Running 且非 docker-desktop 系探测，绝不为了取数而启动已停止的发行版**（docs/09 §8.2） |

### Archive（S5，docs/10 全文权威；实现注记见 docs/10 §11）

| channel | payload | result data |
| --- | --- | --- |
| `archive:preview` | `{ projectId, destRoot? }`（destRoot 缺省读 settings `archive_dest_root`，为空绝不猜默认盘） | **强制 dry-run**（只读，绝不移动任何东西）：`{ previewId, expiresAt, impacts }`。`previewId` 为 `arc-<uuid>` 执行凭证（10 分钟 TTL，`archive:run`/`archive:status` 必须携带）；impacts = `{ projectId, projectName, oldPath, destRoot, destPath, crossVolume, occupiers[], dirLocked, depSkipDirs[], refProjects[], report: { hits[]（≤2000 截断，totalHits 保留真实值）, scannedFiles, skippedBinary, skippedOversize, errorSummary } }`。预检职能（路径存在性 / dest 本地卷与防自吞校验 / 占用进程检测 / 目录锁探测 / depSkipDirs）全部并入本 channel 返回，无独立 `archive:precheck` |
| `archive:run` | `{ previewId, confirmed?, killPids? }`（killPids 为正整数数组，必须出自 preview impacts 的 occupiers 清单） | 未带 confirmed → `{ confirmRequired: true, impacts }`（服务端二次确认半边）；confirmed → 执行 移动→路径修复→残留复核→联动，返回 `{ runId, movedFrom, movedTo, mode, fixed[], external[], totalReplacements, residualHits, skippedDeps[], skippedLinks[], sourceLeftovers[], durationMs }`；执行时仍有占用 → `PROJECT_LOCKED`（绝不移动），old_path 与 projects.win_path 不一致 → 拒绝 |
| `archive:status` | `{ previewId }` | `{ active, phase: 'moving'\|'fixing'\|'verifying'\|'done'\|'failed', percent?, logTail[]（≤30） }`；无对应执行记录 → `NOT_FOUND` |
| `archive:history` | `{ limit? }`（正整数，≤100） | `{ runs: [{ id, projectId(可空), projectName, oldPath, newPath, status: 'running'\|'done'\|'failed'\|'rolled-back', fixedFiles, externalFiles, residualHits, strippedDirs, startedAt, finishedAt, undoEntries(可空) }] }`（archive_runs 按 id 倒序，默认与上限均 100） |
| `archive:rollback` | `{ runId, confirmed? }`（runId 为 archive_runs 行 id） | 未带 confirmed → `{ confirmRequired: true, impacts: { runId, projectName, oldPath, newPath, undoEntries, fixedFiles, note } }`；confirmed → 内容还原（undo 备份逐条 copyFile 覆写，幂等）+ 目录移回原位 + projects.win_path 还原，返回 `{ runId, restored, undoEntries, movedBack, projectsRestored, status: 'rolled-back', note }`；仅 `done` 状态可回滚 |

合计（Phase 1 + S2 + S3 + S4 + S5）= 3+6+4+2+2+4 + 14 + 6+4 + 3+2 + 5 = **55 条**；
AC2 批次 agents 13 条并入（55→68，docs/14 §A.1 权威，本文件未逐行展开）；
夜间#1 批次（服务端积压补齐）追加 2 条（68→70，见下）；
CP1 批次 ContestPin 9 条并入（70→**79**，见下「ContestPin 追加」节 + docs/22 §3）；
CP2 批次 ContestPin 悬浮窗 5 条并入（79→**84**，同节 + docs/22 §4）；
CP3a 批次 ContestPin 识别配置 4 条并入（84→**88**，同节 + docs/22 §6）。

### 夜间#1 追加（服务端积压补齐批次；主控任务书授权的同一追加模式）

| channel | payload | result data |
| --- | --- | --- |
| `versions:cancel` | `{ jobId? }`（缺省 = 取消当前唯一活跃任务；多个活跃时不指定 jobId → BAD_PAYLOAD 消歧） | running job → killTree（github 重建为流水线步间合作式取消）+ `{ cancelled: true, jobId, entryId, status: 'cancelled' }`；无活跃任务 → `{ cancelled: false, note }`（结构化空操作）；未知 jobId → `NOT_FOUND`；已结束 → `{ cancelled: false, status, note }`（docs/09 §7.2 cancelled 分支的主动取消，超时兜底之外的真中断） |
| `agents:probeProvider` | `{ providerId }`（正整数；未注册 → `NOT_FOUND`） | 单家 provider 立即重探（force 语义，绕过 60s 节流）：probeHealth + agent_providers 落库 + 过期能力重验 + 该家会话快照强刷，返回 `{ provider: AgentProviderView, healthChanged }`（known-limitations §3.2 遗留的 per-provider 单独重探） |

### LR1 追加（LLM 复核层，advisory-only；用户裁决 2026-09-09 恢复，设计权威 docs/briefs/lr1-llm-review.md）

LLM 前/后复核 + Skills 元数据体检 4 条，**全 READ_ONLY**，**状态 = LR1 待落地**
（硬门：M3-D 72h 终报通过后开工；落地后白名单 88→**92**——CP3a 批次就地更新，
ContestPin 识别配置 4 条先行占 88）。advisory-only：复核结果
永不阻塞归档主流程，端点未配置/不可达 → skipped 态，全流程行为等价现状。
不改 MCP、不改归档 execute 管线。

| channel | payload | result data | 读写 | 状态 |
| --- | --- | --- | --- | --- |
| `review:testEndpoint` | `{ baseUrl, model }`（base URL 占位 `http://<lan-ip>:11434/v1`） | `{ ok, latencyMs, error? }`（连通性/延迟探测，设置卡片端点测试入口） | READ_ONLY | LR1 待落地 |
| `archive:reviewPre` | preview 既有 plan 摘要（零额外扫描，仅路径/名称/描述/计数） | 四态 envelope（ok/skipped/failed/unparseable）；ok 态含 `{ risk: 'low'\|'medium'\|'high', concerns[], rationale }`（确认弹窗咨询条展示，不拦截 DOUBLE_CONFIRM） | READ_ONLY | LR1 待落地 |
| `archive:reviewPost` | `{ runId }`（archive_runs 行 id） | 四态 envelope（同上）；run 详情查看时按需触发，结果缓存 `review_post_json`，缓存命中不再打端点 | READ_ONLY | LR1 待落地 |
| `skills:reviewMeta` | `{}` | 批量 flags（描述过短 / 语言不一致 / 疑似重复）；只读咨询不落库，doctor 语义不变 | READ_ONLY | LR1 待落地 |

### ContestPin 追加（赛程钉比赛模块；设计权威 docs/22-contestpin-design.md）

CP 系列分批落地，**状态 = CP3a 已落地（白名单 84→88，2026-09-09 CP3a 批次）**；
CP3b-CP6 待落地。CP1 首批 9 条（变更类 7 + READ_ONLY 2）+ CP2 悬浮窗 5 条
（READ_ONLY 1 + 变更类 4）+ CP3a 识别配置 4 条（READ_ONLY 1 + 变更类 3）；
全量落地（CP3b 识别管线余量/CP4/CP5/CP6）后 88→约 **110**（LR1 另 +4）。
计数断言按既有授权模式"就地更新+注记"。变更类 delete/discard 均为
CONFIRM_REQUIRED 两段式（先回 impacts）。

| channel | payload | result data | 读写 | 状态 |
| --- | --- | --- | --- | --- |
| `contestpin:list` | `{ query?, status?, archived?, limit?, offset? }` | `{ items: ContestListItem[], total }`（名称/年份模糊搜索+状态筛选，archived 缺省排除；CP2 起行内携带三链接 URL 与 dueNode/nextNode 投影） | READ_ONLY | CP1 已落地 |
| `contestpin:get` | `{ id }` | ContestDetailView（nodes/materials/reminders/关联 project；CP2 起增 dueNode/nextNode） | READ_ONLY | CP1 已落地 |
| `contestpin:create` | `{ name, year?, edition?, organizer?, note?, status?, officialSite?, signupUrl?, submitUrl? }` | ContestView（同时登记 resources contest 节点） | 变更 | CP1 已落地 |
| `contestpin:update` | `{ id, patch }` | ContestView（改名同步 resource display_name） | 变更 | CP1 已落地 |
| `contestpin:delete` | `{ id, confirmed? }` | 无 confirmed → `{ confirmRequired: true, impacts: { nodes, materials, reminders } }`；confirmed → 级联删（含 resource 节点与边） | 变更 | CP1 已落地 |
| `contestpin:archive` | `{ id, archived: bool }` | ContestView | 变更 | CP1 已落地 |
| `contestpin:nodeUpsert` | `{ contestId, node? }`（node 带 id=更新；precision 校验禁止 date→exact 提升） | ContestNodeView | 变更 | CP1 已落地 |
| `contestpin:nodeDelete` | `{ id, confirmed? }` | CONFIRM_REQUIRED 两段式 | 变更 | CP1 已落地 |
| `contestpin:linkProject` | `{ contestId, projectId: number \| null }` | `{ linked: bool }`（resources+relationships `uses` 边，INSERT OR IGNORE；null=解边） | 变更 | CP1 已落地 |
| `contestpin:overlayState` | `{}` | `{ enabled: bool, bounds: {x,y,width,height} \| null, collapsed: bool }`（非法持久化值拒绝并回默认，bounds=null → wire 层居中主显示器） | READ_ONLY | CP2 已落地 |
| `contestpin:overlaySetEnabled` | `{ enabled: bool }` | `{ enabled: bool }`（settings 持久化经 overlayStateService + overlayWire 窗口创建/show 或 hide 即时生效；托盘 checkbox 同一收敛点） | 变更 | CP2 已落地 |
| `contestpin:overlaySetCollapsed` | `{ collapsed: bool }` | `{ collapsed: bool }`（持久化 + 窗口高度调整，宽度不变；折叠态持久化高度记展开态） | 变更 | CP2 已落地 |
| `contestpin:openInMain` | `{ contestId }` | `{ opened: bool }`（存在性校验后聚焦主窗口并导航 `#contest:<id>`；applier 未注入的纯 Node 语境 → opened:false 结构化 no-op） | 变更 | CP2 已落地 |
| `contestpin:openLink` | `{ url }` | `{ opened: bool }`（validateExternalUrl 仅 http/https——javascript:/file:/ftp:/空白/相对路径拒绝，service 校验后经 shell.openExternal 默认浏览器） | 变更 | CP2 已落地 |
| `contestpin:configList` | `{}` | `{ configs: RecognitionConfigView[] }`（掩码视图：apiKeyTail 尾 4 位/apiKeyLen/apiKeySet 布尔，绝不含明文 key 与 sealed envelope；key 不可解密如实回 null 掩码） | READ_ONLY | CP3a 已落地（88） |
| `contestpin:configSave` | `{ id?, name, role, baseUrl, model, apiKey?, timeoutMs? }`（role ∈ vision\|text\|multimodal；baseUrl 仅 http/https；apiKey 密码框留空=保持既有，新建空 key=无鉴权端点 key_sealed NULL；timeoutMs 正整数毫秒或 null=清空） | RecognitionConfigView（UNIQUE(name,role) 冲突 → `DB_ERROR`；key_sealed 经 getKeyCrypto envelope {v,sealed,fields,plainStore} 照 apihub_profiles 形状） | 变更 | CP3a 已落地（88） |
| `contestpin:configDelete` | `{ id, confirmed? }` | 无 confirmed → `{ confirmRequired: true, impacts: { importJobs } }`（引用该配置的 contest_import_jobs 计数）；confirmed → 删除行（jobs 侧 FK SET NULL，任务行保留） | 变更 | CP3a 已落地（88） |
| `contestpin:configTest` | `{ id }` | `{ ok, latencyMs, usage, error? }`（解密→probeConfig：text 发 ping、vision/multimodal 发 1x1 红 PNG→落 last_test_at/last_test_ok/last_test_usage_json 仅实测才写；usage:'unknown'=服务未返回非实测；error.kind 六分类 AUTH/RATE_LIMIT/TIMEOUT/NETWORK/BAD_RESPONSE/HTTP_ERROR + 服务端摘要含 image/multimodal 字样派生 IMAGE_UNSUPPORTED，文案 鉴权失败/限流/超时/网络错误/格式错误/图片不支持） | 变更 | CP3a 已落地（88） |

后续批次通道组（落地时逐批补表）：CP3 识别管线 +12 已落地 4 条（config 四条，
CP3a），**余 +8 归 CP3b**（materials/import/draft）；CP4 reminder 两条；CP5
agentStatus/Submit/importPack/exportPack；CP6 backupExport/backupImport。
