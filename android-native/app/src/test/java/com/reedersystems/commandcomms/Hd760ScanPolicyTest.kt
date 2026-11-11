package com.reedersystems.commandcomms

import com.reedersystems.commandcomms.hd760.Hd760ScanPolicy
import org.junit.Assert.*
import org.junit.Test

class Hd760ScanPolicyTest {
    @Test fun onlyAuthorizedSelectedSecondaryIsPlayable() {
        val p = Hd760ScanPolicy()
        assertFalse(p.onPacket(9, 1, setOf(2), true, false, 100).accept)
        assertTrue(p.onPacket(2, 1, setOf(2), true, false, 101).accept)
        assertFalse(p.onPacket(9, 1, setOf(2), true, false, 120).accept)
    }

    @Test fun primaryPreemptsAndSecondaryCannotInterruptIt() {
        val p = Hd760ScanPolicy()
        assertTrue(p.onPacket(2, 1, setOf(2), true, false, 100).accept)
        val priority = p.onPacket(1, 1, setOf(2), true, false, 130)
        assertTrue(priority.accept)
        assertTrue(priority.changed)
        assertFalse(p.onPacket(2, 1, setOf(2), true, false, 135).accept)
    }

    @Test fun secondaryHangsUntilIdleThenResumes() {
        val p = Hd760ScanPolicy()
        assertTrue(p.onPacket(2, 1, setOf(2, 3), true, false, 100).accept)
        assertFalse(p.onPacket(3, 1, setOf(2, 3), true, false, 200).accept)
        assertTrue(p.onPacket(3, 1, setOf(2, 3), true, false, 660).accept)
    }

    @Test fun pttAlwaysSuppressesScanningWithoutChangingPrimary() {
        val p = Hd760ScanPolicy()
        p.onPacket(2, 1, setOf(2), true, false, 100)
        assertFalse(p.onPacket(2, 1, setOf(2), true, true, 101).accept)
        assertFalse(p.onPacket(2, 1, setOf(2), false, false, 110).accept)
        assertTrue(p.onPacket(1, 1, setOf(2), true, false, 120).accept)
    }
}
