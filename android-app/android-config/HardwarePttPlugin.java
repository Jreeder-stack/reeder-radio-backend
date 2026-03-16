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
    private int pttKeyCode = PttKeyMapping.KEYCODE_PTT_PRIMARY;
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
        int triggeredKeyCode = event.getKeyCode();
        if (triggeredKeyCode != pttKeyCode && !PttKeyMapping.isPttKey(triggeredKeyCode)) {
            return false;
        }

        int action = event.getAction();
        Log.d(TAG, "HardwarePttPlugin.handleKeyEvent() — keyCode=" + triggeredKeyCode
            + " action=" + (action == KeyEvent.ACTION_DOWN ? "DOWN" : "UP")
            + " isPttPressed=" + isPttPressed);

        if (action == KeyEvent.ACTION_DOWN && !isPttPressed) {
            isPttPressed = true;

            BackgroundAudioService service = BackgroundAudioService.getInstance();
            if (service != null) {
                Log.d(TAG, "HardwarePttPlugin — forwarding DOWN to BackgroundAudioService (triggerKeyCode=" + triggeredKeyCode + ")");
                service.handlePttDown();
            } else {
                Log.d(TAG, "HardwarePttPlugin — BackgroundAudioService not available, notifying JS only (triggerKeyCode=" + triggeredKeyCode + ")");
            }

            notifyPttStateToJs(true, triggeredKeyCode);
            return true;
        } else if (action == KeyEvent.ACTION_UP && isPttPressed) {
            isPttPressed = false;

            BackgroundAudioService service = BackgroundAudioService.getInstance();
            if (service != null) {
                Log.d(TAG, "HardwarePttPlugin — forwarding UP to BackgroundAudioService (triggerKeyCode=" + triggeredKeyCode + ")");
                service.handlePttUp();
            } else {
                Log.d(TAG, "HardwarePttPlugin — BackgroundAudioService not available, notifying JS only (triggerKeyCode=" + triggeredKeyCode + ")");
            }

            notifyPttStateToJs(false, triggeredKeyCode);
            return true;
        }

        return true;
    }

    public void notifyPttStateFromService(boolean pressed) {
        isPttPressed = pressed;
        Log.d(TAG, "HardwarePttPlugin.notifyPttStateFromService(" + pressed + ") — syncing UI");
        notifyPttStateToJs(pressed, pttKeyCode);
    }

    public void notifySideButton1FromService(boolean pressed) {
        Log.d(TAG, "HardwarePttPlugin.notifySideButton1FromService(" + pressed + ")");
        notifyButtonEventToJs(pressed ? "sideButton1Down" : "sideButton1Up");
    }

    public void notifySideButton2FromService(boolean pressed) {
        Log.d(TAG, "HardwarePttPlugin.notifySideButton2FromService(" + pressed + ")");
        notifyButtonEventToJs(pressed ? "sideButton2Down" : "sideButton2Up");
    }

    private void notifyButtonEventToJs(String eventName) {
        try {
            JSObject data = new JSObject();
            data.put("event", eventName);
            if (getActivity() != null) {
                getActivity().runOnUiThread(() -> {
                    try {
                        notifyListeners(eventName, data);
                        Log.d(TAG, "HardwarePttPlugin — JS notified: " + eventName);
                    } catch (Exception e) {
                        Log.d(TAG, "HardwarePttPlugin — JS notify failed (non-blocking): " + e.getMessage());
                    }
                });
            } else {
                Log.d(TAG, "HardwarePttPlugin — no Activity, JS notify skipped for: " + eventName);
            }
        } catch (Exception e) {
            Log.d(TAG, "HardwarePttPlugin — notifyButtonEventToJs failed (non-blocking): " + e.getMessage());
        }
    }

    private void notifyPttStateToJs(boolean pressed, int triggerKeyCode) {
        try {
            JSObject data = new JSObject();
            data.put("pressed", pressed);
            data.put("keyCode", pttKeyCode);
            data.put("triggerKeyCode", triggerKeyCode);

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
