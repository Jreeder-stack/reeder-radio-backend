package com.reedersystems.commandcomms.data.model

data class Zone(
    val name: String,
    val channels: List<Channel>
) {
    val displayName: String get() = name
}

fun List<Channel>.toZones(): List<Zone> {
    return groupBy { it.zoneName }
        .map { (zoneName, channels) -> Zone(name = zoneName, channels = channels) }
        .sortedBy { it.name }
}
