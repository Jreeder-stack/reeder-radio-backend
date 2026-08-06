package com.reedersystems.commandcomms

import android.app.Activity
import android.os.Bundle
import android.util.Log

/**
 * Phone-flavor-only compatibility shim for Android/OEM builds that report
 * canUseFullScreenIntent() == false but do not provide the system Settings
 * activity for ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENTS.
 *
 * MainActivity attempts to open that Settings action during first-run
 * readiness. On affected Samsung/OEM firmware the implicit intent otherwise
 * throws ActivityNotFoundException and crashes the app. This tiny activity
 * safely consumes the unsupported settings intent and immediately returns so
 * the existing readiness flow can continue to battery/overlay setup.
 */
class FullScreenIntentSettingsFallbackActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Log.w(TAG, "OEM does not expose full-screen-intent settings; continuing readiness flow")
        finish()
    }

    companion object {
        private const val TAG = "[PhoneReadiness]"
    }
}
