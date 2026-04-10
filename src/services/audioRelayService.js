import dgram from 'dgram';
import { canonicalChannelKey } from './channelKeyUtils.js';
import { opusCodec } from './opusCodec.js';

const VERSION_LEN = 1;
const FLAGS_LEN = 1;
const CHANNEL_ID_LEN = 2;
const SEQUENCE_LEN = 2;
const TIMESTAMP_LEN = 4;
const SENDER_LEN_LEN = 1;
const PAYLOAD_LEN_LEN = 2;
const RADIO_HEADER_FIXED_LEN = VERSION_LEN + FLAGS_LEN + CHANNEL_ID_LEN + SEQUENCE_LEN + TIMESTAMP_LEN + SENDER_LEN_LEN + PAYLOAD_LEN_LEN;
const PACKET_VERSION = 1;
const FLAG_FEC_HINT = 0x01;
const SUBSCRIBER_TIMEOUT_MS = 60000;
const AUDIO_DIAG = process.env.AUDIO_DIAG === 'true';
const SUBSCRIBER_SWEEP_INTERVAL_MS = 30000;

const WS_PACING_INTERVAL_MS = 20;
const WS_PACING_MAX_QUEUE = 75;
const TX_WATCHDOG_INTERVAL_MS = 1000;
const TX_WATCHDOG_SILENCE_THRESHOLD_MS = 5000;
const TX_WATCHDOG_GRACE_MS = 6000;
const PCM_FRAME_SAMPLES = 960;
const WS_BINARY_MARKER = 0x01;
const WS_BINARY_MARKER_OPUS = 0x02;
const PLC_MAX_CONSECUTIVE = 3;

class AudioRelayService {
  constructor() {
    this.socket = null;
    this.port = 5100;
    this.subscribers = new Map();
    this._recordingTap = null;
    this._sweepTimer = null;
    this._audioListeners = new Map();
    this._wsSubscribers = new Map();
    this._channelNumericByKey = new Map();
    this._channelKeyByNumeric = new Map();
    this._wsPacingQueues = new Map();
    this._wsPacingTimers = new Map();
    this._wsPacingDriftState = new Map();
    this._senderLastSeq = new Map();
    this._senderLastSeqTime = new Map();
    this._zeroChannelWarnTimes = new Map();
    this._signalingService = null;
    this._lastAudioReceived = new Map();
    this._txWatchdogTimer = null;
    this._txWatchdogAlerted = new Set();
    this._txSessionStats = new Map();
    this._wsRelayStats = new Map();
    this._wsRelayStatsTimer = null;
    this._txPacketLogCounters = new Map();
    this._txPacketLogLastSummary = new Map();
    this._txPacketIntervalStats = new Map();
  }

  onRecordingTap(callback) {
    this._recordingTap = callback;
  }

  registerChannelNumeric(channelId, channelNumeric) {
    const key = canonicalChannelKey(channelId);
    const resolved = this._resolveChannelIdNumeric({ channelKey: key, channelIdNumeric: channelNumeric });
    if (key && resolved > 0) {
      const existingKey = this._channelKeyByNumeric.get(resolved);
      if (existingKey && existingKey !== key) {
        console.log(`[AudioRelay] CHANNEL_NUMERIC_REMAP numeric=${resolved} oldKey="${existingKey}" newKey="${key}"`);
        if (this.subscribers.has(existingKey)) {
          const oldSubs = this.subscribers.get(existingKey);
          if (!this.subscribers.has(key)) this.subscribers.set(key, new Map());
          const newSubs = this.subscribers.get(key);
          for (const [unitId, subInfo] of oldSubs) {
            newSubs.set(unitId, subInfo);
          }
          this.subscribers.delete(existingKey);
          console.log(`[AudioRelay] SUBSCRIBERS_MIGRATED from="${existingKey}" to="${key}" count=${oldSubs.size}`);
        }
        if (this._wsSubscribers.has(existingKey)) {
          const oldWsSubs = this._wsSubscribers.get(existingKey);
          if (!this._wsSubscribers.has(key)) this._wsSubscribers.set(key, new Map());
          const newWsSubs = this._wsSubscribers.get(key);
          for (const [unitId, ws] of oldWsSubs) {
            newWsSubs.set(unitId, ws);
          }
          this._wsSubscribers.delete(existingKey);
          console.log(`[AudioRelay] WS_SUBSCRIBERS_MIGRATED from="${existingKey}" to="${key}" count=${oldWsSubs.size}`);
        }
        if (this._audioListeners.has(existingKey)) {
          const oldListeners = this._audioListeners.get(existingKey);
          if (!this._audioListeners.has(key)) this._audioListeners.set(key, new Map());
          const newListeners = this._audioListeners.get(key);
          for (const [listenerId, cb] of oldListeners) {
            newListeners.set(listenerId, cb);
          }
          this._audioListeners.delete(existingKey);
          console.log(`[AudioRelay] AUDIO_LISTENERS_MIGRATED from="${existingKey}" to="${key}" count=${oldListeners.size}`);
        }
        if (this._wsPacingQueues.has(existingKey)) {
          const oldQueue = this._wsPacingQueues.get(existingKey);
          const existingQueue = this._wsPacingQueues.get(key) || [];
          this._wsPacingQueues.set(key, existingQueue.concat(oldQueue));
          this._wsPacingQueues.delete(existingKey);
        }
        if (this._wsPacingTimers.has(existingKey)) {
          clearTimeout(this._wsPacingTimers.get(existingKey));
          this._wsPacingTimers.delete(existingKey);
        }
        this._wsPacingDriftState.delete(existingKey);
        const migratedQueue = this._wsPacingQueues.get(key);
        if (migratedQueue && migratedQueue.length > 0 && !this._wsPacingTimers.has(key)) {
          this._wsPacingDriftState.set(key, { nextTick: Date.now() + WS_PACING_INTERVAL_MS });
          this._schedulePacingTick(key);
        }
        this._channelNumericByKey.delete(existingKey);
      }
      this._channelNumericByKey.set(key, resolved);
      this._channelKeyByNumeric.set(resolved, key);
    }
  }

