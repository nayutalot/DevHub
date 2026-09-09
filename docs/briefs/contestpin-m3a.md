# CP3a 任务书：ContestPin OpenAI 兼容客户端 + 识别配置（M3a）

> 系列权威：docs/22-contestpin-design.md §6（客户端与配置）/ charter §六 §七。
> 执行者：omni-agent，worktree `F:/Active_Project/DevHub-worktrees/contestpin`，分支
> `agent/contestpin`（CP1+CP2+回修 9ab2752 之上继续）。本任务书自包含。

## 0. 时窗红线（最高优先级）

M3-D 72h 观察窗运行中（至 2026-09-10 08:49）：允许编码/`npx tsc --noEmit`/
`node scripts/smoke.mjs --tier=fast`/push origin agent/contestpin。禁止：electron 启动、
全量 smoke/mcp/gradle/adb/打包、杀起进程、占 8746、SSH/ECS、merge/push main、
--no-verify、**真实网络调用任何 API**（本批测试全用注入 fake transport，零联网）。

## 1. 已查明事实链（审计 C + CP1/CP2 落地现状）

- **密钥体系（复用，不自建）**：`src/main/services/apihub/keyStore.ts` — `KeyCrypto`
  注入接口（encrypt/decrypt/plainStore 标记）+ `maskKey`（尾 4 位+长度，全项目唯一
  key 脱敏出口）+ `setKeyCrypto/getKeyCrypto`（:15-53）；生产实现=Electron safeStorage
  由 `src/main/keyStoreWire.ts:29-45` 启动注入（main/index.ts:277），不可用时抛
  KEYSTORE_UNAVAILABLE **拒绝明文**——`plaintextKeyCrypto` 仅为 smoke 夹具默认值。
  envelope 结构先例：`src/main/services/apihub/profileStore.ts:109-145`（sealedToPlain
  解密仅主进程内存瞬间；Renderer 只拿 apiKeyTail/apiKeyLen 掩码）。**本批识别配置
  key_sealed 直接复用 getKeyCrypto()，envelope 形状照抄 profileStore**（自读该文件定
  形，v/sealed/plainStore 字段对齐）。
- **HTTP 范式（唯一出站先例）**：`src/main/services/versionCenter/github.ts:130-151,
  183-205` = 原生 fetch + AbortSignal.timeout + User-Agent + 结构化 {ok,error}；
  全仓无 OpenAI 兼容客户端（零命中）、无连接测试——本批为首建。
- **表已建**（008）：`contestpin_configs`（name/role/base_url/model/key_sealed 可空=
  无鉴权/timeout_ms/last_test_at/last_test_ok/last_test_usage_json，UNIQUE(name,role)）。
- **settings**：`contestpin_default_mode` 已在白名单（CP1）——renderer 经既有
  `settings:get`/`settings:set` 读写即可，**不新增通道**。
- **通道计数**：现 84（CP1 9+CP2 5），计数断言 4 处（step1/step6/s4-68/ac2-84）。
- **LR1 不耦合**（docs/22 §6 裁决）：LR1 客户端=纯文本无鉴权 advisory；本批=
  vision+鉴权+多配置超集，独立实现，留后续重构去重。
- **handlers 禁 electron import**；service 层 electron-free；SQL 全参数绑定；
  错误 ServiceError（services/internal.ts:21）。

## 2. 交付物清单

### 2.1 `src/main/services/contestpin/openaiClient.ts`（electron-free，零新依赖）

- **传输注入**：`export type ChatTransport = (url: string, init: RequestInit) => Promise<{ status: number; bodyText: string }>`；`setChatTransport()/getChatTransport()`（默认实现=原生 fetch，读 body text；smoke 注入 fake，零联网）。
- **chatCompletion(config, messages, opts)**：
  - config={baseUrl, model, apiKey?, timeoutMs?}；URL 规范化：baseUrl 去尾斜杠；若
    已以 `/chat/completions` 结尾则原样用，否则追加 `/chat/completions`（兼容
    `https://x/v1` 与 `https://x/v1/` 两种写法，测试锚定）。
  - POST JSON：`{ model, messages, stream:false }`；messages 支持 OpenAI 格式
    content 数组（`{type:'text',text}` + `{type:'image_url',image_url:{url:
    'data:image/png;base64,...'}}`，vision 用）；apiKey 仅在内存拼
    `Authorization: Bearer` 头，**绝不进日志/错误对象/返回值**。
  - 超时：`AbortSignal.timeout(timeoutMs ?? 60000)`；opts.signal（外部取消）用
    `AbortSignal.any([timeout, external])` 合并（Node ≥20 支持；若 TS lib 类型缺失
    就窄化为任一实现并注明）。
  - **错误分类结构化**（ServiceError 或专用 result 判别联合，二选一并注明）：
    AUTH（401/403）/ RATE_LIMIT（429）/ TIMEOUT（AbortError/TimeoutError）/
    NETWORK（fetch reject）/ BAD_RESPONSE（2xx 但非 JSON/缺 choices）/ HTTP_ERROR
    （其余非 2xx，带 status）。错误 message 不得含 key、完整请求体。
  - **usage 捕获**：响应体含 `usage` 字段才返回实测值，否则 `usage:'unknown'`；
    成功返回 `{ ok:true, content, usage, latencyMs }`（content=choices[0].message.
    content 字符串）。
