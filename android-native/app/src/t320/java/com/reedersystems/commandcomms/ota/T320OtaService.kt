package com.reedersystems.commandcomms.ota

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.app.admin.DevicePolicyManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import com.reedersystems.commandcomms.BuildConfig
import com.reedersystems.commandcomms.CommandCommsApp
import com.reedersystems.commandcomms.audio.radio.RadioState
import com.reedersystems.commandcomms.data.prefs.RadioTokenStore
import com.reedersystems.commandcomms.signaling.SignalingEvent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.MediaType.Companion.toMediaType
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicBoolean

/**
 * T320-only over-the-air update service.
 *
 * It polls the Command Comms backend for an update assigned to this radio,
 * downloads the authenticated APK, verifies SHA-256/package/version, and uses
 * PackageInstaller for an unattended in-place update on Device Owner radios.
 *
 * Safety: no download/install starts while the radio is requesting the floor,
 * transmitting, receiving, channel-busy, in emergency traffic, or clear-air mode.
 */
class T320OtaService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val busy = AtomicBoolean(false)
    private val emergencyUnits = mutableSetOf<String>()
    @Volatile private var clearAirActive = false
    private var signalingJob: Job? = null

    private val app get() = application as CommandCommsApp
    private val tokenStore by lazy { RadioTokenStore(applicationContext) }
    private val otaPrefs by lazy { getSharedPreferences(PREFS, Context.MODE_PRIVATE) }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        startForeground(NOTIFICATION_ID, notification("OTA ready"))
        observeSafetyState()
        scope.launch {
            reportCompletedInstallIfNeeded()
            delay(8_000L)
            while (isActive) {
                runCatching { checkForUpdate() }
                    .onFailure { Log.w(TAG, "OTA check failed: ${it.message}") }
                delay(POLL_INTERVAL_MS)
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_CHECK_NOW) {
            scope.launch { runCatching { checkForUpdate() } }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        signalingJob?.cancel()
        scope.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun observeSafetyState() {
        signalingJob?.cancel()
        signalingJob = scope.launch {
            app.signalingRepository.events.collect { event ->
                when (event) {
                    is SignalingEvent.EmergencyStart -> synchronized(emergencyUnits) { emergencyUnits.add(event.unitId) }
                    is SignalingEvent.EmergencyEnd -> synchronized(emergencyUnits) { emergencyUnits.remove(event.unitId) }
                    is SignalingEvent.ClearAirStart -> clearAirActive = true
                    is SignalingEvent.ClearAirEnd -> clearAirActive = false
                    else -> Unit
                }
            }
        }
    }

    private fun operationallyBusy(): Boolean {
        if (clearAirActive) return true
        if (synchronized(emergencyUnits) { emergencyUnits.isNotEmpty() }) return true
        return when (app.radioStateManager?.currentState) {
            RadioState.REQUESTING_FLOOR,
            RadioState.TRANSMITTING,
            RadioState.RECEIVING,
            RadioState.CHANNEL_BUSY -> true
            else -> false
        }
    }

    private suspend fun checkForUpdate() {
        if (!busy.compareAndSet(false, true)) return
        try {
            val token = tokenStore.getToken() ?: return
            val currentVersion = BuildConfig.VERSION_CODE
            val request = Request.Builder()
                .url("${app.apiClient.baseUrl}/api/radios/ota/check?currentVersionCode=$currentVersion")
                .header("X-Radio-Token", token)
                .get()
                .build()
            val json = app.apiClient.httpClient.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    Log.w(TAG, "check HTTP ${response.code}")
                    return
                }
                JSONObject(response.body?.string() ?: "{}")
            }
            if (!json.optBoolean("updateAvailable", false)) return
            val release = json.optJSONObject("release") ?: return
            val releaseId = release.optLong("id", -1L)
            val versionCode = release.optInt("versionCode", -1)
            val versionName = release.optString("versionName", "")
            val sha256 = release.optString("sha256", "")
            val downloadPath = release.optString("downloadPath", "")
            if (releaseId <= 0 || versionCode <= currentVersion || sha256.length != 64 || downloadPath.isBlank()) return

            if (operationallyBusy()) {
                postStatus(releaseId, "deferred", "Radio active/emergency traffic; waiting for idle")
                updateNotification("Update $versionName waiting for radio idle")
                return
            }

            performUpdate(token, releaseId, versionCode, versionName, sha256, downloadPath)
        } finally {
            busy.set(false)
        }
    }

    private suspend fun performUpdate(
        token: String,
        releaseId: Long,
        versionCode: Int,
        versionName: String,
        expectedSha256: String,
        downloadPath: String
    ) {
        postStatus(releaseId, "downloading", null)
        updateNotification("Downloading Command Comms $versionName")

        val apkFile = File(cacheDir, "t320-ota-$versionCode.apk")
        if (apkFile.exists()) apkFile.delete()
        val request = Request.Builder()
            .url("${app.apiClient.baseUrl}$downloadPath")
            .header("X-Radio-Token", token)
            .get()
            .build()
        app.apiClient.httpClient.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw IllegalStateException("APK download HTTP ${response.code}")
            val body = response.body ?: throw IllegalStateException("APK download body missing")
            apkFile.outputStream().use { output -> body.byteStream().use { input -> input.copyTo(output) } }
        }

        if (operationallyBusy()) {
            apkFile.delete()
            postStatus(releaseId, "deferred", "Radio became active during download; install postponed")
            return
        }

        val actualSha = sha256(apkFile)
        if (!actualSha.equals(expectedSha256, ignoreCase = true)) {
            apkFile.delete()
            postStatus(releaseId, "failed", "SHA-256 mismatch")
            updateNotification("OTA verification failed")
            return
        }

        @Suppress("DEPRECATION")
        val archiveInfo = packageManager.getPackageArchiveInfo(apkFile.absolutePath, PackageManager.GET_META_DATA)
        if (archiveInfo == null || archiveInfo.packageName != packageName) {
            apkFile.delete()
            postStatus(releaseId, "failed", "APK package name does not match installed Command Comms")
            return
        }
        val archiveVersion = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) archiveInfo.longVersionCode.toInt() else archiveInfo.versionCode
        if (archiveVersion != versionCode) {
            apkFile.delete()
            postStatus(releaseId, "failed", "APK versionCode $archiveVersion does not match release $versionCode")
            return
        }

        val dpm = getSystemService(DevicePolicyManager::class.java)
        if (!dpm.isDeviceOwnerApp(packageName)) {
            apkFile.delete()
            postStatus(releaseId, "failed", "Device Owner is required for unattended OTA installation")
            updateNotification("OTA blocked: Device Owner required")
            return
        }

        postStatus(releaseId, "downloaded", null)
        otaPrefs.edit()
            .putLong(KEY_PENDING_RELEASE, releaseId)
            .putInt(KEY_PENDING_VERSION, versionCode)
            .apply()

        installApk(apkFile, releaseId, versionCode)
    }

    private fun installApk(apkFile: File, releaseId: Long, versionCode: Int) {
        if (operationallyBusy()) {
            scope.launch { postStatus(releaseId, "deferred", "Radio became active before installer commit") }
            return
        }
        try {
            val installer = packageManager.packageInstaller
            val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
                setAppPackageName(packageName)
                setSize(apkFile.length())
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
                }
            }
            val sessionId = installer.createSession(params)
            installer.openSession(sessionId).use { session ->
                FileInputStream(apkFile).use { input ->
                    session.openWrite("base.apk", 0, apkFile.length()).use { output ->
                        input.copyTo(output)
                        session.fsync(output)
                    }
                }
                val resultIntent = Intent(this, T320InstallResultReceiver::class.java).apply {
                    putExtra(EXTRA_RELEASE_ID, releaseId)
                    putExtra(EXTRA_VERSION_CODE, versionCode)
                }
                val flags = PendingIntent.FLAG_UPDATE_CURRENT or
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
                val pending = PendingIntent.getBroadcast(this, sessionId, resultIntent, flags)
                scope.launch { postStatus(releaseId, "installing", null) }
                updateNotification("Installing Command Comms update")
                session.commit(pending.intentSender)
            }
        } catch (e: Exception) {
            Log.e(TAG, "PackageInstaller failed", e)
            otaPrefs.edit().remove(KEY_PENDING_RELEASE).remove(KEY_PENDING_VERSION).apply()
            scope.launch { postStatus(releaseId, "failed", "Installer error: ${e.message}") }
            updateNotification("OTA install failed")
        } finally {
            apkFile.delete()
        }
    }

    private suspend fun reportCompletedInstallIfNeeded() {
        val releaseId = otaPrefs.getLong(KEY_PENDING_RELEASE, -1L)
        val targetVersion = otaPrefs.getInt(KEY_PENDING_VERSION, -1)
        if (releaseId <= 0 || targetVersion <= 0) return
        if (BuildConfig.VERSION_CODE >= targetVersion) {
            postStatus(releaseId, "installed", "Running version ${BuildConfig.VERSION_CODE}")
            otaPrefs.edit().remove(KEY_PENDING_RELEASE).remove(KEY_PENDING_VERSION).apply()
            updateNotification("Command Comms updated")
        }
    }

    internal suspend fun postStatus(releaseId: Long, status: String, detail: String?) {
        val token = tokenStore.getToken() ?: return
        val body = JSONObject().apply {
            put("releaseId", releaseId)
            put("status", status)
            put("currentVersionCode", BuildConfig.VERSION_CODE)
            if (detail != null) put("detail", detail)
        }.toString().toRequestBody("application/json".toMediaType())
        val request = Request.Builder()
            .url("${app.apiClient.baseUrl}/api/radios/ota/status")
            .header("X-Radio-Token", token)
            .post(body)
            .build()
        runCatching {
            app.apiClient.httpClient.newCall(request).execute().use { response ->
                if (!response.isSuccessful) Log.w(TAG, "status=$status HTTP ${response.code}")
            }
        }.onFailure { Log.w(TAG, "status=$status failed: ${it.message}") }
    }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buffer)
                if (n <= 0) break
                digest.update(buffer, 0, n)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "T320 software updates", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Checks for and installs Command Comms radio updates"
                setShowBadge(false)
            }
        )
    }

    private fun notification(text: String) = NotificationCompat.Builder(this, CHANNEL_ID)
        .setSmallIcon(android.R.drawable.stat_sys_download_done)
        .setContentTitle("Command Comms")
        .setContentText(text)
        .setOngoing(true)
        .setPriority(NotificationCompat.PRIORITY_LOW)
        .build()

    private fun updateNotification(text: String) {
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification(text))
    }

    companion object {
        private const val TAG = "[T320-OTA]"
        private const val CHANNEL_ID = "t320_ota"
        private const val NOTIFICATION_ID = 1032
        private const val POLL_INTERVAL_MS = 60_000L
        private const val PREFS = "t320_ota"
        private const val KEY_PENDING_RELEASE = "pending_release"
        private const val KEY_PENDING_VERSION = "pending_version"
        const val ACTION_CHECK_NOW = "com.reedersystems.commandcomms.ota.CHECK_NOW"
        const val EXTRA_RELEASE_ID = "ota_release_id"
        const val EXTRA_VERSION_CODE = "ota_version_code"
    }
}
