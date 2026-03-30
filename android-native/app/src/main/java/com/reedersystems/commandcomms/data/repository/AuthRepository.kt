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
            var loginFailedLogged = false
            try {
                val bodyJson = api.gson.toJson(
                    mapOf("username" to username, "password" to password)
                )
                val request = Request.Builder()
                    .url("${api.baseUrl}/api/auth/login")
                    .post(bodyJson.toRequestBody(json))
                    .build()
                Log.d(AUTH_TAG, "LOGIN_REQUEST_SENT url=${request.url.redact()} unitId=$username")
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
                    val reason = errorObj ?: "Login failed (${response.code})"
                    Log.e(AUTH_TAG, "LOGIN_FAILED reason=$reason code=${response.code}")
                    loginFailedLogged = true
                    error(reason)
                }
                val wrapper = api.gson.fromJson(body, JsonObject::class.java)
                val user = api.gson.fromJson(wrapper.get("user"), User::class.java)
                Log.d(AUTH_TAG, "LOGIN_SUCCESS user=${user.username} unitId=${user.unitId ?: "none"}")
                Log.d(AUTH_TAG, "SESSION_PERSIST_START")
                Log.d(AUTH_TAG, "SESSION_PERSIST_RESULT cookieJarHasEntries=${api.cookieJar.hasCookies()} setCookieReceived=$setCookieReceived")
                Log.d(AUTH_TAG, "SESSION_PERSISTED cookieJarHasEntries=${api.cookieJar.hasCookies()}")
                Result.success(user)
            } catch (e: Exception) {
                if (!loginFailedLogged) {
                    Log.e(AUTH_TAG, "LOGIN_FAILED reason=${e.message} type=${e::class.simpleName}")
                }
                Result.failure(e)
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
