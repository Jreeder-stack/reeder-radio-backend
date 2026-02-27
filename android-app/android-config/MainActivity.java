package com.reedersystems.commandcomms;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.KeyEvent;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;

/**
 * Main activity for COMMAND COMMS Android app.
 * 
 * Replace the auto-generated MainActivity.java with this file.
 * Location: android/app/src/main/java/com/reedersystems/commandcomms/MainActivity.java
 */
public class MainActivity extends BridgeActivity {
    
    private static final String TAG = "CommandComms";
    private static final int PERMISSION_REQUEST_CODE = 1001;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register custom Capacitor plugins
        registerPlugin(HardwarePttPlugin.class);
        registerPlugin(DndOverridePlugin.class);
        registerPlugin(LiveKitPlugin.class);
        
        super.onCreate(savedInstanceState);
        
        // Request microphone permission at runtime BEFORE WebView needs it
        requestAudioPermissions();
        
        // Configure WebView settings for WebRTC/LiveKit
        configureWebViewForWebRTC();
    }
    
    private void requestAudioPermissions() {
        String[] permissions = {
            Manifest.permission.RECORD_AUDIO,
            Manifest.permission.MODIFY_AUDIO_SETTINGS
        };
        
        boolean needsPermission = false;
        for (String permission : permissions) {
            if (ContextCompat.checkSelfPermission(this, permission) != PackageManager.PERMISSION_GRANTED) {
                needsPermission = true;
                break;
            }
        }
        
        if (needsPermission) {
            Log.d(TAG, "Requesting audio permissions...");
            ActivityCompat.requestPermissions(this, permissions, PERMISSION_REQUEST_CODE);
        } else {
            Log.d(TAG, "Audio permissions already granted");
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

    private boolean isT320Key(int keyCode) {
        return keyCode == KEY_PTT || keyCode == KEY_ACC || keyCode == KEY_EMERGENCY
            || keyCode == KEY_DPAD_UP || keyCode == KEY_DPAD_DOWN
            || keyCode == KEY_DPAD_LEFT || keyCode == KEY_DPAD_RIGHT
            || keyCode == KEY_STAR;
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
}
