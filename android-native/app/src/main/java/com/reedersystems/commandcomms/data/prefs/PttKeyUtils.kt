package com.reedersystems.commandcomms.data.prefs

import android.view.KeyEvent

private val NON_CAPTURABLE_KEYS = setOf(
    KeyEvent.KEYCODE_POWER,
    KeyEvent.KEYCODE_HOME,
    KeyEvent.KEYCODE_BACK,
    KeyEvent.KEYCODE_APP_SWITCH
)

fun isNonCapturableKey(keyCode: Int): Boolean = keyCode in NON_CAPTURABLE_KEYS

fun formatKeyLabel(keyCode: Int): String {
    val raw = KeyEvent.keyCodeToString(keyCode)
    return raw.removePrefix("KEYCODE_").replace("_", " ")
}
