# DevHub Skills / ApiHub / 版本中心 / Docker·WSL 合并设计（S1 设计，后续批次实现）

> 合并来源：SkillVault（`F:\Active_Project\Skill-Manager`，AI Skills 管理中枢）。
> 数据策略（用户已确认）：元数据迁入 DevHub SQLite 为唯一事实源；vault 物理文件
>（`C:\Users\sakuya\SkillVault`）不动（junction 指向它，只迁 registry 元数据）；
> 老软件目录与其数据文件**永久只读**。
> 本文是设计文档：S1 批次只交付 migration 003 + 一次性导入器；service/IPC/视图由
> S2/S3 批次按本文实现，实现必须同时满足 `docs/00-execution-constraints.md` 全部 28 条。

---

## 1. 数据流总览

```
vault 物理层（只读引用，DevHub 从不写入 skills/agents 内容文件）
  C:\Users\sakuya\SkillVault
    ├─ skills/<name>/SKILL.md + …      ← junction 的目标（唯一真身）
    ├─ agents/*.md                     ← agentsDir 硬链接共享的源
    ├─ registry.json                   ← 老软件写；DevHub 只读一次（导入后弃用）
    └─ .git                            ← vault 内 git 仓（双侧同步仍要用）

DevHub SQLite（唯一事实源，migration 003）
  skill_agents   ← registry.json v2 agents（一次性导入 + UI 可改）
  skills         ← vault skills/ 目录镜像（扫描结果落库）
  skill_links    ← (agent, skill) 链接状态缓存（doctor 扫描产物）
  apihub_profiles← 老接口中心档案（S3 起活跃使用）
  version_targets← 版本中心 8 目标检测快照

外部链路（DevHub 经 exec 写，vault 本体仍只放 skills/agents 内容）
  skillsDir junction（Windows skills 链接）
  agentsDir 真实目录 + 硬链接共享（ZCode 重启会重置 junction，见 §4.2）
  WSL companion symlink（/root/.zcode/...）
  vault git + SkillVault.git 裸仓 origin + WSL companion skm（双侧同步）
```

原则：**元数据读库，物理状态读盘**。`skill_links` 只是缓存；任何 toggle/repair/doctor
动作都以真实文件系统探测为准并回写缓存，绝不把缓存当事实源。

## 2. 模块映射（老模块 → DevHub）

| SkillVault 老模块 | 职责 | DevHub 归宿 |
| --- | --- | --- |
| `src/shared/registry.ts` | registry.json v2 解析/校验/include 匹配 | `src/main/services/skills/registryLogic.ts`（纯函数，electron-free；v1/v2 兼容读、归一化 v2） |
| `src/shared/types.ts` | LinkState/ScanReport/… | 并入 `src/shared/types.ts`（`import type`，无 enum/namespace） |
| `src/shared/frontmatter.ts` | SKILL.md frontmatter 解析 | `src/main/services/skills/frontmatter.ts`（纯函数） |
| `src/shared/paths.ts` | WSL vault 挂载点常量 | `src/main/services/skills/wslVault.ts` |
| `src/main/winLinks.ts` | junction/硬链接/LinkState/agentsDir 修复 | `src/main/services/skills/winLinks.ts`（node:fs 直用，Service 层） |
| `src/main/importer.ts` | 拷贝→校验→删源→建链→commit | `src/main/services/skills/importer.ts` |
| `src/main/doctor.ts` | 全链路体检（severity/fixable） | `src/main/services/skills/doctor.ts` |
| `src/main/sync.ts` + `git.ts` | 双侧 git 同步 | `src/main/services/skills/sync.ts`（git 一律经 `core/exec.ts`） |
| `src/main/wslBridge.ts`/`wslScan.ts`/`companion/skm.ts` | WSL 侧扫描 companion | `src/main/services/skills/wslScan.ts` + `scripts/skm-companion.mjs`（esbuild 内联打包随包分发，仍经 `wsl.exe` 执行） |
| `src/main/apihub/store.ts` | 档案库（sealed key 落盘） | `src/main/services/apihub/profileStore.ts`（改 SQLite `apihub_profiles`） |
| `src/main/apihub/transforms.ts` | 7 适配器目标文件解析/改写 | `src/main/services/apihub/transforms.ts`（node:fs 直用） |
| `src/main/kimi/tomlEdit.ts` | TOML 块级改写/掩码 | `src/main/services/apihub/tomlEdit.ts`（纯函数） |
| `src/main/versionCenter/*` | 8 目标检测/更新 | `src/main/services/versions/`（catalog/npm/winget/native/arp/github/jobs/versionCompare） |
| `src/main/docker/index.ts` | 容器/镜像/引擎管理 | `src/main/services/dockerService.ts`（Phase 1 已有，扩展动作与镜像） |
| `src/main/wslmon/index.ts` | WSL 资源监控 | `src/main/services/wslService.ts`（Phase 1 已有，扩展 terminate/boot/stats） |
| 渲染层 Skills/ApiHub/版本中心/Docker/WSL 页 | 视图 | 新视图 `SkillsView` / `ApiHubView` / `VersionsView` / `DockerView`；WSL 监控并入 `EnvironmentView` |

 ipc 老页面（Kimi 接口、远程目标 RemoteTarget、configTransfer、agent.ts 复核层）：
 - 老接口中心 Kimi 页已被 ApiHub 吸收（kimi-profiles.json → api-hub-profiles.json kimi 节），
   DevHub 直接落 `apihub_profiles`，不再保留独立页。
 - RemoteTarget / remoteSync（SSH/Docker 远程目标）**不在本期范围**，backlog。
 - ArchiveKeeper 的 Agent 复核层**不移植**（见 docs/10）。

