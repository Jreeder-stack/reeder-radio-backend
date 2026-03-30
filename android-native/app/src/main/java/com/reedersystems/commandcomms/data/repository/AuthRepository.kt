package com.reedersystems.commandcomms.data.repository

import android.util.Log
import com.google.gson.JsonObject
import com.reedersystems.commandcomms.data.api.ApiClient
import com.reedersystems.commandcomms.data.model.User
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

class AuthRepository(private val api: ApiClient) {

    private companion object {
        const val AUTH_TAG = "[AUTH-TRACE]"
    }

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
                Log.d(AUTH_TAG, "LOGIN_HTTP_REQUEST_SENT url=${request.url.redact()}")
                val response = api.httpClient.newCall(request).execute()
                val body = response.body?.string() ?: ""
                Log.d(AUTH_TAG, "LOGIN_HTTP_RESPONSE code=${response.code}")
                val setCookieReceived = response.headers("Set-Cookie").isNotEmpty()
                if (!setCookieReceived) {
                    Log.w(AUTH_TAG, "LOGIN_SET_COOKIE_RECEIVED none")
                }
                if (!response.isSuccessful) {
                    val errorObj = runCatching {
                        api.gson.fromJson(body, JsonObject::class.java)
                            ?.get("error")?.asString
                    }.getOrNull()
                    error(errorObj ?: "Login failed (${response.code})")
                }
                val wrapper = api.gson.fromJson(body, JsonObject::class.java)
                Log.d(AUTH_TAG, "SESSION_PERSISTED cookieJarHasEntries=${api.cookieJar.hasCookies()}")
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
