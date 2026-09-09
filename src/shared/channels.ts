/**
 * IPC channel registry (docs/04-ipc-api.md).
 *
 * Renderer traffic goes through the single gateway channel `devhub:invoke`
 * with payload `{ channel, payload }` (constraint #17). The gateway must
 * reject anything not listed in IPC_CHANNELS with CHANNEL_NOT_ALLOWED.
 *
 * This module is the single source of truth for the whitelist; the gateway
 * (Step 6) and the preload bridge (Step 6) both consume it.
 */

/** The one and only gateway channel exposed to the Renderer. */
export const IPC_GATEWAY = 'devhub:invoke' as const

/**
 * Whitelisted business channels, in docs/04 order:
 * 3 scan + 6 projects CRUD + 4 open + 2 environment + 2 services + 4 dashboard/settings/app = 21,
 * plus the S2 skills group (docs/09 §9 skills entries + the agent-registry /
 * linkStates / companion channels this batch requires) = 14 more (35),
 * plus the S3 apihub group (docs/09 §9: adapters / current / profiles / saveProfile /
 * deleteProfile / switch) = 6 and versions group (docs/09 §9: list / check / update / job) = 4,
 * plus the S4 docker/wsl group (docs/09 §8/§9: docker overview / logs / action +
 * wsl action / distroStats) = 5 more, total 50,
 * plus the S5 archive group (docs/10 §11: preview / run / history / rollback /
 * status) = 5 more, total 55. archive:precheck 并入 preview（占用扫描即预览
 * 影响面的一部分）；archive:settings 不设专用 channel——dest_root 读写由
 * settings:get/set（key=archive_dest_root，003 已覆盖）承担。
 * AC2 批次 note（docs/14 §A.1 授权的同一模式更新）：agents 13 条并入，55 → 68
 * （providers/sessions/sessionDetail/messages/events/sessionAction/pairingCreate/
 * devices/deviceRevoke/gatewayStatus/gatewayRestart/setAutoStart/diagnostics；
 * 全部为轮询模式，无广播 channel，docs/14 §A.3）。
 * 夜间#1 批次 note（主控任务书授权的同一模式就地更新）：versions:cancel（docs/09
 * §7.2 cancelled 分支主动取消）+ agents:probeProvider（UX 验收 backlog，
 * known-limitations §3.2 per-provider 单独重探）并入，68 → 70。
 * CP1 批次 note（ContestPin，docs/04「ContestPin 追加」节 + docs/22 §3 授权的同一
 * 模式就地更新）：contestpin 9 条并入，70 → 79（list/get/create/update/delete/
 * archive/nodeUpsert/nodeDelete/linkProject；delete/nodeDelete 为 CONFIRM_REQUIRED
 * 两段式，先回 impacts）。
 * CP2 批次 note（ContestPin 悬浮窗，docs/22 §4 + docs/04「ContestPin 追加」节授权的
 * 同一模式就地更新）：contestpin 5 条并入，79 → 84（overlayState READ_ONLY /
 * overlaySetEnabled / overlaySetCollapsed / openInMain / openLink——openLink 仅
 * http/https 经 service validateExternalUrl 校验后默认浏览器；窗口胶水在
 * overlayWire.ts，handlers 经 overlayStateService 注入 applier，零 electron import）。
 * CP3a 批次 note（ContestPin 识别配置，docs/22 §6 + docs/04「ContestPin 追加」节
 * 授权的同一模式就地更新）：contestpin 4 条并入，84 → 88（configList READ_ONLY
 * 掩码 / configSave / configDelete CONFIRM_REQUIRED 两段式 / configTest——
 * service 经 openaiClient 传输注入面，smoke fake transport 零联网）。
 * LR1 批次 note（LLM 复核层 advisory-only，docs/04「LR1 追加」节 + 任务书 §8
 * 授权的同一模式就地更新）：review/archive-review/skills-review 4 条并入，
 * 88 → 92（review:testEndpoint / archive:reviewPre / archive:reviewPost /
 * skills:reviewMeta——全 READ_ONLY，service 经 reviewClient 传输注入面，
 * smoke fake transport 零联网；advisory-only 永不阻塞归档主流程）。
 */
