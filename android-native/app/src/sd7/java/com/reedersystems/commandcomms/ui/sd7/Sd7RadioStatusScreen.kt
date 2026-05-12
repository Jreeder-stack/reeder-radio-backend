package com.reedersystems.commandcomms.ui.sd7

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.material3.Text
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.reedersystems.commandcomms.audio.radio.RadioState
import com.reedersystems.commandcomms.audio.radio.SignalQuality
import com.reedersystems.commandcomms.data.model.PttState
import com.reedersystems.commandcomms.ui.radio.RadioViewModel

/**
 * Minimal status UI sized for the Siyata SD7's 0.97" 128×64 monochrome OLED.
 *
 * Design rules for this surface:
 *  - One screen, no scroll. Knob rotation switches channels (already wired
 *    via D-Pad up/down KeyActions); knob press cycles into a future menu.
 *  - Mono-friendly: render only black and white. The OLED can't display
 *    color, but Compose treats the screen as standard ARGB; the OEM
 *    framebuffer dithers to mono. Strong contrast (pure white on pure
 *    black) keeps text legible.
 *  - Small fonts (9–12 sp) with truncation, never wrapping past one line.
 *  - No animations: the OLED's refresh rate fights smooth motion.
 *
 * Drives the same RadioViewModel as the T320 RadioScreen so all signaling,
 * floor control, audio transport, paging, and emergency behavior stay
 * identical across flavors. This Composable only changes how state is
 * presented.
 *
 * The visual design is intentionally minimal in this task and meant to be
 * iterated on in a follow-up (see task brief "Out of scope"). It exposes
 * everything dispatchers need for hardware validation: current
 * channel/zone, TX/RX state, signal/battery, last talker, and an alert
 * overlay for incoming pages and emergencies.
 */
@Composable
fun Sd7RadioStatusScreen(
    onLocked: (() -> Unit)?,
    onUnassigned: (() -> Unit)?,
    onReassigned: ((String) -> Unit)?,
    @Suppress("UNUSED_PARAMETER") onSettings: (() -> Unit)?,
    assignedFromUnit: String?,
    viewModel: RadioViewModel = viewModel()
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()

    LaunchedEffect(state.isRadioLocked) { if (state.isRadioLocked) onLocked?.invoke() }
    LaunchedEffect(state.isRadioUnassigned) {
        if (state.isRadioUnassigned) {
            viewModel.consumeRadioUnassigned()
            onUnassigned?.invoke()
        }
    }
    LaunchedEffect(state.reassignedUnitId) {
        val newUnitId = state.reassignedUnitId
        if (newUnitId != null) {
            viewModel.consumeReassigned()
            onReassigned?.invoke(newUnitId)
        }
    }

    val txActive = state.pttState == PttState.TRANSMITTING ||
        state.radioState == RadioState.TRANSMITTING
    val rxUnit = state.activeTransmittingUnit
    val rxActive = state.radioState == RadioState.RECEIVING && !rxUnit.isNullOrBlank()

    val zoneName = state.currentZone?.name?.uppercase() ?: "—"
    val channelName = state.currentChannel?.name?.uppercase() ?: "NO CH"
    val unitId = state.unitId.ifBlank { "—" }

    val signalText = when (state.signalQuality) {
        SignalQuality.EXCELLENT -> "▮▮▮▮"
        SignalQuality.GOOD      -> "▮▮▮ "
        SignalQuality.FAIR      -> "▮▮  "
        SignalQuality.POOR      -> "▮   "
        SignalQuality.NONE      -> "    "
    }
    val battery = state.batteryLevel?.let { "${it}%" } ?: "--%"

    Box(modifier = Modifier.fillMaxSize().background(Color.Black)) {
        Column(modifier = Modifier.fillMaxSize().padding(2.dp)) {

            // Row 1: zone / channel — biggest font, top of screen.
            Text(
                text = "$zoneName/$channelName",
                color = Color.White,
                fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
                fontSize = 12.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.fillMaxWidth()
            )

            Spacer(modifier = Modifier.height(1.dp))

            // Row 2: unit id + signal bars + battery percent.
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Sd7Mono("U:$unitId")
                Sd7Mono(signalText)
                Sd7Mono(battery)
            }

            Spacer(modifier = Modifier.height(2.dp))

            // Row 3: TX / RX / IDLE banner — high-contrast inverse block when
            // active so the operator can see at-a-glance whether the radio is
            // currently keyed or receiving even at arm's length.
            val (bannerText, bannerBg, bannerFg) = when {
                txActive -> Triple("◉ TX", Color.White, Color.Black)
                rxActive -> Triple("◉ RX ${rxUnit ?: ""}".trimEnd(), Color.White, Color.Black)
                else     -> Triple("- IDLE -", Color.Black, Color.White)
            }
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(bannerBg)
                    .padding(horizontal = 2.dp, vertical = 1.dp)
            ) {
                Text(
                    text = bannerText,
                    color = bannerFg,
                    fontWeight = FontWeight.Bold,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 11.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
            }

            // Channel busy indicator (someone else holds the floor).
            if (state.isChannelBusy && !rxActive && !txActive) {
                Spacer(modifier = Modifier.height(1.dp))
                Sd7Mono("BUSY")
            }

            // Assigned-overlay pulse so a freshly-assigned unit ID is
            // unmistakable on first paint.
            if (!assignedFromUnit.isNullOrBlank()) {
                Spacer(modifier = Modifier.height(1.dp))
                Sd7Mono("→ $assignedFromUnit")
            }
        }

        // Page-alert overlay — full-screen inverse so an incoming page is
        // impossible to miss on the small OLED.
        if (state.showPageAlert) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(Color.White),
                contentAlignment = Alignment.Center
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(
                        text = "PAGE",
                        color = Color.Black,
                        fontWeight = FontWeight.Bold,
                        fontFamily = FontFamily.Monospace,
                        fontSize = 14.sp
                    )
                    Text(
                        text = state.pageAlertSender,
                        color = Color.Black,
                        fontFamily = FontFamily.Monospace,
                        fontSize = 10.sp,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                    Text(
                        text = state.pageAlertMessage,
                        color = Color.Black,
                        fontFamily = FontFamily.Monospace,
                        fontSize = 9.sp,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis
                    )
                }
            }
        }

        // Emergency overlay — wins over everything else.
        if (state.myEmergencyActive || state.channelEmergencyActive) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(Color.White),
                contentAlignment = Alignment.Center
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(
                        text = "!! EMERGENCY !!",
                        color = Color.Black,
                        fontWeight = FontWeight.Bold,
                        fontFamily = FontFamily.Monospace,
                        fontSize = 13.sp
                    )
                    val euid = state.channelEmergencyUnitId
                    if (!euid.isNullOrBlank()) {
                        Text(
                            text = euid,
                            color = Color.Black,
                            fontFamily = FontFamily.Monospace,
                            fontSize = 10.sp,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun Sd7Mono(text: String) {
    Text(
        text = text,
        color = Color.White,
        fontFamily = FontFamily.Monospace,
        fontSize = 9.sp,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis
    )
}
