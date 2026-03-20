package com.reedersystems.commandcomms;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioTrack;
import android.media.SoundPool;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

import org.json.JSONObject;

public class BackgroundAudioService extends Service implements NativeRadioEngine.Listener {

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
    private static final String FALLBACK_SERVER_URL = "https://comms.reeder-systems.com";

    public static final String EXTRA_PTT_ACTION = "ptt_action";
    public static final String PTT_ACTION_DOWN = "down";
    public static final String PTT_ACTION_UP = "up";

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

    private SoundPool soundPool;
    private int talkPermitSoundId = -1;
    private volatile boolean isBonking = false;

    private enum PttState { IDLE, TRANSMITTING }
    private volatile PttState pttState = PttState.IDLE;

    private String serverBaseUrl = null;
    private String currentUnitId = null;
    private String currentChannelId = null;
    private String livekitUrl = null;
    private String currentChannelName = null;

    private volatile boolean isReconnecting = false;

    private volatile String lastEventSource    = "none";
    private volatile int    lastEventCode      = -1;
    private volatile String lastEventAction    = "none";
    private volatile long   lastEventTimestamp = 0;

    private AudioManager audioManager;
    private AudioFocusRequest audioFocusRequest;
    private AudioManager.OnAudioFocusChangeListener audioFocusChangeListener;

    private MediaSessionCompat mediaSession;

    @Override
    public void onEngineEvent(String event, java.util.Map<String, Object> data) {
        switch (event) {
            case "connected":
            case "reconnected":
                Log.d(DIAG_TAG, "Engine event: " + event + " — MediaSession STATE_PLAYING");
                updateMediaSessionPlaybackState(true);
                break;
            case "disconnected":
                Log.d(DIAG_TAG, "Engine event: disconnected — MediaSession STATE_STOPPED");
                updateMediaSessionPlaybackState(false);
                if (pttState == PttState.TRANSMITTING) {
                    pttState = PttState.IDLE;
                    abandonAudioFocus();
                    notifyUiPttState(false);
                }
                break;
            default:
                break;
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        createNotificationChannel();
        isRunning = true;
        Log.d(DIAG_TAG, "BackgroundAudioService CREATED — instance set, isRunning=true");

        restoreConnectionInfo();
        initSoundPool();

        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        if (pm != null) {
            cpuWakeLock = pm.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                "CommandComms::BackgroundCPU"
            );
            cpuWakeLock.acquire();
            Log.d(DIAG_TAG, "CPU wake lock acquired");
        }

        audioManager = (AudioManager) getSystemService(AUDIO_SERVICE);
        initAudioFocusListener();

        pttReceiver = new PttBroadcastReceiver();
        IntentFilter pttFilter = new IntentFilter();
        pttFilter.addAction("android.intent.action.PTT.down");
        pttFilter.addAction("android.intent.action.PTT.up");
        pttFilter.addAction("android.intent.action.PTT_DOWN");
        pttFilter.addAction("android.intent.action.PTT_UP");
        pttFilter.addAction("com.inrico.ptt.down");
        pttFilter.addAction("com.inrico.ptt.up");
        pttFilter.addAction("com.inrico.intent.action.PTT_DOWN");
        pttFilter.addAction("com.inrico.intent.action.PTT_UP");
        pttFilter.addAction(ACTION_BTN_PTT_DOWN);
        pttFilter.addAction(ACTION_BTN_PTT_UP);
        pttFilter.addAction(ACTION_BTN_SIDE1_DOWN);
        pttFilter.addAction(ACTION_BTN_SIDE1_UP);
        pttFilter.addAction(ACTION_BTN_SIDE2_DOWN);
        pttFilter.addAction(ACTION_BTN_SIDE2_UP);
        registerReceiver(pttReceiver, pttFilter);
        Log.d(DIAG_TAG, "PTT broadcast receiver registered dynamically (full action set)");

        initMediaSession();

        NativeRadioEngine engineInstance = NativeRadioEngine.peekInstance();
        if (engineInstance != null) {
            engineInstance.addListener(this);
            Log.d(DIAG_TAG, "Registered as NativeRadioEngine listener");
        }

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

    private void initAudioFocusListener() {
        audioFocusChangeListener = focusChange -> {
            Log.d(DIAG_TAG, "AudioFocus change: focusChange=" + focusChange);
            if (focusChange == AudioManager.AUDIOFOCUS_LOSS) {
                Log.w(DIAG_TAG, "AudioFocus LOSS — stopping TX to release mic");
                if (pttState == PttState.TRANSMITTING) {
                    handlePttUp();
                }
            } else if (focusChange == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) {
                Log.w(DIAG_TAG, "AudioFocus LOSS_TRANSIENT — stopping TX");
                if (pttState == PttState.TRANSMITTING) {
                    handlePttUp();
                }
            }
        };
    }

    private boolean requestAudioFocus() {
        if (audioManager == null) return false;
        int result;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            AudioAttributes audioAttributes = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build();
            audioFocusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                .setAudioAttributes(audioAttributes)
                .setAcceptsDelayedFocusGain(false)
                .setOnAudioFocusChangeListener(audioFocusChangeListener)
                .build();
            result = audioManager.requestAudioFocus(audioFocusRequest);
        } else {
            result = audioManager.requestAudioFocus(
                audioFocusChangeListener,
                AudioManager.STREAM_VOICE_CALL,
                AudioManager.AUDIOFOCUS_GAIN_TRANSIENT
            );
        }
        boolean granted = result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
        Log.d(DIAG_TAG, "requestAudioFocus() — result=" + result + " granted=" + granted);
        return granted;
    }

