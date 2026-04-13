import { spawn } from 'child_process';
import OpusScript from 'opusscript';
import { audioRelayService } from './audioRelayService.js';
import { floorControlService } from './floorControlService.js';
import { signalingService, SIGNALING_EVENTS, RADIO_EVENTS } from './signalingService.js';
import { canonicalChannelKey } from './channelKeyUtils.js';

const SCANNER_IDENTITY = 'SCANNER';
const SCANNER_SAMPLE_RATE = 16000;
const SCANNER_CHANNELS = 1;
const SCANNER_FRAME_SIZE = 320;
const FRAME_MS = 20;
const SILENCE_TIMEOUT_MS = 500;
const VAD_THRESHOLD_RMS = 300;
const VAD_SPEECH_THRESHOLD_RMS = 400;
const FFMPEG_STARTUP_TIMEOUT_MS = 10000;
const FLOOR_REARM_INTERVAL_MS = 15000;
const FLOOR_YIELD_RESUME_CHECK_MS = 500;

const RECONNECT_INITIAL_DELAY_MS = 2000;
const RECONNECT_MAX_DELAY_MS = 60000;
const RECONNECT_MAX_ATTEMPTS = 10;

class ScannerFeedService {
  constructor() {
    this._running = false;
    this._ffmpeg = null;
    this._channelName = null;
    this._streamUrl = null;
    this._encoder = null;
    this._sequence = 0;
    this._transmitting = false;
    this._silenceStart = null;
    this._pcmBuffer = Buffer.alloc(0);
    this._pacingTimer = null;
    this._opusQueue = [];
    this._injecting = false;
    this._startedAt = null;
    this._floorRearmTimer = null;
    this._yielded = false;
    this._yieldResumeTimer = null;
    this._pttAttemptUnsub = null;
    this._pttEndUnsub = null;
    this._configuredStreamUrl = null;
    this._configuredChannelName = null;
    this._configuredDisplayName = null;
    this._channelDisplayName = null;

    this._state = 'stopped';
    this._retryCount = 0;
    this._lastError = null;
    this._reconnectTimer = null;
  }

  get isRunning() {
    return this._running;
  }

  getStatus() {
    const isActive = this._running || this._state === 'reconnecting';
    return {
      running: this._running,
      state: this._state,
      streamUrl: isActive ? this._streamUrl : (this._configuredStreamUrl || null),
      channelName: isActive ? (this._channelDisplayName || this._channelName) : (this._configuredDisplayName || this._configuredChannelName || null),
      channelRoomKey: isActive ? this._channelName : (this._configuredChannelName || null),
      startedAt: this._startedAt,
      transmitting: this._transmitting,
      retryCount: this._retryCount,
      maxReconnectAttempts: RECONNECT_MAX_ATTEMPTS,
      lastError: this._lastError,
    };
  }

  async start(streamUrl, channelRoomKey, channelDisplayName, { username, password } = {}) {
    if (this._running) {
      await this.stop();
    }

    this._streamUrl = streamUrl;
    this._channelName = channelRoomKey;
    this._channelDisplayName = channelDisplayName || channelRoomKey;
    this._configuredStreamUrl = streamUrl;
    this._configuredChannelName = channelRoomKey;
    this._configuredDisplayName = channelDisplayName || channelRoomKey;
    this._authHeader = (username && password) ? 'Authorization: Basic ' + Buffer.from(`${username}:${password}`).toString('base64') : null;
    this._running = true;
    this._state = 'running';
    this._sequence = 0;
    this._transmitting = false;
    this._silenceStart = null;
    this._pcmBuffer = Buffer.alloc(0);
    this._opusQueue = [];
    this._injecting = false;
    this._startedAt = Date.now();
    this._yielded = false;
    this._retryCount = 0;
    this._lastError = null;

    this._encoder = new OpusScript(SCANNER_SAMPLE_RATE, SCANNER_CHANNELS, OpusScript.Application.VOIP);
    try {
      this._encoder.encoderCTL(4002, 24000);
      this._encoder.encoderCTL(4012, 1);
    } catch (e) {
      console.warn('[ScannerFeed] Failed to configure encoder:', e.message);
    }

    this._registerPttCallbacks();

    const maskedUrl = streamUrl.length > 40 ? streamUrl.substring(0, 30) + '...' + streamUrl.substring(streamUrl.length - 8) : streamUrl;
    console.log(`[ScannerFeed] Starting stream: url=${maskedUrl} channel=${channelRoomKey} (${this._channelDisplayName})`);

    await this._startFfmpeg();
  }

