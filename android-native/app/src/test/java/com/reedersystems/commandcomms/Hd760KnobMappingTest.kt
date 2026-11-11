package com.reedersystems.commandcomms

import com.reedersystems.commandcomms.hd760.Hd760KnobMapping
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class Hd760KnobMappingTest {
    @Test fun allSixteenAbsoluteDetents() {
        for (position in 0..15) assertEquals(position, Hd760KnobMapping.positionForKeyCode(401 + position))
        assertNull(Hd760KnobMapping.positionForKeyCode(400))
        assertNull(Hd760KnobMapping.positionForKeyCode(417))
    }

    @Test fun fastJumpTargetsFinalAbsolutePosition() {
        val codes = listOf(401, 410, 406, 416, 402)
        assertEquals(1, Hd760KnobMapping.positionForKeyCode(codes.last()))
    }

    @Test fun programmedChannelIdSurvivesChannelReorder() {
        assertEquals(80, Hd760KnobMapping.channelIdForSlot(9, listOf(90, 80, 100), 80))
        assertNull(Hd760KnobMapping.channelIdForSlot(9, listOf(90, 100), 80))
        assertNull(Hd760KnobMapping.channelIdForSlot(15, listOf(90, 80), null))
        assertNull(Hd760KnobMapping.channelIdForSlot(-1, listOf(90, 80), 80))
    }
}