## 3. SQLite 模型（migration 003）

新表 5 张 + 重建扩列 2 张 + settings 种子 2 条（SQL 全文见
`src/main/db/migrations/003_merge_legacy.sql`；机制见 docs/03 §4）。

### 3.1 registry.json → skill_agents 映射规则

registry v2（`RegistryAgent`）逐条映射，`name` 为业务键（upsert）：

| registry.json | skill_agents 列 | 规则 |
| --- | --- | --- |
| `agent.name` | `name` | UNIQUE；v2 校验非空且不重复 |
| `agent.platform` | `platform` | 枚举 `windows` \| `linux` |
| `agent.skillsDir` | `skills_dir` | 非空字符串原样保留（含 WSL POSIX 路径） |
| `agent.agentsDir` | `agents_dir` | 可选；v1 数据缺省 → NULL |
| `agent.include` | `include_json` | `JSON.stringify(include)`，`["*"]` 或技能名数组；读取方 `JSON.parse` 后走 `agentIncludes` 同语义（`*` 全包含） |
| （无对应） | `enabled` | 导入置 1；UI 可停用某 agent（停用 = doctor/toggle 跳过，不删行） |
| （无对应） | `created_at`/`updated_at` | unix 秒；upsert 时 created_at 保留首次值 |

registry.json 本体在导入后**只读弃用**：此后 agent 的增删改一律走 DevHub UI/IPC 写库；
vault 内文件与 junction 目标不受影响。老软件再写 registry.json 不会回流（元数据事实源已切换）。

### 3.2 skills 扩列（重建表，append-only 合同）

001 的 `skills(id, name UNIQUE, source_path, description, created_at, updated_at)` 保留原列，
003 以 002 同款「CREATE 新表 → INSERT SELECT 平移 → DROP → RENAME」重建，新增：

- `vault_rel_path TEXT`：vault 内相对路径，恒为 `skills/<name>`（vault_path 由 settings 提供，
  绝不把绝对路径写死进行——vault_path 用户可改）。
- `frontmatter_json TEXT`：SKILL.md frontmatter 解析结果（`{name, description}` 的 JSON 序列化）。

`source_path` 保留：非 vault 来源（未来扫描发现的本机散装 skill）记录发现位置；vault 镜像行
`source_path` 为 NULL。`skills.name` 与 vault 目录名一一对应，upsert 键。

### 3.3 skill_links（缓存表）

`(agent_id, skill_id)` UNIQUE；`state` 为 LinkState 五态（§4.1）；`checked_at` unix 秒。
doctor/toggle 后整表按 agent 重写（DELETE agent 的行 + 批量 INSERT，单事务）。
WSL agent 的链接状态来自 companion 扫描（`scan:wsl` 缓存），同样落本表；
companion 不可达时缓存 stale（`checked_at` 过期由 UI 标注），不猜测。

