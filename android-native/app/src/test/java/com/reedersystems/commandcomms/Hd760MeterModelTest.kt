package com.reedersystems.commandcomms

import com.reedersystems.commandcomms.audio.radio.SignalQuality
import com.reedersystems.commandcomms.hd760.Hd760MeterModel
import org.junit.Assert.*
import org.junit.Test

/** Never display made-up signal strength when the platform has no measurement. */
class Hd760MeterModelTest {
    @Test fun wifiRssiMapsToFiveBarsWithoutGuessing() {
        assertNull(Hd760MeterModel.wifiBars(null))
        assertNull(Hd760MeterModel.wifiBars(-127))
        assertEquals(5, Hd760MeterModel.wifiBars(-43))
        assertEquals(4, Hd760MeterModel.wifiBars(-61))
        assertEquals(3, Hd760MeterModel.wifiBars(-72))
        assertEquals(2, Hd760MeterModel.wifiBars(-81))
        assertEquals(1, Hd760MeterModel.wifiBars(-94))
    }

    @Test fun gpsBarsOnlyFromRecentRealFixes() {
        assertNull(Hd760MeterModel.gpsBars(null, 0))
        assertNull(Hd760MeterModel.gpsBars(4f, 31_000))
        assertNull(Hd760MeterModel.gpsBars(0f, 10))
        assertEquals(5, Hd760MeterModel.gpsBars(4f, 10))
        assertEquals(3, Hd760MeterModel.gpsBars(18f, 200))
        assertEquals(1, Hd760MeterModel.gpsBars(200f, 100))
    }

    @Test fun radioRxQualityUsesMeasuredPacketLossAndJitterClass() {
        assertNull(Hd760MeterModel.receiveBars(SignalQuality.NONE))
        assertEquals(5, Hd760MeterModel.receiveBars(SignalQuality.EXCELLENT))
        assertEquals(4, Hd760MeterModel.receiveBars(SignalQuality.GOOD))
        assertEquals(3, Hd760MeterModel.receiveBars(SignalQuality.FAIR))
        assertEquals(1, Hd760MeterModel.receiveBars(SignalQuality.POOR))
    }

    @Test fun cellularCannotClaimUnreportedStrength() {
        assertNull(Hd760MeterModel.cellularBars(null))
        assertNull(Hd760MeterModel.cellularBars(5))
        assertEquals(1, Hd760MeterModel.cellularBars(0))
        assertEquals(5, Hd760MeterModel.cellularBars(4))
    }
}
