package com.reedersystems.commandcomms

sealed class KeyAction {
    object EmergencyDown : KeyAction()
    object EmergencyUp : KeyAction()
    object DpadUp : KeyAction()
    object DpadDown : KeyAction()
    object DpadLeft : KeyAction()
    object DpadRight : KeyAction()
    object AccToggle : KeyAction()
    object StarLongPress : KeyAction()
}
