/**
 * RadioClient — Embeddable PTT Radio Client for CAD Integration
 *
 * USAGE GUIDE:
 * ============
 *
 * 1. AUTHENTICATION (server-side, from your CAD backend):
 *    Your CAD server calls the radio server's trusted login endpoint to create
 *    a session for the logged-in CAD user. No password is needed — just the
 *    shared API key (CAD_INTEGRATION_KEY env var).
 *
 *    POST {radioServerUrl}/api/auth/cad-login
 *    Body: { "username": "officer123", "apiKey": "your-shared-secret" }
 *    Response: { "user": { "id", "username", "unit_id", "role", "is_dispatcher" } }
 *    The response sets a `connect.sid` session cookie.
 *
 * 2. VERIFY A USER (optional, server-side):
 *    POST {radioServerUrl}/api/cad-integration/verify-user
 *    Body: { "username": "officer123", "apiKey": "your-shared-secret" }
 *    Response: { "exists": true, "username", "unit_id", "role", "is_dispatcher" }
 *
 * 3. LOAD THIS SCRIPT in your CAD page:
 *    <script src="https://your-radio-server.com/api/radio-client.js"></script>
 *
 * 4. INITIALIZE the client (uses the session cookie from step 1):
 *    const radio = new RadioClient();
 *    await radio.init({
 *      serverUrl: 'https://your-radio-server.com',
 *      channelId: 'North__Dispatch',  // room_key format: zone__channelName
 *    });
 *
 * 5. FETCH ZONES & CHANNELS (to populate dropdowns):
 *    const zones = await radio.getZones();     // returns { zones: [...] }
 *    const channels = await radio.getChannels('North');  // optional zone filter
 *    Each channel object includes a `room_key` field (e.g. "North__Dispatch")
 *    which is the channelId you pass to init() or setChannel().
 *
 * 6. WIRE PTT BUTTON:
 *    pttButton.addEventListener('mousedown', () => radio.startPtt());
 *    pttButton.addEventListener('mouseup',   () => radio.stopPtt());
 *
 *    Or for keyboard (e.g. spacebar):
 *    document.addEventListener('keydown', (e) => {
 *      if (e.code === 'Space' && !e.repeat) radio.startPtt();
 *    });
 *    document.addEventListener('keyup', (e) => {
 *      if (e.code === 'Space') radio.stopPtt();
 *    });
 *
 * 7. SWITCH CHANNEL:
 *    await radio.setChannel('South__Tactical');
 *
 * 8. LISTEN FOR EVENTS:
 *    radio.on('pttStart', (data) => { ... });   // someone is transmitting
 *    radio.on('pttEnd', (data) => { ... });      // transmission ended
 *    radio.on('pttBusy', (data) => { ... });     // channel busy, PTT denied
 *    radio.on('connectionChange', (data) => { ... });
 *    radio.on('channelMembers', (data) => { ... });
 *
 * 9. CLEAN UP when done:
 *    radio.destroy();
 *
 * ROOM_KEY FORMAT:
 *   The room_key (channelId) is always "zoneName__channelName".
 *   Example: zone "North", channel "Dispatch" → room_key = "North__Dispatch"
 */
