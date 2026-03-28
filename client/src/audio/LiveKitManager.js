// PCM-only audio manager (merge-resolved baseline).
import { notifyChannelJoin } from '../utils/api.js';
import { signalingManager } from '../signaling/SignalingManager.js';
import { PTT_STATES } from '../constants/pttStates.js';
import { buildPcmPacket, validatePcmPacket } from './PcmPacket.js';
import { PcmCaptureEngine } from './PcmCaptureEngine.js';
import { PcmPlaybackEngine } from './PcmPlaybackEngine.js';

class LiveKitManager {
  constructor() {
    this.rooms = new Map();
    this.pendingConnections = new Map();
    this.mutedChannels = new Set();
    this._dispatcherMode = false;
    this.primaryTxChannel = null;

    this.pttState = PTT_STATES.IDLE;
    this.onStateChange = null;
    this.onDisconnectDuringTx = null;
    this._pttListeners = new Set();

    this._trackSubscribedListeners = new Set();
    this._trackUnsubscribedListeners = new Set();
    this._participantConnectedListeners = new Set();
    this._participantDisconnectedListeners = new Set();
    this._dataReceivedListeners = new Set();
    this._levelUpdateListeners = new Set();
    this._connectionStateChangeListeners = new Set();
    this._healthChangeListeners = new Set();

    this._capture = new PcmCaptureEngine();
    this._playback = new PcmPlaybackEngine();
    this._txSequence = 0;
    this._loopbackOk = false;
    this._rxPlaybackStarted = false;
  }

  addTrackSubscribedListener(cb) { this._trackSubscribedListeners.add(cb); return () => this._trackSubscribedListeners.delete(cb); }
  addTrackUnsubscribedListener(cb) { this._trackUnsubscribedListeners.add(cb); return () => this._trackUnsubscribedListeners.delete(cb); }
  addParticipantConnectedListener(cb) { this._participantConnectedListeners.add(cb); return () => this._participantConnectedListeners.delete(cb); }
  addParticipantDisconnectedListener(cb) { this._participantDisconnectedListeners.add(cb); return () => this._participantDisconnectedListeners.delete(cb); }
  addDataReceivedListener(cb) { this._dataReceivedListeners.add(cb); return () => this._dataReceivedListeners.delete(cb); }
  addLevelUpdateListener(cb) { this._levelUpdateListeners.add(cb); return () => this._levelUpdateListeners.delete(cb); }
  addConnectionStateChangeListener(cb) { this._connectionStateChangeListeners.add(cb); return () => this._connectionStateChangeListeners.delete(cb); }
  addHealthChangeListener(cb) { this._healthChangeListeners.add(cb); return () => this._healthChangeListeners.delete(cb); }

  _emitConnectionStateChange(channelName, state, error) {
    for (const cb of this._connectionStateChangeListeners) {
      try { cb(channelName, state, error); } catch (_) {}
    }
  }

  _setPttState(next) {
    const prev = this.pttState;
    this.pttState = next;
    if (this.onStateChange) {
      try { this.onStateChange(next, prev); } catch (_) {}
    }
    for (const cb of this._pttListeners) {
      try { cb(next, prev); } catch (_) {}
    }
  }

  setAutoPlayback(_enabled) {}
  startSettingsListener() {}
  async prepareConnection() {
    await this._playback.init();
  }

