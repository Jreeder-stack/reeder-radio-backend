package com.reedersystems.commandcomms.data.model

import com.google.gson.annotations.SerializedName

data class User(
    val id: Int,
    val username: String,
    val email: String?,
    val role: String,
    @SerializedName("unit_id") val unitId: String?,
    @SerializedName("is_dispatcher") val isDispatcher: Boolean = false
)
