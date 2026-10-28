package com.reedersystems.commandcomms.hd760

/** Physical PTT edge ownership across asynchronous TX cleanup (HD760 only). */
class Hd760PttPressState {
    private var pressed = false
    private var deferredUntilCleanup = false

    @Synchronized fun down() { pressed = true }
    @Synchronized fun up() { pressed = false; deferredUntilCleanup = false }
    @Synchronized fun isHeld(): Boolean = pressed

    @Synchronized fun deferDuringCleanup() {
        if (pressed) deferredUntilCleanup = true
    }

    /** A brief press released during cleanup must never transmit afterwards. */
    @Synchronized fun takeDeferredIfHeld(): Boolean {
        val resume = pressed && deferredUntilCleanup
        deferredUntilCleanup = false
        return resume
    }
}
