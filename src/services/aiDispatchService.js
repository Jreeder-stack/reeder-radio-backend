import { speechToText, textToSpeech, isConfigured as isAzureConfigured } from './azureSpeechService.js';
import { matchCommand, resetDispatcherState, matchEmergencyResponse, matchSecureConfirmation, getUnitSessionState, setUnitSessionState, DISPATCHER_STATE } from './commandMatcher.js';
import { isConfigured as isLlmConfigured, classifyIntent } from './llmIntentService.js';
import { parsePersonDetails, parseDOB, extractNameFromTranscript } from './phoneticParser.js';
import pool, { isAiDispatchEnabled, getAiDispatchChannel, createChannelMessage } from '../db/index.js';
import { audioRelayService } from './audioRelayService.js';
import { opusCodec, SAMPLE_RATE as OPUS_SAMPLE_RATE, FRAME_SIZE as OPUS_FRAME_SIZE } from './opusCodec.js';
import { floorControlService } from './floorControlService.js';
import * as cadService from './cadService.js';
import fs from 'fs';
import path from 'path';

const AUDIO_DIR = path.join(process.cwd(), 'uploads', 'audio');
if (!fs.existsSync(AUDIO_DIR)) {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
}

function normalizeAddress(raw) {
  if (!raw) return raw;
  let addr = raw.trim();
  addr = addr.replace(/^(at the|over at|down at|at)\s+/i, '');
  addr = addr.replace(/\s+in\s+(\w)/gi, ', $1');
  addr = addr.replace(/\b(\d+(?:st|nd|rd|th)?)\s+and\s+(\w)/gi, '$1 & $2');
  addr = addr.replace(/\b([A-Z][a-z]+)\s+and\s+([A-Z][a-z]+)/g, '$1 & $2');
  return addr;
}

function cleanTranscript(raw) {
  if (!raw) return raw;
  let text = raw.trim();
  text = text.replace(/^(um|uh|ah|like|so|okay|well|yeah)[,.]?\s+/gi, '');
  text = text.replace(/\s+(um|uh|ah)\s+/gi, ' ');
  text = text.replace(/\.$/, '');
  text = text.replace(/\b[Bb]oulevard\b/g, 'Blvd');
  text = text.replace(/\b[Aa]venue\b/g, 'Ave');
  text = text.replace(/(?<=\s)[Ss]treet\b/g, 'St');
  text = text.replace(/(?<=\s)[Dd]rive\b/g, 'Dr');
  text = text.replace(/(?<=\s)[Ll]ane\b/g, 'Ln');
  text = text.replace(/(?<=\s)[Rr]oad\b/g, 'Rd');
  text = text.replace(/(?<=\s)[Pp]lace\b/g, 'Pl');
  text = text.replace(/(?<=\s)[Cc]ourt\b/g, 'Ct');
  text = text.replace(/\b[Pp]arkway\b/g, 'Pkwy');
  text = text.replace(/\s{2,}/g, ' ');
  return text.trim();
}

function createWavHeader(dataLength, sampleRate, channels, bitsPerSample) {
  const buffer = Buffer.alloc(44);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  buffer.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataLength, 40);
  return buffer;
}

function pcmToWav(pcmBuffer, sampleRate = 48000, channels = 1, bitsPerSample = 16) {
  const wavHeader = createWavHeader(pcmBuffer.length, sampleRate, channels, bitsPerSample);
  return Buffer.concat([wavHeader, pcmBuffer]);
}

const AI_IDENTITY = 'AI-Dispatcher';
const RELAY_SAMPLE_RATE = 48000;
const AZURE_SAMPLE_RATE = 16000;
const CHANNELS = 1;
const SAMPLES_PER_FRAME = 960;
const FRAME_DURATION_MS = Math.floor((SAMPLES_PER_FRAME / RELAY_SAMPLE_RATE) * 1000);
const EMERGENCY_STATUS_CHECK_TIMEOUT_MS = 5000;
const MAX_RECORDING_DURATION_MS = 60000;
const MAX_AUDIO_FILE_SIZE = 10 * 1024 * 1024;
const IDLE_TIMEOUT_MS = 1500;

const EMERGENCY_ESCALATION_STATE = {
  IDLE: 'IDLE',
  FIRST_CHECK: 'FIRST_CHECK',
  SECOND_CHECK: 'SECOND_CHECK',
  NO_RESPONSE_BROADCAST: 'NO_RESPONSE_BROADCAST'
};

const MAX_AUDIO_QUEUE_DEPTH = 5;

class EmergencyEscalationController {
  constructor(dispatcher) {
    this.dispatcher = dispatcher;
    this.activeEscalations = new Map();
    this.audioQueue = Promise.resolve();
    this._audioQueueDepth = 0;
  }

  log(action, details = {}) {
    const timestamp = new Date().toISOString();
    console.log(`[Emergency-Escalation] ${timestamp} | ${action}`, JSON.stringify(details));
  }

  hasActiveEscalation(unitId) {
    return this.activeEscalations.has(unitId);
  }

  getEscalation(unitId) {
    return this.activeEscalations.get(unitId);
  }

  async startEscalation(unitId, channel) {
    if (this.activeEscalations.has(unitId)) {
      this.log('ESCALATION_ALREADY_ACTIVE', { unitId });
      return;
    }

    this.log('ESCALATION_STARTED', { unitId, channel });

    const escalation = {
      unitId,
      channel,
      state: EMERGENCY_ESCALATION_STATE.FIRST_CHECK,
      startTime: Date.now(),
      timer: null
    };

    this.activeEscalations.set(unitId, escalation);

    await this.performStatusCheck(unitId, 1);
  }

  async performStatusCheck(unitId, attempt) {
    const escalation = this.activeEscalations.get(unitId);
    if (!escalation) return;

    this.log('STATUS_CHECK_ATTEMPT', { unitId, attempt });

    const message = `${unitId}, status check.`;
    
    if (this._audioQueueDepth >= MAX_AUDIO_QUEUE_DEPTH) {
      this.log('AUDIO_QUEUE_FULL', { depth: this._audioQueueDepth, dropped: message });
    } else {
      this._audioQueueDepth++;
      this.audioQueue = this.audioQueue.then(async () => {
        await this.dispatcher.playToneAndSpeak('A', message);
      }).finally(() => { this._audioQueueDepth--; });
      await this.audioQueue;
    }

    escalation.timer = setTimeout(async () => {
      await this.handleTimeout(unitId, attempt);
    }, EMERGENCY_STATUS_CHECK_TIMEOUT_MS);
  }

  async handleTimeout(unitId, attempt) {
    const escalation = this.activeEscalations.get(unitId);
    if (!escalation) return;

    this.log('STATUS_CHECK_TIMEOUT', { unitId, attempt });

    if (attempt === 1) {
      escalation.state = EMERGENCY_ESCALATION_STATE.SECOND_CHECK;
      await this.performStatusCheck(unitId, 2);
    } else {
      escalation.state = EMERGENCY_ESCALATION_STATE.NO_RESPONSE_BROADCAST;
      await this.broadcastNoResponse(unitId);
    }
  }

  async broadcastNoResponse(unitId) {
    this.log('NO_RESPONSE_BROADCAST', { unitId });

    const message = `Attention all receiving units, ${unitId} pressed their emergency key with no response.`;
    
    if (this._audioQueueDepth >= MAX_AUDIO_QUEUE_DEPTH) {
      this.log('AUDIO_QUEUE_FULL', { depth: this._audioQueueDepth, dropped: message });
    } else {
      this._audioQueueDepth++;
      this.audioQueue = this.audioQueue.then(async () => {
        await this.dispatcher.playToneAndSpeak('CONTINUOUS', message);
      }).finally(() => { this._audioQueueDepth--; });
      await this.audioQueue;
    }
    
    await this.sendCadBroadcast(unitId, `EMERGENCY: ${unitId} pressed emergency key with NO RESPONSE`, 'emergency');

    await this.sendEmergencyAck(unitId, 'escalation_complete');
    
    this.clearEscalation(unitId);
  }
  
  async sendEmergencyAck(targetUnit, reason) {
    const escalation = this.activeEscalations.get(targetUnit);
    if (!escalation) return;
    
    if (!this.dispatcher.connected) {
      this.log('EMERGENCY_ACK_SKIPPED', { targetUnit, reason: 'Not connected' });
      return;
    }
    
    try {
      await this.dispatcher.sendDataMessage({
        type: 'emergency_ack',
        targetUnit,
        channel: escalation.channel,
        timestamp: Date.now(),
        reason
      });
      this.log('EMERGENCY_ACK_SENT', { targetUnit, reason });
    } catch (error) {
      this.log('EMERGENCY_ACK_ERROR', { error: error.message });
    }
  }

  async sendCadBroadcast(unitId, message, priority) {
    const cadService = await import('./cadService.js');
    if (cadService.isConfigured()) {
      try {
        const result = await cadService.sendBroadcast(message, priority);
        this.log('CAD_BROADCAST_SENT', { unitId, message, priority, success: result.success });
      } catch (error) {
        this.log('CAD_BROADCAST_ERROR', { error: error.message });
      }
    }
  }

  async handleUnitResponse(unitId, responseType, details = {}) {
    const escalation = this.activeEscalations.get(unitId);
    if (!escalation) return null;

    if (escalation.timer) {
      clearTimeout(escalation.timer);
      escalation.timer = null;
    }

    this.log('UNIT_RESPONDED', { unitId, responseType, details });

    if (responseType === 'OK') {
      await this.sendEmergencyAck(unitId, 'acknowledged');
      
      this.clearEscalation(unitId);
      return {
        response: `${unitId}, copy. Clear emergency.`,
        clearEmergency: true
      };
    } else if (responseType === 'DISTRESS') {
      this.clearEscalation(unitId);
      const distressType = details.distressType || 'requesting backup';
      const message = `Attention all units, ${unitId} is ${distressType}.`;
      
      if (this._audioQueueDepth >= MAX_AUDIO_QUEUE_DEPTH) {
        this.log('AUDIO_QUEUE_FULL', { depth: this._audioQueueDepth, dropped: message });
      } else {
        this._audioQueueDepth++;
        this.audioQueue = this.audioQueue.then(async () => {
          await this.dispatcher.playToneAndSpeak('CONTINUOUS', message);
        }).finally(() => { this._audioQueueDepth--; });
        await this.audioQueue;
      }
      
      await this.sendCadBroadcast(unitId, `EMERGENCY: ${unitId} ${distressType}`, 'emergency');
      
      return {
        response: null,
        clearEmergency: false
      };
    }

    return null;
  }

  clearEscalation(unitId) {
    const escalation = this.activeEscalations.get(unitId);
    if (escalation) {
      if (escalation.timer) {
        clearTimeout(escalation.timer);
      }
      this.activeEscalations.delete(unitId);
      this.log('ESCALATION_CLEARED', { unitId });
    }
  }

  clearAllEscalations() {
    for (const [unitId, escalation] of this.activeEscalations) {
      if (escalation.timer) {
        clearTimeout(escalation.timer);
      }
    }
    this.activeEscalations.clear();
    this.log('ALL_ESCALATIONS_CLEARED');
  }
}

