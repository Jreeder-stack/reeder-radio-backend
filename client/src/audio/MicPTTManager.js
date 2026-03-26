import { PTT_STATES } from '../constants/pttStates.js';
import { playPermitTone, startBonkLoop, stopBonkLoop } from './talkPermitTone.js';
import { unlockAudio } from './iosAudioUnlock.js';
import { processRadioVoice, cleanup as cleanupRadioDSP } from './radioVoiceDSP.js';
import { acquireWakeLock, releaseWakeLock } from '../plugins/backgroundService.js';
import { isNativeLiveKitAvailable, nativeEnableMic, nativeDisableMic } from '../plugins/nativeLiveKit.js';
import { getOpusBrowserCodec, initOpusBrowserCodec } from './OpusBrowserCodec.js';

const isNativeAndroid = () => isNativeLiveKitAvailable();

const PTT_COOLDOWN_MS = 500;
const PTT_READY_TIMEOUT_MS = 5000;
const PCM_FRAME_SIZE = 960;

class MicPTTManager {
  constructor() {
    this.state = PTT_STATES.IDLE;
    this.audioContext = null;
    this.stream = null;
    this.browserTrack = null;
    this._ws = null;
    this._captureWorkletNode = null;
    this._captureWorkletReady = false;
    this._sourceNode = null;
    this._txSequence = 0;
    this.onStateChange = null;
    this.onError = null;
    this.onDisconnectDuringTx = null;
    this.pendingStop = false;
    this.transitionLock = false;
    this.permitDeadlineTimer = null;
    this.publishComplete = false;
    this.lastPttEndTime = 0;
    this.stateListeners = new Set();
    this._wsCloseHandler = null;
    this._signalingManager = null;
    this._pttReadyResolver = null;
    this._currentChannelId = null;
    this._currentUnitId = null;

    this._wsResolver = null;
    this._waitingForWs = false;
  }

  setSignalingManager(signalingManager) {
    this._signalingManager = signalingManager;
  }

  setCurrentChannel(channelId) {
    this._currentChannelId = channelId;
  }

  setCurrentUnit(unitId) {
    this._currentUnitId = unitId;
  }

  _waitForPttReady() {
    return new Promise((resolve) => {
      if (!this._signalingManager) {
        resolve(false);
        return;
      }

      let timeout = null;
      let unsubscribe = null;

      const onReady = (data) => {
        const channelMatch = !this._currentChannelId || data.channelId === this._currentChannelId;
        const unitMatch = !this._currentUnitId || data.unitId === this._currentUnitId;

        if (channelMatch && unitMatch) {
          console.log(`[MicPTT] PTT_READY received for ${data.unitId} on ${data.channelId}`);
          if (timeout) clearTimeout(timeout);
          if (unsubscribe) unsubscribe();
          this._pttReadyResolver = null;
          resolve(true);
        }
      };

      unsubscribe = this._signalingManager.on('pttReady', onReady);

      timeout = setTimeout(() => {
        console.log('[MicPTT] PTT_READY timeout - proceeding anyway');
        if (unsubscribe) unsubscribe();
        this._pttReadyResolver = null;
        resolve(false);
      }, PTT_READY_TIMEOUT_MS);

      this._pttReadyResolver = { resolve, timeout, unsubscribe };
    });
  }

  _cancelPttReadyWait() {
    if (this._pttReadyResolver) {
      if (this._pttReadyResolver.timeout) clearTimeout(this._pttReadyResolver.timeout);
      if (this._pttReadyResolver.unsubscribe) this._pttReadyResolver.unsubscribe();
      if (this._pttReadyResolver.resolve) this._pttReadyResolver.resolve(false);
      this._pttReadyResolver = null;
    }
  }

  addStateListener(callback) {
    this.stateListeners.add(callback);
    return () => this.stateListeners.delete(callback);
  }

  removeStateListener(callback) {
    this.stateListeners.delete(callback);
  }

  getState() {
    return this.state;
  }

  isTransmitting() {
    return this.state === PTT_STATES.TRANSMITTING;
  }

