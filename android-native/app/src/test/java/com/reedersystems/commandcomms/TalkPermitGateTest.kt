package com.reedersystems.commandcomms

import com.reedersystems.commandcomms.audio.TalkPermitGate
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TalkPermitGateTest {
    @Test fun completionAllowsMicOnlyAfterTone() = runBlocking {
        val gate = TalkPermitGate(1_000)
        gate.played()
        assertEquals(TalkPermitGate.Outcome.PLAYED, gate.await())
    }

    @Test fun playerErrorDoesNotWaitForUnrelatedCompletion() = runBlocking {
        val gate = TalkPermitGate(1_000)
        gate.failed()
        assertEquals(TalkPermitGate.Outcome.ERROR, gate.await())
    }

    @Test fun releaseCannotTurnIntoLaterMicCapture() = runBlocking {
        val gate = TalkPermitGate(1_000)
        gate.stopped()
        gate.played()
        assertEquals(TalkPermitGate.Outcome.STOPPED, gate.await())
    }

    @Test fun lostCompletionCallbackIsBounded() = runBlocking {
        val gate = TalkPermitGate(10)
        assertEquals(TalkPermitGate.Outcome.TIMED_OUT, gate.await())
    }

    @Test fun externalCancellationIsNotConvertedToSuccess() = runBlocking {
        val gate = TalkPermitGate(5_000)
        val waiter = async { gate.await() }
        waiter.cancel()
        try {
            waiter.await()
            throw AssertionError("Expected cancellation")
        } catch (_: CancellationException) {
            assertTrue(waiter.isCancelled)
        }
    }
}
