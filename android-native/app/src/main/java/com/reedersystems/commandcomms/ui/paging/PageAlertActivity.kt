package com.reedersystems.commandcomms.ui.paging

import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.reedersystems.commandcomms.messaging.CommandCommsFirebaseService
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class PageAlertActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
            val km = getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager
            km?.requestDismissKeyguard(this, null)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                    or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                    or WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                    or WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD
            )
        }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        val sender = intent.getStringExtra(CommandCommsFirebaseService.EXTRA_PAGE_SENDER) ?: "DISPATCH"
        val message = intent.getStringExtra(CommandCommsFirebaseService.EXTRA_PAGE_MESSAGE) ?: ""
        val pageId = intent.getStringExtra(CommandCommsFirebaseService.EXTRA_PAGE_ID) ?: ""
        val timestamp = System.currentTimeMillis()

        setContent {
            PageAlertScreen(
                sender = sender,
                message = message,
                receivedAt = timestamp,
                onAcknowledge = {
                    CommandCommsFirebaseService.stopPagingTone()
                    CommandCommsFirebaseService.clearPagingNotification(applicationContext)
                    finish()
                }
            )
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        recreate()
    }

    override fun finish() {
        CommandCommsFirebaseService.stopPagingTone()
        CommandCommsFirebaseService.clearPagingNotification(applicationContext)
        super.finish()
    }
}

@Composable
private fun PageAlertScreen(
    sender: String,
    message: String,
    receivedAt: Long,
    onAcknowledge: () -> Unit
) {
    val timeStr = remember(receivedAt) {
        SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date(receivedAt))
    }
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFFCC0000))
            .padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f)
                .verticalScroll(rememberScrollState()),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Top
        ) {
            Spacer(modifier = Modifier.height(24.dp))
            Text(
                text = "PAGE FROM",
                color = Color.White,
                fontSize = 28.sp,
                fontWeight = FontWeight.Bold,
                textAlign = TextAlign.Center
            )
            Text(
                text = sender.uppercase(Locale.getDefault()),
                color = Color.White,
                fontSize = 40.sp,
                fontWeight = FontWeight.ExtraBold,
                textAlign = TextAlign.Center
            )
            Spacer(modifier = Modifier.height(24.dp))
            Text(
                text = timeStr,
                color = Color.White,
                fontSize = 18.sp,
                textAlign = TextAlign.Center
            )
            Spacer(modifier = Modifier.height(32.dp))
            Text(
                text = message,
                color = Color.White,
                fontSize = 28.sp,
                fontWeight = FontWeight.Medium,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth()
            )
        }

        Button(
            onClick = onAcknowledge,
            colors = ButtonDefaults.buttonColors(
                containerColor = Color.White,
                contentColor = Color(0xFFCC0000)
            ),
            modifier = Modifier
                .fillMaxWidth()
                .height(72.dp),
            contentPadding = PaddingValues(16.dp)
        ) {
            Text(
                text = "ACKNOWLEDGE",
                fontSize = 24.sp,
                fontWeight = FontWeight.Bold
            )
        }
    }
}

