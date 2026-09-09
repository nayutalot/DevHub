# DevHub Archive 模块设计（S1 设计，后续批次实现）

> 合并来源：ArchiveKeeper（`F:\Active_Project\Archive-Tool\source`，项目归档引擎）。
> 范围修订（用户裁决 2026-09-09，推翻原「Agent 复核层不移植」裁决）：恢复 LLM 复核层，限定：
> (1) 仅咨询性（advisory-only），复核结果永不阻塞归档主流程；(2) 端点=局域网 OpenAI
> chat/completions 兼容本地服务（用户自备硬件 Jetson Orin Nano；Orin 侧不在项目范围），
> v1 无鉴权、零 key 字段；(3) 端点未配置/不可达 → 复核步骤落 skipped 态，全流程行为等价现状；
> (4) 复核输入仅路径/名称/描述/计数，零文件内容。老 agentPre/agentPost/profiles/configCrypto/
> secrets.json 仍不移植——本层为全新轻量实现（LR 批次，设计见 docs/briefs/lr1-llm-review.md）。
> 数据策略：`%APPDATA%\project-archiver\config.json` 只读，元数据迁入 DevHub SQLite
>（archive_runs，migration 003）；老软件目录与数据文件永久只读。
> 铁律基线同 docs/09 §11（exec 入口 / electron-free services / 零新依赖 / TS 风格）。

---

## 1. 生命周期（六阶段，全部可观测）

```
预检(precheck) → 引用预览(preview) → 确认(confirm) → 执行(execute) → 复核(verify) → 回滚(rollback, 按需)
```

LLM 前/后复核（advisory）：见 docs/briefs/lr1-llm-review.md；skipped 态等价现状

| 阶段 | 内容 | 失败语义 |
| --- | --- | --- |
| 预检 | 路径存在性、属于 DevHub projects、archive_dest_root 已设置、目标盘可写、占用进程检测（§6）、rename 可移动探测 | 结构化 `{ code, message }`；占用 → `PROJECT_LOCKED`（附 occupiers 清单） |
| 引用预览 | **强制 dry-run**：进程内 async walker 扫旧路径引用（§4），返回命中清单（file/line/col/snippet/matched）+ 将剥离的依赖目录 + 占用者 | 只读，永不改文件；单文件失败计入 error_summary 降级继续 |
| 确认 | UI 展示命中数/影响文件/剥离清单/目标路径，DOUBLE_CONFIRM（输入项目名匹配）后才允许执行 | 无确认不执行（安全规则 §10） |
| 执行 | 移动引擎（§5）→ 路径修复（§6）→ 残留复核 | 任一 fatal 步失败：保源 + 清理半成品 + run 置 failed |
| 复核 | 对新路径重扫旧根引用 → `residual_hits`；残留应为 0，非 0 不算失败但 UI 显式警示 | 计入 archive_runs.residual_hits |
| 回滚 | undo 目录按 runId 一键回滚（§8） | 单文件失败继续其余，返回 restored 计数 |

## 2. 操作对象与路径规则

- 操作对象 = **DevHub `projects` 表登记的项目**（`project_id` 外键）；
  以路径匹配取代老软件的手动登记：用户从 projects 列表选择待归档项目（win_path），
  不再手工录入 path/name/type。老 config.json 里的登记项目不回灌 projects
  （导入器只匹配关联，不造行——匹配不上的历史进 archive_runs 而 project_id 为 NULL）。
- 归档目标根 = settings `archive_dest_root`（用户未设置则空，UI 引导设置后再可用；
  空值时预检直接拒绝，绝不猜默认盘）。
- 目标重名：`<name>-archived-YYYYMMDD(-N)` 递增（老 `uniqueDestPath` 语义原样）。
- 归档成功后联动（§9）：projects.win_path 更新为新路径、repositories/services 归因失效处理、
  archives 表插入行（含 run_id 外链）。

## 3. 纯函数层移植清单（electron-free、无 IO，smoke 直载单测）

