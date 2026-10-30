package com.reedersystems.commandcomms.hd760

/**
 * HD760 microphone permit: only the completed, successful local TPT for the
 * currently held physical PTT generation and selected room can authorize audio.
 */
class Hd760TxPermitGate {
    private var pressGeneration: Long? = null
    private var selectedRoom: String? = null
    private var completedTone = false

    @Synchronized fun arm(generation: Long, room: String) {
        pressGeneration = generation
        selectedRoom = room
        completedTone = false
    }

    @Synchronized fun confirmTone(generation: Long, room: String): Boolean {
        if (pressGeneration != generation || selectedRoom != room || completedTone) return false
        completedTone = true
        return true
    }

    @Synchronized fun isPermitted(): Boolean =
        pressGeneration != null && !selectedRoom.isNullOrBlank() && completedTone

    /** Permit generation attached to outgoing UDP audio; null when barred. */
    @Synchronized fun authorizedGeneration(): Long? =
        if (pressGeneration != null && !selectedRoom.isNullOrBlank() && completedTone)
            pressGeneration else null

    @Synchronized fun revoke() {
        pressGeneration = null
        selectedRoom = null
        completedTone = false
    }
}
