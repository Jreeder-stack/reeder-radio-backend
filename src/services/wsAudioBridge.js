import { WebSocketServer } from 'ws';
import { audioRelayService } from './audioRelayService.js';
import { opusCodec, SAMPLE_RATE, FRAME_SIZE } from './opusCodec.js';
import { floorControlService } from './floorControlService.js';
import pool from '../db/index.js';
import { config } from '../config/env.js';

const CHANNEL_ID_LEN = 2;
const SEQUENCE_LEN = 2;
const RX_HEADER_LEN = CHANNEL_ID_LEN + SEQUENCE_LEN;

const PING_INTERVAL_MS = 30000;
const PONG_TIMEOUT_MS = 10000;

class WsAudioBridge {
  constructor() {
    this.wss = null;
    this.clients = new Map();
    this._pingTimer = null;
  }

  attach(httpServer) {
    this.wss = new WebSocketServer({ noServer: true });

    httpServer.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url, `http://${request.headers.host}`);
      if (url.pathname !== '/api/audio-ws') {
        return;
      }

      this._authenticate(request)
        .then((user) => {
          if (!user) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
          }

          this.wss.handleUpgrade(request, socket, head, (ws) => {
            this.wss.emit('connection', ws, request, user);
          });
        })
        .catch((err) => {
          console.error('[WsAudioBridge] Auth error:', err.message);
          socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
          socket.destroy();
        });
    });

    this.wss.on('connection', (ws, request, user) => {
      this._handleConnection(ws, request, user);
    });

    this._pingTimer = setInterval(() => {
      this._pingAll();
    }, PING_INTERVAL_MS);
    this._pingTimer.unref?.();

    console.log('[WsAudioBridge] Attached to HTTP server on /api/audio-ws');
  }

  async _authenticate(request) {
    try {
      const cookies = this._parseCookies(request.headers.cookie || '');
      const rawSid = cookies['connect.sid'];
      if (!rawSid) return null;

      let sid = rawSid;
      if (sid.startsWith('s:') || sid.startsWith('s%3A')) {
        sid = sid.startsWith('s%3A') ? decodeURIComponent(sid).slice(2) : sid.slice(2);
        const dotIndex = sid.indexOf('.');
        if (dotIndex !== -1) {
          sid = sid.substring(0, dotIndex);
        }
      }

      const result = await pool.query('SELECT sess FROM session WHERE sid = $1', [sid]);
      if (!result.rows[0]) return null;

      const sess = result.rows[0].sess;
      return sess?.user || null;
    } catch (err) {
      console.error('[WsAudioBridge] Session lookup error:', err.message);
      return null;
    }
  }

  _parseCookies(cookieHeader) {
    const cookies = {};
    cookieHeader.split(';').forEach((pair) => {
      const idx = pair.indexOf('=');
      if (idx > 0) {
        const name = pair.substring(0, idx).trim();
        cookies[name] = pair.substring(idx + 1).trim();
      }
    });
    return cookies;
  }

  async _handleConnection(ws, request, user) {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const channelId = url.searchParams.get('channelId');
    const unitId = user.unit_id || user.username;

    if (!channelId) {
      ws.close(4000, 'channelId required');
      return;
    }

    if (user.role !== 'admin') {
      try {
        const result = await pool.query(
          `SELECT 1 FROM user_channel_access uca
           JOIN users u ON uca.user_id = u.id
           JOIN channels c ON uca.channel_id = c.id
           WHERE (u.unit_id = $1 OR u.username = $1)
             AND (c.id::text = $2 OR COALESCE(c.zone, 'Default') || '__' || c.name = $2)
             AND c.enabled = true
           LIMIT 1`,
          [unitId, channelId]
        );
        if (result.rows.length === 0) {
          const allAccess = await pool.query(
            `SELECT COUNT(*) as cnt FROM user_channel_access uca
             JOIN users u ON uca.user_id = u.id
             WHERE u.unit_id = $1 OR u.username = $1`,
            [unitId]
          );
          if (parseInt(allAccess.rows[0].cnt) > 0) {
            console.warn(`[WsAudioBridge] Channel access denied: ${unitId} on ${channelId}`);
            ws.close(4003, 'Channel access denied');
            return;
          }
        }
      } catch (dbErr) {
        console.error('[WsAudioBridge] Channel auth check failed (fail-closed):', dbErr.message);
        ws.close(4003, 'Authorization check failed');
        return;
      }
    }

    const clientId = `${unitId}:${channelId}:${Date.now()}`;
    const clientInfo = {
      ws,
      channelId,
      unitId,
      user,
      sequence: 0,
      alive: true,
    };

    this.clients.set(clientId, clientInfo);

    audioRelayService.addWsSubscriber(channelId, unitId, ws);

    console.log(`[WsAudioBridge] Client connected: ${unitId} on channel ${channelId}`);

    ws.on('message', (data) => {
      if (typeof data === 'string') {
        this._handleTextMessage(clientId, clientInfo, data);
        return;
      }
      this._handleBinaryMessage(clientId, clientInfo, data);
    });

    ws.on('close', () => {
      audioRelayService.removeWsSubscriber(channelId, unitId);
      this.clients.delete(clientId);
      console.log(`[WsAudioBridge] Client disconnected: ${unitId} from channel ${channelId}`);
    });

    ws.on('error', (err) => {
      console.error(`[WsAudioBridge] WS error for ${unitId}:`, err.message);
    });

    ws.on('pong', () => {
      clientInfo.alive = true;
    });

    ws.send(JSON.stringify({ type: 'connected', channelId, unitId }));
  }

  _handleTextMessage(clientId, clientInfo, data) {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'ping') {
        clientInfo.alive = true;
        clientInfo.ws.send(JSON.stringify({ type: 'pong' }));
      }
    } catch (err) {
      console.warn('[WsAudioBridge] Invalid text message:', err.message);
    }
  }

  _handleBinaryMessage(clientId, clientInfo, data) {
    const buf = Buffer.from(data);
    if (buf.length < 3) return;

    const frameType = buf[0];

    if (frameType === 0x01) {
      if (!floorControlService.holdsFloor(clientInfo.channelId, clientInfo.unitId)) {
        return;
      }

      const sequence = buf.readUInt16BE(1);
      const pcmData = buf.subarray(3);

      if (pcmData.length < 2) return;

      try {
        const opusFrames = opusCodec.encodePcmToOpus(pcmData);
        for (const opusPayload of opusFrames) {
          audioRelayService.injectAudio(
            clientInfo.channelId,
            clientInfo.unitId,
            sequence,
            opusPayload
          );
        }
      } catch (err) {
        console.error(`[WsAudioBridge] Encode error for ${clientInfo.unitId}:`, err.message);
      }
    }
  }

  _pingAll() {
    for (const [clientId, clientInfo] of this.clients) {
      if (!clientInfo.alive) {
        console.log(`[WsAudioBridge] Terminating unresponsive client: ${clientInfo.unitId}`);
        clientInfo.ws.terminate();
        audioRelayService.removeWsSubscriber(clientInfo.channelId, clientInfo.unitId);
        this.clients.delete(clientId);
        continue;
      }
      clientInfo.alive = false;
      try {
        clientInfo.ws.ping();
      } catch (err) {
        console.error(`[WsAudioBridge] Ping error:`, err.message);
      }
    }
  }

  stop() {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    this.clients.clear();
  }
}

export const wsAudioBridge = new WsAudioBridge();