| 老文件 | DevHub 归宿 | 移植内容 | 测试要点 |
| --- | --- | --- | --- |
| `shared/pathRefs.ts` | `src/main/services/archive/pathRefs.ts` | `escapeRegExp` / `normalizeRoot` / `buildPathRegex` / `buildEncodedPathRegex` / `matchSeparator` / `encodePath` / `findPathRefs` / `replacePathRefs` / `lineColOf` / `snippetAround` | 正/反斜杠等价匹配；大小写不敏感；`Foo` 不误伤 `FooBar`（后向边界）；URL 编码变体（%5C/%2F/%20）；**`C:\\A\\B` 双反斜杠转义还原**（JSON 文件改写不损坏——真实案例回归）；层级数不齐时沿用最后一次分隔符写法；空路径抛错 |
| `shared/scanRules.ts` | `src/main/services/archive/scanRules.ts` | `IGNORE_DIRS`(约 25 目录) / `isVenvActivationFile` / `BINARY_EXTENSIONS` / `hasBinaryExtension` / `looksBinary`(前 8KB NUL) / `MANIFESTS` | 目录名小写比较；`activate.bat/.ps1/.fish/.zsh/.csh` 与 `pyvenv.cfg` 定点命中；二进制嗅探边界（恰好 8KB）；manifest 优先级顺序 |
| `shared/depDirs.ts` | `src/main/services/archive/depDirs.ts` | `CACHE_DIR_NAMES` / `JS_DEP_DIR`+`JS_LOCKFILES` / `VENV_DIR_NAMES`+`PY_MANIFESTS` | node_modules 剥离必须 lockfile 在场；venv 剥离条件 = Python 清单在场；缓存目录无条件剥离 |

安全钩子规避：正则匹配一律 `.match()` / `.matchAll()` / `.replace(rx, fn)`，
**禁止 `RegExp.exec(变量)`**（项目安全规约）；正则对象本身是纯函数内部构建的常量形态，
`gi` 标志的 `lastIndex` 状态只存在于 matchAll/replace 内部消费，无跨调用泄漏。

## 4. 进程内 async walker（替代 utilityProcess worker）

老实现是 utilityProcess 子进程（`scan.worker.ts`）；DevHub 铁律禁新增进程形态，
改为 Service 层进程内 async walker：

- 遍历：显式栈 DFS（`readdir withFileTypes`），命中 `IGNORE_DIRS` 整棵剪枝；
  **venv/.venv 例外定点扫描**：只额外收集 `<venv>/pyvenv.cfg` 与
  `<venv>/{Scripts,bin}/activate*`（激活脚本写死绝对路径）。
- 让步（yield）：每处理 N 个文件（N=64）`await setTimeout(0)` 让出事件循环；
  大文件读取用 `fs.promises.readFile` 天然异步。主进程 UI 不因长扫描卡死；
  取消用共享 token（`{ cancelled: boolean }`，每个文件循环检查）。
- 文件过滤：扩展名二进制剔除 + `>2MB` 跳过（计数 skippedOversize）+ 内容前 8KB NUL 剔除；
  BOM 剥离后行列定位。
- 命中上限：单文件 50 条（日志类文件每行都含路径，截断条目不影响按文件整体改写），
  totalHits 保留真实值。
- 并发：命中读取阶段 8 并发池（游标递增模式），单文件异常吞掉计入 error_summary。
- 产出：`{ hits[], totalHits, scannedFiles, skippedBinary, skippedOversize, errorSummary }`。

## 5. 移动引擎（同卷 rename / 跨卷并发校验复制 / 失败保源）

移植 `archiver.ts`（去掉 withoutAsar——无 Electron asar 拦截场景，直接 fsp）：

1. 前置：目标已存在且非空 → 拒绝（不盲目清场）；存在且空 → rmdir 复用。
2. 同卷：`fsp.rename` 瞬时完成；`EXDEV` → 跨卷分支；其它错误码 → 结构化报错
   「目录可能被占用」。
3. 跨卷：复制规划（目录树 + 文件清单 + 总字节；`skipDepDirs` 时按 §3 规则剪枝；
   链接不跨卷复制，计数 skippedLinks）→ **4 并发 worker**（游标分配）逐文件
   `copyFile` + 尺寸校验 → >64MB 大文件抽样头部 sha256（最多 20 个）→ 全部通过后才
   `rmTreeRobust(src)` 删源。任一步失败：删除目标半成品、**源目录原样保留**、run 置 failed。
4. 同卷 rename 后剥离：对目标内的依赖目录执行 `rmTreeRobust`（junction/只读/短暂占用
   多轮退避；删不动的残留不判定失败，记入 leftovers）。
5. 进度：`onProgress(doneBytes, totalBytes)` 节流 150ms；取消检查点在每个 worker 循环与
   大文件校验间。
