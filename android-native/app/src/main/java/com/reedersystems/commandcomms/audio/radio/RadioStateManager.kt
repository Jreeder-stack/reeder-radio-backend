/**
 * RadioStateManager — Tracks the overall radio engine state.
 *
 * Module boundary: This is the single source of truth for radio lifecycle state.
 * All other radio engine modules read/write state exclusively through this manager.
 * It does NOT depend on any UI, service, or signaling layer — it is a pure state machine
 * that publishes changes via Kotlin StateFlow.
 *
 * Hardware safety: This module does not interact with any hardware buttons, key codes,
 * scan codes, broadcast receivers, or accessibility hooks. PTT detection is handled
 * entirely outside the radio engine module boundary.
 */
package com.reedersystems.commandcomms.audio.radio

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

enum class RadioState {
    IDLE,
    RECEIVING,
    REQUESTING_TX,
    TRANSMITTING,
    RECONNECTING
}

class RadioStateManager {

    private val _state = MutableStateFlow(RadioState.IDLE)
    val state: StateFlow<RadioState> = _state.asStateFlow()

    val currentState: RadioState
        get() = _state.value

    fun transitionTo(newState: RadioState) {
        val old = _state.value
        if (old != newState) {
            _state.value = newState
        }
    }

    fun isTransmitting(): Boolean = _state.value == RadioState.TRANSMITTING

    fun isReceiving(): Boolean = _state.value == RadioState.RECEIVING

    fun isIdle(): Boolean = _state.value == RadioState.IDLE

    fun reset() {
        _state.value = RadioState.IDLE
    }
}