  addSubscriber(channelId, unitId, address, port) {
    const key = canonicalChannelKey(channelId);
    if (!this.subscribers.has(key)) this.subscribers.set(key, new Map());
    const existingSub = this.subscribers.get(key).get(unitId);
    if (existingSub && (existingSub.address !== address || existingSub.port !== port)) {
      console.log(`[AudioRelay] SUBSCRIBER_NAT_CHANGE unitId=${unitId} channelId=${key} oldAddr=${existingSub.address}:${existingSub.port} newAddr=${address}:${port}`);
    }
    this.subscribers.get(key).set(unitId, { address, port, lastSeen: Date.now() });
    if (!existingSub) {
      console.log(`[AudioRelay] SUBSCRIBER_ADDED unitId=${unitId} channelId=${key} addr=${address}:${port}`);
    }
  }

  refreshSubscriber(channelId, unitId) {
    const key = canonicalChannelKey(channelId);
    const subs = this.subscribers.get(key);
    if (!subs) {
      console.log(`[AudioRelay] SUBSCRIBER_REFRESH_NO_CHANNEL unitId=${unitId} channelId=${key} subscriberChannels=[${[...this.subscribers.keys()].join(',')}]`);
      return false;
    }
    const sub = subs.get(unitId);
    if (sub) {
      sub.lastSeen = Date.now();
      return true;
    }
    console.log(`[AudioRelay] SUBSCRIBER_REFRESH_NOT_FOUND unitId=${unitId} channelId=${key} channelSubscribers=[${[...subs.keys()].join(',')}]`);
    return false;
  }

  removeSubscriber(channelId, unitId) {
    const key = canonicalChannelKey(channelId);
    const subs = this.subscribers.get(key);
    if (!subs) return;
    subs.delete(unitId);
    console.log(`[AudioRelay] SUBSCRIBER_REMOVED unitId=${unitId} channelId=${key}`);
    if (subs.size === 0) this.subscribers.delete(key);
  }

  setSignalingService(signalingService) {
    this._signalingService = signalingService;
  }

  removeAllSubscriptions(unitId) {
    for (const [channelId, subs] of this.subscribers) {
      subs.delete(unitId);
      if (subs.size === 0) this.subscribers.delete(channelId);
    }
  }

  addWsSubscriber(channelId, unitId, ws) {
    const key = canonicalChannelKey(channelId);
    if (!this._wsSubscribers.has(key)) this._wsSubscribers.set(key, new Map());
    this._wsSubscribers.get(key).set(unitId, ws);
    if (AUDIO_DIAG) console.log(`[AudioRelay] WS_SUBSCRIBER_ADDED channelKey=${key} unitId=${unitId} totalWsSubs=${this._wsSubscribers.get(key).size}`);
  }

  removeWsSubscriber(channelId, unitId, wsInstance = null) {
    const key = canonicalChannelKey(channelId);
    const subs = this._wsSubscribers.get(key);
    if (subs && subs.has(unitId)) {
      subs.delete(unitId);
      if (subs.size === 0) this._wsSubscribers.delete(key);
      if (AUDIO_DIAG) console.log(`[AudioRelay] WS_SUBSCRIBER_REMOVED channelKey=${key} unitId=${unitId}`);
      return;
    }
    for (const [k, s] of this._wsSubscribers) {
      if (s.has(unitId)) {
        if (wsInstance && s.get(unitId) !== wsInstance) continue;
        s.delete(unitId);
        if (s.size === 0) this._wsSubscribers.delete(k);
        if (AUDIO_DIAG) console.log(`[AudioRelay] WS_SUBSCRIBER_REMOVED channelKey=${k} unitId=${unitId} (fallback from requested key=${key})`);
        return;
      }
    }
  }

  removeAllWsSubscriptions(unitId) {
    for (const [key, subs] of this._wsSubscribers) {
      subs.delete(unitId);
      if (subs.size === 0) this._wsSubscribers.delete(key);
    }
  }

