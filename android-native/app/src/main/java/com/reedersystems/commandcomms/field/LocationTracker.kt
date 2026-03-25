package com.reedersystems.commandcomms.field

import android.annotation.SuppressLint
import android.content.Context
import android.location.Location
import android.os.Looper
import android.util.Log
import com.google.android.gms.location.*
import com.reedersystems.commandcomms.signaling.SignalingRepository

private const val TAG = "[PTT-DIAG]"
private const val LOCATION_INTERVAL_MS = 5_000L
private const val LOCATION_FASTEST_INTERVAL_MS = 2_000L
private const val STATIONARY_SPEED_THRESHOLD = 1.0f
private const val STATIONARY_SEND_INTERVAL_MS = 90_000L

class LocationTracker(
    context: Context,
    private val signalingRepository: SignalingRepository
) {

    private val fusedClient = LocationServices.getFusedLocationProviderClient(context)
    private var isTracking = false
    private var lastSentTime = 0L

    private val locationCallback = object : LocationCallback() {
        override fun onLocationResult(result: LocationResult) {
            val location: Location = result.lastLocation ?: return
            val speed = if (location.hasSpeed()) location.speed else 0f
            val now = System.currentTimeMillis()
            val isMoving = speed >= STATIONARY_SPEED_THRESHOLD
            val elapsed = now - lastSentTime

            if (!isMoving && elapsed < STATIONARY_SEND_INTERVAL_MS) {
                Log.d(TAG, "LocationTracker suppressed (stationary, ${elapsed}ms since last)")
                return
            }

            lastSentTime = now
            Log.d(TAG, "LocationTracker update: ${location.latitude},${location.longitude} speed=$speed")
            signalingRepository.sendLocationUpdate(
                lat = location.latitude,
                lon = location.longitude,
                accuracy = location.accuracy,
                heading = if (location.hasBearing()) location.bearing else null,
                speed = if (location.hasSpeed()) location.speed else null
            )
        }
    }

    @SuppressLint("MissingPermission")
    fun startTracking() {
        if (isTracking) return
        Log.d(TAG, "LocationTracker starting")
        val request = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, LOCATION_INTERVAL_MS)
            .setMinUpdateIntervalMillis(LOCATION_FASTEST_INTERVAL_MS)
            .build()
        fusedClient.requestLocationUpdates(request, locationCallback, Looper.getMainLooper())
        isTracking = true
    }

    fun stopTracking() {
        if (!isTracking) return
        Log.d(TAG, "LocationTracker stopping")
        fusedClient.removeLocationUpdates(locationCallback)
        isTracking = false
    }
}
