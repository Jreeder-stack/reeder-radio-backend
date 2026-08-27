package com.reedersystems.commandcomms.data.api

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import com.google.firebase.messaging.FirebaseMessaging
import com.google.gson.Gson
import com.reedersystems.commandcomms.BuildConfig
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

private const val TAG = "[ApiClient]"

class ApiClient private constructor(context: Context) {

    val gson = Gson()

    val cookieJar = PersistentCookieJar(
        context.getSharedPreferences(COOKIE_PREFS, Context.MODE_PRIVATE)
    )

    @Volatile
    var radioToken: String? = null

    private val fcmPrefs: SharedPreferences =
        context.getSharedPreferences(FCM_PREFS, Context.MODE_PRIVATE)

    private val devicePrefs: SharedPreferences =
        context.getSharedPreferences(DEVICE_PREFS, Context.MODE_PRIVATE)

    private val deviceIdentityInterceptor = Interceptor { chain ->
        val deviceId = devicePrefs.getString(DEVICE_ID_KEY, null)
        val builder = chain.request().newBuilder()
            .header("x-command-device-type", BuildConfig.RADIO_DEVICE_TYPE)
        if (!deviceId.isNullOrBlank()) {
            builder.header("x-command-device-id", deviceId)
        }
        chain.proceed(builder.build())
    }

    private val radioTokenInterceptor = Interceptor { chain ->
        val token = radioToken
        if (token != null) {
            val request = chain.request().newBuilder()
                .addHeader("x-radio-token", token)
                .build()
            chain.proceed(request)
        } else {
            chain.proceed(chain.request())
        }
    }

    val httpClient: OkHttpClient = OkHttpClient.Builder()
        .cookieJar(cookieJar)
        .addInterceptor(deviceIdentityInterceptor)
        .addInterceptor(radioTokenInterceptor)
        .callTimeout(20, TimeUnit.SECONDS)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .build()

    val baseUrl: String = BuildConfig.BASE_URL