6. 删除源用 `rmTreeRobust`（rm 重试 → 逐项清扫：链接 rmdir/unlink、只读 chmod 后删、
   EBUSY/EPERM 退避 3 轮），返回删不动残留清单（可手动清理，不算失败）。

## 6. 路径修复与占用检测

### 6.1 路径修复（pathFixer 移植）

- 扫描记录的是旧位置路径，移动后先 `remapMovedPath(file, movedFrom, movedTo)` 映射到新位置。
- 每文件：读 Buffer → `buf.toString('utf8')` → **UTF-8 往返校验**
  （`Buffer.from(text,'utf8')` 与原 buf 不等 = 非 UTF-8/GBK → 跳过不动，记 skippedNonUtf8）→
  `replacePathRefs(text, oldRoot, newRoot)`（正斜杠/反斜杠/大小写/URL 编码变体，
  分隔符风格逐位保留，`\\` 转义不损坏）→ count>0 时：先 `copyFile` 备份到
  undo 目录 → tmp 写 + rename 原子替换。
- 产出 `FixOutcome { fixed[{file,count,backup}], skippedNonUtf8[], missing[], totalReplacements }`。

### 6.2 占用进程检测（procGuard 移植，全部经 exec）

- 检测：PowerShell 静态字面量（`Get-CimInstance Win32_Process | Select ProcessId,Name,
  ExecutablePath,CommandLine | ConvertTo-Json -Compress`，20s 超时）→ 过滤
  exe/命令行含项目路径的进程（带边界防 DemoWeb 误伤 DemoWeb2；排除 DevHub 自身进程树，
  上限 30 条）。
- 探测：目录 rename 到同级临时名再改回（`probeDirMovable`）——被 CWD/句柄锁定即失败；
  改回失败时尽力恢复并显式报错。
- 结束：仅在用户勾选 occupiers 后执行（CONFIRM_REQUIRED）；
  `taskkill /PID <pid> /T` 温和 → 2.5s 存活则 `/T /F` 强制 → 仍失败列入 failed 清单。
  所有 taskkill 参数数组经 exec。

## 7. undo 管理

- 布局：`<DEVHUB_HOME>/undo/<runId>/`（备份文件，`0001-<basename>` 序号命名）+
  `<DEVHUB_HOME>/undo/<runId>.json`（清单 `{ runId, entries[{target, backup}] }`）。
  老实现放 Electron userData；DevHub 统一用 `getDataDir()`（与 DB 同根，`core/paths.ts`）。
- 回滚：读清单 → 逐条 `copyFile(backup, target)`（文件在归档后新位置）→ 返回 restored 数；
  单条失败继续。回滚后 run 置 `rolled-back`。
- 不自动清理：undo 目录保留（磁盘压力由用户手动清）；UI 显示各 run 的 undo 占用提示。
- 回滚只还原**文件内容改写**；目录移动本身的回退（移回原位）是可选动作
  `archive:undoMove`：仅当新位置仍存在且原位置父目录可写时执行，同样先做占用探测。

## 8. history 与 archive_runs（上限 100）

- 一次执行写一行 archive_runs：`project_id`(可空外键) / project_name / old_path / new_path /
  status(`running|done|failed|rolled-back`) / fixed_files / external_files / residual_hits /
  stripped_json(剥离目录名数组 JSON) / started_at / finished_at。
- **历史上限 100**：insert 后 `DELETE FROM archive_runs WHERE id NOT IN
  (SELECT id FROM archive_runs ORDER BY id DESC LIMIT 100)`（老 history 上限 100 语义）。
  undo 目录不随 trimming 删除（数据安全优先）。
- 导入的老 history：`at`(ms) → started_at=finished_at=秒；status done 原样；
  stripped_json 为 NULL（老数据未记录）；按 old_path+started_at 查重不重复导入。
- archives 表（001 预留）003 扩列：加 `run_id`（FK archive_runs, ON DELETE SET NULL）与
  `old_path`；一行 = 当前处于归档态的项目（区别于 archive_runs 的历史流水）。

## 9. 归档后联动

1. `projects.win_path`（与 `wsl_path` 若有）更新为新路径；`updated_at` 刷新；
   `last_opened_at` 保留。
2. `repositories` / `containers` / `services.project_id` 关系不变（外键挂在 project id 上，
   不挂路径）；但 services 的 `working_dir` 归因下次 refresh 自然重算；
   repositories 下次 rescan 重取 head/dirty。
