import dgram from 'dgram';

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

    const subs = this.subscribers.get(channelKey);
    if (!subs || subs.size === 0) {
      return;
    }

    const rxPayload = msg.subarray(SESSION_TOKEN_LEN);

    for (const [subUnitId, subInfo] of subs) {
      if (subUnitId === unitId) continue;
      subInfo.lastSeen = Date.now();
      try {
        this.socket.send(rxPayload, 0, rxPayload.length, subInfo.port, subInfo.address);
      } catch (err) {
        console.error(`[AudioRelay] Send error to ${subUnitId}:`, err.message);
      }
    }

    if (this._recordingTap) {
      try {
        this._recordingTap({
          channelId: channelKey,
          unitId,
          sequence,
          opusPayload,
          timestamp: Date.now(),
        });
      } catch (err) {
        console.error('[AudioRelay] Recording tap error:', err.message);
      }
    }
  }
}

export const audioRelayService = new AudioRelayService();
