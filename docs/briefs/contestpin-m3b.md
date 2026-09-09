# CP3b 任务书：ContestPin 材料导入 + 两阶段识别管线 + 核对界面（M3b）

> 系列权威：docs/22-contestpin-design.md §5（管线）/ charter §五 §六。前置=CP3a 已合
> （main≥551ccb2：openaiClient/recognitionConfigService/contestpin_configs 表/通道 88）。
> 执行者：omni-agent，worktree `F:/Active_Project/DevHub-worktrees/contestpin`，分支
> `agent/contestpin-cp3b`（自 main 切出）。本任务书自包含。

## 0. 纪律（红线）

- 常驻 DevHub.exe 在跑：验证=tsc+`node scripts/smoke.mjs --tier=fast`+ecs 无关；
  **不启动 electron、不跑全量 smoke/mcp、不杀进程、不占 8746**；全量门禁由主控合并前执行。
- **零真实网络**：识别调用一律 fake transport 注入测试；真实 API 调用只发生在生产
  运行期用户触发。凭据三零（源码/示例/测试零凭据字面量）。
- 增量提交每 commit 即 push origin agent/contestpin-cp3b；不 merge 不 push main。

## 1. CP3a 衔接注记（已就位的暴露面，直接用）

- `services/contestpin/openaiClient.ts`：`setChatTransport(t|null)`/`chatCompletion(config,
  messages, {signal})`（判别联合结果）/`probeConfig`/`ChatContentPart(image_url data URL)`。
- `recognitionConfigService`：configList/Save/Delete/Test 四通道已占 88；**需新增内部
  导出 `resolveConfigForCall(id)`**（存在性校验→getKeyCrypto 解密→返回
  {baseUrl,model,apiKey,timeoutMs,role}，明文仅内存瞬间，CP3a 报告建议原样采纳）。
- 008 表 `contest_import_jobs`（九值 stage/vision_fingerprint/params_json/result_json/
  error_json/progress）与 `contest_materials`（sha256 UNIQUE）已建。
- 默认模式 settings `contestpin_default_mode`（two_stage/multimodal）。
- 计数断言 4 处现值=88。

## 2. 交付物

### 2.1 材料导入（service：`services/contestpin/materialService.ts`）

1. `importMaterials(paths[])`/`importImageFromBuffer(name, buf)`（粘贴截图）：读文件→
   sha256→已存在（UNIQUE 命中）返回既有行不重复建→新文件复制到
   `getDataDir()/contestpin/materials/<sha256>.<ext>`→行落库（kind 按 mime/扩展：
   pdf/image/other；pages 对 PDF 延后填充）。
2. 限制（可配常量+params 覆盖）：单文件 20MB、单批 20 份、PDF 50 页；超限结构化
   ServiceError('BAD_PAYLOAD') 带 reason。
3. 通道 +2：`contestpin:materialsList`（READ_ONLY）/`contestpin:importMaterials`
   {paths: string[]}（路径由 renderer 的文件对话框给出；main 侧校验存在+大小）。

### 2.2 本地预处理与依赖裁决（**实测后定，偏差清单报告**）

4. `services/contestpin/pdfService.ts`（electron-free）：
   - **文字/超链接提取**：worktree 内 `npm install pdfjs-dist`（纯 JS）；提取每页文本
     +注释链接（URI）。锚定测试：生成最小合法 PDF 夹具（手写 PDF 字节或用 pdfjs 附
     带测试文件结构）断言文本/链接往返。
   - **页转图**（扫描件视觉路径）：首选 `npm install @napi-rs/canvas`（预编译，纯 Node
     可用）+pdfjs 渲染→JPEG base64；**安装/渲染失败则降级**：kind=pdf 的视觉阶段仅
     支持文字 PDF（本地提取文字直接进文本阶段），扫描 PDF 页转图记 `page_render_
     unavailable` 进 error_json 并在 UI 显示已知限制——不阻塞其余管线。裁决结果与
     理由写偏差清单。
   - 图片材料：直接读 buffer→（如超 2048px 用 @napi-rs/canvas 等比缩放；不可用则原样，
     超 10MB 图片拒收）。
5. **QR 解码**：本批不做（backlog，charter 允许可解码为可选源）。

### 2.3 两阶段管线（`services/contestpin/importPipeline.ts`，注入式可测）

6. 状态机（008 stage 九值）：imported→preprocessed→vision_done→text_done→validated→
   draft→confirmed；failed/cancelled 从任一阶段可达；**每阶段独立重试**（retry 接口
   指定 fromStage，重跑该阶段及以后）。
