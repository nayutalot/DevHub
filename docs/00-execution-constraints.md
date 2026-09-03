# DevHub 执行约束合同（Execution Constraints）

> 本文件是 DevHub 项目的最高约束合同。所有 Step 的设计、编码、测试、验收都必须遵守本文档的 28 条约束。
> 每个 Step 开工前必须重读本文档。每 Step 交付物与本文档冲突时，以本文档为准并上报冲突。

约束共 28 条，分四类：流程类（1–6）、安全类（7–14）、架构类（15–22）、质量类（23–28）。

---

## 一、流程类（1–6）

1. **先规划后写码。** 每个 Step 开工前必须重读本文档与该 Step 涉及的设计文档（01–07），明确交付物清单与验收标准后再动手编码。
2. **每 Step 完成必须立即验证。** 每 Step 结束时必须真实执行 `npx tsc --noEmit && node scripts/smoke.mjs`，两者全绿（0 error、全部用例通过）才算该 Step 完成；失败必须修复后重跑。
3. **不擅自扩大范围。** 只实现当前 Step 交付物清单内的内容；过程中想到的改进一律记入 backlog，不顺手实现。
4. **架构冲突停止上报。** 编码中发现实现需求与 00/02/03/04 文档存在不可调和的冲突时，停止编码并上报决策者，不得自行选择替代架构方案继续推进。
5. **最终验收必须真实启动应用。** Step 8 验收必须真实启动 Electron 应用（`npm run dev` 或 build 后运行），并对四个视图逐一目视验证；禁止仅以 tsc/smoke 通过代替真实启动验收。
6. **文档权威原则。** 每 Step 交付物与本文档冲突时，以本文档为准；实现与文档的偏差必须如实上报，不得静默修改文档迁就实现。

## 二、安全类（7–14）

7. **唯一 spawn 入口。** 全项目唯一允许调用系统进程的入口是 `src/main/core/exec.ts`；其他任何模块不得直接使用 `child_process` 的 spawn/exec/execFile 及其同步变体。
8. **参数数组、禁止 shell 拼接。** 所有外部命令一律以参数数组形式传给 exec 内核；exec 内核不设置 `shell: true`；严禁把用户数据、路径、端口等拼接进命令字符串（防 shell injection）。
9. **强制 timeout。** 所有外部命令必须携带超时（默认 15 秒，可按调用显式放宽）；超时后终止进程并返回结构化超时错误，不允许无限等待。
10. **结构化捕获。** exec 内核必须捕获 stdout、stderr 与 exit code，并返回结构化结果对象；禁止只向上层返回拼接后的裸字符串。
11. **SQL 参数绑定。** 所有 SQL 一律使用 `?` 占位符 + 参数数组绑定，禁止字符串拼接或 format 模板组装 SQL。唯一例外：`PRAGMA user_version = N` 因 SQLite 不支持参数绑定，必须使用字面量赋值。
12. **PowerShell 静态字面量。** 内嵌 PowerShell 脚本必须是静态字面量（固定字符串）；所有动态值（路径、参数等）一律通过 `$env:` 环境变量传入子进程，不得插入脚本正文。
13. **日志脱敏。** 日志与错误信息中不得写入密钥、token、凭据；敏感路径全文按需截断或脱敏。
14. **结构化错误。** 所有传回 Renderer 的错误必须是结构化对象 `{ code, message }`；不得向 Renderer 抛裸 Error、原始异常对象或堆栈。

## 三、架构类（15–22）

15. **Renderer 零系统权限。** Renderer 禁止执行任何系统命令，禁止直接访问 Node API、fs、child_process、网络探测等宿主能力。
16. **系统操作只经 Service 层。** 所有系统操作（进程、文件、WSL、Docker、Git）必须由 Main Process 的 Service 层执行；Renderer 只消费 IPC 结果。
17. **单一 IPC 网关。** Renderer 只能通过唯一 channel `devhub:invoke`（payload `{ channel, payload }`）调用白名单内的 channel（见 docs/04-ipc-api.md）；网关对未注册 channel 一律拒绝并返回结构化错误。
18. **preload sandbox 化。** preload 必须满足：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`；contextBridge 只暴露一个 `invoke` 方法，不暴露任何 Node 对象。
19. **Adapter 只读。** Adapter 层（windows / wsl / git / docker / fs）只做只读探测：只发现与读取状态，不修改系统、不写业务数据。
20. **Service 层是唯一写库层。** 只有 Service 层允许写 SQLite；Adapter 层与 IPC 层不得直接读写数据库。
21. **migration 只追加。** migration 文件只追加、永不修改历史；版本由 `PRAGMA user_version` 管理（字面量赋值）；已应用的 migration 禁止编辑，新变更一律新增递增序号文件。
22. **通用资源关系模型。** 数据模型不得把资源硬编码进 projects 表；项目与仓库/环境/容器/服务等跨资源关系统一走 `resources` + `relationships` 表（见 docs/05-resource-model.md）。

## 四、质量类（23–28）

23. **无 mock。** UI 不允许任何 mock 数据：Dashboard / Projects / Environment / Services 四视图的全部数据必须来自真实 IPC 调用与真实系统探测。
24. **三态强制。** 每个视图必须实现 loading / empty / error 三态，缺一不可；三态之外的数据展示才算完成。
25. **容错降级。** 单项探测失败不得拖垮整体扫描：任一 Adapter 单项失败必须记入 error_summary 并降级继续其余项。
26. **降级可读。** Docker daemon 不可用、WSL 未安装等场景必须在 UI 显示结构化状态文案（如 "Docker: daemon unreachable"），不得白屏、不得未捕获异常。
27. **smoke 只增不减。** smoke 测试用例随开发步骤累加：每 Step 至少新增 1 个用例；既有用例禁止删除或跳过。
28. **冲突上报。** 每 Step 交付物与本文档冲突时，以本文档为准，并上报冲突内容等待裁决，不得先斩后奏。