  _registerPttCallbacks() {
    const channelKey = canonicalChannelKey(this._channelName);

    this._pttAttemptUnsub = signalingService.onPttAttempt((data) => {
      if (!this._running) return;
      const eventChannel = canonicalChannelKey(data.channelId);
      if (eventChannel !== channelKey) return;
      if (data.unitId === SCANNER_IDENTITY) return;

      console.log(`[ScannerFeed] Real user ${data.unitId} attempting PTT on ${channelKey}, yielding immediately`);
      this._yielded = true;
      if (this._transmitting) {
        this._endTransmission();
      }
    });

    this._pttEndUnsub = signalingService.onPttEnd((data) => {
      if (!this._running) return;
      const eventChannel = canonicalChannelKey(data.channelId);
      if (eventChannel !== channelKey) return;
      if (data.unitId === SCANNER_IDENTITY) return;

      console.log(`[ScannerFeed] Real user ${data.unitId} released PTT on ${channelKey}, scheduling resume`);
      this._scheduleYieldResume();
    });
  }

  _unregisterPttCallbacks() {
    if (this._pttAttemptUnsub) {
      this._pttAttemptUnsub();
      this._pttAttemptUnsub = null;
    }
    if (this._pttEndUnsub) {
      this._pttEndUnsub();
      this._pttEndUnsub = null;
    }
  }

  _scheduleYieldResume() {
    if (this._yieldResumeTimer) {
      clearTimeout(this._yieldResumeTimer);
    }
    this._yieldResumeTimer = setTimeout(() => {
      this._yieldResumeTimer = null;
      if (!this._running) return;
      const channelKey = canonicalChannelKey(this._channelName);
      const holder = floorControlService.getFloorHolder(channelKey);
      if (!holder || holder.unitId === SCANNER_IDENTITY) {
        this._yielded = false;
        console.log(`[ScannerFeed] Floor is free, scanner ready to transmit again`);
      } else {
        console.log(`[ScannerFeed] Floor still held by ${holder.unitId}, waiting...`);
        this._scheduleYieldResume();
      }
    }, FLOOR_YIELD_RESUME_CHECK_MS);
  }

  _startFfmpeg() {
    return new Promise((resolve, reject) => {
      const ffmpegArgs = [
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',
      ];
      if (this._authHeader) {
        ffmpegArgs.push('-headers', this._authHeader + '\r\n');
      }
      ffmpegArgs.push('-i', this._streamUrl);
      this._ffmpeg = spawn('ffmpeg', [
        ...ffmpegArgs,
        '-f', 's16le',
        '-acodec', 'pcm_s16le',
        '-ar', String(SCANNER_SAMPLE_RATE),
        '-ac', '1',
        '-',
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let resolved = false;
      let stderrBuf = '';

      const startupTimeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          const errorMsg = 'ffmpeg startup timed out — check stream URL';
          console.error(`[ScannerFeed] ${errorMsg}`);
          this._lastError = errorMsg;
          this._killFfmpegProcess();
          if (this._running) {
            this._scheduleReconnect(errorMsg);
          }
          resolve();
        }
      }, FFMPEG_STARTUP_TIMEOUT_MS);

      this._ffmpeg.stdout.on('data', (chunk) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(startupTimeout);
          console.log('[ScannerFeed] ffmpeg producing audio data, stream connected');
          this._retryCount = 0;
          this._lastError = null;
          this._state = 'running';
          resolve();
        }
        if (!this._running) return;
        this._processPcmChunk(chunk);
      });

