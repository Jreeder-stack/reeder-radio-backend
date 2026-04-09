// PCM-only websocket bridge (merge-resolved baseline).
import { WebSocketServer } from 'ws';
import cookie from 'cookie';
import signature from 'cookie-signature';
import pool from '../db/index.js';
import { config } from '../config/env.js';
import { canonicalChannelKey } from './channelKeyUtils.js';
import { floorControlService } from './floorControlService.js';
import { audioRelayService } from './audioRelayService.js';
import { opusCodec } from './opusCodec.js';
const AUDIO_DIAG = process.env.AUDIO_DIAG === 'true';

const PCM_SHAPE = {
  type: 'audio',
  codec: 'pcm',
  sampleRate: 48000,
  channels: 1,
  frameSamples: 960,
};

function isValidPcmPacket(packet) {
  if (!packet || typeof packet !== 'object') return false;
  if (packet.type !== PCM_SHAPE.type) return false;
  if (packet.codec !== PCM_SHAPE.codec) return false;
  if (packet.sampleRate !== PCM_SHAPE.sampleRate) return false;
  if (packet.channels !== PCM_SHAPE.channels) return false;
  if (packet.frameSamples !== PCM_SHAPE.frameSamples) return false;
  if (!Number.isInteger(packet.sequence)) return false;
  if (!Array.isArray(packet.payload)) return false;
  if (packet.payload.length !== PCM_SHAPE.frameSamples) return false;
  return true;
}

const PING_INTERVAL = 30000;
const PONG_TIMEOUT = 10000;
const MAX_MISSED_PONGS = 3;

class WsAudioBridge {
  constructor() {
    this.wss = null;
    this.channelClients = new Map();
    this._pingInterval = null;
    this._pongCheckInterval = null;
  }

