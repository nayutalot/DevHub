# U3 批任务书：会话气泡 markdown 子集渲染（审计 P3#1，最后一条）

> 依据：U-Aud 审计 `acceptance/agents-mobile/ux-audit-20260912/AUDIT.md` P3#1（截图 06/08）：「表格竖线、## 标题、** 加粗原样直出；行内 code 有芯片样式，渲染不完整更显割裂。建议至少支持标题/加粗/表格」。本批=体验线 Android 侧最后一条。
>
> **主控裁决（渲染方案，不重开）**：**零新依赖手写子集渲染器**——纯函数解析（:core）+ Compose 渲染（:app）。理由：APK 零增重、解析可单测（ErrorPresent/SessionTitleOps 同风格）、子集外语法回退纯文本绝不空白（诚实纪律）。不引第三方 markdown 库。

## 0. 红线

- 28 条合同；凭据三零；只动 android/；桌面零触碰。
- **渲染不改内容**：纯展示层；解析失败/未知语法 → 原样纯文本回退（绝不渲染成空白/丢内容）。
- 转录内容是外部产物：解析器必须容忍任意畸形输入（fuzz 式单测：残缺表格/未闭合加粗/超长行）。
- 既有单测锁文案/数字逐一核对；门禁：`cd android && ./gradlew :app:testDebugUnitTest :core:test :app:assembleDebug`（JAVA_HOME 未设用 `D:/Apps/JetBrains/IntelliJ IDEA 2026.1/jbr`；链尾勿加 --stop）。

## 1. 实施面

1. **:core MarkdownOps 纯函数解析器**（新增+单测）：
   - 块级：标题（#~######）、段落、无序/有序列表项、表格（`|` 分隔+`---` 分隔行识别）、代码块（``` 围栏，整块保留原文）；
   - 行内：**加粗**、`行内 code`、*斜体*（可选做）、纯文本；嵌套只做一层（加粗内 code 即止）；
   - 语法子集外 → 该行/块整体按纯文本；解析确定性（同输入同输出）；
   - 单测：审计语料形态（表格/标题/加粗）+畸形输入族（残缺/未闭合/超长/空）+回退断言。
2. **:app 气泡渲染接入**：
   - 既有气泡 Text 路径改：解析结果非平凡（含标题/表格/列表/代码块任一）走渲染器；平凡纯文本走原路径（性能零回退）；
   - 标题=既有 typography 缩阶；加粗=AnnotatedString span；行内 code=沿用既有芯片样式；表格=简易行列表格（列宽自适应、横向可滚动、行分隔线）；代码块=等宽背景块（既有 mono 样式系）；
   - 长转录性能：解析按单条消息记忆化（remember(messageId/content)），LazyColumn 结构零动。
3. **不做**：图片/链接自动开浏览器/任务列表/脚注/HTML 透传（子集外一律纯文本）。

## 2. 交付

- Worktree：`F:/Active_Project/DevHub-worktrees/u3md`，分支 `agent/ux-u3-markdown`（自 main 建后先读 AUDIT.md P3#1 与截图）。
- 增量 commit+push（墙期 SOCKS 配方同前；绝不 --no-verify；当前主树 Mimosa 干净无弹窗）。
- 出包：app-debug.apk → `F:/Active_Project/DevHub/dist/DevHub-Android-0.1.0-debug.apk`（覆盖；记录 sha256+时间戳；dist-cp6 勿碰）。
- 汇报：diff 概览、:app/:core 测试数、APK sha256、push 回执、解析器支持的语法子集清单、偏差如实。
- worktree 准备：android/local.properties 从主仓复制（若缺）。
