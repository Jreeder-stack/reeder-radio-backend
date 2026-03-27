import { WebSocketServer } from 'ws';
import pool from '../db/index.js';
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

      const user = await this._authenticate(request);
      if (!user) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.wss.emit('connection', ws, request, user);
      });
    });

    this.wss.on('connection', (ws, request, user) => {
      this._onConnection(ws, request, user);
    });
  }

  async _authenticate(request) {
    try {
      const cookies = Object.fromEntries((request.headers.cookie || '').split(';').map((v) => v.trim().split('=')));
      const rawSid = cookies['connect.sid'];
      if (!rawSid) return null;

      let sid = rawSid;
      if (sid.startsWith('s:') || sid.startsWith('s%3A')) {
        sid = sid.startsWith('s%3A') ? decodeURIComponent(sid).slice(2) : sid.slice(2);
        const dotIndex = sid.indexOf('.');
        if (dotIndex !== -1) sid = sid.slice(0, dotIndex);
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
      if (!floorControlService.holdsFloor(channelId, unitId)) return;

      const listeners = this.channelClients.get(channelId);
      const listenerCount = listeners ? Math.max(0, listeners.size - 1) : 0;
      console.log('SRV_RELAY', { channelId, listenerCount });

      if (!listeners) return;
      const outbound = JSON.stringify(packet);
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
