package com.reedersystems.commandcomms.data.api

import android.content.Context
import android.content.SharedPreferences
import com.google.gson.Gson
import com.reedersystems.commandcomms.BuildConfig
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

class ApiClient private constructor(context: Context) {

    val gson = Gson()

    val cookieJar = PersistentCookieJar(
        context.getSharedPreferences(COOKIE_PREFS, Context.MODE_PRIVATE)
    )

    val httpClient: OkHttpClient = OkHttpClient.Builder()
        .cookieJar(cookieJar)
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

    override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
        if (cookies.isEmpty()) return
        val key = "cookies_${url.host}"
        val serialized = cookies.joinToString(DELIMITER) { "${it.name}${SEP}${it.value}" }
        prefs.edit().putString(key, serialized).apply()
    }

    override fun loadForRequest(url: HttpUrl): List<Cookie> {
        val key = "cookies_${url.host}"
        val saved = prefs.getString(key, null) ?: return emptyList()
        return saved.split(DELIMITER).mapNotNull { entry ->
            val idx = entry.indexOf(SEP)
            if (idx < 0) return@mapNotNull null
            val name = entry.substring(0, idx)
            val value = entry.substring(idx + SEP.length)
            Cookie.Builder()
                .name(name)
                .value(value)
                .domain(url.host)
                .path("/")
                .build()
        }
    }

    fun clear() {
        prefs.edit().clear().apply()
    }

    companion object {
        private const val DELIMITER = "||"
        private const val SEP = "::="
    }
}
