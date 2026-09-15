# UX-Z2 批任务书：对话 v2 结构层（工作区任务列表+composer-first+模型弹层）

> 背景：docs/28 规格（UX-Z1 批，主控已裁决：B 档前提授权〔桌面只读聚合投影+workdir/模型字段追加，纯只读零协议破坏〕/Z2 先行/chips 按 DevHub 语境重写四枚/C 档零出现不画入口）。本批=Z2 结构层。基线 main=UX-Z1 docs 合并后 main；门禁 fast 140/full 242/:app 177/:core 322。

## 0. 工作区与纪律

- worktree：主仓根 `git worktree add worktrees/uxz2 -b agent/uxz2-structure main`；`npm install`；`cp /f/Active_Project/DevHub/android/local.properties android/local.properties`；gradle JAVA_HOME jbr。
- 每 commit 即 push 分支（直连优先 socks5h 兜底重试循环）；绝不 push main；绝不 --no-verify；凭据三零。
- 资源：gradle+模拟器（走查）归本批；常驻零需求（桌面只读投影不动运行时）。

## 1. 桌面侧（只读聚合投影，零协议破坏）

- SessionView 投影追加 workdir/当前模型字段（agentControlService.ts:324 现出 projectId 不出 workdir——纯追加，既有字段零变化）；sessions list 只读聚合投影（GROUP BY workdir：组名/路径/对话数/最近活动——provider 侧 workdir 已落库 zcodeProvider.ts:1025/1315、deepseekProvider.ts:593/1290）。
- smoke 断言联动（新增字段断言，既有断言零删改）。

## 2. Android 侧（结构层四件，docs/28 §规格为准）

1. **对话 tab 段控**「最近对话｜工作区」：工作区视图=卡片列表（类型图标+名称+路径+N 个对话+「更新于 X」相对时间+chevron 展开任务行+「+ 新对话」）；分组键=workdir 归一（缺失归「未分组」尾部）；组间按最近活动降序；WebView 遥控置顶卡保留并存。Room 增列/查询如需（迁移遵守既有 Room 迁移纪律）。
2. **composer-first 新建流**（升级替换 P3 开始对话）：迁至对话 tab（助手页按钮跳转+聚焦 autoOpenSpawn 复用）；问候语按时段文案池（无称呼不伪造）；**快捷 chips 四枚按 DevHub 语境重写**（如「报错修复」「写个脚本」「代码解读」「接着上次任务」——预设表常量+点击仅填入）；**模型选择弹层诚实三态**（可选面=managed_model 设置值展示〔zcode/deepseek 现有键，展示不承诺切换〕/托管停用态/observed 不画入口）。
3. **相对时间**：TimeFmt 增「更新于 X」（刚刚/N 分钟前/N 小时/N 天）——与桌面 relativeTime 中文口径一致。
4. **杂项**：MessageBubble 复制钮；statusDetail 工程串「turn/end (seq 806)」人话化收口（词表漏网）。

## 3. 红线

C 档零出现（本地/远程 tag/附件/@///$ /记忆 pill/撤销——不画入口）；U1-U5/P1-P3 已落面不回退；不伪造状态（数据没有就不画——A4 教训）；ControlGate/会话门语义不动；深链零破坏。

## 4. 门禁与验证

- typecheck 0 + fast 全绿（基线 **140/140**）+ full 全绿（基线 **242/242**）+ build；:app/:core 全绿（基线 **177/322**，如实增改）。
- 模拟器走查（headless）：段控两视图/工作区卡片分组与相对时间/新建流四要素/chips 填入/模型弹层三态/复制钮——截图入 `acceptance/uxz2-walkthrough/`（盘凭据）。新 APK 覆盖 dist 登记 sha256。

## 5. 汇报

commits / 逐元素对照 docs/28（A/B 档销账清单）/ 门禁数字（fast/full/:app/:core）/ 走查截图清单 / APK sha256 / 偏差如实。
