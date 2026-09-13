package com.devhub.mobile.connect

import android.content.Context
import com.devhub.mobile.core.LogRedactor
import com.devhub.mobile.data.RemoteWorkspaceUrl
import com.devhub.mobile.data.db.DevHubDb
import com.devhub.mobile.data.db.RemoteWorkspaceEntryEntity
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * S 批「ZCode 工作区」智能条目状态机（docs/18 §5.3 注记；任务书 §1 #4）。
 * 纯逻辑（:app 单测直锁）：Idle → Requesting → Ready/Queued/Unavailable。
 * **URL 敏感对待**：状态机只持 entryId 与展示文案，URL 不进文案、不进日志——
 * 点击打开走 Room 条目 → 既有全屏 WebView 面（Q 批）。
 */
object WorkspaceLinkCard {

    /** 智能条目固定标题（Room 行的保留标题；自动建/更新置顶条目的定位键）。 */
    const val ENTRY_TITLE = "ZCode 工作区"

    /**
     * T1 批：find-or-create 纯决策（WorkspaceLinkController.upsertEntry 的执行计划，
     * :app 单测直锁「固定保留标题零重复行」契约）。
     */
    sealed interface EntryUpsertPlan {
        /** 已有行 → 只刷新该行（URL + 时间戳），绝不堆积重复行。 */
        data class UpdateExisting(val entryId: Long) : EntryUpsertPlan

        /** 无行 → 按固定保留标题插入新行。 */
        data class InsertNew(val title: String, val url: String, val createdAtMs: Long) : EntryUpsertPlan
    }

    /**
     * find-or-create 计划（纯函数）：按既往行存在与否二分。
     * id>0 才视为有效行（Room 自增 id 恒 ≥1；非正形态走插入兜底——与 DTO 投影
     * `takeIf { it > 0 }` 同惯例），绝不 update 到不存在的行。
     */
    fun planUpsert(existingId: Long?, url: String, nowMs: Long): EntryUpsertPlan =
        if (existingId != null && existingId > 0) {
            EntryUpsertPlan.UpdateExisting(existingId)
        } else {
            EntryUpsertPlan.InsertNew(title = ENTRY_TITLE, url = url, createdAtMs = nowMs)
        }

    sealed interface State {
        /** 未请求（本进程首次进入前）。 */
        data object Idle : State

        /** 自动请求进行中（ack/result 等待）。 */
        data object Requesting : State

        /** 已取得链接并建/更新置顶条目（entryId = 点击即开的面）。 */
        data class Ready(val entryId: Long, val deviceName: String?) : State

        /** 离线桌面/queued:true（行已入队同 key 补发）→ 排队提示照 relay 语义。 */
        data object Queued : State

        /** 结构化不可用：桌面 ZCODE_LINK_UNAVAILABLE / 链接白名单复检拒绝 / 拒绝码。 */
        data class Unavailable(val code: String, val message: String) : State

        /**
         * U5 批（Z3 结论 B 方案①）：本地模式诚实态——本地帧协议无 workspace_link
         * 结算回程（结构性恒 Queued），App 侧不发起取链；卡显三入口统一诚实文案
         * （InteractionHonesty.ZCODE_REMOTE_LOCAL_UNAVAILABLE），绝不渲染排队/重试。
         * 判定源 = WorkspaceLinkModePolicy（纯函数，:app 单测直锁）。
         */
        data object NotAvailableInLocal : State
    }

    /**
     * WorkspaceLinkSubmit → 卡片状态投影（纯函数；Executed 仍经 RemoteWorkspaceUrl.parse
     * 白名单复检——桌面来源不豁免 App 侧 http(s) 红线）。
     */
    fun reduce(submit: WorkspaceLinkSubmit, entryId: Long?): State = when (submit) {
        is WorkspaceLinkSubmit.Queued -> State.Queued

        is WorkspaceLinkSubmit.Failed -> State.Unavailable(submit.code, submit.message)

        is WorkspaceLinkSubmit.Executed -> when (RemoteWorkspaceUrl.parse(submit.url)) {
            is RemoteWorkspaceUrl.Verdict.Ok ->
                entryId?.let { State.Ready(it, submit.deviceName) }
                    ?: State.Unavailable("BAD_PAYLOAD", "链接已取得但条目写入失败")

            else ->
                State.Unavailable("BAD_PAYLOAD", "链接未通过 http(s) 白名单校验")
        }
    }
}