      this._ffmpeg.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        stderrBuf += msg + '\n';
        if (msg && !msg.startsWith('frame=') && !msg.includes('size=')) {
          if (msg.includes('Error') || msg.includes('error') || msg.includes('Invalid')) {
            console.error(`[ScannerFeed] ffmpeg error: ${msg}`);
          }
        }
      });

      this._ffmpeg.on('close', (code) => {
        console.log(`[ScannerFeed] ffmpeg exited with code ${code}`);
        if (!resolved) {
          resolved = true;
          clearTimeout(startupTimeout);
          const errorMsg = `ffmpeg exited with code ${code} before producing audio`;
          this._lastError = errorMsg;
          this._killFfmpegProcess();
          if (this._running) {
            this._scheduleReconnect(errorMsg);
          }
          resolve();
          return;
        }
        if (this._running) {
          this._endTransmission();
          const errorMsg = `ffmpeg exited with code ${code}`;
          this._lastError = errorMsg;
          this._scheduleReconnect(errorMsg);
        }
      });

      this._ffmpeg.on('error', (err) => {
        console.error(`[ScannerFeed] ffmpeg spawn error: ${err.message}`);
        if (!resolved) {
          resolved = true;
          clearTimeout(startupTimeout);
          this._lastError = err.message;
          this._killFfmpegProcess();
          if (this._running) {
            this._scheduleReconnect(err.message);
          }
          resolve();
          return;
        }
        if (this._running) {
          this._lastError = err.message;
          this._scheduleReconnect(err.message);
        }
      });
    });
  }

  _scheduleReconnect(reason) {
    this._killFfmpegProcess();

    if (this._reconnectTimer) {
      return;
    }

    if (this._retryCount >= RECONNECT_MAX_ATTEMPTS) {
      console.error(`[ScannerFeed] Max reconnect attempts (${RECONNECT_MAX_ATTEMPTS}) reached, giving up. Last error: ${reason}`);
      this._state = 'errored';
      this._lastError = reason;
      this._running = false;
      this._cleanupTimersAndCallbacks();
      return;
    }

    this._retryCount++;
    const delay = Math.min(RECONNECT_INITIAL_DELAY_MS * Math.pow(2, this._retryCount - 1), RECONNECT_MAX_DELAY_MS);
    this._state = 'reconnecting';
    console.log(`[ScannerFeed] Scheduling reconnect attempt ${this._retryCount}/${RECONNECT_MAX_ATTEMPTS} in ${delay}ms (reason: ${reason})`);

    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      if (!this._running) return;

      console.log(`[ScannerFeed] Reconnect attempt ${this._retryCount}/${RECONNECT_MAX_ATTEMPTS}`);

      this._pcmBuffer = Buffer.alloc(0);
      this._opusQueue = [];
      this._injecting = false;
      this._transmitting = false;
      this._yielded = false;

      if (this._encoder) {
        try { this._encoder.delete(); } catch (_) {}
      }
      this._encoder = new OpusScript(SCANNER_SAMPLE_RATE, SCANNER_CHANNELS, OpusScript.Application.VOIP);
      try {
        this._encoder.encoderCTL(4002, 24000);
        this._encoder.encoderCTL(4012, 1);
      } catch (e) {
        console.warn('[ScannerFeed] Failed to configure encoder on reconnect:', e.message);
      }

      try {
        await this._startFfmpeg();
        if (this._state === 'running') {
          console.log(`[ScannerFeed] Reconnect successful`);
        }
      } catch (err) {
        console.error(`[ScannerFeed] Reconnect attempt ${this._retryCount} failed: ${err.message}`);
        this._lastError = err.message;
        if (this._running) {
          this._scheduleReconnect(err.message);
        }
      }
    }, delay);
  }

  _killFfmpegProcess() {
    if (this._ffmpeg) {
      try {
        this._ffmpeg.stdout.removeAllListeners();
        this._ffmpeg.stderr.removeAllListeners();
        this._ffmpeg.removeAllListeners();
        this._ffmpeg.kill('SIGTERM');
        const ffmpegRef = this._ffmpeg;
        setTimeout(() => {
          try { ffmpegRef.kill('SIGKILL'); } catch (_) {}
        }, 3000);
      } catch (_) {}
      this._ffmpeg = null;
    }
  }

  _cleanupTimersAndCallbacks() {
    if (this._pacingTimer) {
      clearInterval(this._pacingTimer);
      this._pacingTimer = null;
    }

    if (this._floorRearmTimer) {
      clearInterval(this._floorRearmTimer);
      this._floorRearmTimer = null;
    }

    if (this._yieldResumeTimer) {
      clearTimeout(this._yieldResumeTimer);
      this._yieldResumeTimer = null;
    }

    this._unregisterPttCallbacks();

    if (this._encoder) {
      try { this._encoder.delete(); } catch (_) {}
      this._encoder = null;
    }

    this._pcmBuffer = Buffer.alloc(0);
    this._opusQueue = [];
    this._injecting = false;
    this._transmitting = false;
    this._yielded = false;
  }

  _processPcmChunk(chunk) {
    this._pcmBuffer = Buffer.concat([this._pcmBuffer, chunk]);

    const frameSizeBytes = SCANNER_FRAME_SIZE * 2;
    while (this._pcmBuffer.length >= frameSizeBytes) {
      const frameData = this._pcmBuffer.subarray(0, frameSizeBytes);
      this._pcmBuffer = this._pcmBuffer.subarray(frameSizeBytes);
      this._processFrame(frameData);
    }
  }

  _processFrame(pcmFrame) {
    if (this._yielded) return;

    const rms = this._calculateRms(pcmFrame);
    const isSpeech = rms > VAD_THRESHOLD_RMS;

    if (isSpeech) {
      this._silenceStart = null;

      if (!this._transmitting) {
        if (rms > VAD_SPEECH_THRESHOLD_RMS) {
          this._beginTransmission();
        } else {
          return;
        }
      }

      if (this._transmitting) {
        this._encodeAndQueue(pcmFrame);
      }
    } else {
      if (this._transmitting) {
        if (!this._silenceStart) {
          this._silenceStart = Date.now();
        }

        this._encodeAndQueue(pcmFrame);

        if (Date.now() - this._silenceStart >= SILENCE_TIMEOUT_MS) {
          this._endTransmission();
        }
      }
    }
  }

  _calculateRms(pcmBuffer) {
    let aligned = pcmBuffer;
    if (aligned.byteOffset % 2 !== 0) {
      const copy = new Uint8Array(aligned.length);
      copy.set(new Uint8Array(aligned.buffer, aligned.byteOffset, aligned.length));
      aligned = Buffer.from(copy.buffer, copy.byteOffset, copy.byteLength);
    }
    const samples = new Int16Array(aligned.buffer, aligned.byteOffset, aligned.length / 2);
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      sum += samples[i] * samples[i];
    }
    return Math.sqrt(sum / samples.length);
  }

  _beginTransmission() {
    if (this._yielded) return;

    const channelKey = canonicalChannelKey(this._channelName);

    const floorHolder = floorControlService.getFloorHolder(channelKey);
    if (floorHolder && floorHolder.unitId !== SCANNER_IDENTITY) {
      this._yielded = true;
      return;
    }

    const floorResult = floorControlService.requestFloor(channelKey, SCANNER_IDENTITY, {
      isEmergency: false,
    });

    if (!floorResult.granted) {
      console.log(`[ScannerFeed] Floor busy, held by ${floorResult.heldBy}`);
      this._yielded = true;
      return;
    }

    this._transmitting = true;
    this._silenceStart = null;
    console.log(`[ScannerFeed] TX START on ${channelKey}`);

    if (signalingService.io) {
      const transmissionData = {
        unitId: SCANNER_IDENTITY,
        channelId: channelKey,
        timestamp: Date.now(),
        isEmergency: false,
      };
      signalingService.activeTransmissions.set(channelKey, transmissionData);
      signalingService.io.to(`channel:${channelKey}`).emit(SIGNALING_EVENTS.PTT_START, transmissionData);
      signalingService.io.to(`channel:${channelKey}`).emit(RADIO_EVENTS.TX_START, {
        senderUnitId: SCANNER_IDENTITY,
        channelId: channelKey,
        timestamp: Date.now(),
        isEmergency: false,
      });
      signalingService.io.to(`channel:${channelKey}`).emit(RADIO_EVENTS.CHANNEL_BUSY, {
        channelId: channelKey,
        heldBy: SCANNER_IDENTITY,
        timestamp: Date.now(),
      });
    }

    this._startFloorRearm(channelKey);
    this._startInjectionLoop();
  }

  _startFloorRearm(channelKey) {
    if (this._floorRearmTimer) {
      clearInterval(this._floorRearmTimer);
    }
    this._floorRearmTimer = setInterval(() => {
      if (!this._running || !this._transmitting) {
        clearInterval(this._floorRearmTimer);
        this._floorRearmTimer = null;
        return;
      }
      const result = floorControlService.requestFloor(channelKey, SCANNER_IDENTITY, {
        isEmergency: false,
      });
      if (!result.granted) {
        console.log(`[ScannerFeed] Floor rearm failed, lost floor to ${result.heldBy}`);
        this._endTransmission();
      }
    }, FLOOR_REARM_INTERVAL_MS);
  }

  _endTransmission() {
    if (!this._transmitting) return;

    const channelKey = canonicalChannelKey(this._channelName);
    this._transmitting = false;
    this._silenceStart = null;
    this._opusQueue = [];
    this._injecting = false;

    if (this._pacingTimer) {
      clearInterval(this._pacingTimer);
      this._pacingTimer = null;
    }

    if (this._floorRearmTimer) {
      clearInterval(this._floorRearmTimer);
      this._floorRearmTimer = null;
    }

    console.log(`[ScannerFeed] TX END on ${channelKey}`);

    floorControlService.releaseFloor(channelKey, SCANNER_IDENTITY);

    if (signalingService.io) {
      signalingService.activeTransmissions.delete(channelKey);
      signalingService.io.to(`channel:${channelKey}`).emit(SIGNALING_EVENTS.PTT_END, {
        unitId: SCANNER_IDENTITY,
        channelId: channelKey,
        timestamp: Date.now(),
      });
      signalingService.io.to(`channel:${channelKey}`).emit(RADIO_EVENTS.TX_STOP, {
        senderUnitId: SCANNER_IDENTITY,
        channelId: channelKey,
        timestamp: Date.now(),
      });
      signalingService.io.to(`channel:${channelKey}`).emit(RADIO_EVENTS.CHANNEL_IDLE, {
        channelId: channelKey,
        timestamp: Date.now(),
      });
    }
  }

  _encodeAndQueue(pcmFrame) {
    try {
      const encoded = this._encoder.encode(pcmFrame, SCANNER_FRAME_SIZE);
      this._opusQueue.push(Buffer.from(encoded));
    } catch (err) {
      console.warn('[ScannerFeed] Opus encode error:', err.message);
    }
  }

  _startInjectionLoop() {
    if (this._injecting) return;
    this._injecting = true;

    const channelKey = canonicalChannelKey(this._channelName);

    this._pacingTimer = setInterval(() => {
      if (!this._running || !this._transmitting) {
        clearInterval(this._pacingTimer);
        this._pacingTimer = null;
        this._injecting = false;
        return;
      }

      const floorHolder = floorControlService.getFloorHolder(channelKey);
      if (!floorHolder || floorHolder.unitId !== SCANNER_IDENTITY) {
        console.log(`[ScannerFeed] Lost floor during injection (holder=${floorHolder?.unitId || 'none'})`);
        this._endTransmission();
        return;
      }

      const frame = this._opusQueue.shift();
      if (frame) {
        this._sequence = (this._sequence + 1) & 0xFFFF;
        audioRelayService.injectAudio(channelKey, SCANNER_IDENTITY, this._sequence, frame);
      }
    }, FRAME_MS);
  }

  async stop() {
    if (!this._running && this._state !== 'reconnecting' && this._state !== 'errored') return;
    console.log('[ScannerFeed] Stopping scanner feed');
    this._running = false;
    this._endTransmission();
    this._cleanup();
  }

  _cleanup() {
    this._running = false;
    this._state = 'stopped';
    this._retryCount = 0;
    this._lastError = null;

    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    if (this._pacingTimer) {
      clearInterval(this._pacingTimer);
      this._pacingTimer = null;
    }

    if (this._floorRearmTimer) {
      clearInterval(this._floorRearmTimer);
      this._floorRearmTimer = null;
    }

    if (this._yieldResumeTimer) {
      clearTimeout(this._yieldResumeTimer);
      this._yieldResumeTimer = null;
    }

    this._unregisterPttCallbacks();

    this._killFfmpegProcess();

    if (this._encoder) {
      try { this._encoder.delete(); } catch (_) {}
      this._encoder = null;
    }

    this._pcmBuffer = Buffer.alloc(0);
    this._opusQueue = [];
    this._injecting = false;
    this._transmitting = false;
    this._startedAt = null;
    this._streamUrl = null;
    this._channelName = null;
    this._channelDisplayName = null;
    this._yielded = false;
  }
}

export const scannerFeedService = new ScannerFeedService();