function resampleAudio(inputBuffer, fromRate, toRate) {
  const inputSamples = new Int16Array(inputBuffer.buffer, inputBuffer.byteOffset, inputBuffer.length / 2);
  const ratio = fromRate / toRate;
  const outputLength = Math.floor(inputSamples.length / ratio);
  const outputSamples = new Int16Array(outputLength);
  
  for (let i = 0; i < outputLength; i++) {
    const srcIndex = Math.floor(i * ratio);
    const nextIndex = Math.min(srcIndex + 1, inputSamples.length - 1);
    const frac = (i * ratio) - srcIndex;
    outputSamples[i] = Math.round(inputSamples[srcIndex] * (1 - frac) + inputSamples[nextIndex] * frac);
  }
  
  return Buffer.from(outputSamples.buffer);
}

class AIDispatcher {
  constructor() {
    this.connected = false;
    this.channelName = null;
    this.isRunning = false;
    this.configuredChannel = null;
    this.channelAliases = new Set();
    this.numericChannelId = null;
    this.displayChannel = null;
    this.emergencyEscalation = new EmergencyEscalationController(this);
    this.errorCounts = new Map();
    this.errorCooldowns = new Map();
    this._errorLastSeen = new Map();
    this.stoppedByUser = false;
    this._activeRecordings = new Map();
    this._errorCleanupInterval = null;
    this._signalingService = null;
    this._audioListenerBound = null;
    this._publishSequence = 0;
  }

  log(action, details = {}) {
    const timestamp = new Date().toISOString();
    console.log(`[AI-Dispatcher] ${timestamp} | ${action}`, JSON.stringify(details));
  }

  get humanParticipantCount() {
    if (!this._signalingService) return 0;
    try {
      const seen = new Set();
      let count = 0;
      const keysToCheck = this.channelName ? [this.channelName, ...this.channelAliases] : [...this.channelAliases];
      for (const key of keysToCheck) {
        const members = this._signalingService.getChannelMembers(key);
        if (members && (members.size || members.length)) {
          const arr = members instanceof Set ? Array.from(members) : members;
          for (const m of arr) {
            const uid = typeof m === 'string' ? m : m.unitId;
            if (uid && !seen.has(uid) && this.isHumanParticipant(uid)) {
              seen.add(uid);
              count++;
            }
          }
        }
      }
      return count;
    } catch {
      return 0;
    }
  }

  async _ensureSignalingService() {
    if (!this._signalingService) {
      const mod = await import('./signalingService.js');
      this._signalingService = mod.signalingService;
    }
    return this._signalingService;
  }

  matchesChannel(channelId) {
    if (!channelId) return false;
    const id = String(channelId);
    if (this.channelAliases.has(id)) return true;
    if (this.configuredChannel && id === this.configuredChannel) return true;
    if (this.displayChannel && id === this.displayChannel) return true;
    if (this.numericChannelId != null && id === String(this.numericChannelId)) return true;
    return false;
  }

  async _resolveChannelAliases(channelName, roomKey) {
    this.channelAliases.clear();
    this.numericChannelId = null;
    if (channelName) this.channelAliases.add(channelName);
    if (roomKey) this.channelAliases.add(roomKey);

    try {
      const result = await pool.query(
        `SELECT id, name, COALESCE(zone, 'Default') || '__' || name AS room_key
         FROM channels
         WHERE name = $1
            OR COALESCE(zone, 'Default') || '__' || name = $2
         LIMIT 1`,
        [channelName, roomKey || channelName]
      );
      if (result.rows[0]) {
        const row = result.rows[0];
        this.numericChannelId = row.id;
        this.channelAliases.add(String(row.id));
        this.channelAliases.add(row.name);
        this.channelAliases.add(row.room_key);
      }
    } catch (err) {
      this.log('CHANNEL_ALIAS_RESOLVE_ERROR', { error: err.message, channelName, roomKey });
    }

    this.log('CHANNEL_ALIASES_RESOLVED', { aliases: Array.from(this.channelAliases), numericId: this.numericChannelId });
  }

  async start(channelName, options = {}) {
    const { roomKey = null } = options;
    
    if (!channelName) {
      this.log('START_SKIPPED', { reason: 'No channel configured' });
      return;
    }

    if (!isAzureConfigured()) {
      this.log('START_SKIPPED', { reason: 'Azure Speech not configured' });
      return;
    }

    this.log('CONFIG_STATUS', {
      azureSpeech: isAzureConfigured(),
      llm: isLlmConfigured(),
    });

    const enabled = await isAiDispatchEnabled();
    if (!enabled) {
      this.log('START_SKIPPED', { reason: 'AI Dispatch disabled in settings' });
      return;
    }

    if (this.connected) {
      this.log('CHANNEL_SWITCH', { from: this.channelName, to: channelName });
      await this.leaveChannel();
    }

    this.configuredChannel = roomKey || channelName;
    this.displayChannel = channelName;
    this.isRunning = true;
    this.stoppedByUser = false;
    this.errorCounts.clear();
    this.errorCooldowns.clear();
    this._errorLastSeen.clear();
    this._startErrorCleanup();
    
    await this._resolveChannelAliases(channelName, roomKey);
    await this._ensureSignalingService();
    
    if (cadService.isConfigured()) {
      cadService.getCallNatures().catch(err => {
        this.log('CALL_NATURES_PRELOAD_ERROR', { error: err.message });
      });
    }

    await this.joinChannel(this.configuredChannel);
    this.log('STARTED_CONNECTED', { channel: channelName, roomKey: this.configuredChannel, numericId: this.numericChannelId, aliases: Array.from(this.channelAliases), mode: 'always-on' });
  }

  _removeAllAudioListeners() {
    audioRelayService.removeAllAudioListeners(AI_IDENTITY);
  }

  async leaveChannel() {
    if (this.connected) {
      try {
        this._removeAllAudioListeners();
        this.log('CHANNEL_LEFT', { channel: this.channelName });
      } catch (error) {
        this.log('CHANNEL_LEAVE_ERROR', { channel: this.channelName, error: error.message });
      }
      this.connected = false;
      this.channelName = null;
      this._clearAllRecordings();
    }
  }

  async stop() {
    this.log('STOPPING', { channel: this.channelName });
    this.isRunning = false;
    this.stoppedByUser = true;
    this._stopErrorCleanup();
    this.errorCounts.clear();
    this.errorCooldowns.clear();
    this._errorLastSeen.clear();
    this.emergencyEscalation.clearAllEscalations();
    resetDispatcherState();

    if (this.connected) {
      try {
        this._removeAllAudioListeners();
        this.log('CHANNEL_LEFT', { channel: this.channelName });
      } catch (error) {
        this.log('CHANNEL_LEAVE_ERROR', { channel: this.channelName, error: error.message });
      }
      this.connected = false;
      this.channelName = null;
    }

    this._clearAllRecordings();
  }

