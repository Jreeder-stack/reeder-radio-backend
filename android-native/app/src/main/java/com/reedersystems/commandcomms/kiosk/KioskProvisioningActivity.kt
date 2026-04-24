package com.reedersystems.commandcomms.kiosk

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.util.Log
import com.reedersystems.commandcomms.MainActivity

/**
 * Trampoline activity launched by the system when a fresh device is provisioned
 * with this app as Device Owner via QR code (action `PROVISION_MANAGED_DEVICE`).
 *
 * We don't render any UI here — the on-device Setup Wizard owns the screen
 * during enrollment. Kiosk policies are NOT applied here: kiosk stays OFF by
 * default until an admin explicitly enables it from the Settings screen.
 * We simply bounce the user into [MainActivity].
 */
class KioskProvisioningActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Log.d(TAG, "Provisioning trampoline launched: action=${intent?.action}")
        startActivity(
            Intent(this, MainActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
            }
        )
        finish()
    }

    companion object {
        private const val TAG = "[KioskProvisioning]"
    }
}
