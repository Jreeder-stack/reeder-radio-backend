package com.reedersystems.commandcomms.device

import android.app.Activity
import android.app.ActivityManager
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import com.reedersystems.commandcomms.MainActivity
import com.reedersystems.commandcomms.RadioDeviceAdminReceiver

/**
 * Wraps every [DevicePolicyManager] call we need for kiosk operation.
 *
 * Most of these calls require the app to be Device Owner — that's a one-time
 * provisioning step performed via ADB (`dpm set-device-owner`) or QR-code
 * enrollment on a freshly-reset device. See `KIOSK_PROVISIONING.md`.
 *
 * Methods that require Device Owner are no-ops when the app is not Device
 * Owner so the rest of the app keeps working on developer hardware.
 */
class KioskPolicyManager(private val context: Context) {

    private val dpm: DevicePolicyManager =
        context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager

    private val activityManager: ActivityManager =
        context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager

    val adminComponent: ComponentName =
        ComponentName(context, RadioDeviceAdminReceiver::class.java)

    val mainActivityComponent: ComponentName =
        ComponentName(context, MainActivity::class.java)

    /** True when this app is the device owner (a true kiosk role). */
    val isDeviceOwner: Boolean
        get() = try {
            dpm.isDeviceOwnerApp(context.packageName)
        } catch (e: Exception) {
            Log.w(TAG, "isDeviceOwnerApp threw: ${e.message}")
            false
        }

    /** True when the device-admin component is at least active (weaker than DO). */
    val isAdminActive: Boolean
        get() = try {
            dpm.isAdminActive(adminComponent)
        } catch (e: Exception) {
            false
        }

