package com.reedersystems.commandcomms

import com.reedersystems.commandcomms.hd760.Hd760RxDisplayTracker
import org.junit.Assert.*
import org.junit.Test

class Hd760RxDisplayTrackerTest {
    @Test fun displaysActualRxThenReturnsExactlyOneSecondAfterEnd() {
        val tracker = Hd760RxDisplayTracker()
        tracker.onPacket(12, "ENGINE 2", 100)
        assertEquals(12, tracker.snapshot(200)?.channelId)
        assertEquals("ENGINE 2", tracker.snapshot(200)?.unitId)
        assertTrue(tracker.snapshot(200)!!.receiving)
        tracker.onEnd(12, "ENGINE 2", 300)
        assertFalse(tracker.snapshot(1299)!!.receiving)
        assertNull(tracker.snapshot(1300))
    }

    @Test fun newIncomingCallCancelsOldReturnWindow() {
        val tracker = Hd760RxDisplayTracker()
        tracker.onPacket(3, "A", 100)
        tracker.onEnd(3, "A", 200)
        tracker.onPacket(4, "B", 500)
        assertEquals(4, tracker.snapshot(600)?.channelId)
        assertEquals("B", tracker.snapshot(600)?.unitId)
        tracker.onEnd(4, "B", 700)
        assertNotNull(tracker.snapshot(1699))
        assertNull(tracker.snapshot(1700))
    }

    @Test fun staleStopOrWrongUnitDoesNotClearNewCall() {
        val tracker = Hd760RxDisplayTracker()
        tracker.onPacket(2, "UNIT2", 100)
        tracker.onPacket(5, "UNIT5", 150)
        tracker.onEnd(2, "UNIT2", 175)
        tracker.onEnd(5, "OTHER", 180)
        assertTrue(tracker.snapshot(250)!!.receiving)
        assertEquals(5, tracker.snapshot(250)?.channelId)
    }

    @Test fun fallbackForLostStopDoesNotLeaveStuckIdentity() {
        val tracker = Hd760RxDisplayTracker()
        tracker.onPacket(6, "CAR 6", 100)
        assertTrue(tracker.snapshot(449)!!.receiving)
        assertFalse(tracker.snapshot(450)!!.receiving)
        assertNull(tracker.snapshot(1450))
    }

    @Test fun resetRestoresSelectedDisplayImmediately() {
        val tracker = Hd760RxDisplayTracker()
        tracker.onPacket(6, "CAR 6", 100)
        tracker.reset()
        assertNull(tracker.snapshot(101))
    }

    @Test fun lateOlderPacketCannotRestoreAnEndedCall() {
        val tracker = Hd760RxDisplayTracker()
        tracker.onPacket(6, "CAR 6", 100)
        tracker.onEnd(6, "CAR 6", 150)
        tracker.onPacket(6, "CAR 6", 90)
        assertFalse(tracker.snapshot(155)!!.receiving)
    }
}
