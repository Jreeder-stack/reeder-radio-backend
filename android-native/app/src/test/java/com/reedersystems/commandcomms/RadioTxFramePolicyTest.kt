package com.reedersystems.commandcomms

import com.reedersystems.commandcomms.audio.radio.RadioTxFramePolicy
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RadioTxFramePolicyTest {
    @Test fun currentGenerationFreshVoiceIsAllowed() {
        assertTrue(RadioTxFramePolicy.maySend(4L, 4L, 0L))
        assertTrue(RadioTxFramePolicy.maySend(4L, 4L, 400L))
    }

    @Test fun queuedVoiceFromPriorSocketIsNeverReplayed() {
        assertFalse(RadioTxFramePolicy.maySend(4L, 5L, 1L))
    }

    @Test fun staleVoiceIsDroppedEvenWhenSocketIsConnected() {
        assertFalse(RadioTxFramePolicy.maySend(4L, 4L, 401L))
    }

    @Test fun negativeAgeFromClockAnomalyCannotReplay() {
        assertFalse(RadioTxFramePolicy.maySend(4L, 4L, -1L))
    }
}