### 3.4 apihub_profiles

- `name UNIQUE`（全局唯一；导入冲突时以 `<provider>/<name>` 去重，见 §6.3）。
- `provider`：适配器 id（`claude-cli|claude-desktop|codex|grok|kimi|zcode|deepseek`）。
- `encrypted_blob BLOB`：JSON envelope 的 UTF-8 字节：
  `{ "v": 1, "sealed": "<base64>", "fields": {…}, "plainStore": bool? }`。
  key 全值只在 seal/解密瞬间存在于内存；`sealed` 是 safeStorage(DPAPI) 密文或
  plainStore 降级的 base64 明文（此时 `plainStore: true`，UI 强提示）。
- `needs_rekey INTEGER`：1 = blob 来自老软件 DPAPI 上下文，尚未在 DevHub 内重加密成功；
  1 的档案**只展示元数据、禁止切换动作**（S3 迁移解密流程见 §6.2）。
- 老档案 `activeByAdapter` 不迁（激活态以目标文件当前内容为准，由 `apihub:current` 反推）。

### 3.5 version_targets

`key` = 版本目录 catalog id（claude-code-npm / claude-code-winget / claude-desktop /
codex-desktop / kimi-cli / grok-cli / deepseek-harness / zcode）。检测快照表：
`installed_version` / `target_version` / `state`（`up-to-date|upgradable|unknown|check-failed|detect-only`，
`checking` 仅渲染层占位不入库）/ `last_checked_at`。每次 checkAll 全量 upsert；
catalog 是代码常量（VERSION_CATALOG 原样移植），表里只存状态不存目录。

### 3.6 archive_runs 与 archives 扩列

见 docs/10 §9（字段、历史 100 上限、与 projects 的联动）。

### 3.7 settings 种子

- `vault_path = C:\Users\sakuya\SkillVault`（用户当前真实值；UI 可改，改后需重扫）。
- `archive_dest_root = ''`（空 = 未设置，UI 引导设置；见 docs/10 §2）。
- 种子一律 `INSERT … SELECT … WHERE NOT EXISTS`（用户已有值不覆盖）。
- `settingsService.ALLOWED_KEYS` 同步追加 `vault_path` / `archive_dest_root`（settings:set 白名单）。

## 4. 链接模型

### 4.1 LinkState 五态（原样移植）

| state | 判定 | doctor 修复语义 |
| --- | --- | --- |
| `linked` | 链接存在、指向 vault 目标、目标存在 | 无需修复 |
| `missing` | 路径不存在 | fixable：建 junction（skillsDir）/ 硬链接（agentsDir）/ companion symlink（WSL） |
| `wrong-target` | 链接指向其它位置，或是普通文件 | fixable（链接形态）：删链接重建；**普通文件不自动删**，报 error 交人工 |
| `real-dir` | 同名真实目录（非链接，仅 skillsDir 语义） | **不可自动修复**（可能含用户独有内容）：报 warn + fixable=false，UI 引导手动导入（走 §5 流水线）或手动处理 |
| `vault-missing` | 链接在、vault 目标缺失（悬空） | 报 error；修复 = 从 agent 侧反导入（若 agent 侧还有内容走 §5）或移除死链，UI 二选一确认 |

### 4.2 三种链接形态

- **skillsDir → junction**（Windows）：`fs.symlinkSync(target, link, 'junction')`，
  免管理员权限；每个 skill 一条 junction，指向 `vault\skills\<name>`。
  选择 junction 而非 symlink 的原因：Windows symlink 需要开发者模式/管理员，
  junction 不需要且对目录语义完备。
