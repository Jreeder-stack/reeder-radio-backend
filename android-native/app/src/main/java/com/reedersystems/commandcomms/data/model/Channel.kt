package com.reedersystems.commandcomms.data.model

import com.google.gson.annotations.SerializedName

data class Channel(
    val id: Int,
    val name: String,
    val zone: String?,
    @SerializedName("zone_id") val zoneId: Int?,
    @SerializedName("room_key") val roomKey: String,
    val enabled: Boolean = true,
    val scannable: Boolean = true
) {
    val zoneName: String get() = zone ?: "Default"
    val displayName: String get() = name
}
