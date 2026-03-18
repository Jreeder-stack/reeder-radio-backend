package com.reedersystems.commandcomms.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

val ColorBackground = Color(0xFF111111)
val ColorSurface = Color(0xFF1C1C1C)
val ColorSurfaceVariant = Color(0xFF2A2A2A)
val ColorCyan = Color(0xFF00FFFF)
val ColorCyanDim = Color(0xFF009999)
val ColorRed = Color(0xFFFF3333)
val ColorAmber = Color(0xFFFFAA00)
val ColorGreen = Color(0xFF00CC44)
val ColorTextPrimary = Color(0xFFE0E0E0)
val ColorTextSecondary = Color(0xFF888888)

private val DarkColorScheme = darkColorScheme(
    primary = ColorCyan,
    onPrimary = Color.Black,
    primaryContainer = ColorCyanDim,
    onPrimaryContainer = Color.Black,
    secondary = ColorAmber,
    onSecondary = Color.Black,
    background = ColorBackground,
    onBackground = ColorTextPrimary,
    surface = ColorSurface,
    onSurface = ColorTextPrimary,
    surfaceVariant = ColorSurfaceVariant,
    onSurfaceVariant = ColorTextSecondary,
    error = ColorRed,
    onError = Color.White,
    outline = Color(0xFF444444)
)

@Composable
fun CommandCommsTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = DarkColorScheme,
        content = content
    )
}
