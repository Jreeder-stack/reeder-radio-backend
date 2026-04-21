package com.reedersystems.commandcomms.audio.radio

enum class SignalQuality {
    NONE,
    EXCELLENT,
    GOOD,
    FAIR,
    POOR;

    companion object {
        fun classify(lossPct: Double, jitterMs: Double, framesInWindow: Long): SignalQuality {
            if (framesInWindow < 10) return NONE
            return when {
                lossPct < 2.0 && jitterMs < 15.0 -> EXCELLENT
                lossPct < 8.0 && jitterMs < 30.0 -> GOOD
                lossPct < 20.0 && jitterMs < 60.0 -> FAIR
                else -> POOR
            }
        }
    }
}