(function (global) {
  'use strict';

  var PCM_SPEC = {
    type: 'audio',
    codec: 'pcm',
    sampleRate: 16000,
    channels: 1,
    frameSamples: 320,
  };

  function buildPcmPacket(sequence, channelId, int16Frame) {
    return {
      type: PCM_SPEC.type,
      codec: PCM_SPEC.codec,
      sampleRate: PCM_SPEC.sampleRate,
      channels: PCM_SPEC.channels,
      frameSamples: PCM_SPEC.frameSamples,
      sequence: sequence,
      channelId: channelId,
      payload: Array.from(int16Frame),
    };
  }

  var WS_BINARY_MARKER = 0x01;

  function truncateUtf8(encoder, str, maxBytes) {
    var encoded = encoder.encode(str || '');
    if (encoded.length > maxBytes) encoded = encoded.slice(0, maxBytes);
    return encoded;
  }

  function buildBinaryFrame(sequence, channelId, unitId, int16Frame) {
    var encoder = new TextEncoder();
    var channelBytes = truncateUtf8(encoder, channelId, 255);
    var senderBytes = truncateUtf8(encoder, unitId, 255);
    var headerLen = 1 + 4 + 1 + channelBytes.length + 1 + senderBytes.length;
    var pcmBytes = int16Frame.length * 2;
    var buf = new ArrayBuffer(headerLen + pcmBytes);
    var view = new DataView(buf);
    var u8 = new Uint8Array(buf);
    var off = 0;
    view.setUint8(off, WS_BINARY_MARKER); off += 1;
    view.setUint32(off, sequence, true); off += 4;
    view.setUint8(off, channelBytes.length); off += 1;
    u8.set(channelBytes, off); off += channelBytes.length;
    view.setUint8(off, senderBytes.length); off += 1;
    u8.set(senderBytes, off); off += senderBytes.length;
    var pcmU8 = new Uint8Array(int16Frame.buffer, int16Frame.byteOffset, int16Frame.byteLength);
    u8.set(pcmU8, off);
    return buf;
  }

  function parseBinaryAudioFrame(arrayBuffer) {
    try {
      if (arrayBuffer.byteLength < 7) return null;
      var view = new DataView(arrayBuffer);
      var off = 0;
      var marker = view.getUint8(off); off += 1;
      if (marker !== WS_BINARY_MARKER) return null;
      var sequence = view.getUint32(off, true); off += 4;
      if (off >= arrayBuffer.byteLength) return null;
      var channelIdLen = view.getUint8(off); off += 1;
      if (off + channelIdLen >= arrayBuffer.byteLength) return null;
      var channelIdBytes = new Uint8Array(arrayBuffer, off, channelIdLen);
      var channelId = new TextDecoder().decode(channelIdBytes); off += channelIdLen;
      if (off >= arrayBuffer.byteLength) return null;
      var senderIdLen = view.getUint8(off); off += 1;
      if (off + senderIdLen > arrayBuffer.byteLength) return null;
      var senderIdBytes = new Uint8Array(arrayBuffer, off, senderIdLen);
      var senderUnitId = new TextDecoder().decode(senderIdBytes); off += senderIdLen;
      var pcmByteLength = arrayBuffer.byteLength - off;
      if (pcmByteLength < 2 || pcmByteLength % 2 !== 0) return null;
      var samples = new Int16Array(arrayBuffer.slice(off, off + pcmByteLength));
      return { sequence: sequence, channelId: channelId, senderUnitId: senderUnitId, samples: samples };
    } catch (e) {
      return null;
    }
  }

  function validatePcmPacket(packet) {
    if (!packet || typeof packet !== 'object') return false;
    if (packet.type !== PCM_SPEC.type) return false;
    if (packet.codec !== PCM_SPEC.codec) return false;
    if (packet.sampleRate !== PCM_SPEC.sampleRate) return false;
    if (packet.channels !== PCM_SPEC.channels) return false;
    if (packet.frameSamples !== PCM_SPEC.frameSamples) return false;
    if (!Number.isInteger(packet.sequence)) return false;
    if (!Array.isArray(packet.payload)) return false;
    if (packet.payload.length !== PCM_SPEC.frameSamples) return false;
    return true;
  }

  var DEVICE_ID_STORAGE_KEY = 'radioClient.deviceId';
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function generateUUID() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function getOrCreateDeviceId() {
    try {
      var existing = window.localStorage && window.localStorage.getItem(DEVICE_ID_STORAGE_KEY);
      if (existing && UUID_RE.test(existing)) return existing;
    } catch (_) {}
    var fresh = generateUUID();
    try {
      if (window.localStorage) window.localStorage.setItem(DEVICE_ID_STORAGE_KEY, fresh);
    } catch (_) {}
    return fresh;
  }

  function RadioClient() {
    this._serverUrl = '';
    this._channelId = null;
    this._activeChannelId = null;
    this._joinedChannelId = null;
    this._joiningChannelId = null;
    this._reception = null;
    this._channelGeneration = 0;
    this._socket = null;
    this._ws = null;
    this._unitId = null;
    this._username = null;
    this._isDispatcher = false;
    this._authenticated = false;
    this._transmitting = false;
    this._txSequence = 0;
    this._capture = null;
    this._pttAttempt = null;
    this._pttChannelId = null;
    this._playback = null;
    this._listeners = {};
    this._destroyed = false;
    this._deviceId = getOrCreateDeviceId();
    this._deviceType = 'cad';
    this._readyPromise = null;
    this._cancelSignaling = null;
    this._cancelChannelJoin = null;
    this._cancelAudioConnect = null;
  }

  function cancelledOperation() {
    var error = new Error('Radio operation was superseded or cancelled');
    error.code = 'RADIO_OPERATION_CANCELLED';
    return error;
  }

  RadioClient.prototype._assertAlive = function () {
    if (this._destroyed) throw cancelledOperation();
  };

  RadioClient.prototype._isCurrentChannel = function (channelId, generation) {
    return !this._destroyed && this._channelId === channelId &&
      this._channelGeneration === generation;
  };

  RadioClient.prototype._acceptChannelEvent = function (data) {
    return !this._destroyed && this._authenticated && this._activeChannelId !== null &&
      this._activeChannelId === this._channelId && data &&
      data.channelId === this._activeChannelId;
  };

  RadioClient.prototype._acceptSelectedActivity = function (data) {
    return !this._destroyed && this._authenticated && data && data.channelId === this._channelId &&
      (data.channelId === this._joinedChannelId || data.channelId === this._joiningChannelId);
  };

  RadioClient.prototype.init = async function (options) {
    this._assertAlive();
    if (this._readyPromise) throw new Error('RadioClient is already initialized');
    if (!options || !options.serverUrl) {
      throw new Error('serverUrl is required');
    }

    this._serverUrl = options.serverUrl.replace(/\/$/, '');
    this._channelId = options.channelId || null;
    var channelId = this._channelId;
    var generation = ++this._channelGeneration;
    if (options.deviceId && UUID_RE.test(options.deviceId)) {
      this._deviceId = options.deviceId;
      try {
        if (window.localStorage) window.localStorage.setItem(DEVICE_ID_STORAGE_KEY, options.deviceId);
      } catch (_) {}
    }
    if (options.deviceType) this._deviceType = options.deviceType;

    var self = this;
    this._readyPromise = (async function () {
      await self._fetchUserInfo();
      self._assertAlive();
      await self._connectSignaling();
      self._assertAlive();
      await self._initPlayback();
      self._assertAlive();
    })();
    await this._readyPromise;
    await this._activateChannel(channelId, generation);
  };

  RadioClient.prototype._fetchUserInfo = async function () {
    var res = await fetch(this._serverUrl + '/api/auth/me', {
      credentials: 'include',
    });
    if (!res.ok) {
      throw new Error('Not authenticated. Call POST /api/auth/cad-login first.');
    }
    var data = await res.json();
    this._assertAlive();
    var user = data.user;
    this._unitId = user.unit_id || user.username;
    this._username = user.username;
    this._isDispatcher = user.is_dispatcher || false;
  };

  RadioClient.prototype._connectSignaling = function () {
    var self = this;
    return new Promise(function (resolve, reject) {
      var settled = false;
      var script = null;
      var timeout = setTimeout(function () {
        finish(new Error('Signaling connection timeout'));
      }, 10000);

      function finish(error) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (self._cancelSignaling === cancel) self._cancelSignaling = null;
        if (script) {
          script.onload = null;
          script.onerror = null;
        }
        if (error) reject(error);
        else resolve();
      }
      function cancel() {
        finish(cancelledOperation());
      }
      function connect() {
        if (settled || self._destroyed) { cancel(); return; }
        self._doConnect(function () { finish(); }, finish);
      }
      self._cancelSignaling = cancel;
      if (typeof io === 'undefined') {
        script = document.createElement('script');
        script.src = self._serverUrl + '/socket.io/socket.io.js';
        script.onload = connect;
        script.onerror = function () {
          finish(new Error('Failed to load Socket.IO client library'));
        };
        document.head.appendChild(script);
      } else {
        connect();
      }
    });
  };

  RadioClient.prototype._doConnect = function (resolve, reject) {
    var self = this;
    var hasAuthenticated = false;
    var socket = io(this._serverUrl, {
      path: '/signaling',
      withCredentials: true,
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 999,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });
    this._socket = socket;

    function isCurrentSocket() {
      return !self._destroyed && self._socket === socket;
    }

    socket.on('connect', function () {
      if (!isCurrentSocket()) return;
      self._emit('connectionChange', { connected: true, ready: false });
      socket.emit('authenticate', {
        unitId: self._unitId,
        username: self._username,
        agencyId: 'default',
        isDispatcher: self._isDispatcher,
        deviceId: self._deviceId,
        deviceType: self._deviceType,
      });
    });

    socket.on('authenticated', function () {
      if (!isCurrentSocket()) return;
      var wasAuthenticated = self._authenticated;
      self._authenticated = true;
      if (!hasAuthenticated) {
        hasAuthenticated = true;
        resolve();
      } else if (!wasAuthenticated) {
        var generation = self._channelGeneration;
        var channelId = self._channelId;
        self._readyPromise.then(function () {
          return self._activateChannel(channelId, generation);
        }).catch(function (error) {
          if (error.code !== 'RADIO_OPERATION_CANCELLED' &&
              self._isCurrentChannel(channelId, generation)) {
            self._emit('connectionChange', { connected: true, ready: false, error: error.message });
          }
        });
      }
    });

    socket.on('disconnect', function (reason) {
      if (!isCurrentSocket()) return;
      self._authenticated = false;
      if (hasAuthenticated) ++self._channelGeneration;
      self._reception = null;
      self.stopPtt();
      if (self._cancelChannelJoin) self._cancelChannelJoin();
      self._closeAudioWs();
      self._joinedChannelId = null;
      self._emit('connectionChange', { connected: false, ready: false, reason: reason });
    });

    socket.on('connect_error', function (error) {
      if (isCurrentSocket() && !hasAuthenticated) {
        reject(new Error('Signaling connection failed: ' + error.message));
      }
    });

    socket.on('ptt:start', function (data) {
      if (!isCurrentSocket() || !self._acceptSelectedActivity(data)) return;
      if (data.unitId === self._unitId) return;
      self._reception = data;
      if (self._acceptChannelEvent(data)) self._emit('pttStart', data);
    });
    socket.on('ptt:end', function (data) {
      if (!isCurrentSocket() || !self._acceptSelectedActivity(data)) return;
      if (self._reception && (!data.unitId || data.unitId === self._reception.unitId)) {
        self._reception = null;
      }
      if (self._acceptChannelEvent(data)) self._emit('pttEnd', data);
    });
    socket.on('ptt:busy', function (data) {
      if (isCurrentSocket() && self._acceptChannelEvent(data)) self._emit('pttBusy', data);
    });
    socket.on('ptt:granted', function (data) {
      var attempt = self._pttAttempt;
      if (isCurrentSocket() && self._acceptChannelEvent(data) && attempt &&
          data.requestId === attempt.requestId &&
          (!data.targetDeviceId || data.targetDeviceId === self._deviceId)) {
        self._emit('pttGranted', data);
      }
    });
    socket.on('channel:join', function (data) {
      if (isCurrentSocket() && self._acceptChannelEvent(data)) self._emit('channelJoin', data);
    });
    socket.on('channel:leave', function (data) {
      if (isCurrentSocket() && self._acceptChannelEvent(data)) self._emit('channelLeave', data);
    });
    socket.on('channel:members', function (data) {
      if (!isCurrentSocket() || !data) return;
      // Authorization is asynchronous on the server. A cancelled join may be
      // acknowledged after its leave; remove that obsolete room again.
      if (data.channelId && (data.channelId !== self._channelId ||
          (data.channelId !== self._joiningChannelId && data.channelId !== self._joinedChannelId))) {
        self._leaveChannel(data.channelId);
        return;
      }
      if (self._acceptChannelEvent(data)) self._emit('channelMembers', data);
    });
    socket.on('emergency:start', function (data) {
      if (isCurrentSocket() && self._acceptChannelEvent(data)) self._emit('emergencyStart', data);
    });
    socket.on('emergency:end', function (data) {
      if (isCurrentSocket() && self._acceptChannelEvent(data)) self._emit('emergencyEnd', data);
    });
  };

  RadioClient.prototype._joinChannel = function (channelId, generation) {
    var self = this;
    var socket = this._socket;
    if (!socket || !this._authenticated) return Promise.reject(new Error('Signaling is disconnected'));
    return new Promise(function (resolve, reject) {
      var settled = false;
      self._joiningChannelId = channelId;
      var timeout = setTimeout(function () {
        finish(new Error('Channel join timeout'));
      }, 10000);
      function finish(error, data) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.off('channel:members', onJoined);
        socket.off('error', onError);
        if (self._cancelChannelJoin === cancel) {
          self._cancelChannelJoin = null;
          self._joiningChannelId = null;
        }
        if (error) reject(error);
        else resolve(data);
      }
      function cancel() { finish(cancelledOperation()); }
      function onJoined(data) {
        if (!data || data.channelId !== channelId) return;
        if (!self._isCurrentChannel(channelId, generation) || self._socket !== socket) {
          cancel();
          return;
        }
        self._joinedChannelId = channelId;
        finish(null, data);
      }
      function onError(data) {
        if (data && data.channelId === channelId) {
          finish(new Error(data.message || 'Channel join failed'));
        }
      }
      self._cancelChannelJoin = cancel;
      socket.on('channel:members', onJoined);
      socket.on('error', onError);
      socket.emit('channel:join', { channelId: channelId });
    });
  };

  RadioClient.prototype._leaveChannel = function (channelId) {
    if (this._socket && this._authenticated) {
      this._socket.emit('channel:leave', { channelId: channelId });
    }
  };

  RadioClient.prototype._clearPlayback = function () {
    var playback = this._playback;
    if (!playback) return;
    playback.fallbackQueue.length = 0;
    playback.fallbackOffset = 0;
    if (playback.workletNode) playback.workletNode.port.postMessage({ type: 'clear' });
  };

  RadioClient.prototype._closeAudioWs = function () {
    if (this._cancelAudioConnect) this._cancelAudioConnect();
    var ws = this._ws;
    this._ws = null;
    this._activeChannelId = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      ws.close();
    }
    this._clearPlayback();
  };

  RadioClient.prototype._activateChannel = async function (channelId, generation) {
    if (!this._isCurrentChannel(channelId, generation)) throw cancelledOperation();
    if (!channelId) return;
    try {
      var members = await this._joinChannel(channelId, generation);
      if (!this._isCurrentChannel(channelId, generation)) throw cancelledOperation();
      await this._connectAudioWs(channelId, generation);
      if (!this._isCurrentChannel(channelId, generation)) throw cancelledOperation();
      this._emit('channelMembers', members);
      if (this._reception) this._emit('pttStart', this._reception);
    } catch (error) {
      if (this._isCurrentChannel(channelId, generation)) {
        this._leaveChannel(channelId);
        this._joinedChannelId = null;
        this._reception = null;
        this._emit('connectionChange', { connected: this.isConnected(), ready: false, error: error.message });
      }
      throw error;
    }
  };

  RadioClient.prototype._connectAudioWs = function (channelId, generation) {
    var self = this;
    this._closeAudioWs();
    return new Promise(function (resolve, reject) {
      var settled = false;
      var proto = self._serverUrl.startsWith('https') ? 'wss:' : 'ws:';
      var host = self._serverUrl.replace(/^https?:\/\//, '');
      var url = proto + '//' + host + '/api/audio-ws?channelId=' +
        encodeURIComponent(channelId) + '&unitId=' + encodeURIComponent(self._unitId);
      var ws = new WebSocket(url);
      // Own the socket while it is CONNECTING, so a newer selection can close it.
      self._ws = ws;
      ws.binaryType = 'arraybuffer';
      var timeout = setTimeout(function () {
        fail(new Error('Audio WebSocket connection timeout'));
      }, 10000);

      function isCurrent() {
        return self._ws === ws && self._authenticated &&
          self._isCurrentChannel(channelId, generation);
      }
      function finish(error) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (self._cancelAudioConnect === cancel) self._cancelAudioConnect = null;
        if (error) reject(error);
        else resolve();
      }
      function cancel() { finish(cancelledOperation()); }
      function fail(error) {
        var established = settled && self._activeChannelId === channelId;
        finish(error);
        if (self._ws === ws) {
          self.stopPtt();
          self._reception = null;
          self._closeAudioWs();
          if (established) self._emit('connectionChange', {
            connected: self.isConnected(), ready: false, reason: 'audio_error', error: error.message,
          });
        }
      }
      self._cancelAudioConnect = cancel;

      ws.onopen = function () {
        if (!isCurrent()) {
          finish(cancelledOperation());
          ws.close();
          return;
        }
        self._activeChannelId = channelId;
        finish();
        self._emit('connectionChange', { connected: true, ready: true, channelId: channelId });
      };
      ws.onerror = function () { fail(new Error('Audio WebSocket connection failed')); };
      ws.onmessage = function (event) {
        if (!isCurrent() || self._activeChannelId !== channelId) return;
        if (event.data instanceof ArrayBuffer) {
          var parsed = parseBinaryAudioFrame(event.data);
          if (!parsed || parsed.channelId !== channelId) return;
          if (parsed.senderUnitId && parsed.senderUnitId === self._unitId) return;
          if (self._playback) self._playback.enqueue(parsed.samples);
          return;
        }
        if (typeof event.data !== 'string') return;
        var msg;
        try { msg = JSON.parse(event.data); } catch (_) { return; }
        if (msg.type === 'heartbeat') {
          try { ws.send(JSON.stringify({ type: 'pong', ts: msg.ts })); } catch (_) {}
          return;
        }
        if (!validatePcmPacket(msg) || msg.channelId !== channelId) return;
        if (msg.senderUnitId && msg.senderUnitId === self._unitId) return;
        if (self._playback) self._playback.enqueue(new Int16Array(msg.payload));
      };
      ws.onclose = function () {
        finish(new Error('Audio WebSocket closed'));
        if (self._ws !== ws) return;
        self._ws = null;
        self._activeChannelId = null;
        self._reception = null;
        self.stopPtt();
        self._clearPlayback();
        self._emit('connectionChange', { connected: self.isConnected(), ready: false, reason: 'audio_closed' });
      };
    });
  };

  RadioClient.prototype._initPlayback = async function () {
    var AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    this._assertAlive();
    var ctx = new AudioCtx({ sampleRate: PCM_SPEC.sampleRate });
    var self = this;
    var playback = {
      ctx: ctx,
      workletNode: null,
      fallbackProcessor: null,
      fallbackQueue: [],
      fallbackOffset: 0,
    };
    this._playback = playback;
    function isCurrent() { return !self._destroyed && self._playback === playback; }
    if (ctx.state === 'suspended') await ctx.resume();
    if (!isCurrent()) throw cancelledOperation();
    try {
      await ctx.audioWorklet.addModule(this._serverUrl + '/pcm-playback-worklet.js');
      if (!isCurrent()) throw cancelledOperation();
      playback.workletNode = new AudioWorkletNode(ctx, 'pcm-playback-processor', {
        outputChannelCount: [1],
      });
      playback.workletNode.connect(ctx.destination);
    } catch (error) {
      if (!isCurrent()) throw cancelledOperation();
      var proc = ctx.createScriptProcessor(1024, 1, 1);
      proc.onaudioprocess = function (event) {
        var output = event.outputBuffer.getChannelData(0);
        var written = 0;
        var q = playback.fallbackQueue;
        while (isCurrent() && written < output.length && q.length > 0) {
          var current = q[0];
          var offset = playback.fallbackOffset;
          var available = current.length - offset;
          var needed = output.length - written;
          var count = Math.min(available, needed);
          for (var i = 0; i < count; i++) {
            var sample = (current[offset + i] / 32768) * 2.5;
            if (sample > 0.8 || sample < -0.8) sample = Math.tanh(sample);
            output[written + i] = sample;
          }
          written += count;
          playback.fallbackOffset += count;
          if (playback.fallbackOffset >= current.length) {
            q.shift();
            playback.fallbackOffset = 0;
          }
        }
        for (var j = written; j < output.length; j++) output[j] = 0;
      };
      proc.connect(ctx.destination);
      playback.fallbackProcessor = proc;
    }
    playback.enqueue = function (int16Frame) {
      if (!isCurrent()) return;
      if (ctx.state === 'suspended') ctx.resume().catch(function () {});
      var samples = int16Frame instanceof Int16Array ? int16Frame : new Int16Array(int16Frame);
      if (playback.workletNode) {
        playback.workletNode.port.postMessage({ type: 'enqueue', samples: samples });
      } else if (playback.fallbackProcessor) {
        playback.fallbackQueue.push(samples);
      }
    };
  };

  RadioClient.prototype._isCurrentPtt = function (attempt) {
    return this._pttAttempt === attempt && this._authenticated &&
      this._isCurrentChannel(attempt.channelId, attempt.generation) &&
      this._activeChannelId === attempt.channelId && this._socket === attempt.socket &&
      this._ws === attempt.ws && attempt.ws.readyState === WebSocket.OPEN;
  };

  RadioClient.prototype.startPtt = async function () {
    if (this._destroyed || this._transmitting || this._pttAttempt || !this._channelId) return false;
    if (!this._socket || !this._authenticated || this._activeChannelId !== this._channelId) return false;
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return false;
    var self = this;
    var attempt = {
      channelId: this._activeChannelId,
      generation: this._channelGeneration,
      socket: this._socket,
      ws: this._ws,
      requestId: generateUUID(),
      cancel: null,
    };
    this._pttAttempt = attempt;
    this._pttChannelId = attempt.channelId;
    return new Promise(function (resolve, reject) {
      var settled = false;
      var granted = false;
      var timeout = setTimeout(function () {
        finish(false, new Error('PTT grant timeout'));
        self.stopPtt();
      }, 3000);

      function cleanup() {
        clearTimeout(timeout);
        attempt.socket.off('ptt:granted', onGranted);
        attempt.socket.off('ptt:busy', onBusy);
      }
      function finish(result, error) {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve(result);
      }
      attempt.cancel = function () { finish(false); };
      function onGranted(data) {
        if (granted || !self._isCurrentPtt(attempt) || !data ||
            data.channelId !== attempt.channelId || data.requestId !== attempt.requestId ||
            (data.targetDeviceId && data.targetDeviceId !== self._deviceId)) return;
        granted = true;
        cleanup();
        self._beginCapture(attempt).then(function (started) {
          if (started && self._isCurrentPtt(attempt)) {
            self._transmitting = true;
            finish(true);
          } else {
            finish(false);
          }
        }).catch(function (error) {
          finish(false, error);
          if (self._pttAttempt === attempt) self.stopPtt();
        });
      }
      function onBusy(data) {
        if (!self._isCurrentPtt(attempt) || !data || data.channelId !== attempt.channelId) return;
        finish(false);
        self._pttAttempt = null;
        self._pttChannelId = null;
      }
      // Unrelated channel events must not consume the awaited grant listener.
      attempt.socket.on('ptt:granted', onGranted);
      attempt.socket.on('ptt:busy', onBusy);
      attempt.socket.emit('ptt:start', { channelId: attempt.channelId, requestId: attempt.requestId });
    });
  };

  RadioClient.prototype._releaseCapture = function (capture) {
    if (!capture) return Promise.resolve();
    if (this._capture === capture) this._capture = null;
    if (capture.worklet) {
      capture.worklet.port.onmessage = null;
      capture.worklet.disconnect();
    }
    if (capture.fallback) {
      capture.fallback.onaudioprocess = null;
      capture.fallback.disconnect();
    }
    if (capture.source) capture.source.disconnect();
    if (capture.stream) capture.stream.getTracks().forEach(function (track) { track.stop(); });
    return capture.ctx ? capture.ctx.close().catch(function () {}) : Promise.resolve();
  };

  RadioClient.prototype._beginCapture = async function (attempt) {
    var self = this;
    var stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: PCM_SPEC.sampleRate,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    if (!this._isCurrentPtt(attempt)) {
      stream.getTracks().forEach(function (track) { track.stop(); });
      return false;
    }
    var AudioCtx = window.AudioContext || window.webkitAudioContext;
    var capture = { stream: stream, ctx: null, source: null, worklet: null, fallback: null };
    this._capture = capture;
    try {
      capture.ctx = new AudioCtx({ sampleRate: PCM_SPEC.sampleRate });
      if (capture.ctx.state === 'suspended') await capture.ctx.resume();
      if (!this._isCurrentPtt(attempt)) return false;
      capture.source = capture.ctx.createMediaStreamSource(stream);
      function sendFrame(samples) {
        if (!self._transmitting || !self._isCurrentPtt(attempt)) return;
        attempt.ws.send(buildBinaryFrame(self._txSequence++, attempt.channelId, self._unitId, samples));
      }
      try {
        await capture.ctx.audioWorklet.addModule(this._serverUrl + '/pcm-capture-worklet.js');
        if (!this._isCurrentPtt(attempt)) return false;
        capture.worklet = new AudioWorkletNode(capture.ctx, 'pcm-capture-processor');
        capture.worklet.port.onmessage = function (event) {
          if (event.data.type === 'pcmFrame') sendFrame(event.data.samples);
        };
        capture.source.connect(capture.worklet);
        capture.worklet.connect(capture.ctx.destination);
      } catch (error) {
        if (!this._isCurrentPtt(attempt)) return false;
        capture.fallback = capture.ctx.createScriptProcessor(1024, 1, 1);
        var buffer = new Int16Array(0);
        capture.fallback.onaudioprocess = function (event) {
          if (!self._transmitting || !self._isCurrentPtt(attempt)) return;
          var input = event.inputBuffer.getChannelData(0);
          var chunk = new Int16Array(input.length);
          for (var i = 0; i < input.length; i++) {
            var value = Math.max(-1, Math.min(1, input[i]));
            chunk[i] = value < 0 ? value * 32768 : value * 32767;
          }
          var merged = new Int16Array(buffer.length + chunk.length);
          merged.set(buffer, 0);
          merged.set(chunk, buffer.length);
          buffer = merged;
          while (buffer.length >= PCM_SPEC.frameSamples) {
            sendFrame(buffer.slice(0, PCM_SPEC.frameSamples));
            buffer = buffer.slice(PCM_SPEC.frameSamples);
          }
        };
        capture.source.connect(capture.fallback);
        capture.fallback.connect(capture.ctx.destination);
      }
      return this._isCurrentPtt(attempt);
    } finally {
      if (!this._isCurrentPtt(attempt)) await this._releaseCapture(capture);
    }
  };

  RadioClient.prototype.stopPtt = async function () {
    var attempt = this._pttAttempt;
    var channelId = this._pttChannelId;
    var socket = attempt ? attempt.socket : this._socket;
    this._transmitting = false;
    this._pttAttempt = null;
    this._pttChannelId = null;
    if (attempt && attempt.cancel) attempt.cancel();
    // Release the captured channel before awaiting audio teardown or switching.
    if (channelId && socket && socket === this._socket && this._authenticated && socket.connected) {
      socket.emit('ptt:end', { channelId: channelId });
    }
    await this._releaseCapture(this._capture);
  };

  RadioClient.prototype.setChannel = async function (channelId) {
    this._assertAlive();
    if (!this._readyPromise) throw new Error('RadioClient is not initialized');
    channelId = channelId || null;
    var previousChannelId = this._channelId;
    var generation = ++this._channelGeneration;
    this._channelId = channelId;
    this._reception = null;
    this.stopPtt();
    if (this._cancelChannelJoin) this._cancelChannelJoin();
    this._closeAudioWs();
    if (previousChannelId) this._leaveChannel(previousChannelId);
    if (this._joinedChannelId && this._joinedChannelId !== previousChannelId) {
      this._leaveChannel(this._joinedChannelId);
    }
    this._joinedChannelId = null;
    this._emit('connectionChange', { connected: this.isConnected(), ready: false });
    await this._readyPromise;
    await this._activateChannel(channelId, generation);
  };

  RadioClient.prototype.getZones = async function () {
    var res = await fetch(this._serverUrl + '/api/cad-integration/zones', {
      credentials: 'include',
    });
    if (!res.ok) throw new Error('Failed to fetch zones');
    return await res.json();
  };

  RadioClient.prototype.getChannels = async function (zone) {
    var url = this._serverUrl + '/api/cad-integration/channels';
    if (zone) url += '?zone=' + encodeURIComponent(zone);
    var res = await fetch(url, {
      credentials: 'include',
    });
    if (!res.ok) throw new Error('Failed to fetch channels');
    return await res.json();
  };

  RadioClient.prototype.on = function (event, callback) {
    if (!this._listeners[event]) {
      this._listeners[event] = [];
    }
    this._listeners[event].push(callback);
    return this;
  };

  RadioClient.prototype.off = function (event, callback) {
    if (this._listeners[event]) {
      this._listeners[event] = this._listeners[event].filter(function (cb) {
        return cb !== callback;
      });
    }
    return this;
  };

  RadioClient.prototype._emit = function (event, data) {
    var cbs = this._listeners[event];
    if (!cbs) return;
    for (var i = 0; i < cbs.length; i++) {
      try {
        cbs[i](data);
      } catch (e) {
        console.error('[RadioClient] Listener error for ' + event + ':', e);
      }
    }
  };

  RadioClient.prototype.destroy = async function () {
    if (this._destroyed) return;
    this._destroyed = true;
    ++this._channelGeneration;
    var captureStopped = this.stopPtt();
    if (this._cancelSignaling) this._cancelSignaling();
    if (this._cancelChannelJoin) this._cancelChannelJoin();
    if (this._channelId) this._leaveChannel(this._channelId);
    if (this._joinedChannelId && this._joinedChannelId !== this._channelId) {
      this._leaveChannel(this._joinedChannelId);
    }
    this._closeAudioWs();
    var socket = this._socket;
    this._socket = null;
    this._authenticated = false;
    this._joinedChannelId = null;
    this._reception = null;
    if (socket) socket.disconnect();
    var playback = this._playback;
    this._playback = null;
    if (playback) {
      if (playback.workletNode) playback.workletNode.disconnect();
      if (playback.fallbackProcessor) {
        playback.fallbackProcessor.onaudioprocess = null;
        playback.fallbackProcessor.disconnect();
      }
      if (playback.ctx) await playback.ctx.close().catch(function () {});
    }
    this._listeners = {};
    await captureStopped;
  };

  RadioClient.prototype.isTransmitting = function () {
    return this._transmitting;
  };

  RadioClient.prototype.isConnected = function () {
    return this._authenticated && this._socket && this._socket.connected;
  };

  RadioClient.prototype.getChannelId = function () {
    return this._channelId;
  };

  RadioClient.prototype.getActiveChannelId = function () {
    return this._activeChannelId;
  };

  RadioClient.prototype.getReception = function () {
    return this._acceptChannelEvent(this._reception) ? {
      channelId: this._reception.channelId,
      unitId: this._reception.unitId,
    } : null;
  };

  RadioClient.prototype.getUnitId = function () {
    return this._unitId;
  };

  RadioClient.prototype.getUsername = function () {
    return this._username;
  };

  RadioClient.prototype.getDeviceId = function () {
    return this._deviceId;
  };

  global.RadioClient = RadioClient;

})(typeof window !== 'undefined' ? window : this);

