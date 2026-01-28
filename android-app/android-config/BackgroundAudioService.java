package com.reedersystems.commandcomms;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

/**
 * Foreground service to keep audio and GPS running in background.
 * 
 * This service displays a persistent notification while the app is active,
 * allowing audio streaming and location updates to continue when the app
 * is minimized.
 * 
 * Installation:
 * 1. Copy to android/app/src/main/java/com/reedersystems/commandcomms/
 * 2. Register in AndroidManifest.xml (see README.md)
 * 3. Start service when user logs in
 * 4. Stop service on logout
 */
public class BackgroundAudioService extends Service {

    private static final String CHANNEL_ID = "command_comms_channel";
    private static final int NOTIFICATION_ID = 1001;
    
    public static boolean isRunning = false;

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        isRunning = true;
    }
    
    @Override
    public void onDestroy() {
        super.onDestroy();
        isRunning = false;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        
        if ("STOP".equals(action)) {
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }
        
        // Build persistent notification
        Intent notificationIntent = new Intent(this, MainActivity.class);
        PendingIntent pendingIntent = PendingIntent.getActivity(
            this, 0, notificationIntent, 
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        int iconId = getResources().getIdentifier("ic_stat_icon", "drawable", getPackageName());
        if (iconId == 0) {
            iconId = android.R.drawable.ic_media_play;
        }
        
        Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("COMMAND COMMS Active")
            .setContentText("Radio communications enabled")
            .setSmallIcon(iconId)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build();

        startForeground(NOTIFICATION_ID, notification);

        return START_STICKY;
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "COMMAND COMMS",
                NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("Background radio communications");
            channel.setShowBadge(false);
            
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }
}
