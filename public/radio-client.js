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
    sampleRate: 48000,
    channels: 1,
    frameSamples: 960,
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

  function RadioClient() {
    this._serverUrl = '';
    this._channelId = null;
    this._socket = null;
    this._ws = null;
    this._unitId = null;
    this._username = null;
    this._isDispatcher = false;
    this._authenticated = false;
    this._transmitting = false;
    this._txSequence = 0;
    this._capture = null;
    this._playback = null;
    this._listeners = {};
    this._destroyed = false;
  }

  RadioClient.prototype.init = async function (options) {
    if (!options || !options.serverUrl) {
      throw new Error('serverUrl is required');
    }

    this._serverUrl = options.serverUrl.replace(/\/$/, '');
    this._channelId = options.channelId || null;

    await this._fetchUserInfo();
    await this._connectSignaling();
    await this._initPlayback();

    if (this._channelId) {
      await this._joinChannel(this._channelId);
      await this._connectAudioWs(this._channelId);
    }
  };

  RadioClient.prototype._fetchUserInfo = async function () {
    var res = await fetch(this._serverUrl + '/api/auth/me', {
      credentials: 'include',
    });
    if (!res.ok) {
      throw new Error('Not authenticated. Call POST /api/auth/cad-login first.');
    }
    var data = await res.json();
    var user = data.user;
    this._unitId = user.unit_id || user.username;
    this._username = user.username;
    this._isDispatcher = user.is_dispatcher || false;
  };

  RadioClient.prototype._connectSignaling = function () {
    var self = this;

    return new Promise(function (resolve, reject) {
      if (typeof io === 'undefined') {
        var script = document.createElement('script');
        script.src = self._serverUrl + '/socket.io/socket.io.js';
        script.onload = function () {
          self._doConnect(resolve, reject);
        };
        script.onerror = function () {
          reject(new Error('Failed to load Socket.IO client library'));
        };
        document.head.appendChild(script);
      } else {
        self._doConnect(resolve, reject);
      }
    });
  };

  RadioClient.prototype._doConnect = function (resolve, reject) {
    var self = this;
    var settled = false;

    this._socket = io(this._serverUrl, {
      path: '/signaling',
      withCredentials: true,
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 999,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });

    var timeout = setTimeout(function () {
      if (!settled) {
        settled = true;
        reject(new Error('Signaling connection timeout'));
      }
    }, 10000);

    this._socket.on('connect', function () {
      clearTimeout(timeout);
      self._emit('connectionChange', { connected: true });

      self._socket.emit('authenticate', {
        unitId: self._unitId,
        username: self._username,
        agencyId: 'default',
        isDispatcher: self._isDispatcher,
      });
    });

    this._socket.on('authenticated', function (data) {
      self._authenticated = true;
      if (!settled) {
        settled = true;
        resolve();
      }
    });

    this._socket.on('disconnect', function (reason) {
      self._authenticated = false;
      self._emit('connectionChange', { connected: false, reason: reason });
    });

    this._socket.on('connect_error', function (err) {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error('Signaling connection failed: ' + err.message));
      }
    });

    this._socket.on('ptt:start', function (data) {
      self._emit('pttStart', data);
    });
    this._socket.on('ptt:end', function (data) {
      self._emit('pttEnd', data);
    });
    this._socket.on('ptt:busy', function (data) {
      self._emit('pttBusy', data);
    });
    this._socket.on('ptt:granted', function (data) {
      self._emit('pttGranted', data);
    });
    this._socket.on('channel:join', function (data) {
      self._emit('channelJoin', data);
    });
    this._socket.on('channel:leave', function (data) {
      self._emit('channelLeave', data);
    });
    this._socket.on('channel:members', function (data) {
      self._emit('channelMembers', data);
    });
    this._socket.on('emergency:start', function (data) {
      self._emit('emergencyStart', data);
    });
    this._socket.on('emergency:end', function (data) {
      self._emit('emergencyEnd', data);
    });
  };

  RadioClient.prototype._joinChannel = function (channelId) {
    if (this._socket && this._authenticated) {
      this._socket.emit('channel:join', { channelId: channelId });
    }
  };

  RadioClient.prototype._leaveChannel = function (channelId) {
    if (this._socket && this._authenticated) {
      this._socket.emit('channel:leave', { channelId: channelId });
    }
  };

  RadioClient.prototype._connectAudioWs = function (channelId) {
    var self = this;

    if (this._ws) {
      this._ws.onclose = null;
      this._ws.close();
      this._ws = null;
    }

    return new Promise(function (resolve, reject) {
      var proto = self._serverUrl.startsWith('https') ? 'wss:' : 'ws:';
      var host = self._serverUrl.replace(/^https?:\/\//, '');
      var url = proto + '//' + host + '/api/audio-ws?channelId=' +
        encodeURIComponent(channelId) + '&unitId=' + encodeURIComponent(self._unitId);

      var ws = new WebSocket(url);

      ws.onopen = function () {
        self._ws = ws;
        resolve();
      };

      ws.onerror = function () {
        reject(new Error('Audio WebSocket connection failed'));
      };

      ws.onmessage = function (evt) {
        if (typeof evt.data !== 'string') return;
        var msg;
        try {
          msg = JSON.parse(evt.data);
        } catch (e) {
          return;
        }

        if (!validatePcmPacket(msg)) return;
        if (msg.senderUnitId && msg.senderUnitId === self._unitId) return;

        if (self._playback) {
          var frame = new Int16Array(msg.payload);
          self._playback.enqueue(frame);
        }
      };

      ws.onclose = function () {
        if (self._ws === ws) {
          self._ws = null;
        }
      };
    });
  };

  RadioClient.prototype._initPlayback = async function () {
    var AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;

    var ctx = new AudioCtx({ sampleRate: PCM_SPEC.sampleRate });
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }

    var self = this;
    this._playback = {
      ctx: ctx,
      workletNode: null,
      fallbackProcessor: null,
      fallbackQueue: [],
      fallbackOffset: 0,
    };

    try {
      await ctx.audioWorklet.addModule(this._serverUrl + '/pcm-playback-worklet.js');
      this._playback.workletNode = new AudioWorkletNode(ctx, 'pcm-playback-processor', {
        outputChannelCount: [1],
      });
      this._playback.workletNode.connect(ctx.destination);
    } catch (e) {
      var proc = ctx.createScriptProcessor(1024, 1, 1);
      proc.onaudioprocess = function (event) {
        var output = event.outputBuffer.getChannelData(0);
        var written = 0;
        var q = self._playback.fallbackQueue;
        while (written < output.length && q.length > 0) {
          var current = q[0];
          var offset = self._playback.fallbackOffset;
          var available = current.length - offset;
          var needed = output.length - written;
          var count = Math.min(available, needed);
          for (var i = 0; i < count; i++) {
            var sample = (current[offset + i] / 32768) * 2.5;
            if (sample > 0.8 || sample < -0.8) sample = Math.tanh(sample);
            output[written + i] = sample;
          }
          written += count;
          self._playback.fallbackOffset += count;
          if (self._playback.fallbackOffset >= current.length) {
            q.shift();
            self._playback.fallbackOffset = 0;
          }
        }
        for (var j = written; j < output.length; j++) {
          output[j] = 0;
        }
      };
      proc.connect(ctx.destination);
      this._playback.fallbackProcessor = proc;
    }

    this._playback.enqueue = function (int16Frame) {
      if (self._playback.ctx && self._playback.ctx.state === 'suspended') {
        self._playback.ctx.resume().catch(function () {});
      }
      var samples = (int16Frame instanceof Int16Array) ? int16Frame : new Int16Array(int16Frame);
      if (self._playback.workletNode) {
        self._playback.workletNode.port.postMessage({ type: 'enqueue', samples: samples });
      } else if (self._playback.fallbackProcessor) {
        self._playback.fallbackQueue.push(samples);
      }
    };
  };

  RadioClient.prototype.startPtt = async function () {
    if (this._transmitting || !this._channelId) return false;
    if (!this._socket || !this._authenticated) return false;
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return false;

    var self = this;

    return new Promise(function (resolve, reject) {
      var settled = false;

      var timeout = setTimeout(function () {
        if (!settled) {
          settled = true;
          cleanup();
          reject(new Error('PTT grant timeout'));
        }
      }, 3000);

      function cleanup() {
        clearTimeout(timeout);
        self._socket.off('ptt:granted', onGranted);
        self._socket.off('ptt:busy', onBusy);
      }

      function onGranted(data) {
        if (data.channelId === self._channelId) {
          settled = true;
          cleanup();
          self._beginCapture().then(function () {
            self._transmitting = true;
            resolve(true);
          }).catch(reject);
        }
      }

      function onBusy(data) {
        if (data.channelId === self._channelId) {
          settled = true;
          cleanup();
          self._emit('pttBusy', data);
          resolve(false);
        }
      }

      self._socket.once('ptt:granted', onGranted);
      self._socket.once('ptt:busy', onBusy);
      self._socket.emit('ptt:start', { channelId: self._channelId });
    });
  };

  RadioClient.prototype._beginCapture = async function () {
    var self = this;

    this._captureStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: PCM_SPEC.sampleRate,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });

    var AudioCtx = window.AudioContext || window.webkitAudioContext;
    this._captureCtx = new AudioCtx({ sampleRate: PCM_SPEC.sampleRate });
    if (this._captureCtx.state === 'suspended') {
      await this._captureCtx.resume();
    }

    this._captureSource = this._captureCtx.createMediaStreamSource(this._captureStream);

    try {
      await this._captureCtx.audioWorklet.addModule(this._serverUrl + '/pcm-capture-worklet.js');
      this._captureWorklet = new AudioWorkletNode(this._captureCtx, 'pcm-capture-processor');
      this._captureWorklet.port.onmessage = function (event) {
        if (event.data.type === 'pcmFrame' && self._transmitting && self._ws && self._ws.readyState === WebSocket.OPEN) {
          var packet = buildPcmPacket(self._txSequence++, self._channelId, event.data.samples);
          self._ws.send(JSON.stringify(packet));
        }
      };
      this._captureSource.connect(this._captureWorklet);
      this._captureWorklet.connect(this._captureCtx.destination);
    } catch (e) {
      this._captureFallback = this._captureCtx.createScriptProcessor(1024, 1, 1);
      this._captureFallbackBuffer = new Int16Array(0);
      this._captureFallback.onaudioprocess = function (event) {
        if (!self._transmitting || !self._ws || self._ws.readyState !== WebSocket.OPEN) return;
        var input = event.inputBuffer.getChannelData(0);
        var pcmChunk = new Int16Array(input.length);
        for (var i = 0; i < input.length; i++) {
          var s = Math.max(-1, Math.min(1, input[i]));
          pcmChunk[i] = s < 0 ? s * 32768 : s * 32767;
        }
        var merged = new Int16Array(self._captureFallbackBuffer.length + pcmChunk.length);
        merged.set(self._captureFallbackBuffer, 0);
        merged.set(pcmChunk, self._captureFallbackBuffer.length);
        self._captureFallbackBuffer = merged;
        while (self._captureFallbackBuffer.length >= PCM_SPEC.frameSamples) {
          var frame = self._captureFallbackBuffer.slice(0, PCM_SPEC.frameSamples);
          self._captureFallbackBuffer = self._captureFallbackBuffer.slice(PCM_SPEC.frameSamples);
          var packet = buildPcmPacket(self._txSequence++, self._channelId, frame);
          self._ws.send(JSON.stringify(packet));
        }
      };
      this._captureSource.connect(this._captureFallback);
      this._captureFallback.connect(this._captureCtx.destination);
    }
  };

  RadioClient.prototype.stopPtt = async function () {
    if (!this._transmitting) return;
    this._transmitting = false;

    if (this._captureWorklet) {
      this._captureWorklet.disconnect();
      this._captureWorklet.port.onmessage = null;
      this._captureWorklet = null;
    }
    if (this._captureFallback) {
      this._captureFallback.disconnect();
      this._captureFallback.onaudioprocess = null;
      this._captureFallback = null;
      this._captureFallbackBuffer = null;
    }
    if (this._captureSource) {
      this._captureSource.disconnect();
      this._captureSource = null;
    }
    if (this._captureStream) {
      this._captureStream.getTracks().forEach(function (t) { t.stop(); });
      this._captureStream = null;
    }
    if (this._captureCtx) {
      await this._captureCtx.close().catch(function () {});
      this._captureCtx = null;
    }

    if (this._socket && this._channelId) {
      this._socket.emit('ptt:end', { channelId: this._channelId });
    }
  };

  RadioClient.prototype.setChannel = async function (channelId) {
    if (this._transmitting) {
      await this.stopPtt();
    }

    if (this._channelId) {
      this._leaveChannel(this._channelId);
    }

    this._channelId = channelId;

    if (channelId) {
      this._joinChannel(channelId);
      await this._connectAudioWs(channelId);
    }
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

    await this.stopPtt();

    if (this._channelId && this._socket) {
      this._leaveChannel(this._channelId);
    }

    if (this._ws) {
      this._ws.onclose = null;
      this._ws.close();
      this._ws = null;
    }

    if (this._socket) {
      this._socket.disconnect();
      this._socket = null;
    }

    if (this._playback) {
      if (this._playback.workletNode) {
        this._playback.workletNode.port.postMessage({ type: 'clear' });
        this._playback.workletNode.disconnect();
      }
      if (this._playback.fallbackProcessor) {
        this._playback.fallbackProcessor.disconnect();
      }
      if (this._playback.ctx) {
        await this._playback.ctx.close().catch(function () {});
      }
      this._playback = null;
    }

    this._listeners = {};
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

  RadioClient.prototype.getUnitId = function () {
    return this._unitId;
  };

  RadioClient.prototype.getUsername = function () {
    return this._username;
  };

  global.RadioClient = RadioClient;

})(typeof window !== 'undefined' ? window : this);