  addAudioListener(channelId, listenerId, callback) {
    const key = canonicalChannelKey(channelId);
    if (!this._audioListeners.has(key)) this._audioListeners.set(key, new Map());
    this._audioListeners.get(key).set(listenerId, callback);
  }

  removeAudioListener(channelId, listenerId) {
    const key = canonicalChannelKey(channelId);
    const listeners = this._audioListeners.get(key);
    if (!listeners) return;
    listeners.delete(listenerId);
    if (listeners.size === 0) this._audioListeners.delete(key);
  }

  removeAllAudioListeners(listenerId) {
    for (const [channelId, listeners] of this._audioListeners) {
      listeners.delete(listenerId);
      if (listeners.size === 0) this._audioListeners.delete(channelId);
    }
  }

  injectAudio(channelId, senderUnitId, sequence, opusPayload, rawPcmSamples = null) {
    const channelKey = canonicalChannelKey(channelId);
    const resolvedChannelId = this._resolveChannelIdNumeric({ channelKey, channelIdNumeric: channelId });
    this.trackAudioReceived(channelKey, senderUnitId);

    if (AUDIO_DIAG && sequence % 100 === 0) {
      console.log(`[AudioRelay] INJECT_AUDIO channelKey=${channelKey} sender=${senderUnitId} seq=${sequence} numericId=${resolvedChannelId}`);
    }

    const rxPayload = this._buildRelayPacket({
      channelKey,
      channelIdNumeric: resolvedChannelId,
      senderUnitId,
      sequence,
      opusPayload,
      flags: FLAG_FEC_HINT,
      timestampMs: Date.now(),
    });

    this._broadcastToAll(channelKey, senderUnitId, rxPayload, sequence, opusPayload, resolvedChannelId, null, rawPcmSamples);
  }

  _buildBinaryWsFrame(sequence, channelKey, senderUnitId, pcmInt16View) {
    const channelBytes = Buffer.from(channelKey.slice(0, 255), 'utf8');
    const senderBytes = Buffer.from(senderUnitId.slice(0, 255), 'utf8');
    const headerLen = 1 + 4 + 1 + channelBytes.length + 1 + senderBytes.length;
    const pcmBytes = pcmInt16View.length * 2;
    const buf = Buffer.alloc(headerLen + pcmBytes);
    let offset = 0;
    buf[offset++] = WS_BINARY_MARKER;
    buf.writeUInt32LE(sequence, offset); offset += 4;
    buf[offset++] = channelBytes.length;
    channelBytes.copy(buf, offset); offset += channelBytes.length;
    buf[offset++] = senderBytes.length;
    senderBytes.copy(buf, offset); offset += senderBytes.length;
    const pcmBuf = Buffer.from(pcmInt16View.buffer, pcmInt16View.byteOffset, pcmInt16View.byteLength);
    pcmBuf.copy(buf, offset);
    return buf;
  }

  _buildBinaryWsFrameOpus(sequence, channelKey, senderUnitId, opusPayload) {
    const channelBytes = Buffer.from(channelKey.slice(0, 255), 'utf8');
    const senderBytes = Buffer.from(senderUnitId.slice(0, 255), 'utf8');
    const headerLen = 1 + 4 + 1 + channelBytes.length + 1 + senderBytes.length;
    const payloadLen = opusPayload.length;
    const buf = Buffer.alloc(headerLen + payloadLen);
    let offset = 0;
    buf[offset++] = WS_BINARY_MARKER_OPUS;
    buf.writeUInt32LE(sequence, offset); offset += 4;
    buf[offset++] = channelBytes.length;
    channelBytes.copy(buf, offset); offset += channelBytes.length;
    buf[offset++] = senderBytes.length;
    senderBytes.copy(buf, offset); offset += senderBytes.length;
    if (Buffer.isBuffer(opusPayload)) {
      opusPayload.copy(buf, offset);
    } else {
      buf.set(opusPayload, offset);
    }
    return buf;
  }

