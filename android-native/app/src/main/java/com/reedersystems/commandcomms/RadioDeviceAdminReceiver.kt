package com.reedersystems.commandcomms

import android.app.admin.DeviceAdminReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import android.widget.Toast

/**
 * Device admin / Device owner callbacks for the radio app.
 *
 * On `onProfileProvisioningComplete` (Device Owner enrollment via QR or NFC)
 * we just bounce the user into [MainActivity] — kiosk policies are NOT applied
 * here, because kiosk defaults to OFF until an admin explicitly enables it
 * from the Settings screen.
 */
class RadioDeviceAdminReceiver : DeviceAdminReceiver() {

    override fun onEnabled(context: Context, intent: Intent) {
        Log.d(TAG, "Device admin enabled")
        Toast.makeText(context, "Radio admin enabled", Toast.LENGTH_SHORT).show()
    }

    override fun onDisabled(context: Context, intent: Intent) {
        Log.d(TAG, "Device admin disabled")
        Toast.makeText(context, "Radio admin disabled", Toast.LENGTH_SHORT).show()
    }

    override fun onProfileProvisioningComplete(context: Context, intent: Intent) {
        super.onProfileProvisioningComplete(context, intent)
        Log.d(TAG, "Profile provisioning complete — launching MainActivity (kiosk stays OFF until admin enables it)")
        val launch = Intent(context, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(launch)
    }

    override fun onLockTaskModeEntering(context: Context, intent: Intent, pkg: String) {
        Log.d(TAG, "Lock task mode entering: $pkg")
    }

    override fun onLockTaskModeExiting(context: Context, intent: Intent) {
        Log.d(TAG, "Lock task mode exiting")
    }

    companion object {
        private const val TAG = "[RadioAdmin]"
    }
}
