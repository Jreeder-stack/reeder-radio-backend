package com.reedersystems.commandcomms.data.repository

import com.google.gson.JsonObject
import com.reedersystems.commandcomms.data.api.ApiClient
import com.reedersystems.commandcomms.data.model.User
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

class AuthRepository(private val api: ApiClient) {

    private val json = "application/json; charset=utf-8".toMediaType()

    suspend fun login(username: String, password: String): Result<User> =
        withContext(Dispatchers.IO) {
            runCatching {
                val bodyJson = api.gson.toJson(
                    mapOf("username" to username, "password" to password)
                )
                val request = Request.Builder()
                    .url("${api.baseUrl}/api/auth/login")
                    .post(bodyJson.toRequestBody(json))
                    .build()
                val response = api.httpClient.newCall(request).execute()
                val body = response.body?.string() ?: ""
                if (!response.isSuccessful) {
                    val errorObj = runCatching {
                        api.gson.fromJson(body, JsonObject::class.java)
                            ?.get("error")?.asString
                    }.getOrNull()
                    error(errorObj ?: "Login failed (${response.code})")
                }
                val wrapper = api.gson.fromJson(body, JsonObject::class.java)
                api.gson.fromJson(wrapper.get("user"), User::class.java)
            }
        }

    suspend fun me(): Result<User> =
        withContext(Dispatchers.IO) {
            runCatching {
                val request = Request.Builder()
                    .url("${api.baseUrl}/api/auth/me")
                    .get()
                    .build()
                val response = api.httpClient.newCall(request).execute()
                if (!response.isSuccessful) error("Not authenticated (${response.code})")
                val body = response.body?.string() ?: ""
                val wrapper = api.gson.fromJson(body, JsonObject::class.java)
                api.gson.fromJson(wrapper.get("user"), User::class.java)
            }
        }

    suspend fun logout(): Unit =
        withContext(Dispatchers.IO) {
            runCatching {
                val request = Request.Builder()
                    .url("${api.baseUrl}/api/auth/logout")
                    .post("{}".toRequestBody(json))
                    .build()
                api.httpClient.newCall(request).execute().close()
            }
            api.cookieJar.clear()
        }
}
