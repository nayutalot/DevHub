package com.devhub.mobile.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * U2-M1（AUDIT P2#1 + P3#7）：capabilities 人话译码纯函数直锁。
 *
 * 译码表 = 桌面 provider 投影 evidence 形态**穷举**（zcode 3 + codex 2 + claude 2 +
 * kimi 7 + deepseek 1 + service 缺省 1 + App 夹具 1 = 17 形态），每形态一断言；
 * 未知形态兜底（reasonKnown=false）+ 技术原值零吞码纪律一并锁定。
 */
class CapabilitiesExplainTest {

    // —— mode 全集（SessionMode 三值 + CP5 空缺省 + 未知兜底）——

    @Test
    fun `mode labels cover full server vocabulary`() {
        assertEquals("托管接入", CapabilitiesExplain.modeLabel("managed"))
        assertEquals("已挂接（hooks）", CapabilitiesExplain.modeLabel("attached"))
        assertEquals("观察模式（只读）", CapabilitiesExplain.modeLabel("observed"))
        assertEquals("能力未探测", CapabilitiesExplain.modeLabel(""))
        assertEquals("能力状态未知", CapabilitiesExplain.modeLabel("somefuture"))
    }

    // —— granted 全集（AgentCapability 五值 + 未知令牌原样保留）——

    @Test
    fun `granted labels cover full vocabulary and keep unknown tokens`() {
        assertEquals("无控制能力", CapabilitiesExplain.grantedLabel(emptyList()))
        assertEquals("可执行：回复", CapabilitiesExplain.grantedLabel(listOf("reply")))
        assertEquals("可执行：回复、暂停", CapabilitiesExplain.grantedLabel(listOf("reply", "pause")))
        assertEquals("可执行：恢复", CapabilitiesExplain.grantedLabel(listOf("resume")))
        assertEquals("可执行：批准", CapabilitiesExplain.grantedLabel(listOf("approve")))
        assertEquals("可执行：中断", CapabilitiesExplain.grantedLabel(listOf("interrupt")))
        // 未知令牌：绝不吞（原样同显，技术原值另有折叠区）
        assertEquals("可执行：futurecap", CapabilitiesExplain.grantedLabel(listOf("futurecap")))
    }

    // —— evidence 译码表穷举（17 形态）——

    @Test
    fun `zcode unconfigured form decodes with settings key reason`() {
        // 08 号截图原句（桌面 zcodeProvider E1 + snapshot.reason 细分）
        val (label, known) = CapabilitiesExplain.reasonLabel(
            "managed face unconfigured: settings key zcode_managed_model is empty (managed face disabled by default) (caps stay observed)",
        )
        assertEquals("ZCode 托管未启用：尚未在桌面端设置 ZCode 托管模型", label)
        assertTrue(known)
    }

    @Test
    fun `zcode unconfigured other reason falls into generic unconfigured wording`() {
        val (label, known) = CapabilitiesExplain.reasonLabel(
            "managed face unconfigured: profile missing (caps stay observed)",
        )
        assertEquals("ZCode 托管未启用：桌面端 ZCode 托管配置未就绪", label)
        assertTrue(known)
    }

    @Test
    fun `zcode doctor probe failed form decodes`() {
        val (label, known) = CapabilitiesExplain.reasonLabel(
            "managed face configured but zcode doctor probe failed: cli not alive",
        )
        assertEquals("ZCode 托管配置已填写，但桌面端探测未通过", label)
        assertTrue(known)
    }

    @Test
    fun `zcode probe ok form decodes`() {
        val (label, known) = CapabilitiesExplain.reasonLabel(
            "zcode managed probe ok: doctor alive + ApiHub zcode active profile ready + zcode_managed_model set",
        )
        assertEquals("ZCode 托管通道就绪（桌面端探测通过）", label)
        assertTrue(known)
    }

    @Test
    fun `codex handshake forms decode`() {
        val ok = CapabilitiesExplain.reasonLabel("app-server handshake ok (9 protocol methods observed)")
        assertEquals("Codex 托管通道就绪（app-server 握手成功）", ok.first)
        assertTrue(ok.second)
        val bare = CapabilitiesExplain.reasonLabel("app-server handshake ok")
        assertTrue(bare.second)
        val fail = CapabilitiesExplain.reasonLabel("app-server handshake failed: connect ECONNREFUSED")
        assertEquals("Codex 托管握手失败（当前只读）", fail.first)
        assertTrue(fail.second)
    }

    @Test
    fun `claude hooks forms decode`() {
        val hooks = CapabilitiesExplain.reasonLabel("hooks registered (3 DevHub entries; reply injection not verified in AC3)")
        assertEquals("已注册 DevHub hooks（回复注入未验证，当前只读）", hooks.first)
        assertTrue(hooks.second)
        val readonly = CapabilitiesExplain.reasonLabel("read-only transcript source (no DevHub hooks registered)")
        assertEquals("只读转录源（未注册 DevHub hooks）", readonly.first)
        assertTrue(readonly.second)
    }

