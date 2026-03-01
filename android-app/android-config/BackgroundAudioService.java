package com.reedersystems.commandcomms;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

public class BackgroundAudioService extends Service {

    private static final String TAG = "CommandComms.BgService";
    private static final String CHANNEL_ID = "command_comms_channel";
    private static final int NOTIFICATION_ID = 1001;
    private static final long KEEPALIVE_INTERVAL_MS = 30000;
    
    public static boolean isRunning = false;

    private PowerManager.WakeLock cpuWakeLock;
    private Handler keepAliveHandler;
    private Runnable keepAliveRunnable;
    private PttBroadcastReceiver pttReceiver;

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        isRunning = true;

        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        if (pm != null) {
            cpuWakeLock = pm.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                "CommandComms::BackgroundCPU"
            );
            cpuWakeLock.acquire();
            Log.d(TAG, "CPU wake lock acquired");
        }

        pttReceiver = new PttBroadcastReceiver();
        IntentFilter pttFilter = new IntentFilter();
        pttFilter.addAction("android.intent.action.PTT.down");
        pttFilter.addAction("android.intent.action.PTT.up");
        registerReceiver(pttReceiver, pttFilter);
        Log.d(TAG, "PTT broadcast receiver registered dynamically");

        keepAliveHandler = new Handler(Looper.getMainLooper());
        keepAliveRunnable = new Runnable() {
            @Override
            public void run() {
                Log.d(TAG, "Keep-alive ping");
                keepAliveHandler.postDelayed(this, KEEPALIVE_INTERVAL_MS);
            }
        };
        keepAliveHandler.postDelayed(keepAliveRunnable, KEEPALIVE_INTERVAL_MS);
    }
    
    @Override
    public void onDestroy() {
        if (pttReceiver != null) {
            try {
                unregisterReceiver(pttReceiver);
                Log.d(TAG, "PTT broadcast receiver unregistered");
            } catch (Exception e) {
                Log.w(TAG, "Failed to unregister PTT receiver: " + e.getMessage());
            }
        }
        if (keepAliveHandler != null && keepAliveRunnable != null) {
            keepAliveHandler.removeCallbacks(keepAliveRunnable);
        }
        if (cpuWakeLock != null && cpuWakeLock.isHeld()) {
            cpuWakeLock.release();
            Log.d(TAG, "CPU wake lock released");
        }
        isRunning = false;
        super.onDestroy();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        
        if ("STOP".equals(action)) {
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }
        
        Intent notificationIntent = new Intent(this, MainActivity.class);
        notificationIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
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