  _broadcastToAll(channelKey, senderUnitId, rxPayload, sequence, opusPayload, channelIdNumeric = null, resolvedSender = null, rawPcmSamples = null) {
    if (AUDIO_DIAG && sequence % 100 === 0) {
      const udpKeys = [...this.subscribers.keys()];
      const wsKeys = [...this._wsSubscribers.keys()];
      const listenerKeys = [...this._audioListeners.keys()];
      console.log(`[AudioRelay] BROADCAST channelKey=${channelKey} sender=${senderUnitId} seq=${sequence} udpChannels=[${udpKeys.join(',')}] wsChannels=[${wsKeys.join(',')}] listenerChannels=[${listenerKeys.join(',')}]`);
    }

    const udpSubs = this.subscribers.get(channelKey);
    if (udpSubs) {
      for (const [subUnitId, subInfo] of udpSubs) {
        if (subUnitId === senderUnitId) continue;
        subInfo.lastSeen = Date.now();
        try {
          this.socket.send(rxPayload, 0, rxPayload.length, subInfo.port, subInfo.address);
        } catch (err) {
          console.error(`[AudioRelay] Send error to ${subUnitId}:`, err.message);
        }
      }
    }

    const listeners = this._audioListeners.get(channelKey);
    if (listeners) {
      for (const [listenerId, callback] of listeners) {
        if (listenerId === senderUnitId) continue;
        try {
          callback({ channelId: channelKey, unitId: senderUnitId, sequence, opusPayload, timestamp: Date.now() });
        } catch (err) {
          console.error(`[AudioRelay] Listener error for ${listenerId}:`, err.message);
        }
      }
    }

    {
      const wsSubs = this._wsSubscribers.get(channelKey);
      if (wsSubs && wsSubs.size > 0) {
        const binaryFrame = this._buildBinaryWsFrameOpus(sequence, channelKey, senderUnitId, opusPayload);
        this._enqueueWsFrame(channelKey, senderUnitId, binaryFrame);
      }
    }

    if (this._recordingTap) {
      try {
        this._recordingTap({ channelId: channelKey, unitId: senderUnitId, sequence, opusPayload, timestamp: Date.now() });
      } catch (err) {
        console.error('[AudioRelay] Recording tap error:', err.message);
      }
    }
  }

  _enqueueWsFrame(channelKey, senderUnitId, packetBuf) {
    let queue = this._wsPacingQueues.get(channelKey);
    if (!queue) {
      queue = [];
      this._wsPacingQueues.set(channelKey, queue);
    }
    if (queue.length >= WS_PACING_MAX_QUEUE) {
      queue.shift();
      this._trackWsRelayFrame(channelKey, 'drop');
      console.warn(`[AudioRelay] WS_PACING_FRAME_DROPPED channelId=${channelKey} queueDepth=${queue.length} maxQueue=${WS_PACING_MAX_QUEUE}`);
    }
    queue.push({ senderUnitId, packetBuf });
    this._trackWsRelayFrame(channelKey, 'enqueue');
    this._startWsRelayStatsTimer();

    if (!this._wsPacingTimers.has(channelKey)) {
      this._wsPacingDriftState.set(channelKey, { nextTick: Date.now() + WS_PACING_INTERVAL_MS });
      this._schedulePacingTick(channelKey);
    }
  }

  _schedulePacingTick(channelKey) {
    const drift = this._wsPacingDriftState.get(channelKey);
    if (!drift) return;
    const now = Date.now();
    const delay = Math.max(1, drift.nextTick - now);
    const timer = setTimeout(() => this._drainWsQueue(channelKey), delay);
    this._wsPacingTimers.set(channelKey, timer);
  }

  _drainWsQueue(channelKey) {
    const queue = this._wsPacingQueues.get(channelKey);
    if (!queue || queue.length === 0) {
      this._wsPacingTimers.delete(channelKey);
      this._wsPacingDriftState.delete(channelKey);
      this._wsPacingQueues.delete(channelKey);
      return;
    }

    const drift = this._wsPacingDriftState.get(channelKey);
    if (drift) {
      drift.nextTick += WS_PACING_INTERVAL_MS;
      const now = Date.now();
      if (drift.nextTick < now - WS_PACING_INTERVAL_MS * 3) {
        drift.nextTick = now + WS_PACING_INTERVAL_MS;
      }
    }

    const WS_PACING_BURST_THRESHOLD = 5;
    const WS_PACING_BURST_COUNT = 3;
    const framesToDrain = queue.length > WS_PACING_BURST_THRESHOLD
      ? Math.min(WS_PACING_BURST_COUNT, queue.length)
      : 1;

    if (framesToDrain > 1) {
      console.log(`[AudioRelay] WS_PACING_BURST channelKey=${channelKey} queueDepth=${queue.length} draining=${framesToDrain}`);
      this._trackWsRelayFrame(channelKey, 'burst');
    }

    for (let f = 0; f < framesToDrain; f++) {
      if (queue.length === 0) break;
      const frame = queue.shift();
      this._trackWsRelayFrame(channelKey, 'drain');
      const wsSubs = this._wsSubscribers.get(channelKey);

      let wsSentCount = 0;
      if (!wsSubs) {
        continue;
      }
      for (const [subUnitId, ws] of wsSubs) {
        if (subUnitId === frame.senderUnitId) continue;
        try {
          if (ws.readyState === 1) {
            ws.send(frame.packetBuf);
            wsSentCount++;
          }
        } catch (err) {
          console.error(`[AudioRelay] WS send error to ${subUnitId}:`, err.message);
        }
      }
      if (AUDIO_DIAG && wsSentCount > 0 && queue.length % 50 === 0) {
        console.log(`[AudioRelay] WS_RELAY channelKey=${channelKey} sender=${frame.senderUnitId} recipients=${wsSentCount} queueRemaining=${queue.length}`);
      }
    }

    if (queue.length > 0) {
      this._schedulePacingTick(channelKey);
    } else {
      this._wsPacingTimers.delete(channelKey);
      this._wsPacingDriftState.delete(channelKey);
      this._wsPacingQueues.delete(channelKey);
    }
  }

