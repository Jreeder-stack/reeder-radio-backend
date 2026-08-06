package com.reedersystems.commandcomms.ota

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.util.Log
import com.reedersystems.commandcomms.CommandCommsApp
import com.reedersystems.commandcomms.data.prefs.RadioTokenStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

class T320InstallResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
        val releaseId = intent.getLongExtra(T320OtaService.EXTRA_RELEASE_ID, -1L)
        val targetVersion = intent.getIntExtra(T320OtaService.EXTRA_VERSION_CODE, -1)
        Log.d(TAG, "installer result status=$status release=$releaseId targetVersion=$targetVersion message=$message")

        if (status == PackageInstaller.STATUS_SUCCESS) {
            // Updating this package may kill the old process before a network ACK
            // finishes. Keep pending markers; T320OtaService reports 'installed'
            // after MY_PACKAGE_REPLACED starts the new version.
            return
        }

        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            reportFailure(context, releaseId, "Installer requested user interaction; unattended install was not authorized")
            return
        }

        reportFailure(context, releaseId, "PackageInstaller failed: ${message ?: status}")
    }

    private fun reportFailure(context: Context, releaseId: Long, detail: String) {
        if (releaseId <= 0) return
        context.getSharedPreferences("t320_ota", Context.MODE_PRIVATE).edit()
            .remove("pending_release")
            .remove("pending_version")
            .apply()
        val pending = goAsync()
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            try {
                val app = context.applicationContext as CommandCommsApp
                val token = RadioTokenStore(context).getToken() ?: return@launch
                val body = JSONObject().apply {
                    put("releaseId", releaseId)
                    put("status", "failed")
                    put("detail", detail)
                }.toString().toRequestBody("application/json".toMediaType())
                val request = Request.Builder()
                    .url("${app.apiClient.baseUrl}/api/radios/ota/status")
                    .header("X-Radio-Token", token)
                    .post(body)
                    .build()
                app.apiClient.httpClient.newCall(request).execute().close()
            } catch (e: Exception) {
                Log.w(TAG, "Failed to report installer error: ${e.message}")
            } finally {
                pending.finish()
            }
        }
    }

    companion object {
        private const val TAG = "[T320-OTA]"
    }
}
