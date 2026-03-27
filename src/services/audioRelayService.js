import dgram from 'dgram';
import { canonicalChannelKey } from './channelKeyUtils.js';

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

    this._txSessions = new Map();
    this._relayCounters = new Map();
    this._txIdleTimer = null;
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
    const key = canonicalChannelKey(channelId);
    if (!this.wsSubscribers.has(key)) {
      this.wsSubscribers.set(key, new Map());
    }
    this.wsSubscribers.get(key).set(unitId, { ws, lastSeen: Date.now() });
    console.log(`[AudioRelay] WS subscriber added: ${unitId} on channel ${key}`);
  }

  removeWsSubscriber(channelId, unitId) {
    const key = canonicalChannelKey(channelId);
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
    const key = canonicalChannelKey(channelId);
    if (!this._audioListeners.has(key)) {
      this._audioListeners.set(key, new Map());
    }
    this._audioListeners.get(key).set(listenerId, callback);
    console.log(`[AudioRelay] Internal listener added: ${listenerId} on channel ${key}`);
  }

  removeAudioListener(channelId, listenerId) {
    const key = canonicalChannelKey(channelId);
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
    const channelKey = canonicalChannelKey(channelId);

    if (this._floorControlService && !this._floorControlService.holdsFloor(channelKey, senderUnitId)) {
      if (sequence % 50 === 0 || sequence < 3) {
        console.warn(`[AudioRelay] injectAudio dropped: ${senderUnitId} does not hold floor on channelKey="${channelKey}" seq=${sequence}`);
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

  _trackTxSession(channelKey, senderUnitId) {
    const txKey = `${senderUnitId}:${channelKey}`;
    const now = Date.now();
    let session = this._txSessions.get(txKey);
    if (!session) {
      session = { startTime: now, lastPacketTime: now, packetCount: 0, firstRelayLogged: false };
      this._txSessions.set(txKey, session);
      console.log(`[RELAY-DIAG] TX START unitId=${senderUnitId} channel=${channelKey}`);
    }
    session.lastPacketTime = now;
    session.packetCount++;
    return session;
  }

  _broadcastToAll(channelKey, senderUnitId, rxPayload, sequence, opusPayload) {
    const txSession = this._trackTxSession(channelKey, senderUnitId);

    const udpSubs = this.subscribers.get(channelKey);
    const udpSubCount = udpSubs ? udpSubs.size : 0;
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
    const wsSubCount = wsSubs ? wsSubs.size : 0;
    if (wsSubs && wsSubs.size > 0) {
      const channelIdNum = parseInt(channelKey, 10);
      const opusFrame = Buffer.alloc(5 + opusPayload.length);
      opusFrame.writeUInt8(0x02, 0);
      opusFrame.writeUInt16BE(isNaN(channelIdNum) ? 0 : channelIdNum, 1);
      opusFrame.writeUInt16BE(sequence & 0xFFFF, 3);
      opusPayload.copy(opusFrame, 5);

      if (!txSession.firstRelayLogged) {
        const wsUnitIds = [...wsSubs.keys()].filter(id => id !== senderUnitId);
        console.log(`[RELAY-DIAG] First relay packet: ch=${channelKey} from=${senderUnitId} wsSubscribers=[${wsUnitIds.join(',')}]`);
        txSession.firstRelayLogged = true;
      }

      for (const [subUnitId, subInfo] of wsSubs) {
        if (subUnitId === senderUnitId) continue;
        subInfo.lastSeen = Date.now();
        try {
          if (subInfo.ws.readyState === 1) {
            subInfo.ws.send(opusFrame);
          }
        } catch (err) {
          console.error(`[AudioRelay] WS send error to ${subUnitId}:`, err.message);
        }
      }
    }

    const listeners = this._audioListeners.get(channelKey);
    const listenerCount = listeners ? listeners.size : 0;

    if (txSession.packetCount % 50 === 0) {
      console.log(`[RELAY-DIAG] RELAY ch=${channelKey} from=${senderUnitId} seq=${sequence} udpSubs=${udpSubCount} wsSubs=${wsSubCount} listeners=${listenerCount}`);
    }

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

  start(port, retries = 3, delay = 3000) {
    this.port = port || this.port;

    return new Promise((resolve, reject) => {
      const bindWithRetry = (remaining) => {
        this.socket = dgram.createSocket('udp4');

        this.socket.on('message', (msg, rinfo) => {
          this._handlePacket(msg, rinfo);
        });

        this.socket.once('error', (err) => {
          if (err.code === 'EADDRINUSE' && remaining > 0) {
            console.warn(`[AudioRelay] UDP port ${this.port} in use, retrying in ${delay}ms (${remaining} attempts left)...`);
            try { this.socket.close(); } catch (_) {}
            this.socket = null;
            setTimeout(() => bindWithRetry(remaining - 1), delay);
          } else {
            reject(err);
          }
        });

        this.socket.bind(this.port, '0.0.0.0', () => {
          this.socket.removeAllListeners('error');
          this.socket.on('error', (err) => {
            console.error('[AudioRelay] Socket error:', err.message);
          });
          console.log(`[AudioRelay] UDP relay listening on port ${this.port}`);
          resolve();
        });
      };

      bindWithRetry(retries);
    }).then(() => {
      this._sweepTimer = setInterval(() => {
        this._sweepStaleSubscribers();
      }, SUBSCRIBER_SWEEP_INTERVAL_MS);
      this._sweepTimer.unref?.();

      this._txIdleTimer = setInterval(() => {
        this._sweepIdleTxSessions();
      }, 1000);
      this._txIdleTimer.unref?.();
    });
  }

  stop() {
    if (this._sweepTimer) {
      clearInterval(this._sweepTimer);
      this._sweepTimer = null;
    }
    if (this._txIdleTimer) {
      clearInterval(this._txIdleTimer);
      this._txIdleTimer = null;
    }
    if (this.socket) {
      this.socket.close();
      this.socket = null;
      console.log('[AudioRelay] UDP relay stopped');
    }
  }

  _sweepIdleTxSessions() {
    const now = Date.now();
    for (const [txKey, session] of this._txSessions) {
      if (now - session.lastPacketTime > 500) {
        const [unitId, channel] = txKey.split(':');
        const duration = session.lastPacketTime - session.startTime;
        console.log(`[RELAY-DIAG] TX STOP unitId=${unitId} channel=${channel} packets=${session.packetCount} duration=${duration}ms`);
        this._txSessions.delete(txKey);
      }
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
    const sequence = msg.readUInt16BE(SESSION_TOKEN_LEN + CHANNEL_ID_LEN);
    const opusPayload = msg.subarray(HEADER_LEN);

    const session = this.sessionTokens.get(token);
    if (!session) {
      return;
    }

    const { unitId, allowedChannel } = session;
    const channelKey = allowedChannel;

    if (this._floorControlService && !this._floorControlService.holdsFloor(channelKey, unitId)) {
      return;
    }

    this.addSubscriber(channelKey, unitId, rinfo.address, rinfo.port);

    const channelIdNum = parseInt(channelKey, 10);
    const rxPayload = Buffer.alloc(CHANNEL_ID_LEN + SEQUENCE_LEN + opusPayload.length);
    rxPayload.writeUInt16BE(isNaN(channelIdNum) ? 0 : channelIdNum, 0);
    rxPayload.writeUInt16BE(sequence & 0xFFFF, CHANNEL_ID_LEN);
    opusPayload.copy(rxPayload, CHANNEL_ID_LEN + SEQUENCE_LEN);

    this._broadcastToAll(channelKey, unitId, rxPayload, sequence, opusPayload);
  }
}

export const audioRelayService = new AudioRelayService();