  attach(httpServer) {
    this.wss = new WebSocketServer({ noServer: true });

    httpServer.on('upgrade', async (request, socket, head) => {
      const url = new URL(request.url, `http://${request.headers.host}`);
      if (url.pathname !== '/api/audio-ws') return;
      console.log('AUDIO_WS_UPGRADE_HIT', {
        method: request.method,
        path: url.pathname,
        query: url.search,
        host: request.headers.host,
        upgrade: request.headers.upgrade,
        connection: request.headers.connection,
      });

      const user = await this._authenticate(request);
      if (!user) {
        console.warn('AUDIO_WS_REJECTED', { reason: 'unauthorized_session' });
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(request, socket, head, (ws) => {
        console.log('AUDIO_WS_ACCEPTED', {
          username: user.username,
          unitId: user.unit_id || user.username,
        });
        this.wss.emit('connection', ws, request, user);
      });
    });

    this.wss.on('connection', (ws, request, user) => {
      this._onConnection(ws, request, user);
    });

    this._startPingInterval();
  }

  _startPingInterval() {
    if (this._pingInterval) clearInterval(this._pingInterval);
    if (this._pongCheckInterval) clearInterval(this._pongCheckInterval);

    this._pingInterval = setInterval(() => {
      if (!this.wss) return;
      const now = Date.now();
      const heartbeat = JSON.stringify({ type: 'heartbeat', ts: now });
      for (const ws of this.wss.clients) {
        if (ws.readyState !== 1) continue;
        ws._audioPongPending = true;
        ws._audioPingSentAt = now;
        try {
          ws.ping();
          ws.send(heartbeat);
        } catch (_) {
          ws.terminate();
        }
      }
    }, PING_INTERVAL);

    this._pongCheckInterval = setInterval(() => {
      if (!this.wss) return;
      const now = Date.now();
      for (const ws of this.wss.clients) {
        if (ws._audioPongPending && ws._audioPingSentAt && (now - ws._audioPingSentAt) > PONG_TIMEOUT) {
          ws._missedPongs = (ws._missedPongs || 0) + 1;
          ws._audioPongPending = false;
          console.warn('AUDIO_WS_PING_TIMEOUT', { channelId: ws._audioChannelId, unitId: ws._audioUnitId, elapsed: now - ws._audioPingSentAt, missedPongs: ws._missedPongs });
          if (ws._missedPongs >= MAX_MISSED_PONGS) {
            console.warn('AUDIO_WS_TERMINATING', { channelId: ws._audioChannelId, unitId: ws._audioUnitId, missedPongs: ws._missedPongs });
            ws.terminate();
          }
        }
      }
    }, 5000);
  }

  async _authenticate(request) {
    try {
      const rawCookies = request.headers.cookie || '';
      const cookies = cookie.parse(rawCookies);
      let sid = cookies['connect.sid'];
      if (!sid) return null;

      if (sid.startsWith('s%3A')) sid = decodeURIComponent(sid);
      if (sid.startsWith('s:')) {
        sid = signature.unsign(sid.slice(2), config.sessionSecret);
        if (sid === false) return null;
      }

      const result = await pool.query('SELECT sess FROM session WHERE sid = $1', [sid]);
      return result.rows[0]?.sess?.user || null;
    } catch {
      return null;
    }
  }

  _onConnection(ws, request, user) {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const channelId = canonicalChannelKey(url.searchParams.get('channelId'));
    const unitId = user.unit_id || user.username;

    if (!channelId || !unitId) {
      console.warn('AUDIO_WS_REJECTED', {
        reason: 'missing_channel_or_unit',
        channelId,
        unitId,
      });
      ws.close();
      return;
    }

    if (!this.channelClients.has(channelId)) this.channelClients.set(channelId, new Map());
    this.channelClients.get(channelId).set(unitId, ws);

    ws._audioChannelId = channelId;
    ws._audioUnitId = unitId;
    ws._audioPongPending = false;
    ws._missedPongs = 0;

    ws.on('pong', () => {
      ws._audioPongPending = false;
      ws._missedPongs = 0;
    });

    audioRelayService.addWsSubscriber(channelId, unitId, ws);
    if (AUDIO_DIAG) console.log(`[WsAudioBridge] CONNECTION_REGISTERED channelId=${channelId} unitId=${unitId}`);

    ws.on('message', (raw) => {
      let packet;
      try {
        packet = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (packet.type === 'pong') {
        ws._audioPongPending = false;
        ws._missedPongs = 0;
        return;
      }

      if (!isValidPcmPacket(packet)) return;
      if (packet.channelId !== channelId) {
        console.warn(`[WsAudioBridge] CHANNEL_MISMATCH wsChannel=${channelId} packetChannel=${packet.channelId} unitId=${unitId}`);
        return;
      }
      try {
        const pcmInt16 = Buffer.from(new Int16Array(packet.payload).buffer);
        const opusFrames = opusCodec.encodePcmToOpus(pcmInt16);
        for (let i = 0; i < opusFrames.length; i++) {
          audioRelayService.injectAudio(channelId, unitId, packet.sequence + i, opusFrames[i], i === 0 ? packet.payload : null);
        }
      } catch (err) {
        console.error('WS_TO_UDP_RELAY_ERROR', {
          channelId,
          senderUnitId: unitId,
          sequence: packet.sequence,
          error: err.message,
        });
      }
    });

    ws.on('close', () => {
      audioRelayService.removeWsSubscriber(channelId, unitId, ws);
      const map = this.channelClients.get(channelId);
      if (!map) return;
      map.delete(unitId);
      if (map.size === 0) this.channelClients.delete(channelId);
    });
  }

  stop() {
    if (this._pingInterval) {
      clearInterval(this._pingInterval);
      this._pingInterval = null;
    }
    if (this._pongCheckInterval) {
      clearInterval(this._pongCheckInterval);
      this._pongCheckInterval = null;
    }
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    this.channelClients.clear();
  }
}

export const wsAudioBridge = new WsAudioBridge();
