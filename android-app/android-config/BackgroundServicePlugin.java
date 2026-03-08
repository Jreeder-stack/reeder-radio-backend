package com.reedersystems.commandcomms;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.PowerManager;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "BackgroundService")
public class BackgroundServicePlugin extends Plugin {

    private static final String TAG = "PTT-DIAG";
    private static final String PREFS_NAME = "CommandCommsServicePrefs";
    private PowerManager.WakeLock wakeLock;
    private static final String WAKE_LOCK_TAG = "CommandComms::PTTWakeLock";

    @PluginMethod
    public void startService(PluginCall call) {
        Context context = getContext();
        Intent serviceIntent = new Intent(context, BackgroundAudioService.class);
        
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(serviceIntent);
            } else {
                context.startService(serviceIntent);
            }
            
            JSObject ret = new JSObject();
            ret.put("success", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Failed to start background service: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stopService(PluginCall call) {
        Context context = getContext();
        Intent serviceIntent = new Intent(context, BackgroundAudioService.class);
        serviceIntent.setAction("STOP");
        
        try {
            context.startService(serviceIntent);
            
            JSObject ret = new JSObject();
            ret.put("success", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Failed to stop background service: " + e.getMessage());
        }
    }

    @PluginMethod
    public void acquireWakeLock(PluginCall call) {
        try {
            if (wakeLock == null) {
                PowerManager powerManager = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
                wakeLock = powerManager.newWakeLock(
                    PowerManager.PARTIAL_WAKE_LOCK,
                    WAKE_LOCK_TAG
                );
            }
            
            if (!wakeLock.isHeld()) {
                wakeLock.acquire(10 * 60 * 1000L);
            }
            
            JSObject ret = new JSObject();
            ret.put("success", true);
            ret.put("held", wakeLock.isHeld());
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Failed to acquire wake lock: " + e.getMessage());
        }
    }

    @PluginMethod
    public void releaseWakeLock(PluginCall call) {
        try {
            if (wakeLock != null && wakeLock.isHeld()) {
                wakeLock.release();
            }
            
            JSObject ret = new JSObject();
            ret.put("success", true);
            ret.put("held", wakeLock != null && wakeLock.isHeld());
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Failed to release wake lock: " + e.getMessage());
        }
    }

    @PluginMethod
    public void isServiceRunning(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("running", BackgroundAudioService.isRunning);
        call.resolve(ret);
    }

    @PluginMethod
    public void updateConnectionInfo(PluginCall call) {
        String serverBaseUrl = call.getString("serverBaseUrl");
        String unitId = call.getString("unitId");
        String channelId = call.getString("channelId");
        String livekitUrl = call.getString("livekitUrl");
        String channelName = call.getString("channelName");

        Log.d(TAG, "updateConnectionInfo() — serverUrl=" + serverBaseUrl + " unit=" + unitId
            + " channel=" + channelId + " lkUrl=" + livekitUrl + " channelName=" + channelName);

        SharedPreferences prefs = getContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        SharedPreferences.Editor editor = prefs.edit();
        if (serverBaseUrl != null) editor.putString("server_base_url", serverBaseUrl);
        if (unitId != null) editor.putString("unit_id", unitId);
        if (channelId != null) editor.putString("channel_id", channelId);
        if (livekitUrl != null) editor.putString("livekit_url", livekitUrl);
        if (channelName != null) editor.putString("channel_name", channelName);
        editor.apply();
        Log.d(TAG, "updateConnectionInfo() — persisted to SharedPreferences");

        BackgroundAudioService service = BackgroundAudioService.getInstance();
        if (service != null) {
            service.setConnectionInfo(serverBaseUrl, unitId, channelId);
            if (livekitUrl != null && channelName != null) {
                service.setLiveKitInfo(livekitUrl, channelName);
            }
        } else {
            Log.d(TAG, "updateConnectionInfo() — service not running, info saved to prefs only");
        }

        JSObject ret = new JSObject();
        ret.put("success", true);
        call.resolve(ret);
    }
}
