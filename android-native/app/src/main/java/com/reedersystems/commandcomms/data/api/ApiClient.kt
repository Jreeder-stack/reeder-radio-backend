package com.reedersystems.commandcomms.data.api

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import com.google.gson.Gson
import com.reedersystems.commandcomms.BuildConfig
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

class ApiClient private constructor(context: Context) {

    val gson = Gson()

    val cookieJar = PersistentCookieJar(
        context.getSharedPreferences(COOKIE_PREFS, Context.MODE_PRIVATE)
    )

    @Volatile
    var radioToken: String? = null

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
        .addInterceptor(radioTokenInterceptor)
        .callTimeout(20, TimeUnit.SECONDS)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .build()

    val baseUrl: String = BuildConfig.BASE_URL

    companion object {
        private const val COOKIE_PREFS = "commandcomms_cookies"

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
