package com.reedersystems.commandcomms.data.repository

import android.util.Log
import com.google.gson.JsonObject
import com.google.gson.reflect.TypeToken
import com.reedersystems.commandcomms.data.api.ApiClient
import com.reedersystems.commandcomms.data.model.Channel
import com.reedersystems.commandcomms.data.model.Zone
import com.reedersystems.commandcomms.data.model.toZones
import com.reedersystems.commandcomms.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Request
import okhttp3.CookieJar

class HttpException(val code: Int, message: String) : Exception(message)

class ChannelRepository(private val api: ApiClient) {

    // A dedicated HD760 must be authorized as its assigned radio, never as
    // an unrelated user session left in the app's persistent cookie jar.
    // Keep the normal cookie-authenticated client for phone/desktop flows.
    private val catalogClient by lazy {
        if (BuildConfig.FLAVOR == "hd760") {
            api.httpClient.newBuilder().cookieJar(CookieJar.NO_COOKIES).build()
        } else api.httpClient
    }

    private companion object {
        const val AUTH_TAG = "[AUTH-TRACE]"
        const val ANNOUNCE_TAG = "[Announce]"
    }

    suspend fun getChannels(): Result<List<Channel>> =
        withContext(Dispatchers.IO) {
            runCatching {
                val request = Request.Builder()
                    .url("${api.baseUrl}/api/channels")
                    .get()
                    .build()
                Log.d(AUTH_TAG, "CHANNEL_FETCH_REQUEST_SENT url=${request.url.redact()}")
                val dedicatedRadio = BuildConfig.FLAVOR == "hd760"
                val hasCookie = !dedicatedRadio && api.cookieJar.hasCookiesForUrl(request.url)
                Log.d(AUTH_TAG, "CHANNEL_FETCH_AUTH_ATTACHED cookie=" +
                    (if (hasCookie) "yes" else "no") + " radioToken=" +
                    (if (dedicatedRadio && !api.radioToken.isNullOrBlank()) "yes" else "no"))
                if (!hasCookie && !dedicatedRadio) {
                    Log.w(AUTH_TAG, "AUTH_MISSING_REASON noCookiesForUrl=" + request.url.redact())
                }
                val response = catalogClient.newCall(request).execute()
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

    suspend fun fetchChannelAnnouncementAudio(channelId: Int): Result<ByteArray> =
        withContext(Dispatchers.IO) {
            runCatching {
                val request = Request.Builder()
                    .url("${api.baseUrl}/api/channels/$channelId/announcement")
                    .get()
                    .build()
                val response = api.httpClient.newCall(request).execute()
                response.use { resp ->
                    if (!resp.isSuccessful) {
                        error("Channel announcement fetch failed (${resp.code})")
                    }
                    val bytes = resp.body?.bytes() ?: error("Empty announcement response")
                    Log.d(ANNOUNCE_TAG, "Fetched channel announcement audio channelId=$channelId size=${bytes.size}")
                    bytes
                }
            }
        }

    suspend fun fetchZoneAnnouncementAudio(zoneId: Int): Result<ByteArray> =
        withContext(Dispatchers.IO) {
            runCatching {
                val request = Request.Builder()
                    .url("${api.baseUrl}/api/zones/$zoneId/announcement")
                    .get()
                    .build()
                val response = api.httpClient.newCall(request).execute()
                response.use { resp ->
                    if (!resp.isSuccessful) {
                        error("Zone announcement fetch failed (${resp.code})")
                    }
                    val bytes = resp.body?.bytes() ?: error("Empty announcement response")
                    Log.d(ANNOUNCE_TAG, "Fetched zone announcement audio zoneId=$zoneId size=${bytes.size}")
                    bytes
                }
            }
        }
}