  _startErrorCleanup() {
    this._stopErrorCleanup();
    const ERROR_STALENESS_MS = 5 * 60 * 1000;
    this._errorCleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [key, until] of this.errorCooldowns) {
        if (now >= until) {
          this.errorCooldowns.delete(key);
          this.errorCounts.delete(key);
          this._errorLastSeen.delete(key);
        }
      }
      for (const [key, lastSeen] of this._errorLastSeen) {
        if (now - lastSeen > ERROR_STALENESS_MS && !this.errorCooldowns.has(key)) {
          this.errorCounts.delete(key);
          this._errorLastSeen.delete(key);
        }
      }
    }, 5 * 60 * 1000);
    if (this._errorCleanupInterval.unref) {
      this._errorCleanupInterval.unref();
    }
  }

  _stopErrorCleanup() {
    if (this._errorCleanupInterval) {
      clearInterval(this._errorCleanupInterval);
      this._errorCleanupInterval = null;
    }
  }

  async leaveRoom() {
    await this.leaveChannel();
  }

  async rejoinIfNeeded() {
    if (this.connected || !this.isRunning || this.stoppedByUser || !this.configuredChannel) {
      return;
    }

    const enabled = await isAiDispatchEnabled();
    if (!enabled) {
      return;
    }

    this.log('REJOIN_TRIGGERED', { channel: this.configuredChannel });
    await this.joinChannel(this.configuredChannel);
  }

  isHumanParticipant(identity) {
    if (!identity) return false;
    if (identity === AI_IDENTITY) return false;
    if (identity.startsWith('AI-')) return false;
    if (identity.startsWith('SIP-')) return false;
    if (identity.startsWith('sip_')) return false;
    if (identity.startsWith('Bot-')) return false;
    if (identity.startsWith('bot_')) return false;
    if (identity.startsWith('PIPELINE_')) return false;
    if (identity.startsWith('pipeline-')) return false;
    return true;
  }

  async joinChannel(channelName) {
    if (this.connected && this.channelName === channelName) {
      this.log('JOIN_SKIPPED', { reason: 'Already connected to this channel', channel: channelName });
      return;
    }

    if (this.connected) {
      await this.leaveChannel();
    }

    this._audioListenerBound = this._onAudioFrame.bind(this);

    const listenKeys = new Set();
    listenKeys.add(channelName);
    for (const alias of this.channelAliases) {
      listenKeys.add(alias);
    }
    if (this.numericChannelId != null) {
      listenKeys.add(String(this.numericChannelId));
    }

    for (const key of listenKeys) {
      audioRelayService.addAudioListener(key, AI_IDENTITY, this._audioListenerBound);
    }

    if (this.numericChannelId != null) {
      audioRelayService.registerChannelNumeric(channelName, this.numericChannelId);
    }

    this.connected = true;
    this.channelName = channelName;
    
    this.log('CHANNEL_JOINED', { channel: channelName, audioListenerKeys: Array.from(listenKeys), registeredNumericId: this.numericChannelId });
    this.log('OPUS_TRANSPORT_VERIFIED', { mode: 'server-side decode', note: 'AI dispatcher receives Opus from relay listeners and decodes server-side for STT' });
  }

  _onAudioFrame(audioEvent) {
    const { channelId, unitId, opusPayload, sequence } = audioEvent;
    if (unitId === AI_IDENTITY) return;
    if (!this.isHumanParticipant(unitId)) {
      if (sequence === 0) {
        this.log('AUDIO_FRAME_NON_HUMAN', { unitId, channelId });
      }
      return;
    }
    if (sequence === 0 || (!this._activeRecordings.has(unitId) && sequence % 50 === 0)) {
      this.log('AUDIO_FRAME_RECEIVED', { unitId, channelId, sequence, payloadBytes: opusPayload?.length });
    }

    let pcmFrame;
    try {
      pcmFrame = opusCodec.decodeOpusToPcm(opusPayload, unitId);
    } catch (err) {
      this.log('OPUS_DECODE_ERROR', { unitId, error: err.message });
      return;
    }

    let recording = this._activeRecordings.get(unitId);
    if (!recording) {
      recording = {
        chunks: [],
        frameCount: 0,
        lastFrameTime: Date.now(),
        startTime: Date.now(),
        idleTimer: null,
        maxTimer: null,
      };
      this._activeRecordings.set(unitId, recording);
      this.log('AUDIO_BUFFERING_START', { participant: unitId, channel: channelId });

      recording.maxTimer = setTimeout(() => {
        this.log('AUDIO_MAX_DURATION', { participant: unitId, maxMs: MAX_RECORDING_DURATION_MS, frameCount: recording.frameCount });
        this._finishRecording(unitId);
      }, MAX_RECORDING_DURATION_MS);
    }

    recording.chunks.push(pcmFrame);
    recording.frameCount++;
    recording.lastFrameTime = Date.now();

    if (recording.idleTimer) clearTimeout(recording.idleTimer);
    recording.idleTimer = setTimeout(() => {
      this.log('AUDIO_IDLE_TIMEOUT', { participant: unitId, frameCount: recording.frameCount });
      this._finishRecording(unitId);
    }, IDLE_TIMEOUT_MS);
  }

  _finishRecording(unitId) {
    const recording = this._activeRecordings.get(unitId);
    if (!recording) return;

    this._activeRecordings.delete(unitId);

    if (recording.idleTimer) clearTimeout(recording.idleTimer);
    if (recording.maxTimer) clearTimeout(recording.maxTimer);

    if (recording.chunks.length === 0) {
      this.log('AUDIO_EMPTY', { participant: unitId });
      return;
    }

    const audioBuffer = Buffer.concat(recording.chunks);
    this.log('AUDIO_BUFFERING_COMPLETE', {
      participant: unitId,
      frames: recording.frameCount,
      bytes: audioBuffer.length
    });

    const MIN_AUDIO_BYTES = RELAY_SAMPLE_RATE * 2 * 0.5;
    if (audioBuffer.length < MIN_AUDIO_BYTES) {
      this.log('AUDIO_TOO_SHORT', { bytes: audioBuffer.length, minBytes: MIN_AUDIO_BYTES });
      return;
    }

    if (!this.isRunning) {
      this.log('AUDIO_DISCARDED', { reason: 'Dispatcher stopped during buffering' });
      return;
    }

    const channelName = this.channelName;
    this.saveAudioAsMessage(audioBuffer, channelName, unitId);

    isAiDispatchEnabled().then(enabled => {
      if (enabled && this.isRunning) {
        this.processAudio(audioBuffer, unitId).catch(err => {
          this.log('PROCESS_AUDIO_UNHANDLED_ERROR', { error: err.message, participant: unitId });
        });
      }
    });
  }

  _clearAllRecordings() {
    for (const [unitId, recording] of this._activeRecordings) {
      if (recording.idleTimer) clearTimeout(recording.idleTimer);
      if (recording.maxTimer) clearTimeout(recording.maxTimer);
    }
    this._activeRecordings.clear();
  }

  async saveAudioAsMessage(audioBuffer, channelName, sender) {
    try {
      const wavBuffer = pcmToWav(audioBuffer, RELAY_SAMPLE_RATE, CHANNELS, 16);

      if (wavBuffer.length > MAX_AUDIO_FILE_SIZE) {
        this.log('VOICE_MESSAGE_TOO_LARGE', { 
          channel: channelName, sender, 
          size: wavBuffer.length, 
          maxSize: MAX_AUDIO_FILE_SIZE 
        });
        return;
      }

      if (wavBuffer.length < 44 ||
          wavBuffer.toString('ascii', 0, 4) !== 'RIFF' ||
          wavBuffer.toString('ascii', 8, 12) !== 'WAVE') {
        this.log('VOICE_MESSAGE_CORRUPT_WAV', { channel: channelName, sender, size: wavBuffer.length });
        return;
      }

      const headerDataLen = wavBuffer.readUInt32LE(40);
      const actualDataLen = wavBuffer.length - 44;
      if (Math.abs(headerDataLen - actualDataLen) > 1024) {
        this.log('VOICE_MESSAGE_WAV_MISMATCH', { 
          channel: channelName, sender, 
          headerDataLen, actualDataLen 
        });
        return;
      }

      const durationSecs = Math.round(audioBuffer.length / (RELAY_SAMPLE_RATE * 2));
      if (durationSecs <= 0) {
        this.log('VOICE_MESSAGE_INVALID_DURATION', { channel: channelName, sender, durationSecs });
        return;
      }

      const filename = `${channelName}_${Date.now()}_${sender.replace(/[^a-zA-Z0-9]/g, '_')}.wav`;
      const filepath = path.join(AUDIO_DIR, filename);
      
      fs.writeFileSync(filepath, wavBuffer);
      
      const audioUrl = `/api/messages/audio/${filename}`;
      
      const message = await createChannelMessage(channelName, sender, 'audio', null, audioUrl, durationSecs);
      this.log('VOICE_MESSAGE_SAVED', { channel: channelName, sender, filename, duration: durationSecs });
      
      const broadcastPayload = {
        type: 'new_message',
        message: {
          id: message.id,
          channel: channelName,
          sender,
          message_type: 'audio',
          audio_url: audioUrl,
          audio_duration: durationSecs,
          created_at: message.created_at
        }
      };

      await this.sendDataMessage(broadcastPayload);
    } catch (error) {
      this.log('VOICE_MESSAGE_SAVE_ERROR', { error: error.message, channel: channelName, sender });
    }
  }

  async shouldRespond() {
    if (!this.isRunning) return false;
    try {
      return await isAiDispatchEnabled();
    } catch (error) {
      this.log('TOGGLE_CHECK_ERROR', { error: error.message });
      return false;
    }
  }

  async processAudio(audioBuffer, participantId) {
    try {
      if (!await this.shouldRespond()) {
        this.log('PROCESS_SKIPPED', { reason: 'Disabled' });
        return;
      }

      const consecutiveErrors = this.errorCounts.get(participantId) || 0;
      if (consecutiveErrors >= 5) {
        const cooldownUntil = this.errorCooldowns.get(participantId) || 0;
        const now = Date.now();
        if (now < cooldownUntil) {
          this.log('PROCESS_SKIPPED', { reason: 'Error cooldown active', participant: participantId, consecutiveErrors, cooldownRemainingMs: cooldownUntil - now });
          return;
        }
        this.log('PROCESS_RETRY', { reason: 'Cooldown expired, retrying', participant: participantId, consecutiveErrors });
      }

      this.log('AUDIO_PROCESSING', { bytes: audioBuffer.length, channel: this.channelName, participant: participantId });

      const resampledAudio = resampleAudio(audioBuffer, RELAY_SAMPLE_RATE, AZURE_SAMPLE_RATE);

      const transcript = await speechToText(resampledAudio);
      if (!transcript) {
        this.log('STT_NO_SPEECH');
        return;
      }

      this.log('STT_RESULT', { transcript, participant: participantId });

      if (this.errorCounts.has(participantId)) {
        this.errorCounts.delete(participantId);
      }

      if (this.emergencyEscalation.hasActiveEscalation(participantId)) {
        const emergencyResponse = matchEmergencyResponse(transcript);
        if (emergencyResponse) {
          this.log('EMERGENCY_RESPONSE_DETECTED', { 
            participant: participantId, 
            responseType: emergencyResponse.type,
            distressType: emergencyResponse.distressType 
          });
          
          const result = await this.emergencyEscalation.handleUnitResponse(
            participantId, 
            emergencyResponse.type, 
            { distressType: emergencyResponse.distressType }
          );
          
          if (result && result.response) {
            await this.speak(result.response, participantId);
          }
          
          if (result && result.cadAction === 'broadcast' && result.cadData && cadService.isConfigured()) {
            try {
              await cadService.sendBroadcast(result.cadData.message, result.cadData.priority);
            } catch (cadError) {
              this.log('CAD_BROADCAST_ERROR', { error: cadError.message });
            }
          }
          
          return;
        }
      }

      if (isLlmConfigured()) {
        await this.processTranscriptWithLLM(transcript, participantId);
      } else {
        await this.processTranscriptWithRegex(transcript, participantId);
      }

    } catch (error) {
      const count = (this.errorCounts.get(participantId) || 0) + 1;
      this.errorCounts.set(participantId, count);
      this._errorLastSeen.set(participantId, Date.now());
      this.log('PROCESS_ERROR', { error: error.message, participant: participantId, consecutiveErrors: count });
      if (count >= 5) {
        const cooldownMs = Math.min(30000, 10000 * Math.floor(count / 5));
        this.errorCooldowns.set(participantId, Date.now() + cooldownMs);
        this.log('PROCESS_ERROR_COOLDOWN', { participant: participantId, cooldownMs, consecutiveErrors: count });
      }
    }
  }

  async processTranscriptWithLLM(transcript, participantId) {
    try {
      const sessionState = getUnitSessionState(participantId);
      const { state, slots } = sessionState;

      const normalized = transcript.toLowerCase();
      const emergencyPhrases = [
        'officer needs assistance', 'officer down', 'shots fired',
        'code 3 backup', 'emergency backup', '10-33', '10/33', 'ten thirty three',
        'foot pursuit', 'in foot pursuit', 'pursuing on foot',
        'need ems', 'request ems', 'send ems', 'need an ambulance',
        'need fire', 'request fire', 'send fire'
      ];
      const isEmergencyCommand = emergencyPhrases.some(p => normalized.includes(p));

      if (isEmergencyCommand) {
        this.log('EMERGENCY_FAST_PATH', { participant: participantId, transcript });
        await this.processTranscriptWithRegex(transcript, participantId);
        return;
      }

      if (state === DISPATCHER_STATE.AWAITING_SECURE_CONFIRM) {
        this.log('SECURE_CONFIRM_FAST_PATH', { participant: participantId });
        await this.handleSecureConfirmResponse(participantId, transcript, slots);
        return;
      }

      if ([DISPATCHER_STATE.AWAITING_PLATE, DISPATCHER_STATE.AWAITING_NAME,
           DISPATCHER_STATE.AWAITING_LOCATION, DISPATCHER_STATE.AWAITING_DESCRIPTION].includes(state)) {
        this.log('REGEX_ONLY_STATE_FALLBACK', { participant: participantId, state });
        await this.processTranscriptWithRegex(transcript, participantId);
        return;
      }

      if (state === DISPATCHER_STATE.AWAITING_CALL_NATURE) {
        this.log('CALL_NATURE_FAST_PATH', { participant: participantId, transcript });
        await this.handleCallNatureInput(participantId, transcript, slots);
        return;
      }

      if (state === DISPATCHER_STATE.AWAITING_CALL_ADDRESS) {
        this.log('CALL_ADDRESS_FAST_PATH', { participant: participantId, transcript });
        await this.handleCallAddressInput(participantId, transcript, slots);
        return;
      }

      this.log('LLM_CLASSIFY_START', { participant: participantId, state, transcript });

      const conversationHistory = slots?.conversationHistory || [];
      const result = await classifyIntent(transcript, participantId, state, slots, conversationHistory);

      this.log('LLM_CLASSIFY_RESULT', { participant: participantId, intent: result.intent, response: result.response });

      switch (result.intent) {
        case 'SILENCE': {
          if (state === DISPATCHER_STATE.AWAITING_COMMAND) {
            this.log('LLM_SILENCE_AFTER_GOAHEAD', {
              participant: participantId,
              transcript,
              state,
              conversationHistory,
            });
          }
          this.log('LLM_SILENCE', { participant: participantId, transcript, state });
          break;
        }

        case 'DISREGARD': {
          this.log('LLM_DISREGARD', { participant: participantId, state });
          setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
          const resp = result.response || `${participantId}, 10-4, disregard.`;
          await this.speak(resp, participantId);
          this.addConversationExchange(participantId, transcript, resp);
          break;
        }

        case 'STATUS_CHANGE': {
          if (result.cadStatus && cadService.isConfigured()) {
            try {
              const cadResult = await cadService.updateUnitStatus(participantId, result.cadStatus);
              this.log('CAD_STATUS_UPDATE', { unitId: participantId, status: result.cadStatus, success: cadResult.success });
            } catch (cadError) {
              this.log('CAD_ERROR', { error: cadError.message });
            }
          }
          setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
          const statusResp = result.response || `${participantId}, 10-4.`;
          await this.speak(statusResp, participantId);
          this.addConversationExchange(participantId, transcript, statusResp);
          break;
        }

        case 'ZONE_CHANGE': {
          const zone = normalizeAddress(result.slots?.zone);
          if (zone) {
            await this.handleZoneConfirmPrompt(participantId, zone);
          } else {
            setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_ZONE, null, {}, true);
            const resp = result.response || `${participantId}, go ahead with zone.`;
            await this.speak(resp, participantId);
            this.addConversationExchange(participantId, transcript, resp);
          }
          break;
        }

        case 'ZONE_PROMPT': {
          setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_ZONE, null, {}, true);
          const resp = result.response || `${participantId}, go ahead with zone.`;
          await this.speak(resp, participantId);
          this.addConversationExchange(participantId, transcript, resp);
          break;
        }

        case 'DETAIL': {
          const location = normalizeAddress(result.slots?.location);
          if (location) {
            await this.handleDetailConfirmPrompt(participantId, location);
          } else {
            setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_DETAIL_LOCATION, null, {}, true);
            const resp = result.response || `${participantId}, go ahead with location.`;
            await this.speak(resp, participantId);
            this.addConversationExchange(participantId, transcript, resp);
          }
          break;
        }

        case 'DETAIL_PROMPT': {
          setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_DETAIL_LOCATION, null, {}, true);
          const resp = result.response || `${participantId}, go ahead with location.`;
          await this.speak(resp, participantId);
          this.addConversationExchange(participantId, transcript, resp);
          break;
        }

        case 'CONFIRM': {
          if (state === DISPATCHER_STATE.AWAITING_ZONE_CONFIRM) {
            await this.handleZoneConfirm(participantId, transcript, slots);
          } else if (state === DISPATCHER_STATE.AWAITING_DETAIL_CONFIRM) {
            await this.handleDetailConfirm(participantId, transcript, slots);
          } else if (state === DISPATCHER_STATE.AWAITING_PERSON_CONFIRM) {
            await this.handlePersonCheckConfirm(participantId, transcript, slots);
          } else if (state === DISPATCHER_STATE.AWAITING_SECURE_CONFIRM) {
            await this.handleSecureConfirmResponse(participantId, transcript, slots);
          } else if (state === DISPATCHER_STATE.AWAITING_CALL_CONFIRM) {
            await this.handleCallConfirm(participantId, transcript, slots);
          } else {
            const resp = result.response || `${participantId}, 10-4.`;
            await this.speak(resp, participantId);
            this.addConversationExchange(participantId, transcript, resp);
          }
          break;
        }

        case 'DENY': {
          if (state === DISPATCHER_STATE.AWAITING_ZONE_CONFIRM) {
            await this.handleZoneConfirm(participantId, transcript, slots);
          } else if (state === DISPATCHER_STATE.AWAITING_DETAIL_CONFIRM) {
            await this.handleDetailConfirm(participantId, transcript, slots);
          } else if (state === DISPATCHER_STATE.AWAITING_PERSON_CONFIRM) {
            await this.handlePersonCheckConfirm(participantId, transcript, slots);
          } else if (state === DISPATCHER_STATE.AWAITING_SECURE_CONFIRM) {
            await this.handleSecureConfirmResponse(participantId, transcript, slots);
          } else if (state === DISPATCHER_STATE.AWAITING_CALL_CONFIRM) {
            await this.handleCallDeny(participantId);
          } else {
            const resp = result.response || `${participantId}, 10-4. Disregard.`;
            await this.speak(resp, participantId);
            this.addConversationExchange(participantId, transcript, resp);
          }
          break;
        }

        case 'PERSON_CHECK_START': {
          setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_PERSON_DETAILS, null, {}, true);
          const resp = result.response || `${participantId}, 10-27, go ahead.`;
          await this.speak(resp, participantId);
          this.addConversationExchange(participantId, transcript, resp);
          break;
        }

        case 'PERSON_DETAILS': {
          if (state === DISPATCHER_STATE.AWAITING_PERSON_DOB) {
            await this.handlePersonCheckDOB(participantId, transcript, slots, result.slots);
          } else if (state === DISPATCHER_STATE.AWAITING_PERSON_FIRSTNAME) {
            await this.handlePersonFirstName(participantId, transcript, slots);
          } else {
            await this.handlePersonCheckDetails(participantId, transcript, result.slots);
          }
          break;
        }

        case 'RADIO_CHECK':
        case 'TIME_CHECK':
        case 'UNKNOWN': {
          const genResp = result.response || `${participantId}, Central, say again?`;
          await this.speak(genResp, participantId);
          this.addConversationExchange(participantId, transcript, genResp);
          break;
        }

        case 'WAKE_ONLY': {
          const wakeResp = result.response || `${participantId}, go ahead.`;
          await this.speak(wakeResp, participantId);
          this.addConversationExchange(participantId, transcript, wakeResp);
          setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_COMMAND);
          this.log('WAKE_ONLY_AWAITING', { participant: participantId, newState: DISPATCHER_STATE.AWAITING_COMMAND });
          break;
        }

        case 'REQUEST_BACKUP': {
          if (result.cadAction === 'broadcast' && result.cadData && cadService.isConfigured()) {
            try {
              await cadService.sendBroadcast(result.cadData.message, result.cadData.priority);
              this.log('CAD_BROADCAST', { message: result.cadData.message, priority: result.cadData.priority });
            } catch (cadError) {
              this.log('CAD_BROADCAST_ERROR', { error: cadError.message });
            }
          }
          const backupResp = result.response || `${participantId}, 10-4. Dispatching backup.`;
          await this.speak(backupResp, participantId);
          this.addConversationExchange(participantId, transcript, backupResp);
          break;
        }

        case 'TRAFFIC_STOP': {
          if (result.cadStatus && cadService.isConfigured()) {
            try {
              await cadService.updateUnitStatus(participantId, result.cadStatus);
              this.log('CAD_STATUS_UPDATE', { unitId: participantId, status: result.cadStatus });
            } catch (cadError) {
              this.log('CAD_ERROR', { error: cadError.message });
            }
          }
          setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
          const stopResp = result.response || `${participantId}, 10-4.`;
          await this.speak(stopResp, participantId);
          this.addConversationExchange(participantId, transcript, stopResp);
          break;
        }

        case 'RUN_PLATE': {
          if (result.slots?.plate) {
            setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
            const resp = result.response || `${participantId}, standby on plate.`;
            await this.speak(resp, participantId);
            this.addConversationExchange(participantId, transcript, resp);
          } else {
            setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_PLATE, null, {}, true);
            const resp = result.response || `${participantId}, go ahead with plate.`;
            await this.speak(resp, participantId);
            this.addConversationExchange(participantId, transcript, resp);
          }
          break;
        }

        case 'CREATE_CALL': {
          const nature = result.slots?.nature;
          const address = normalizeAddress(result.slots?.address);
          const additionalUnits = result.slots?.additionalUnits || [];
          const priority = result.slots?.priority || 'medium';

          if (nature && address) {
            const matchedNature = await cadService.findBestNature(nature);
            this.log('CREATE_CALL_MATCHED', { spoken: nature, matched: matchedNature, address, additionalUnits });
            setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_CALL_CONFIRM, null, {
              nature: matchedNature,
              address,
              additionalUnits,
              priority
            }, true);
            const confirmResp = `${participantId}, confirm, ${matchedNature.toLowerCase()} at ${address}?`;
            await this.speak(confirmResp, participantId);
            this.addConversationExchange(participantId, transcript, confirmResp);
          } else if (nature && !address) {
            const matchedNature = await cadService.findBestNature(nature);
            setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_CALL_ADDRESS, null, {
              nature: matchedNature,
              additionalUnits,
              priority
            }, true);
            const resp = result.response || `${participantId}, go ahead with address.`;
            await this.speak(resp, participantId);
            this.addConversationExchange(participantId, transcript, resp);
          } else {
            setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_CALL_NATURE, null, {
              address: address || null,
              additionalUnits,
              priority
            }, true);
            const resp = result.response || `${participantId}, go ahead with call nature.`;
            await this.speak(resp, participantId);
            this.addConversationExchange(participantId, transcript, resp);
          }
          break;
        }

        case 'CREATE_CALL_PROMPT': {
          const promptNature = result.slots?.nature;
          const promptAddress = normalizeAddress(result.slots?.address);
          const promptUnits = result.slots?.additionalUnits || [];
          const promptPriority = result.slots?.priority || 'medium';

          if (promptNature && !promptAddress) {
            const matchedNature = await cadService.findBestNature(promptNature);
            setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_CALL_ADDRESS, null, {
              nature: matchedNature,
              additionalUnits: promptUnits,
              priority: promptPriority
            }, true);
            const resp = result.response || `${participantId}, go ahead with address for ${matchedNature.toLowerCase()}.`;
            await this.speak(resp, participantId);
            this.addConversationExchange(participantId, transcript, resp);
          } else if (!promptNature && promptAddress) {
            setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_CALL_NATURE, null, {
              address: promptAddress,
              additionalUnits: promptUnits,
              priority: promptPriority
            }, true);
            const resp = result.response || `${participantId}, go ahead with call nature.`;
            await this.speak(resp, participantId);
            this.addConversationExchange(participantId, transcript, resp);
          } else {
            setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_CALL_NATURE, null, {
              address: null,
              additionalUnits: promptUnits,
              priority: promptPriority
            }, true);
            const resp = result.response || `${participantId}, go ahead with call nature and address.`;
            await this.speak(resp, participantId);
            this.addConversationExchange(participantId, transcript, resp);
          }
          break;
        }

        case 'SIGNAL_100': {
          setUnitSessionState(participantId, DISPATCHER_STATE.SIGNAL_100_ACTIVE, null, {}, true);
          const sig100Resp = result.response || 'All units, Signal 100. Emergency traffic only.';
          await this.speak(sig100Resp, participantId);
          this.addConversationExchange(participantId, transcript, sig100Resp);
          break;
        }

        case 'SIGNAL_100_CLEAR': {
          setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
          const sigClearResp = result.response || 'All units, Signal 100 clear. Resume normal traffic.';
          await this.speak(sigClearResp, participantId);
          this.addConversationExchange(participantId, transcript, sigClearResp);
          break;
        }

        case 'SPELL_NAME': {
          const spellSession = getUnitSessionState(participantId);
          const lastResult = spellSession?.slots?.lastSearchResult;
          if (lastResult?.lastName) {
            const spelled = lastResult.lastName.toUpperCase().split('').join(', ');
            const spellResp = `${participantId}, last name spelling: ${spelled}.`;
            await this.speak(spellResp, participantId);
            this.addConversationExchange(participantId, transcript, spellResp);
          } else {
            const noNameResp = `${participantId}, no name on file to spell.`;
            await this.speak(noNameResp, participantId);
            this.addConversationExchange(participantId, transcript, noNameResp);
          }
          break;
        }

        case 'REPEAT':
        case 'REPEAT_RESULTS': {
          const repeatSession = getUnitSessionState(participantId);
          const repeatResult = repeatSession?.slots?.lastSearchResult;
          const lastSpoken = repeatSession?.slots?.lastSpokenText;
          if (repeatResult) {
            const parts = [];
            if (repeatResult.lastName) parts.push(`Last name ${repeatResult.lastName}`);
            if (repeatResult.firstName) parts.push(`first ${repeatResult.firstName}`);
            if (repeatResult.dob) parts.push(`date of birth ${repeatResult.dob}`);
            if (repeatResult.status) parts.push(`status ${repeatResult.status}`);
            const repeatResp = `${participantId}, repeating: ${parts.join(', ')}.`;
            await this.speak(repeatResp, participantId);
            this.addConversationExchange(participantId, transcript, repeatResp);
          } else if (lastSpoken) {
            const repeatResp = `${participantId}, repeating: ${lastSpoken}`;
            await this.speak(repeatResp, participantId);
            this.addConversationExchange(participantId, transcript, repeatResp);
          } else {
            const noRepeatResp = `${participantId}, nothing to repeat.`;
            await this.speak(noRepeatResp, participantId);
            this.addConversationExchange(participantId, transcript, noRepeatResp);
          }
          break;
        }

        default: {
          this.log('LLM_UNKNOWN_INTENT', { intent: result.intent });
          const defaultResp = result.response || `${participantId}, Central, say again?`;
          await this.speak(defaultResp, participantId);
          this.addConversationExchange(participantId, transcript, defaultResp);
          break;
        }
      }
    } catch (llmError) {
      this.log('LLM_ERROR', { error: llmError.message });
      this.log('LLM_FALLBACK_TO_REGEX', { participant: participantId });
      await this.processTranscriptWithRegex(transcript, participantId);
    }
  }

  async processTranscriptWithRegex(transcript, participantId) {
    const commandResult = matchCommand(transcript, participantId);
    if (!commandResult) {
      this.log('COMMAND_NO_MATCH', { transcript });
      return;
    }

    if (commandResult.intent === 'PERSON_CHECK_DETAILS') {
      await this.handlePersonCheckDetails(participantId, commandResult.rawTranscript);
      return;
    }

    if (commandResult.intent === 'PERSON_CHECK_DOB') {
      await this.handlePersonCheckDOB(participantId, commandResult.rawTranscript, commandResult.slots);
      return;
    }

    if (commandResult.intent === 'PERSON_CHECK_FIRSTNAME') {
      await this.handlePersonFirstName(participantId, commandResult.rawTranscript, commandResult.slots);
      return;
    }

    if (commandResult.intent === 'PERSON_CHECK_CONFIRM') {
      await this.handlePersonCheckConfirm(participantId, commandResult.rawTranscript, commandResult.slots);
      return;
    }

    if (commandResult.intent === 'ZONE_DETAILS_WITH_ZONE') {
      await this.handleZoneConfirmPrompt(participantId, commandResult.slots.zone);
      return;
    }

    if (commandResult.intent === 'ZONE_DETAILS') {
      await this.handleZoneDetails(participantId, commandResult.rawTranscript);
      return;
    }

    if (commandResult.intent === 'ZONE_CONFIRM') {
      await this.handleZoneConfirm(participantId, commandResult.rawTranscript, commandResult.slots);
      return;
    }

    if (commandResult.intent === 'DETAIL_WITH_LOCATION') {
      await this.handleDetailConfirmPrompt(participantId, commandResult.slots.location);
      return;
    }

    if (commandResult.intent === 'DETAIL_LOCATION') {
      await this.handleDetailLocation(participantId, commandResult.rawTranscript);
      return;
    }

    if (commandResult.intent === 'DETAIL_CONFIRM') {
      await this.handleDetailConfirm(participantId, commandResult.rawTranscript, commandResult.slots);
      return;
    }

    if (commandResult.intent === 'SECURE_CONFIRM_RESPONSE') {
      await this.handleSecureConfirmResponse(participantId, commandResult.rawTranscript, commandResult.slots);
      return;
    }

    let finalResponse = commandResult.response;
    let finalCadStatus = commandResult.cadStatus;
    let finalCadAction = commandResult.cadAction;
    let finalCadData = commandResult.cadData;

    if (commandResult.asyncCompletion) {
      try {
        const cadServiceArg = cadService.isConfigured() ? cadService : null;
        const asyncResult = await commandResult.asyncCompletion(cadServiceArg);
        if (asyncResult) {
          finalResponse = asyncResult.response;
          finalCadStatus = asyncResult.cadStatus;
          finalCadAction = asyncResult.cadAction;
          finalCadData = asyncResult.cadData;
        }
      } catch (asyncError) {
        this.log('ASYNC_COMPLETION_ERROR', { error: asyncError.message });
        finalResponse = `${commandResult.unitId}, standby. System error.`;
      }
    }

    this.log('COMMAND_MATCHED', { transcript, response: finalResponse, cadStatus: finalCadStatus, cadAction: finalCadAction });

    if (finalCadStatus && commandResult.unitId) {
      try {
        const cadResult = await cadService.updateUnitStatus(commandResult.unitId, finalCadStatus);
        this.log('CAD_STATUS_UPDATE', { 
          unitId: commandResult.unitId, 
          status: finalCadStatus, 
          success: cadResult.success,
          error: cadResult.error
        });
      } catch (cadError) {
        this.log('CAD_ERROR', { error: cadError.message });
      }
    }

    if (finalCadAction === 'broadcast' && finalCadData && cadService.isConfigured()) {
      try {
        const broadcastResult = await cadService.sendBroadcast(finalCadData.message, finalCadData.priority);
        this.log('CAD_BROADCAST', { 
          message: finalCadData.message,
          priority: finalCadData.priority,
          success: broadcastResult.success,
          error: broadcastResult.error
        });
      } catch (cadError) {
        this.log('CAD_BROADCAST_ERROR', { error: cadError.message });
      }
    }

    if (!finalResponse) {
      this.log('NO_RESPONSE_NEEDED');
      return;
    }

    if (!await this.shouldRespond()) {
      this.log('TTS_ABORTED', { reason: 'Disabled before TTS' });
      return;
    }

    const responseAudio = await textToSpeech(finalResponse);

    if (!await this.shouldRespond()) {
      this.log('PUBLISH_ABORTED', { reason: 'Disabled before publish' });
      return;
    }

    await this.publishAudio(responseAudio, finalResponse);
  }

  async handlePersonCheckDetails(participantId, rawTranscript, llmSlots) {
    this.log('PERSON_CHECK_DETAILS', { participant: participantId, transcript: rawTranscript, llmSlots });
    
    const personDetails = parsePersonDetails(rawTranscript);
    this.log('PERSON_DETAILS_PARSED', personDetails);
    
    if (!personDetails.lastName && llmSlots?.lastName) {
      personDetails.lastName = llmSlots.lastName;
      this.log('PERSON_DETAILS_LLM_FALLBACK', { field: 'lastName', value: llmSlots.lastName });
    }
    if (!personDetails.firstName && llmSlots?.firstName) {
      personDetails.firstName = llmSlots.firstName;
      this.log('PERSON_DETAILS_LLM_FALLBACK', { field: 'firstName', value: llmSlots.firstName });
    }
    if (!personDetails.dob && llmSlots?.dob) {
      const llmDob = parseDOB(llmSlots.dob);
      if (llmDob) {
        personDetails.dob = llmDob;
        this.log('PERSON_DETAILS_LLM_FALLBACK', { field: 'dob', value: llmSlots.dob, parsed: llmDob.formatted });
      }
    }
    
    if (!personDetails.lastName) {
      const response = `${participantId}, did not copy last name. Go ahead with last name.`;
      await this.speak(response, participantId);
      return;
    }
    
    if (!personDetails.firstName) {
      const newSlots = { lastName: personDetails.lastName };
      if (personDetails.dob) newSlots.dob = personDetails.dob.formatted;
      setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_PERSON_FIRSTNAME, null, newSlots, true);
      const response = `${participantId}, did not copy first name. Go ahead with first name.`;
      await this.speak(response, participantId);
      return;
    }
    
    if (!personDetails.dob) {
      setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_PERSON_DOB, null, {
        lastName: personDetails.lastName,
        firstName: personDetails.firstName
      }, true);
      const response = `${participantId}, did not copy date of birth. Go ahead with date of birth.`;
      await this.speak(response, participantId);
      return;
    }
    
    const lastName = personDetails.lastName;
    const firstName = personDetails.firstName;
    const dob = personDetails.dob.formatted;
    
    setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_PERSON_CONFIRM, null, {
      lastName,
      firstName,
      dob
    }, true);
    
    const confirmResponse = `${participantId}, confirming. Last ${lastName}, first ${firstName}, date of birth ${dob}. 10-4?`;
    await this.speak(confirmResponse, participantId);
  }

  async handlePersonCheckDOB(participantId, rawTranscript, savedSlots, llmSlots) {
    this.log('PERSON_CHECK_DOB', { participant: participantId, transcript: rawTranscript, savedSlots, llmSlots });
    
    let dob = null;
    if (llmSlots?.dob) {
      dob = parseDOB(llmSlots.dob);
      if (dob) {
        this.log('PERSON_DOB_LLM_SLOT_USED', { llmDob: llmSlots.dob, parsed: dob.formatted });
      }
    }
    if (!dob) {
      dob = parseDOB(rawTranscript);
    }
    
    if (!dob) {
      const response = `${participantId}, did not copy date of birth. Go ahead with date of birth.`;
      await this.speak(response, participantId);
      return;
    }
    
    const lastName = savedSlots.lastName;
    const firstName = savedSlots.firstName;
    const dobFormatted = dob.formatted;
    
    setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_PERSON_CONFIRM, null, {
      lastName,
      firstName,
      dob: dobFormatted
    }, true);
    
    const confirmResponse = `${participantId}, confirming. Last ${lastName}, first ${firstName}, date of birth ${dobFormatted}. 10-4?`;
    await this.speak(confirmResponse, participantId);
  }

  formatMilitaryTime() {
    const options = {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    };
    const formatter = new Intl.DateTimeFormat('en-US', options);
    const parts = formatter.formatToParts(new Date());
    const hour = parts.find(p => p.type === 'hour').value;
    const minute = parts.find(p => p.type === 'minute').value;
    return `${hour}${minute} hours`;
  }

  async handleZoneConfirmPrompt(participantId, zone) {
    this.log('ZONE_CONFIRM_PROMPT', { participant: participantId, zone });
    
    setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_ZONE_CONFIRM, null, { zone }, true);
    
    const confirmResponse = `${participantId}, just to confirm, you want a zone change to ${zone}?`;
    await this.speak(confirmResponse, participantId);
  }

  async handleZoneDetails(participantId, rawTranscript) {
    this.log('ZONE_DETAILS', { participant: participantId, transcript: rawTranscript });
    
    const zone = cleanTranscript(rawTranscript);
    
    if (!zone || zone.length < 2) {
      const response = `${participantId}, did not copy zone. Go ahead with zone.`;
      await this.speak(response, participantId);
      return;
    }
    
    await this.handleZoneConfirmPrompt(participantId, zone);
  }

  async handleZoneConfirm(participantId, rawTranscript, slots) {
    this.log('ZONE_CONFIRM', { participant: participantId, transcript: rawTranscript, slots });
    
    const normalized = rawTranscript.toLowerCase().trim();
    
    const confirmPhrases = [
      '10-4', '10/4', 'ten four', 'ten-four', 'tenfour',
      'affirmative', 'yes', 'yeah', 'yep', 'correct', 'that is correct',
      'copy', 'roger', 'roger that', 'copy that',
      'confirmed', 'confirm', 'thats right', "that's right", "that's correct"
    ];
    const denyPhrases = [
      'negative', 'neg', 'no', 'nope', 'incorrect', 'wrong',
      'not correct', 'that is wrong', "that's wrong", 'thats wrong',
      'repeat', 'say again', 'try again'
    ];
    
    let isConfirmed = false;
    let isDenied = false;
    
    for (const phrase of confirmPhrases) {
      if (normalized.includes(phrase)) { isConfirmed = true; break; }
    }
    if (!isConfirmed) {
      for (const phrase of denyPhrases) {
        if (normalized.includes(phrase)) { isDenied = true; break; }
      }
    }
    
    if (isDenied) {
      setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_ZONE, null, {}, true);
      const retryResponse = `${participantId}, can you repeat the zone for me again?`;
      await this.speak(retryResponse, participantId);
      return;
    }
    
    if (!isConfirmed) {
      const askAgainResponse = `${participantId}, confirm zone change, 10-4 or negative?`;
      await this.speak(askAgainResponse, participantId);
      return;
    }
    
    const zone = slots.zone;
    
    try {
      if (cadService.isConfigured()) {
        await cadService.updateUnitZone(participantId, zone);
        this.log('CAD_ZONE_UPDATED', { participantId, zone });
      }
    } catch (error) {
      this.log('CAD_ZONE_UPDATE_ERROR', { error: error.message });
    }
    
    const timeStr = this.formatMilitaryTime();
    const confirmResponse = `${participantId}, 10-4. ${timeStr}.`;
    await this.speak(confirmResponse, participantId);
    
    await this.logToCallNotes(participantId, `Zone change: ${zone}`);
    setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
  }

  async handleDetailConfirmPrompt(participantId, location) {
    this.log('DETAIL_CONFIRM_PROMPT', { participant: participantId, location });
    
    setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_DETAIL_CONFIRM, null, { location }, true);
    
    const confirmResponse = `${participantId}, just to confirm, detail at ${location}?`;
    await this.speak(confirmResponse, participantId);
  }

  async handleDetailLocation(participantId, rawTranscript) {
    this.log('DETAIL_LOCATION', { participant: participantId, transcript: rawTranscript });
    
    const location = cleanTranscript(rawTranscript);
    
    if (!location || location.length < 2) {
      const response = `${participantId}, did not copy location. Go ahead with location.`;
      await this.speak(response, participantId);
      return;
    }
    
    await this.handleDetailConfirmPrompt(participantId, location);
  }

  async handleDetailConfirm(participantId, rawTranscript, slots) {
    this.log('DETAIL_CONFIRM', { participant: participantId, transcript: rawTranscript, slots });
    
    const normalized = rawTranscript.toLowerCase().trim();
    
    const confirmPhrases = [
      '10-4', '10/4', 'ten four', 'ten-four', 'tenfour',
      'affirmative', 'yes', 'yeah', 'yep', 'correct', 'that is correct',
      'copy', 'roger', 'roger that', 'copy that',
      'confirmed', 'confirm', 'thats right', "that's right", "that's correct"
    ];
    const denyPhrases = [
      'negative', 'neg', 'no', 'nope', 'incorrect', 'wrong',
      'not correct', 'that is wrong', "that's wrong", 'thats wrong',
      'repeat', 'say again', 'try again'
    ];
    
    let isConfirmed = false;
    let isDenied = false;
    
    for (const phrase of confirmPhrases) {
      if (normalized.includes(phrase)) { isConfirmed = true; break; }
    }
    if (!isConfirmed) {
      for (const phrase of denyPhrases) {
        if (normalized.includes(phrase)) { isDenied = true; break; }
      }
    }
    
    if (isDenied) {
      setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_DETAIL_LOCATION, null, {}, true);
      const retryResponse = `${participantId}, can you repeat the location?`;
      await this.speak(retryResponse, participantId);
      return;
    }
    
    if (!isConfirmed) {
      const askAgainResponse = `${participantId}, confirm detail, 10-4 or negative?`;
      await this.speak(askAgainResponse, participantId);
      return;
    }
    
    const location = slots.location;
    
    try {
      if (cadService.isConfigured()) {
        await cadService.updateUnitStatus(participantId, 'detail');
        this.log('CAD_DETAIL_STATUS_UPDATED', { participantId, status: 'detail' });
        
        await cadService.updateUnitZone(participantId, location);
        this.log('CAD_DETAIL_ZONE_UPDATED', { participantId, location });
      }
    } catch (error) {
      this.log('CAD_DETAIL_UPDATE_ERROR', { error: error.message });
    }
    
    const timeStr = this.formatMilitaryTime();
    const confirmResponse = `${participantId}, 10-4. ${timeStr}.`;
    await this.speak(confirmResponse, participantId);
    
    await this.logToCallNotes(participantId, `Detail at: ${location}`);
    setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
  }

  async handleCallNatureInput(participantId, transcript, savedSlots) {
    this.log('CALL_NATURE_INPUT', { participant: participantId, transcript, savedSlots });

    const normalized = transcript.toLowerCase().trim();
    const disregardPhrases = ['disregard', 'cancel', 'cancel that', 'nevermind', 'never mind', '10-22', 'scratch that'];
    if (disregardPhrases.some(p => normalized.includes(p))) {
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      const resp = `${participantId}, 10-4, disregard.`;
      await this.speak(resp, participantId);
      return;
    }

    const nature = transcript.trim();
    if (!nature || nature.length < 2) {
      const resp = `${participantId}, did not copy call nature. Go ahead with call nature.`;
      await this.speak(resp, participantId);
      return;
    }

    const matchedNature = await cadService.findBestNature(nature);
    this.log('CALL_NATURE_MATCHED', { spoken: nature, matched: matchedNature });

    const address = savedSlots?.address;
    if (address) {
      setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_CALL_CONFIRM, null, {
        nature: matchedNature,
        address,
        additionalUnits: savedSlots?.additionalUnits || [],
        priority: savedSlots?.priority || 'medium'
      }, true);
      const confirmResp = `${participantId}, confirm, ${matchedNature.toLowerCase()} at ${address}?`;
      await this.speak(confirmResp, participantId);
    } else {
      setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_CALL_ADDRESS, null, {
        nature: matchedNature,
        additionalUnits: savedSlots?.additionalUnits || [],
        priority: savedSlots?.priority || 'medium'
      }, true);
      const resp = `${participantId}, go ahead with address.`;
      await this.speak(resp, participantId);
    }
  }

  async handleCallAddressInput(participantId, transcript, savedSlots) {
    this.log('CALL_ADDRESS_INPUT', { participant: participantId, transcript, savedSlots });

    const normalized = transcript.toLowerCase().trim();
    const disregardPhrases = ['disregard', 'cancel', 'cancel that', 'nevermind', 'never mind', '10-22', 'scratch that'];
    if (disregardPhrases.some(p => normalized.includes(p))) {
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      const resp = `${participantId}, 10-4, disregard.`;
      await this.speak(resp, participantId);
      return;
    }

    const address = normalizeAddress(cleanTranscript(transcript));
    if (!address || address.length < 2) {
      const resp = `${participantId}, did not copy address. Go ahead with address.`;
      await this.speak(resp, participantId);
      return;
    }

    const nature = savedSlots?.nature || 'UNKNOWN TYPE';
    setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_CALL_CONFIRM, null, {
      nature,
      address,
      additionalUnits: savedSlots?.additionalUnits || [],
      priority: savedSlots?.priority || 'medium'
    }, true);
    const confirmResp = `${participantId}, confirm, ${nature.toLowerCase()} at ${address}?`;
    await this.speak(confirmResp, participantId);
  }

  async handleCallConfirm(participantId, transcript, slots) {
    this.log('CALL_CONFIRM', { participant: participantId, transcript, slots });

    const normalized = transcript.toLowerCase().trim();

    const confirmPhrases = [
      '10-4', '10/4', 'ten four', 'ten-four', 'tenfour',
      'affirmative', 'yes', 'yeah', 'yep', 'correct', 'that is correct',
      'copy', 'roger', 'roger that', 'copy that',
      'confirmed', 'confirm', 'thats right', "that's right", "that's correct"
    ];
    const denyPhrases = [
      'negative', 'neg', 'no', 'nope', 'incorrect', 'wrong',
      'not correct', 'that is wrong', "that's wrong", 'thats wrong',
      'repeat', 'say again', 'try again'
    ];

    let isConfirmed = false;
    let isDenied = false;

    for (const phrase of confirmPhrases) {
      if (normalized.includes(phrase)) { isConfirmed = true; break; }
    }
    if (!isConfirmed) {
      for (const phrase of denyPhrases) {
        if (normalized.includes(phrase)) { isDenied = true; break; }
      }
    }

    if (isDenied) {
      await this.handleCallDeny(participantId);
      return;
    }

    if (!isConfirmed) {
      const askResp = `${participantId}, confirm call, 10-4 or negative?`;
      await this.speak(askResp, participantId);
      return;
    }

    await this.executeCallCreation(participantId, slots);
  }

  async handleCallDeny(participantId) {
    this.log('CALL_DENY', { participant: participantId });
    setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
    const resp = `${participantId}, 10-4, disregard.`;
    await this.speak(resp, participantId);
  }

  async executeCallCreation(participantId, slots) {
    const { nature, address, additionalUnits, priority } = slots;
    this.log('CALL_CREATION_EXECUTING', { participantId, nature, address, priority, additionalUnits });

    try {
      if (!cadService.isConfigured()) {
        this.log('CALL_CREATION_SKIPPED', { reason: 'CAD not configured' });
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
        const timeStr = this.formatMilitaryTime();
        const resp = `${participantId}, 10-4. ${nature.toLowerCase()} at ${address}. ${timeStr}.`;
        await this.speak(resp, participantId);
        return;
      }

      const callResult = await cadService.createCall(nature, priority || 'medium', address, '', `Created by AI Dispatcher for ${participantId}`);
      this.log('CAD_CALL_CREATED', { success: callResult.success, callId: callResult.call_id, error: callResult.error });

      if (!callResult.success) {
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
        const resp = `${participantId}, unable to create call. System error.`;
        await this.speak(resp, participantId);
        return;
      }

      const callId = callResult.call_id;

      try {
        await cadService.assignUnitToCall(participantId, callId);
        this.log('CAD_UNIT_ASSIGNED', { unitId: participantId, callId });
      } catch (assignError) {
        this.log('CAD_UNIT_ASSIGN_ERROR', { unitId: participantId, callId, error: assignError.message });
      }

      if (additionalUnits && additionalUnits.length > 0) {
        for (const unitId of additionalUnits) {
          try {
            await cadService.assignUnitToCall(unitId, callId);
            this.log('CAD_ADDITIONAL_UNIT_ASSIGNED', { unitId, callId });
          } catch (assignError) {
            this.log('CAD_ADDITIONAL_UNIT_ASSIGN_ERROR', { unitId, callId, error: assignError.message });
          }
        }
      }

      try {
        await cadService.updateUnitStatus(participantId, 'en_route');
        this.log('CAD_STATUS_UPDATED_EN_ROUTE', { unitId: participantId });
      } catch (statusError) {
        this.log('CAD_STATUS_UPDATE_ERROR', { unitId: participantId, error: statusError.message });
      }

      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      const timeStr = this.formatMilitaryTime();
      const resp = `${participantId}, 10-4. Call created, ${nature.toLowerCase()} at ${address}. ${timeStr}.`;
      await this.speak(resp, participantId);

    } catch (error) {
      this.log('CALL_CREATION_ERROR', { error: error.message });
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      const resp = `${participantId}, unable to create call. System error.`;
      await this.speak(resp, participantId);
    }
  }

  async handlePersonFirstName(participantId, rawTranscript, savedSlots) {
    this.log('PERSON_CHECK_FIRSTNAME', { participant: participantId, transcript: rawTranscript, savedSlots });
    
    const cleaned = rawTranscript
      .replace(/[,\.]/g, ' ')
      .split(/\s+/)
      .filter(p => p.length > 1 && !['and', 'the', 'is', 'a', 'an', 'my', 'its', "it's"].includes(p.toLowerCase()));
    
    const firstName = cleaned.length > 0 ? extractNameFromTranscript(cleaned[0]) : null;
    
    if (!firstName) {
      const response = `${participantId}, did not copy first name. Go ahead with first name.`;
      await this.speak(response, participantId);
      return;
    }
    
    const lastName = savedSlots.lastName;
    const dob = savedSlots.dob || null;
    
    if (!dob) {
      setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_PERSON_DOB, null, {
        lastName,
        firstName
      }, true);
      const response = `${participantId}, did not copy date of birth. Go ahead with date of birth.`;
      await this.speak(response, participantId);
      return;
    }
    
    setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_PERSON_CONFIRM, null, {
      lastName,
      firstName,
      dob
    }, true);
    
    const confirmResponse = `${participantId}, confirming. Last ${lastName}, first ${firstName}, date of birth ${dob}. 10-4?`;
    await this.speak(confirmResponse, participantId);
  }

  async handlePersonCheckConfirm(participantId, rawTranscript, slots) {
    this.log('PERSON_CHECK_CONFIRM', { participant: participantId, transcript: rawTranscript, slots });
    
    const normalized = rawTranscript.toLowerCase().trim();
    
    const confirmPhrases = [
      '10-4', '10/4', 'ten four', 'ten-four', 'tenfour',
      'affirmative', 'yes', 'yeah', 'yep', 'correct', 'that is correct',
      'copy', 'roger', 'roger that', 'copy that', 'go ahead',
      'confirmed', 'confirm', 'thats right', "that's right", "that's correct"
    ];
    const denyPhrases = [
      'negative', 'neg', 'no', 'nope', 'incorrect', 'wrong',
      'not correct', 'that is wrong', "that's wrong", 'thats wrong',
      'repeat', 'say again', 'try again', 'start over', 'redo'
    ];
    
    let isConfirmed = false;
    let isDenied = false;
    
    for (const phrase of confirmPhrases) {
      if (normalized.includes(phrase)) { isConfirmed = true; break; }
    }
    if (!isConfirmed) {
      for (const phrase of denyPhrases) {
        if (normalized.includes(phrase)) { isDenied = true; break; }
      }
    }
    
    if (isDenied) {
      setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_PERSON_DETAILS, null, {}, true);
      const retryResponse = `${participantId}, go ahead with details again.`;
      await this.speak(retryResponse, participantId);
      return;
    }
    
    if (!isConfirmed) {
      const askAgainResponse = `${participantId}, confirm details, 10-4 or negative?`;
      await this.speak(askAgainResponse, participantId);
      return;
    }
    
    const { lastName, firstName, dob } = slots;
    
    const standbyResponse = `${participantId}, 10-4. Standby.`;
    await this.speak(standbyResponse, participantId);
    
    await this.executePersonCheck(participantId, lastName, firstName, dob);
  }

  async executePersonCheck(participantId, lastName, firstName, dob) {
    try {
      if (!cadService.isConfigured()) {
        const noConfigResponse = `${participantId}, CAD system not available. Standby.`;
        await this.speak(noConfigResponse, participantId);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
        return;
      }
      
      this.log('CAD_PERSON_QUERY_SENDING', { participantId, firstName, lastName, dob });
      const cadResult = await cadService.queryPerson(firstName, lastName, dob);
      this.log('CAD_PERSON_QUERY_RESULT', { participantId, result: cadResult });
      
      if (!cadResult.success) {
        const errorResponse = `${participantId}, Central. Unable to complete records check. Try again.`;
        await this.speak(errorResponse, participantId);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
        return;
      }
      
      const person = (cadResult.results && cadResult.results.length > 0) ? cadResult.results[0] 
                   : (cadResult.person || cadResult.record || cadResult.data || null);
      const hasRecord = !!(cadResult.count > 0) || 
                        !!(cadResult.results && cadResult.results.length > 0) ||
                        !!(cadResult.found) ||
                        !!(person && Object.keys(person).length > 0);
      const hasFlags = person && (person.wanted || person.warrant || person.bolo || 
                       (person.warrants && person.warrants.length > 0) ||
                       (person.flags && person.flags.length > 0));
      
      this.log('PERSON_CHECK_ANALYSIS', { hasRecord, hasFlags, personKeys: person ? Object.keys(person) : [] });
      
      const lastSearchResult = { lastName, firstName, dob, status: hasFlags ? 'flagged' : hasRecord ? 'local file' : 'no record' };

      if (hasFlags) {
        setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_SECURE_CONFIRM, null, {
          lastName,
          firstName,
          dob,
          personData: person,
          lastSearchResult
        }, true);
        
        const securePrompt = `${participantId}, Central. Is your mic secure?`;
        await this.speak(securePrompt, participantId);
      } else if (hasRecord) {
        const clearResponse = `${participantId}, Central. Local file, no wants or warrants.`;
        await this.speak(clearResponse, participantId);
        
        await this.logToCallNotes(participantId, `Records check: ${lastName}, ${firstName}, DOB ${dob} - Local file, no wants or warrants`);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, { lastSearchResult }, true);
      } else {
        const noRecordResponse = `${participantId}, Central. No record on file.`;
        await this.speak(noRecordResponse, participantId);
        
        await this.logToCallNotes(participantId, `Records check: ${lastName}, ${firstName}, DOB ${dob} - No record on file`);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, { lastSearchResult }, true);
      }
      
    } catch (error) {
      this.log('PERSON_CHECK_ERROR', { error: error.message });
      const errorResponse = `${participantId}, Central. System error on records check.`;
      await this.speak(errorResponse, participantId);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
    }
  }

  async handleSecureConfirmResponse(participantId, rawTranscript, slots) {
    this.log('SECURE_CONFIRM_RESPONSE', { participant: participantId, transcript: rawTranscript, slots });
    
    const secureResult = matchSecureConfirmation(rawTranscript);
    
    if (!secureResult) {
      const repeatPrompt = `${participantId}, Central. Confirm, is your mic secure?`;
      await this.speak(repeatPrompt, participantId);
      return;
    }
    
    if (!secureResult.confirmed) {
      const standbyResponse = `${participantId}, Central. Copy. Contact dispatch on secure line.`;
      await this.speak(standbyResponse, participantId);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      return;
    }
    
    const { lastName, firstName, dob, personData } = slots;
    
    let flagDetails = [];
    if (personData.wanted) flagDetails.push(`wanted out of ${personData.wanted_county || 'unknown county'}`);
    if (personData.warrant) flagDetails.push(`active warrant out of ${personData.warrant_county || 'unknown county'}`);
    if (personData.warrants && personData.warrants.length > 0) {
      personData.warrants.forEach(w => {
        flagDetails.push(`${w.type || 'warrant'} out of ${w.county || 'unknown county'}`);
      });
    }
    if (personData.bolo) flagDetails.push('active BOLO');
    if (personData.flags && personData.flags.length > 0) {
      personData.flags.forEach(f => flagDetails.push(f.description || f.type || 'flag on file'));
    }
    
    const flagText = flagDetails.length > 0 ? flagDetails.join(', ') : 'flag on file';
    const flagResponse = `${participantId}, Central. ${lastName}, ${firstName}, date of birth ${dob} returns ${flagText}. Use caution.`;
    await this.speak(flagResponse, participantId);
    
    await this.logToCallNotes(participantId, `Records check: ${lastName}, ${firstName}, DOB ${dob} - ${flagText}`);
    
    setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
  }

  async logToCallNotes(unitId, note) {
    try {
      if (!cadService.isConfigured()) return;
      
      const statusCheck = await cadService.getStatusCheck();
      if (statusCheck.success && statusCheck.units) {
        const unitData = statusCheck.units.find(u => u.unit_id === unitId || u.id === unitId);
        if (unitData && unitData.call_id) {
          await cadService.addCallNote(unitData.call_id, note);
          this.log('CALL_NOTE_ADDED', { unitId, callId: unitData.call_id, note });
        }
      }
    } catch (error) {
      this.log('CALL_NOTE_ERROR', { error: error.message });
    }
  }

  async speak(text, participantId = null) {
    const audio = await textToSpeech(text);
    await this.publishAudio(audio, text);
    if (participantId) {
      const session = getUnitSessionState(participantId);
      setUnitSessionState(participantId, session?.state || 'IDLE', null, {
        lastSpokenText: text
      }, false);
    }
  }

  addConversationExchange(participantId, unitText, dispatchText) {
    const session = getUnitSessionState(participantId);
    const history = session?.slots?.conversationHistory || [];
    history.push({ unit: unitText, dispatch: dispatchText });
    if (history.length > 4) history.shift();
    setUnitSessionState(participantId, session?.state || 'IDLE', null, {
      conversationHistory: history
    }, false);
  }

  async publishAudio(audioBuffer, responseText = null) {
    try {
      if (!await this.shouldRespond()) {
        this.log('PUBLISH_SKIPPED', { reason: 'Disabled' });
        return;
      }

      if (!this.connected || !this.channelName) {
        this.log('PUBLISH_SKIPPED', { reason: 'Not connected to channel' });
        return;
      }

      const resampled48k = resampleAudio(audioBuffer, AZURE_SAMPLE_RATE, RELAY_SAMPLE_RATE);

      let opusFrames;
      try {
        opusFrames = opusCodec.encodePcmToOpus(resampled48k);
      } catch (err) {
        this.log('OPUS_ENCODE_ERROR', { error: err.message });
        return;
      }

      this.log('AUDIO_STREAMING', { opusFrames: opusFrames.length, channel: this.channelName });

      const floorResult = floorControlService.requestFloor(this.channelName, AI_IDENTITY, {
        isEmergency: false,
        emergencyStates: null,
      });
      if (!floorResult.granted) {
        this.log('PUBLISH_SKIPPED', { reason: 'Floor busy', heldBy: floorResult.heldBy });
        return;
      }

      await new Promise(resolve => setTimeout(resolve, 300));

      const startTime = Date.now();
      const FRAME_MS = 20;

      for (let i = 0; i < opusFrames.length; i++) {
        if (i % 10 === 0 && !this.isRunning) {
          this.log('PUBLISH_INTERRUPTED', { reason: 'Dispatcher stopped mid-publish' });
          break;
        }

        this._publishSequence = (this._publishSequence + 1) & 0xFFFF;
        audioRelayService.injectAudio(
          this.channelName,
          AI_IDENTITY,
          this._publishSequence,
          opusFrames[i]
        );

        const expectedTime = (i + 1) * FRAME_MS;
        const elapsed = Date.now() - startTime;
        const sleepTime = Math.max(0, expectedTime - elapsed);
        if (sleepTime > 0) {
          await new Promise(resolve => setTimeout(resolve, sleepTime));
        }
      }

      const TRAILING_SILENT_FRAMES = 4;
      const silentPcm = Buffer.alloc(OPUS_FRAME_SIZE * 2);
      let silentOpusFrames;
      try {
        silentOpusFrames = opusCodec.encodePcmToOpus(silentPcm);
      } catch (_) {
        silentOpusFrames = [];
      }
      for (const silentFrame of silentOpusFrames) {
        this._publishSequence = (this._publishSequence + 1) & 0xFFFF;
        audioRelayService.injectAudio(this.channelName, AI_IDENTITY, this._publishSequence, silentFrame);
        await new Promise(resolve => setTimeout(resolve, FRAME_MS));
      }

      await new Promise(resolve => setTimeout(resolve, 800));

      if (responseText && this.channelName) {
        try {
          const wavHeader = createWavHeader(audioBuffer.length, AZURE_SAMPLE_RATE, CHANNELS, 16);
          const wavBuffer = Buffer.concat([wavHeader, audioBuffer]);
          const filename = `${this.channelName}_${Date.now()}_AI-DISPATCHER.wav`;
          const filepath = path.join(AUDIO_DIR, filename);
          fs.writeFileSync(filepath, wavBuffer);
          const audioUrl = `/api/messages/audio/${filename}`;
          const samples = new Int16Array(audioBuffer.buffer, audioBuffer.byteOffset, audioBuffer.length / 2);
          const durationMs = Math.round((samples.length / AZURE_SAMPLE_RATE) * 1000);
          const msg = await createChannelMessage(this.channelName, 'AI-DISPATCHER', 'audio', null, audioUrl, durationMs);
          if (msg) {
            await createChannelMessage(this.channelName, 'AI-DISPATCHER', 'text', responseText).catch(() => {});
            broadcastMessage(this.channelName, msg).catch(() => {});
          }
          this.log('CHAT_RECORDED', { channel: this.channelName, messageId: msg?.id });
        } catch (chatErr) {
          this.log('CHAT_RECORD_ERROR', { error: chatErr.message });
        }
      }

      floorControlService.releaseFloor(this.channelName, AI_IDENTITY);

    } catch (error) {
      floorControlService.releaseFloor(this.channelName, AI_IDENTITY);
      this.log('PUBLISH_ERROR', { error: error.message });
    }
  }

  generateTone(toneType, durationMs) {
    const sampleRate = AZURE_SAMPLE_RATE;
    const numSamples = Math.floor((durationMs / 1000) * sampleRate);
    const samples = new Int16Array(numSamples);
    
    if (toneType === 'A') {
      const frequency = 1200;
      const amplitude = 0.5 * 32767;
      for (let i = 0; i < numSamples; i++) {
        samples[i] = Math.floor(Math.sin(2 * Math.PI * frequency * i / sampleRate) * amplitude);
      }
    } else if (toneType === 'CONTINUOUS') {
      const freq1 = 800;
      const freq2 = 850;
      const lfoFreq = 8;
      for (let i = 0; i < numSamples; i++) {
        const lfo = 0.6 + 0.3 * (Math.sin(2 * Math.PI * lfoFreq * i / sampleRate) > 0 ? 1 : 0);
        const wave1 = (2 * ((freq1 * i / sampleRate) % 1) - 1);
        const wave2 = (Math.sin(2 * Math.PI * freq2 * i / sampleRate) > 0 ? 1 : -1);
        samples[i] = Math.floor((wave1 + wave2) * 0.3 * lfo * 32767);
      }
    }
    
    return Buffer.from(samples.buffer);
  }

  async sendDataMessage(messageObj) {
    if (!this.connected || !this.channelName) return;
    try {
      const sig = await this._ensureSignalingService();
      sig.broadcastDataToChannel(this.channelName, messageObj);
      this.log('DATA_MESSAGE_SENT', messageObj);
    } catch (error) {
      this.log('DATA_MESSAGE_SEND_ERROR', { error: error.message });
    }
  }

  async playToneAndSpeak(toneType, message) {
    if (!this.connected || !this.isRunning) {
      this.log('TONE_SPEAK_SKIPPED', { reason: 'Not connected or not running' });
      return;
    }

    this.log('TONE_SPEAK_START', { toneType, message });

    try {
      await this.sendDataMessage({ type: 'ai-playback-start' });
      
      await new Promise(resolve => setTimeout(resolve, 200));
      
      const toneDuration = toneType === 'CONTINUOUS' ? 3000 : 2500;
      const toneAudio = this.generateTone(toneType, toneDuration);
      
      await this.publishAudio(toneAudio);
      
      await new Promise(resolve => setTimeout(resolve, 300));
      
      if (message) {
        const speechAudio = await textToSpeech(message);
        await this.publishAudio(speechAudio);
      }
      
      await new Promise(resolve => setTimeout(resolve, 300));
      
      await this.sendDataMessage({ type: 'ai-playback-end' });
      
      this.log('TONE_SPEAK_COMPLETE', { toneType, message });
    } catch (error) {
      this.log('TONE_SPEAK_ERROR', { error: error.message });
      await this.sendDataMessage({ type: 'ai-playback-end' });
    }
  }

  handleDataMessage(data, senderUnitId) {
    try {
      let jsonStr;
      if (data instanceof Uint8Array || Buffer.isBuffer(data)) {
        jsonStr = new TextDecoder().decode(data);
      } else if (typeof data === 'string') {
        jsonStr = data;
      } else {
        jsonStr = data.toString();
      }
      
      this.log('DATA_MESSAGE_RAW', { raw: jsonStr.substring(0, 200), sender: senderUnitId });
      
      const message = JSON.parse(jsonStr);
      
      if (message.type === 'heartbeat' && message.location) {
        const unitId = message.identity || senderUnitId;
        const { lat, lng, accuracy } = message.location;
        if (unitId && typeof lat === 'number' && typeof lng === 'number') {
          import('../services/locationService.js').then(mod => {
            mod.default.updateLocation(unitId, lat, lng, accuracy, message.channel);
          });
        }
      } else if (message.type === 'emergency' && message.active === true) {
        this.log('EMERGENCY_BUTTON_PRESSED', { unitId: senderUnitId, channel: this.channelName });
        this.emergencyEscalation.startEscalation(senderUnitId, this.channelName);
      } else if (message.type === 'emergency' && message.active === false) {
        this.log('EMERGENCY_BUTTON_CLEARED', { unitId: senderUnitId });
        this.emergencyEscalation.clearEscalation(senderUnitId);
      }
    } catch (error) {
      this.log('DATA_MESSAGE_PARSE_ERROR', { error: error.message });
    }
  }
}

