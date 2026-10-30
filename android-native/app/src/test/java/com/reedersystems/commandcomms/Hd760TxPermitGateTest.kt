package com.reedersystems.commandcomms

import com.reedersystems.commandcomms.hd760.Hd760TxPermitGate
import org.junit.Assert.*
import org.junit.Test

class Hd760TxPermitGateTest {
    @Test fun microphoneIsBlockedUntilSuccessfulTone() {
        val gate = Hd760TxPermitGate()
        assertFalse(gate.isPermitted())
        gate.arm(1, "ops")
        assertFalse(gate.isPermitted())
        assertTrue(gate.confirmTone(1, "ops"))
        assertTrue(gate.isPermitted())
    }

    @Test fun wrongPressOrChannelCannotGrant() {
        val gate = Hd760TxPermitGate()
        gate.arm(5, "ops")
        assertFalse(gate.confirmTone(4, "ops"))
        assertFalse(gate.confirmTone(5, "fire"))
        assertFalse(gate.isPermitted())
    }

    @Test fun releaseRevokesPlaybackAndPacketAuthorization() {
        val gate = Hd760TxPermitGate()
        gate.arm(2, "ops")
        assertTrue(gate.confirmTone(2, "ops"))
        gate.revoke()
        assertFalse(gate.isPermitted())
        assertFalse(gate.confirmTone(2, "ops"))
    }

    @Test fun oldPlaybackCannotAuthorizeNewRapidPress() {
        val gate = Hd760TxPermitGate()
        gate.arm(1, "ops")
        gate.revoke()
        gate.arm(3, "ops")
        assertFalse(gate.confirmTone(1, "ops"))
        assertFalse(gate.isPermitted())
        assertTrue(gate.confirmTone(3, "ops"))
        assertTrue(gate.isPermitted())
    }

    @Test fun channelChangeRequiresFreshTone() {
        val gate = Hd760TxPermitGate()
        gate.arm(8, "ops")
        assertTrue(gate.confirmTone(8, "ops"))
        gate.arm(8, "fire")
        assertFalse(gate.isPermitted())
        assertFalse(gate.confirmTone(8, "ops"))
        assertTrue(gate.confirmTone(8, "fire"))
    }

    @Test fun revokedQueuedPacketNeverMatchesNewPress() {
        val gate = Hd760TxPermitGate()
        gate.arm(1, "ops")
        assertTrue(gate.confirmTone(1, "ops"))
        val oldToken = gate.authorizedGeneration()
        assertEquals(1L, oldToken)
        gate.revoke()
        assertNull(gate.authorizedGeneration())
        gate.arm(3, "ops")
        assertTrue(gate.confirmTone(3, "ops"))
        assertNotEquals(oldToken, gate.authorizedGeneration())
    }

    @Test fun duplicateCompletionCannotReauthorize() {
        val gate = Hd760TxPermitGate()
        gate.arm(8, "ops")
        assertTrue(gate.confirmTone(8, "ops"))
        assertFalse(gate.confirmTone(8, "ops"))
    }
}
