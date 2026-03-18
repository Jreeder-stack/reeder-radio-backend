package com.reedersystems.commandcomms.data.repository

import com.google.gson.JsonObject
import com.google.gson.reflect.TypeToken
import com.reedersystems.commandcomms.data.api.ApiClient
import com.reedersystems.commandcomms.data.model.Channel
import com.reedersystems.commandcomms.data.model.Zone
import com.reedersystems.commandcomms.data.model.toZones
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Request

class ChannelRepository(private val api: ApiClient) {

    suspend fun getChannels(): Result<List<Channel>> =
        withContext(Dispatchers.IO) {
            runCatching {
                val request = Request.Builder()
                    .url("${api.baseUrl}/api/channels")
                    .get()
                    .build()
                val response = api.httpClient.newCall(request).execute()
                if (!response.isSuccessful) error("Failed to fetch channels (${response.code})")
                val body = response.body?.string() ?: "{}"
                val wrapper = api.gson.fromJson(body, JsonObject::class.java)
                val channelsArray = wrapper.get("channels") ?: error("No channels field in response")
                val type = object : TypeToken<List<Channel>>() {}.type
                api.gson.fromJson<List<Channel>>(channelsArray, type)
            }
        }

    suspend fun getZones(): Result<List<Zone>> =
        getChannels().map { channels -> channels.toZones() }
}
