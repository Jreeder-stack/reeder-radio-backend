package com.reedersystems.commandcomms;

import android.view.KeyEvent;
import android.webkit.WebView;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.JSObject;

/**
 * Capacitor plugin for hardware PTT key capture.
 * 
 * This plugin allows the web app to receive hardware key events from:
 * - Volume buttons
 * - Bluetooth PTT accessories  
 * - Media buttons on headsets
 * 
 * Installation:
 * 1. Copy this file to android/app/src/main/java/com/reedersystems/commandcomms/
 * 2. Register plugin in MainActivity.java
 * 3. Configure key codes in app settings
 */
@CapacitorPlugin(name = "HardwarePtt")
public class HardwarePttPlugin extends Plugin {

    private static HardwarePttPlugin instance;
    private int pttKeyCode = 230; // Inrico T320 PTT button = keycode 230
    private boolean isPttPressed = false;

    @Override
    public void load() {
        instance = this;
        super.load();
    }

    public static HardwarePttPlugin getInstance() {
        return instance;
    }

    /**
     * Set the key code to use for PTT
     * Called from JavaScript when user configures PTT key in settings
     */
    @PluginMethod
    public void setPttKeyCode(PluginCall call) {
        Integer keyCode = call.getInt("keyCode");
        if (keyCode != null) {
            pttKeyCode = keyCode;
            JSObject ret = new JSObject();
            ret.put("success", true);
            ret.put("keyCode", keyCode);
            call.resolve(ret);
        } else {
            call.reject("Missing keyCode parameter");
        }
    }

    /**
     * Get current PTT key code
     */
    @PluginMethod
    public void getPttKeyCode(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("keyCode", pttKeyCode);
        call.resolve(ret);
    }

    /**
     * Check if PTT is currently pressed
     */
    @PluginMethod
    public void isPttPressed(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("pressed", isPttPressed);
        call.resolve(ret);
    }

    /**
     * Called from MainActivity when a key event occurs
     * Returns true if the key was handled (is PTT key)
     */
    public boolean handleKeyEvent(KeyEvent event) {
        if (event.getKeyCode() != pttKeyCode) {
            return false;
        }

        int action = event.getAction();
        
        if (action == KeyEvent.ACTION_DOWN && !isPttPressed) {
            isPttPressed = true;
            notifyPttState(true);
            return true;
        } else if (action == KeyEvent.ACTION_UP && isPttPressed) {
            isPttPressed = false;
            notifyPttState(false);
            return true;
        }
        
        return true; // Consume the event even if no state change
    }

    /**
     * Notify the web app of PTT state change
     */
    private void notifyPttState(boolean pressed) {
        JSObject data = new JSObject();
        data.put("pressed", pressed);
        data.put("keyCode", pttKeyCode);

        if (getActivity() != null) {
            getActivity().runOnUiThread(() -> {
                notifyListeners(pressed ? "pttDown" : "pttUp", data);
            });
        } else {
            notifyListeners(pressed ? "pttDown" : "pttUp", data);
        }
    }
}