    fun saveFcmToken(token: String) {
        fcmPrefs.edit().putString(FCM_TOKEN_KEY, token).apply()
        Log.d(TAG, "FCM token persisted to SharedPreferences")

        // Phone builds do not have a dedicated radio token. If Firebase rotates
        // the token while the session is already authenticated, push the new
        // token immediately instead of waiting for the next signaling reconnect.
        if (BuildConfig.RADIO_DEVICE_TYPE == "android_phone") {
            CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
                registerPhonePresence()
                registerFcmTokenNow(token)
            }
        }
    }

    fun getPersistedFcmToken(): String? = fcmPrefs.getString(FCM_TOKEN_KEY, null)

    /**
     * Actively asks Firebase for the device's current token, persists it, and
     * registers it with Command Comms whenever authentication is available.
     *
     * This is deliberately stronger than relying on FirebaseMessagingService.onNewToken():
     * onNewToken is not guaranteed to fire during every app install/startup path. A radio
     * that missed that callback could otherwise remain registered in Command Comms with a
     * null fcm_token forever. Calling this at process startup and after socket authentication
     * makes push registration self-healing for existing and newly provisioned radios.
     */
    fun refreshAndRegisterFcmToken(scope: CoroutineScope) {
        scope.launch(Dispatchers.IO) {
            try {
                Log.d(TAG, "FCM self-heal: requesting current Firebase token")
                val token = FirebaseMessaging.getInstance().token.await()
                if (token.isBlank()) {
                    Log.w(TAG, "FCM self-heal: Firebase returned a blank token")
                    return@launch
                }

                val previous = getPersistedFcmToken()
                fcmPrefs.edit().putString(FCM_TOKEN_KEY, token).apply()
                Log.d(
                    TAG,
                    "FCM self-heal: token acquired and persisted changed=${previous != token} deviceType=${BuildConfig.RADIO_DEVICE_TYPE}"
                )

                if (BuildConfig.RADIO_DEVICE_TYPE == "android_phone") {
                    registerPhonePresence()
                    registerFcmTokenNow(token)
                    return@launch
                }

                if (radioToken == null) {
                    Log.d(TAG, "FCM self-heal: radio token not available yet; token persisted for post-auth retry")
                    return@launch
                }

                registerFcmTokenNow(token)
            } catch (e: Exception) {
                Log.w(TAG, "FCM self-heal: failed to obtain/register current token: ${e.message}", e)

                // If Firebase retrieval fails transiently but we already have a cached token,
                // still try to repair the backend row with that known token.
                val cached = getPersistedFcmToken()
                if (!cached.isNullOrBlank()) {
                    Log.d(TAG, "FCM self-heal: falling back to persisted token")
                    if (BuildConfig.RADIO_DEVICE_TYPE == "android_phone") {
                        registerPhonePresence()
                        registerFcmTokenNow(cached)
                    } else if (radioToken != null) {
                        registerFcmTokenNow(cached)
                    }
                }
            }
        }
    }

    /**
     * Re-register push delivery after signaling authentication. Android-phone
     * builds are session-authenticated first-class radio endpoints, so they
     * must register presence even when Firebase has not issued a new token in
     * this process. Dedicated radios continue using their radio token path.
     */
    fun registerPersistedFcmToken(scope: CoroutineScope) {
        if (BuildConfig.RADIO_DEVICE_TYPE == "android_phone") {
            scope.launch(Dispatchers.IO) {
                registerPhonePresence()
                getPersistedFcmToken()?.let { registerFcmTokenNow(it) }
            }
            return
        }

        val token = getPersistedFcmToken() ?: run {
            Log.d(TAG, "registerPersistedFcmToken: no persisted FCM token found, skipping")
            return
        }
        if (radioToken == null) {
            Log.d(TAG, "registerPersistedFcmToken: no radio token set yet, skipping")
            return
        }
        scope.launch(Dispatchers.IO) {
            registerFcmTokenNow(token)
        }
    }

    private fun registerPhonePresence() {
        try {
            val request = Request.Builder()
                .url("$baseUrl/api/radios/phone-presence")
                .post("{}".toRequestBody("application/json".toMediaType()))
                .build()
            httpClient.newCall(request).execute().use { response ->
                if (response.isSuccessful) {
                    Log.d(TAG, "Android phone radio endpoint presence registered")
                } else {
                    Log.w(TAG, "Android phone presence registration failed: ${response.code}")
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Android phone presence registration error: ${e.message}")
        }
    }

    private fun registerFcmTokenNow(token: String) {
        try {
            val body = JSONObject().apply { put("fcmToken", token) }
                .toString()
                .toRequestBody("application/json".toMediaType())
            val request = Request.Builder()
                .url("$baseUrl/api/radios/fcm-token")
                .post(body)
                .build()
            httpClient.newCall(request).execute().use { response ->
                if (response.isSuccessful) {
                    Log.d(TAG, "Persisted FCM token registered successfully after auth")
                } else {
                    val responseBody = response.body?.string()?.take(300)
                    Log.w(TAG, "FCM token re-registration failed: ${response.code} body=$responseBody")
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "FCM token re-registration error: ${e.message}")
        }
    }

    companion object {
        private const val COOKIE_PREFS = "commandcomms_cookies"
        private const val FCM_PREFS = "commandcomms_fcm"
        private const val FCM_TOKEN_KEY = "fcm_token"
        private const val DEVICE_PREFS = "commandcomms_device"
        private const val DEVICE_ID_KEY = "device_id"

        @Volatile
        private var instance: ApiClient? = null

        fun getInstance(context: Context): ApiClient =
            instance ?: synchronized(this) {
                instance ?: ApiClient(context.applicationContext).also { instance = it }
            }
    }
}

class PersistentCookieJar(private val prefs: SharedPreferences) : CookieJar {

    private companion object {
        private const val TAG = "[AUTH-TRACE]"
        private const val COOKIE_STORE_KEY = "cookies_store"
    }

    private val gson = Gson()

    override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
        if (cookies.isEmpty()) return
        val existing = loadAllCookies().associateBy { cookieIdentity(it) }.toMutableMap()
        cookies.forEach { cookie ->
            existing[cookieIdentity(cookie)] = cookie
            Log.d(TAG, "LOGIN_SET_COOKIE_RECEIVED name=${cookie.name} domain=${cookie.domain} path=${cookie.path}")
        }
        persistCookies(existing.values.toList())
    }

    override fun loadForRequest(url: HttpUrl): List<Cookie> {
        val now = System.currentTimeMillis()
        val validCookies = loadAllCookies().filterNot { cookie ->
            cookie.expiresAt <= now
        }
        if (validCookies.isEmpty()) {
            return emptyList()
        }
        val matched = validCookies.filter { it.matches(url) }
        if (validCookies.size != loadAllCookies().size) {
            persistCookies(validCookies)
        }
        return matched
    }

    fun clear() {
        prefs.edit().clear().apply()
    }

    fun hasCookies(): Boolean = loadAllCookies().isNotEmpty()

    fun hasCookiesForUrl(url: HttpUrl): Boolean = loadForRequest(url).isNotEmpty()

    private fun loadAllCookies(): List<Cookie> {
        val serialized = prefs.getString(COOKIE_STORE_KEY, null) ?: return emptyList()
        val records = runCatching {
            gson.fromJson(serialized, Array<CookieRecord>::class.java)?.toList().orEmpty()
        }.getOrElse {
            emptyList()
        }
        return records.mapNotNull { it.toCookie() }
    }

    private fun persistCookies(cookies: List<Cookie>) {
        val records = cookies.map { CookieRecord.fromCookie(it) }
        val serialized = gson.toJson(records)
        prefs.edit().putString(COOKIE_STORE_KEY, serialized).apply()
    }

    private fun cookieIdentity(cookie: Cookie): String =
        "${cookie.name}|${cookie.domain}|${cookie.path}"

    private data class CookieRecord(
        val name: String,
        val value: String,
        val expiresAt: Long,
        val domain: String,
        val path: String,
        val secure: Boolean,
        val httpOnly: Boolean,
        val persistent: Boolean,
        val hostOnly: Boolean,
    ) {
        fun toCookie(): Cookie? = runCatching {
            Cookie.Builder()
                .name(name)
                .value(value)
                .expiresAt(expiresAt)
                .apply {
                    if (hostOnly) {
                        hostOnlyDomain(domain)
                    } else {
                        domain(domain)
                    }
                    path(path)
                    if (secure) secure()
                    if (httpOnly) httpOnly()
                }
                .build()
        }.getOrNull()

        companion object {
            fun fromCookie(cookie: Cookie): CookieRecord = CookieRecord(
                name = cookie.name,
                value = cookie.value,
                expiresAt = cookie.expiresAt,
                domain = cookie.domain,
                path = cookie.path,
                secure = cookie.secure,
                httpOnly = cookie.httpOnly,
                persistent = cookie.persistent,
                hostOnly = cookie.hostOnly,
            )
        }
    }
}
