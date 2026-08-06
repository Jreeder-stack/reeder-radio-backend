package com.reedersystems.commandcomms

import android.app.Activity
import android.os.Bundle
import android.util.Log

/**
 * Phone-flavor-only compatibility shim for OEM builds that report
 * full-screen-intent permission management but do not provide the matching
 * Android Settings activity. MainActivity's existing first-run readiness flow
 * launches android.settings.MANAGE_APP_USE_FULL_SCREEN_INTENTS; on affected
 * firmware that implicit intent throws ActivityNotFoundException and crashes.
 * This activity safely consumes the unsupported action and immediately returns
 * so readiness can continue with battery/overlay setup.
 */
class FullScreenIntentSettingsFallbackActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Log.w(TAG, "Full-screen-intent Settings activity unavailable on this OEM; continuing")
        finish()
    }

    companion object {
        private const val TAG = "[PhoneReadiness]"
    }
}
