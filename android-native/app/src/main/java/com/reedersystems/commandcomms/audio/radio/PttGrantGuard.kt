package com.reedersystems.commandcomms.audio.radio

import android.os.SystemClock
import android.util.Log

/**
 * Prevents an unsolicited/shared-callsign floor grant from starting local TX.
 * A grant is valid only when this physical device recently requested the floor
 * for the same channel.
 */
object PttGrantGuard {
    private const val TAG = "[PttGrantGuard]"
    private const val REQUEST_TTL_MS = 10_000L

    private data class PendingRequest(
        val channelKey: String,
        val requestedAtMs: Long,
    )

    @Volatile
    private var pending: PendingRequest? = null

    fun markRequested(channelKey: String) {
        pending = PendingRequest(channelKey, SystemClock.elapsedRealtime())
        Log.d(TAG, "Local floor request armed channel=$channelKey")
    }

    fun consumeGrant(channelKey: String): Boolean {
        val request = pending ?: return false
        val ageMs = SystemClock.elapsedRealtime() - request.requestedAtMs
        val accepted = request.channelKey == channelKey && ageMs in 0..REQUEST_TTL_MS
        pending = null

        if (!accepted) {
            Log.w(TAG, "Rejected unsolicited/stale floor grant channel=$channelKey expected=${request.channelKey} ageMs=$ageMs")
        }
        return accepted
    }

    fun clear(reason: String) {
        if (pending != null) {
            Log.d(TAG, "Cleared pending floor request reason=$reason")
        }
        pending = null
    }
}
