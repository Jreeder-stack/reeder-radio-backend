package com.reedersystems.commandcomms;

import android.util.Log;

import org.json.JSONObject;

import java.net.URISyntaxException;

import io.socket.client.IO;
import io.socket.client.Socket;
import io.socket.emitter.Emitter;

/**
 * SignalingConnection — thin Socket.IO wrapper for BackgroundAudioService.
 *
 * Mirrors the authentication + channel-join pattern from the web-layer
 * SignalingManager.js so the native service receives real-time ptt:start /
 * ptt:end events and can pre-connect to LiveKit before the first audio frame.
 *
 * Usage:
 *   conn = new SignalingConnection(serverUrl, unitId, username, channelId,
 *                                   pttStartListener, pttEndListener);
 *   conn.connect();
 *   // later:
 *   conn.joinChannel(newChannelId);      // after channel change
 *   conn.leaveChannel(oldChannelId);
 *   conn.destroy();                      // in onDestroy
 */
public class SignalingConnection {

    public interface PttStartListener {
        void onPttStart(String unitId, String channelId);
    }

    public interface PttEndListener {
        void onPttEnd(String unitId, String channelId);
    }

    private static final String TAG        = "CommandComms.Signaling";
    private static final String DIAG_TAG   = "PTT-DIAG";
    private static final String SOCKET_PATH = "/signaling";

    private final String serverUrl;
    private final String unitId;
    private final String username;
    private String       currentChannelId;

    private final PttStartListener pttStartListener;
    private final PttEndListener   pttEndListener;

    private Socket socket;
    private volatile boolean authenticated = false;
    private volatile boolean destroyed     = false;

    public SignalingConnection(
            String serverUrl,
            String unitId,
            String username,
            String channelId,
            PttStartListener pttStartListener,
            PttEndListener   pttEndListener) {

        this.serverUrl       = serverUrl;
        this.unitId          = unitId;
        this.username        = username;
        this.currentChannelId = channelId;
        this.pttStartListener = pttStartListener;
        this.pttEndListener   = pttEndListener;
    }

    public void connect() {
        if (destroyed) return;

        try {
            IO.Options opts = new IO.Options();
            opts.path                = SOCKET_PATH;
            opts.reconnection        = true;
            opts.reconnectionAttempts = Integer.MAX_VALUE;
            opts.reconnectionDelay   = 1000;
            opts.reconnectionDelayMax = 5000;
            opts.transports          = new String[]{"websocket", "polling"};

            socket = IO.socket(serverUrl, opts);

            socket.on(Socket.EVENT_CONNECT, new Emitter.Listener() {
                @Override
                public void call(Object... args) {
                    Log.d(DIAG_TAG, "[Signaling] Connected to " + serverUrl);
                    authenticated = false;
                    sendAuthenticate();
                }
            });

            socket.on(Socket.EVENT_DISCONNECT, new Emitter.Listener() {
                @Override
                public void call(Object... args) {
                    String reason = args.length > 0 ? String.valueOf(args[0]) : "unknown";
                    Log.d(DIAG_TAG, "[Signaling] Disconnected: " + reason);
                    authenticated = false;
                }
            });

            socket.on(Socket.EVENT_CONNECT_ERROR, new Emitter.Listener() {
                @Override
                public void call(Object... args) {
                    String err = args.length > 0 ? String.valueOf(args[0]) : "unknown";
                    Log.w(DIAG_TAG, "[Signaling] Connection error: " + err);
                }
            });

            socket.on("authenticated", new Emitter.Listener() {
                @Override
                public void call(Object... args) {
                    Log.d(DIAG_TAG, "[Signaling] Authenticated as " + unitId);
                    authenticated = true;
                    if (currentChannelId != null) {
                        sendChannelJoin(currentChannelId);
                    }
                }
            });

            socket.on("ptt:start", new Emitter.Listener() {
                @Override
                public void call(Object... args) {
                    if (args.length == 0) return;
                    try {
                        JSONObject data = (JSONObject) args[0];
                        String fromUnit  = data.optString("unitId",   "");
                        String channelId = data.optString("channelId", "");
                        Log.d(DIAG_TAG, "[Signaling] ptt:start from=" + fromUnit + " channel=" + channelId);
                        if (pttStartListener != null) {
                            pttStartListener.onPttStart(fromUnit, channelId);
                        }
                    } catch (Exception e) {
                        Log.w(DIAG_TAG, "[Signaling] ptt:start parse error: " + e.getMessage());
                    }
                }
            });

            socket.on("ptt:end", new Emitter.Listener() {
                @Override
                public void call(Object... args) {
                    if (args.length == 0) return;
                    try {
                        JSONObject data = (JSONObject) args[0];
                        String fromUnit  = data.optString("unitId",   "");
                        String channelId = data.optString("channelId", "");
                        Log.d(DIAG_TAG, "[Signaling] ptt:end from=" + fromUnit + " channel=" + channelId);
                        if (pttEndListener != null) {
                            pttEndListener.onPttEnd(fromUnit, channelId);
                        }
                    } catch (Exception e) {
                        Log.w(DIAG_TAG, "[Signaling] ptt:end parse error: " + e.getMessage());
                    }
                }
            });

            socket.connect();
            Log.d(DIAG_TAG, "[Signaling] Socket.IO connecting to " + serverUrl);

        } catch (URISyntaxException e) {
            Log.e(DIAG_TAG, "[Signaling] Invalid server URL: " + serverUrl + " — " + e.getMessage());
        }
    }