    private void abandonAudioFocus() {
        if (audioManager == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (audioFocusRequest != null) {
                audioManager.abandonAudioFocusRequest(audioFocusRequest);
                audioFocusRequest = null;
                Log.d(DIAG_TAG, "abandonAudioFocus() — AudioFocusRequest abandoned");
            }
        } else {
            audioManager.abandonAudioFocus(audioFocusChangeListener);
            Log.d(DIAG_TAG, "abandonAudioFocus() — legacy abandonAudioFocus called");
        }
    }

    private void initMediaSession() {
        try {
            mediaSession = new MediaSessionCompat(this, "CommandComms.PTT");
            mediaSession.setFlags(
                MediaSessionCompat.FLAG_HANDLES_MEDIA_BUTTONS |
                MediaSessionCompat.FLAG_HANDLES_TRANSPORT_CONTROLS
            );
            updateMediaSessionPlaybackState(false);
            mediaSession.setActive(true);
            Log.d(DIAG_TAG, "MediaSessionCompat created and activated");
        } catch (Exception e) {
            Log.e(DIAG_TAG, "MediaSession init failed: " + e.getMessage());
        }
    }

    private void updateMediaSessionPlaybackState(boolean playing) {
        if (mediaSession == null) return;
        try {
            PlaybackStateCompat.Builder stateBuilder = new PlaybackStateCompat.Builder();
            if (playing) {
                stateBuilder.setState(
                    PlaybackStateCompat.STATE_PLAYING,
                    PlaybackStateCompat.PLAYBACK_POSITION_UNKNOWN,
                    1.0f
                );
            } else {
                stateBuilder.setState(
                    PlaybackStateCompat.STATE_STOPPED,
                    PlaybackStateCompat.PLAYBACK_POSITION_UNKNOWN,
                    0f
                );
            }
            mediaSession.setPlaybackState(stateBuilder.build());
        } catch (Exception e) {
            Log.w(DIAG_TAG, "updateMediaSessionPlaybackState failed: " + e.getMessage());
        }
    }

    private void initSoundPool() {
        try {
            AudioAttributes audioAttrs = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build();
            soundPool = new SoundPool.Builder()
                .setMaxStreams(2)
                .setAudioAttributes(audioAttrs)
                .build();
            int rawId = getResources().getIdentifier("talk_permit", "raw", getPackageName());
            if (rawId != 0) {
                talkPermitSoundId = soundPool.load(this, rawId, 1);
                Log.d(DIAG_TAG, "SoundPool: talk_permit loaded, soundId=" + talkPermitSoundId);
            } else {
                Log.w(DIAG_TAG, "SoundPool: talk_permit raw resource not found");
            }
        } catch (Exception e) {
            Log.e(DIAG_TAG, "SoundPool init failed: " + e.getMessage());
        }
    }