export const IPC_CHANNELS = [
  // scan
  'scan:start',
  'scan:status',
  'scan:cancel',
  // projects CRUD
  'projects:list',
  'projects:get',
  'projects:add',
  'projects:remove',
  'projects:rescan',
  'projects:update',
  // projects open
  'projects:openFolder',
  'projects:openVSCode',
  'projects:openTerminal',
  'projects:openWSL',
  // environment
  'environment:detect',
  'environment:doctor',
  // services
  'services:list',
  'services:refresh',
  // dashboard / settings / app
  'dashboard:summary',
  'settings:get',
  'settings:set',
  'app:version',
  // skills（S2 批次，docs/09 §9 skills 条目 + 本批必需的 agent 注册表/链接态/companion 条目；
  // 文档 skills:toggleLink 命名为准，docs/09 未列的 5 条为任务书要求的 CRUD/探测通道）
  'skills:scan',
  'skills:scanWsl',
  'skills:list',
  'skills:agents',
  'skills:linkStates',
  'skills:toggleLink',
  'skills:import',
  'skills:doctor',
  'skills:repair',
  'skills:sync',
  'skills:agent.upsert',
  'skills:agent.remove',
  'skills:companion.status',
  'skills:companion.deploy',
  // apihub（S3 批次，docs/09 §9 apihub 条目；变更动作 saveProfile/deleteProfile/switch
  // 的 CONFIRM_REQUIRED 语义在 service 层落地）
  'apihub:adapters',
  'apihub:current',
  'apihub:profiles',
  'apihub:saveProfile',
  'apihub:deleteProfile',
  'apihub:switch',
  // versions（S3 批次，docs/09 §9 versions 条目；job 快照经 versions:job 轮询。
  // versions:cancel 为夜间#1 批次追加：docs/09 §7.2 cancelled 分支的主动取消，
  // 缺省 jobId = 取消当前唯一活跃任务，无活跃任务 → 结构化空操作）
  'versions:list',
  'versions:check',
  'versions:update',
  'versions:job',
  'versions:cancel',
  // docker（S4 批次，docs/09 §9 docker 条目按文档命名：overview/logs/action；
  // 变更动作 action 的 CONFIRM_REQUIRED 两段式语义在 service 层落地）
  'docker:overview',
  'docker:logs',
  'docker:action',
  // wsl（S4 批次，docs/09 §8.2/§9 授权随 Environment 扩展批次并入：action +
  // distroStats；boot 无害直接执行，terminate 为 CONFIRM_REQUIRED 两段式）
  'wsl:action',
  'wsl:distroStats',
  // archive（S5 批次，docs/10 §11：preview/run/history/rollback/status。
  // preview 强制 dry-run 只读；run 必须携带 preview 签发的 previewId 且 confirmed
  // 才执行（安全规则 1/2）；rollback 为 CONFIRM_REQUIRED 两段式；status 为执行期
  // 进度轮询（docs/10 §11「不新增广播 channel」）；dest_root 读写复用 settings:get/set）
  'archive:preview',
  'archive:run',
  'archive:history',
  'archive:rollback',
  'archive:status',
  // agents（AC2 批次，docs/14 §A.1 逐字命名；顺序照 A.1 表 1-13。
  // 全部为 renderer 轮询 channel——不新增广播/推送 channel，docs/14 §A.3）
  'agents:providers',
  'agents:sessions',
  'agents:sessionDetail',
  'agents:messages',
  'agents:events',
  'agents:sessionAction',
  'agents:pairingCreate',
  'agents:devices',
  'agents:deviceRevoke',
  'agents:gatewayStatus',
  'agents:gatewayRestart',
  'agents:setAutoStart',
  'agents:diagnostics',
  // 夜间#1 批次：per-provider 单独重探（UX 验收 backlog，known-limitations §3.2；
  // 轮询模式不变，docs/14 §A.3 授权的同一追加模式）
  'agents:probeProvider',
  // contestpin（CP1 批次，docs/04「ContestPin 追加」节逐字命名；delete/nodeDelete
  // 为 CONFIRM_REQUIRED 两段式——缺省回 { confirmRequired: true, impacts }，
  // docker:action / archive:run 先例；全部轮询 channel，无广播）
  'contestpin:list',
  'contestpin:get',
  'contestpin:create',
  'contestpin:update',
  'contestpin:delete',
  'contestpin:archive',
  'contestpin:nodeUpsert',
  'contestpin:nodeDelete',
  'contestpin:linkProject',
  // contestpin（CP2 批次，docs/22 §4 悬浮窗：overlayState READ_ONLY；开关/折叠
  // 经 settings 持久化 + overlayWire 窗口即时生效；openInMain 聚焦主窗口导航
  // contest:<id>；openLink 仅 http/https，service 校验后默认浏览器）
  'contestpin:overlayState',
  'contestpin:overlaySetEnabled',
  'contestpin:overlaySetCollapsed',
  'contestpin:openInMain',
  'contestpin:openLink',
  // contestpin（CP3a 批次，docs/22 §6 识别配置：configList READ_ONLY 掩码视图；
  // configSave 密码框留空=不改 key；configDelete 为 CONFIRM_REQUIRED 两段式——
  // 缺省回 { confirmRequired: true, impacts: { importJobs } }；configTest 解密→
  // probeConfig→落 last_test_*，传输面经 openaiClient 注入，测试零联网）
  'contestpin:configList',
  'contestpin:configSave',
  'contestpin:configDelete',
  'contestpin:configTest',
  // LLM 复核层（LR1 批次，docs/04「LR1 追加」节逐字命名；全 READ_ONLY，
  // advisory-only：复核结果永不阻塞归档主流程，端点未配置/不可达 → skipped）
  'review:testEndpoint',
  'archive:reviewPre',
  'archive:reviewPost',
  'skills:reviewMeta',
] as const

/** Compile-time whitelist: a handler map must be keyed by IpcChannel. */
export type IpcChannel = (typeof IPC_CHANNELS)[number]
