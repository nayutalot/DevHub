# X 批任务书：ZCode 工作区链接 origin 修正（chatglm.site → z.ai）

> 主控已查明的事实链（子代理从结论续做，不重复侦查）：
> - 症状：用户手机扫码（ZCode 桌面出示的 QR）能连上远程控制，DevHub App「ZCode 工作区」连不上（白屏/ERR_CONNECTION_ABORTED code=-6）。
> - 真因：DevHub `zcodeLinkProvider.ts` 硬编码 `ZCODE_LINK_ORIGIN='https://zcode.chatglm.site'`，该域名 **全网死**；QR 实际指向 `https://zcode.z.ai`（活的）。
> - 证据（2026-09-11 夜主控实测）：
>   1. `zcode.chatglm.site` DNS：本机路由器/223.5.5.5/119.29.29.29/8.8.8.8/114.114.114.114 五递归全返回私网死址 **172.25.136.172**（权威记录本身如此）；桌面直连超时、走 7897 代理 CONNECT 隧道建立但上游死、ECS（59.110.149.11 机房）直连超时——四面全死。
>   2. `zcode.z.ai/remote/v4` **直连 HTTP 200**（122.156.129.108）。
>   3. ZCode asar（`C:/Users/sakuya/AppData/Local/Programs/ZCode/resources/app.asar`）反混淆：每个常量组均为 `="https://zcode.z.ai","https://zcode.chatglm.site"` —— **z.ai 是生产主默认**，chatglm.site 仅次选/特例（`resolveWebRemoteControlRelayWsUrl` 里 endpointOrigin 显式等于 chatglm.site 才走它）；endpoint 对话框的 placeholder 文本恰是 chatglm.site —— R 批当年从这里读岔（acceptance/agents-mobile/zcode-url-source-20260911-0415/endpoints-and-url-builder-masked.txt 的「生产默认」推断作废）。
>   4. 推翻旧结论：HANDOFF「白屏=ZCode 服务端双断、App 零责」不成立——V 批隔离 Chrome A/B 测的是死域名故无效；z.ai 一直活着。
> - URL 其余五参数（sid/hash/t/mid/name/app_version）与域名无关，桌面 ZCode 的 relay 注册在 zcode.z.ai 上（`ZCODE_BASE_URL=https://zcode.z.ai`），sid/hash 用在 z.ai 才是对的。
> - Android WebView 白名单按 scheme（http/https）无域名限制，origin 替换无 App 侧阻碍；App 侧零改动。

## 0. 红线（不变）

- 28 条合同（docs/00）；令牌三零（sid/hash/mid/完整 URL 绝不入日志/审计/错误信息/reason）。
- 只改本任务书列出的文件；`exec.ts` 唯一 spawn；SQL 绑定；migration 零触碰。
- 绝不 `--no-verify`；每 commit 即 push 分支；门禁绿才可合 main（主控 merge）。

## 1. 改动面（恰好三处）

1. `src/main/services/agentControl/zcodeLinkProvider.ts`
   - L38：`export const ZCODE_LINK_ORIGIN = 'https://zcode.chatglm.site'` → `'https://zcode.z.ai'`。
   - 同步改 L37 注释：生产默认 origin 的证据来源更正为「asar 反混淆主默认+2026-09-11 实测 z.ai 直连 200 / chatglm.site DNS→私网死址四面不通；endpoint 对话框 placeholder=chatglm.site 曾致误读」。注释保持简洁、不含任何 sid/hash 值。
2. `scripts/smoke.mjs` L11823：
   `assert.ok(okRes.url.startsWith('https://zcode.chatglm.site/remote/v4?'), 'URL prefix: production origin + /remote/v4')`
   → 前缀换 `https://zcode.z.ai/remote/v4?`（断言文案不变）。
3. `scripts/smoke.mjs` L11950：
   `assert.ok(result.json.result.url.startsWith('https://zcode.chatglm.site/remote/v4?'), 'url has the v4 prefix (shape)')`
   → 前缀换 `https://zcode.z.ai/remote/v4?`（断言文案不变）。

不增删用例——smoke 计数断言零触碰（预期 fast 仍 196）。

## 2. 环境与门禁

- Worktree：`F:/Active_Project/DevHub-worktrees/xfix`，分支 `agent/zcode-origin-fix`，自 `main`（372a24d）建。
- **worktree 无 node_modules 先 `npm install`**（或 npm ci；以 lock 可装为准）。
- 门禁（顺序执行，全绿才算完）：
  1. `npm run typecheck` → 0 error。
  2. `npm run smoke:fast` → 全绿（预期 196/196；用例数不因本批变化）。
- 跑 smoke 前双杀 `DevHub.exe`+`electron.exe`（端口铁律；杀不到就如实记录，勿谎报）。
- 毕后**不拉起常驻**（后续重打包换装批会拉起新版）。

## 3. 交付与汇报

- Commit（1 个即可，信息形如 `fix(agents): ZCode 工作区链接 origin 修正 chatglm.site→zcode.z.ai——R 批 placeholder 误读改判（chatglm.site 四面死/z.ai 直连 200 实测）+smoke 两断言同步`），push 分支 `agent/zcode-origin-fix`。
- 汇报：diff 摘要（三处）、typecheck 输出尾行、smoke:fast 总分、push 回执；任何偏差如实报告，不擅自扩面。
