package com.reedersystems.commandcomms.ui.bridge

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import com.reedersystems.commandcomms.CommandCommsApp
import com.reedersystems.commandcomms.ui.theme.CommandCommsTheme

/**
 * Dedicated phone/tablet launcher for the UHF bridge flavor.
 *
 * This intentionally does not use the physical-radio MainActivity or its
 * Device Registration navigation graph. A bridge installation is a normal
 * authenticated Command Communications user session.
 */
class BridgeMainActivity : ComponentActivity() {

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { results ->
        val app = application as CommandCommsApp
        app.sessionPrefs.micPermissionGranted =
            results[Manifest.permission.RECORD_AUDIO]
                ?: isGranted(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            app.sessionPrefs.notificationPermissionGranted =
                results[Manifest.permission.POST_NOTIFICATIONS]
                    ?: isGranted(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            CommandCommsTheme {
                BridgeAppNavigation()
            }
        }
        requestBridgePermissions()
    }

    private fun requestBridgePermissions() {
        val app = application as CommandCommsApp
        val requested = buildList {
            if (!isGranted(Manifest.permission.RECORD_AUDIO)) {
                add(Manifest.permission.RECORD_AUDIO)
            }
            if (
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                !isGranted(Manifest.permission.POST_NOTIFICATIONS)
            ) {
                add(Manifest.permission.POST_NOTIFICATIONS)
            }
        }

        app.sessionPrefs.micPermissionGranted = isGranted(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            app.sessionPrefs.notificationPermissionGranted =
                isGranted(Manifest.permission.POST_NOTIFICATIONS)
        }

        if (requested.isNotEmpty()) {
            permissionLauncher.launch(requested.toTypedArray())
        }
    }

    private fun isGranted(permission: String): Boolean =
        ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED
}
