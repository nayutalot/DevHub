package com.devhub.mobile.ui.screens

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * W2 批（briefs/w2-relay-devices-copy）：设备页「服务端状态」轮询闸门纯函数锁。
 * 背景：ECS relay REST 面无 GET /v1/devices（HANDOFF 09-11 实证：结构化 NOT_FOUND；
 * WS 路径不受影响）——relay 模式每 FALLBACK_POLL_MS 打一次必 404 端点（error 永挂、
 * 状态区永缺、白打 HTTP）。shouldQueryServerRow(mode) 钉死分支约定：relay 跳过、
 * 直连保留（行为零变化）；真实轮询时序/网络面属 Compose+Retrofit 集成面，本锁只钉闸门。
 */
class DeviceScreenServerRowPolicyTest {

    @Test
    fun `relay mode skips server row polling`() {
        // relay 模式：必 404 轮询退役（serverRow 保持 null、无 error）
        assertFalse(shouldQueryServerRow("relay"))
    }

    @Test
    fun `direct mode keeps server row polling`() {
        // 直连（LAN 网关）模式：轮询行为零变化
        assertTrue(shouldQueryServerRow("direct"))
    }

    @Test
    fun `unconfigured mode keeps legacy polling`() {
        // configuredMode() 未加载（null）：沿用旧行为（轮询），绝不误伤直连语义
        assertTrue(shouldQueryServerRow(null))
    }
}