    /**
     * Turn on every policy needed for full kiosk operation. Safe to call repeatedly.
     * Silently no-ops when the app is not Device Owner.
     */
    fun applyKioskPolicies() {
        if (!isDeviceOwner) {
            Log.w(TAG, "applyKioskPolicies skipped — not Device Owner")
            return
        }
        try {
            // Allow our own package to run in lock-task mode.
            dpm.setLockTaskPackages(adminComponent, arrayOf(context.packageName))
        } catch (e: SecurityException) {
            Log.w(TAG, "setLockTaskPackages failed: ${e.message}")
        }

        // From API 28: lock-task feature flags. We pass NONE which means:
        //   * status bar info (clock, battery) hidden
        //   * notification shade and quick settings cannot be pulled down
        //   * Home button / Recents are blocked
        //   * long-press power (global actions) is blocked
        //   * keyguard does not appear inside lock-task mode
        // This is exactly the kiosk posture we want.
        // Our own foreground-service notifications still post normally; this flag
        // only hides them from the user while the device is pinned.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            try {
                dpm.setLockTaskFeatures(
                    adminComponent,
                    DevicePolicyManager.LOCK_TASK_FEATURE_NONE
                )
            } catch (e: SecurityException) {
                Log.w(TAG, "setLockTaskFeatures failed: ${e.message}")
            }
        }

        // Make this app the persistent default Home so power-on / Home gesture lands here.
        try {
            val homeFilter = IntentFilter(Intent.ACTION_MAIN).apply {
                addCategory(Intent.CATEGORY_HOME)
                addCategory(Intent.CATEGORY_DEFAULT)
            }
            dpm.addPersistentPreferredActivity(adminComponent, homeFilter, mainActivityComponent)
        } catch (e: SecurityException) {
            Log.w(TAG, "addPersistentPreferredActivity failed: ${e.message}")
        }

        // Disable keyguard so wake goes straight back to the app.
        try {
            dpm.setKeyguardDisabled(adminComponent, true)
        } catch (e: SecurityException) {
            Log.w(TAG, "setKeyguardDisabled failed: ${e.message}")
        }

        // Hide the system dialer / phone packages so the green call key,
        // dial intents, and contacts shortcuts cannot launch a phone app
        // out from under the kiosk. Safe no-op on devices that don't have
        // these packages installed.
        setPhoneAppsHidden(true)

        // Keep the screen safely on per app needs (we already use FLAG_KEEP_SCREEN_ON
        // in the activity for incoming-audio behavior; nothing extra here).
    }

    /**
     * Undo the policies set by [applyKioskPolicies]. Safe to call repeatedly.
     * Silently no-ops when the app is not Device Owner.
     */
    fun clearKioskPolicies() {
        if (!isDeviceOwner) return
        try {
            dpm.setLockTaskPackages(adminComponent, emptyArray())
        } catch (e: SecurityException) {
            Log.w(TAG, "clearLockTaskPackages failed: ${e.message}")
        }
        try {
            dpm.clearPackagePersistentPreferredActivities(adminComponent, context.packageName)
        } catch (e: SecurityException) {
            Log.w(TAG, "clearPersistentPreferredActivities failed: ${e.message}")
        }
        try {
            dpm.setKeyguardDisabled(adminComponent, false)
        } catch (e: SecurityException) {
            Log.w(TAG, "setKeyguardDisabled(false) failed: ${e.message}")
        }
        // Restore the dialer / phone packages we hid on enter so the device
        // is left in a usable state when the admin disables kiosk.
        setPhoneAppsHidden(false)
    }

    /**
     * Hide or unhide the system dialer / phone packages. Called from
     * [applyKioskPolicies] / [clearKioskPolicies] so the green call key,
     * `ACTION_DIAL` intents, and contacts shortcuts can't launch the phone
     * app while kiosk is active. Each package is independently looked up
     * and skipped if not installed, so this is safe across OEMs.
     */
    private fun setPhoneAppsHidden(hidden: Boolean) {
        if (!isDeviceOwner) return
        val pm = context.packageManager
        for (pkg in PHONE_PACKAGES) {
            try {
                pm.getApplicationInfo(pkg, 0)
            } catch (_: PackageManager.NameNotFoundException) {
                continue
            }
            try {
                dpm.setApplicationHidden(adminComponent, pkg, hidden)
            } catch (e: SecurityException) {
                Log.w(TAG, "setApplicationHidden($pkg, $hidden) failed: ${e.message}")
            }
        }
    }

    /**
     * Returns true when [activity] is allowed to call [Activity.startLockTask] right now —
     * i.e. the app is whitelisted for lock-task mode (auto-true if Device Owner).
     */
    fun isLockTaskPermitted(): Boolean = try {
        dpm.isLockTaskPermitted(context.packageName)
    } catch (e: Exception) {
        false
    }

    /**
     * True if the device is *currently* in lock-task / pinned mode (regardless of
     * who put it there). Reads the live OS state, so callers can show an
     * accurate "Kiosk Active" indicator even if our prefs disagree.
     */
    val isInLockTaskMode: Boolean
        get() = try {
            activityManager.lockTaskModeState != ActivityManager.LOCK_TASK_MODE_NONE
        } catch (e: Exception) {
            false
        }

    /**
     * Try to enter lock-task mode on [activity]. No-ops when not permitted.
     * Returns true if a startLockTask call was issued (whether or not the OS accepted it).
     */
    fun enterLockTask(activity: Activity): Boolean {
        if (!isLockTaskPermitted()) {
            Log.w(TAG, "enterLockTask skipped — not permitted (DO=$isDeviceOwner)")
            return false
        }
        return try {
            activity.startLockTask()
            true
        } catch (e: Exception) {
            Log.w(TAG, "startLockTask failed: ${e.message}")
            false
        }
    }

    /** Exit lock-task mode if currently active. */
    fun exitLockTask(activity: Activity) {
        try {
            activity.stopLockTask()
        } catch (e: Exception) {
            Log.w(TAG, "stopLockTask failed: ${e.message}")
        }
    }

    /**
     * Re-enable installation/launch of common system apps when leaving kiosk —
     * we only call this from [clearKioskPolicies] callers if needed.
     */
    @Suppress("unused")
    fun setUserAppsHidden(hidden: Boolean) {
        if (!isDeviceOwner) return
        // Block / unblock the Settings app explicitly. Other apps are already
        // unreachable while lock-task is active, but Settings is the most common
        // escape hatch users will look for.
        try {
            val settingsPkg = "com.android.settings"
            val pm = context.packageManager
            val info = try {
                pm.getApplicationInfo(settingsPkg, 0)
            } catch (_: PackageManager.NameNotFoundException) { null }
            if (info != null) {
                dpm.setApplicationHidden(adminComponent, settingsPkg, hidden)
            }
        } catch (e: SecurityException) {
            Log.w(TAG, "setApplicationHidden failed: ${e.message}")
        }
    }

    companion object {
        private const val TAG = "[KioskPolicy]"

        /**
         * Common dialer / phone packages we hide while kiosk is active.
         * Each is looked up before being touched, so missing packages are
         * silently skipped on devices that don't have them.
         */
        private val PHONE_PACKAGES = arrayOf(
            "com.android.dialer",
            "com.google.android.dialer",
            "com.android.contacts",
            "com.android.phone",
        )
    }
}