let dispatcherInstance = null;
let signalingUnsubscribers = [];

export function getDispatcher() {
  if (!dispatcherInstance) {
    dispatcherInstance = new AIDispatcher();
  }
  return dispatcherInstance;
}

async function setupSignalingIntegration(channelName) {
  try {
    const { signalingService } = await import('./signalingService.js');
    const { aiDispatcherSignaling } = await import('./aiDispatcherSignaling.js');
    
    signalingUnsubscribers.forEach(unsub => unsub());
    signalingUnsubscribers = [];
    
    const dispatcher = getDispatcher();
    aiDispatcherSignaling.initialize(dispatcher);

    const allChannelKeys = new Set(dispatcher.channelAliases);
    if (dispatcher.configuredChannel) allChannelKeys.add(dispatcher.configuredChannel);
    if (dispatcher.displayChannel) allChannelKeys.add(dispatcher.displayChannel);
    if (channelName) allChannelKeys.add(channelName);

    for (const alias of allChannelKeys) {
      aiDispatcherSignaling.setActiveChannel(alias);
    }
    
    signalingUnsubscribers.push(
      signalingService.onPttStart(async (data) => {
        if (dispatcher.matchesChannel(data.channelId)) {
          console.log(`[AI-Dispatcher] PTT_START callback matched: channelId=${data.channelId}, unitId=${data.unitId}`);
          await aiDispatcherSignaling.handlePttStart(data.channelId, data.unitId, data.isEmergency);
        }
      })
    );
    
    signalingUnsubscribers.push(
      signalingService.onPttEnd(async (data) => {
        if (dispatcher.matchesChannel(data.channelId)) {
          await aiDispatcherSignaling.handlePttEnd(data.channelId, data.unitId, data.gracePeriodMs);
        }
      })
    );
    
    signalingUnsubscribers.push(
      signalingService.onEmergencyStart(async (data) => {
        if (dispatcher.matchesChannel(data.channelId)) {
          await aiDispatcherSignaling.handleEmergencyStart(data.channelId, data.unitId);
        }
      })
    );
    
    signalingUnsubscribers.push(
      signalingService.onEmergencyEnd(async (data) => {
        if (dispatcher.matchesChannel(data.channelId)) {
          await aiDispatcherSignaling.handleEmergencyEnd(data.channelId, data.unitId);
        }
      })
    );
    
    console.log(`[AI-Dispatcher] Signaling integration setup for channel: ${channelName} (aliases: ${Array.from(dispatcher.channelAliases).join(', ')})`);
  } catch (err) {
    console.error('[AI-Dispatcher] Failed to setup signaling integration:', err.message);
  }
}

