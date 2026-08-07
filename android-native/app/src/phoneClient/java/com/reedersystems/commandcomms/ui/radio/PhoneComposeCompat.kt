package com.reedersystems.commandcomms.ui.radio

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Shape

/** Phone-only compatibility overload used by the compact browser-matched deck. */
@Composable
fun OutlinedIconButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    shape: Shape = IconButtonDefaults.outlinedShape,
    @Suppress("UNUSED_PARAMETER") contentPadding: PaddingValues,
    content: @Composable () -> Unit,
) {
    androidx.compose.material3.OutlinedIconButton(
        onClick = onClick,
        modifier = modifier,
        shape = shape,
        content = content,
    )
}
