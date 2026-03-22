package com.reedersystems.commandcomms.data.repository

import android.util.Log
import com.reedersystems.commandcomms.data.api.ApiClient
import com.reedersystems.commandcomms.data.model.RadioTransportConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Request

private const val TAG = "[RadioConfig]"

class RadioConfigRepository(private val api: ApiClient) {

    suspend fun fetchConfig(): Result<RadioTransportConfig> =
        withContext(Dispatchers.IO) {
            runCatching {
                val request = Request.Builder()
                    .url("${api.baseUrl}/api/radio/config")
                    .get()
                    .build()
                val response = api.httpClient.newCall(request).execute()
                response.use { resp ->
                    val body = resp.body?.string() ?: ""
                    if (!resp.isSuccessful) {
                        error("Radio config fetch failed (${resp.code})")
                    }
                    val config = api.gson.fromJson(body, RadioTransportConfig::class.java)
                    Log.d(TAG, "Fetched radio config: host=${config.audioRelayHost} port=${config.audioRelayPort} mode=${config.transportMode}")
                    config
                }
            }
        }
}
