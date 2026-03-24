import dgram from 'dgram';
import { opusCodec } from './opusCodec.js';

const SESSION_TOKEN_LEN = 16;
const CHANNEL_ID_LEN = 2;
const SEQUENCE_LEN = 2;
const HEADER_LEN = SESSION_TOKEN_LEN + CHANNEL_ID_LEN + SEQUENCE_LEN;
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

    this.wsSubscribers = new Map();
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
      if (info.unitId === unitId) {
        this.sessionTokens.delete(token);
      }
    }
  }

  addSubscriber(channelId, unitId, address, port) {
    if (!this.subscribers.has(channelId)) {
      this.subscribers.set(channelId, new Map());
    }
    this.subscribers.get(channelId).set(unitId, {
      address,
      port,
      lastSeen: Date.now(),
    });
  }

  refreshSubscriber(channelId, unitId) {
    const subs = this.subscribers.get(channelId);
    if (subs) {
      const sub = subs.get(unitId);
      if (sub) {
        sub.lastSeen = Date.now();
      }
    }
  }

  removeSubscriber(channelId, unitId) {
    const subs = this.subscribers.get(channelId);
    if (subs) {
      subs.delete(unitId);
      if (subs.size === 0) {
        this.subscribers.delete(channelId);
      }
    }
  }

  removeAllSubscriptions(unitId) {
    for (const [channelId, subs] of this.subscribers) {
      subs.delete(unitId);
      if (subs.size === 0) {
        this.subscribers.delete(channelId);
      }
    }
  }

  addWsSubscriber(channelId, unitId, ws) {
    const key = String(channelId);
    if (!this.wsSubscribers.has(key)) {
      this.wsSubscribers.set(key, new Map());
    }
    this.wsSubscribers.get(key).set(unitId, { ws, lastSeen: Date.now() });
    console.log(`[AudioRelay] WS subscriber added: ${unitId} on channel ${key}`);
  }

  removeWsSubscriber(channelId, unitId) {
    const key = String(channelId);
    const subs = this.wsSubscribers.get(key);
    if (subs) {
      subs.delete(unitId);
      if (subs.size === 0) {
        this.wsSubscribers.delete(key);
      }
    }
    console.log(`[AudioRelay] WS subscriber removed: ${unitId} from channel ${key}`);
  }

  removeAllWsSubscriptions(unitId) {
    for (const [channelId, subs] of this.wsSubscribers) {
      subs.delete(unitId);
      if (subs.size === 0) {
        this.wsSubscribers.delete(channelId);
      }
    }
  }

  addAudioListener(channelId, listenerId, callback) {
    const key = String(channelId);
    if (!this._audioListeners.has(key)) {
      this._audioListeners.set(key, new Map());
    }
    this._audioListeners.get(key).set(listenerId, callback);
    console.log(`[AudioRelay] Internal listener added: ${listenerId} on channel ${key}`);
  }

  removeAudioListener(channelId, listenerId) {
    const key = String(channelId);
    const listeners = this._audioListeners.get(key);
    if (listeners) {
      listeners.delete(listenerId);
      if (listeners.size === 0) {
        this._audioListeners.delete(key);
      }
    }
    console.log(`[AudioRelay] Internal listener removed: ${listenerId} from channel ${key}`);
  }

  removeAllAudioListeners(listenerId) {
    for (const [channelId, listeners] of this._audioListeners) {
      listeners.delete(listenerId);
      if (listeners.size === 0) {
        this._audioListeners.delete(channelId);
      }
    }
  }

  injectAudio(channelId, senderUnitId, sequence, opusPayload) {
    const channelKey = String(channelId);

    if (this._floorControlService && !this._floorControlService.holdsFloor(channelKey, senderUnitId)) {
      if (sequence % 50 === 0) {
        console.warn(`[AudioRelay] injectAudio dropped: ${senderUnitId} does not hold floor on ${channelKey}`);
      }
      return;
    }

    const channelIdNum = parseInt(channelKey, 10);
    const rxPayload = Buffer.alloc(CHANNEL_ID_LEN + SEQUENCE_LEN + opusPayload.length);
    rxPayload.writeUInt16BE(isNaN(channelIdNum) ? 0 : channelIdNum, 0);
    rxPayload.writeUInt16BE(sequence & 0xFFFF, CHANNEL_ID_LEN);
    opusPayload.copy(rxPayload, CHANNEL_ID_LEN + SEQUENCE_LEN);

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

    const wsSubs = this.wsSubscribers.get(channelKey);
    if (wsSubs && wsSubs.size > 0) {
      let pcmFrame = null;
      try {
        const pcmData = opusCodec.decodeOpusToPcm(opusPayload);
        const channelIdNum = parseInt(channelKey, 10);
        pcmFrame = Buffer.alloc(4 + pcmData.length);
        pcmFrame.writeUInt16BE(isNaN(channelIdNum) ? 0 : channelIdNum, 0);
        pcmFrame.writeUInt16BE(sequence & 0xFFFF, 2);
        pcmData.copy(pcmFrame, 4);
      } catch (err) {
        console.error('[AudioRelay] Opus decode for WS broadcast error:', err.message);
      }

      if (pcmFrame) {
        for (const [subUnitId, subInfo] of wsSubs) {
          if (subUnitId === senderUnitId) continue;
          subInfo.lastSeen = Date.now();
          try {
            if (subInfo.ws.readyState === 1) {
              subInfo.ws.send(pcmFrame);
            }
          } catch (err) {
            console.error(`[AudioRelay] WS send error to ${subUnitId}:`, err.message);
          }
        }
      }
    }

    const listeners = this._audioListeners.get(channelKey);
    if (listeners) {
      for (const [listenerId, callback] of listeners) {
        if (listenerId === senderUnitId) continue;
        try {
          callback({
            channelId: channelKey,
            unitId: senderUnitId,
            sequence,
            opusPayload,
            timestamp: Date.now(),
          });
        } catch (err) {
          console.error(`[AudioRelay] Listener error for ${listenerId}:`, err.message);
        }
      }
    }

    if (this._recordingTap) {
      try {
        this._recordingTap({
          channelId: channelKey,
          unitId: senderUnitId,
          sequence,
          opusPayload,
          timestamp: Date.now(),
        });
      } catch (err) {
        console.error('[AudioRelay] Recording tap error:', err.message);
      }
    }
  }

  start(port) {
    this.port = port || this.port;
    this.socket = dgram.createSocket('udp4');

    this.socket.on('message', (msg, rinfo) => {
      this._handlePacket(msg, rinfo);
    });

    this.socket.on('error', (err) => {
      console.error('[AudioRelay] Socket error:', err.message);
    });

    this.socket.bind(this.port, '0.0.0.0', () => {
      console.log(`[AudioRelay] UDP relay listening on port ${this.port}`);
    });

    this._sweepTimer = setInterval(() => {
      this._sweepStaleSubscribers();
    }, SUBSCRIBER_SWEEP_INTERVAL_MS);
    this._sweepTimer.unref?.();
  }

  stop() {
    if (this._sweepTimer) {
      clearInterval(this._sweepTimer);
      this._sweepTimer = null;
    }
    if (this.socket) {
      this.socket.close();
      this.socket = null;
      console.log('[AudioRelay] UDP relay stopped');
    }
  }

  _sweepStaleSubscribers() {
    const now = Date.now();
    for (const [channelId, subs] of this.subscribers) {
      for (const [unitId, sub] of subs) {
        if (now - sub.lastSeen > SUBSCRIBER_TIMEOUT_MS) {
          subs.delete(unitId);
          console.log(`[AudioRelay] Timeout: removed subscriber ${unitId} from channel ${channelId}`);
        }
      }
      if (subs.size === 0) {
        this.subscribers.delete(channelId);
      }
    }

    for (const [channelId, subs] of this.wsSubscribers) {
      for (const [unitId, sub] of subs) {
        if (now - sub.lastSeen > SUBSCRIBER_TIMEOUT_MS) {
          subs.delete(unitId);
          console.log(`[AudioRelay] Timeout: removed WS subscriber ${unitId} from channel ${channelId}`);
        }
        if (sub.ws.readyState !== 1) {
          subs.delete(unitId);
          console.log(`[AudioRelay] Closed WS: removed subscriber ${unitId} from channel ${channelId}`);
        }
      }
      if (subs.size === 0) {
        this.wsSubscribers.delete(channelId);
      }
    }
  }

  _handlePacket(msg, rinfo) {
    if (msg.length < HEADER_LEN + 1) {
      return;
    }

    const tokenBuf = msg.subarray(0, SESSION_TOKEN_LEN);
    const token = tokenBuf.toString('hex');
    const channelId = msg.readUInt16BE(SESSION_TOKEN_LEN);
    const sequence = msg.readUInt16BE(SESSION_TOKEN_LEN + CHANNEL_ID_LEN);
    const opusPayload = msg.subarray(HEADER_LEN);

    const session = this.sessionTokens.get(token);
    if (!session) {
      return;
    }

    const { unitId, allowedChannel } = session;

    const channelKey = String(channelId);
    if (allowedChannel !== channelKey) {
      return;
    }

    if (this._floorControlService && !this._floorControlService.holdsFloor(channelKey, unitId)) {
      return;
    }

    const rxPayload = msg.subarray(SESSION_TOKEN_LEN);

    this._broadcastToAll(channelKey, unitId, rxPayload, sequence, opusPayload);
  }
}

export const audioRelayService = new AudioRelayService();
