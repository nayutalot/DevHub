package com.devhub.mobile.core

import org.junit.Assert.assertEquals
import org.junit.Test

/** R11 气泡分侧与头像规则。 */
class BubbleSidesTest {

    @Test
    fun `user goes right with fixed avatar`() {
        assertEquals(BubbleSides.Placement.RIGHT_PRIMARY, BubbleSides.placementFor("user"))
        assertEquals("我", BubbleSides.avatarText("user", "zcode", "ZCode"))
        assertEquals("我", BubbleSides.avatarText("user", null, null)) // user 头像不随 provider 变化
    }

    @Test
    fun `assistant goes left with provider initial avatar`() {
        assertEquals(BubbleSides.Placement.LEFT_VARIANT, BubbleSides.placementFor("assistant"))
        assertEquals("Z", BubbleSides.avatarText("assistant", "zcode", "ZCode"))
    }

    @Test
    fun `system tool event and unknown go centered chip`() {
        assertEquals(BubbleSides.Placement.CENTER_CHIP, BubbleSides.placementFor("system"))
        assertEquals(BubbleSides.Placement.CENTER_CHIP, BubbleSides.placementFor("tool"))
        assertEquals(BubbleSides.Placement.CENTER_CHIP, BubbleSides.placementFor("event"))
        assertEquals(BubbleSides.Placement.CENTER_CHIP, BubbleSides.placementFor("whatever"))
        assertEquals(BubbleSides.Placement.CENTER_CHIP, BubbleSides.placementFor(""))
    }

    @Test
    fun `assistant avatar falls back to label then unknown`() {
        assertEquals("C", BubbleSides.avatarText("assistant", null, "Claude Code"))
        assertEquals("?", BubbleSides.avatarText("assistant", null, null))
    }
}
