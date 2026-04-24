package com.reedersystems.commandcomms.data.prefs

import android.content.Context
import android.content.SharedPreferences
import android.util.Base64
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * Persists kiosk-mode state and the salted+hashed admin PIN.
 *
 * The PIN itself is never stored — only a per-install random salt and the
 * SHA-256 hash of (salt || pin). Verification recomputes the hash and uses
 * a constant-time comparison.
 *
 * Two [StateFlow]s are exposed so the UI can subscribe and always reflect the
 * live source of truth without polling: [kioskEnabledFlow] and [pinSetFlow].
 */
class KioskPrefs(context: Context) {

    private val prefs: SharedPreferences =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    private val _kioskEnabledFlow = MutableStateFlow(prefs.getBoolean(KEY_KIOSK_ENABLED, false))
    val kioskEnabledFlow: StateFlow<Boolean> = _kioskEnabledFlow.asStateFlow()

    private val _pinSetFlow = MutableStateFlow(
        prefs.contains(KEY_PIN_HASH) && prefs.contains(KEY_PIN_SALT)
    )
    val pinSetFlow: StateFlow<Boolean> = _pinSetFlow.asStateFlow()

    /**
     * When > 0, dispatcher has remotely temporarily exited kiosk mode and the
     * device should remain unlocked until this epoch-millisecond timestamp.
     * Survives process death so the on-device tech still has a window after a
     * crash/reboot. Cleared by `clearRemoteUnlock()` (manual relock or expiry).
     */
    private val _remoteUnlockUntilFlow = MutableStateFlow(prefs.getLong(KEY_REMOTE_UNLOCK_UNTIL, 0L))
    val remoteUnlockUntilFlow: StateFlow<Long> = _remoteUnlockUntilFlow.asStateFlow()

    /** True when the admin has turned kiosk mode on. Default: false. */
    var kioskEnabled: Boolean
        get() = _kioskEnabledFlow.value
        set(value) {
            prefs.edit().putBoolean(KEY_KIOSK_ENABLED, value).apply()
            _kioskEnabledFlow.value = value
        }

    var remoteUnlockUntilMs: Long
        get() = _remoteUnlockUntilFlow.value
        private set(value) {
            prefs.edit().putLong(KEY_REMOTE_UNLOCK_UNTIL, value).apply()
            _remoteUnlockUntilFlow.value = value
        }

    fun setRemoteUnlock(expiresAtMs: Long) {
        remoteUnlockUntilMs = expiresAtMs
    }

    fun clearRemoteUnlock() {
        if (remoteUnlockUntilMs != 0L) {
            remoteUnlockUntilMs = 0L
        }
    }

    /**
     * True when a dispatcher-initiated unlock window is currently in effect.
     * Use this in any code that wants to know whether the device should be
     * pinned right now, irrespective of the persistent `kioskEnabled` flag.
     */
    fun isRemoteUnlockActive(now: Long = System.currentTimeMillis()): Boolean =
        remoteUnlockUntilMs > now

    /**
     * Effective pin-now state: kiosk is configured and we are NOT inside an
     * active remote unlock window.
     */
    fun shouldPinNow(now: Long = System.currentTimeMillis()): Boolean =
        kioskEnabled && !isRemoteUnlockActive(now)

    /** True if an admin PIN has been set. */
    val isPinSet: Boolean
        get() = _pinSetFlow.value

    /**
     * Replace the admin PIN. Pass an empty string to clear it.
     * The PIN must be 4–12 digits (validated by the caller / UI).
     */
    fun setPin(pin: String) {
        if (pin.isEmpty()) {
            clearPin()
            return
        }
        val salt = ByteArray(SALT_BYTES).also { SecureRandom().nextBytes(it) }
        val hash = hashPin(pin, salt)
        prefs.edit()
            .putString(KEY_PIN_SALT, Base64.encodeToString(salt, Base64.NO_WRAP))
            .putString(KEY_PIN_HASH, Base64.encodeToString(hash, Base64.NO_WRAP))
            .apply()
        _pinSetFlow.value = true
    }

    fun clearPin() {
        prefs.edit().remove(KEY_PIN_SALT).remove(KEY_PIN_HASH).apply()
        _pinSetFlow.value = false
    }

    /** Constant-time check that [candidate] matches the stored PIN. */
    fun verifyPin(candidate: String): Boolean {
        if (candidate.isEmpty()) return false
        val saltStr = prefs.getString(KEY_PIN_SALT, null) ?: return false
        val hashStr = prefs.getString(KEY_PIN_HASH, null) ?: return false
        val salt = try { Base64.decode(saltStr, Base64.NO_WRAP) } catch (_: Exception) { return false }
        val expected = try { Base64.decode(hashStr, Base64.NO_WRAP) } catch (_: Exception) { return false }
        val actual = hashPin(candidate, salt)
        return MessageDigest.isEqual(expected, actual)
    }

    private fun hashPin(pin: String, salt: ByteArray): ByteArray {
        val md = MessageDigest.getInstance("SHA-256")
        md.update(salt)
        md.update(pin.toByteArray(Charsets.UTF_8))
        return md.digest()
    }

    companion object {
        private const val PREFS_NAME = "commandcomms_kiosk"
        private const val KEY_KIOSK_ENABLED = "kiosk_enabled"
        private const val KEY_PIN_SALT = "admin_pin_salt"
        private const val KEY_PIN_HASH = "admin_pin_hash"
        private const val KEY_REMOTE_UNLOCK_UNTIL = "kiosk_remote_unlock_until_ms"
        private const val SALT_BYTES = 16
    }
}
