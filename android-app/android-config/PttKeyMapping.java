package com.reedersystems.commandcomms;

import android.view.KeyEvent;

public final class PttKeyMapping {
    public static final int KEYCODE_PTT_PRIMARY = KeyEvent.KEYCODE_F11; // 141
    public static final int KEYCODE_PTT_FALLBACK = 230;

    private PttKeyMapping() {}

    public static boolean isPttKey(int keyCode) {
        return keyCode == KEYCODE_PTT_PRIMARY || keyCode == KEYCODE_PTT_FALLBACK;
    }
}
