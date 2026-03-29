import dgram from 'dgram';
import { canonicalChannelKey } from './channelKeyUtils.js';

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
  }

  setFloorControlService(fcs) {
    this._floorControlService = fcs;
  }

  onRecordingTap(callback) {
    this._recordingTap = callback;
  }

  registerSession(unitId, token, allowedChannelId) {
    this.sessionTokens.set(token, {
      unitId,
      allowedChannel: String(allowedChannelId),
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

  // Browser-WS audio path removed in teardown.
  addWsSubscriber() {}
  removeWsSubscriber() {}
  removeAllWsSubscriptions() {}

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

  injectAudio(channelId, senderUnitId, sequence, opusPayload) {
    const channelKey = canonicalChannelKey(channelId);

    if (this._floorControlService && !this._floorControlService.holdsFloor(channelKey, senderUnitId)) {
      return;
    }

    const rxPayload = this._buildRelayPacket({
      channelKey,
      senderUnitId,
      sequence,
      opusPayload,
      flags: FLAG_FEC_HINT,
      timestampMs: Date.now(),
    });

    this._broadcastToAll(channelKey, senderUnitId, rxPayload, sequence, opusPayload);
  }

  _broadcastToAll(channelKey, senderUnitId, rxPayload, sequence, opusPayload) {
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

    if (this._recordingTap) {
      try {
        this._recordingTap({ channelId: channelKey, unitId: senderUnitId, sequence, opusPayload, timestamp: Date.now() });
      } catch (err) {
        console.error('[AudioRelay] Recording tap error:', err.message);
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
    if (msg.length < HEADER_LEN + 1) return;

    const token = msg.subarray(0, SESSION_TOKEN_LEN).toString('hex');
    const parsed = this._parsePacket(msg, SESSION_TOKEN_LEN);
    if (!parsed) return;
    const { sequence, opusPayload, flags, timestampMs, senderUnitId } = parsed;

    const session = this.sessionTokens.get(token);
    if (!session) return;

    const { unitId, allowedChannel } = session;
    const channelKey = allowedChannel;

    if (this._floorControlService && !this._floorControlService.holdsFloor(channelKey, unitId)) return;

    this.addSubscriber(channelKey, unitId, rinfo.address, rinfo.port);

    const rxPayload = this._buildRelayPacket({
      channelKey,
      senderUnitId: senderUnitId || unitId,
      sequence,
      opusPayload,
      flags,
      timestampMs,
    });

    this._broadcastToAll(channelKey, unitId, rxPayload, sequence, opusPayload);
  }

  _buildRelayPacket({ channelKey, senderUnitId, sequence, opusPayload, flags = FLAG_FEC_HINT, timestampMs = Date.now() }) {
    const channelIdNum = parseInt(channelKey, 10);
    const senderBytes = Buffer.from(senderUnitId || '', 'utf8').subarray(0, 255);
    const payloadLength = Math.min(opusPayload.length, 0xffff);
    const packet = Buffer.alloc(RADIO_HEADER_FIXED_LEN + senderBytes.length + payloadLength);
    let offset = 0;
    packet.writeUInt8(PACKET_VERSION, offset); offset += VERSION_LEN;
    packet.writeUInt8(flags & 0xff, offset); offset += FLAGS_LEN;
    packet.writeUInt16BE(Number.isNaN(channelIdNum) ? 0 : channelIdNum, offset); offset += CHANNEL_ID_LEN;
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
    if (payloadLength <= 0 || msg.length < offset + payloadLength) return null;
    const opusPayload = msg.subarray(offset, offset + payloadLength);
    return { channelId, sequence, timestampMs, flags, senderUnitId, opusPayload };
  }
}

export const audioRelayService = new AudioRelayService();
