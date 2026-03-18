package com.reedersystems.commandcomms

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.reedersystems.commandcomms.navigation.AppNavigation
import com.reedersystems.commandcomms.ui.theme.CommandCommsTheme

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            CommandCommsTheme {
                AppNavigation()
            }
        }
    }
}
