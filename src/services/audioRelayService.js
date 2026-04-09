import dgram from 'dgram';
import { canonicalChannelKey } from './channelKeyUtils.js';
import { opusCodec } from './opusCodec.js';

const SESSION_TOKEN_LEN = 16;
const VERSION_LEN = 1;
const FLAGS_LEN = 1;
const CHANNEL_ID_LEN = 2;
const SEQUENCE_LEN = 2;
const TIMESTAMP_LEN = 4;
const SENDER_LEN_LEN = 1;
const PAYLOAD_LEN_LEN = 2;
const RADIO_HEADER_FIXED_LEN = VERSION_LEN + FLAGS_LEN + CHANNEL_ID_LEN + SEQUENCE_LEN + TIMESTAMP_LEN + SENDER_LEN_LEN + PAYLOAD_LEN_LEN;
const HEADER_LEN = SESSION_TOKEN_LEN + RADIO_HEADER_FIXED_LEN;
const PACKET_VERSION = 1;
const FLAG_FEC_HINT = 0x01;
const SUBSCRIBER_TIMEOUT_MS = 120000;
const SUBSCRIBER_SWEEP_INTERVAL_MS = 30000;

const WS_PACING_INTERVAL_MS = 20;
const WS_PACING_MAX_QUEUE = 25;
const PCM_FRAME_SAMPLES = 960;
const WS_BINARY_MARKER = 0x01;

class AudioRelayService {
  constructor() {
    this.socket = null;
    this.port = 5100;
    this.subscribers = new Map();
    this.sessionTokens = new Map();
    this._floorControlService = null;
    this._recordingTap = null;
    this._sweepTimer = null;
    this._audioListeners = new Map();
    this._channelNumericByKey = new Map();
    this._earlyAudioBuffers = new Map();
    this._earlyBufferMaxMs = 3000;
    this._earlyBufferMaxFrames = 150;
    this._wsPacingQueues = new Map();
    this._wsPacingTimers = new Map();
  }

  setFloorControlService(fcs) {
    this._floorControlService = fcs;
  }

  onRecordingTap(callback) {
    this._recordingTap = callback;
  }

  registerSession(unitId, token, allowedChannelId, allowedChannelNumeric = null) {
    const allowedChannelKey = canonicalChannelKey(allowedChannelId);
    const resolvedChannelId = this._resolveChannelIdNumeric({
      channelKey: allowedChannelKey,
      channelIdNumeric: allowedChannelNumeric,
    });
    if (allowedChannelKey && resolvedChannelId > 0) {
      this._channelNumericByKey.set(allowedChannelKey, resolvedChannelId);
    }

    this.sessionTokens.set(token, {
      unitId,
      allowedChannel: allowedChannelKey,
      allowedChannelNumeric: resolvedChannelId,
      createdAt: Date.now(),
    });
  }

  removeSession(token) {
    this.sessionTokens.delete(token);
  }

  removeSessionsByUnit(unitId) {
    for (const [token, info] of this.sessionTokens) {
      if (info.unitId === unitId) this.sessionTokens.delete(token);
    }
  }

  addSubscriber(channelId, unitId, address, port) {
    if (!this.subscribers.has(channelId)) this.subscribers.set(channelId, new Map());
    this.subscribers.get(channelId).set(unitId, { address, port, lastSeen: Date.now() });
  }

  refreshSubscriber(channelId, unitId) {
    const subs = this.subscribers.get(channelId);
    if (!subs) return;
    const sub = subs.get(unitId);
    if (sub) sub.lastSeen = Date.now();
  }

  removeSubscriber(channelId, unitId) {
    const subs = this.subscribers.get(channelId);
    if (!subs) return;
    subs.delete(unitId);
    if (subs.size === 0) this.subscribers.delete(channelId);
  }

  removeAllSubscriptions(unitId) {
    for (const [channelId, subs] of this.subscribers) {
      subs.delete(unitId);
      if (subs.size === 0) this.subscribers.delete(channelId);
    }
  }

  addWsSubscriber(channelId, unitId, ws) {
    const key = canonicalChannelKey(channelId);
    if (!this._wsSubscribers) this._wsSubscribers = new Map();
    if (!this._wsSubscribers.has(key)) this._wsSubscribers.set(key, new Map());
    this._wsSubscribers.get(key).set(unitId, ws);
  
  }

  removeWsSubscriber(channelId, unitId) {
    const key = canonicalChannelKey(channelId);
    if (!this._wsSubscribers) return;
    const subs = this._wsSubscribers.get(key);
    if (!subs) return;
    subs.delete(unitId);
    if (subs.size === 0) this._wsSubscribers.delete(key);
  
  }

