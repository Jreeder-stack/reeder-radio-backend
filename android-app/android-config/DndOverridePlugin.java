package com.reedersystems.commandcomms;

import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.provider.Settings;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.JSObject;

/**
 * Capacitor plugin for Do Not Disturb override functionality.
 * 
 * This plugin allows the app to:
 * 1. Check if notification policy access is granted
 * 2. Open system settings to request permission
 * 3. Configure priority notifications that bypass DND
 * 
 * Installation:
 * 1. Copy to android/app/src/main/java/com/reedersystems/commandcomms/
 * 2. Register plugin in MainActivity.java: registerPlugin(DndOverridePlugin.class);
 * 3. Add permission to AndroidManifest.xml:
 *    <uses-permission android:name="android.permission.ACCESS_NOTIFICATION_POLICY" />
 */
@CapacitorPlugin(name = "DndOverride")
public class DndOverridePlugin extends Plugin {

    /**
     * Check if notification policy access is granted
     */
    @PluginMethod
    public void isGranted(PluginCall call) {
        Context context = getContext();
        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        
        boolean granted = false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            granted = nm.isNotificationPolicyAccessGranted();
        } else {
            // Pre-Marshmallow, DND override is not available
            granted = true;
        }
        
        JSObject ret = new JSObject();
        ret.put("granted", granted);
        call.resolve(ret);
    }

    /**
     * Open system settings to request notification policy access
     */
    @PluginMethod
    public void requestPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            Context context = getContext();
            NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            
            if (!nm.isNotificationPolicyAccessGranted()) {
                Intent intent = new Intent(Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS);
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(intent);
            }
        }
        
        JSObject ret = new JSObject();
        ret.put("success", true);
        call.resolve(ret);
    }

    /**
     * Set DND filter to priority mode temporarily
     * Only call this when actually needing to override DND for an alert
     */
    @PluginMethod
    public void activatePriorityMode(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            Context context = getContext();
            NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            
            if (nm.isNotificationPolicyAccessGranted()) {
                // Remember current filter to restore later
                int currentFilter = nm.getCurrentInterruptionFilter();
                
                // Set to priority mode
                nm.setInterruptionFilter(NotificationManager.INTERRUPTION_FILTER_PRIORITY);
                
                JSObject ret = new JSObject();
                ret.put("success", true);
                ret.put("previousFilter", currentFilter);
                call.resolve(ret);
                return;
            }
        }
        
        JSObject ret = new JSObject();
        ret.put("success", false);
        ret.put("error", "Permission not granted");
        call.resolve(ret);
    }

    /**
     * Restore DND filter to previous state
     */
    @PluginMethod
    public void restoreFilter(PluginCall call) {
        Integer filter = call.getInt("filter");
        
        if (filter != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            Context context = getContext();
            NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            
            if (nm.isNotificationPolicyAccessGranted()) {
                nm.setInterruptionFilter(filter);
            }
        }
        
        JSObject ret = new JSObject();
        ret.put("success", true);
        call.resolve(ret);
    }
}
