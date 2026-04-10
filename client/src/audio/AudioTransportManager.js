import { notifyChannelJoin } from '../utils/api.js';
import { signalingManager } from '../signaling/SignalingManager.js';
import { PTT_STATES } from '../constants/pttStates.js';
import { buildPcmPacket, buildBinaryFrame, buildBinaryFrameOpus, validatePcmPacket, parseBinaryAudioFrame } from './PcmPacket.js';
import { PcmCaptureEngine } from './PcmCaptureEngine.js';
import { PcmPlaybackEngine } from './PcmPlaybackEngine.js';
import { OpusDecoder } from 'opus-decoder';
import { OpusBrowserEncoder } from './OpusBrowserEncoder.js';

const WS_HEALTH_CHECK_INTERVAL = 5000;
const WS_LIVENESS_TIMEOUT = 45000;
const REORDER_BUFFER_SIZE = 20;
const REORDER_MAX_LATE = 20;
const PLC_MAX_CONSECUTIVE = 7;
const RX_DIAG_DETAIL_COUNT = 5;
const RX_DIAG_SUMMARY_INTERVAL_MS = 2000;

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 10000;

function float32ToInt16(float32) {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = s < 0 ? s * 32768 : s * 32767;
  }
  return int16;
}

class AudioTransportManager {
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

    this._opusDecoders = new Map();
    this._opusDecoderReady = new Map();
    this._txEncoder = new OpusBrowserEncoder();

    this._reorderStreams = new Map();
    this._latePackets = 0;
    this._reorderedPackets = 0;
    this._lastReorderLog = 0;
    this._suspendedBuffer = [];

    this._rxDiagDecodedCount = 0;
    this._rxDiagDetailCount = 0;
    this._rxDiagLastSummaryTime = 0;
    this._rxDiagSummaryFrames = 0;
    this._rxDiagSummaryBytes = 0;
    this._rxDiagPlcCount = 0;
    this._rxDiagReorderFlushes = 0;