export async function startDispatcher(channelName, roomKey = null) {
  const dispatcher = getDispatcher();
  const resolvedRoomKey = roomKey || channelName;
  await dispatcher.start(channelName, { roomKey: resolvedRoomKey });
  await setupSignalingIntegration(resolvedRoomKey);
}

export async function stopDispatcher() {
  const dispatcher = getDispatcher();
  
  signalingUnsubscribers.forEach(unsub => unsub());
  signalingUnsubscribers = [];
  
  try {
    const { aiDispatcherSignaling } = await import('./aiDispatcherSignaling.js');
    for (const alias of dispatcher.channelAliases) {
      aiDispatcherSignaling.removeActiveChannel(alias);
    }
    if (dispatcher.configuredChannel) {
      aiDispatcherSignaling.removeActiveChannel(dispatcher.configuredChannel);
    }
  } catch (err) {
    console.error('[AI-Dispatcher] Failed to cleanup signaling:', err.message);
  }
  
  await dispatcher.stop();
}

export async function restartDispatcher(channelName, roomKey = null) {
  await stopDispatcher();
  await startDispatcher(channelName, roomKey);
}

export async function broadcastMessage(channelName, message) {
  const dispatcher = getDispatcher();
  if (dispatcher.connected && dispatcher.channelName === channelName) {
    try {
      await dispatcher.sendDataMessage({
        type: 'new_message',
        message
      });
      console.log(`[AI-Dispatcher] Broadcast message to ${channelName}:`, message.id);
      return true;
    } catch (error) {
      console.error(`[AI-Dispatcher] Failed to broadcast to ${channelName}:`, error.message);
      return false;
    }
  }
  console.log(`[AI-Dispatcher] Cannot broadcast to ${channelName}: dispatcher is on ${dispatcher.channelName || 'no channel'}`);
  return false;
}
