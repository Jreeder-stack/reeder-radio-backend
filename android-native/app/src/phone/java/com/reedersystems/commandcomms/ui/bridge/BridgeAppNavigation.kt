package com.reedersystems.commandcomms.ui.bridge

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.weight
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.reedersystems.commandcomms.ui.login.LoginScreen
import com.reedersystems.commandcomms.ui.radio.PhoneBridgeDashboard

private object BridgeRoutes {
    const val LOGIN = "bridge_login"
    const val DASHBOARD = "bridge_dashboard"
}

/**
 * Phone bridge navigation deliberately contains no physical-radio device
 * registration, assignment, lock, or kiosk routes.
 */
@Composable
fun BridgeAppNavigation() {
    val navController = rememberNavController()

    NavHost(
        navController = navController,
        startDestination = BridgeRoutes.LOGIN
    ) {
        composable(BridgeRoutes.LOGIN) {
            Column(modifier = Modifier.fillMaxSize()) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(Color(0xFF0B6E3E))
                        .padding(horizontal = 16.dp, vertical = 12.dp),
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        text = "UHF BRIDGE • PHONE / TABLET",
                        color = Color.White,
                        fontSize = 16.sp,
                        fontWeight = FontWeight.Black,
                        fontFamily = FontFamily.Monospace
                    )
                }
                Box(modifier = Modifier.weight(1f)) {
                    LoginScreen(
                        onLoginSuccess = {
                            navController.navigate(BridgeRoutes.DASHBOARD) {
                                popUpTo(BridgeRoutes.LOGIN) { inclusive = true }
                            }
                        }
                    )
                }
            }
        }

        composable(BridgeRoutes.DASHBOARD) {
            PhoneBridgeDashboard(
                onLocked = null,
                onUnassigned = null,
                onReassigned = null,
                onSettings = null,
                assignedFromUnit = null
            )
        }
    }
}
