package com.reedersystems.commandcomms;

import android.Manifest;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.AlertDialog;
import android.app.KeyguardManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.util.Log;
import android.util.TypedValue;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityManager;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;
import java.util.ArrayList;
import java.util.List;

public class MainActivity extends BridgeActivity {

    private static final String TAG = "CommandComms";
    private static final String DIAG_TAG = "PTT-DIAG";
    private static final int PERMISSION_REQUEST_CODE = 1001;
    private static final int BACKGROUND_LOCATION_REQUEST_CODE = 1002;

    private boolean batteryExemptionPrompted = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(HardwarePttPlugin.class);
        registerPlugin(DndOverridePlugin.class);
        registerPlugin(LiveKitPlugin.class);
        registerPlugin(BackgroundServicePlugin.class);

        super.onCreate(savedInstanceState);

        Log.d(DIAG_TAG, "MainActivity.onCreate() — starting BackgroundAudioService immediately");
        startBackgroundAudioServiceNow();

        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        setupNativeStatusUi();

        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            requestAllPermissions();
        }, 500);
    }

    private void startBackgroundAudioServiceNow() {
        try {
            Intent serviceIntent = new Intent(this, BackgroundAudioService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(serviceIntent);
            } else {
                startService(serviceIntent);
            }
            Log.d(DIAG_TAG, "BackgroundAudioService start intent sent from MainActivity");
        } catch (Exception e) {
            Log.e(DIAG_TAG, "Failed to start BackgroundAudioService from MainActivity: " + e.getMessage());
        }
    }

    private void requestAllPermissions() {
        List<String> permissionsNeeded = new ArrayList<>();

        String[] basePermissions = {
            Manifest.permission.RECORD_AUDIO,
            Manifest.permission.CAMERA,
            Manifest.permission.MODIFY_AUDIO_SETTINGS,
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION
        };

        for (String permission : basePermissions) {
            if (ContextCompat.checkSelfPermission(this, permission) != PackageManager.PERMISSION_GRANTED) {
                permissionsNeeded.add(permission);
            }
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
                permissionsNeeded.add(Manifest.permission.BLUETOOTH_CONNECT);
            }
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_SCAN) != PackageManager.PERMISSION_GRANTED) {
                permissionsNeeded.add(Manifest.permission.BLUETOOTH_SCAN);
            }
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                permissionsNeeded.add(Manifest.permission.POST_NOTIFICATIONS);
            }
        }

        if (!permissionsNeeded.isEmpty()) {
            Log.d(TAG, "Requesting permissions: " + permissionsNeeded.toString());
            ActivityCompat.requestPermissions(this, permissionsNeeded.toArray(new String[0]), PERMISSION_REQUEST_CODE);
        } else {
            Log.d(TAG, "All permissions already granted");
            configureWebViewForWebRTC();
            requestBackgroundLocationIfNeeded();
            requestBatteryOptimizationExemption();
        }
    }

    private void requestBackgroundLocationIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
                && ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_BACKGROUND_LOCATION) != PackageManager.PERMISSION_GRANTED) {
                Log.d(TAG, "Requesting background location permission...");
                ActivityCompat.requestPermissions(this, new String[]{ Manifest.permission.ACCESS_BACKGROUND_LOCATION }, BACKGROUND_LOCATION_REQUEST_CODE);
            }
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);

        if (requestCode == PERMISSION_REQUEST_CODE) {
            for (int i = 0; i < permissions.length; i++) {
                String permission = permissions[i];
                boolean granted = grantResults[i] == PackageManager.PERMISSION_GRANTED;
                Log.d(TAG, "Permission " + permission + " granted: " + granted);
            }
            configureWebViewForWebRTC();
            requestBackgroundLocationIfNeeded();
            requestBatteryOptimizationExemption();
        } else if (requestCode == BACKGROUND_LOCATION_REQUEST_CODE) {
            boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            Log.d(TAG, "Background location permission granted: " + granted);
        }
    }

    private void requestBatteryOptimizationExemption() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null && !pm.isIgnoringBatteryOptimizations(getPackageName())) {
                Log.d(TAG, "Requesting battery optimization exemption...");
                try {
                    Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                    intent.setData(Uri.parse("package:" + getPackageName()));
                    startActivity(intent);
                } catch (Exception e) {
                    Log.e(TAG, "Failed to request battery optimization exemption: " + e.getMessage());
                }
            } else {
                Log.d(TAG, "Battery optimization already exempted");
            }
        }
    }

    private void configureWebViewForWebRTC() {
        WebView webView = this.bridge.getWebView();
        WebSettings settings = webView.getSettings();

        settings.setMediaPlaybackRequiresUserGesture(false);

        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }

        Log.d(TAG, "WebView configured for WebRTC: mediaPlaybackRequiresUserGesture=false");

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                Log.d(TAG, "WebView permission request received");
                runOnUiThread(() -> {
                    String[] requestedResources = request.getResources();
                    for (String resource : requestedResources) {
                        Log.d(TAG, "Requested resource: " + resource);
                        if (resource.equals(PermissionRequest.RESOURCE_AUDIO_CAPTURE) ||
                            resource.equals(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) {
                            Log.d(TAG, "Granting WebRTC permission");
                            request.grant(request.getResources());
                            return;
                        }
                    }
                    Log.d(TAG, "Denying non-audio/video permission request");
                    request.deny();
                });
            }
        });
    }

    // Legacy T320 keycodes (original mappings, kept as fallback)
    private static final int KEY_PTT = PttKeyMapping.KEYCODE_PTT_FALLBACK;
    private static final int KEY_ACC = 231;
    private static final int KEY_EMERGENCY = 233;
    private static final int KEY_DPAD_UP = 19;
    private static final int KEY_DPAD_DOWN = 20;
    private static final int KEY_DPAD_LEFT = 21;
    private static final int KEY_DPAD_RIGHT = 22;
    private static final int KEY_STAR = 17;

    // Confirmed Linux-to-Android keycode mappings from adb getevent -l on T320
    private static final int KEY_PTT_F11         = PttKeyMapping.KEYCODE_PTT_PRIMARY; // 141 — PTT primary
    private static final int KEY_SIDE1_F1        = KeyEvent.KEYCODE_F1;            // 131 — black side button
    private static final int KEY_SIDE2_SELECT    = KeyEvent.KEYCODE_BUTTON_SELECT; // 109 — orange side button (verify on device)
    private static final int KEY_SIDE2_DPAD_CTR  = KeyEvent.KEYCODE_DPAD_CENTER;   // 23  — orange fallback

    // Per-button held-state for Activity-side handling (fallback when AccessibilityService is off)
    private boolean activityPttHeld   = false;
    private boolean activitySide1Held = false;
    private boolean activitySide2Held = false;

    private LinearLayout accessibilityBanner;

    private PowerManager.WakeLock screenWakeLock;
    private Handler jsKeepaliveHandler;
    private Runnable jsKeepaliveRunnable;
    private boolean isScreenOff = false;

    private void startJsKeepalive() {
        if (jsKeepaliveHandler != null) return;
        jsKeepaliveHandler = new Handler(Looper.getMainLooper());
        jsKeepaliveRunnable = new Runnable() {
            @Override
            public void run() {
                if (isScreenOff) {
                    keepWebViewAlive();
                }
                jsKeepaliveHandler.postDelayed(this, 3000);
            }
        };
        jsKeepaliveHandler.postDelayed(jsKeepaliveRunnable, 3000);
    }

    private void stopJsKeepalive() {
        if (jsKeepaliveHandler != null && jsKeepaliveRunnable != null) {
            jsKeepaliveHandler.removeCallbacks(jsKeepaliveRunnable);
        }
        jsKeepaliveHandler = null;
        jsKeepaliveRunnable = null;
    }

    private boolean isT320Key(int keyCode) {
        return keyCode == KEY_PTT || keyCode == KEY_PTT_F11
            || keyCode == KEY_ACC || keyCode == KEY_EMERGENCY
            || keyCode == KEY_SIDE1_F1
            || keyCode == KEY_SIDE2_SELECT || keyCode == KEY_SIDE2_DPAD_CTR
            || keyCode == KEY_DPAD_UP || keyCode == KEY_DPAD_DOWN
            || keyCode == KEY_DPAD_LEFT || keyCode == KEY_DPAD_RIGHT
            || keyCode == KEY_STAR;
    }

    private boolean isPttKey(int keyCode) {
        return PttKeyMapping.isPttKey(keyCode);
    }

    private boolean isSide1Key(int keyCode) {
        return keyCode == KEY_SIDE1_F1;
    }

    private boolean isSide2Key(int keyCode) {
        return keyCode == KEY_SIDE2_SELECT || keyCode == KEY_SIDE2_DPAD_CTR;
    }

    private boolean isAccessibilityServiceEnabled() {
        return false;
    }

    private void logResumeDiagnostics() {
        boolean svcRunning = BackgroundAudioService.isRunning;
        BackgroundAudioService svc = BackgroundAudioService.getInstance();

        Log.d(DIAG_TAG, "=== RESUME DIAGNOSTICS ===");
        Log.d(DIAG_TAG, "  AccessibilityService enabled : false (disabled by app config)");
        Log.d(DIAG_TAG, "  BackgroundAudioService running: " + svcRunning);
        Log.d(DIAG_TAG, "  Active capture source        : Activity/Broadcast only");
        if (svc != null) {
            Log.d(DIAG_TAG, "  Service debug               : " + svc.getDebugSummary());
        }
        Log.d(DIAG_TAG, "  Activity PTT held           : " + activityPttHeld);
        Log.d(DIAG_TAG, "==========================");

    }

    private String getActiveCaptureSource(boolean a11yEnabled) {
        return "Activity/Broadcast";
    }

    private void updateAccessibilityWarningUi(boolean a11yEnabled) {
        // Accessibility path intentionally disabled.
    }

    private void setupNativeStatusUi() {
        // Accessibility warning banner removed.
    }

    private int dp(int value) {
        float density = getResources().getDisplayMetrics().density;
        return Math.round(value * density);
    }

    private void showAccessibilitySettingsFallbackDialog() {
        try {
            new AlertDialog.Builder(this)
                .setTitle("Accessibility Settings")
                .setMessage("Open Settings > Accessibility > Command Comms PTT")
                .setPositiveButton("OK", null)
                .show();
        } catch (Exception e) {
            Log.w(TAG, "Could not show accessibility fallback dialog: " + e.getMessage());
        }
    }

    private void wakeScreen() {
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null && !pm.isInteractive()) {
                if (screenWakeLock != null && screenWakeLock.isHeld()) {
                    screenWakeLock.release();
                }
                screenWakeLock = pm.newWakeLock(
                    PowerManager.FULL_WAKE_LOCK
                    | PowerManager.ACQUIRE_CAUSES_WAKEUP
                    | PowerManager.ON_AFTER_RELEASE,
                    "CommandComms::ScreenWake"
                );
                screenWakeLock.acquire(10 * 1000L);
                Log.d(TAG, "Screen woken by hardware key");
            }

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
                setShowWhenLocked(true);
                setTurnScreenOn(true);
                KeyguardManager km = (KeyguardManager) getSystemService(Context.KEYGUARD_SERVICE);
                if (km != null) {
                    km.requestDismissKeyguard(this, null);
                }
            } else {
                getWindow().addFlags(
                    WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                    | WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD
                    | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                    | WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                );
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to wake screen: " + e.getMessage());
        }
    }

    private void injectJsKeyEvent(int keyCode, String eventType) {
        WebView webView = this.bridge.getWebView();
        if (webView == null) return;
        String js = "document.dispatchEvent(new KeyboardEvent('" + eventType + "',{keyCode:" + keyCode + ",which:" + keyCode + ",bubbles:true,cancelable:true}));";
        webView.post(new Runnable() {
            @Override
            public void run() {
                webView.evaluateJavascript(js, null);
            }
        });
    }

    private void injectJsKeyEventDelayed(int keyCode, String eventType, long delayMs) {
        WebView webView = this.bridge.getWebView();
        if (webView == null) return;
        String js = "document.dispatchEvent(new KeyboardEvent('" + eventType + "',{keyCode:" + keyCode + ",which:" + keyCode + ",bubbles:true,cancelable:true}));";
        webView.postDelayed(new Runnable() {
            @Override
            public void run() {
                webView.evaluateJavascript(js, null);
            }
        }, delayMs);
    }

    private String getPttStateSummary() {
        BackgroundAudioService svc = BackgroundAudioService.getInstance();
        LiveKitPlugin lk = LiveKitPlugin.getInstance();
        return "STATE_SUMMARY: screen=" + (isScreenOff ? "OFF" : "ON")
            + " service=" + (BackgroundAudioService.isRunning ? "RUNNING" : "STOPPED")
            + " svcInstance=" + (svc != null ? "YES" : "NULL")
            + " livekit=" + (lk != null && lk.isRoomConnected() ? "CONNECTED" : "DISCONNECTED")
            + " lkChannel=" + (lk != null ? lk.getActiveChannel() : "null")
            + " pttState=" + (svc != null ? (svc.isTransmitting() ? "TRANSMITTING" : "IDLE") : "N/A");
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        int    keyCode    = event.getKeyCode();
        int    action     = event.getAction();
        int    repeat     = event.getRepeatCount();
        String actionStr  = (action == KeyEvent.ACTION_DOWN) ? "DOWN" : "UP";

        if (isT320Key(keyCode)) {
            Log.d(DIAG_TAG, "MainActivity.dispatchKeyEvent() — keyCode=" + keyCode
                + " action=" + actionStr
                + " repeat=" + repeat
                + " screenOff=" + isScreenOff);
            Log.d(DIAG_TAG, getPttStateSummary());

            // Keep radio behavior: PTT must transmit in background without forcing UI foreground.
            // Only wake the screen for non-PTT hardware keys (e.g., menu/navigation usage).
            if (action == KeyEvent.ACTION_DOWN && !isPttKey(keyCode)) {
                wakeScreen();
            }
            keepWebViewAlive();
        }

        // --- PTT key handling ---
        if (isPttKey(keyCode)) {
            Log.d(DIAG_TAG, "MainActivity — PTT key=" + keyCode + " action=" + actionStr + " HANDLED_IN_ACTIVITY");

            if (action == KeyEvent.ACTION_DOWN) {
                if (repeat > 0 || activityPttHeld) {
                    Log.d(DIAG_TAG, "MainActivity — PTT DOWN suppressed: repeat=" + repeat + " held=" + activityPttHeld);
                } else {
                    activityPttHeld = true;
                    BackgroundAudioService service = BackgroundAudioService.getInstance();
                    if (service != null) {
                        service.handlePttDown();
                        Log.d(DIAG_TAG, "MainActivity — PTT DOWN forwarded to BackgroundAudioService");
                    } else {
                        Log.w(DIAG_TAG, "MainActivity — BackgroundAudioService NULL, cannot forward PTT DOWN");
                    }
                    HardwarePttPlugin pttPlugin = HardwarePttPlugin.getInstance();
                    if (pttPlugin != null) pttPlugin.handleKeyEvent(event);
                }
            } else if (action == KeyEvent.ACTION_UP) {
                if (!activityPttHeld) {
                    Log.d(DIAG_TAG, "MainActivity — PTT UP suppressed: not held");
                } else {
                    activityPttHeld = false;
                    BackgroundAudioService service = BackgroundAudioService.getInstance();
                    if (service != null) {
                        service.handlePttUp();
                        Log.d(DIAG_TAG, "MainActivity — PTT UP forwarded to BackgroundAudioService");
                    } else {
                        Log.w(DIAG_TAG, "MainActivity — BackgroundAudioService NULL, cannot forward PTT UP");
                    }
                    HardwarePttPlugin pttPlugin = HardwarePttPlugin.getInstance();
                    if (pttPlugin != null) pttPlugin.handleKeyEvent(event);
                }
            }
            return true;
        }

        // --- Side button 1 (black, KEY_F1) ---
        if (isSide1Key(keyCode)) {
            if (action == KeyEvent.ACTION_DOWN && repeat == 0 && !activitySide1Held) {
                activitySide1Held = true;
                BackgroundAudioService svc = BackgroundAudioService.getInstance();
                if (svc != null) svc.handleSideButton1Down();
            } else if (action == KeyEvent.ACTION_UP && activitySide1Held) {
                activitySide1Held = false;
                BackgroundAudioService svc = BackgroundAudioService.getInstance();
                if (svc != null) svc.handleSideButton1Up();
            }
            if (!isScreenOff) injectJsKeyEvent(keyCode, action == KeyEvent.ACTION_DOWN ? "keydown" : "keyup");
            else injectJsKeyEventDelayed(keyCode, action == KeyEvent.ACTION_DOWN ? "keydown" : "keyup", 50);
            return true;
        }

        // --- Side button 2 (orange, KEY_SELECT) ---
        if (isSide2Key(keyCode)) {
            if (action == KeyEvent.ACTION_DOWN && repeat == 0 && !activitySide2Held) {
                activitySide2Held = true;
                BackgroundAudioService svc = BackgroundAudioService.getInstance();
                if (svc != null) svc.handleSideButton2Down();
            } else if (action == KeyEvent.ACTION_UP && activitySide2Held) {
                activitySide2Held = false;
                BackgroundAudioService svc = BackgroundAudioService.getInstance();
                if (svc != null) svc.handleSideButton2Up();
            }
            if (!isScreenOff) injectJsKeyEvent(keyCode, action == KeyEvent.ACTION_DOWN ? "keydown" : "keyup");
            else injectJsKeyEventDelayed(keyCode, action == KeyEvent.ACTION_DOWN ? "keydown" : "keyup", 50);
            return true;
        }

        // --- Other T320 keys — inject into JS only ---
        if (isT320Key(keyCode)) {
            if (isScreenOff) {
                injectJsKeyEventDelayed(keyCode, action == KeyEvent.ACTION_DOWN ? "keydown" : "keyup", 50);
            } else {
                injectJsKeyEvent(keyCode, action == KeyEvent.ACTION_DOWN ? "keydown" : "keyup");
            }
            return true;
        }

        return super.dispatchKeyEvent(event);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (isT320Key(keyCode)) {
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    public boolean onKeyUp(int keyCode, KeyEvent event) {
        if (isT320Key(keyCode)) {
            return true;
        }
        return super.onKeyUp(keyCode, event);
    }

    @Override
    public void onPause() {
        super.onPause();
        isScreenOff = true;
        Log.d(DIAG_TAG, "MainActivity.onPause() — isScreenOff=true, service running=" + BackgroundAudioService.isRunning);
        keepWebViewAlive();
        startJsKeepalive();
    }

    @Override
    public void onResume() {
        super.onResume();
        isScreenOff = false;
        stopJsKeepalive();
        Log.d(DIAG_TAG, "MainActivity.onResume() — screen ON, isScreenOff=false");

        startBackgroundAudioServiceNow();
        logResumeDiagnostics();

        if (!batteryExemptionPrompted) {
            new Handler(Looper.getMainLooper()).postDelayed(() -> {
                requestBatteryOptimizationExemption();
                batteryExemptionPrompted = true;
            }, 1500);
        }
    }

    @Override
    public void onStop() {
        super.onStop();
        isScreenOff = true;
        Log.d(DIAG_TAG, "MainActivity.onStop() — isScreenOff=true, service running=" + BackgroundAudioService.isRunning);
        keepWebViewAlive();
    }

    private void keepWebViewAlive() {
        try {
            WebView webView = this.bridge.getWebView();
            if (webView != null) {
                webView.onResume();
                webView.resumeTimers();
                webView.dispatchWindowVisibilityChanged(android.view.View.VISIBLE);
                webView.post(new Runnable() {
                    @Override
                    public void run() {
                        webView.evaluateJavascript("1", null);
                    }
                });
                Log.d(TAG, "WebView kept alive after lifecycle pause");
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to keep WebView alive: " + e.getMessage());
        }
    }

    @Override
    public void onDestroy() {
        stopJsKeepalive();
        if (screenWakeLock != null && screenWakeLock.isHeld()) {
            screenWakeLock.release();
        }
        super.onDestroy();
    }
}
