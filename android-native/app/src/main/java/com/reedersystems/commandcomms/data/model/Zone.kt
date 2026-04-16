package com.reedersystems.commandcomms.data.model

data class Zone(
    val id: Int?,
    val name: String,
    val channels: List<Channel>
) {
    val displayName: String get() = name
}

fun List<Channel>.toZones(): List<Zone> {
    return groupBy { it.zoneName }
        .map { (zoneName, channels) ->
            Zone(id = channels.firstOrNull()?.zoneId, name = zoneName, channels = channels)
        }
        .sortedBy { it.name }
}
