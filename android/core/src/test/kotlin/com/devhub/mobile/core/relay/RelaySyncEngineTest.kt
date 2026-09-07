package com.devhub.mobile.core.relay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * M3-C8a sync 引导死锁修复回归（docs/18 §3.11/§6.1/§6.2/§6.3）。
 *
 * 死锁链（C2e 实证）：旧实现 sendRelaySyncRequest 对 after<=0 早退 → fresh install 本地游标永 0
 * → sync_request 永不发 → 补发页永不启动 → held 只增（批内实测 870+）、event_ack_state row2 永不
 * 落盘。修复 = hello 引导对 after=0 必发出帧（§6.1.2 照契约实施），ECS 以 sequence>after 升序补页
 * + upTo/hasGaps 暴露权威水位（§3.12；forwarder.ts pageSince/hasGapsBetween 服务端实证）。
 */
class RelaySyncEngineTest {

    private fun parse(frame: String): RelayFrame = RelayCodec.parse(frame)

    // ---- 判据 1：fresh 游标引导（死锁根因回归）----

    @Test
    fun `fresh install hello bootstrap emits sync_request with after=0 - deadlock fix regression`() {
        val engine = RelaySyncEngine() // fresh install：row2 无记录，游标初值 0
        val frame = parse(engine.helloSyncFrame())
        assertTrue("hello 引导必须产出 sync_request（旧实现 after<=0 早退不发）", frame is RelayFrame.SyncRequest)
        frame as RelayFrame.SyncRequest
        assertEquals(0L, frame.after)
        // requestId 必填（docs/18 §3.11 帧形；ECS asString 校验——M3-C8a 实战暴露的第二个
        // 潜在雷：死锁时期 sync_request 从未上线，null requestId 违约从未被检验）
        assertFalse("sync_request.requestId 必须为非空 uuid（§3.11）", frame.requestId.isNullOrBlank())
        // 引导帧即累计 ACK 初值（docs/18 §6.2 只前进语义的合法起点）
    }

    @Test
    fun `fresh bootstrap then full backfill drains to ecs watermark via gapFill`() {
        val engine = RelaySyncEngine()
        // hello → ECS 缓存起点 14500（1..14499 已被淘汰）→ page1 + hasGaps:true
        assertTrue(parse(engine.helloSyncFrame()) is RelayFrame.SyncRequest)
        // 补发页事件全部先挂起（14500 != 0+1，绝不跳号）
        for (seq in 14500L..14502L) assertFalse(engine.observe(seq))
        assertEquals(0L, engine.after)
        assertEquals(3, engine.heldCount())
        // hasGaps → gapFill(upTo) 显式推进 + held 一并解除（§6.3）
        assertTrue(engine.gapFill(14502L))
        assertEquals(14502L, engine.after)
        assertEquals(0, engine.heldCount())
        // 续页 ACK 携带推进后的游标（ECS 收到后回 sequence>14502 的下一页）
        assertEquals(14502L, (parse(engine.ackSyncFrame()) as RelayFrame.SyncRequest).after)
        // 后续 live 事件接续前进
        assertTrue(engine.observe(14503L))
    }

    // ---- 判据 2：已有游标不回退 ----

    @Test
    fun `restored cursor never regresses below hello watermark - local wins`() {
        val engine = RelaySyncEngine(initial = 14800) // App 重启从 row2 恢复
        // hello.sequence=14871 > 本地游标：补发引导（§6.1.2 第一分支）——after 仍是本地游标
        assertEquals(14800L, (parse(engine.helloSyncFrame()) as RelayFrame.SyncRequest).after)
        // hello.sequence=100 ≤ 本地游标（ECS 缓存重置场景）：本地为准，不回退（§6.1.2 第二分支）
        assertTrue(engine.helloSyncFrame().isNotEmpty())
        assertFalse(engine.observe(14800L)) // 重复
        assertFalse(engine.observe(14799L)) // 旧序重放
        assertEquals(14800L, engine.after)
        assertTrue(engine.observe(14801L))
        assertEquals(14801L, engine.after)
    }

    // ---- 判据 3：held 消化（空洞后位挂起 → 缺口补到解挂）----

    @Test
    fun `held queue drains when the hole arrives then advances contiguously`() {
        val engine = RelaySyncEngine(initial = 14800)
        // 14801 缺失：14802/14803 挂起，游标不得越过
        assertFalse(engine.observe(14803L))
        assertFalse(engine.observe(14802L))
        assertEquals(14800L, engine.after)
        assertEquals(2, engine.heldCount())
        // ACK 面仍报 14800（未处理事件绝不计入 after，§3.11）
        assertEquals(14800L, (parse(engine.ackSyncFrame()) as RelayFrame.SyncRequest).after)
        // 缺口补到 → 挂起链一次解挂到 14803
        assertTrue(engine.observe(14801L))
        assertEquals(14803L, engine.after)
        assertEquals(0, engine.heldCount())
        assertEquals(14803L, (parse(engine.ackSyncFrame()) as RelayFrame.SyncRequest).after)
    }

    // ---- 判据 4：ack 落盘契约（persist-on-send-success → event_ack_state row2）----

    @Test
    fun `full app-off timeline - bootstrap backfill ack advances persisted cursor monotonically`() {
        // 模拟 R-B6 app-off 判据时间线：ConnectionManager 的落盘规则 = 每次发送成功即
        // persist(engine.after)（row2 upsert，只前进）。
        var row2 = 0L
        val persist: (Long) -> Unit = { row2 = it }

        val engine = RelaySyncEngine() // 杀 App 期间的 fresh 场景（游标未落过盘）
        // ① 重连 hello → 引导帧发出（发送成功）→ 落盘 after=0（幂等，不回退既有值）
        val helloFrame = parse(engine.helloSyncFrame()) as RelayFrame.SyncRequest
        persist(helloFrame.after)
        assertEquals(0L, row2)
        // ② 断线期事件 21710-21712 经补发页到达 → 游标接续推进（fresh 游标 0 → 起点非 1 →
        //    先挂起，由 hasGaps gapFill 引导到页上界，与 ECS 缓存起点>1 的实证形态一致）
        for (seq in 21710L..21712L) assertFalse(engine.observe(seq))
        assertTrue(engine.gapFill(21712L))
        // ③ 节流 ACK 发出 → 落盘 21712（补发零丢失后 held 消化、ack 落盘）
        val ackFrame = parse(engine.ackSyncFrame()) as RelayFrame.SyncRequest
        persist(ackFrame.after)
        assertEquals(21712L, row2)
        assertEquals(21712L, engine.after)
        assertEquals(0, engine.heldCount())
        // ④ 补发重放（重连后 ECS 重发同段）绝不回退已落盘游标
        for (seq in 21710L..21712L) assertFalse(engine.observe(seq))
        assertEquals(21712L, engine.after)
        assertEquals(21712L, row2)
        // ⑤ 心跳 lastAckedSeq 与落盘游标同源（§3.13 兜底 ACK）
        assertEquals(row2, engine.after)
    }

    @Test
    fun `cursor restored from persisted state survives reconnect replay - ack only forward`() {
        // 已落盘 row2=14871 的设备重连：恢复游标 → 引导 after=14871 → 重放/乱序零回退
        val engine = RelaySyncEngine(initial = 14871)
        assertEquals(14871L, (parse(engine.helloSyncFrame()) as RelayFrame.SyncRequest).after)
        assertFalse(engine.observe(14871L))
        assertFalse(engine.observe(14861L))
        assertEquals(14871L, engine.after)
        assertTrue(engine.observe(14872L))
        assertEquals(14872L, engine.after)
    }
}