  removeAllWsSubscriptions(unitId) {
    if (!this._wsSubscribers) return;
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

    if (this._floorControlService && !this._floorControlService.holdsFloor(channelKey, senderUnitId)) {
      const bufKey = `${channelKey}:${senderUnitId}`;
      let buf = this._earlyAudioBuffers.get(bufKey);
      if (!buf) {
        buf = [];
        this._earlyAudioBuffers.set(bufKey, buf);
      }
      const now = Date.now();
      while (buf.length > 0 && (now - buf[0].bufferedAt) > this._earlyBufferMaxMs) {
        buf.shift();
      }
      if (buf.length < this._earlyBufferMaxFrames) {
        buf.push({ channelKey, channelIdNumeric: resolvedChannelId, senderUnitId, sequence, opusPayload, flags: FLAG_FEC_HINT, timestampMs: Date.now(), bufferedAt: now, rawPcmSamples });
      }
      return;
    }

    const bufKey = `${channelKey}:${senderUnitId}`;
    const earlyBuf = this._earlyAudioBuffers.get(bufKey);
    if (earlyBuf && earlyBuf.length > 0) {
      const now = Date.now();
      const freshFrames = earlyBuf.filter(pkt => (now - pkt.bufferedAt) <= this._earlyBufferMaxMs);
      if (freshFrames.length > 0) {
        for (const pkt of freshFrames) {
          const earlyPayload = this._buildRelayPacket(pkt);
          this._broadcastToAll(pkt.channelKey, pkt.senderUnitId, earlyPayload, pkt.sequence, pkt.opusPayload, pkt.channelIdNumeric, null, pkt.rawPcmSamples);
        }
      }
      this._earlyAudioBuffers.delete(bufKey);
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

  _broadcastToAll(channelKey, senderUnitId, rxPayload, sequence, opusPayload, channelIdNumeric = null, resolvedSender = null, rawPcmSamples = null) {
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

    if (this._wsSubscribers) {
      const wsSubs = this._wsSubscribers.get(channelKey);
      if (wsSubs && wsSubs.size > 0) {
        let int16View = null;
        if (rawPcmSamples) {
          int16View = (rawPcmSamples instanceof Int16Array) ? rawPcmSamples : new Int16Array(rawPcmSamples);
        } else {
          try {
            const pcmBuf = opusCodec.decodeOpusToPcm(opusPayload, resolvedSender || senderUnitId);
            int16View = new Int16Array(pcmBuf.buffer, pcmBuf.byteOffset, pcmBuf.byteLength / 2);
          } catch (err) {
            console.error(`[AudioRelay] Opus→PCM decode error: ${err.message}`);
          }
        }
        if (int16View) {
          const binaryFrame = this._buildBinaryWsFrame(sequence, channelKey, senderUnitId, int16View);
          this._enqueueWsFrame(channelKey, senderUnitId, binaryFrame);
        }
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

  _broadcastToAllDirect(channelKey, senderUnitId, rxPayload, sequence, opusPayload, channelIdNumeric = null, resolvedSender = null) {
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

    if (this._wsSubscribers) {
      const wsSubs = this._wsSubscribers.get(channelKey);
      if (wsSubs && wsSubs.size > 0) {
        let int16View = null;
        try {
          const pcmBuf = opusCodec.decodeOpusToPcm(opusPayload, resolvedSender || senderUnitId);
          int16View = new Int16Array(pcmBuf.buffer, pcmBuf.byteOffset, pcmBuf.byteLength / 2);
        } catch (err) {
          console.error(`[AudioRelay] Opus→PCM decode error: ${err.message}`);
        }
        if (int16View) {
          const binaryFrame = this._buildBinaryWsFrame(sequence, channelKey, senderUnitId, int16View);
          for (const [subUnitId, ws] of wsSubs) {
            if (subUnitId === senderUnitId) continue;
            try {
              if (ws.readyState === 1) {
                ws.send(binaryFrame);
              }
            } catch (err) {
              console.error(`[AudioRelay] WS send error to ${subUnitId}:`, err.message);
            }
          }
        }
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
      console.warn(`[AudioRelay] WS_PACING_FRAME_DROPPED channelId=${channelKey} queueDepth=${queue.length} maxQueue=${WS_PACING_MAX_QUEUE}`);
    }
    queue.push({ senderUnitId, packetBuf });

    if (!this._wsPacingTimers.has(channelKey)) {
      const timer = setInterval(() => this._drainWsQueue(channelKey), WS_PACING_INTERVAL_MS);
      this._wsPacingTimers.set(channelKey, timer);
    }
  }

  _drainWsQueue(channelKey) {
    const queue = this._wsPacingQueues.get(channelKey);
    if (!queue || queue.length === 0) {
      const timer = this._wsPacingTimers.get(channelKey);
      if (timer) {
        clearInterval(timer);
        this._wsPacingTimers.delete(channelKey);
      }
      this._wsPacingQueues.delete(channelKey);
      return;
    }

    const frame = queue.shift();
    const wsSubs = this._wsSubscribers ? this._wsSubscribers.get(channelKey) : null;
    if (!wsSubs) return;

    for (const [subUnitId, ws] of wsSubs) {
      if (subUnitId === frame.senderUnitId) continue;
      try {
        if (ws.readyState === 1) {
          ws.send(frame.packetBuf);
        }
      } catch (err) {
        console.error(`[AudioRelay] WS send error to ${subUnitId}:`, err.message);
      }
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
    });
  }

  stop() {
    if (this._sweepTimer) {
      clearInterval(this._sweepTimer);
      this._sweepTimer = null;
    }
    for (const [, timer] of this._wsPacingTimers) {
      clearInterval(timer);
    }
    this._wsPacingTimers.clear();
    this._wsPacingQueues.clear();
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  _sweepStaleSubscribers() {
    const now = Date.now();
    for (const [channelId, subs] of this.subscribers) {
      for (const [unitId, sub] of subs) {
        if (now - sub.lastSeen > SUBSCRIBER_TIMEOUT_MS) subs.delete(unitId);
      }
      if (subs.size === 0) this.subscribers.delete(channelId);
    }
  }

  _handlePacket(msg, rinfo) {
    if (msg.length < HEADER_LEN) return;

    const token = msg.subarray(0, SESSION_TOKEN_LEN).toString('hex');
    const parsed = this._parsePacket(msg, SESSION_TOKEN_LEN);
    if (!parsed) return;
    const { sequence, opusPayload, flags, timestampMs, senderUnitId } = parsed;

    const session = this.sessionTokens.get(token);
    if (!session) return;

    const { unitId, allowedChannel, allowedChannelNumeric } = session;
    const channelKey = canonicalChannelKey(allowedChannel);
    const resolvedChannelId = this._resolveChannelIdNumeric({ channelKey, channelIdNumeric: allowedChannelNumeric });
  

    this.addSubscriber(channelKey, unitId, rinfo.address, rinfo.port);

    if (!opusPayload || opusPayload.length === 0) {
      console.log(`[Signaling] KEEPALIVE_OK unitId=${unitId} channelKey=${channelKey} addr=${rinfo.address}:${rinfo.port}`);
      return;
    }

    const resolvedSender = senderUnitId || unitId;

    if (this._floorControlService && !this._floorControlService.holdsFloor(channelKey, unitId)) {
      const bufKey = `${channelKey}:${unitId}`;
      let buf = this._earlyAudioBuffers.get(bufKey);
      if (!buf) {
        buf = [];
        this._earlyAudioBuffers.set(bufKey, buf);
      }
      const now = Date.now();
      while (buf.length > 0 && (now - buf[0].bufferedAt) > this._earlyBufferMaxMs) {
        buf.shift();
      }
      if (buf.length < this._earlyBufferMaxFrames) {
        buf.push({ channelKey, channelIdNumeric: resolvedChannelId, senderUnitId: resolvedSender, sequence, opusPayload, flags, timestampMs, bufferedAt: now });
      
      }
      return;
    }

    const bufKey = `${channelKey}:${unitId}`;
    const earlyBuf = this._earlyAudioBuffers.get(bufKey);
    if (earlyBuf && earlyBuf.length > 0) {
      const now = Date.now();
      const freshFrames = earlyBuf.filter(pkt => (now - pkt.bufferedAt) <= this._earlyBufferMaxMs);
      if (freshFrames.length > 0) {
      
        for (const pkt of freshFrames) {
          const earlyPayload = this._buildRelayPacket(pkt);
          this._broadcastToAllDirect(pkt.channelKey, unitId, earlyPayload, pkt.sequence, pkt.opusPayload, pkt.channelIdNumeric, pkt.senderUnitId);
        }
      }
      this._earlyAudioBuffers.delete(bufKey);
    }

    const rxPayload = this._buildRelayPacket({
      channelKey,
      channelIdNumeric: resolvedChannelId,
      senderUnitId: resolvedSender,
      sequence,
      opusPayload,
      flags,
      timestampMs,
    });

    this._broadcastToAll(channelKey, unitId, rxPayload, sequence, opusPayload, resolvedChannelId, resolvedSender);
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
    const channelIdNum = this._resolveChannelIdNumeric({ channelKey, channelIdNumeric });
    if (channelIdNum === 0) {
      console.warn(`[AudioRelay] RELAY_CHANNEL_ID_ZERO channelKey=${channelKey} — receiver may drop this packet`);
      console.warn(`RADIO_RELAY_PACKET_ZERO_CHANNEL_WARNING roomKey=${channelKey} senderUnit=${senderUnitId || ''}`);
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
