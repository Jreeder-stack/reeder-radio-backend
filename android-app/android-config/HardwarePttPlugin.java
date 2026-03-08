package com.reedersystems.commandcomms;

import android.view.KeyEvent;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.JSObject;
import android.util.Log;

@CapacitorPlugin(name = "HardwarePtt")
public class HardwarePttPlugin extends Plugin {

    private static final String TAG = "PTT-DIAG";
    private static HardwarePttPlugin instance;
    private int pttKeyCode = 230;
    private boolean isPttPressed = false;

    @Override
    public void load() {
        instance = this;
        super.load();
        Log.d(TAG, "HardwarePttPlugin loaded (instance set)");
    }

    public static HardwarePttPlugin getInstance() {
        return instance;
    }

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

    @PluginMethod
    public void getPttKeyCode(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("keyCode", pttKeyCode);
        call.resolve(ret);
    }

    @PluginMethod
    public void isPttPressed(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("pressed", isPttPressed);
        call.resolve(ret);
    }

    public boolean handleKeyEvent(KeyEvent event) {
        if (event.getKeyCode() != pttKeyCode) {
            return false;
        }

        int action = event.getAction();
        Log.d(TAG, "HardwarePttPlugin.handleKeyEvent() — keyCode=" + event.getKeyCode()
            + " action=" + (action == KeyEvent.ACTION_DOWN ? "DOWN" : "UP")
            + " isPttPressed=" + isPttPressed);

        if (action == KeyEvent.ACTION_DOWN && !isPttPressed) {
            isPttPressed = true;

            BackgroundAudioService service = BackgroundAudioService.getInstance();
            if (service != null) {
                Log.d(TAG, "HardwarePttPlugin — forwarding DOWN to BackgroundAudioService");
                service.handlePttDown();
            } else {
                Log.d(TAG, "HardwarePttPlugin — BackgroundAudioService not available, notifying JS only");
            }

            notifyPttStateToJs(true);
            return true;
        } else if (action == KeyEvent.ACTION_UP && isPttPressed) {
            isPttPressed = false;

            BackgroundAudioService service = BackgroundAudioService.getInstance();
            if (service != null) {
                Log.d(TAG, "HardwarePttPlugin — forwarding UP to BackgroundAudioService");
                service.handlePttUp();
            } else {
                Log.d(TAG, "HardwarePttPlugin — BackgroundAudioService not available, notifying JS only");
            }

            notifyPttStateToJs(false);
            return true;
        }

        return true;
    }

    public void notifyPttStateFromService(boolean pressed) {
        isPttPressed = pressed;
        Log.d(TAG, "HardwarePttPlugin.notifyPttStateFromService(" + pressed + ") — syncing UI");
        notifyPttStateToJs(pressed);
    }

    private void notifyPttStateToJs(boolean pressed) {
        try {
            JSObject data = new JSObject();
            data.put("pressed", pressed);
            data.put("keyCode", pttKeyCode);

            if (getActivity() != null) {
                getActivity().runOnUiThread(() -> {
                    try {
                        notifyListeners(pressed ? "pttDown" : "pttUp", data);
                        Log.d(TAG, "HardwarePttPlugin — JS notified: " + (pressed ? "pttDown" : "pttUp"));
                    } catch (Exception e) {
                        Log.d(TAG, "HardwarePttPlugin — JS notify failed (non-blocking): " + e.getMessage());
                    }
                });
            } else {
                Log.d(TAG, "HardwarePttPlugin — no Activity, JS notify skipped");
            }
        } catch (Exception e) {
            Log.d(TAG, "HardwarePttPlugin — notifyPttStateToJs failed (non-blocking): " + e.getMessage());
        }
    }
}