3. `resources/relationships` 图：project resource 行不变；relationship 边不因路径变化失效。
4. archives 插入 `{ project_id, archive_path: new_path, run_id, old_path, size_bytes }`。
5. 项目被移出 scan_root：下次全量扫描不会重复发现旧位置（已移走），也不会删除登记行
   （DevHub projects 为显式登记 + 扫描合并模型，路径仍有效）。

## 10. 安全规则（强制，违反任一即实现缺陷）

1. **强制 dry-run 预览**：`archive:preview` 只读；执行通道（`archive:run`）必须携带
   preview 返回的 `runId` 且服务端校验该 runId 确有已完成的预览记录，杜绝跳过预览直跑。
2. **UI 二次确认**：确认页必须展示命中文件数、影响文件清单、剥离目录、old→new 路径；
   DOUBLE_CONFIRM 输入项目名匹配后才发 `archive:run { confirmed: true }`。
3. **绝不删数据，只移动 + 备份**：引擎只有 rename/copy/修复改写三种写行为；
   修复改写前逐文件备份；删源只在复制校验全通过后执行；剥离仅限 §3 判定的可再生目录；
   任何删除失败都降级为残留报告而非报错回滚。
4. **回滚必须可用**：每次执行生成 undo 清单；`archive:rollback` 不依赖老软件存在；
   回滚动作自身只做 copyFile 覆写（不再改写路径），保证幂等可重复执行。
5. 非法路径拒绝：old_path 必须 == projects.win_path（防误伤任意目录）；
   archive_dest_root 不得位于 old_path 内部（防自吞）；跨设备移动只允许常规本地卷。

## 11. 服务与 IPC 映射

- Service：`src/main/services/archive/`（flow 编排 + §3 纯函数 + walker + mover + fixer +
  procGuard + undo），唯一写库层；无 electron import。
- IPC 新增（追加白名单 + handler 注册表，模式同 docs/09 §9）：

| channel | payload | result |
| --- | --- | --- |
| `archive:precheck` | `{ projectId }` | `{ ok, occupiers[], dirLocked, depSkipDirs[], destPath }` |
| `archive:preview` | `{ projectId }` | `{ runId, report(hits/totalHits/scanned/…), occupiers, depSkip }`（强制 dry-run） |
| `archive:run` | `{ runId, confirmed? }` | DOUBLE_CONFIRM；`ArchiveSummary { movedFrom/To, fixedFiles, externalFiles, residualHits, skippedDeps, sourceLeftover, durationMs }` |
| `archive:history` | `{ limit? }` | archive_runs 最近记录（默认 100） |
| `archive:rollback` | `{ runId, confirmed? }` | `{ restored, status: 'rolled-back' }` |

> **实现注记（S5 批次如实记录，偏差经母智能体裁决接受）**：表中 `archive:precheck`
> 未单独成 channel——预检职能（路径存在性 / archive_dest_root 校验 / 占用进程检测 /
> 目录锁探测 / depSkipDirs）已并入 `archive:preview` 强制 dry-run 的返回（impacts）。
> 同步更正两处命名：preview 签发的执行凭证实际字段名为 `previewId`（`arc-<uuid>`，
> 10 分钟 TTL；`archive:run` 与下条 `archive:status` 均携带 previewId，表中 `runId`
> 为设计期草案命名，`archive:run` 结果里的 runId 才是 archive_runs 行 id）；
> `archive:rollback` 实际为两段式：未带 confirmed 先回 `{ confirmRequired, impacts }`，
> 带 confirmed 才执行，返回含 `restored / movedBack / projectsRestored / note`。

- 执行期间进度复用轮询模式：`archive:status { runId }`（phase/percent/log 尾部），
  不新增广播 channel。
- MCP：`devhub.archives.list`（只读，docs/09 §10）；preview/run/rollback **不进 MCP**。

## 12. smoke 要点（实现批次）

- pathRefs/scanRules/depDirs 纯函数全表断言（含 `\\` 转义回归、venv 定点、Foo/FooBar 边界）。
- walker：夹具树（含 node_modules/venv 激活脚本/二进制/超长文件）命中与剪枝计数。
- mover：同卷 rename；注入 renameFn 抛 EXDEV 模拟跨卷 → 复制/校验/剥离/删源；
  失败注入 → 源保留 + 目标清理。
- fixer：UTF-8 往返拒绝 GBK 字节流；备份存在；原子替换后内容正确。
- flow：临时 DEVHUB_HOME 全链路 preview→run→residual 0→rollback restored；
  archive_runs 行与 100 上限；projects.win_path 联动更新。