- **agentsDir → 真实目录 + 硬链接共享**（Windows）：ZCode 启动会重置自身目录里的
  junction（替换成空目录），整目录 junction 在 `.zcode\agents` 上不可存活。正确形态是
  真实目录，其中每个 `vault\agents\*.md` 以硬链接（同 dev+ino）出现。判定
  `agentsDirStateOf`：junction/symlink 走 getLinkState；真实目录且 vault 每个 .md
  同名同 inode、无多余 .md → `linked`（附注「硬链接共享」）；其余真实目录 → `real-dir` 可一键修复。
  修复（`repairAgentsDir`）：解除既有链接（真实目录形态保留目录）→ vault 每个 .md
  同名同 inode 跳过 / 同名异文件先移回收站（vault 同级 `.trash-<ts>/`）再 `fs.link` /
  缺失直接硬链接 → 多余 .md 移回收站。
- **WSL companion symlink**：WSL 侧无法建 Windows junction，companion（skm）在
  `/root/.zcode/skills/<name>` 建 POSIX symlink → `/root/skill-vault/skills/<name>`
  （vault 经 `/mnt/c/...` 不理想，实际做法是 companion 维护 vault 在 WSL 侧的镜像挂载点，
  与老软件一致：`WSL_VAULT = /root/skill-vault`）。DevHub 经 `wsl.exe`（exec 内核）
  调 companion 扫描/修复，companion 脚本 esbuild 内联打包（依赖树内已有 esbuild）。

### 4.3 doctor 项模型

`DoctorItem { id, severity: 'error'|'warn'|'info', message, fixable, fixId?, payload? }` 原样移植；
扫描源 = Windows registry agents（库内 `skill_agents` where platform='windows' and enabled=1）
+ WSL agents（companion）+ vault 健康检查（`vaultOk`：skills/、agents/、.git 存在性）。

## 5. Skill 导入流水线（拷贝→校验→删源→建链→git commit）

移植 `importer.ts` 语义，铁律不变：**删除源之前必须完成校验；校验失败中止，vault 副本
保留待人工处理，绝不先删后验**。

1. plan：源目录存在 → resolveRealDir（解析 junction/symlink 到真身，深度上限 16）→
   skill 名 = basename，校验小写 kebab-case → 必须有 SKILL.md → 源不得位于 vault 内部 →
   vault 同名冲突拒绝（不覆盖）→ 统计文件数/字节数，产出 actions 清单。
2. execute：递归拷贝（排除 .git、跳过内嵌链接）→ 校验（文件数一致 + 逐文件字节数一致）→
   删源（链接只删链接本身；真身目录递归删）→ 原位置建 junction → vault 内
   `git add -A` + `commit`（仅本地不 push）。全部 git 调用经 `core/exec.ts`。
3. UI：`skills:import` 先返回 plan（actions 列表），用户确认后带 `confirmed: true` 重发执行
   （CONFIRM_REQUIRED 语义，见 §8.3）。
4. 成功后：重扫该 agent 链接状态回写 `skill_links`；`skills` 表 upsert 镜像行。

## 6. ApiHub（接口中心）

### 6.1 注入式 keyStore 接口（electron-free）

services 目录禁止 import electron（smoke 用系统 Node 直载）。key 加密能力做成注入接口：

```ts
// src/main/services/apihub/keyStore.ts
export interface KeyStore {
  /** safeStorage 可用性（DPAPI 就绪）；不可用时调用方落 plainStore 降级 */
  isEncryptionAvailable(): boolean
  encrypt(plain: string): string   // → base64 密文
  decrypt(sealed: string): string  // base64 密文 → 明文（仅主进程内存瞬间）
}
```

- 生产实现 `src/main/services/apihub/safeStorageKeyStore.ts`：包一层 Electron
  `safeStorage`（`encryptString`/`decryptString` + `isEncryptionAvailable`），
  仅 `main/index.ts` 接线时 import electron 并注入；transforms/profileStore 只见接口。
- smoke/测试实现 `plaintextKeyStore`：encrypt = base64(plain)，decrypt 反向，
  并显式落 `plainStore: true` 语义（测试断言降级路径）。

### 6.2 老 DPAPI blob 迁移策略（S3 实现，S1 只登记）

老档案 blob 是老 app userData（实测为 `%APPDATA%\SkillVault`，候选还有
`%APPDATA%\skill-manager`、`%APPDATA%\skill-vault`）下 `api-hub-profiles.json` 的
`byAdapter[<id>][].apiKeySealed`。DPAPI 密文按 (用户, 应用Entropy) 解密——若 DevHub 沿用
safeStorage 默认（无自定义 entropy），同 Windows 用户可直接解密。