/**
 * S 批「ZCode 工作区」智能条目控制器（应用内单例，DevHubApp.onCreate init）：
 * - `request()`：submitWorkspaceLink（relay 面）→ Executed 时自动建/更新置顶条目
 *   （固定标题定位；已有行 = 更新 URL 与时间戳，绝不堆积重复行）→ Ready(entryId)；
 * - tab 打开自动请求（RemoteWorkspaceScreen LaunchedEffect）；幂等：Requesting 中
 *   重复请求直接忽略（避免风暴）；Queued/Unavailable 后再请求允许重试；
 * - 令牌红线：URL 只在 Room 条目（本机私有）与内存流转，零日志零外发。
 */
object WorkspaceLinkController {
    private const val TAG = "WsLinkCtl"

    /**
     * P0 热修（2026-09-13）：作用域异常兜底——SupervisorJob 不拦异常，未捕获 Throwable
     * 会直达进程默认处理器=闪退。取链失败面（连接未就绪/解析异常等）降级为结构化
     * Unavailable（code=INTERNAL_ERROR，scrub 后 message）如实落卡，**永不闪退**。
     */
    private val scopeGuard = CoroutineExceptionHandler { _, err ->
        android.util.Log.w(TAG, "workspace link scope uncaught: ${LogRedactor.scrub(err.message ?: err.javaClass.simpleName)}")
        _state.value = WorkspaceLinkCard.State.Unavailable(
            "INTERNAL_ERROR",
            "取链请求内部错误（${err.javaClass.simpleName}）",
        )
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO + scopeGuard)
    private var appContext: Context? = null
    private var db: DevHubDb? = null

    private val _state = MutableStateFlow<WorkspaceLinkCard.State>(WorkspaceLinkCard.State.Idle)
    val state: StateFlow<WorkspaceLinkCard.State> = _state

    /** Application.onCreate 接线（幂等）。 */
    fun init(context: Context) {
        if (appContext != null) return
        appContext = context.applicationContext
        db = DevHubDb.get(context)
    }

    /**
     * 发起一次链接查询（tab 打开自动 / 卡片点击重试）。Requesting 中幂等忽略。
     * local 模式：submitWorkspaceLink 走 relay 帧面——未连接（含 local 无 relay WS）
     * 一律 Queued 排队语义，绝不伪造成功。
     *
     * U5 批模式门（Z3 结论 B 方案①；docs/briefs/u5-local-honest.md §1 #2）：
     * local 模式（非 fixture 演示）**不发出 workspace_link 帧**——本地帧协议无
     * command 结算回程，帧必然 10s 超时后入队（幂等键垃圾行），诚实态直接落卡，
     * 零请求零入队零超时等待。relay/fixture/未知模式走现状路径（逐字节不变）。
     */
    fun request() {
        if (_state.value is WorkspaceLinkCard.State.Requesting) return
        val ctx = appContext ?: return
        if (WorkspaceLinkModePolicy.presentation(
                connectionMode = ConnectionManager.configuredMode(),
                fixtureMode = com.devhub.mobile.data.FixtureMode.enabled(ctx),
            ) is WorkspaceLinkModePolicy.Presentation.NotAvailableInLocal
        ) {
            _state.value = WorkspaceLinkCard.State.NotAvailableInLocal
            return
        }
        _state.value = WorkspaceLinkCard.State.Requesting
        scope.launch {
            val submit = ConnectionManager.submitWorkspaceLink()
            var entryId: Long? = null
            if (submit is WorkspaceLinkSubmit.Executed) {
                entryId = runCatching { upsertEntry(submit.url) }
                    .onFailure { android.util.Log.w(TAG, "entry upsert failed: ${LogRedactor.scrub(it.message ?: "?")}") }
                    .getOrNull()
            }
            _state.value = WorkspaceLinkCard.reduce(submit, entryId)
        }
    }

    /**
     * 固定标题定位的建/更新（零重复行）：无行 → 插入；有行 → 更新 URL + 时间戳。
     * 返回条目 id（点击即开的导航键）。执行计划由 WorkspaceLinkCard.planUpsert
     * 纯决策给出（:app 单测直锁），本函数只承担 DAO IO。
     */
    private suspend fun upsertEntry(url: String): Long = withContext(Dispatchers.IO) {
        val dao = db!!.remoteWorkspaceEntryDao()
        val now = System.currentTimeMillis()
        when (val plan = WorkspaceLinkCard.planUpsert(dao.getByTitle(WorkspaceLinkCard.ENTRY_TITLE)?.id, url, now)) {
            is WorkspaceLinkCard.EntryUpsertPlan.UpdateExisting -> {
                dao.updateUrl(plan.entryId, url, now)
                plan.entryId
            }

            is WorkspaceLinkCard.EntryUpsertPlan.InsertNew ->
                dao.insert(
                    RemoteWorkspaceEntryEntity(
                        title = plan.title,
                        url = plan.url,
                        createdAtMs = plan.createdAtMs,
                    ),
                )
        }
    }
}