7. 视觉阶段（two_stage）：按 params（页范围/`skipTextPages` 布尔=用户显式选择）组装
   messages（每页一图 image_url+页码标注 text）→`resolveConfigForCall(vision_config_id)`
   →chatCompletion（AbortController 存句柄供 cancel）→中间结果（逐页 OCR 文本/表格/
   日期/网址/上下文+页码来源）写 result_json.vision，stage=vision_done。
   **缓存**：vision_fingerprint=`<材料sha256>@<hash(baseUrl+model+页参数)>`——与行内
   既存一致且既有 vision 结果可复用时跳过视觉阶段（材料或视觉配置变化即失效重跑）。
8. 文本阶段：输入=vision 结果+本地 pdfjs 提取文本/链接（补充输入）→prompt=跨页整合/
   比赛分类/节点整理/去重/冲突标记→**结构化 JSON 输出契约**（contests 草稿数组：
   名称/年份可空/届次/主办方/链接【仅当来源=原文或 PDF 链接，逐字段带
   {materialId,page,excerpt}】/nodes【precision 语义：原文仅日期→'date'，无年份→
   year 空，待定→'tbd'，**禁止编造/提升精度**】）→解析失败→error_json 结构化
   （BAD_RESPONSE 摘要）可单独重试。
9. 校验阶段（validated）：程序化规则——URL 形状/precision×startAt 组合（复用
   contestService 同款规则抽出的共享校验函数）/来源映射完整性；模糊/冲突打
   flags（{field,reason,excerpt}）展示待核对，**不自动丢弃**。
10. 草稿→确认：draft 行=校验通过的结构化结果；`draftConfirm`（两段式）→经
    contestService 建 contest+nodes（source='imported'）+materials 关联（import_jobs
    contest_id 回填）；相似比赛检测（同 name 或 name+year 近似）→返回新旧 diff 视图
    数据由 renderer 呈现，用户选择合并（更新既有）或另建，**不静默覆盖**。
11. 多模态模式：单次 vision 配置调用直接出结构化 JSON（同 8 契约）→同 9/10 校验核对。
12. 取消与晚到结果：cancel 置 cancelled+AbortController.abort()；**晚到回调检查行
    stage 已 cancelled 则丢弃结果不落库**。进度（progress=已完成页/阶段百分比）。
13. 通道 +6：`contestpin:importCreate` {materialIds[],mode,params?}、`importStatus`
    {jobId}（READ_ONLY 轮询）、`importCancel` {jobId}、`importRetry` {jobId,fromStage}、
    `contestpin:draftList`（READ_ONLY）、`draftConfirm`/`draftDiscard`（两段式，合计
    +6 → 88→96；如拆分不同以实际为准同步 docs/04+计数 4 处）。

### 2.4 核对界面（renderer）

14. Contests 视图新增「材料导入」区：文件选择/拖入（可用 webUtils/对话框经 IPC 由
    main 侧落路径——**renderer 不拿 Node fs**）、粘贴截图、模式选择（默认读
    contestpin_default_mode）、进度列表（阶段/进度条/取消/重试按钮）。
15. 「待核对」草稿界面：字段级来源展示（点击展开 {页码,原文摘录}）、flags 高亮、
    逐字段编辑、批量确认、相似比赛 diff 对比视图、两段式确认弹窗。三态无 mock。

### 2.5 测试（fast 档全 fake）

16. `cp3b-materials`：sha256 去重/复制落盘/超限拒绝/kind 判定。
17. `cp3b-pipeline`：fake transport 驱动全状态机（两阶段 happy path/文本阶段失败单独
    重试/取消后晚到结果丢弃/缓存命中跳视觉/精度规则拒绝 date→exact 编造/多模态同径）。
18. `cp3b-pdf`：pdfjs 文本+链接提取夹具（+页转图若依赖可用，否则断言降级路径）。
19. 计数就地更新（88→96 或实际值）。

### 2.6 文档

20. docs/04（新通道行+计数）、docs/22 §5 状态注记（QR 不做/依赖裁决结果）、
    docs/03 零改动（无新迁移）。

## 3. 完成定义

1. tsc 0；2. smoke:fast 全过；3. 红线自查（electron-free/零真实网络/凭据三零/SQL 绑定/
    晚到丢弃有测试锚定）；4. 最终消息：commit 列表+验证摘要+**依赖裁决结论**（canvas
    可用与否及降级面）+偏差清单+窗毕实机验证清单（真实识别需用户凭据，缺凭据时明确
    标注哪些已实测哪些未验证）。
