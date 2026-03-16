package com.reedersystems.commandcomms;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

import org.json.JSONObject;

public class BackgroundAudioService extends Service {

    private static final String TAG = "CommandComms.BgService";
    private static final String DIAG_TAG = "PTT-DIAG";
    private static final String CHANNEL_ID = "command_comms_channel";
    private static final int NOTIFICATION_ID = 1001;
    private static final long KEEPALIVE_INTERVAL_MS = 30000;
    private static final String PREFS_NAME = "CommandCommsServicePrefs";
    private static final String PREF_SERVER_URL = "server_base_url";
    private static final String PREF_UNIT_ID = "unit_id";
    private static final String PREF_CHANNEL_ID = "channel_id";
    private static final String PREF_LIVEKIT_URL = "livekit_url";
    private static final String PREF_CHANNEL_NAME = "channel_name";

    public static final String EXTRA_PTT_ACTION = "ptt_action";
    public static final String PTT_ACTION_DOWN = "down";
    public static final String PTT_ACTION_UP = "up";

    // Intent action constants for AccessibilityService → Service communication (lifecycle-safe)
    public static final String ACTION_BTN_PTT_DOWN  = "com.reedersystems.commandcomms.action.PTT_DOWN";
    public static final String ACTION_BTN_PTT_UP    = "com.reedersystems.commandcomms.action.PTT_UP";
    public static final String ACTION_BTN_SIDE1_DOWN = "com.reedersystems.commandcomms.action.SIDE1_DOWN";
    public static final String ACTION_BTN_SIDE1_UP   = "com.reedersystems.commandcomms.action.SIDE1_UP";
    public static final String ACTION_BTN_SIDE2_DOWN = "com.reedersystems.commandcomms.action.SIDE2_DOWN";
    public static final String ACTION_BTN_SIDE2_UP   = "com.reedersystems.commandcomms.action.SIDE2_UP";
    public static final String EXTRA_EVENT_SOURCE   = "event_source";

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
    private String livekitUrl = null;
    private String currentChannelName = null;

    private volatile boolean isReconnecting = false;

    // Debug state — last captured button event
    private volatile String lastEventSource    = "none";
    private volatile int    lastEventCode      = -1;
    private volatile String lastEventAction    = "none";
    private volatile long   lastEventTimestamp = 0;

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        createNotificationChannel();
        isRunning = true;
        Log.d(DIAG_TAG, "BackgroundAudioService CREATED — instance set, isRunning=true");

        restoreConnectionInfo();

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
            String intentAction = intent.getAction();
            String source = intent.getStringExtra(EXTRA_EVENT_SOURCE);
            if (source == null) source = "unknown";

            // Handle Intent-based button commands from PttAccessibilityService (lifecycle-safe IPC)
            if (ACTION_BTN_PTT_DOWN.equals(intentAction)) {
                Log.d(DIAG_TAG, "[Service] ACTION_BTN_PTT_DOWN from source=" + source);
                recordEventDebug(source, 141, "DOWN");
                handlePttDown();
                return START_STICKY;
            } else if (ACTION_BTN_PTT_UP.equals(intentAction)) {
                Log.d(DIAG_TAG, "[Service] ACTION_BTN_PTT_UP from source=" + source);
                recordEventDebug(source, 141, "UP");
                handlePttUp();
                return START_STICKY;
            } else if (ACTION_BTN_SIDE1_DOWN.equals(intentAction)) {
                Log.d(DIAG_TAG, "[Service] ACTION_BTN_SIDE1_DOWN from source=" + source);
                recordEventDebug(source, 131, "DOWN");
                handleSideButton1Down();
                return START_STICKY;
            } else if (ACTION_BTN_SIDE1_UP.equals(intentAction)) {
                Log.d(DIAG_TAG, "[Service] ACTION_BTN_SIDE1_UP from source=" + source);
                recordEventDebug(source, 131, "UP");
                handleSideButton1Up();
                return START_STICKY;
            } else if (ACTION_BTN_SIDE2_DOWN.equals(intentAction)) {
                Log.d(DIAG_TAG, "[Service] ACTION_BTN_SIDE2_DOWN from source=" + source);
                recordEventDebug(source, 109, "DOWN");
                handleSideButton2Down();
                return START_STICKY;
            } else if (ACTION_BTN_SIDE2_UP.equals(intentAction)) {
                Log.d(DIAG_TAG, "[Service] ACTION_BTN_SIDE2_UP from source=" + source);
                recordEventDebug(source, 109, "UP");
                handleSideButton2Up();
                return START_STICKY;
            }

