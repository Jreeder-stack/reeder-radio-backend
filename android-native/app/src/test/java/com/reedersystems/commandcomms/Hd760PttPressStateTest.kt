package com.reedersystems.commandcomms

import com.reedersystems.commandcomms.hd760.Hd760PttPressState
import org.junit.Assert.*
import org.junit.Test

class Hd760PttPressStateTest {
    @Test fun heldRepressResumesAfterCleanup() {
        val p = Hd760PttPressState()
        p.down(); p.deferDuringCleanup()
        assertTrue(p.takeDeferredIfHeld())
        assertFalse(p.takeDeferredIfHeld())
    }

    @Test fun releasedQuickTapNeverStartsLateTransmission() {
        val p = Hd760PttPressState()
        p.down(); p.deferDuringCleanup(); p.up()
        assertFalse(p.takeDeferredIfHeld())
    }

    @Test fun releaseAndNextPressAreIndependent() {
        val p = Hd760PttPressState()
        p.down(); p.deferDuringCleanup(); p.up()
        p.down()
        assertFalse(p.takeDeferredIfHeld())
        p.deferDuringCleanup()
        assertTrue(p.takeDeferredIfHeld())
    }

    @Test fun duplicateCleanupDoesNotRestartTwice() {
        val p = Hd760PttPressState()
        p.down(); p.deferDuringCleanup(); p.deferDuringCleanup()
        assertTrue(p.takeDeferredIfHeld())
        assertFalse(p.takeDeferredIfHeld())
    }
}
