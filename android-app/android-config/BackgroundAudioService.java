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

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

public class BackgroundAudioService extends Service {

    private static final String TAG = "CommandComms.BgService";
    private static final String DIAG_TAG = "PTT-DIAG";
    private static final String CHANNEL_ID = "command_comms_channel";
    private static final int NOTIFICATION_ID = 1001;
    private static final long KEEPALIVE_INTERVAL_MS = 30000;

    public static final String EXTRA_PTT_ACTION = "ptt_action";
    public static final String PTT_ACTION_DOWN = "down";
    public static final String PTT_ACTION_UP = "up";

    private static volatile BackgroundAudioService instance = null;

    public static BackgroundAudioService getInstance() {
        return instance;
    }

    public static boolean isRunning = false;

    private PowerManager.WakeLock cpuWakeLock;
    private Handler keepAliveHandler;
    private Runnable keepAliveRunnable;
    private PttBroadcastReceiver pttReceiver;

    private enum PttState { IDLE, TRANSMITTING }
    private volatile PttState pttState = PttState.IDLE;

    private String serverBaseUrl = null;
    private String currentUnitId = null;
    private String currentChannelId = null;

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        createNotificationChannel();
        isRunning = true;
        Log.d(DIAG_TAG, "BackgroundAudioService CREATED — instance set, isRunning=true");

        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        if (pm != null) {
            cpuWakeLock = pm.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                "CommandComms::BackgroundCPU"
            );
            cpuWakeLock.acquire();
            Log.d(DIAG_TAG, "CPU wake lock acquired");
        }

        pttReceiver = new PttBroadcastReceiver();
        IntentFilter pttFilter = new IntentFilter();
        pttFilter.addAction("android.intent.action.PTT.down");
        pttFilter.addAction("android.intent.action.PTT.up");
        registerReceiver(pttReceiver, pttFilter);
        Log.d(DIAG_TAG, "PTT broadcast receiver registered dynamically");

        keepAliveHandler = new Handler(Looper.getMainLooper());
        keepAliveRunnable = new Runnable() {
            @Override
            public void run() {
                Log.d(TAG, "Keep-alive ping — pttState=" + pttState);
                keepAliveHandler.postDelayed(this, KEEPALIVE_INTERVAL_MS);
            }
        };
        keepAliveHandler.postDelayed(keepAliveRunnable, KEEPALIVE_INTERVAL_MS);
    }

    @Override
    public void onDestroy() {
        Log.d(DIAG_TAG, "BackgroundAudioService DESTROYING");
        if (pttState == PttState.TRANSMITTING) {
            handlePttUp();
        }

        if (pttReceiver != null) {
            try {
                unregisterReceiver(pttReceiver);
                Log.d(DIAG_TAG, "PTT broadcast receiver unregistered");
            } catch (Exception e) {
                Log.w(TAG, "Failed to unregister PTT receiver: " + e.getMessage());
            }
        }
        if (keepAliveHandler != null && keepAliveRunnable != null) {
            keepAliveHandler.removeCallbacks(keepAliveRunnable);
        }
        if (cpuWakeLock != null && cpuWakeLock.isHeld()) {
            cpuWakeLock.release();
            Log.d(DIAG_TAG, "CPU wake lock released");
        }
        isRunning = false;
        instance = null;
        Log.d(DIAG_TAG, "BackgroundAudioService DESTROYED — instance cleared");
        super.onDestroy();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;

        if ("STOP".equals(action)) {
            Log.d(DIAG_TAG, "Service STOP command received");
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }

        if (intent != null) {
            String pttAction = intent.getStringExtra(EXTRA_PTT_ACTION);
            if (pttAction != null) {
                Log.d(DIAG_TAG, "Service received PTT via intent extra: action=" + pttAction);
                if (PTT_ACTION_DOWN.equals(pttAction)) {
                    handlePttDown();
                } else if (PTT_ACTION_UP.equals(pttAction)) {
                    handlePttUp();
                }
            }

            String baseUrl = intent.getStringExtra("server_base_url");
            if (baseUrl != null) {
                serverBaseUrl = baseUrl;
                Log.d(DIAG_TAG, "Server base URL set: " + serverBaseUrl);
            }
            String unitId = intent.getStringExtra("unit_id");
            if (unitId != null) {
                currentUnitId = unitId;
                Log.d(DIAG_TAG, "Unit ID set: " + currentUnitId);
            }
            String channelId = intent.getStringExtra("channel_id");
            if (channelId != null) {
                currentChannelId = channelId;
                Log.d(DIAG_TAG, "Channel ID set: " + currentChannelId);
            }
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

        String contentText = pttState == PttState.TRANSMITTING
            ? "TRANSMITTING"
            : "Radio communications enabled";

        Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("COMMAND COMMS Active")
            .setContentText(contentText)
            .setSmallIcon(iconId)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build();

        startForeground(NOTIFICATION_ID, notification);

        return START_STICKY;
    }

    public void setConnectionInfo(String baseUrl, String unitId, String channelId) {
        this.serverBaseUrl = baseUrl;
        this.currentUnitId = unitId;
        this.currentChannelId = channelId;
        Log.d(DIAG_TAG, "Connection info set: url=" + baseUrl + " unit=" + unitId + " channel=" + channelId);
    }

    public synchronized void handlePttDown() {
        Log.d(DIAG_TAG, "========== SERVICE handlePttDown() ==========");
        Log.d(DIAG_TAG, "handlePttDown() — currentState=" + pttState
            + " serverUrl=" + serverBaseUrl + " unitId=" + currentUnitId + " channelId=" + currentChannelId);

        if (pttState == PttState.TRANSMITTING) {
            Log.d(DIAG_TAG, "handlePttDown() — already TRANSMITTING, ignoring duplicate DOWN");
            return;
        }

        LiveKitPlugin lkPlugin = LiveKitPlugin.getInstance();
        boolean lkConnected = lkPlugin != null && lkPlugin.isRoomConnected();
        String lkChannel = lkPlugin != null ? lkPlugin.getActiveChannel() : "null";
        boolean lkMic = lkPlugin != null && lkPlugin.isMicTransmitting();
        Log.d(DIAG_TAG, "handlePttDown() — LiveKitPlugin=" + (lkPlugin != null)
            + " connected=" + lkConnected + " channel=" + lkChannel + " micActive=" + lkMic);

        if (!lkConnected) {
            Log.w(DIAG_TAG, "handlePttDown() BLOCKED — LiveKit not connected, cannot start TX");
            Log.w(DIAG_TAG, "handlePttDown() — This means NativeLiveKit.connect() was never called from JS, or the connection dropped");
            return;
        }

        pttState = PttState.TRANSMITTING;
        Log.d(DIAG_TAG, "handlePttDown() — state → TRANSMITTING");

        boolean txResult = lkPlugin.startTransmit();
        Log.d(DIAG_TAG, "handlePttDown() — startTransmit() result=" + txResult);

        sendPttSignaling("start");

        notifyUiPttState(true);
        Log.d(DIAG_TAG, "handlePttDown() — COMPLETE (tx=" + txResult + ")");
    }

    public synchronized void handlePttUp() {
        Log.d(DIAG_TAG, "========== SERVICE handlePttUp() ==========");
        Log.d(DIAG_TAG, "handlePttUp() — currentState=" + pttState);

        if (pttState == PttState.IDLE) {
            Log.d(DIAG_TAG, "handlePttUp() — already IDLE, ignoring duplicate UP");
            return;
        }

        pttState = PttState.IDLE;
        Log.d(DIAG_TAG, "handlePttUp() — state → IDLE");

        LiveKitPlugin lkPlugin = LiveKitPlugin.getInstance();
        if (lkPlugin != null) {
            boolean txResult = lkPlugin.stopTransmit();
            Log.d(DIAG_TAG, "handlePttUp() — stopTransmit() result=" + txResult);
        } else {
            Log.w(DIAG_TAG, "handlePttUp() — LiveKitPlugin not available for stopTransmit");
        }

        sendPttSignaling("end");

        notifyUiPttState(false);
        Log.d(DIAG_TAG, "handlePttUp() — COMPLETE");
    }

    public PttState getPttState() {
        return pttState;
    }

    public boolean isTransmitting() {
        return pttState == PttState.TRANSMITTING;
    }

    private void sendPttSignaling(String action) {
        if (serverBaseUrl == null || currentUnitId == null || currentChannelId == null) {
            Log.d(DIAG_TAG, "sendPttSignaling(" + action + ") — skipped, missing connection info"
                + " url=" + serverBaseUrl + " unit=" + currentUnitId + " channel=" + currentChannelId);
            return;
        }

        new Thread(() -> {
            try {
                String endpoint = serverBaseUrl + "/api/ptt/" + action;
                URL url = new URL(endpoint);
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod("POST");
                conn.setRequestProperty("Content-Type", "application/json");
                conn.setDoOutput(true);
                conn.setConnectTimeout(3000);
                conn.setReadTimeout(3000);

                String body = "{\"channelId\":\"" + currentChannelId + "\",\"unitId\":\"" + currentUnitId + "\"}";
                OutputStream os = conn.getOutputStream();
                os.write(body.getBytes("UTF-8"));
                os.flush();
                os.close();

                int responseCode = conn.getResponseCode();
                Log.d(DIAG_TAG, "sendPttSignaling(" + action + ") — HTTP " + responseCode);
                conn.disconnect();
            } catch (Exception e) {
                Log.w(DIAG_TAG, "sendPttSignaling(" + action + ") — FAILED (non-blocking): " + e.getMessage());
            }
        }).start();
    }

    private void notifyUiPttState(boolean pressed) {
        try {
            HardwarePttPlugin pttPlugin = HardwarePttPlugin.getInstance();
            if (pttPlugin != null) {
                pttPlugin.notifyPttStateFromService(pressed);
                Log.d(DIAG_TAG, "notifyUiPttState(" + pressed + ") — HardwarePttPlugin notified");
            } else {
                Log.d(DIAG_TAG, "notifyUiPttState(" + pressed + ") — HardwarePttPlugin not available, UI sync skipped");
            }
        } catch (Exception e) {
            Log.d(DIAG_TAG, "notifyUiPttState(" + pressed + ") — UI sync failed (non-blocking): " + e.getMessage());
        }
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
