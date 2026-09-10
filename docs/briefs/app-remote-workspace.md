# App 批任务书：「远程工作区」屏——WebView 内嵌外部远程控制页（ZCode 移动端遥控等）

> 需求（用户 2026-09-11 凌晨）：ZCode 有「移动端远程控制」页面（桌面端出二维码/链接，
> 手机打开即可遥控工作区）；**二维码/链接是动态的**（会话令牌）——把这类页面
> **内置进 DevHub App**：新增「远程工作区」屏=可配置 URL 条目+全屏 WebView。
> 通用设计：不绑定 ZCode——任何网页终端/控制面板（https）皆可用。
> 执行者：omni-agent，worktree `F:/Active_Project/DevHub-worktrees/app-rws`，
> 分支 `agent/app-remote-workspace`（从 main 切出）。**App-only 批：零桌面/ECS 改动。**

## 0. 主控已核事实链

- 目标页特性（实测截图）：ZCode 云端遥控页——重 JS/WebSocket 交互（终端类），
  动态会话 URL；手机浏览器可完整交互 → Android WebView（JS+DOM storage 开启，
  WebSocket 原生支持）可承载，键盘输入走 WebView 默认软键盘路径。
- App 现状：Compose UI；主导航含 Agents/Device/Settings 等屏（AgentsScreen 等
  先例）；存储=Room（DevHubDb，v4）+ SecureStore（token 专用——本批**不用**，
  URL 非凭据）；:app 单测基线 63。
- **URL 非凭据但按敏感对待**：含会话令牌的 URL 等同临时凭据——存储用 Room 明文
  可接受（本机私有 DB），但**绝不入日志/不外发**；UI 显示时可截断中段。

## 1. 设计裁决（主控定）

1. **屏与入口**：新 `RemoteWorkspaceScreen`，主导航加「远程工作区」入口（与
   Agents/Settings 平级；图标风格对齐既有）。屏内两部分：条目列表（空态引导）
   + 打开后的全屏 WebView（标题栏带返回/刷新/复制当前 URL）。
2. **URL 条目**：字段={标题（用户起名，缺省取 host）, url, createdAt, lastOpenedAt}；
   Room 新表 `remote_workspace_entries`（migration v4→v5，append-only 纪律照 App
   侧 Room 迁移先例=破坏性重建仅当必要，本表新增=安全 migrate）；**剪贴板一键填充**
   （检测 http(s) 链接才亮）；最近使用排序。
3. **WebView 纪律**：
   - `javaScriptEnabled`+`domStorageEnabled` 开（终端类页面必需）；**禁止**
     file/content scheme（shouldOverrideUrlLoading 白名单 http/https——外部
     非协议链接回系统浏览器先例对齐 ContestView openLink 语义可简化为仅拒载）；
   - 加载态/错误态/空态三态强制（约束 #24 口径）；证书错误**绝不 proceed**
     （onReceivedSslError 默认取消——与 App pin-TM 红线同向，不自签放行）；
   - 软键盘：`android:windowSoftInputMode=adjustResize` 局部处理，输入焦点
     正常落 WebView；返回键=先 WebView.canGoBack() 再屏退。
4. **安全红线**：URL 校验 `https?://` 之外一律拒绝（BAD_PAYLOAD 风格结构化提示）；
   零凭据存储零日志；不注入任何 JS；不加 cookie 持久化黑魔法（默认即可）。
5. **零改动面**：ConnectionManager/relay/本地模式全部不碰；桌面仓库零改动。

## 2. 交付物清单

1. `RemoteWorkspaceScreen.kt`+导航接线+Room 表+DAO+migration v5。
2. URL 校验/剪贴板检测纯函数 + :app 单测（≥5：校验拒绝面/剪贴板 http 检出/
   条目排序/空态/标题缺省 host）——基线 63→≥68。
3. 模拟器实测（AVD 先例流程）：装新 APK→加条目（任一 https 页如 example.com）
   →WebView 渲染/返回键/错误态（断网址出错误态）截图证据；
   `acceptance/agents-mobile/remote-workspace-<ts>/`。**ZCode 真实链接留用户终验**
   （动态令牌我侧无留存——用户装包后自行粘贴验证）。
4. `assembleDebug` 产新 APK（覆盖 dist 副本：F:/Active_Project/DevHub/dist/
   DevHub-Android-0.1.0-debug.apk 更新为新构建）。

## 3. 门禁与铁律

- gradle `:app:testDebugUnitTest :app:assembleDebug`（链尾勿 --stop；gradle 独占）；
  每 commit 即 push `agent/app-remote-workspace`（墙期 ECS SOCKS 配方 HANDOFF §7，
  1082 端口，用毕杀 ssh）；绝不 --no-verify。
- App-only：:core 不动（如需 URL 工具函数放 :app 包内）；改桌面 TS=范围违规停手。
- 约束 #23/#24（零 mock/三态）；凭据零入日志；卡死重试 ≤2。

## 4. 汇报

diff 摘要（屏/导航/表/migration/测试）+门禁计数+模拟器截图清单+新 APK 路径与
sha256+push 状态。