    private void sendAuthenticate() {
        if (socket == null || !socket.connected()) return;
        try {
            JSONObject payload = new JSONObject();
            payload.put("unitId",       unitId);
            payload.put("username",     username != null ? username : unitId);
            payload.put("agencyId",     "default");
            payload.put("isDispatcher", false);
            socket.emit("authenticate", payload);
            Log.d(DIAG_TAG, "[Signaling] authenticate sent for unitId=" + unitId);
        } catch (Exception e) {
            Log.w(DIAG_TAG, "[Signaling] authenticate emit failed: " + e.getMessage());
        }
    }

    public void joinChannel(String channelId) {
        currentChannelId = channelId;
        if (authenticated && socket != null && socket.connected()) {
            sendChannelJoin(channelId);
        }
    }

    public void leaveChannel(String channelId) {
        if (socket == null || !socket.connected()) return;
        try {
            JSONObject payload = new JSONObject();
            payload.put("channelId", channelId);
            socket.emit("channel:leave", payload);
            Log.d(DIAG_TAG, "[Signaling] channel:leave sent for channelId=" + channelId);
        } catch (Exception e) {
            Log.w(DIAG_TAG, "[Signaling] channel:leave emit failed: " + e.getMessage());
        }
    }

    private void sendChannelJoin(String channelId) {
        if (socket == null || !socket.connected()) return;
        try {
            JSONObject payload = new JSONObject();
            payload.put("channelId", channelId);
            socket.emit("channel:join", payload);
            Log.d(DIAG_TAG, "[Signaling] channel:join sent for channelId=" + channelId);
        } catch (Exception e) {
            Log.w(DIAG_TAG, "[Signaling] channel:join emit failed: " + e.getMessage());
        }
    }

    public void destroy() {
        destroyed = true;
        if (socket != null) {
            try {
                socket.off();
                socket.disconnect();
                socket.close();
            } catch (Exception e) {
                Log.w(DIAG_TAG, "[Signaling] destroy error: " + e.getMessage());
            }
            socket = null;
        }
        Log.d(DIAG_TAG, "[Signaling] SignalingConnection destroyed");
    }

    public boolean isConnected() {
        return socket != null && socket.connected() && authenticated;
    }
}