  async _openWebSocket(channelName, identity) {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${window.location.host}/api/audio-ws?channelId=${encodeURIComponent(channelName)}&unitId=${encodeURIComponent(identity)}`;
    const redactedUrl = (() => {
      try {
        const parsed = new URL(url);
        ['token', 'auth', 'access_token'].forEach((key) => {
          if (parsed.searchParams.has(key)) parsed.searchParams.set(key, '[REDACTED]');
        });
        return parsed.toString();
      } catch {
        return url;
      }
    })();
    console.log('AUDIO_WS_CONNECT_ATTEMPT', { channelName, identity, url: redactedUrl });

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onopen = () => {
        console.log('AUDIO_WS_ONOPEN', { channelName, identity });
        resolve(ws);
      };
      ws.onerror = (event) => {
        console.error('AUDIO_WS_ONERROR', { channelName, identity, eventType: event?.type || 'unknown' });
        reject(new Error('audio websocket connect failed'));
      };
      ws.onclose = (event) => {
        console.warn('AUDIO_WS_ONCLOSE', {
          channelName,
          identity,
          code: event?.code,
          reason: event?.reason || '',
          wasClean: event?.wasClean,
        });
      };
    });
  }

  async connect(channelName, identity) {
    if (!channelName || !identity) throw new Error('channelName and identity required');
    if (this.rooms.has(channelName)) return this.rooms.get(channelName);
    if (this.pendingConnections.has(channelName)) return this.pendingConnections.get(channelName);

    const pending = (async () => {
      const ws = await this._openWebSocket(channelName, identity);
      const conn = { channelName, unitId: identity, ws, state: 'connected' };

      ws.onmessage = async (evt) => {
        if (typeof evt.data !== 'string') return;
        let msg;
        try {
          msg = JSON.parse(evt.data);
        } catch {
          return;
        }

        if (!validatePcmPacket(msg)) return;
        if (this.mutedChannels.has(channelName)) return;
        if (msg.senderUnitId && msg.senderUnitId === conn.unitId) {
          console.log('SELF_AUDIO_SUPPRESSED', {
            channelName,
            senderUnitId: msg.senderUnitId,
            localUnitId: conn.unitId,
            sequence: msg.sequence,
          });
          return;
        }

        console.log('RX_RECEIVED', { sequence: msg.sequence, samples: msg.payload.length, senderUnitId: msg.senderUnitId || null });
        console.log('RX_FRAME_RECEIVED', { sequence: msg.sequence, senderUnitId: msg.senderUnitId || null });
        const frame = Int16Array.from(msg.payload);
        const enqueued = await this._playback.enqueue(frame);
        if (enqueued) {
          console.log('RX_REMOTE_AUDIO_PLAYED', { sequence: msg.sequence, senderUnitId: msg.senderUnitId || null });
        }
        if (enqueued && !this._rxPlaybackStarted) {
          this._rxPlaybackStarted = true;
          console.log('RX_PLAYBACK_STARTED');
        }
      };

      ws.onclose = () => {
        this.rooms.delete(channelName);
        this._emitConnectionStateChange(channelName, 'disconnected');
      };

      this.rooms.set(channelName, conn);
      notifyChannelJoin(channelName, identity);
      this._emitConnectionStateChange(channelName, 'connected');
      return conn;
    })();

    this.pendingConnections.set(channelName, pending);
    try {
      return await pending;
    } finally {
      this.pendingConnections.delete(channelName);
    }
  }

  async disconnect(channelName = null) {
    if (!channelName) {
      await this.stopTransmit();
      return;
    }
    const conn = this.rooms.get(channelName);
    if (!conn) return;
    this.rooms.delete(channelName);
    try { conn.ws.close(); } catch (_) {}
    this._emitConnectionStateChange(channelName, 'disconnected');
  }

  async disconnectAll() {
    for (const channel of [...this.rooms.keys()]) {
      await this.disconnect(channel);
    }
    await this.stopTransmit();
  }

  getRoom(channelName) { return this.rooms.get(channelName) || null; }
  getConnectedChannels() { return [...this.rooms.keys()]; }
  isConnected(channelName) { return this.rooms.has(channelName); }
  setChannelActive(_channelName) {}
  setChannelInactive(_channelName) {}

  waitForRoom(channelName, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        const room = this.getRoom(channelName);
        if (room) return resolve(room);
        if (Date.now() - start > timeoutMs) return reject(new Error('Room wait timeout'));
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  muteChannel(ch) { this.mutedChannels.add(ch); }
  unmuteChannel(ch) { this.mutedChannels.delete(ch); }
  muteChannels(chs) { chs.forEach((c) => this.muteChannel(c)); }
  unmuteChannels(chs) { chs.forEach((c) => this.unmuteChannel(c)); }

  sendData(channelName, data) {
    signalingManager.sendChannelData(channelName, data);
  }

  setPrimaryTxChannel(channelName) {
    if (!this.rooms.has(channelName)) return false;
    this.primaryTxChannel = channelName;
    return true;
  }
  getPrimaryTxChannel() { return this.primaryTxChannel || null; }

  getState() { return this.pttState; }
  getPttState() { return this.pttState; }
  addPttStateListener(cb) { this._pttListeners.add(cb); return () => this._pttListeners.delete(cb); }

  setCurrentChannel(channelName) { this.primaryTxChannel = channelName; }
  setCurrentUnit(_unitId) {}
  setRoom(_room) {}

  canStartTransmit() { return !!this.primaryTxChannel && this.pttState === PTT_STATES.IDLE; }
  canStart() { return this.canStartTransmit(); }
  canStop() { return this.pttState === PTT_STATES.ARMING || this.pttState === PTT_STATES.TRANSMITTING || this.pttState === PTT_STATES.BUSY; }
  isTransmitting() { return this.pttState === PTT_STATES.TRANSMITTING; }

  async startTransmit() {
    if (!this.canStartTransmit()) {
      console.warn('AUDIO_TX_BLOCKED', {
        reason: 'cannot_start_transmit',
        primaryTxChannel: this.primaryTxChannel,
        pttState: this.pttState,
      });
      return false;
    }
    const txChannel = this.primaryTxChannel;
    const room = this.rooms.get(txChannel);
    if (!room || !room.ws || room.ws.readyState !== WebSocket.OPEN) {
      console.warn('AUDIO_TX_BLOCKED', {
        reason: 'ws_not_open',
        txChannel,
        hasRoom: !!room,
        readyState: room?.ws?.readyState,
      });
      return false;
    }

    this._setPttState(PTT_STATES.ARMING);
    this._loopbackOk = true;
    console.log('SELF_MONITOR_DISABLED');

    await this._capture.start(async (frame) => {
      if (!this._loopbackOk) return;

      const packet = buildPcmPacket(this._txSequence++, txChannel, frame);
      const payloadBytes = frame.length * 2;
      room.ws.send(JSON.stringify(packet));
      console.log('TX_SENT', { sequence: packet.sequence, payloadBytes });
      console.log('TX_WS_FRAME_SENT', { sequence: packet.sequence, payloadBytes });
    });

    this._setPttState(PTT_STATES.TRANSMITTING);
    return true;
  }

  async start() { return this.startTransmit(); }

  async stopTransmit() {
    if (this.pttState === PTT_STATES.IDLE) return;
    await this._capture.stop();
    this._setPttState(PTT_STATES.COOLDOWN);
    this._setPttState(PTT_STATES.IDLE);
  }

  async stop() { return this.stopTransmit(); }

  forceReleaseTransmit() {
    this._capture.stop().catch(() => {});
    this._setPttState(PTT_STATES.IDLE);
  }

  forceRelease() { this.forceReleaseTransmit(); }

  setPttErrorHandler(_callback) {}
  setPttDisconnectHandler(callback) { this.onDisconnectDuringTx = callback; }

  isChannelHealthy(channelName, { allowReconnecting = false } = {}) {
    if (this.rooms.has(channelName)) return true;
    return allowReconnecting && this.pendingConnections.has(channelName);
  }
  areChannelsHealthy(names, opts = {}) { return names.every((n) => this.isChannelHealthy(n, opts)); }
  areAnyChannelsBusy() { return false; }
  isChannelBusy() { return false; }
  isChannelReconnecting(channelName) { return this.pendingConnections.has(channelName); }

  getConnectionStatus() {
    const total = this.rooms.size;
    return {
      status: total > 0 ? 'connected' : 'disconnected',
      healthy: total,
      total,
      channels: [...this.rooms.keys()].map((ch) => ({ channel: ch, connected: true, quality: 'good', state: 'connected' })),
    };
  }

  setDispatcherMode(enabled) { this._dispatcherMode = !!enabled; }
  isDispatcherMode() { return this._dispatcherMode; }
  scheduleDispatcherReconnect(_channelName, _identity) {}

  broadcastData(data) {
    for (const [channelName] of this.rooms) {
      this.sendData(channelName, data);
    }
  }
}

export const livekitManager = new LiveKitManager();
if (typeof window !== 'undefined') window.__livekitManager = livekitManager;
export default livekitManager;
