package com.reedersystems.commandcomms.audio

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull

/** One physical talk-permit attempt. A missing MediaPlayer callback cannot hold PTT forever. */
internal class TalkPermitGate(private val timeoutMs: Long = 2_500L) {
    init { require(timeoutMs > 0) }

    enum class Outcome { PLAYED, ERROR, STOPPED, TIMED_OUT }

    private val completion = CompletableDeferred<Outcome>()

    fun played() { completion.complete(Outcome.PLAYED) }
    fun failed() { completion.complete(Outcome.ERROR) }
    fun stopped() { completion.complete(Outcome.STOPPED) }

    suspend fun await(): Outcome =
        withTimeoutOrNull(timeoutMs) { completion.await() } ?: Outcome.TIMED_OUT
}