            // Legacy PTT via intent extra (PttBroadcastReceiver / cold-start path)
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
        persistConnectionInfo();
        Log.d(DIAG_TAG, "Connection info set and persisted: url=" + baseUrl + " unit=" + unitId + " channel=" + channelId);
    }

    public void setLiveKitInfo(String lkUrl, String channelName) {
        this.livekitUrl = lkUrl;
        this.currentChannelName = channelName;
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        prefs.edit()
            .putString(PREF_LIVEKIT_URL, lkUrl)
            .putString(PREF_CHANNEL_NAME, channelName)
            .apply();
        Log.d(DIAG_TAG, "LiveKit info persisted: lkUrl=" + lkUrl + " channelName=" + channelName);
    }

    private void persistConnectionInfo() {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        SharedPreferences.Editor editor = prefs.edit();
        if (serverBaseUrl != null) editor.putString(PREF_SERVER_URL, serverBaseUrl);
        if (currentUnitId != null) editor.putString(PREF_UNIT_ID, currentUnitId);
        if (currentChannelId != null) editor.putString(PREF_CHANNEL_ID, currentChannelId);
        editor.apply();
        Log.d(DIAG_TAG, "Connection info persisted to SharedPreferences");
    }

    private void restoreConnectionInfo() {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        if (serverBaseUrl == null) {
            serverBaseUrl = prefs.getString(PREF_SERVER_URL, null);
        }
        if (currentUnitId == null) {
            currentUnitId = prefs.getString(PREF_UNIT_ID, null);
        }
        if (currentChannelId == null) {
            currentChannelId = prefs.getString(PREF_CHANNEL_ID, null);
        }
        if (livekitUrl == null) {
            livekitUrl = prefs.getString(PREF_LIVEKIT_URL, null);
        }
        if (currentChannelName == null) {
            currentChannelName = prefs.getString(PREF_CHANNEL_NAME, null);
        }
        Log.d(DIAG_TAG, "Connection info restored from SharedPreferences: url=" + serverBaseUrl
            + " unit=" + currentUnitId + " channel=" + currentChannelId
            + " lkUrl=" + livekitUrl + " channelName=" + currentChannelName);
    }

    public synchronized void handlePttDown() {
        Log.d(DIAG_TAG, "========== SERVICE handlePttDown() ==========");
        Log.d(DIAG_TAG, "handlePttDown() — currentState=" + pttState
            + " serverUrl=" + serverBaseUrl + " unitId=" + currentUnitId + " channelId=" + currentChannelId);

        if (pttState == PttState.TRANSMITTING) {
            Log.d(DIAG_TAG, "handlePttDown() — already TRANSMITTING, ignoring duplicate DOWN");
            return;
        }

        NativeRadioEngine engine = NativeRadioEngine.getInstance(getApplicationContext());
        boolean engineAvailable = engine != null;
        boolean lkConnected = engineAvailable && engine.isConnected();
        String lkChannel = engineAvailable ? engine.getActiveChannel() : "null";
        boolean lkMic = engineAvailable && engine.isMicEnabled();
        Log.d(DIAG_TAG, "handlePttDown() — engineAvailable=" + engineAvailable
            + " connected=" + lkConnected + " channel=" + lkChannel + " micActive=" + lkMic);

        if (!lkConnected) {
            Log.w(DIAG_TAG, "handlePttDown() — LiveKit not connected, launching async auto-reconnect...");
            pttState = PttState.TRANSMITTING;
            sendPttSignaling("start");
            new Thread(() -> {
                boolean reconnected = attemptAutoReconnect();
                if (reconnected) {
                    NativeRadioEngine reconnectEngine = NativeRadioEngine.getInstance(getApplicationContext());
                    if (reconnectEngine.isConnected()) {
                        boolean txResult = reconnectEngine.startTransmit();
                        Log.d(DIAG_TAG, "handlePttDown() async-reconnect — startTransmit() result=" + txResult);
                        notifyUiPttState(true);
                    } else {
                        Log.w(DIAG_TAG, "handlePttDown() async-reconnect — still not connected after attempt");
                    }
                } else {
                    Log.w(DIAG_TAG, "handlePttDown() async-reconnect — reconnect failed");
                }
            }).start();
            return;
        }

        pttState = PttState.TRANSMITTING;
        Log.d(DIAG_TAG, "handlePttDown() — state → TRANSMITTING");

        boolean txResult = engine.startTransmit();
        Log.d(DIAG_TAG, "handlePttDown() — startTransmit() result=" + txResult);

        sendPttSignaling("start");

        notifyUiPttState(true);
        Log.d(DIAG_TAG, "handlePttDown() — COMPLETE (tx=" + txResult + ")");
    }

    private boolean attemptAutoReconnect() {
        if (isReconnecting) {
            Log.d(DIAG_TAG, "attemptAutoReconnect() — already in progress, skipping");
            return false;
        }

        if (livekitUrl == null || serverBaseUrl == null || currentUnitId == null || currentChannelName == null) {
            Log.w(DIAG_TAG, "attemptAutoReconnect() — missing info: lkUrl=" + livekitUrl
                + " serverUrl=" + serverBaseUrl + " unitId=" + currentUnitId + " channelName=" + currentChannelName);
            return false;
        }

        NativeRadioEngine engine = NativeRadioEngine.getInstance(getApplicationContext());

        isReconnecting = true;
        Log.d(DIAG_TAG, "attemptAutoReconnect() — fetching token from server for unit=" + currentUnitId + " channel=" + currentChannelName);

        try {
            String token = fetchTokenFromServer(currentUnitId, currentChannelName);
            if (token == null) {
                Log.w(DIAG_TAG, "attemptAutoReconnect() — failed to fetch token from server");
                isReconnecting = false;
                return false;
            }

            Log.d(DIAG_TAG, "attemptAutoReconnect() — token received, calling connectFromService()");
            boolean connected = engine.connect(livekitUrl, token, currentChannelName);
            Log.d(DIAG_TAG, "attemptAutoReconnect() — connectFromService() result=" + connected);

            if (connected) {
                int waitAttempts = 0;
                while (!engine.isConnected() && waitAttempts < 30) {
                    Thread.sleep(100);
                    waitAttempts++;
                }
                boolean finalConnected = engine.isConnected();
                Log.d(DIAG_TAG, "attemptAutoReconnect() — waited " + (waitAttempts * 100) + "ms, connected=" + finalConnected);
                isReconnecting = false;
                return finalConnected;
            }

            isReconnecting = false;
            return false;

        } catch (Exception e) {
            Log.e(DIAG_TAG, "attemptAutoReconnect() FAILED: " + e.getMessage(), e);
            isReconnecting = false;
            return false;
        }
    }

    private String fetchTokenFromServer(String identity, String channelName) {
        try {
            String endpoint = serverBaseUrl + "/api/ptt/token?identity=" +
                java.net.URLEncoder.encode(identity, "UTF-8") +
                "&room=" + java.net.URLEncoder.encode(channelName, "UTF-8");
            URL url = new URL(endpoint);
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(5000);
            conn.setReadTimeout(5000);

            int responseCode = conn.getResponseCode();
            Log.d(DIAG_TAG, "fetchTokenFromServer() — HTTP " + responseCode);

            if (responseCode == 200) {
                BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream()));
                StringBuilder response = new StringBuilder();
                String line;
                while ((line = reader.readLine()) != null) {
                    response.append(line);
                }
                reader.close();
                conn.disconnect();

                JSONObject json = new JSONObject(response.toString());
                String token = json.optString("token", null);
                Log.d(DIAG_TAG, "fetchTokenFromServer() — token " + (token != null ? "received" : "MISSING from response"));
                return token;
            } else {
                Log.w(DIAG_TAG, "fetchTokenFromServer() — HTTP error " + responseCode);
                conn.disconnect();
                return null;
            }
        } catch (Exception e) {
            Log.e(DIAG_TAG, "fetchTokenFromServer() FAILED: " + e.getMessage());
            return null;
        }
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

        NativeRadioEngine engine = NativeRadioEngine.getInstance(getApplicationContext());
        boolean engineAvailable = engine != null;
        boolean lkConnected = engineAvailable && engine.isConnected();
        String lkChannel = engineAvailable ? engine.getActiveChannel() : "null";
        boolean lkMic = engineAvailable && engine.isMicEnabled();
        Log.d(DIAG_TAG, "handlePttUp() — engineAvailable=" + engineAvailable
            + " connected=" + lkConnected + " channel=" + lkChannel + " micActive=" + lkMic);

        boolean txResult = engine.stopTransmit();
        Log.d(DIAG_TAG, "handlePttUp() — stopTransmit() result=" + txResult);

        sendPttSignaling("end");

        notifyUiPttState(false);
        Log.d(DIAG_TAG, "handlePttUp() — COMPLETE");
    }

    // --- Side button handlers ---

    public void handleSideButton1Down() {
        Log.d(DIAG_TAG, "[Service] handleSideButton1Down() — black side button pressed");
        HardwarePttPlugin plugin = HardwarePttPlugin.getInstance();
        if (plugin != null) {
            plugin.notifySideButton1FromService(true);
        }
    }

    public void handleSideButton1Up() {
        Log.d(DIAG_TAG, "[Service] handleSideButton1Up() — black side button released");
        HardwarePttPlugin plugin = HardwarePttPlugin.getInstance();
        if (plugin != null) {
            plugin.notifySideButton1FromService(false);
        }
    }

    public void handleSideButton2Down() {
        Log.d(DIAG_TAG, "[Service] handleSideButton2Down() — orange side button pressed");
        HardwarePttPlugin plugin = HardwarePttPlugin.getInstance();
        if (plugin != null) {
            plugin.notifySideButton2FromService(true);
        }
    }

    public void handleSideButton2Up() {
        Log.d(DIAG_TAG, "[Service] handleSideButton2Up() — orange side button released");
        HardwarePttPlugin plugin = HardwarePttPlugin.getInstance();
        if (plugin != null) {
            plugin.notifySideButton2FromService(false);
        }
    }

    // --- Debug state ---

    private void recordEventDebug(String source, int code, String action) {
        lastEventSource    = source;
        lastEventCode      = code;
        lastEventAction    = action;
        lastEventTimestamp = System.currentTimeMillis();
    }

    public String getDebugSummary() {
        return "pttState=" + pttState
            + " lastSrc=" + lastEventSource
            + " lastCode=" + lastEventCode
            + " lastAction=" + lastEventAction
            + " lastTs=" + lastEventTimestamp
            + " svcRunning=" + isRunning;
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
