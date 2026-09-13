package com.smbchan.chatspace.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// Web 版 (Material 3 / インディゴ基調ダーク) に合わせた配色
private val DarkColors = darkColorScheme(
    primary = Color(0xFF9396F5),
    onPrimary = Color(0xFF16173A),
    primaryContainer = Color(0xFF2E3060),
    onPrimaryContainer = Color(0xFFE2E1FF),
    secondary = Color(0xFFC5C3F0),
    onSecondary = Color(0xFF2D2E52),
    secondaryContainer = Color(0xFF43456E),
    onSecondaryContainer = Color(0xFFE4E1FF),
    background = Color(0xFF0B0D13),
    onBackground = Color(0xFFE4E2F2),
    surface = Color(0xFF0B0D13),
    onSurface = Color(0xFFE4E2F2),
    surfaceVariant = Color(0xFF1A1D2B),
    onSurfaceVariant = Color(0xFFA9A8BC),
    surfaceContainer = Color(0xFF141724),
    surfaceContainerHigh = Color(0xFF1B1E2E),
    surfaceContainerHighest = Color(0xFF262938),
    surfaceContainerLow = Color(0xFF10121C),
    surfaceContainerLowest = Color(0xFF060709),
    outline = Color(0xFF4A4E66),
    outlineVariant = Color(0xFF2A2D3E),
    error = Color(0xFFFFB4AB),
    onError = Color(0xFF690005),
    errorContainer = Color(0xFF93000A),
    onErrorContainer = Color(0xFFFFDAD6),
)

@Composable
fun ChatSpaceTheme(content: @Composable () -> Unit) {
    // 常時ダーク (Web 版と同じ) 。isSystemInDarkTheme は現状未使用。
    @Suppress("UNUSED_EXPRESSION")
    isSystemInDarkTheme()
    MaterialTheme(
        colorScheme = DarkColors,
        content = content,
    )
}
