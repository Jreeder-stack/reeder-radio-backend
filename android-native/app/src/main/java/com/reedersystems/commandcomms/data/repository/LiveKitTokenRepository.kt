package com.reedersystems.commandcomms.data.repository

import com.google.gson.JsonObject
import com.reedersystems.commandcomms.data.api.ApiClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Request

data class LiveKitToken(val token: String, val livekitUrl: String)

/**
 * @deprecated The custom radio transport path uses UDP relay instead of LiveKit.
 * This repository is retained only for the dispatcher/web fallback path (transportMode="livekit")
 * and will be removed once the replacement is verified working in production.
 */
@Deprecated("Replaced by custom radio UDP transport for handheld devices")
class LiveKitTokenRepository(private val api: ApiClient) {

    suspend fun getToken(identity: String, room: String): Result<LiveKitToken> =
        withContext(Dispatchers.IO) {
            runCatching {
                val url = "${api.baseUrl}/api/ptt/token" +
                    "?identity=${encode(identity)}&room=${encode(room)}"
                val request = Request.Builder().url(url).get().build()
                val response = api.httpClient.newCall(request).execute()
                if (!response.isSuccessful) {
                    val body = response.body?.string() ?: ""
                    val msg = runCatching {
                        api.gson.fromJson(body, JsonObject::class.java)?.get("error")?.asString
                    }.getOrNull()
                    error(msg ?: "Token request failed (${response.code})")
                }
                val body = response.body?.string() ?: "{}"
                val json = api.gson.fromJson(body, JsonObject::class.java)
                val token = json.get("token")?.asString ?: error("No token in response")
                val livekitUrl = json.get("livekitUrl")?.asString ?: error("No livekitUrl in response")
                LiveKitToken(token, livekitUrl)
            }
        }

    private fun encode(value: String): String =
        java.net.URLEncoder.encode(value, "UTF-8")
}