  start(port, retries = 3, delay = 3000) {
    this.port = port || this.port;

    return new Promise((resolve, reject) => {
      const bindWithRetry = (remaining) => {
        this.socket = dgram.createSocket('udp4');
        this.socket.on('message', (msg, rinfo) => this._handlePacket(msg, rinfo));

        this.socket.once('error', (err) => {
          if (err.code === 'EADDRINUSE' && remaining > 0) {
            try { this.socket.close(); } catch (_) {}
            this.socket = null;
            setTimeout(() => bindWithRetry(remaining - 1), delay);
          } else {
            reject(err);
          }
        });

        this.socket.bind(this.port, '0.0.0.0', () => {
          this.socket.removeAllListeners('error');
          this.socket.on('error', (err) => console.error('[AudioRelay] Socket error:', err.message));
          resolve();
        });
      };

      bindWithRetry(retries);
    }).then(() => {
      this._sweepTimer = setInterval(() => this._sweepStaleSubscribers(), SUBSCRIBER_SWEEP_INTERVAL_MS);
      this._sweepTimer.unref?.();
      this._txWatchdogTimer = setInterval(() => this._checkTxWatchdog(), TX_WATCHDOG_INTERVAL_MS);
      this._txWatchdogTimer.unref?.();
    });
  }