    this._targetChannels = new Map();
    this._healthCheckInterval = null;
    this._reconnectAttempts = new Map();
    this._reconnectTimers = new Map();
    this._startHealthCheck();
  }

  async _getOpusDecoder(senderKey) {
    if (this._opusDecoders.has(senderKey)) {
      try {
        await this._opusDecoderReady.get(senderKey);
        return this._opusDecoders.get(senderKey);
      } catch (err) {
        console.warn('[AudioTransport] Cached decoder init failed for', senderKey, '- recreating');
        this._opusDecoders.delete(senderKey);
        this._opusDecoderReady.delete(senderKey);
      }
    }
    const decoder = new OpusDecoder({ channels: 1, sampleRate: 48000 });
    const readyPromise = decoder.ready.then(() => decoder).catch((err) => {
      this._opusDecoders.delete(senderKey);
      this._opusDecoderReady.delete(senderKey);
      throw err;
    });
    this._opusDecoders.set(senderKey, decoder);
    this._opusDecoderReady.set(senderKey, readyPromise);
    await readyPromise;
    return decoder;
  }

  _resetOpusDecoderForChannel(channelId) {
    for (const [key, decoder] of this._opusDecoders) {
      if (key.startsWith(channelId + '::')) {
        try { decoder.free(); } catch (_) {}
        this._opusDecoders.delete(key);
        this._opusDecoderReady.delete(key);
      }
    }
  }

  async _ensureTxEncoder() {
    if (!this._txEncoder.isReady()) {
      await this._txEncoder.init();
    }
    return this._txEncoder.isReady();
  }

  _startHealthCheck() {
    if (this._healthCheckInterval) clearInterval(this._healthCheckInterval);
    this._healthCheckInterval = setInterval(() => {
      const now = Date.now();
      for (const [channelName, conn] of this.rooms) {
        const isDead = !conn.ws || conn.ws.readyState !== WebSocket.OPEN;
        const isStale = conn.ws && conn.ws.readyState === WebSocket.OPEN && conn._lastActivity && (now - conn._lastActivity) > WS_LIVENESS_TIMEOUT;
        if (isDead || isStale) {
          console.warn('AUDIO_WS_HEALTH_CHECK_DEAD', { channelName, readyState: conn.ws?.readyState, stale: isStale, lastActivity: conn._lastActivity });
          try { conn.ws.close(); } catch (_) {}
          this.rooms.delete(channelName);
          this._emitConnectionStateChange(channelName, 'disconnected');
          this._scheduleReconnect(channelName);
        }
      }
    }, WS_HEALTH_CHECK_INTERVAL);
  }

  _scheduleReconnect(channelName) {
    if (!this._targetChannels.has(channelName)) return;
    if (this._reconnectTimers.has(channelName)) return;
    if (this.rooms.has(channelName)) return;

    const attempt = (this._reconnectAttempts.get(channelName) || 0) + 1;
    this._reconnectAttempts.set(channelName, attempt);
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, attempt - 1), RECONNECT_MAX_MS);

    console.log('AUDIO_WS_RECONNECT_SCHEDULED', { channelName, attempt, delayMs: delay });
    this._emitConnectionStateChange(channelName, 'reconnecting');

    const timer = setTimeout(async () => {
      this._reconnectTimers.delete(channelName);
      const identity = this._targetChannels.get(channelName);
      if (!identity) return;
      if (this.rooms.has(channelName)) return;

      try {
        await this.connect(channelName, identity);
        console.log('AUDIO_WS_RECONNECT_SUCCESS', { channelName, attempt });
      } catch (err) {
        console.warn('AUDIO_WS_RECONNECT_FAILED', { channelName, attempt, error: err.message });
        this._scheduleReconnect(channelName);
      }
    }, delay);
    this._reconnectTimers.set(channelName, timer);
  }

  forceHealthCheck() {
    const now = Date.now();
    for (const [channelName, conn] of this.rooms) {
      const isDead = !conn.ws || conn.ws.readyState !== WebSocket.OPEN;
      const isStale = conn.ws && conn.ws.readyState === WebSocket.OPEN && conn._lastActivity && (now - conn._lastActivity) > WS_LIVENESS_TIMEOUT;
      if (isDead || isStale) {
        console.warn('AUDIO_WS_FORCE_HEALTH_CHECK_DEAD', { channelName, readyState: conn.ws?.readyState, stale: isStale, lastActivity: conn._lastActivity });
        try { conn.ws.close(); } catch (_) {}
        this.rooms.delete(channelName);
        this._emitConnectionStateChange(channelName, 'disconnected');
      }
    }
  }

  hasRecoveryTargets() {
    return this._targetChannels.size > 0;
  }

  hasActiveConnections() {
    return this.rooms.size > 0 || this.pendingConnections.size > 0;
  }

  getTargetChannelsSnapshot() {
    return new Map(this._targetChannels);
  }

  restoreTargetChannels(snapshot) {
    for (const [channelName, unitId] of snapshot) {
      this._targetChannels.set(channelName, unitId);
    }
  }

  async resumePlayback() {
    if (this._playback && this._playback.audioContext) {
      return await this._playback.ensureAudioContextResumed('visibility-restore');
    }
    return false;
  }

  _cancelReconnect(channelName) {
    const timer = this._reconnectTimers.get(channelName);
    if (timer) {
      clearTimeout(timer);
      this._reconnectTimers.delete(channelName);
    }
    this._reconnectAttempts.delete(channelName);
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
    await this._playback.ensureAudioContextResumed('prepareConnection');
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
    this._targetChannels.set(channelName, identity);
    if (this.rooms.has(channelName)) return this.rooms.get(channelName);
    if (this.pendingConnections.has(channelName)) return this.pendingConnections.get(channelName);

    const pending = (async () => {
      const ws = await this._openWebSocket(channelName, identity);
      const conn = { channelName, unitId: identity, ws, state: 'connected', _lastActivity: Date.now() };

      ws.binaryType = 'arraybuffer';

      ws.onmessage = async (evt) => {
        conn._lastActivity = Date.now();

        if (evt.data instanceof ArrayBuffer) {
          const parsed = parseBinaryAudioFrame(evt.data);
          if (!parsed) return;
          if (this.mutedChannels.has(channelName)) return;
          if (parsed.senderUnitId && parsed.senderUnitId === conn.unitId) return;
          const chId = parsed.channelId || channelName;
          if (parsed.codec === 'opus') {
            await this._enqueueWithReorder(parsed.sequence, parsed.opusData, chId, parsed.senderUnitId, 'opus');
          } else {
            await this._enqueueWithReorder(parsed.sequence, parsed.samples, chId, parsed.senderUnitId, 'pcm');
          }
          return;
        }

        if (typeof evt.data !== 'string') return;
        let msg;
        try {
          msg = JSON.parse(evt.data);
        } catch {
          return;
        }

        if (msg.type === 'heartbeat') {
          try {
            ws.send(JSON.stringify({ type: 'pong', ts: msg.ts }));
          } catch (_) {}
          return;
        }

        if (!validatePcmPacket(msg)) return;
        if (this.mutedChannels.has(channelName)) return;
        if (msg.senderUnitId && msg.senderUnitId === conn.unitId) return;

        const frame = new Int16Array(msg.payload);
        await this._enqueueWithReorder(msg.sequence, frame, msg.channelId || channelName, msg.senderUnitId || 'unknown', 'pcm');
      };

      ws.onclose = () => {
        this.rooms.delete(channelName);
        this._emitConnectionStateChange(channelName, 'disconnected');
        this._scheduleReconnect(channelName);
      };

      if (!this._targetChannels.has(channelName)) {
        try { ws.close(); } catch (_) {}
        return null;
      }

      this._reconnectAttempts.delete(channelName);
      this.rooms.set(channelName, conn);
      this._playback.ensureAudioContextResumed('channelJoin').catch(() => {});
      this._capture.warmup().catch((err) => {
        console.warn('[AudioTransport] Capture warmup failed:', err.message);
      });
      this._resetReorderForChannel(channelName);
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
    this._targetChannels.delete(channelName);
    this._cancelReconnect(channelName);
    this._resetReorderForChannel(channelName);
    this._resetOpusDecoderForChannel(channelName);
    const conn = this.rooms.get(channelName);
    if (!conn) return;
    this.rooms.delete(channelName);
    try { conn.ws.close(); } catch (_) {}
    this._emitConnectionStateChange(channelName, 'disconnected');

    if (this.rooms.size === 0) {
      await this._capture.shutdown();
    }
  }

  async disconnectAll() {
    this._targetChannels.clear();
    for (const channelName of this._reconnectTimers.keys()) {
      this._cancelReconnect(channelName);
    }
    for (const [key, stream] of this._reorderStreams) {
      if (stream.flushTimer) clearTimeout(stream.flushTimer);
    }
    this._reorderStreams.clear();
    for (const [, decoder] of this._opusDecoders) {
      try { decoder.free(); } catch (_) {}
    }
    this._opusDecoders.clear();
    this._opusDecoderReady.clear();
    if (this._txEncoder) {
      this._txEncoder.destroy();
      this._txEncoder = new OpusBrowserEncoder();
    }
    for (const channel of [...this.rooms.keys()]) {
      await this.disconnect(channel);
    }
    await this.stopTransmit();
    await this._capture.shutdown();
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
    let room = this.rooms.get(txChannel);
    if (!room || !room.ws || room.ws.readyState !== WebSocket.OPEN) {
      const target = this._targetChannels.get(txChannel);
      if (target) {
        console.log('AUDIO_TX_AUTO_RECONNECT', { txChannel });
        try {
          const connectTimeout = 5000;
          await Promise.race([
            this.connect(txChannel, target),
            new Promise((_, reject) => setTimeout(() => reject(new Error('auto-connect timeout')), connectTimeout)),
          ]);
          room = this.rooms.get(txChannel);
        } catch (err) {
          console.warn('AUDIO_TX_AUTO_RECONNECT_FAILED', { txChannel, error: err.message });
        }
      }
      if (!room || !room.ws || room.ws.readyState !== WebSocket.OPEN) {
        console.warn('AUDIO_TX_BLOCKED', {
          reason: 'ws_not_open',
          txChannel,
          hasRoom: !!room,
          readyState: room?.ws?.readyState,
        });
        return false;
      }
    }

    this._setPttState(PTT_STATES.ARMING);
    this._loopbackOk = true;
    await this._playback.ensureAudioContextResumed('pttActivity');

    if (!OpusBrowserEncoder.isSupported()) {
      console.error('AUDIO_TX_BLOCKED: WebCodecs AudioEncoder not available — cannot transmit');
      this._setPttState(PTT_STATES.IDLE);
      return false;
    }

    const opusTxReady = await this._ensureTxEncoder();

    if (!opusTxReady) {
      console.error('AUDIO_TX_BLOCKED: Opus encoder failed to initialize');
      this._setPttState(PTT_STATES.IDLE);
      return false;
    }

    this._txEncoder.setOnEncoded((encoded) => {
      if (!this._loopbackOk) return;
      if (!room || !room.ws || room.ws.readyState !== WebSocket.OPEN) return;
      const binFrame = buildBinaryFrameOpus(this._txSequence++, txChannel, room.unitId, encoded);
      room.ws.send(binFrame);
    });

    await this._capture.start(async (frame) => {
      if (!this._loopbackOk) return;
      this._txEncoder.encode(frame);
    });

    if (this.pttState !== PTT_STATES.ARMING) {
      await this._capture.stop();
      return false;
    }

    this._setPttState(PTT_STATES.TRANSMITTING);
    return true;
  }

  async start() { return this.startTransmit(); }

  async stopTransmit() {
    if (this.pttState === PTT_STATES.IDLE) return;
    await this._capture.stop();
    if (this._txEncoder && this._txEncoder.isReady()) {
      await this._txEncoder.flush();
    }
    this._txEncoder.setOnEncoded(null);
    this._setPttState(PTT_STATES.COOLDOWN);
    this._setPttState(PTT_STATES.IDLE);
  }

  async stop() { return this.stopTransmit(); }

  forceReleaseTransmit() {
    this._capture.stop().catch(() => {});
    if (this._txEncoder) {
      this._txEncoder.setOnEncoded(null);
    }
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
    let healthy = 0;
    const channels = [];
    for (const [ch, conn] of this.rooms) {
      const isOpen = conn.ws && conn.ws.readyState === WebSocket.OPEN;
      if (isOpen) healthy++;
      channels.push({
        channel: ch,
        connected: isOpen,
        quality: isOpen ? 'good' : 'poor',
        state: isOpen ? 'connected' : 'reconnecting',
      });
    }
    for (const ch of this.pendingConnections.keys()) {
      if (!this.rooms.has(ch)) {
        channels.push({ channel: ch, connected: false, quality: 'poor', state: 'reconnecting' });
      }
    }
    const reconnecting = this.pendingConnections.size > 0 || (total > 0 && healthy < total);
    return {
      status: healthy > 0 ? 'connected' : (reconnecting ? 'reconnecting' : 'disconnected'),
      healthy,
      total: total + (channels.length - total),
      channels,
    };
  }

  setDispatcherMode(enabled) { this._dispatcherMode = !!enabled; }
  isDispatcherMode() { return this._dispatcherMode; }
  scheduleDispatcherReconnect(_channelName, _identity) {}

  async verifyAndReconnectAll(allowedChannels = null) {
    const toReconnect = [];
    for (const [channelName, conn] of this.rooms) {
      if (allowedChannels && !allowedChannels.has(channelName)) continue;
      if (!conn.ws || conn.ws.readyState !== WebSocket.OPEN) {
        toReconnect.push({ channelName, unitId: conn.unitId });
      }
    }
    for (const [channelName, unitId] of this._targetChannels) {
      if (allowedChannels && !allowedChannels.has(channelName)) continue;
      if (!this.rooms.has(channelName) && !this.pendingConnections.has(channelName)) {
        if (!toReconnect.some(r => r.channelName === channelName)) {
          toReconnect.push({ channelName, unitId });
        }
      }
    }
    for (const { channelName, unitId } of toReconnect) {
      console.log('AUDIO_WS_VERIFY_RECONNECT', { channelName, unitId });
      const existing = this.rooms.get(channelName);
      if (existing) {
        try { existing.ws?.close(); } catch (_) {}
        this.rooms.delete(channelName);
        this._emitConnectionStateChange(channelName, 'disconnected');
      }
      try {
        await this.connect(channelName, unitId);
      } catch (err) {
        console.error('AUDIO_WS_VERIFY_RECONNECT_FAILED', { channelName, error: err.message });
      }
    }
    return toReconnect.length;
  }

  _getReorderStream(channelId, senderUnitId) {
    const key = `${channelId}::${senderUnitId}`;
    let stream = this._reorderStreams.get(key);
    if (!stream) {
      stream = { expectedSequence: -1, buffer: [], flushTimer: null };
      this._reorderStreams.set(key, stream);
    }
    return stream;
  }

  _resetReorderForChannel(channelId) {
    for (const [key, stream] of this._reorderStreams) {
      if (key.startsWith(channelId + '::')) {
        if (stream.flushTimer) clearTimeout(stream.flushTimer);
        this._reorderStreams.delete(key);
      }
    }
  }

  async _enqueueWithReorder(sequence, payload, channelId, senderUnitId, codec = 'pcm') {
    const stream = this._getReorderStream(channelId, senderUnitId);

    if (stream.expectedSequence === -1 || sequence < stream.expectedSequence - REORDER_MAX_LATE * 5) {
      stream.expectedSequence = sequence;
    }

    if (sequence < stream.expectedSequence - REORDER_MAX_LATE) {
      this._latePackets++;
      console.log('AUDIO_RX_LATE_DROPPED', { seq: sequence, expected: stream.expectedSequence, channelId, sender: senderUnitId });
      this._logReorderStats();
      return;
    }

    if (sequence === stream.expectedSequence) {
      await this._deliverFrame(stream, sequence, payload, codec, channelId, senderUnitId);
      stream.expectedSequence = sequence + 1;
      await this._flushReorderBuffer(stream, channelId, senderUnitId);
      return;
    }

    if (sequence < stream.expectedSequence) {
      this._latePackets++;
      this._logReorderStats();
      return;
    }

    this._reorderedPackets++;
    this._logReorderStats();
    stream.buffer.push({ sequence, payload, codec });
    stream.buffer.sort((a, b) => a.sequence - b.sequence);

    if (stream.buffer.length > REORDER_BUFFER_SIZE) {
      const oldest = stream.buffer.shift();
      stream.expectedSequence = oldest.sequence + 1;
      await this._deliverFrame(stream, oldest.sequence, oldest.payload, oldest.codec, channelId, senderUnitId);
      await this._flushReorderBuffer(stream, channelId, senderUnitId);
    }

    if (!stream.flushTimer) {
      stream.flushTimer = setTimeout(async () => {
        stream.flushTimer = null;
        if (stream.buffer.length > 0) {
          const oldest = stream.buffer.shift();
          stream.expectedSequence = oldest.sequence + 1;
          await this._deliverFrame(stream, oldest.sequence, oldest.payload, oldest.codec, channelId, senderUnitId);
          await this._flushReorderBuffer(stream, channelId, senderUnitId);
        }
      }, 90);
    }
  }

  async _flushReorderBuffer(stream, channelId, senderUnitId) {
    let flushed = 0;
    while (stream.buffer.length > 0 && stream.buffer[0].sequence === stream.expectedSequence) {
      const entry = stream.buffer.shift();
      stream.expectedSequence = entry.sequence + 1;
      await this._deliverFrame(stream, entry.sequence, entry.payload, entry.codec, channelId, senderUnitId);
      flushed++;
    }
    if (flushed > 0) {
      this._rxDiagReorderFlushes++;
    }
  }

  async _deliverFrame(stream, sequence, payload, codec, channelId, senderUnitId) {
    const lastSeq = stream.lastDeliveredSeq;
    if (lastSeq !== undefined && codec === 'opus') {
      const gap = sequence - lastSeq - 1;
      if (gap > 0 && gap <= PLC_MAX_CONSECUTIVE) {
        await this._generatePlc(channelId, senderUnitId, gap);
      }
    }
    stream.lastDeliveredSeq = sequence;
    await this._decodeAndPlayback(payload, codec, channelId, senderUnitId);
  }

  async _decodeAndPlayback(payload, codec, channelId, senderUnitId) {
    if (codec === 'opus') {
      try {
        const decoderKey = `${channelId}::${senderUnitId}`;
        const decoder = await this._getOpusDecoder(decoderKey);
        const decoded = decoder.decodeFrame(payload);
        if (decoded.samplesDecoded > 0 && decoded.channelData && decoded.channelData[0]) {
          const int16 = float32ToInt16(decoded.channelData[0]);
          this._rxDiagDecodedCount++;
          this._rxDiagDetailCount++;
          this._rxDiagSummaryFrames++;
          this._rxDiagSummaryBytes += payload.byteLength || payload.length || 0;
          if (this._rxDiagDetailCount <= RX_DIAG_DETAIL_COUNT) {
            console.log('AUDIO_RX_DECODE_DETAIL', { opusBytes: payload.byteLength || payload.length, pcmSamples: decoded.samplesDecoded, channelId, sender: senderUnitId, frame: this._rxDiagDetailCount });
          } else {
            const now = Date.now();
            if (now - this._rxDiagLastSummaryTime >= RX_DIAG_SUMMARY_INTERVAL_MS) {
              console.log('AUDIO_RX_DECODE_SUMMARY', { frames: this._rxDiagSummaryFrames, totalBytes: this._rxDiagSummaryBytes, plcFrames: this._rxDiagPlcCount, reorderFlushes: this._rxDiagReorderFlushes });
              this._rxDiagLastSummaryTime = now;
              this._rxDiagSummaryFrames = 0;
              this._rxDiagSummaryBytes = 0;
              this._rxDiagPlcCount = 0;
              this._rxDiagReorderFlushes = 0;
            }
          }
          await this._playbackFrame(int16);
        }
      } catch (err) {
        console.warn('OPUS_DECODE_ERROR', err.message);
      }
    } else {
      await this._playbackFrame(payload);
    }
  }

  async _generatePlc(channelId, senderUnitId, count) {
    try {
      const decoderKey = `${channelId}::${senderUnitId}`;
      const decoder = await this._getOpusDecoder(decoderKey);
      console.log('AUDIO_RX_PLC_GENERATE', { channelId, sender: senderUnitId, count });
      this._rxDiagPlcCount += count;
      for (let i = 0; i < count; i++) {
        try {
          const plc = decoder.decodeFrame(new Uint8Array(0));
          if (plc.samplesDecoded > 0 && plc.channelData && plc.channelData[0]) {
            const int16 = float32ToInt16(plc.channelData[0]);
            await this._playbackFrame(int16);
          }
        } catch (_) {
          break;
        }
      }
    } catch (_) {}
  }

  _logReorderStats() {
    const now = Date.now();
    if (now - this._lastReorderLog > 5000) {
      this._lastReorderLog = now;
      if (this._latePackets > 0 || this._reorderedPackets > 0) {
        console.warn('AUDIO_RX_REORDER_STATS', {
          lateDropped: this._latePackets,
          reordered: this._reorderedPackets,
          activeStreams: this._reorderStreams.size,
        });
        this._latePackets = 0;
        this._reorderedPackets = 0;
      }
    }
  }

  async _playbackFrame(samples) {
    if (!this._playback.started) {
      await this._playback.init();
    }

    if (this._playback.audioContext && this._playback.audioContext.state === 'suspended') {
      this._suspendedBuffer.push(samples);
      if (this._suspendedBuffer.length > 50) {
        this._suspendedBuffer.splice(0, this._suspendedBuffer.length - 25);
      }
      try {
        await this._playback.audioContext.resume();
      } catch (_) {}
      if (this._playback.audioContext.state === 'running' && this._suspendedBuffer.length > 0) {
        const buffered = this._suspendedBuffer.splice(0);
        for (const frame of buffered) {
          await this._playback.enqueue(frame);
        }
      }
      return;
    }

    if (this._suspendedBuffer.length > 0) {
      const buffered = this._suspendedBuffer.splice(0);
      for (const frame of buffered) {
        await this._playback.enqueue(frame);
      }
    }

    await this._playback.enqueue(samples);
  }

  broadcastData(data) {
    for (const [channelName] of this.rooms) {
      this.sendData(channelName, data);
    }
  }
}

export const audioTransportManager = new AudioTransportManager();
if (typeof window !== 'undefined') {
  window.__audioTransportManager = audioTransportManager;
  window.__livekitManager = audioTransportManager;
}
export default audioTransportManager;

export const livekitManager = audioTransportManager;
export { AudioTransportManager as LiveKitManager };
