package com.reedersystems.commandcomms;

import android.Manifest;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.util.Log;
import android.view.KeyEvent;
import android.view.WindowManager;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;
import java.util.ArrayList;
import java.util.List;

public class MainActivity extends BridgeActivity {
    
    private static final String TAG = "CommandComms";
    private static final int PERMISSION_REQUEST_CODE = 1001;
    private static final int BACKGROUND_LOCATION_REQUEST_CODE = 1002;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(HardwarePttPlugin.class);
        registerPlugin(DndOverridePlugin.class);
        registerPlugin(LiveKitPlugin.class);
        registerPlugin(BackgroundServicePlugin.class);
        
        super.onCreate(savedInstanceState);
        
        requestAllPermissions();
        
        configureWebViewForWebRTC();
    }
    
    private void requestAllPermissions() {
        List<String> permissionsNeeded = new ArrayList<>();

        String[] basePermissions = {
            Manifest.permission.RECORD_AUDIO,
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
            requestBackgroundLocationIfNeeded();
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
            requestBackgroundLocationIfNeeded();
        } else if (requestCode == BACKGROUND_LOCATION_REQUEST_CODE) {
            boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            Log.d(TAG, "Background location permission granted: " + granted);
        }
    }
    
    private void configureWebViewForWebRTC() {
        WebView webView = this.bridge.getWebView();
        WebSettings settings = webView.getSettings();
        
        // CRITICAL: Allow media playback without user gesture (required for LiveKit audio)
        settings.setMediaPlaybackRequiresUserGesture(false);
        
        // Enable JavaScript and DOM storage (should already be enabled by Capacitor, but explicit)
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        
        // Allow mixed content (http in https) if needed
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }
        
        Log.d(TAG, "WebView configured for WebRTC: mediaPlaybackRequiresUserGesture=false");
        
        // Configure WebChromeClient to grant WebRTC permissions
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                Log.d(TAG, "WebView permission request received");
                // Grant audio and video capture permissions for WebRTC
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
                    // If not audio/video, deny the request
                    Log.d(TAG, "Denying non-audio/video permission request");
                    request.deny();
                });
            }
        });
    }

    private static final int KEY_PTT = 230;
    private static final int KEY_ACC = 231;
    private static final int KEY_EMERGENCY = 233;
    private static final int KEY_DPAD_UP = 19;
    private static final int KEY_DPAD_DOWN = 20;
    private static final int KEY_DPAD_LEFT = 21;
    private static final int KEY_DPAD_RIGHT = 22;
    private static final int KEY_STAR = 17;

    private PowerManager.WakeLock screenWakeLock;

    private boolean isT320Key(int keyCode) {
        return keyCode == KEY_PTT || keyCode == KEY_ACC || keyCode == KEY_EMERGENCY
            || keyCode == KEY_DPAD_UP || keyCode == KEY_DPAD_DOWN
            || keyCode == KEY_DPAD_LEFT || keyCode == KEY_DPAD_RIGHT
            || keyCode == KEY_STAR;
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

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        int keyCode = event.getKeyCode();
        int action = event.getAction();

        if (isT320Key(keyCode) && action == KeyEvent.ACTION_DOWN) {
            wakeScreen();
        }

        HardwarePttPlugin pttPlugin = HardwarePttPlugin.getInstance();
        if (pttPlugin != null && keyCode == KEY_PTT) {
            pttPlugin.handleKeyEvent(event);
        }

        if (isT320Key(keyCode)) {
            if (action == KeyEvent.ACTION_DOWN) {
                injectJsKeyEvent(keyCode, "keydown");
            } else if (action == KeyEvent.ACTION_UP) {
                injectJsKeyEvent(keyCode, "keyup");
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
    protected void onDestroy() {
        if (screenWakeLock != null && screenWakeLock.isHeld()) {
            screenWakeLock.release();
        }
        super.onDestroy();
    }
}