    @Test
    fun `kimi forms decode all seven shapes`() {
        val forms = listOf(
            "read-only session files; exe/version probe failed (enoent)",
            "read-only session files; session_index.jsonl not readable",
            "read-only session files; managed probe skipped: launching a real kimi session would write into ~/.kimi-code and cannot be guaranteed inference-free (red line; fixture-verified managed channel, real-machine e2e lands in AC8)",
        )
        for (f in forms) {
            val (label, known) = CapabilitiesExplain.reasonLabel(f)
            assertEquals("Kimi 会话文件只读（托管通道未验证）", label)
            assertTrue(known)
        }
        assertEquals(
            "Kimi 托管探测未配置（跳过）" to true,
            CapabilitiesExplain.reasonLabel("managed probe skipped: managedProbeSessionDir not configured"),
        )
        assertEquals(
            "Kimi 托管探测失败（进程启动失败）" to true,
            CapabilitiesExplain.reasonLabel("managed probe failed: spawn error"),
        )
        val (stdinLabel, stdinKnown) = CapabilitiesExplain.reasonLabel("managed probe failed: stdin write (EPIPE)")
        assertEquals("Kimi 托管探测失败（标准输入写入失败）", stdinLabel)
        assertTrue(stdinKnown)
        assertEquals(
            "Kimi 托管探测失败（进程提前退出）" to true,
            CapabilitiesExplain.reasonLabel("managed probe failed: process exited without session-file terminal state"),
        )
        assertEquals(
            "Kimi 托管探测超时" to true,
            CapabilitiesExplain.reasonLabel("managed probe timed out without session-file terminal state"),
        )
        assertEquals(
            "Kimi 托管通道就绪（探测通过）" to true,
            CapabilitiesExplain.reasonLabel("managed probe ok: stdin probe confirmed by session-file terminal state"),
        )
    }

    @Test
    fun `deepseek not integrated form decodes`() {
        val (label, known) = CapabilitiesExplain.reasonLabel(
            "not integrated: harness source tree detected but no session/control interface verified (never fabricated)",
        )
        assertEquals("DeepSeek 未接入（无已验证的会话/控制接口）", label)
        assertTrue(known)
    }

    @Test
    fun `service default not probed form decodes`() {
        assertEquals(
            "能力尚未探测" to true,
            CapabilitiesExplain.reasonLabel("not probed (no capability verification yet)"),
        )
    }

    @Test
    fun `fixture evidence passes through as human chinese`() {
        assertEquals(
            "fixture 演示数据（非真实能力）" to true,
            CapabilitiesExplain.reasonLabel("fixture 演示数据（非真实能力）"),
        )
    }

    @Test
    fun `unknown evidence form falls back honestly and flags unknown`() {
        val (label, known) = CapabilitiesExplain.reasonLabel("brand new provider says hi")
        assertEquals("能力状态说明详见技术信息", label)
        assertFalse(known)
        // 空串（evidence 缺省投影）= 已知缺省形态
        val (emptyLabel, emptyKnown) = CapabilitiesExplain.reasonLabel("")
        assertEquals("无能力说明（未探测）", emptyLabel)
        assertTrue(emptyKnown)
    }

    // —— 合流与一行摘要 ——

    @Test
    fun `explain merges three dimensions`() {
        val e = CapabilitiesExplain.explain(
            "observed",
            emptyList(),
            "managed face unconfigured: settings key zcode_managed_model is empty (caps stay observed)",
        )
        assertEquals("观察模式（只读）", e.modeLabel)
        assertEquals("无控制能力", e.grantedLabel)
        assertEquals("ZCode 托管未启用：尚未在桌面端设置 ZCode 托管模型", e.reasonLabel)
        assertTrue(e.reasonKnown)
    }

    @Test
    fun `summary line is one short human sentence`() {
        val s = CapabilitiesExplain.summaryLine(
            "observed",
            "managed face unconfigured: settings key zcode_managed_model is empty (caps stay observed)",
        )
        assertEquals("观察模式（只读） · ZCode 托管未启用：尚未在桌面端设置 ZCode 托管模型", s)
        // 未知 evidence 形态：摘要只显 mode（英文半截句绝不回漏用户面）
        val unknown = CapabilitiesExplain.summaryLine("observed", "weird future evidence")
        assertEquals("观察模式（只读）", unknown)
    }

    @Test
    fun `kimi real device evidence from audit screenshot decodes`() {
        // 06 号截图实测 evidence（read-only session files 前缀族）
        val (label, known) = CapabilitiesExplain.reasonLabel(
            "read-only session files; managed probe skipped: launching a real kimi session would write into ~/.kimi-code and cannot be guaranteed inference-free (red line; fixture-verified managed channel, real-machine e2e lands in AC8)",
        )
        assertEquals("Kimi 会话文件只读（托管通道未验证）", label)
        assertTrue(known)
    }
}