  stop() {
    if (this._sweepTimer) {
      clearInterval(this._sweepTimer);
      this._sweepTimer = null;
    }
    if (this._txWatchdogTimer) {
      clearInterval(this._txWatchdogTimer);
      this._txWatchdogTimer = null;
    }
    this._stopWsRelayStatsTimer();
    for (const [, timer] of this._wsPacingTimers) {
      clearTimeout(timer);
    }
    this._wsPacingTimers.clear();
    this._wsPacingDriftState.clear();
    this._wsPacingQueues.clear();
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  trackAudioReceived(channelKey, unitId) {
    const key = `${channelKey}::${unitId}`;
    this._lastAudioReceived.set(key, Date.now());
    if (this._txWatchdogAlerted.has(key)) {
      this._txWatchdogAlerted.delete(key);
      console.log(`[AudioRelay] TX_WATCHDOG_RECOVERED unitId=${unitId} channelKey=${channelKey}`);
    }
  }

  clearTxWatchdog(channelKey, unitId, reason = 'ptt_release') {
    const key = `${channelKey}::${unitId}`;
    this._lastAudioReceived.delete(key);
    this._txWatchdogAlerted.delete(key);
    this._finalizeTxSessionStats(channelKey, unitId, reason);
    this._logWsRelayStats(channelKey, 'tx_session_end');
  }

  _initTxSessionStats(channelKey, unitId) {
    const key = `${channelKey}::${unitId}`;
    this._txSessionStats.set(key, {
      channelKey,
      unitId,
      startTime: Date.now(),
      firstSeq: null,
      lastSeq: null,
      totalFrames: 0,
      maxConsecutiveGap: 0,
      lastReceivedSeq: null,
      interArrivalTimes: [],
      lastArrivalTime: null,
      minPacketSize: Infinity,
      maxPacketSize: 0,
      totalPacketBytes: 0,
    });
  }

  _trackTxPacket(channelKey, unitId, sequence, packetSize) {
    const key = `${channelKey}::${unitId}`;
    let stats = this._txSessionStats.get(key);
    if (!stats) {
      this._initTxSessionStats(channelKey, unitId);
      stats = this._txSessionStats.get(key);
    }

    stats.totalFrames++;
    if (stats.firstSeq === null) stats.firstSeq = sequence;
    stats.lastSeq = sequence;

    if (stats.lastReceivedSeq !== null) {
      const gap = ((sequence - stats.lastReceivedSeq) & 0xFFFF);
      if (gap > 1 && gap < 0x8000) {
        if (gap - 1 > stats.maxConsecutiveGap) stats.maxConsecutiveGap = gap - 1;
      }
    }
    stats.lastReceivedSeq = sequence;

    const now = Date.now();
    if (stats.lastArrivalTime !== null) {
      stats.interArrivalTimes.push(now - stats.lastArrivalTime);
      if (stats.interArrivalTimes.length > 1000) {
        stats.interArrivalTimes = stats.interArrivalTimes.slice(-500);
      }
    }
    stats.lastArrivalTime = now;

    if (packetSize < stats.minPacketSize) stats.minPacketSize = packetSize;
    if (packetSize > stats.maxPacketSize) stats.maxPacketSize = packetSize;
    stats.totalPacketBytes += packetSize;

    const logKey = key;
    let counter = this._txPacketLogCounters.get(logKey) || 0;
    counter++;
    this._txPacketLogCounters.set(logKey, counter);

    if (counter <= 5) {
      console.log(`[AudioRelay] PACKET_DETAIL unitId=${unitId} channelKey=${channelKey} seq=${sequence} packetBytes=${packetSize} frame=${counter}`);
    } else {
      const lastSummary = this._txPacketLogLastSummary.get(logKey) || 0;
      if (now - lastSummary >= 1000) {
        const interval = this._txPacketIntervalStats.get(logKey) || { frames: 0, bytes: 0 };
        this._txPacketLogLastSummary.set(logKey, now);
        console.log(`[AudioRelay] PACKET_SUMMARY unitId=${unitId} channelKey=${channelKey} intervalFrames=${interval.frames} intervalAvgBytes=${interval.frames > 0 ? Math.round(interval.bytes / interval.frames) : 0} totalFrames=${stats.totalFrames} lastSeq=${sequence}`);
        this._txPacketIntervalStats.set(logKey, { frames: 0, bytes: 0 });
      }
    }

    const interval = this._txPacketIntervalStats.get(logKey) || { frames: 0, bytes: 0 };
    interval.frames++;
    interval.bytes += packetSize;
    this._txPacketIntervalStats.set(logKey, interval);
  }

  _finalizeTxSessionStats(channelKey, unitId, reason) {
    const key = `${channelKey}::${unitId}`;
    const stats = this._txSessionStats.get(key);
    if (!stats || stats.totalFrames === 0) {
      this._txSessionStats.delete(key);
      this._txPacketLogCounters.delete(key);
      this._txPacketLogLastSummary.delete(key);
      this._txPacketIntervalStats.delete(key);
      return;
    }

    const duration = Date.now() - stats.startTime;
    const expectedFrames = stats.firstSeq !== null && stats.lastSeq !== null
      ? ((stats.lastSeq - stats.firstSeq + 1 + 0x10000) % 0x10000)
      : stats.totalFrames;
    const lossCount = Math.max(0, expectedFrames - stats.totalFrames);
    const lossPct = expectedFrames > 0 ? ((lossCount / expectedFrames) * 100).toFixed(1) : '0.0';
    const avgInterArrival = stats.interArrivalTimes.length > 0
      ? (stats.interArrivalTimes.reduce((a, b) => a + b, 0) / stats.interArrivalTimes.length).toFixed(1)
      : 'N/A';

    const summary = {
      channelKey,
      unitId,
      reason,
      durationMs: duration,
      firstSeq: stats.firstSeq,
      lastSeq: stats.lastSeq,
      totalFrames: stats.totalFrames,
      expectedFrames,
      lossCount,
      lossPct: parseFloat(lossPct),
      maxConsecutiveGap: stats.maxConsecutiveGap,
      avgInterArrivalMs: avgInterArrival === 'N/A' ? avgInterArrival : parseFloat(avgInterArrival),
      minPacketBytes: stats.minPacketSize === Infinity ? 0 : stats.minPacketSize,
      maxPacketBytes: stats.maxPacketSize,
    };

    console.log(`[AudioRelay] TX_SESSION_STATS ${JSON.stringify(summary)}`);

    this._txSessionStats.delete(key);
    this._txPacketLogCounters.delete(key);
    this._txPacketLogLastSummary.delete(key);
    this._txPacketIntervalStats.delete(key);
  }

  _trackWsRelayFrame(channelKey, action, count = 1) {
    if (!this._wsRelayStats.has(channelKey)) {
      this._wsRelayStats.set(channelKey, {
        framesEnqueued: 0,
        framesDropped: 0,
        framesDrained: 0,
        burstDrains: 0,
        lastLogTime: Date.now(),
      });
    }
    const s = this._wsRelayStats.get(channelKey);
    if (action === 'enqueue') s.framesEnqueued += count;
    else if (action === 'drop') s.framesDropped += count;
    else if (action === 'drain') s.framesDrained += count;
    else if (action === 'burst') s.burstDrains += count;
  }

  _logWsRelayStats(channelKey, reason = 'periodic') {
    const s = this._wsRelayStats.get(channelKey);
    if (!s) return;
    if (s.framesEnqueued === 0 && s.framesDrained === 0 && s.framesDropped === 0) return;
    const queueDepth = this._wsPacingQueues.has(channelKey) ? this._wsPacingQueues.get(channelKey).length : 0;
    const wsSubCount = this._wsSubscribers.has(channelKey) ? this._wsSubscribers.get(channelKey).size : 0;
    console.log(`[AudioRelay] WS_RELAY_STATS ${JSON.stringify({
      channelKey,
      reason,
      framesEnqueued: s.framesEnqueued,
      framesDropped: s.framesDropped,
      framesDrained: s.framesDrained,
      burstDrains: s.burstDrains,
      queueDepth,
      wsSubscribers: wsSubCount,
    })}`);
    s.framesEnqueued = 0;
    s.framesDropped = 0;
    s.framesDrained = 0;
    s.burstDrains = 0;
  }

  _startWsRelayStatsTimer() {
    if (this._wsRelayStatsTimer) return;
    this._wsRelayStatsTimer = setInterval(() => {
      for (const [channelKey, s] of this._wsRelayStats) {
        if (s.framesEnqueued > 0 || s.framesDrained > 0) {
          this._logWsRelayStats(channelKey, 'periodic');
        }
      }
    }, 5000);
    this._wsRelayStatsTimer.unref?.();
  }

  _stopWsRelayStatsTimer() {
    if (this._wsRelayStatsTimer) {
      clearInterval(this._wsRelayStatsTimer);
      this._wsRelayStatsTimer = null;
    }
  }

  _checkTxWatchdog() {
    if (!this._signalingService) return;
    const now = Date.now();
    const activeTransmissions = this._signalingService.activeTransmissions;
    if (!activeTransmissions) return;
    for (const [channelId, transmission] of activeTransmissions) {
      const unitId = transmission.unitId;
      if (!unitId) continue;
      const key = `${channelId}::${unitId}`;
      const lastReceived = this._lastAudioReceived.get(key);
      const baseline = lastReceived || transmission.timestamp;
      if (!baseline) continue;
      if (!lastReceived && transmission.timestamp && (now - transmission.timestamp) < TX_WATCHDOG_GRACE_MS) continue;
      const silenceMs = now - baseline;
      if (silenceMs >= TX_WATCHDOG_SILENCE_THRESHOLD_MS && !this._txWatchdogAlerted.has(key)) {
        this._txWatchdogAlerted.add(key);
        console.warn(`[AudioRelay] TX_WATCHDOG_SILENCE unitId=${unitId} channelId=${channelId} silenceMs=${silenceMs} hadAudio=${!!lastReceived}`);
        this._finalizeTxSessionStats(channelId, unitId, 'silence_watchdog');
        this._logWsRelayStats(channelId, 'tx_session_end_watchdog');
        try {
          this._signalingService.emitTxSilenceWarning(channelId, unitId, silenceMs);
        } catch (err) {
          console.error(`[AudioRelay] TX_WATCHDOG_EMIT_ERROR: ${err.message}`);
        }
      }
    }
  }

  _sweepStaleSubscribers() {
    const now = Date.now();
    for (const [channelId, subs] of this.subscribers) {
      for (const [unitId, sub] of subs) {
        if (now - sub.lastSeen > SUBSCRIBER_TIMEOUT_MS) {
          const staleMs = now - sub.lastSeen;
          subs.delete(unitId);
          console.log(`[AudioRelay] SUBSCRIBER_STALE_REMOVED unitId=${unitId} channelId=${channelId} staleMs=${staleMs}`);
          if (this._signalingService) {
            try {
              this._signalingService.notifyUnitPotentiallyDisconnected(unitId, channelId);
            } catch (err) {
              console.warn(`[AudioRelay] Failed to notify signaling of stale subscriber: ${err.message}`);
            }
          }
        }
      }
      if (subs.size === 0) this.subscribers.delete(channelId);
    }
    for (const [key, ts] of this._senderLastSeqTime) {
      if (now - ts > SUBSCRIBER_TIMEOUT_MS) {
        this._senderLastSeq.delete(key);
        this._senderLastSeqTime.delete(key);
      }
    }
  }

  _handlePacket(msg, rinfo) {
    if (msg.length < RADIO_HEADER_FIXED_LEN) return;

    const parsed = this._parsePacket(msg, 0);
    if (!parsed) return;
    const { channelId: channelIdNumeric, sequence, opusPayload, flags, timestampMs, senderUnitId } = parsed;

    if (!senderUnitId) return;

    const channelKey = this._resolveChannelKeyFromNumeric(channelIdNumeric);
    if (!channelKey) {
      if (sequence % 50 === 0) {
        console.warn(`[AudioRelay] PACKET_UNRESOLVED_CHANNEL numericId=${channelIdNumeric} sender=${senderUnitId} knownNumerics=[${[...this._channelKeyByNumeric.keys()].join(',')}]`);
      }
      return;
    }

    if (AUDIO_DIAG && sequence % 100 === 0) {
      console.log(`[AudioRelay] PACKET_RECEIVED numericId=${channelIdNumeric} resolvedKey=${channelKey} sender=${senderUnitId} seq=${sequence} from=${rinfo.address}:${rinfo.port}`);
    }

    this.addSubscriber(channelKey, senderUnitId, rinfo.address, rinfo.port);

    if (!opusPayload || opusPayload.length === 0) {
      console.log(`[Signaling] KEEPALIVE_OK unitId=${senderUnitId} channelKey=${channelKey} addr=${rinfo.address}:${rinfo.port}`);
      return;
    }

    const resolvedChannelId = this._resolveChannelIdNumeric({ channelKey, channelIdNumeric });

    const senderSeqKey = `${channelKey}::${senderUnitId}`;
    const lastSeqEntry = this._senderLastSeq.get(senderSeqKey);
    const seqForward = lastSeqEntry !== undefined ? ((sequence - lastSeqEntry) & 0xFFFF) : 0;
    const isForward = lastSeqEntry === undefined || (seqForward > 0 && seqForward < 0x8000);
    if (isForward) {
      this._senderLastSeq.set(senderSeqKey, sequence);
      this._senderLastSeqTime.set(senderSeqKey, Date.now());
    } else if (lastSeqEntry === undefined) {
      this._senderLastSeq.set(senderSeqKey, sequence);
      this._senderLastSeqTime.set(senderSeqKey, Date.now());
    }

    const rxPayload = this._buildRelayPacket({
      channelKey,
      channelIdNumeric: resolvedChannelId,
      senderUnitId,
      sequence,
      opusPayload,
      flags,
      timestampMs,
    });

    this._trackTxPacket(channelKey, senderUnitId, sequence, msg.length);
    this.trackAudioReceived(channelKey, senderUnitId);
    this._broadcastToAll(channelKey, senderUnitId, rxPayload, sequence, opusPayload, resolvedChannelId, senderUnitId);
  }

  _resolveChannelKeyFromNumeric(numericId) {
    return this._channelKeyByNumeric.get(numericId) || null;
  }


  _resolveChannelIdNumeric({ channelKey, channelIdNumeric }) {
    const candidate = Number.parseInt(String(channelIdNumeric ?? '').trim(), 10);
    if (!Number.isNaN(candidate)) return candidate;

    const fromKey = Number.parseInt(String(channelKey ?? '').trim(), 10);
    if (!Number.isNaN(fromKey)) return fromKey;

    const mapped = this._channelNumericByKey.get(canonicalChannelKey(channelKey));
    if (mapped != null && !Number.isNaN(mapped)) return mapped;

    return 0;
  }

  _buildRelayPacket({ channelKey, channelIdNumeric, senderUnitId, sequence, opusPayload, flags = FLAG_FEC_HINT, timestampMs = Date.now() }) {
    let channelIdNum = this._resolveChannelIdNumeric({ channelKey, channelIdNumeric });
    if (channelIdNum === 0) {
      const fallback = this._channelNumericByKey.get(canonicalChannelKey(channelKey));
      if (fallback != null && !Number.isNaN(fallback) && fallback > 0) {
        channelIdNum = fallback;
      }
    }
    if (channelIdNum === 0) {
      const now = Date.now();
      const lastWarn = this._zeroChannelWarnTimes.get(channelKey) || 0;
      if (now - lastWarn >= 30000) {
        this._zeroChannelWarnTimes.set(channelKey, now);
        console.warn(`[AudioRelay] RELAY_CHANNEL_ID_ZERO channelKey=${channelKey} — receiver may drop this packet`);
        console.warn(`RADIO_RELAY_PACKET_ZERO_CHANNEL_WARNING roomKey=${channelKey} senderUnit=${senderUnitId || ''}`);
      }
    }
  
    const senderBytes = Buffer.from(senderUnitId || '', 'utf8').subarray(0, 255);
    const payloadLength = Math.min(opusPayload.length, 0xffff);
    const packet = Buffer.alloc(RADIO_HEADER_FIXED_LEN + senderBytes.length + payloadLength);
    let offset = 0;
    packet.writeUInt8(PACKET_VERSION, offset); offset += VERSION_LEN;
    packet.writeUInt8(flags & 0xff, offset); offset += FLAGS_LEN;
    packet.writeUInt16BE(channelIdNum & 0xffff, offset); offset += CHANNEL_ID_LEN;
    packet.writeUInt16BE(sequence & 0xffff, offset); offset += SEQUENCE_LEN;
    packet.writeUInt32BE((timestampMs >>> 0), offset); offset += TIMESTAMP_LEN;
    packet.writeUInt8(senderBytes.length, offset); offset += SENDER_LEN_LEN;
    senderBytes.copy(packet, offset); offset += senderBytes.length;
    packet.writeUInt16BE(payloadLength, offset); offset += PAYLOAD_LEN_LEN;
    opusPayload.copy(packet, offset, 0, payloadLength);
    return packet;
  }

  _parsePacket(msg, startOffset = 0) {
    if (msg.length < startOffset + RADIO_HEADER_FIXED_LEN) return null;
    let offset = startOffset;
    const version = msg.readUInt8(offset); offset += VERSION_LEN;
    if (version !== PACKET_VERSION) return null;
    const flags = msg.readUInt8(offset); offset += FLAGS_LEN;
    const channelId = msg.readUInt16BE(offset); offset += CHANNEL_ID_LEN;
    const sequence = msg.readUInt16BE(offset); offset += SEQUENCE_LEN;
    const timestampMs = msg.readUInt32BE(offset); offset += TIMESTAMP_LEN;
    const senderLen = msg.readUInt8(offset); offset += SENDER_LEN_LEN;
    if (msg.length < offset + senderLen + PAYLOAD_LEN_LEN) return null;
    const senderUnitId = msg.subarray(offset, offset + senderLen).toString('utf8');
    offset += senderLen;
    const payloadLength = msg.readUInt16BE(offset); offset += PAYLOAD_LEN_LEN;
    if (payloadLength < 0 || msg.length < offset + payloadLength) return null;
    const opusPayload = payloadLength > 0 ? msg.subarray(offset, offset + payloadLength) : Buffer.alloc(0);
    return { channelId, sequence, timestampMs, flags, senderUnitId, opusPayload };
  }
}

export const audioRelayService = new AudioRelayService();