  canStart() {
    if (this.state !== PTT_STATES.IDLE || this.transitionLock) {
      return false;
    }
    const timeSinceLastEnd = Date.now() - this.lastPttEndTime;
    if (timeSinceLastEnd < PTT_COOLDOWN_MS) {
      console.log(`[MicPTT] Cooldown active - ${PTT_COOLDOWN_MS - timeSinceLastEnd}ms remaining`);
      return false;
    }
    return true;
  }

  canStop() {
    return this.state === PTT_STATES.TRANSMITTING ||
           this.state === PTT_STATES.ARMING ||
           this.state === PTT_STATES.BUSY;
  }

  _setState(newState) {
    const oldState = this.state;
    this.state = newState;
    console.log(`[MicPTT] State: ${oldState} → ${newState}`);
    if (this.onStateChange) {
      this.onStateChange(newState, oldState);
    }
    this.stateListeners.forEach(listener => {
      try {
        listener(newState, oldState);
      } catch (e) {
        console.error('[MicPTT] State listener error:', e);
      }
    });
  }

  _ensureAudioContext() {
    if (!this.audioContext || this.audioContext.state === 'closed') {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
    }
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume().catch(e => console.warn('[MicPTT] AudioContext resume failed:', e));
    }
    return this.audioContext;
  }

  setWsTransport(ws) {
    this._removeWsListeners();
    this._ws = ws;

    if (this._waitingForWs && this._wsResolver) {
      console.log('[MicPTT] WS transport received while waiting - resolving promise');
      this._wsResolver(ws);
      this._wsResolver = null;
      this._waitingForWs = false;
    }
  }

  setRoom(room) {
    if (room && room.ws) {
      this.setWsTransport(room.ws);
    } else if (room && typeof room === 'object') {
      this.setWsTransport(room);
    }
  }

  _waitForWsTransport(timeoutMs = 5000) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      return Promise.resolve(this._ws);
    }

    this._waitingForWs = true;

    return new Promise((resolve, reject) => {
      this._wsRejecter = reject;

      this._wsWaitTimeout = setTimeout(() => {
        if (this._waitingForWs) {
          this._waitingForWs = false;
          this._wsResolver = null;
          this._wsRejecter = null;
          this._wsWaitTimeout = null;
          reject(new Error('WS transport connection timeout'));
        }
      }, timeoutMs);

      this._wsResolver = (ws) => {
        if (this._wsWaitTimeout) {
          clearTimeout(this._wsWaitTimeout);
          this._wsWaitTimeout = null;
        }
        this._wsRejecter = null;
        resolve(ws);
      };
    });
  }

  _cancelWsWait() {
    if (this._wsWaitTimeout) {
      clearTimeout(this._wsWaitTimeout);
      this._wsWaitTimeout = null;
    }
    if (this._wsRejecter) {
      this._wsRejecter(new Error('WS wait cancelled'));
      this._wsRejecter = null;
    }
    this._waitingForWs = false;
    this._wsResolver = null;
  }

  _setupWsListeners() {
    if (!this._ws) return;

    this._wsCloseHandler = () => {
      console.warn('[MicPTT] WS disconnected during transmission!');
      this._handleDisconnectDuringTx();
    };

    this._ws.addEventListener('close', this._wsCloseHandler);
  }

  _removeWsListeners() {
    if (this._ws && this._wsCloseHandler) {
      this._ws.removeEventListener('close', this._wsCloseHandler);
    }
    this._wsCloseHandler = null;
  }

  _handleDisconnectDuringTx() {
    if (this.state === PTT_STATES.TRANSMITTING || this.state === PTT_STATES.ARMING) {
      console.error('[MicPTT] Disconnected during active transmission - forcing cleanup');

      if (this.onDisconnectDuringTx) {
        this.onDisconnectDuringTx();
      }

      this.forceRelease();
    }
  }

  _clearPermitDeadline() {
    if (this.permitDeadlineTimer) {
      clearTimeout(this.permitDeadlineTimer);
      this.permitDeadlineTimer = null;
    }
  }

  async _ensureCaptureWorklet() {
    if (this._captureWorkletReady) return;
    const ctx = this._ensureAudioContext();
    await ctx.audioWorklet.addModule('/audio/pcm-capture-worklet.js');
    this._captureWorkletReady = true;
    console.log('[MicPTT] Capture worklet module loaded');
  }

  async start() {
    if (!this.canStart()) {
      console.log(`[MicPTT] start() — BLOCKED, state=${this.state} lock=${this.transitionLock}`);
      return false;
    }

    const native = isNativeAndroid();
    console.log(`[MicPTT] start() — path=${native ? 'NATIVE' : 'WEB'} channel=${this._currentChannelId} unit=${this._currentUnitId}`);

    if (native) {
      return this._startNative();
    }

    unlockAudio();
    acquireWakeLock().catch(e => console.warn('[MicPTT] Wake lock acquire failed:', e));

    this.transitionLock = true;
    this.pendingStop = false;

    try {
      this._setState(PTT_STATES.ARMING);
      const ctx = this._ensureAudioContext();
      await this._ensureCaptureWorklet();

      try {
        await initOpusBrowserCodec();
        console.log('[MicPTT] Opus browser codec ready');
      } catch (err) {
        console.warn('[MicPTT] Opus browser codec init failed, will fallback to PCM:', err.message);
      }

      playPermitTone();
      console.log('[MicPTT] Permit tone played immediately');

      let noiseSuppressionEnabled = true;
      try {
        const stored = localStorage.getItem('app_settings');
        if (stored) {
          const parsed = JSON.parse(stored);
          if (parsed.noiseSuppressionEnabled !== undefined) {
            noiseSuppressionEnabled = parsed.noiseSuppressionEnabled;
          }
        }
      } catch (e) {}

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: noiseSuppressionEnabled,
          autoGainControl: true
        }
      });

      if (this.pendingStop) {
        console.log('[MicPTT] Stop requested during mic acquisition - aborting');
        this._stopTracks(stream);
        this._setState(PTT_STATES.IDLE);
        this.transitionLock = false;
        return false;
      }

      this.stream = stream;

      const processedStream = processRadioVoice(stream);
      this.browserTrack = processedStream.getAudioTracks()[0];
      console.log('[MicPTT] Mic acquired with radio voice DSP');

      let ws = this._ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.log('[MicPTT] Waiting for WS transport connection...');
        try {
          ws = await this._waitForWsTransport(PTT_READY_TIMEOUT_MS);
          this._ws = ws;
        } catch (wsErr) {
          console.error('[MicPTT] WS transport connection failed:', wsErr);
          startBonkLoop();
          await this._cleanup();
          this.transitionLock = false;
          if (this.pendingStop) {
            stopBonkLoop();
            this.pendingStop = false;
            this._setState(PTT_STATES.IDLE);
          } else {
            this._setState(PTT_STATES.BUSY);
          }
          if (this.onError) {
            this.onError(wsErr);
          }
          return false;
        }
      }

      if (this.pendingStop) {
        console.log('[MicPTT] Stop requested during WS wait - aborting');
        this._stopTracks(stream);
        this._setState(PTT_STATES.IDLE);
        this.transitionLock = false;
        return false;
      }

      this._setupWsListeners();
      this.publishComplete = false;
      console.log('[MicPTT] WS transport ready, starting capture...');

      this.permitDeadlineTimer = setTimeout(() => {
        if (!this.publishComplete && this.state === PTT_STATES.ARMING && !this.pendingStop) {
          console.log('[MicPTT] Capture setup taking too long, starting bonk');
          startBonkLoop();
        }
      }, 2000);

      try {
        const source = ctx.createMediaStreamSource(new MediaStream([this.browserTrack]));
        this._sourceNode = source;

        const captureNode = new AudioWorkletNode(ctx, 'pcm-capture-processor');
        this._captureWorkletNode = captureNode;

        captureNode.port.onmessage = (e) => {
          if (e.data.type === 'pcm') {
            this._sendPcmFrame(e.data.samples);
          }
        };

        source.connect(captureNode);
        captureNode.connect(ctx.destination);

        captureNode.port.postMessage({ type: 'start' });

        this.publishComplete = true;
        this._clearPermitDeadline();
        stopBonkLoop();
      } catch (captureErr) {
        console.error('[MicPTT] Capture setup failed:', captureErr);
        this._clearPermitDeadline();
        startBonkLoop();
        await this._cleanup();
        this.transitionLock = false;
        if (this.pendingStop) {
          stopBonkLoop();
          this.pendingStop = false;
          this._setState(PTT_STATES.IDLE);
        } else {
          this._setState(PTT_STATES.BUSY);
        }
        if (this.onError) {
          this.onError(captureErr);
        }
        return false;
      }

      if (this.pendingStop) {
        console.log('[MicPTT] Stop requested during capture setup - cleaning up');
        await this._doStop();
        return false;
      }

      this._setState(PTT_STATES.TRANSMITTING);
      this.transitionLock = false;
      console.log('[MicPTT] Transmission active');
      return true;

    } catch (err) {
      console.error('[MicPTT] Start failed (mic access):', err);
      startBonkLoop();
      await this._cleanup();
      this.transitionLock = false;
      if (this.pendingStop) {
        stopBonkLoop();
        this.pendingStop = false;
        this._setState(PTT_STATES.IDLE);
      } else {
        this._setState(PTT_STATES.BUSY);
      }
      if (this.onError) {
        this.onError(err);
      }
      return false;
    }
  }

  _sendPcmFrame(int16Samples) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;

    const codec = getOpusBrowserCodec();
    if (codec.ready) {
      try {
        const opusData = codec.encode(int16Samples);

        const frame = new Uint8Array(3 + opusData.length);
        frame[0] = 0x02;
        frame[1] = (this._txSequence >> 8) & 0xFF;
        frame[2] = this._txSequence & 0xFF;
        frame.set(opusData, 3);
        this._txSequence = (this._txSequence + 1) & 0xFFFF;

        this._ws.send(frame.buffer);
      } catch (err) {
        console.warn('[MicPTT] Opus encode/send error:', err.message);
      }
    } else {
      const header = new ArrayBuffer(3);
      const view = new DataView(header);
      view.setUint8(0, 0x01);
      view.setUint16(1, this._txSequence & 0xFFFF);
      this._txSequence++;

      const pcmBytes = new Uint8Array(int16Samples.buffer, int16Samples.byteOffset, int16Samples.byteLength);
      const frame = new Uint8Array(3 + pcmBytes.length);
      frame.set(new Uint8Array(header), 0);
      frame.set(pcmBytes, 3);

      try {
        this._ws.send(frame.buffer);
      } catch (err) {
        console.warn('[MicPTT] WS send error:', err.message);
      }
    }
  }

  _isDeadObjectError(err) {
    if (!err) return false;
    const msg = (err.message || err.toString() || '').toLowerCase();
    return msg.includes('-38') || msg.includes('dead object') || msg.includes('deadobject');
  }

  async _startNative() {
    console.log('[MicPTT] _startNative() — BEGIN');
    acquireWakeLock().catch(e => console.warn('[MicPTT] Native wake lock acquire failed:', e));

    this.transitionLock = true;
    this.pendingStop = false;

    try {
      this._setState(PTT_STATES.ARMING);
      playPermitTone();

      await new Promise(resolve => setTimeout(resolve, 200));

      const success = await nativeEnableMic();
      if (!success) {
        console.error('[MicPTT] _startNative() — nativeEnableMic FAILED');
        await new Promise(resolve => setTimeout(resolve, 100));
        startBonkLoop();
        this.transitionLock = false;
        this._setState(PTT_STATES.BUSY);
        return false;
      }

      if (this.pendingStop) {
        try {
          await nativeDisableMic();
        } catch (stopErr) {
          if (!this._isDeadObjectError(stopErr)) {
            console.warn('[MicPTT] _startNative() — error on pendingStop disable:', stopErr);
          }
        }
        this._setState(PTT_STATES.IDLE);
        this.transitionLock = false;
        return false;
      }

      stopBonkLoop();
      this._setState(PTT_STATES.TRANSMITTING);
      this.transitionLock = false;
      return true;

    } catch (err) {
      if (this._isDeadObjectError(err)) {
        console.warn('[MicPTT] _startNative() — dead object caught, resetting to IDLE');
      } else {
        console.error('[MicPTT] _startNative() — ERROR:', err);
      }
      this.pendingStop = false;
      this.transitionLock = false;
      this._setState(PTT_STATES.IDLE);
      releaseWakeLock().catch(() => {});
      return false;
    }
  }

  async stop() {
    const native = isNativeAndroid();
    console.log(`[MicPTT] stop() — state=${this.state} path=${native ? 'NATIVE' : 'WEB'}`);

    stopBonkLoop();

    if (this.state === PTT_STATES.IDLE) {
      return;
    }

    if (this.state === PTT_STATES.BUSY) {
      this._setState(PTT_STATES.IDLE);
      return;
    }

    if (this.state === PTT_STATES.ARMING) {
      console.log('[MicPTT] Setting pendingStop flag');
      this.pendingStop = true;
      this._cancelPttReadyWait();
      this._cancelWsWait();
      return;
    }

    if (this.state === PTT_STATES.COOLDOWN) {
      return;
    }

    if (isNativeAndroid()) {
      return this._doStopNative();
    }

    await this._doStop();
  }

  async _doStopNative() {
    this._setState(PTT_STATES.COOLDOWN);

    try {
      await nativeDisableMic();
    } catch (err) {
      if (!this._isDeadObjectError(err)) {
        console.error('[MicPTT] _doStopNative() — ERROR:', err);
      }
    } finally {
      this.pendingStop = false;
      this.transitionLock = false;
      this.lastPttEndTime = Date.now();
      this._setState(PTT_STATES.IDLE);
      releaseWakeLock().catch(e => console.warn('[MicPTT] Native wake lock release failed:', e));
    }
  }

  async _doStop() {
    this._setState(PTT_STATES.COOLDOWN);

    this._removeWsListeners();

    try {
      if (this._captureWorkletNode) {
        this._captureWorkletNode.port.postMessage({ type: 'stop' });
        try { this._captureWorkletNode.disconnect(); } catch (e) {}
        this._captureWorkletNode = null;
      }

      if (this._sourceNode) {
        try { this._sourceNode.disconnect(); } catch (e) {}
        this._sourceNode = null;
      }

      this._cleanup();

    } catch (err) {
      console.error('[MicPTT] Stop error:', err);
    } finally {
      this.pendingStop = false;
      this.transitionLock = false;
      this.lastPttEndTime = Date.now();
      this._setState(PTT_STATES.IDLE);
      releaseWakeLock().catch(e => console.warn('[MicPTT] Wake lock release failed:', e));
      console.log('[MicPTT] Transmission ended, state reset to IDLE');
    }
  }

  async _cleanup() {
    this._clearPermitDeadline();
    this._cancelWsWait();
    this.publishComplete = false;
    stopBonkLoop();
    cleanupRadioDSP();

    if (this._captureWorkletNode) {
      try {
        this._captureWorkletNode.port.postMessage({ type: 'stop' });
        this._captureWorkletNode.disconnect();
      } catch (e) {}
      this._captureWorkletNode = null;
    }

    if (this._sourceNode) {
      try { this._sourceNode.disconnect(); } catch (e) {}
      this._sourceNode = null;
    }

    if (this.browserTrack) {
      try {
        this.browserTrack.stop();
        console.log('[MicPTT] Browser track stopped');
      } catch (e) {}
      this.browserTrack = null;
    }

    if (this.stream) {
      this.stream.getTracks().forEach(t => {
        try {
          t.stop();
        } catch (e) {}
      });
      this.stream = null;
    }
  }

  _stopTracks(stream) {
    if (stream) {
      stream.getTracks().forEach(t => {
        try { t.stop(); } catch (e) {}
      });
    }
  }

  forceRelease() {
    console.log('[MicPTT] Force release');

    this._clearPermitDeadline();
    this._removeWsListeners();
    this._cancelWsWait();
    this._cancelPttReadyWait();
    stopBonkLoop();

    this._cleanup();
    this.pendingStop = false;
    this.transitionLock = false;

    if (this.state !== PTT_STATES.IDLE) {
      this._setState(PTT_STATES.IDLE);
    }
  }

  disconnect() {
    this.forceRelease();
    this._ws = null;

    if (this.audioContext && this.audioContext.state !== 'closed') {
      try {
        this.audioContext.close();
      } catch (e) {}
      this.audioContext = null;
      this._captureWorkletReady = false;
    }
  }
}

export const micPTTManager = new MicPTTManager();
export { PTT_STATES };
export default micPTTManager;
