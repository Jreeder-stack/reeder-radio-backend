package com.reedersystems.commandcomms;

import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.PowerManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Capacitor plugin to control background service and wake locks.
 * 
 * This plugin allows JavaScript to:
 * - Start/stop the foreground service for background audio
 * - Acquire/release wake locks to prevent CPU sleep during PTT
 * 
 * Installation:
 * 1. Copy to android/app/src/main/java/com/reedersystems/commandcomms/
 * 2. Register in MainActivity.java (see README.md)
 * 
 * JavaScript usage:
 *   import { Plugins } from '@capacitor/core';
 *   const { BackgroundService } = Plugins;
 *   
 *   await BackgroundService.startService();
 *   await BackgroundService.stopService();
 *   await BackgroundService.acquireWakeLock();
 *   await BackgroundService.releaseWakeLock();
 */
@CapacitorPlugin(name = "BackgroundService")
public class BackgroundServicePlugin extends Plugin {

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
                wakeLock.acquire(10 * 60 * 1000L); // 10 minutes max
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
}
