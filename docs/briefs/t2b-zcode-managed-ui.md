# T2b 批任务书：zcode 托管模型键设置卡（renderer 补面）

> 背景：T2 已实现 zcode 托管面（main 进程），settings 键 `zcode_managed_model`（值=完整 "provider/model" 串，默认空=停用）已入白名单（settingsService 19 键），但 **renderer 零 UI**——用户无入口填键，托管面无法启用。本批=最小 renderer 补面，让用户能在 DevHub 桌面设置里配置该键。

## 0. 红线

- 28 条合同；只动 `src/renderer`（+若确需 preload 通道核对既有 settings:get/set 通道复用，**零新通道**——settings:set 白名单已含该键）；`src/main` 与 `android/` 零触碰。
- 凭据三零：本卡只编辑模型串（provider/model），不涉及 key（key 在 ApiHub 档案）；值展示无敏感物。
- 文案诚实：说明「默认空=托管停用；就绪还需 ApiHub zcode 活动档案（baseURL+密钥）」；就绪状态不在本卡展示（App Agents 页 caps 卡已可见 managed/observed）。

## 1. 改动面

1. 新组件 `src/renderer/src/components/ZcodeManaged.tsx`（**仿 LlmReview.tsx 模式**——先读该文件复用其表单/保存/错误呈现形态）：
   - 单文本框（label=「ZCode 托管模型」，placeholder 例 `zai-glm/glm-4.7`，帮助文案说明 "provider/model" 完整串+默认空=停用+依赖 ApiHub zcode 活动档案）；
   - 保存走既有 settings:set IPC（键 zcode_managed_model）；读取走 settings:get；保存后回显+成功/失败提示；
   - 挂载进既有设置页（LlmReview.tsx 挂哪它挂哪，同层级同间距）。
2. 若 LlmReview 有配套样式/测试形态，对齐复用；renderer 侧如无测试惯例则零新测（smoke 面已锁 settings 键）。

## 2. 门禁与交付

- Worktree：`F:/Active_Project/DevHub-worktrees/t2bui`，分支 `agent/zcode-managed-ui`（自合并 T2 后的 main 建）。
- 门禁：`npm run typecheck`（0）→ `npm run smoke:fast` 全绿（常驻可能在线——卫生批后 fast 常驻在线可跑，无须双杀；若撞端口如实记录再处理）。
- commit+push 分支（墙期 SOCKS 配方同 T1 §2）；绝不 --no-verify。
- 汇报：diff、门禁两数字、挂载位置截图可选（不强求）、push 回执、偏差如实。