- **连接测试辅助**：`probeConfig(config)` — text 角色：messages=[{role:'user',
  content:'ping'}]；vision/multimodal 角色：附 1x1 红色 PNG base64（常量内嵌，约
  100 字节）+ "Describe this image in one word."；返回 ok/latencyMs/usage/错误分类。

### 2.2 `src/main/services/contestpin/recognitionConfigService.ts`（electron-free）

- CRUD：`listConfigs()`（掩码视图：apiKeyTail/apiKeyLen/apiKeySet 布尔，**绝不含
  明文或 sealed**）；`saveConfig(payload)`（id 可空=新建；**apiKey 空串/undefined=
  保持既有**，密码框约定先例 ApiHubView.tsx:436-438；baseUrl http/https 校验【复用
  overlayStateService.validateExternalUrl 风格，但本地实现勿跨域耦合】；name/role/
  model 必填；UNIQUE(name,role) 冲突 → ServiceError 合理码）；`deleteConfig`（
  CONFIRM_REQUIRED 两段式：impacts=引用该配置的 import_jobs 计数——CP3b 表已存在，
  直接 COUNT）；`testConfig(id)`：解密（getKeyCrypto）→ probeConfig → 落
  last_test_at/last_test_ok/last_test_usage_json（**仅真实返回才写实测 usage**）→
  返回测试结果（含错误分类文案：鉴权失败/限流/超时/格式错误/图片不支持——
  IMAGE_UNSUPPORTED 若服务端错误信息可判（含 'image'/'multimodal' 字样映射），
  不可判归 HTTP_ERROR/BAD_RESPONSE 并原样带简短摘要）。
- key_sealed 写入：`getKeyCrypto().encrypt(plainKeyJson)` 照 profileStore envelope；
  key 为空字符串的配置（无鉴权端点）key_seald=NULL 允许保存。
- 解密只在 testConfig/（CP3b 的识别调用）瞬间，结果不落任何日志/缓存。

### 2.3 通道 +4（84→88）+ 三件套

`contestpin:configList`(READ_ONLY 掩码) / `contestpin:configSave` / 
`contestpin:configDelete`（两段式）/ `contestpin:configTest`。channels/types/handlers
三件套 + docs/04 四行（状态 CP3a 已落地（88），payload/result 逐字）+ smoke 计数
4 处就地更新 84→88 + docs/22 §3 CP3 预告行加注（+4 已落地，余 +8 归 CP3b）。

### 2.4 Renderer：识别配置面板

ContestView 内「识别设置」折叠面板（或独立小节，循现有组件风格）：按角色分组列表
（vision/text/multimodal 三组，掩码 key 显示）、新建/编辑表单（name/role 选择/
baseUrl/model/apiKey 密码框留空=不改/超时毫秒）、测试按钮（显示 ok/延迟/实测
usage/分类错误文案）、删除两段式确认、默认模式选择（two_stage/multimodal，经既有
settings:get/set 读写 contestpin_default_mode）。三态无 mock。

### 2.5 smoke（fast，零联网——全部 fake transport）

- `cp3a-config-crud`：plaintext fixture setKeyCrypto → save（含 key）/list 掩码
  （断言不含明文与 sealed）/空 key 保持/testConfig 落 last_test_*/delete 两段式。
- `cp3a-client-taxonomy`：fake transport 分别回 401/429/500/非 JSON/2xx 无 usage/
  2xx 带 usage/AbortError → 分类与 usage 断言；fake 抛 network reject → NETWORK。
- `cp3a-baseurl-normalize`：`https://x/v1`、`https://x/v1/`、已带 /chat/completions
  三形态 URL 断言（经 fake transport 捕获 url）。
- 计数 84→88（4 处就地+注记）。

## 3. 完成定义

1. `npx tsc --noEmit` 0 error；2. `node scripts/smoke.mjs --tier=fast` 全过
   （88→91±）；3. 红线自查：services/contestpin 零 electron import、零真实网络
   （fake transport 全覆盖，默认传输仅在生产可达）、无 key 进日志/错误/返回值、
   SQL 全绑定；4. 最终消息：commit 列表+验证摘要+偏差清单+「CP3b 衔接注记」
   （client 暴露面/状态机预留点，供下一批任务书引用）。

## 4. 提交纪律

同前：增量提交（`feat(contestpin): …`），每 commit 即 push origin agent/contestpin；
不 merge 不 push main；不可调和冲突停下上报。
