package com.reedersystems.commandcomms.audio

import android.app.Activity
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.provider.Settings
import android.util.Log

private const val TAG = "DndOverride"

enum class DndOverrideSource { EMERGENCY, CLEAR_AIR }

class DndOverrideManager(private val context: Context) {
    private val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    private var savedFilter: Int? = null
    private val activeSources = mutableSetOf<DndOverrideSource>()

    val isGranted: Boolean
        get() = nm.isNotificationPolicyAccessGranted

    fun requestPermission(activity: Activity) {
        val intent = Intent(Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS)
        activity.startActivity(intent)
    }

    @Synchronized
    fun activate(source: DndOverrideSource) {
        if (!isGranted) return
        if (activeSources.isEmpty()) {
            savedFilter = nm.currentInterruptionFilter
        }
        activeSources.add(source)
        nm.setInterruptionFilter(NotificationManager.INTERRUPTION_FILTER_PRIORITY)
        Log.d(TAG, "DND override activated source=$source (active=$activeSources, saved=$savedFilter)")
    }

    @Synchronized
    fun restore(source: DndOverrideSource) {
        if (!isGranted) return
        val removed = activeSources.remove(source)
        if (!removed) {
            Log.d(TAG, "DND override restore ignored — source=$source was not active")
            return
        }
        if (activeSources.isEmpty()) {
            val filter = savedFilter ?: NotificationManager.INTERRUPTION_FILTER_ALL
            nm.setInterruptionFilter(filter)
            savedFilter = null
            Log.d(TAG, "DND override restored to $filter (source=$source)")
        } else {
            Log.d(TAG, "DND override still active (removed=$source, remaining=$activeSources)")
        }
    }

    @Synchronized
    fun forceRestoreAll() {
        if (!isGranted) return
        if (activeSources.isNotEmpty()) {
            val filter = savedFilter ?: NotificationManager.INTERRUPTION_FILTER_ALL
            activeSources.clear()
            nm.setInterruptionFilter(filter)
            savedFilter = null
            Log.d(TAG, "DND override force-restored to $filter")
        }
    }
}