- S1 导入器（已实现）：探测到档案 → 原样登记 `apihub_profiles`，`encrypted_blob` 存
  原始 envelope，`needs_rekey = 1`，**绝不尝试解密**；只登记档案名/provider/字段。
- S3 迁移流程：逐条尝试 `safeStorage.decrypt` → 成功：立即用 DevHub KeyStore 重加密入库
  （needs_rekey → 0，成功前不删旧 blob）→ 失败：保持 needs_rekey=1，UI 提示「需重新录入
  key」，**绝不猜测、绝不伪造可用性**。
- plainStore 降级档案（老数据 `plainStore: true`）：base64 即明文，重加密后同样走 S3 流程。

### 6.3 档案与切换语义

- 每适配器多档案；`name` 全局 UNIQUE（导入冲突时重命名为 `<provider>/<原名>` 并在报告注明）。
- 切换（`apihub:switch`）流程（老语义原样）：预检目标进程（tasklist 经 exec）
  → 运行中则 `blocked: true`，UI 确认后带 `confirmed` 重发 → 目标文件逐个
  `copyFile` 备份（`.bak_<stamp>`）→ 临时文件 + rename 原子写 → 任一失败回滚全部备份 →
  返回 `{ backupFiles, warning? }`。zcode 适配器附带「重启 ZCode 生效」warning。
- 档案视图（`apihub:profiles`）一律脱敏：`apiKeyTail`（尾 4 位）+ `apiKeyLen`，绝无全值。

### 6.4 七个适配器：目标文件清单与写入/回滚

| adapterId | 目标文件 | 写入内容 | 备注 |
| --- | --- | --- | --- |
| `claude-cli` | `~/.claude/settings.json` | `env.ANTHROPIC_BASE_URL` / `env.ANTHROPIC_AUTH_TOKEN` | JSON 整文件改写，其余键零改动 |
| `claude-desktop` | — | — | `available: false`（N/A 说明卡：无可靠切换通道） |
| `codex` | `~/.codex/auth.json` + `~/.codex/config.toml` | auth.json `OPENAI_API_KEY`；config.toml 顶层 `model_provider` + `[model_providers.<id>]` 块 | 双文件备份/回滚 |
| `grok` | `~/.grok/config.toml` | `[models] default` + `[model."<modelId>"]` 块 | 块级 upsert，其余段零改动 |
| `kimi` | `~/.kimi-code/config.toml` | `providers` / `models` / `thinking` 块 + `default_model` | 块级 upsert（tomlEdit 纯函数移植） |
| `zcode` | `~/.zcode/v2/config.json` + `~/.zcode/v2/setting.json` | `provider.<id>` upsert（结构照抄现有条目）+ `modelProviderFamilySelectedKeys` | warning：重启 ZCode 生效 |
| `deepseek` | — | — | `available: false`（N/A：源码重建形态，无配置切换通道） |

通用规则：写前逐文件备份；原子写（tmp + rename）；改写为纯文本块级操作，未知段落/键
零改动；回滚按备份逆序整体恢复；TOML 解析展示（readCurrent）只回掩码（尾 4 位 + 长度）。

### 6.5 红线（约束 #13 的具体化）

key 全值**永不出现在** IPC payload/返回、MCP 工具结果、日志、错误消息、缓存文件。
一切对外投影只有 `apiKeyTail`（尾 4 位）与 `apiKeyLen`。解密只发生在主进程
切换/写目标文件的瞬间。smoke 断言：任何 apihub 返回对象 JSON 序列化后不含 key 明文
（测试用可识别的假 key 验证）。

## 7. 版本中心

### 7.1 八目标与通道（catalog 原样移植）

