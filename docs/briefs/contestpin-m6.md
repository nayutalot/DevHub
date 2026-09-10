# CP6 任务书：ContestPin 备份恢复（收官批）——导出 manifest+材料包 / 待核对式导入

> 设计权威=docs/22 §9（备份恢复）+ charter §七。ContestPin 收官批：落地后 CP 系全部齐。
> 执行者：omni-agent，worktree `F:/Active_Project/DevHub-worktrees/cp6`，分支
> `agent/contestpin-cp6`（从 main 切出）。桌面-only：ecs-relay/android 零改动。

## 0. 主控已核事实链

- main=fb20b79；门禁基线 tsc 0 / fast 102 / full 192 / mcp 27；白名单 **108**。
- 设计 §9 原文要点：导出=目标目录 `manifest.json`（contests/nodes/reminders/
  materials 元数据，**结构性不含 contestpin_configs.key_sealed 与任何凭据**）+
  `materials/` 附件夹复制（sha256 命名天然去重）；导入=manifest 解析 → 按
  sha256/name+year 去重 → **待核对式导入（复用草稿核对界面）不静默覆盖**。
- §3 预告：CP6 备份 +2 通道（本任务书命名 `contestpin:backupExport`（READ_ONLY
  材料面，产物落用户选择目录——CP5 exportPack 同款先例）/ `contestpin:backupImport`
  （变更：解析→建 draft 走核对，绝不直写生产行——importPack 同款纪律））。
  白名单 108→**110**。
- 复用面：draft 核对界面（CP3b）；导出目录选择=main 侧 dialog（CP3b importMaterials
  的 renderer 对话框+preload 先例）；materials 存储在 `<data>/contestpin/materials/`
  （sha256 命名）；contestService 读写既有点位。

## 1. 设计裁决（主控定，docs/22 §9 权威内细化）

1. **manifest 结构**（版本化 JSON，字段=export 版本号/导出时间/来源库名义标识零本机
   路径零凭据/contests[]（含 nodes/reminders 全量元数据）+materials[]（sha256/原文件
   名/kind/大小，**不含内容**——内容在 materials/ 夹按 sha256 命名复制））。embedded
   版本号向前兼容字段未知容忍（导入端未知字段忽略并 flag）。
2. **导出**：目标目录用户选（dialog）；已存在 manifest → 结构化拒绝不覆盖（或
   带时间戳文件名——取其一，倾向拒绝+用户重选，诚实面）。materials 夹增量复制
   （同 sha256 跳过=天然断点续传）。中断=可重跑（幂等），不留半成品 manifest
   （最后原子写/写临时名再 rename）。
3. **导入**：manifest+materials 解析 → 校验（形状/材料 sha256 对账——缺文件如实
   flag 降级不带病导入）→ 全部赛事作为**一份 draft** 走既有草稿核对界面（每比赛
   相似检测按 name+year 既有逻辑）→ 用户逐项确认/合并/另建 → 落库。**绝不静默覆盖**。
4. **零凭据红线**：manifest/materials 结构性审计——导出产物 grep 不到 key_sealed/
   api_key/token 任何形态（smoke 断言）。
5. **UI**：ContestView 工具区「备份导出/恢复导入」两入口；三态强制零 mock；
   导入走既有 draft 核对流（零新界面）。
6. **零改动面**：识别配置表不导出（key_sealed 红线）；ecs-relay/android/docs/18
   零触碰；migration 零新增（无新表——draft 复用）。

## 2. 交付物清单

1. 后端 contestBackupService（或并入 contestService 面）：export/import 两面+校验+
   幂等+审计对齐既有风格。
2. 2 通道+handlers+docs/04 追加（110 就地更新）+ types。
3. smoke +2 fast（cp6-backup-export：manifest 形状/零凭据断言/sha256 复制幂等/
   已存在拒绝；cp6-backup-import：形状校验/缺材料 flag/name+year 去重挂 draft/
   不静默覆盖/确认落库 source='imported'）+计数断言就地更新 108→110。
4. renderer：两入口（三态强制）。
5. docs/22 §9.1 落地注记（对齐 CP5 先例）。

## 3. 门禁与铁律

- tsc 0 + fast（102+2）+ full（192+2）+ mcp 27（**A13 需常驻下线——先停常驻跑 mcp
  再拉回，新铁律见 HANDOFF §7**；smoke 常驻在线可跑）。
- **安装包备料不替换在役**：`npx electron-builder --win --config.directories.output=dist-cp6`
  （独立输出目录），产出 NSIS 件留 dist-cp6/（.gitignore 若不覆盖则补一行），
  **绝不写 dist/win-unpacked**（在役程序不动）；**不发 Release**（docs/22 §10 原文）。
  若 builder 联网卡（SHASUMS Bypass 坑）：HTTPS_PROXY=7897 不可用则走 ECS SOCKS
  （`ssh -D`+`HTTPS_PROXY=socks5h://127.0.0.1:<port>`——注意 electron-builder 吃
  socks 代理需 HTTPS_PROXY 全局 env，实测为准，失败如实上报不硬撑）。
- 每 commit 即 push（墙期配方：ECS SOCKS+git -c http.proxy，用毕杀 ssh）；绝不
  --no-verify；真实启动验收（§10 要求）=**停常驻→npm run dev 起真应用→备份导出/
   导入核对流逐项目视→关 dev→拉回常驻**（单实例铁律）；截图证据落
  acceptance/contestpin/cp6-<ts>/。
- 约束 #4/#28 冲突停手上报；smoke 只增不减；凭据三零；卡死重试 ≤2。

## 4. 汇报

diff 摘要+门禁计数表+dist-cp6 产物清单（asar 依赖抽查可免——无新依赖）+真实启动
验收实录+push 状态。
