package com.reedersystems.commandcomms.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

val ColorBackground = Color(0xFFFFFFFF)
val ColorSurface = Color(0xFFF0F0F0)
val ColorSurfaceVariant = Color(0xFFE0E0E0)
val ColorPrimary = Color(0xFF006633)
val ColorPrimaryVariant = Color(0xFF004422)
val ColorRed = Color(0xFFCC0000)
val ColorAmber = Color(0xFFCC8800)
val ColorGreen = Color(0xFF006633)
val ColorTextPrimary = Color(0xFF111111)
val ColorTextSecondary = Color(0xFF555555)

private val T320LightColorScheme = lightColorScheme(
    primary = ColorPrimary,
    onPrimary = Color.White,
    primaryContainer = ColorSurfaceVariant,
    onPrimaryContainer = ColorTextPrimary,
    secondary = ColorAmber,
    onSecondary = Color.White,
    background = ColorBackground,
    onBackground = ColorTextPrimary,
    surface = ColorSurface,
    onSurface = ColorTextPrimary,
    surfaceVariant = ColorSurfaceVariant,
    onSurfaceVariant = ColorTextSecondary,
    error = ColorRed,
    onError = Color.White,
    outline = Color(0xFFAAAAAA)
)

@Composable
fun CommandCommsTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = T320LightColorScheme,
        content = content
    )
}