| key | name | 通道 | kind | 已装检测 | 最新版检测 | 更新动作 |
| --- | --- | --- | --- | --- | --- | --- |
| claude-code-npm | Claude Code CLI (npm) | npm: @anthropic-ai/claude-code | npm | `npm ls -g <pkg>` | `npm view <pkg> version` | `npm install -g <pkg>@latest` |
| claude-code-winget | Claude Code CLI (winget) | winget: Anthropic.ClaudeCode | winget | `winget list -e --id …` | `winget upgrade` 清单 | `winget upgrade -e --id …` |
| claude-desktop | Claude Desktop | winget: Anthropic.Claude | winget | 同上 | 同上 | 同上；预检 `claude.exe` 进程 |
| codex-desktop | Codex Desktop | MSIX: OpenAI.Codex | winget | `listExact:false` 子串匹配（MSIX 完整包名） | 同上 | `winget upgrade`；失败提示走 Microsoft Store；预检 `Codex.exe` |
| kimi-cli | Kimi Code CLI | 自带更新器 `~/.kimi-code/bin/kimi` | native | `kimi --version` | `kimi update --check`（或同义自检） | `kimi update` |
| grok-cli | Grok CLI | 自带更新器 `~/.grok/bin/grok` | native | `grok --version` | 同上 | `grok update` |
| deepseek-harness | DeepSeek Harness | GitHub Releases 源码重建 | github | 安装目录（settings.deepseekHarnessRoot，默认 `D:\Apps\deepseek-harness`）+ 本地版本文件 | GitHub Releases latest tag | 下载源码包 → staging 内 `npm install` 重建 → 原子换目录（旧目录自动备份，`~/.dsh` 不动） |
| zcode | ZCode | winget: ZhipuAI.ZCode | winget | `winget list -e --id …` | 同上 | `winget upgrade`；预检 `ZCode.exe`（更新会关闭宿主会话，UI 强提示） |

### 7.2 更新 job 状态机

```
              user click
   ┌──────────────────────────┐   blocked(process running) → UI 确认 → confirmed 重发
   │ idle ──► running ──► done │  （done 后自动重查一次，快照回写 version_targets）
   │           │      └─► failed
   │           └──────► cancelled（用户取消；子进程经 exec 超时/kill 收尾）
```

- job 快照（IPC 轮询）：`{ jobId, entryId, status, log[](内存环形尾部截断), error?, after? }`；
  同一时刻每目标至多 1 个 running job（重复点击返回既有 jobId）。
- 超时（经 exec 内核，显式放宽）：检测类 90s；更新类 20min（npm/winget 拉包），
  github 重建 30min；超时 = failed（结构化 timeout 错误）。
- 全部外部命令（npm/winget/tasklist/taskkill/git/gh）一律参数数组经 `core/exec.ts`，
  禁止 shell 拼接；下载走 Node fetch（无新依赖）。

## 8. Docker / WSL 合并

### 8.1 Docker 视图（Portainer 风格，daemon 不可用是常态）

- 数据：`dockerInfo`（online / engine-down / error 三态）、容器列表（`docker ps -a` JSON
  Lines + `stats --no-stream` 按名合并）、镜像列表（`docker images` JSON）。
- 动作：`docker:containerAction`（start/stop/restart/remove）——start/stop/restart 归
  CONFIRM_REQUIRED（UI 确认弹窗），remove 强确认（输入容器名匹配）。
  `docker:startEngine`：拉起 Docker Desktop.exe（ok 仅代表已发起，10–30s 后手动刷新）。
- 降级文案：daemon 不可达时全页横幅 `Docker: daemon unreachable (engine-down)` +
  「启动引擎」按钮（约束 #26），绝不白屏。
- 与 Phase 1 `dockerService` 的关系：同一 service 扩展动作函数与镜像列表；
  `containers` 表照旧落库，镜像不落库（瞬时读）。

### 8.2 WSL 并入 Environment 视图

- `wsl:distros`（列表 + Running/Stopped + vmmemWSL 宿主内存）、`wsl:distroStats`
  （/proc 一次读取复合指标；取不到为 null，绝不硬造）、`wsl:action`
  （terminate/boot/shutdownAll）。**绝不为了取数而启动已停止的发行版**。
- terminate / boot / shutdownAll 归 CONFIRM_REQUIRED（UI 确认；shutdownAll 需二次确认文案）。
- Environment 视图新增「WSL 监控」折叠区：Phase 1 的 distros 快照 + 实时 stats + 动作按钮。

### 8.3 动作确认语义（三档）

