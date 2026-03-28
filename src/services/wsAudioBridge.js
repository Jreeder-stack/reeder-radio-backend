// PCM-only websocket bridge (merge-resolved baseline).
import { WebSocketServer } from 'ws';
import cookie from 'cookie';
import signature from 'cookie-signature';
import pool from '../db/index.js';
import { config } from '../config/env.js';
import { canonicalChannelKey } from './channelKeyUtils.js';
import { floorControlService } from './floorControlService.js';

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

class WsAudioBridge {
  constructor() {
    this.wss = null;
    this.channelClients = new Map();
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

    ws.on('message', (raw) => {
      let packet;
      try {
        packet = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (!isValidPcmPacket(packet)) return;
      if (packet.channelId !== channelId) return;
      if (!floorControlService.holdsFloor(channelId, unitId)) {
        console.warn('AUDIO_WS_REJECTED', {
          reason: 'floor_not_held',
          channelId,
          unitId,
          sequence: packet.sequence,
        });
        return;
      }
      console.log('SRV_TX_FRAME_RECEIVED', {
        channelId,
        senderUnitId: unitId,
        sequence: packet.sequence,
        samples: packet.payload?.length,
      });

      const listeners = this.channelClients.get(channelId);
      const listenerCount = listeners ? Math.max(0, listeners.size - 1) : 0;
      console.log('SRV_RELAY', { channelId, listenerCount });
      console.log('SRV_TX_FRAME_RELAYED', {
        channelId,
        senderUnitId: unitId,
        sequence: packet.sequence,
        listenerCount,
      });

      if (!listeners) return;
      const outbound = JSON.stringify({ ...packet, senderUnitId: unitId });
      for (const [listenerUnitId, listenerWs] of listeners) {
        if (listenerUnitId === unitId) continue;
        if (listenerWs.readyState === 1) {
          listenerWs.send(outbound);
        }
      }
    });

    ws.on('close', () => {
      const map = this.channelClients.get(channelId);
      if (!map) return;
      map.delete(unitId);
      if (map.size === 0) this.channelClients.delete(channelId);
    });
  }

  stop() {
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    this.channelClients.clear();
  }
}

export const wsAudioBridge = new WsAudioBridge();
