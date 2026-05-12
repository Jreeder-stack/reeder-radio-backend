package com.reedersystems.commandcomms

sealed class KeyAction {
    object PttDown : KeyAction()
    object PttUp : KeyAction()
    object EmergencyDown : KeyAction()
    object EmergencyUp : KeyAction()
    object DpadUp : KeyAction()
    object DpadDown : KeyAction()
    object DpadLeft : KeyAction()
    object DpadRight : KeyAction()
    /**
     * Center / select press. Used by the Siyata SD7 rotary-knob press
     * (KEYCODE_DPAD_CENTER, 23). Wired to status-cycle in RadioViewModel so
     * a knob press progresses the unit through the standard
     * off_duty → on_duty → en_route → arrived → oos → off_duty rotation.
     * The T320 build does not emit DPAD_CENTER through any hardware path,
     * so adding the action here is safe (non-T320-affecting).
     */
    object DpadCenter : KeyAction()
    object AccToggle : KeyAction()
    object StarLongPress : KeyAction()

    /**
     * Toggle scan mode on/off. Emitted by the SD7 top side button on a
     * long-press (~600 ms). Wired to RadioViewModel.toggleScanning().
     */
    object ScanToggle : KeyAction()

    /**
     * Toggle the *currently selected* channel in/out of the scan list.
     * Emitted by the SD7 bottom side button on a long-press (~600 ms).
     * Wired to RadioViewModel.toggleScanChannel(currentChannelId).
     */
    object ScanListToggleCurrent : KeyAction()
}
