import { WebSocketServer } from 'ws';
import { audioRelayService } from './audioRelayService.js';
import { opusCodec, SAMPLE_RATE, FRAME_SIZE } from './opusCodec.js';
import { floorControlService } from './floorControlService.js';
import { canonicalChannelKey } from './channelKeyUtils.js';
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
    const rawChannelId = url.searchParams.get('channelId');
    const channelId = canonicalChannelKey(rawChannelId);
    const unitId = user.unit_id || user.username;

    if (rawChannelId !== channelId) {
      console.log(`[WsAudioBridge] Channel ID normalized: raw="${rawChannelId}" canonical="${channelId}"`);
    }

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
      serverSequence: 0,
      alive: true,
    };

    this.clients.set(clientId, clientInfo);

    audioRelayService.addWsSubscriber(channelId, unitId, ws);

    console.log(`[WsAudioBridge] Client connected: ${unitId} on channel ${channelId}`);

    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        this._handleTextMessage(clientId, clientInfo, data.toString());
        return;
      }
      this._handleBinaryMessage(clientId, clientInfo, data);
    });

    ws.on('close', () => {
      const frameCount = clientInfo._rxFrameCount || 0;
      clearTimeout(clientInfo._rxBurstIdleTimer);
      audioRelayService.removeWsSubscriber(channelId, unitId);
      this.clients.delete(clientId);
      console.log(`[WsAudioBridge] Client disconnected: ${unitId} from channel ${channelId} (received ${frameCount} binary frames)`);
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
    if (buf.length < 3) {
      console.warn(`[WsAudioBridge] Binary frame too short (${buf.length} bytes) from ${clientInfo.unitId}`);
      return;
    }

    const frameType = buf[0];

    if (!clientInfo._rxFrameCount) clientInfo._rxFrameCount = 0;
    if (!clientInfo._rxBurstFrameCount) clientInfo._rxBurstFrameCount = 0;
    if (!clientInfo._rxBurstBytes) clientInfo._rxBurstBytes = 0;
    clientInfo._rxFrameCount++;
    clientInfo._rxBurstFrameCount++;
    clientInfo._rxBurstBytes += buf.length;

    if (clientInfo._rxBurstFrameCount === 1) {
      clientInfo._rxBurstStart = Date.now();
      console.log(`[TX-RELAY] Burst START from ${clientInfo.unitId} on channel=${clientInfo.channelId} frameType=0x${frameType.toString(16).padStart(2, '0')} len=${buf.length}`);
    } else if (clientInfo._rxBurstFrameCount % 50 === 0) {
      console.log(`[TX-RELAY] Burst progress: unit=${clientInfo.unitId} ch=${clientInfo.channelId} frames=${clientInfo._rxBurstFrameCount} bytes=${clientInfo._rxBurstBytes}`);
    }

    clearTimeout(clientInfo._rxBurstIdleTimer);
    clientInfo._rxBurstIdleTimer = setTimeout(() => {
      const duration = Date.now() - (clientInfo._rxBurstStart || Date.now());
      console.log(`[TX-RELAY] Burst END unit=${clientInfo.unitId} ch=${clientInfo.channelId} frames=${clientInfo._rxBurstFrameCount} bytes=${clientInfo._rxBurstBytes} duration=${duration}ms`);
      clientInfo._rxBurstFrameCount = 0;
      clientInfo._rxBurstBytes = 0;
    }, 500);

    if (clientInfo._rxFrameCount === 1) {
      console.log(`[WsAudioBridge] First binary frame from ${clientInfo.unitId} on channel=${clientInfo.channelId} frameType=0x${frameType.toString(16).padStart(2, '0')} len=${buf.length}`);
    }

    if (frameType === 0x02) {
      if (!floorControlService.holdsFloor(clientInfo.channelId, clientInfo.unitId)) {
        if (clientInfo._rxFrameCount <= 3 || clientInfo._rxFrameCount % 50 === 0) {
          const holder = floorControlService.getFloorHolder(clientInfo.channelId);
          console.warn(`[WsAudioBridge] Floor check FAILED: unit=${clientInfo.unitId} channel=${clientInfo.channelId} holder=${holder ? holder.unitId : 'none'} frame#=${clientInfo._rxFrameCount}`);
        }
        return;
      }

      const sequence = buf.readUInt16BE(1);
      const opusPayload = Buffer.from(buf.subarray(3));

      if (opusPayload.length < 1) return;

      if (clientInfo._rxFrameCount <= 2) {
        console.log(`[WsAudioBridge] Relaying Opus frame: unit=${clientInfo.unitId} ch=${clientInfo.channelId} seq=${sequence} opusLen=${opusPayload.length}`);
      }

      try {
        audioRelayService.injectAudio(
          clientInfo.channelId,
          clientInfo.unitId,
          sequence,
          opusPayload
        );
      } catch (err) {
        console.error(`[WsAudioBridge] Relay error for ${clientInfo.unitId}:`, err.message);
      }
    } else if (frameType === 0x01) {
      if (!floorControlService.holdsFloor(clientInfo.channelId, clientInfo.unitId)) {
        if (clientInfo._rxFrameCount <= 3 || clientInfo._rxFrameCount % 50 === 0) {
          const holder = floorControlService.getFloorHolder(clientInfo.channelId);
          console.warn(`[WsAudioBridge] Floor check FAILED (PCM): unit=${clientInfo.unitId} channel=${clientInfo.channelId} holder=${holder ? holder.unitId : 'none'} frame#=${clientInfo._rxFrameCount}`);
        }
        return;
      }

      const sequence = buf.readUInt16BE(1);
      const pcmData = Buffer.from(buf.subarray(3));

      if (pcmData.length < 2) return;

      if (clientInfo._rxFrameCount <= 2) {
        console.log(`[WsAudioBridge] Relaying PCM frame: unit=${clientInfo.unitId} ch=${clientInfo.channelId} seq=${sequence} pcmLen=${pcmData.length}`);
      }

      try {
        const opusFrames = opusCodec.encodePcmToOpus(pcmData);
        for (const opusPayload of opusFrames) {
          clientInfo.serverSequence = (clientInfo.serverSequence + 1) & 0xFFFF;
          audioRelayService.injectAudio(
            clientInfo.channelId,
            clientInfo.unitId,
            clientInfo.serverSequence,
            opusPayload
          );
        }
      } catch (err) {
        console.error(`[WsAudioBridge] Encode error for ${clientInfo.unitId}:`, err.message);
      }
    } else if (frameType === 0x10) {
      this._handleNewPcmFrame(clientId, clientInfo, buf);
    }
  }

  _handleNewPcmFrame(clientId, clientInfo, buf) {
    if (clientInfo._rxFrameCount <= 2) {
      console.log(`[AUDIO-NEW] _handleNewPcmFrame ENTRY: unit=${clientInfo.unitId} ch=${clientInfo.channelId} bufLen=${buf.length} frame#=${clientInfo._rxFrameCount}`);
    }

    if (!floorControlService.holdsFloor(clientInfo.channelId, clientInfo.unitId)) {
      if (clientInfo._rxFrameCount <= 3 || clientInfo._rxFrameCount % 50 === 0) {
        const holder = floorControlService.getFloorHolder(clientInfo.channelId);
        console.warn(`[AUDIO-NEW] Floor check FAILED: unit=${clientInfo.unitId} channel=${clientInfo.channelId} holder=${holder ? holder.unitId : 'none'} frame#=${clientInfo._rxFrameCount}`);
      }
      return;
    }

    const PCM_HEADER_MIN = 13;
    if (buf.length < PCM_HEADER_MIN) {
      console.warn(`[AUDIO-NEW] PCM packet too short (${buf.length} bytes, need ${PCM_HEADER_MIN}) from ${clientInfo.unitId}`);
      return;
    }

    let offset = 1;
    const codecId = buf.readUInt8(offset); offset += 1;
    const sampleRate = buf.readUInt16BE(offset); offset += 2;
    const channels = buf.readUInt8(offset); offset += 1;
    const frameSamples = buf.readUInt16BE(offset); offset += 2;
    const sequence = buf.readUInt16BE(offset); offset += 2;

    if (offset + 1 > buf.length) return;
    const senderIdLen = buf.readUInt8(offset); offset += 1;
    if (offset + senderIdLen > buf.length) return;
    offset += senderIdLen;

    if (offset + 1 > buf.length) return;
    const channelIdLen = buf.readUInt8(offset); offset += 1;
    if (offset + channelIdLen > buf.length) return;
    offset += channelIdLen;

    if (offset + 2 > buf.length) return;
    const payloadBytes = buf.readUInt16BE(offset); offset += 2;
    if (offset + payloadBytes > buf.length) return;

    if (payloadBytes !== 1920 || payloadBytes % 2 !== 0) {
      if (clientInfo._rxFrameCount <= 5) {
        console.warn(`[AUDIO-NEW] Invalid payloadBytes=${payloadBytes} (expected 1920) from ${clientInfo.unitId}`);
      }
      return;
    }

    if (codecId !== 0x01 || sampleRate !== 48000 || channels !== 1 || frameSamples !== 960) {
      if (clientInfo._rxFrameCount <= 5) {
        console.warn(`[AUDIO-NEW] Invalid metadata: codec=0x${codecId.toString(16)} sampleRate=${sampleRate} channels=${channels} frameSamples=${frameSamples} from ${clientInfo.unitId}`);
      }
      return;
    }

    if (!clientInfo._newPcmRelayCount) clientInfo._newPcmRelayCount = 0;
    clientInfo._newPcmRelayCount++;

    const wsSubs = audioRelayService.wsSubscribers.get(canonicalChannelKey(clientInfo.channelId));
    const listenerCount = wsSubs ? wsSubs.size : 0;

    if (clientInfo._newPcmRelayCount === 1 || clientInfo._newPcmRelayCount % 50 === 0) {
      console.log(`[AUDIO-NEW] RELAY sender=${clientInfo.unitId} channel=${clientInfo.channelId} codec=pcm payloadBytes=${payloadBytes} listenerCount=${listenerCount} seq=${sequence} relayed=${clientInfo._newPcmRelayCount}`);
    }

    if (wsSubs && wsSubs.size > 0) {
      const packetBuf = Buffer.from(buf);
      for (const [subUnitId, subInfo] of wsSubs) {
        if (subUnitId === clientInfo.unitId) continue;
        try {
          if (subInfo.ws.readyState === 1) {
            subInfo.ws.send(packetBuf);
            subInfo.lastSeen = Date.now();
          }
        } catch (err) {
          console.error(`[AUDIO-NEW] WS send error to ${subUnitId}:`, err.message);
        }
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