| 档 | 语义 | 例子 |
| --- | --- | --- |
| READ_ONLY | 直接执行 | scan / list / doctor |
| CONFIRM_REQUIRED | 一次 UI 确认后带 `confirmed: true` 重发；不带 confirmed 时返回 `{ confirmRequired: true, … }` | toggleLink、repair、apihub:switch、container start/stop、wsl terminate/boot、versions:update |
| DOUBLE_CONFIRM | 额外输入匹配（名称/删除确认） | docker remove、archive 执行（docs/10）、skill 导入删源步骤 |

MCP 侧：变更动作一律不进 MCP（见 §10）；MCP 权限表 CONFIRM_REQUIRED 槽位留给 Phase B。

## 9. 新增 IPC channels（全部走 `devhub:invoke` 白名单 + Result envelope）

新增 22 条（channel 定义追加进 `src/shared/channels.ts`，handler 注册表同步，
smoke 用例 #1 的 21 条断言由实现批次按同一模式更新为 43 条）：

| 分组 | channel | payload 摘要 | result 摘要 |
| --- | --- | --- | --- |
| skills | `skills:scan` | `{}` | `ScanReport { skills, agents[], vaultOk }`（Windows 实时） |
| skills | `skills:scanWsl` | `{}` | `{ report, stale, reason? }`（companion 不可达回落缓存） |
| skills | `skills:list` | `{}` | 库内 `skills[]`（含 frontmatter description 投影） |
| skills | `skills:agents` | `{}` | `AgentScan[]`（实时扫描 + skill_links 缓存回写） |
| skills | `skills:toggleLink` | `{ agent, skill, enable, confirmed? }` | CONFIRM_REQUIRED；enable=建链 / disable=删链（仅删链接本身） |
| skills | `skills:import` | `{ sourceDir, confirmed? }` | plan → 确认 → 执行结果 `{ plan, steps }` |
| skills | `skills:doctor` | `{}` | `DoctorItem[]` |
| skills | `skills:repair` | `{ fixId, confirmed? }` | `{ steps, state, note? }` |
| skills | `skills:sync` | `{ confirmed? }` | 双侧 git 同步 `{ steps[], conflicts[] }` |
| apihub | `apihub:adapters` | `{}` | 适配器目录（available/naReason/fieldDefs） |
| apihub | `apihub:current` | `{ adapterId }` | readCurrent 脱敏视图（configPaths/baseUrl/tail/detail） |
| apihub | `apihub:profiles` | `{ adapterId }` | `{ profiles[](脱敏), activeId }` |
| apihub | `apihub:saveProfile` | `{ input, apiKeyPlain? }` | 明文仅本次 payload，主进程立即 seal；返回脱敏视图 |
| apihub | `apihub:deleteProfile` | `{ adapterId, id }` | `{ deleted }` |
| apihub | `apihub:switch` | `{ adapterId, id, confirmed? }` | 预检 blocked → 确认 → `{ backupFiles, warning? }` |
| versions | `versions:list` | `{}` | 目录 8 条 + 库内快照（installed/target/state/lastCheckedAt） |
| versions | `versions:check` | `{ id? }`（缺省全查） | `VersionStatus[]`（回写 version_targets） |
| versions | `versions:update` | `{ id, confirmed? }` | `{ blocked?, jobId? }`；job 快照轮询复用 `versions:job` |
| versions | `versions:job` | `{ jobId }` | `VersionJobSnapshot` |
| docker | `docker:overview` | `{}` | info + containers + images（daemon 降级结构化） |
| docker | `docker:logs` | `{ name, tail? }` | `{ ok, text, error? }` |
| docker | `docker:action` | `{ name, action, confirmed? }` | CONFIRM_REQUIRED / remove 强确认 |

WSL 动作不新增 channel：`wsl:action`（terminate/boot/shutdownAll）与 `wsl:distroStats`
随 Environment 扩展批次并入 whitelist（同一追加模式，届时一并更新断言与 docs/04）。

