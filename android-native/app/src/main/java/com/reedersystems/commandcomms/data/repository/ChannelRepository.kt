package com.reedersystems.commandcomms.data.repository

import android.util.Log
import com.google.gson.JsonObject
import com.google.gson.reflect.TypeToken
import com.reedersystems.commandcomms.data.api.ApiClient
import com.reedersystems.commandcomms.data.model.Channel
import com.reedersystems.commandcomms.data.model.Zone
import com.reedersystems.commandcomms.data.model.toZones
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Request

class HttpException(val code: Int, message: String) : Exception(message)

class ChannelRepository(private val api: ApiClient) {

    private companion object {
        const val AUTH_TAG = "[AUTH-TRACE]"
    }

    suspend fun getChannels(): Result<List<Channel>> =
        withContext(Dispatchers.IO) {
            runCatching {
                val request = Request.Builder()
                    .url("${api.baseUrl}/api/channels")
                    .get()
                    .build()
                Log.d(AUTH_TAG, "CHANNEL_FETCH_REQUEST_SENT url=${request.url.redact()}")
                val hasCookie = api.cookieJar.hasCookiesForUrl(request.url)
                Log.d(AUTH_TAG, "CHANNEL_FETCH_AUTH_ATTACHED cookie=${if (hasCookie) "yes" else "no"} token=no")
                if (!hasCookie) {
                    Log.w(AUTH_TAG, "AUTH_MISSING_REASON noCookiesForUrl=${request.url.redact()} cookieJarEmpty=${!api.cookieJar.hasCookies()}")
                }
                val response = api.httpClient.newCall(request).execute()
                val body = response.body?.string() ?: "{}"
                Log.d(AUTH_TAG, "CHANNEL_FETCH_HTTP_RESPONSE code=${response.code}")
                if (!response.isSuccessful) {
                    if (response.code == 401) {
                        val preview = body.replace("\n", " ").take(180)
                        Log.e(AUTH_TAG, "CHANNEL_FETCH_401_DETAILS body=$preview")
                    }
                    throw HttpException(response.code, "Failed to fetch channels (${response.code})")
                }
                val wrapper = api.gson.fromJson(body, JsonObject::class.java)
                val channelsArray = wrapper.get("channels") ?: error("No channels field in response")
                val type = object : TypeToken<List<Channel>>() {}.type
                Log.d(AUTH_TAG, "CHANNEL_FETCH_SUCCESS")
                api.gson.fromJson<List<Channel>>(channelsArray, type)
            }
        }

    suspend fun getZones(): Result<List<Zone>> =
        getChannels().map { channels -> channels.toZones() }
}
