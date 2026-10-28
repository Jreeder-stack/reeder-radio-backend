package com.reedersystems.commandcomms.hd760keytest;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.util.TypedValue;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.text.SimpleDateFormat;
import java.util.ArrayDeque;
import java.util.Date;
import java.util.Locale;

/**
 * Read-only hardware discovery tool, NOT a PoC communications client.
 * It makes no network connections and never transmits microphone audio.
 */
public final class MainActivity extends Activity {
    private static final String TAG = "CC-HD760";
    private static final int MAX_EVENTS = 24;

    // Published Zello hardware integration action names, plus generic Android
    // PTT conventions. These are candidates, NOT confirmed HD760 broadcasts.
    private static final String[] BROADCAST_ACTIONS = {
        "com.zello.ptt.down", "com.zello.ptt.up",
        "com.zello.intent.buttonExtra1.down", "com.zello.intent.buttonExtra1.up",
        "com.zello.intent.buttonSOS.down", "com.zello.intent.buttonSOS.up",
        "com.zello.intent.channelUp", "com.zello.intent.channelDown",
        "com.zello.intent.setChannel",
        "android.intent.action.PTT",
        "android.intent.action.PTT.down", "android.intent.action.PTT.up",
        "android.intent.action.PTT_DOWN", "android.intent.action.PTT_UP",
        "android.intent.action.PTT_KEY_DOWN", "android.intent.action.PTT_KEY_UP",
        "android.intent.action.CHANNEL.prev", "android.intent.action.CHANNEL.next"
    };

    private final ArrayDeque<String> eventHistory = new ArrayDeque<>();
    private TextView eventsText;
    private TextView deviceText;
    private BroadcastReceiver buttonReceiver;
    private boolean receiverRegistered;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LOW_PROFILE);
        getWindow().setStatusBarColor(Color.rgb(15, 23, 42));
        buildScreen();
        String identity = "Manufacturer: " + Build.MANUFACTURER
                + "\nModel: " + Build.MODEL + "  Device: " + Build.DEVICE
                + "\nAndroid: " + Build.VERSION.RELEASE
                + "  API: " + Build.VERSION.SDK_INT;
        deviceText.setText(identity);
        record("BOOT " + identity.replace('\n', ' '));
        record("Test each button DOWN and UP, then rotate channel knob both ways.");
        record("Diagnostic only: NO radio TX; no account or microphone used.");

        buttonReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (intent == null) return;
                Bundle extras = intent.getExtras();
                String extraDescription = extras == null ? "(none)" : extras.keySet().toString();
                record("BROADCAST action=" + intent.getAction()
                        + " extras.keys=" + extraDescription);
                if (extras != null) {
                    for (String key : extras.keySet()) {
                        Object value = extras.get(key);
                        record("EXTRA " + key + "=" + String.valueOf(value));
                    }
                }
            }
        };
    }

    private void buildScreen() {
        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setPadding(8, 7, 8, 7);
        column.setBackgroundColor(Color.rgb(15, 23, 42));

        TextView title = text("CC HD760 KEY TEST", 15, Color.rgb(125, 211, 252));
        column.addView(title);
        TextView warning = text("DIAGNOSTICS ONLY • NO TRANSMIT", 10, Color.rgb(253, 186, 116));
        column.addView(warning);
        deviceText = text("", 10, Color.WHITE);
        column.addView(deviceText);

        TextView label = text("BUTTON / KNOB EVENTS:", 11, Color.rgb(134, 239, 172));
        label.setPadding(0, 6, 0, 2);
        column.addView(label);

        ScrollView scroll = new ScrollView(this);
        eventsText = text("Listening...", 10, Color.WHITE);
        eventsText.setTextIsSelectable(false);
        scroll.addView(eventsText);
        column.addView(scroll, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));
        setContentView(column);
    }

    private TextView text(String value, int sp, int color) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        view.setTextColor(color);
        return view;
    }

    private void record(String line) {
        Log.i(TAG, line);
        String time = new SimpleDateFormat("HH:mm:ss.SSS", Locale.US).format(new Date());
        eventHistory.addFirst(time + " " + line);
        while (eventHistory.size() > MAX_EVENTS) eventHistory.removeLast();
        if (eventsText == null) return;
        StringBuilder out = new StringBuilder();
        for (String event : eventHistory) out.append(event).append("\n\n");
        eventsText.setText(out.toString());
    }

    @Override
    protected void onStart() {
        super.onStart();
        if (!receiverRegistered) {
            IntentFilter filter = new IntentFilter();
            for (String action : BROADCAST_ACTIONS) filter.addAction(action);
            registerReceiver(buttonReceiver, filter);
            receiverRegistered = true;
            record("Listening for documented/generic PTT and channel broadcasts.");
        }
    }

    @Override
    protected void onStop() {
        if (receiverRegistered) {
            unregisterReceiver(buttonReceiver);
            receiverRegistered = false;
        }
        super.onStop();
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (event.getAction() == KeyEvent.ACTION_DOWN
                || event.getAction() == KeyEvent.ACTION_UP) {
            InputDevice input = event.getDevice();
            String deviceName = input == null ? "unknown" : input.getName();
            record("KEY " + (event.getAction() == KeyEvent.ACTION_DOWN ? "DOWN" : "UP")
                    + " code=" + event.getKeyCode()
                    + " (" + KeyEvent.keyCodeToString(event.getKeyCode()) + ")"
                    + " scan=" + event.getScanCode()
                    + " repeats=" + event.getRepeatCount()
                    + " source=0x" + Integer.toHexString(event.getSource())
                    + " input=" + deviceName);
        }
        // Keep navigation and volume behavior available for a non-touch radio.
        return super.dispatchKeyEvent(event);
    }
}
