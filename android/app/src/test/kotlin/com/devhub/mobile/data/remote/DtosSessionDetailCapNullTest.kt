package com.devhub.mobile.data.remote

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * CP5 hotfix 单测：[Dtos.parseSessionDetail] 对 capabilities 缺省的宽容纪律。
 *
 * 实证（D 批活体复验 rb5-rb8，logcat FATAL 03:47:26/04:15:19）：managed spawn 成功后
 * App 自动跳会话详情页，桌面内部发起的托管会话（device_id=null）能力投影可为 null →
 * 旧实现 `getJSONObject("capabilities")` 抛 JSONException 即崩（前台服务自愈但体验崩）。
 * 修复后：JSON null / 字段缺失 → 空能力缺省（mode=""、零 granted、verifiedAtSec=0），
 * 绝不抛；字段在 → 原样解析（既有契约回归零变）。
 */
class DtosSessionDetailCapNullTest {

    /** OMITTED 哨兵：body 完全不携带 capabilities 字段（区别于 JSON null 形态）。 */
    private val omitted = Any()

    /** CP5 形态最小 sessionDetail body（managed 会话；capabilities 形态按用例注入）。 */
    private fun detailBody(capabilities: Any?): JSONObject {
        val session = JSONObject()
            .put("id", 501L)
            .put("providerId", 1L)
            .put("nativeId", "native-cp5")
            .put("sessionMode", "managed")
            .put("status", "running")
        val body = JSONObject().put("session", session)
        if (capabilities !== omitted) body.put("capabilities", capabilities)
        return body.put("childSessions", JSONArray())
    }

    private fun assertEmptyCapabilities(caps: CapabilitiesDto) {
        assertEquals("", caps.mode)
        assertTrue(caps.granted.isEmpty())
        assertEquals(0L, caps.verifiedAtSec)
        assertEquals("", caps.evidence)
    }

    @Test
    fun `capabilities json null parses to empty capabilities without throwing`() {
        val dto = Dtos.parseSessionDetail(detailBody(capabilities = JSONObject.NULL))
        assertEmptyCapabilities(dto.capabilities)
        // 崩溃场景正主：session 本体照常解析（跳详情页不再半路崩）
        assertEquals(501L, dto.session.id)
        assertEquals("managed", dto.session.sessionMode)
        assertEquals("running", dto.session.status)
    }

    @Test
    fun `capabilities field missing parses to empty capabilities without throwing`() {
        val dto = Dtos.parseSessionDetail(detailBody(capabilities = omitted))
        assertEmptyCapabilities(dto.capabilities)
        assertEquals(501L, dto.session.id)
    }

    @Test
    fun `capabilities present still parses verbatim`() {
        val caps = JSONObject()
            .put("mode", "managed")
            .put("granted", JSONArray().put("reply").put("pause"))
            .put("verifiedAt", 1757400000L)
            .put("evidence", "probe-ok")
        val dto = Dtos.parseSessionDetail(detailBody(capabilities = caps))
        assertEquals("managed", dto.capabilities.mode)
        assertEquals(listOf("reply", "pause"), dto.capabilities.granted)
        assertEquals(1757400000L, dto.capabilities.verifiedAtSec)
        assertEquals("probe-ok", dto.capabilities.evidence)
    }

    /**
     * DSW 批（docs/briefs/dsw-workspace.md §1）：workspace 可选字段——桌面托管门开
     * 时携带生效工作区（spawn 表单/详情 ⓘ「工作区：<路径>」）；旧桌面/停用面缺失
     * → null（宽容缺省，UI 回退不显示，解析绝不抛）。
     */
    @Test
    fun `workspace parses when present and stays null when missing`() {
        val withWs = JSONObject()
            .put("mode", "managed")
            .put("granted", JSONArray().put("reply"))
            .put("verifiedAt", 1757400000L)
            .put("evidence", "probe-ok")
            .put("workspace", "C:\\Users\\t\\AppData\\Roaming\\DevHub\\dsh-workspace")
        assertEquals(
            "C:\\Users\\t\\AppData\\Roaming\\DevHub\\dsh-workspace",
            Dtos.parseSessionDetail(detailBody(capabilities = withWs)).capabilities.workspace,
        )
        val withoutWs = JSONObject()
            .put("mode", "managed")
            .put("granted", JSONArray().put("reply"))
            .put("verifiedAt", 1757400000L)
            .put("evidence", "probe-ok")
        assertEquals(null, Dtos.parseSessionDetail(detailBody(capabilities = withoutWs)).capabilities.workspace)
    }
}