D5 桌面收官批追加 1 条（AUDIT D-Aud I8，就地注记）：`dialog:pickPath`——
`{ mode: 'directory'|'file', defaultPath?, title? }` → `{ canceled, path }`
（electron `dialog.showOpenDialog` 结构化投影；READ_ONLY 对话框面，零 fs 能力暴露；
electron 面经 HandlerDeps 注入，取消/未选 = canceled:true + path:null，renderer
维持原值不报错；接入 BackupPanel destDir / Skills importDialog sourceDir /
Archive destRoot / MaterialImport manual_pack destDir 四处，手输保留）。

## 10. MCP 只读扩展（变更动作不进 MCP）

新增 4 个 READ_ONLY tool（docs/08 机制不变：zod schema + structuredContent + 只读落库快照）：

| tool | 入参 | 返回 |
| --- | --- | --- |
| `devhub.skills.list` | `{}` | skills 镜像（name/description/vaultRelPath/updatedAt）+ agents 概况 |
| `devhub.versions.list` | `{}` | 8 目标 installed/target/state（来自 version_targets 快照；never live-check） |
| `devhub.archives.list` | `{}` | archive_runs 最近 N 条（project/old/new/status/at） |
| `devhub.docker.images` | `{}` | 镜像列表（daemon 降级 → available:false + reason，不是 error） |

- toggle/switch/update/import/archive 等**变更动作一律不注册 MCP tool**
  （MCP 只读合同不变；权限表只加 READ_ONLY 行）。
- `devhub.skills.list` 等投影脱敏合同与 IPC 相同（apihub 本就不进 MCP）。

## 11. DevHub 适配铁律落实清单（实现批次验收对照）

1. 外部命令（git/wsl.exe/docker/taskkill/npm/winget/powershell）一律 `core/exec.ts`，
   参数数组 + 强制 timeout + 结构化结果（约束 #7–#10）。
2. node:fs 操作在 Service 层直用（junction/硬链接/目标文件改写/移动引擎）；
   Adapter 层保持只读（约束 #19）。
3. services 目录 electron-free：keyStore 注入（§6.1）、utilityProcess worker 改进程内
   async walker（docs/10 §5）；smoke 用系统 Node 直载 .ts 全绿。
4. 不新增 npm 依赖：react-window 不要（列表用既有分页/截断模式）；esbuild 仅用依赖树内
   已有版本打 companion；YAML/TOML 用移植的纯函数解析器。
5. TS 风格：无 enum/namespace、`import type`、显式 `.ts` 扩展名导入。
6. 三态强制 + 容错降级：companion 不可达、daemon 不可达、vault 缺失均有结构化文案（约束 #24–#26）。
7. 日志脱敏（§6.5 红线）+ 结构化错误 `{ code, message }`（约束 #13、#14）。

## 12. 一次性导入器（S1 已交付，`scripts/migrate-legacy.mjs`）

- 只读探测 registry.json / vault skills/ / project-archiver config.json / 老 ApiHub userData；
  upsert 入 003 新表；输出导入报告；可重复运行（幂等，按唯一键 upsert + 历史按
  old_path+at 查重）；绝不写老目录任何文件。详见 docs/03 §5 与脚本头注释。
- ApiHub blob：只登记 needs_rekey=1 占位（§6.2），不解密。

## 13. Skills 元数据体检（`skills:reviewMeta`，LR1 已落地；advisory）

- 依据：用户裁决 2026-09-09 恢复 LLM 复核层（advisory-only），设计权威见
  docs/briefs/lr1-llm-review.md；本节只登记 Skills 侧落点。
- 入口：Skills 页**手动按钮**（无自动触发）；经 IPC `skills:reviewMeta`
  （全 READ_ONLY，docs/04「LR1 追加」节；2026-09-09 LR1 批次已落地，
  实现落点 `src/main/services/review/reviewService.ts` + SkillsView「LLM 体检」按钮）。
- 行为：对 skills 元数据做批量体检，产出 flags——**描述过短 / 语言不一致 / 疑似重复**。
- **只读咨询不落库**：结果不写任何表（与 skill_links 等落库缓存无关），仅 UI 展示。
- **doctor 语义不变**：体检结果不进 §4.3 DoctorItem 判定，不改变 doctor 扫描源与修复行为。
- 输入仅路径/名称/描述/计数级元数据，**零文件内容零 key**；端点未配置/不可达 →
  skipped 态，页面行为等价现状。