    @Override
    public void onDestroy() {
        Log.d(DIAG_TAG, "BackgroundAudioService DESTROYING");
        isBonking = false;
        if (pttState == PttState.TRANSMITTING) {
            handlePttUp();
        }

        NativeRadioEngine engineInstance = NativeRadioEngine.peekInstance();
        if (engineInstance != null) {
            engineInstance.removeListener(this);
            Log.d(DIAG_TAG, "Unregistered as NativeRadioEngine listener");
        }

        if (mediaSession != null) {
            try {
                updateMediaSessionPlaybackState(false);
                mediaSession.setActive(false);
                mediaSession.release();
                Log.d(DIAG_TAG, "MediaSession released");
            } catch (Exception e) {
                Log.w(DIAG_TAG, "MediaSession release failed: " + e.getMessage());
            }
            mediaSession = null;
        }

        abandonAudioFocus();

        if (soundPool != null) {
            soundPool.release();
            soundPool = null;
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

    private Notification buildForegroundNotification() {
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

        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("COMMAND COMMS Active")
            .setContentText(contentText)
            .setSmallIcon(iconId)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForeground(NOTIFICATION_ID, buildForegroundNotification());

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
        updateMediaSessionPlaybackState(true);
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

    // ── Talk permit tone ──────────────────────────────────────────────────────

    private void playTalkPermitTone() {
        if (soundPool != null && talkPermitSoundId > 0) {
            soundPool.play(talkPermitSoundId, 1.0f, 1.0f, 1, 0, 1.0f);
            Log.d(DIAG_TAG, "Talk permit tone played");
            try { Thread.sleep(350); } catch (InterruptedException ignored) {}
        } else {
            Log.w(DIAG_TAG, "Talk permit tone: SoundPool not ready (id=" + talkPermitSoundId + ")");
        }
    }

    // ── Bonk tone loop (plays while not connected / rejected) ────────────────

    private void runBonkLoop() {
        final int SAMPLE_RATE = 44100;
        final int TONE_DURATION_MS = 220;
        final int SILENCE_DURATION_MS = 120;
        final double FREQ_HZ = 290.0;
        final int toneSamples = (SAMPLE_RATE * TONE_DURATION_MS) / 1000;
        final int silenceSamples = (SAMPLE_RATE * SILENCE_DURATION_MS) / 1000;

        short[] toneBuffer = new short[toneSamples];
        for (int i = 0; i < toneSamples; i++) {
            double angle = 2 * Math.PI * FREQ_HZ * i / SAMPLE_RATE;
            double envelope = 1.0;
            int fadeIn = SAMPLE_RATE / 100;
            int fadeOut = SAMPLE_RATE / 80;
            if (i < fadeIn) envelope = (double) i / fadeIn;
            else if (i > toneSamples - fadeOut) envelope = (double) (toneSamples - i) / fadeOut;
            toneBuffer[i] = (short) (Short.MAX_VALUE * 0.75 * envelope * Math.sin(angle));
        }
        short[] silenceBuffer = new short[silenceSamples];

        AudioTrack audioTrack = null;
        try {
            AudioAttributes attrs = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build();
            AudioFormat format = new AudioFormat.Builder()
                .setSampleRate(SAMPLE_RATE)
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                .build();
            int minBuf = AudioTrack.getMinBufferSize(SAMPLE_RATE,
                AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT);
            audioTrack = new AudioTrack.Builder()
                .setAudioAttributes(attrs)
                .setAudioFormat(format)
                .setBufferSizeInBytes(Math.max(minBuf, (toneSamples + silenceSamples) * 2))
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build();
            audioTrack.play();
            Log.d(DIAG_TAG, "Bonk tone loop started at " + FREQ_HZ + "Hz");

            while (isBonking) {
                audioTrack.write(toneBuffer, 0, toneSamples);
                audioTrack.write(silenceBuffer, 0, silenceSamples);
            }
        } catch (Exception e) {
            Log.e(DIAG_TAG, "Bonk tone error: " + e.getMessage());
        } finally {
            if (audioTrack != null) {
                try {
                    audioTrack.stop();
                    audioTrack.release();
                } catch (Exception ignored) {}
            }
            Log.d(DIAG_TAG, "Bonk tone loop stopped");
        }
    }

    // ── PTT handlers ─────────────────────────────────────────────────────────

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
            Log.w(DIAG_TAG, "handlePttDown() — LiveKit not connected, starting bonk + async reconnect");
            pttState = PttState.TRANSMITTING;
            sendPttSignaling("start");

            isBonking = true;
            Thread bonkThread = new Thread(this::runBonkLoop);
            bonkThread.setDaemon(true);
            bonkThread.start();

            new Thread(() -> {
                boolean reconnected = attemptAutoReconnect();
                isBonking = false;
                if (reconnected) {
                    NativeRadioEngine reconnectEngine = NativeRadioEngine.getInstance(getApplicationContext());
                    if (reconnectEngine != null && reconnectEngine.isConnected()
                            && pttState == PttState.TRANSMITTING) {
                        boolean focused = requestAudioFocus();
                        if (!focused) {
                            Log.w(DIAG_TAG, "handlePttDown() async-reconnect — audio focus denied, aborting TX");
                            pttState = PttState.IDLE;
                            notifyUiPttState(false);
                            return;
                        }
                        playTalkPermitTone();
                        boolean txResult = reconnectEngine.startTransmit();
                        Log.d(DIAG_TAG, "handlePttDown() async-reconnect — startTransmit() result=" + txResult);
                        updateMediaSessionPlaybackState(true);
                        notifyUiPttState(true);
                    } else {
                        Log.w(DIAG_TAG, "handlePttDown() async-reconnect — connected but PTT released or engine gone");
                        pttState = PttState.IDLE;
                        notifyUiPttState(false);
                    }
                } else {
                    Log.w(DIAG_TAG, "handlePttDown() async-reconnect — reconnect failed");
                    pttState = PttState.IDLE;
                    notifyUiPttState(false);
                }
            }).start();
            return;
        }

        pttState = PttState.TRANSMITTING;
        Log.d(DIAG_TAG, "handlePttDown() — state → TRANSMITTING");

        boolean focused = requestAudioFocus();
        if (!focused) {
            Log.w(DIAG_TAG, "handlePttDown() — audio focus denied, aborting TX");
            pttState = PttState.IDLE;
            notifyUiPttState(false);
            return;
        }

        playTalkPermitTone();

        boolean txResult = engine.startTransmit();
        Log.d(DIAG_TAG, "handlePttDown() — startTransmit() result=" + txResult);

        updateMediaSessionPlaybackState(true);
        sendPttSignaling("start");
        notifyUiPttState(true);
        Log.d(DIAG_TAG, "handlePttDown() — COMPLETE (tx=" + txResult + ")");
    }

    private boolean attemptAutoReconnect() {
        if (isReconnecting) {
            Log.d(DIAG_TAG, "attemptAutoReconnect() — already in progress, skipping");
            return false;
        }

        restoreConnectionInfo();

        if (serverBaseUrl == null) {
            serverBaseUrl = FALLBACK_SERVER_URL;
            Log.w(DIAG_TAG, "attemptAutoReconnect() — serverUrl null, using fallback: " + serverBaseUrl);
        }

        if (livekitUrl == null || currentUnitId == null || currentChannelName == null) {
            Log.w(DIAG_TAG, "attemptAutoReconnect() — missing info: lkUrl=" + livekitUrl
                + " serverUrl=" + serverBaseUrl + " unitId=" + currentUnitId + " channelName=" + currentChannelName);
            return false;
        }

        NativeRadioEngine engine = NativeRadioEngine.getInstance(getApplicationContext());

        isReconnecting = true;
        Log.d(DIAG_TAG, "attemptAutoReconnect() — fetching token from server for unit="
            + currentUnitId + " channel=" + currentChannelName);

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
                Log.d(DIAG_TAG, "attemptAutoReconnect() — waited " + (waitAttempts * 100)
                    + "ms, connected=" + finalConnected);
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
            String effectiveUrl = serverBaseUrl != null ? serverBaseUrl : FALLBACK_SERVER_URL;
            String endpoint = effectiveUrl + "/api/ptt/token?identity=" +
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

        isBonking = false;
        pttState = PttState.IDLE;
        Log.d(DIAG_TAG, "handlePttUp() — isBonking=false, state → IDLE");

        NativeRadioEngine engine = NativeRadioEngine.getInstance(getApplicationContext());
        boolean engineAvailable = engine != null;
        boolean lkConnected = engineAvailable && engine.isConnected();
        String lkChannel = engineAvailable ? engine.getActiveChannel() : "null";
        boolean lkMic = engineAvailable && engine.isMicEnabled();
        Log.d(DIAG_TAG, "handlePttUp() — engineAvailable=" + engineAvailable
            + " connected=" + lkConnected + " channel=" + lkChannel + " micActive=" + lkMic);

        boolean txResult = engine.stopTransmit();
        Log.d(DIAG_TAG, "handlePttUp() — stopTransmit() result=" + txResult);

        abandonAudioFocus();
        updateMediaSessionPlaybackState(false);

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
                try (OutputStream os = conn.getOutputStream()) {
                    os.write(body.getBytes("UTF-8"));
                }

                int responseCode = conn.getResponseCode();
                Log.d(DIAG_TAG, "sendPttSignaling(" + action + ") — HTTP " + responseCode);
                conn.disconnect();
            } catch (Exception e) {
                Log.w(DIAG_TAG, "sendPttSignaling(" + action + ") FAILED: " + e.getMessage());
            }
        }).start();
    }

    private void notifyUiPttState(boolean transmitting) {
        HardwarePttPlugin plugin = HardwarePttPlugin.getInstance();
        if (plugin != null) {
            plugin.notifyPttStateFromService(transmitting);
            Log.d(DIAG_TAG, "notifyUiPttState(" + transmitting + ") — HardwarePttPlugin notified");
        } else {
            Log.d(DIAG_TAG, "notifyUiPttState(" + transmitting + ") — HardwarePttPlugin not available");
        }
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "Command Comms Service",
                NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("Background radio communication service");
            channel.setShowBadge(false);
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
