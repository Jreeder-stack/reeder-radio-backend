import { speechToText, textToSpeech, isConfigured as isAzureConfigured } from './azureSpeechService.js';
import { matchCommand, resetDispatcherState, matchEmergencyResponse, matchSecureConfirmation, getUnitSessionState, setUnitSessionState, DISPATCHER_STATE, EMERGENCY_DISTRESS_PHRASES } from './commandMatcher.js';
import { isConfigured as isLlmConfigured, classifyIntent, answerWithData } from './llmIntentService.js';
import { parsePersonDetails, parseDOB, extractNameFromTranscript } from './phoneticParser.js';
import pool, { isAiDispatchEnabled, getAiDispatchChannel, createChannelMessage } from '../db/index.js';
import { isValidWav } from './wavValidator.js';
import { audioRelayService } from './audioRelayService.js';
import { opusCodec, SAMPLE_RATE as OPUS_SAMPLE_RATE, FRAME_SIZE as OPUS_FRAME_SIZE } from './opusCodec.js';
import { floorControlService } from './floorControlService.js';
import { formatSpokenTime24 } from './hourlyTimeBroadcastService.js';
import * as cadService from './cadService.js';
import locationService from './locationService.js';
import { webSearch, SEARCH_STATUS } from './webSearchService.js';
import fs from 'fs';
import path from 'path';

const AUDIO_DIR = path.join(process.cwd(), 'uploads', 'audio');
if (!fs.existsSync(AUDIO_DIR)) {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
}

const SPEECH_LOG_DIR = path.join(process.cwd(), 'logs');
if (!fs.existsSync(SPEECH_LOG_DIR)) {
  fs.mkdirSync(SPEECH_LOG_DIR, { recursive: true });
}
const SPEECH_LOG_FILE = path.join(SPEECH_LOG_DIR, 'ai-dispatch-speech.log');
const SPEECH_LOG_MAX_SIZE = 5 * 1024 * 1024;

let _speechLogWarnedAt = 0;
function writeSpeechLogLine(line) {
  try {
    if (fs.existsSync(SPEECH_LOG_FILE)) {
      const stats = fs.statSync(SPEECH_LOG_FILE);
      if (stats.size > SPEECH_LOG_MAX_SIZE) {
        const rotated = SPEECH_LOG_FILE + '.1';
        if (fs.existsSync(rotated)) fs.unlinkSync(rotated);
        fs.renameSync(SPEECH_LOG_FILE, rotated);
      }
    }
    fs.appendFileSync(SPEECH_LOG_FILE, line + '\n');
  } catch (err) {
    const now = Date.now();
    if (now - _speechLogWarnedAt > 60000) {
      _speechLogWarnedAt = now;
      console.warn(`[AI-DISPATCH-SPEECH] Log file write failed: ${err.message}`);
    }
  }
}

const MY_LOCATION_PATTERN = /\b(at my location|my location|at my current location|my current location|my GPS|my gps|at my GPS|at my gps|where I am|where i am|my position|at my position|my current position|my address|at my address|this address|at this address|this location|at this location|my detail|at my detail|my detail address|at my detail address|my detail location|at my detail location|my assigned location|at my assigned location|my zone|at my zone)\b/i;

function isMyLocationPhrase(text) {
  if (!text) return false;
  return MY_LOCATION_PATTERN.test(text);
}

const STATUS_VERB_RX = '(?:on[\\s-]?duty|off[\\s-]?duty|in\\s+service|out\\s+of\\s+service|available|en[\\s-]?route|on[\\s-]?scene|10[-\\s]?\\d{1,2}|ten[-\\s]\\w+)';
const UNIT_TOKEN_RX = '([a-z]+[\\s-]?\\d{1,3}|\\d{4})';

const TARGET_UNIT_PATTERNS = [
  new RegExp(`\\b(?:put|show|mark|set|place|change|update)\\s+${UNIT_TOKEN_RX}\\s+(?:to\\s+)?(?:as\\s+)?(?:${STATUS_VERB_RX})\\b`, 'i'),
  new RegExp(`\\b${UNIT_TOKEN_RX}\\s+is\\s+(?:${STATUS_VERB_RX})\\b`, 'i'),
  new RegExp(`\\b${UNIT_TOKEN_RX}\\s+(?:${STATUS_VERB_RX})\\b`, 'i'),
];

function normalizeUnitId(s) {
  if (!s) return null;
  return String(s).trim().toUpperCase().replace(/\s+/g, '-');
}

function detectTargetUnitFromTranscript(transcript) {
  if (!transcript) return null;
  const text = transcript.toLowerCase().replace(/[.,!?]/g, ' ').replace(/\s+/g, ' ').trim();
  for (const rx of TARGET_UNIT_PATTERNS) {
    const m = text.match(rx);
    if (m && m[1]) {
      return normalizeUnitId(m[1]);
    }
  }
  return null;
}

const STATE_ABBREVIATIONS = {
  'alabama': 'AL', 'alaska': 'AK', 'arizona': 'AZ', 'arkansas': 'AR',
  'california': 'CA', 'colorado': 'CO', 'connecticut': 'CT', 'delaware': 'DE',
  'florida': 'FL', 'georgia': 'GA', 'hawaii': 'HI', 'idaho': 'ID',
  'illinois': 'IL', 'indiana': 'IN', 'iowa': 'IA', 'kansas': 'KS',
  'kentucky': 'KY', 'louisiana': 'LA', 'maine': 'ME', 'maryland': 'MD',
  'massachusetts': 'MA', 'michigan': 'MI', 'minnesota': 'MN', 'mississippi': 'MS',
  'missouri': 'MO', 'montana': 'MT', 'nebraska': 'NE', 'nevada': 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', 'ohio': 'OH', 'oklahoma': 'OK',
  'oregon': 'OR', 'pennsylvania': 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', 'tennessee': 'TN', 'texas': 'TX', 'utah': 'UT',
  'vermont': 'VT', 'virginia': 'VA', 'washington': 'WA', 'west virginia': 'WV',
  'wisconsin': 'WI', 'wyoming': 'WY', 'district of columbia': 'DC',
  'puerto rico': 'PR', 'guam': 'GU', 'american samoa': 'AS',
  'u.s. virgin islands': 'VI', 'us virgin islands': 'VI',
  'northern mariana islands': 'MP',
};

const STATE_NAMES_SORTED = Object.keys(STATE_ABBREVIATIONS)
  .sort((a, b) => b.length - a.length);

const STATE_NAME_PATTERN = new RegExp(
  '^(' + STATE_NAMES_SORTED
    .map(s => s.replace(/\./g, '\\.'))
    .join('|') + ')(?:\\s+(\\d{5}(?:-\\d{4})?))?[.,;]?$',
  'i'
);

const STATE_TRAILING_PATTERN = new RegExp(
  '\\s(' + STATE_NAMES_SORTED
    .map(s => s.replace(/\./g, '\\.'))
    .join('|') + ')(?:\\s+(\\d{5}(?:-\\d{4})?))?[.,;]?$',
  'i'
);

function abbreviateState(addr) {
  const commaIdx = addr.lastIndexOf(',');
  if (commaIdx !== -1) {
    const before = addr.substring(0, commaIdx + 1);
    const after = addr.substring(commaIdx + 1).trim();
    const match = after.match(STATE_NAME_PATTERN);
    if (match) {
      const abbr = STATE_ABBREVIATIONS[match[1].toLowerCase()];
      if (abbr) {
        const zip = match[2] ? ` ${match[2]}` : '';
        return `${before} ${abbr}${zip}`;
      }
    }
    return addr;
  }
  const trailingMatch = addr.match(STATE_TRAILING_PATTERN);
  if (trailingMatch) {
    const abbr = STATE_ABBREVIATIONS[trailingMatch[1].toLowerCase()];
    if (abbr) {
      const zip = trailingMatch[2] ? ` ${trailingMatch[2]}` : '';
      const idx = trailingMatch.index;
      return addr.substring(0, idx) + ' ' + abbr + zip;
    }
  }
  return addr;
}

function normalizeAddress(raw) {
  if (!raw) return raw;
  let addr = raw.trim();
  addr = addr.replace(/^(it'?s going to be|it'?s at|it'?s over at|it'?s|that'?s going to be|that'?s at|going to be|over at|down at|at the|at)\s+/i, '');
  addr = addr.replace(/\s+in\s+(\w)/gi, ', $1');
  addr = addr.replace(/\b(\d+(?:st|nd|rd|th)?)\s+and\s+(\w)/gi, '$1 & $2');
  addr = addr.replace(/\b([A-Z][a-z]+)\s+and\s+([A-Z][a-z]+)/g, '$1 & $2');
  addr = abbreviateState(addr);
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

function pcmToWav(pcmBuffer, sampleRate = 16000, channels = 1, bitsPerSample = 16) {
  const wavHeader = createWavHeader(pcmBuffer.length, sampleRate, channels, bitsPerSample);
  return Buffer.concat([wavHeader, pcmBuffer]);
}

const AI_IDENTITY = 'AI-Dispatcher';
const RELAY_SAMPLE_RATE = 16000;
const AZURE_SAMPLE_RATE = 16000;
const CHANNELS = 1;
const SAMPLES_PER_FRAME = 320;
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

  logSpeechEvent(unitId, heard, intent, response) {
    const timestamp = new Date().toISOString();
    const line = `[AI-DISPATCH-SPEECH] ${timestamp} | unit=${unitId} | heard="${heard}" | intent=${intent} | response="${response || '(none)'}"`; 
    console.log(line);
    writeSpeechLogLine(line);
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
    this.logSpeechEvent(unitId, '(emergency key pressed)', 'STATUS_CHECK', message);
    
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

    let locationInfo = '';
    try {
      const unitLoc = await locationService.getUnitAddress(unitId);
      if (unitLoc && unitLoc.address) {
        locationInfo = ` Last known location: ${unitLoc.address}.`;
      }
    } catch (e) {}

    const message = `Attention all receiving units, ${unitId} pressed their emergency key with no response.${locationInfo}`;
    this.logSpeechEvent(unitId, '(no response to status check)', 'NO_RESPONSE_BROADCAST', message);
    
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
      
      const okResponse = `${unitId}, copy. Clear emergency.`;
      this.clearEscalation(unitId);
      return {
        response: okResponse,
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

function isCallPending(call) {
  const units = call.units || call.assigned_units || [];
  return !Array.isArray(units) || units.length === 0;
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
    this.verboseLogging = process.env.AI_DISPATCH_VERBOSE === 'true';
    this._turnContextByUnit = new Map();
    this._boloPollingInterval = null;
    this._seenBoloIds = new Set();
    this._statusCheckPollingInterval = null;
    this._seenStatusCheckIds = new Set();
    this._reconnectTimer = null;
    this._reconnectAttempts = 0;
    this._isReconnecting = false;
    this._healthCheckInterval = null;
    this._intentionalLeave = false;
    this.pipelineStatus = 'idle';
    this.pipelineError = null;
    this._decodeErrorCounts = new Map();
    this._sttErrorCount = 0;
    this._lastSuccessfulSttAt = null;
    this._framesReceivedCount = 0;
    this._decodeSuccessCount = 0;
  }

  log(action, details = {}) {
    const timestamp = new Date().toISOString();
    console.log(`[AI-Dispatcher] ${timestamp} | ${action}`, JSON.stringify(details));
  }

  verboseLog(action, details = {}) {
    if (!this.verboseLogging) return;
    const timestamp = new Date().toISOString();
    console.log(`[AI-Dispatcher-Verbose] ${timestamp} | ${action}`, JSON.stringify(details));
  }

  logSpeechEvent(unitId, transcript, intent, response) {
    const timestamp = new Date().toISOString();
    const line = `[AI-DISPATCH-SPEECH] ${timestamp} | unit=${unitId} | heard="${transcript}" | intent=${intent} | response="${response || '(none)'}"`; 
    console.log(line);
    writeSpeechLogLine(line);
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
      this._intentionalLeave = true;
      await this.leaveChannel();
      this._intentionalLeave = false;
    }

    this.configuredChannel = roomKey || channelName;
    this.displayChannel = channelName;
    this.isRunning = true;
    this.stoppedByUser = false;
    this._reconnectAttempts = 0;
    this.errorCounts.clear();
    this.errorCooldowns.clear();
    this._errorLastSeen.clear();
    this._startErrorCleanup();
    
    try {
      await this._resolveChannelAliases(channelName, roomKey);
    } catch (err) {
      this.log('START_FAILED', { phase: 'resolveChannelAliases', error: err.message, stack: err.stack });
      this.isRunning = false;
      this._stopErrorCleanup();
      return;
    }

    try {
      await this._ensureSignalingService();
    } catch (err) {
      this.log('START_FAILED', { phase: 'ensureSignalingService', error: err.message, stack: err.stack });
      this.isRunning = false;
      this._stopErrorCleanup();
      return;
    }

    const opusOk = this._opusSelfTest();
    if (!opusOk) {
      this.log('START_FAILED', { phase: 'opusSelfTest', reason: 'Opus decoder failed 16kHz self-test — cannot process audio' });
      this.isRunning = false;
      this._stopErrorCleanup();
      return;
    }
    
    if (cadService.isConfigured()) {
      cadService.getCallNatures().catch(err => {
        this.log('CALL_NATURES_PRELOAD_ERROR', { error: err.message });
      });
    }

    try {
      await this.joinChannel(this.configuredChannel);
    } catch (err) {
      this.log('START_FAILED', { phase: 'joinChannel', error: err.message, stack: err.stack, note: 'Will attempt reconnect — dispatcher remains assigned' });
      this._scheduleReconnect();
      return;
    }

    this.log('STARTED_CONNECTED', { channel: channelName, roomKey: this.configuredChannel, numericId: this.numericChannelId, aliases: Array.from(this.channelAliases), mode: 'always-on' });

    this._startBoloPolling();
    this._startStatusCheckPolling();
    this._startHealthCheck();
  }

  _removeAllAudioListeners() {
    audioRelayService.removeAllAudioListeners(AI_IDENTITY);
  }

  async leaveChannel() {
    const previousChannel = this.channelName;
    const wasConnected = this.connected;
    if (this.connected) {
      try {
        this._removeAllAudioListeners();
      } catch (error) {
        this.log('CHANNEL_LEAVE_ERROR', { channel: this.channelName, error: error.message });
      }
      this.connected = false;
      this.channelName = null;
      this.pipelineStatus = 'idle';
      this._clearAllRecordings();
    }

    if (this._intentionalLeave || this.stoppedByUser) {
      this.log('CHANNEL_LEFT_INTENTIONAL', {
        channel: previousChannel,
        reason: this.stoppedByUser ? 'stopped_by_user' : 'channel_switch',
        wasConnected
      });
    } else if (this.isRunning && wasConnected) {
      this.log('CHANNEL_LEFT_UNEXPECTED', {
        channel: previousChannel,
        state: 'recovering',
        note: 'Dispatcher is still assigned — will attempt to reconnect'
      });
      this._scheduleReconnect();
    }
  }

  _opusSelfTest() {
    try {
      const silentPcm = Buffer.alloc(OPUS_FRAME_SIZE * 2, 0);
      const encodedFrames = opusCodec.encodePcmToOpus(silentPcm);
      if (!encodedFrames || encodedFrames.length === 0) {
        this.log('OPUS_SELF_TEST_FAILED', { reason: 'Encoder produced no frames', sampleRate: 16000 });
        return false;
      }
      const decoded = opusCodec.decodeOpusToPcm(encodedFrames[0]);
      if (!decoded || decoded.length === 0) {
        this.log('OPUS_SELF_TEST_FAILED', { reason: 'Decoder produced empty output', sampleRate: 16000 });
        return false;
      }
      this.log('OPUS_SELF_TEST_PASSED', { sampleRate: 16000, channels: 1, encodedBytes: encodedFrames[0].length, decodedBytes: decoded.length });
      return true;
    } catch (err) {
      this.log('OPUS_SELF_TEST_FAILED', { error: err.message, stack: err.stack, sampleRate: 16000 });
      return false;
    }
  }

  _scheduleReconnect() {
    if (this.stoppedByUser) return;
    if (this._reconnectTimer) return;
    if (!this.isRunning) return;

    const BASE_DELAY_MS = 2000;
    const MAX_DELAY_MS = 120000;
    const ATTEMPT_RESET_THRESHOLD = 10;

    if (!this._reconnectAttempts) this._reconnectAttempts = 0;

    if (this._reconnectAttempts >= ATTEMPT_RESET_THRESHOLD) {
      this.log('RECONNECT_CYCLE_RESET', {
        previousAttempts: this._reconnectAttempts,
        channel: this.configuredChannel,
        note: 'Resetting attempt counter — dispatcher will keep retrying indefinitely while assigned'
      });
      this._reconnectAttempts = 0;
    }

    const delay = Math.min(BASE_DELAY_MS * Math.pow(2, this._reconnectAttempts), MAX_DELAY_MS);
    this._reconnectAttempts++;

    this._isReconnecting = true;
    this.log('RECONNECT_SCHEDULED', { attempt: this._reconnectAttempts, delayMs: delay, channel: this.configuredChannel });

    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      if (this.stoppedByUser || this.connected) {
        this._isReconnecting = false;
        return;
      }
      if (!this.isRunning) {
        this._isReconnecting = false;
        return;
      }

      this.log('RECONNECT_ATTEMPTING', { attempt: this._reconnectAttempts, channel: this.configuredChannel });

      try {
        await this._resolveChannelAliases(this.displayChannel, this.configuredChannel);
        await this._ensureSignalingService();
        await this.joinChannel(this.configuredChannel);
        this._reconnectAttempts = 0;
        this._isReconnecting = false;
        this.isRunning = true;
        this.log('RECONNECT_SUCCESS', { channel: this.configuredChannel });
        this._startHealthCheck();
        this._startBoloPolling();
        this._startStatusCheckPolling();
      } catch (err) {
        this.log('RECONNECT_FAILED', { attempt: this._reconnectAttempts, error: err.message });
        this._scheduleReconnect();
      }
    }, delay);
    if (this._reconnectTimer.unref) this._reconnectTimer.unref();
  }

  _stopReconnect() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._reconnectAttempts = 0;
    this._isReconnecting = false;
  }

  _startHealthCheck() {
    this._stopHealthCheck();
    const HEALTH_CHECK_INTERVAL_MS = 30000;
    this._healthCheckInterval = setInterval(() => {
      if (this.stoppedByUser) {
        this._stopHealthCheck();
        return;
      }
      if (!this.isRunning) {
        this._stopHealthCheck();
        return;
      }
      if (!this.connected) {
        this.log('HEALTH_CHECK_DISCONNECTED', { channel: this.configuredChannel, state: 'not_connected' });
        this._scheduleReconnect();
        return;
      }
      if (this.connected && this.channelName && this._audioListenerBound) {
        const listenKeys = new Set();
        listenKeys.add(this.channelName);
        for (const alias of this.channelAliases) {
          listenKeys.add(alias);
        }
        if (this.numericChannelId != null) {
          listenKeys.add(String(this.numericChannelId));
        }
        for (const key of listenKeys) {
          audioRelayService.addAudioListener(key, AI_IDENTITY, this._audioListenerBound);
        }
      }
    }, HEALTH_CHECK_INTERVAL_MS);
    if (this._healthCheckInterval.unref) this._healthCheckInterval.unref();
  }

  _stopHealthCheck() {
    if (this._healthCheckInterval) {
      clearInterval(this._healthCheckInterval);
      this._healthCheckInterval = null;
    }
  }

  async stop() {
    this.log('STOPPING', { channel: this.channelName });
    this.isRunning = false;
    this.stoppedByUser = true;
    this._stopReconnect();
    this._stopHealthCheck();
    this._stopBoloPolling();
    this._stopStatusCheckPolling();
    this._stopErrorCleanup();
    this.errorCounts.clear();
    this.errorCooldowns.clear();
    this._errorLastSeen.clear();
    this.emergencyEscalation.clearAllEscalations();
    resetDispatcherState();

    if (this.connected) {
      try {
        this._removeAllAudioListeners();
        this.log('CHANNEL_LEFT_INTENTIONAL', { channel: this.channelName, reason: 'stopped_by_user' });
      } catch (error) {
        this.log('CHANNEL_LEAVE_ERROR', { channel: this.channelName, error: error.message });
      }
      this.connected = false;
      this.channelName = null;
    }

    this._clearAllRecordings();
    this.pipelineStatus = 'idle';
    this.pipelineError = null;
    this._decodeErrorCounts.clear();
  }

  getPipelineStatus() {
    return {
      connected: this.connected,
      pipelineStatus: this._isReconnecting ? 'reconnecting' : this.pipelineStatus,
      pipelineError: this.pipelineError,
      framesReceived: this._framesReceivedCount,
      decodeSuccesses: this._decodeSuccessCount,
      sttErrors: this._sttErrorCount,
      lastSuccessfulSttAt: this._lastSuccessfulSttAt,
      channel: this.channelName || this.configuredChannel,
      reconnectAttempts: this._reconnectAttempts || 0,
    };
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
    if (this.connected) {
      this.log('REJOIN_SKIPPED', { reason: 'Already connected' });
      return;
    }
    if (!this.isRunning) {
      this.log('REJOIN_SKIPPED', { reason: 'Dispatcher is not running' });
      return;
    }
    if (this.stoppedByUser) {
      this.log('REJOIN_SKIPPED', { reason: 'Stopped by user' });
      return;
    }
    if (!this.configuredChannel) {
      this.log('REJOIN_SKIPPED', { reason: 'No channel configured' });
      return;
    }

    const enabled = await isAiDispatchEnabled();
    if (!enabled) {
      this.log('REJOIN_SKIPPED', { reason: 'AI Dispatch disabled in settings' });
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

  _matchDistressPhrase(normalizedText) {
    const SINGLE_WORD_PHRASES = new Set(['help', 'weapon', 'hostile', 'ambush']);
    for (const distress of EMERGENCY_DISTRESS_PHRASES) {
      if (SINGLE_WORD_PHRASES.has(distress.phrase)) {
        const regex = new RegExp(`\\b${distress.phrase}\\b`);
        if (regex.test(normalizedText)) {
          return distress;
        }
      } else {
        if (normalizedText.includes(distress.phrase)) {
          return distress;
        }
      }
    }
    return null;
  }

  _detectArrivalStatus(transcript) {
    if (!transcript) return 'on_scene';
    const t = transcript.toLowerCase();
    if (/\b(en route|enroute|en-route|responding to|rolling to|heading to|10-76|10\/76|10 76)\b/.test(t)) {
      return 'en_route';
    }
    return 'on_scene';
  }

  _looksLikeAddress(value) {
    if (!value || value.trim().length < 5) return false;
    const v = value.trim();
    if (/^\d+\s+\w/.test(v)) return true;
    if (/\b(st|street|ave|avenue|blvd|boulevard|rd|road|dr|drive|ln|lane|ct|court|way|pl|place|pike|hwy|highway)\b/i.test(v)) return true;
    return false;
  }

  _isOnDetailOrAssignment(status) {
    if (!status) return false;
    const s = status.toLowerCase();
    return s === 'detail' || s === 'on_scene' || s === 'en_route' || s === 'ondispatched';
  }

  async resolveUnitLocationFromCAD(unitId) {
    try {
      if (!cadService.isConfigured()) return null;
      const unitInfo = await cadService.getUnitInfo(unitId);
      if (!unitInfo) return null;

      if (this._isOnDetailOrAssignment(unitInfo.status)) {
        if (unitInfo.zone && this._looksLikeAddress(unitInfo.zone)) {
          this.log('UNIT_DETAIL_ZONE_ADDRESS', { unitId, zone: unitInfo.zone, status: unitInfo.status });
          return unitInfo.zone.trim();
        }
        if (unitInfo.currentLocation && this._looksLikeAddress(unitInfo.currentLocation)) {
          this.log('UNIT_DETAIL_CURRENT_LOCATION', { unitId, location: unitInfo.currentLocation, zone: unitInfo.zone, status: unitInfo.status });
          return unitInfo.currentLocation.trim();
        }
      } else {
        if (unitInfo.zone && this._looksLikeAddress(unitInfo.zone)) {
          this.log('UNIT_ZONE_AS_LOCATION', { unitId, zone: unitInfo.zone, status: unitInfo.status });
          return unitInfo.zone.trim();
        }
      }

      this.log('UNIT_CAD_NO_ADDRESS', { unitId, status: unitInfo.status, zone: unitInfo.zone, currentLocation: unitInfo.currentLocation });
      return null;
    } catch (error) {
      this.log('UNIT_CAD_LOCATION_ERROR', { unitId, error: error.message });
      return null;
    }
  }

  async resolveUnitLocationFromGPS(unitId) {
    try {
      const result = await locationService.getUnitAddress(unitId);
      if (result && result.address) {
        this.log('UNIT_LOCATION_FROM_GPS', { unitId, address: result.address, lat: result.lat, lng: result.lng });
        return result.address;
      }
      this.log('UNIT_GPS_NO_ADDRESS', { unitId, hasLocation: !!result });
      return null;
    } catch (error) {
      this.log('UNIT_GPS_RESOLVE_ERROR', { unitId, error: error.message });
      return null;
    }
  }

  async resolveUnitLocation(unitId) {
    const cadAddress = await this.resolveUnitLocationFromCAD(unitId);
    if (cadAddress) {
      this.log('UNIT_LOCATION_RESOLVED', { unitId, source: 'cad', address: cadAddress });
      return cadAddress;
    }

    const gpsAddress = await this.resolveUnitLocationFromGPS(unitId);
    if (gpsAddress) {
      this.log('UNIT_LOCATION_RESOLVED', { unitId, source: 'gps', address: gpsAddress });
      return gpsAddress;
    }

    this.log('UNIT_LOCATION_UNRESOLVABLE', { unitId });
    return null;
  }

  async handleEmergencyPhraseAssist(unitId, distressType) {
    this.log('EMERGENCY_PHRASE_ASSIST_START', { unitId, distressType });

    setUnitSessionState(unitId, DISPATCHER_STATE.IDLE, null, {}, true);

    let address = null;

    try {
      if (cadService.isConfigured()) {
        const callInfo = await cadService.getUnitCurrentCallById(unitId);
        if (callInfo && callInfo.location && callInfo.status === 'ON_SCENE') {
          address = callInfo.location;
          this.log('EMERGENCY_PHRASE_ADDRESS_FROM_CALL', { unitId, address, callNumber: callInfo.callNumber });
        }
      }
    } catch (e) {
      this.log('EMERGENCY_PHRASE_CALL_LOOKUP_ERROR', { unitId, error: e.message });
    }

    if (!address) {
      address = await this.resolveUnitLocation(unitId);
    }

    let broadcastMsg;
    if (address) {
      broadcastMsg = `Attention all units, priority assist ${unitId} at ${address}. ${unitId} is ${distressType}.`;
    } else {
      broadcastMsg = `Attention all units, priority assist ${unitId}. ${unitId} is ${distressType}. Location unknown, ${unitId} advise your location.`;
    }

    this.logSpeechEvent(unitId, `(emergency phrase: ${distressType})`, 'EMERGENCY_PHRASE_ASSIST', broadcastMsg);
    await this.playToneAndSpeak('CONTINUOUS', broadcastMsg);

    if (cadService.isConfigured()) {
      try {
        const cadMsg = `PRIORITY ASSIST: ${unitId} ${distressType}${address ? ` at ${address}` : ''}`;
        await cadService.sendBroadcast(cadMsg, 'emergency');
        this.log('EMERGENCY_PHRASE_CAD_BROADCAST', { unitId, message: cadMsg });
      } catch (e) {
        this.log('EMERGENCY_PHRASE_CAD_BROADCAST_ERROR', { unitId, error: e.message });
      }
    }

    try {
      const sigService = await this._ensureSignalingService();
      const trackStarted = sigService.requestLocationTrackStart(unitId);
      this.log('EMERGENCY_PHRASE_TRACK_START', { unitId, delivered: trackStarted });
    } catch (e) {
      this.log('EMERGENCY_PHRASE_TRACK_START_ERROR', { unitId, error: e.message });
    }

    this._turnContextByUnit.delete(unitId);

    await this.emergencyEscalation.startEscalation(unitId, this.channelName);
  }

  async joinChannel(channelName) {
    if (this.connected && this.channelName === channelName) {
      this.log('JOIN_SKIPPED', { reason: 'Already connected to this channel', channel: channelName });
      return;
    }

    if (this.connected) {
      this._intentionalLeave = true;
      await this.leaveChannel();
      this._intentionalLeave = false;
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
    this.pipelineStatus = 'awaiting_audio';
    this.pipelineError = null;
    this._framesReceivedCount = 0;
    this._decodeSuccessCount = 0;
    this._decodeErrorCounts.clear();
    this._sttErrorCount = 0;
    
    this.log('CHANNEL_JOINED', { channel: channelName, audioListenerKeys: Array.from(listenKeys), registeredNumericId: this.numericChannelId });
    this.verboseLog('OPUS_TRANSPORT_VERIFIED', { mode: 'server-side decode', note: 'AI dispatcher receives Opus from relay listeners and decodes server-side for STT' });
  }

  _onAudioFrame(audioEvent) {
    const { channelId, unitId, opusPayload, sequence, codec } = audioEvent;
    if (unitId === AI_IDENTITY) return;
    if (!this.isHumanParticipant(unitId)) {
      if (sequence === 0) {
        this.verboseLog('AUDIO_FRAME_NON_HUMAN', { unitId, channelId });
      }
      return;
    }

    this._framesReceivedCount++;
    if (sequence === 0 || (!this._activeRecordings.has(unitId) && sequence % 50 === 0)) {
      this.verboseLog('AUDIO_FRAME_RECEIVED', { unitId, channelId, sequence, codec: codec || 'opus', payloadBytes: opusPayload?.length });
    }

    let pcmFrame;
    if (codec === 'pcm') {
      pcmFrame = Buffer.isBuffer(opusPayload) ? opusPayload : Buffer.from(opusPayload);
      this._decodeSuccessCount++;
    } else {
      try {
        pcmFrame = opusCodec.decodeOpusToPcm(opusPayload, unitId);
        this._decodeSuccessCount++;
        const errCount = this._decodeErrorCounts.get(unitId) || 0;
        if (errCount > 0) {
          this._decodeErrorCounts.set(unitId, 0);
          this.log('OPUS_DECODE_RECOVERED', { unitId });
        }
        if (this.pipelineStatus === 'decode_error') {
          this.pipelineStatus = 'healthy';
          this.pipelineError = null;
        }
      } catch (err) {
        const errCount = (this._decodeErrorCounts.get(unitId) || 0) + 1;
        this._decodeErrorCounts.set(unitId, errCount);
        this.log('OPUS_DECODE_ERROR', { unitId, error: err.message, consecutiveErrors: errCount, sampleRate: OPUS_SAMPLE_RATE });
        if (errCount >= 3) {
          this.pipelineStatus = 'decode_error';
          this.pipelineError = `Opus decode failed for ${unitId}: ${err.message}`;
          this.log('PIPELINE_DECODE_DEGRADED', { unitId, consecutiveErrors: errCount });
        }
        return;
      }
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
      this.verboseLog('AUDIO_BUFFERING_START', { participant: unitId, channel: channelId });

      recording.maxTimer = setTimeout(() => {
        this.verboseLog('AUDIO_MAX_DURATION', { participant: unitId, maxMs: MAX_RECORDING_DURATION_MS, frameCount: recording.frameCount });
        this._finishRecording(unitId);
      }, MAX_RECORDING_DURATION_MS);
    }

    recording.chunks.push(pcmFrame);
    recording.frameCount++;
    recording.lastFrameTime = Date.now();

    if (recording.idleTimer) clearTimeout(recording.idleTimer);
    recording.idleTimer = setTimeout(() => {
      this.verboseLog('AUDIO_IDLE_TIMEOUT', { participant: unitId, frameCount: recording.frameCount });
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
      this.log('AUDIO_EMPTY', { participant: unitId, frameCount: recording.frameCount });
      return;
    }

    const audioBuffer = Buffer.concat(recording.chunks);
    this.log('AUDIO_BUFFERING_COMPLETE', {
      participant: unitId,
      frames: recording.frameCount,
      bytes: audioBuffer.length,
      durationMs: Math.round((audioBuffer.length / (RELAY_SAMPLE_RATE * 2)) * 1000)
    });

    const MIN_AUDIO_BYTES = RELAY_SAMPLE_RATE * 2 * 0.5;
    if (audioBuffer.length < MIN_AUDIO_BYTES) {
      this.log('AUDIO_TOO_SHORT', { participant: unitId, bytes: audioBuffer.length, minBytes: MIN_AUDIO_BYTES });
      return;
    }

    if (!this.isRunning) {
      this.verboseLog('AUDIO_DISCARDED', { reason: 'Dispatcher stopped during buffering' });
      return;
    }

    isAiDispatchEnabled().then(enabled => {
      if (enabled && this.isRunning) {
        this.processAudio(audioBuffer, unitId).catch(err => {
          this.log('PROCESS_AUDIO_UNHANDLED_ERROR', { error: err.message, participant: unitId });
        });
      }
    });
  }

  flushRecordingForUnit(unitId) {
    const recording = this._activeRecordings.get(unitId);
    if (!recording) {
      this.verboseLog('PTT_END_FLUSH_SKIPPED', { unitId, reason: 'No active recording' });
      return;
    }
    this.log('PTT_END_FLUSH', { unitId, frames: recording.frameCount, chunks: recording.chunks.length });
    this._finishRecording(unitId);
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

      if (!isValidWav(wavBuffer)) {
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
      
      const message = await createChannelMessage(channelName, sender, 'audio', null, audioUrl, durationSecs, wavBuffer);
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

      this.verboseLog('AUDIO_PROCESSING', { bytes: audioBuffer.length, channel: this.channelName, participant: participantId });

      this.log('STT_INVOKE', { participant: participantId, audioBytes: audioBuffer.length, sampleRate: RELAY_SAMPLE_RATE });

      const resampledAudio = resampleAudio(audioBuffer, RELAY_SAMPLE_RATE, AZURE_SAMPLE_RATE);

      let transcript;
      try {
        transcript = await speechToText(resampledAudio);
      } catch (sttErr) {
        this._sttErrorCount++;
        this.pipelineStatus = 'stt_error';
        this.pipelineError = `STT failed: ${sttErr.message}`;
        this.log('STT_ERROR', { participant: participantId, error: sttErr.message, totalSttErrors: this._sttErrorCount });
        throw sttErr;
      }

      if (!transcript) {
        this.verboseLog('STT_NO_SPEECH', { participant: participantId });
        return;
      }

      this._lastSuccessfulSttAt = Date.now();
      this._sttErrorCount = 0;
      if (this.pipelineStatus !== 'healthy') {
        const prevStatus = this.pipelineStatus;
        this.pipelineStatus = 'healthy';
        this.pipelineError = null;
        this.log('PIPELINE_HEALTHY', { participant: participantId, previousStatus: prevStatus });
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
          
          this._turnContextByUnit.set(participantId, { transcript, intent: `EMERGENCY_RESPONSE_${emergencyResponse.type}` });

          const result = await this.emergencyEscalation.handleUnitResponse(
            participantId, 
            emergencyResponse.type, 
            { distressType: emergencyResponse.distressType }
          );
          
          if (result && result.response) {
            await this.speak(result.response, participantId);
          } else {
            this.logSpeechEvent(participantId, transcript, `EMERGENCY_RESPONSE_${emergencyResponse.type}`, null);
            this._turnContextByUnit.delete(participantId);
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

      const currentSession = getUnitSessionState(participantId);
      const currentState = currentSession?.state || DISPATCHER_STATE.IDLE;
      if (currentState === DISPATCHER_STATE.IDLE) {
        const normalizedForGate = transcript.trim().toLowerCase();
        const isAddressingDispatch = /^central\b/i.test(normalizedForGate);
        if (!isAddressingDispatch) {
          this.verboseLog('IDLE_NO_CENTRAL_SKIP', { participant: participantId, transcript });
          return;
        }
      }

      if (isLlmConfigured()) {
        await this.processTranscriptWithLLM(transcript, participantId);
      } else {
        await this.processTranscriptWithRegex(transcript, participantId);
      }

    } catch (error) {
      this._turnContextByUnit.delete(participantId);
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

  _normalizeSTTMisrecognitions(transcript) {
    const sttCorrections = [
      { patterns: [/\bradio\s+shack\b/gi, /\bradio\s+shaq\b/gi, /\bready\s+a\s+check\b/gi, /\bradio\s+cheque\b/gi, /\bradio\s+shek\b/gi, /\bradio\s+sheck\b/gi, /\bradio\s+shak\b/gi], replacement: 'radio check' },
    ];
    let corrected = transcript;
    for (const { patterns, replacement } of sttCorrections) {
      for (const pattern of patterns) {
        corrected = corrected.replace(pattern, replacement);
      }
    }
    if (corrected !== transcript) {
      this.log('STT_NORMALIZATION', { original: transcript, corrected });
    }
    return corrected;
  }

  async processTranscriptWithLLM(transcript, participantId) {
    try {
      transcript = this._normalizeSTTMisrecognitions(transcript);

      const sessionState = getUnitSessionState(participantId);
      const { state, slots } = sessionState;

      const normalized = transcript.toLowerCase();

      if (state === DISPATCHER_STATE.IDLE) {
        const normalizedForDistress = normalized.replace(/[.,!?]/g, '').replace(/\s+/g, ' ').trim();
        const matchedDistressPhrase = this._matchDistressPhrase(normalizedForDistress);
        if (matchedDistressPhrase && /^central\b/.test(normalizedForDistress)) {
          this.log('EMERGENCY_PHRASE_FAST_PATH', { participant: participantId, transcript, distressType: matchedDistressPhrase.distressType });
          this._turnContextByUnit.set(participantId, { transcript, intent: 'EMERGENCY_PHRASE_ASSIST' });
          await this.handleEmergencyPhraseAssist(participantId, matchedDistressPhrase.distressType);
          return;
        }
      }

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
        this._turnContextByUnit.set(participantId, { transcript, intent: 'SECURE_CONFIRM' });
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
        this._turnContextByUnit.set(participantId, { transcript, intent: 'CALL_NATURE_INPUT' });
        await this.handleCallNatureInput(participantId, transcript, slots);
        return;
      }

      if (state === DISPATCHER_STATE.AWAITING_CALL_ADDRESS) {
        this.log('CALL_ADDRESS_FAST_PATH', { participant: participantId, transcript });
        this._turnContextByUnit.set(participantId, { transcript, intent: 'CALL_ADDRESS_INPUT' });
        await this.handleCallAddressInput(participantId, transcript, slots);
        return;
      }

      if (state === DISPATCHER_STATE.AWAITING_CALL_CONFIRM) {
        this.log('CALL_CONFIRM_FAST_PATH', { participant: participantId, transcript });
        this._turnContextByUnit.set(participantId, { transcript, intent: 'CALL_CONFIRM' });
        await this.handleCallConfirm(participantId, transcript, slots);
        return;
      }

      if (state === DISPATCHER_STATE.AWAITING_NOTE_CONTENT) {
        this.log('NOTE_CONTENT_FAST_PATH', { participant: participantId, transcript });
        this._turnContextByUnit.set(participantId, { transcript, intent: 'ADD_NOTE' });
        await this.handleNoteContentInput(participantId, transcript, slots);
        return;
      }

      if (state === DISPATCHER_STATE.AWAITING_DL_STATE) {
        this.log('DL_STATE_FAST_PATH', { participant: participantId, transcript });
        this._turnContextByUnit.set(participantId, { transcript, intent: 'PERSON_CHECK_DL' });
        await this.handleDLStateInput(participantId, transcript, slots);
        return;
      }

      if (state === DISPATCHER_STATE.AWAITING_DL_NUMBER) {
        this.log('DL_NUMBER_FAST_PATH', { participant: participantId, transcript });
        this._turnContextByUnit.set(participantId, { transcript, intent: 'PERSON_CHECK_DL' });
        await this.handleDLNumberInput(participantId, transcript, slots);
        return;
      }

      if (state === DISPATCHER_STATE.AWAITING_SSN) {
        this.log('SSN_FAST_PATH', { participant: participantId, transcript });
        this._turnContextByUnit.set(participantId, { transcript, intent: 'PERSON_CHECK_SSN' });
        await this.handleSSNInput(participantId, transcript, slots);
        return;
      }

      if (state === DISPATCHER_STATE.AWAITING_DISPOSITION) {
        this.log('DISPOSITION_FAST_PATH', { participant: participantId, transcript });
        this._turnContextByUnit.set(participantId, { transcript, intent: 'DISPOSE_CALL' });
        await this.handleDispositionInput(participantId, transcript, slots);
        return;
      }

      if (state === DISPATCHER_STATE.AWAITING_WARRANT_NAME) {
        this.log('WARRANT_NAME_FAST_PATH', { participant: participantId, transcript });
        this._turnContextByUnit.set(participantId, { transcript, intent: 'WARRANT_CHECK' });
        await this.handleWarrantNameInput(participantId, transcript, slots);
        return;
      }

      if (state === DISPATCHER_STATE.AWAITING_ANIMAL_SEARCH_TYPE) {
        this.log('ANIMAL_SEARCH_FAST_PATH', { participant: participantId, transcript });
        this._turnContextByUnit.set(participantId, { transcript, intent: 'ANIMAL_SEARCH' });
        await this.handleAnimalSearchInput(participantId, transcript, slots);
        return;
      }

      if (state === DISPATCHER_STATE.AWAITING_STATUS_CHECK_RESPONSE) {
        this.log('STATUS_CHECK_RESPONSE_FAST_PATH', { participant: participantId, transcript });
        this._turnContextByUnit.set(participantId, { transcript, intent: 'STATUS_CHECK_RESPONSE' });
        await this.handleStatusCheckResponse(participantId, transcript, slots);
        return;
      }

      if (state === DISPATCHER_STATE.AWAITING_CALL_UPDATE_DETAILS) {
        this.log('CALL_UPDATE_DETAILS_FAST_PATH', { participant: participantId, transcript });
        this._turnContextByUnit.set(participantId, { transcript, intent: 'UPDATE_CALL' });
        await this.handleCallUpdateDetailsInput(participantId, transcript, slots);
        return;
      }

      if (state === DISPATCHER_STATE.AWAITING_COMMAND) {
        const normalizedForEmergency = transcript.toLowerCase().replace(/[.,!?]/g, '').replace(/\s+/g, ' ').trim();
        const matchedDistress = this._matchDistressPhrase(normalizedForEmergency);
        if (matchedDistress) {
          this.log('EMERGENCY_PHRASE_DETECTED', { participant: participantId, transcript, distressType: matchedDistress.distressType });
          this._turnContextByUnit.set(participantId, { transcript, intent: 'EMERGENCY_PHRASE_ASSIST' });
          await this.handleEmergencyPhraseAssist(participantId, matchedDistress.distressType);
          return;
        }
      }

      const normalizedTranscript = transcript.trim().toLowerCase().replace(/[.,!?]+/g, '');
      const hasUnitToUnit = /\b\w+[\s-]*\d+\s+from\s+\w+[\s-]*\d+\b/i.test(normalizedTranscript);
      const hasCommandContent = /\b(10-\d+|run\b|plate\b|check\b|backup\b|service\b|zone\b|status\b|detail\b|stop\b|traffic\b|radio\b|time\b|clear\b|close\b|dispose\b|warrant\b|update\b|priority\b|animal\b|microchip\b|tag\b|call\b)/i.test(normalizedTranscript);
      if (!hasUnitToUnit && !hasCommandContent) {
        const isCentralHail = /^central\b/.test(normalizedTranscript);
        if (isCentralHail) {
          this.log('REGEX_WAKE_ONLY_PRECHECK', { participant: participantId, transcript });
          const wakeResp = `${participantId}, go ahead.`;
          this._turnContextByUnit.set(participantId, { transcript, intent: 'WAKE_ONLY' });
          await this.speak(wakeResp, participantId);
          this.addConversationExchange(participantId, transcript, wakeResp);
          setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_COMMAND);
          this.log('REGEX_WAKE_ONLY_AWAITING', { participant: participantId, newState: DISPATCHER_STATE.AWAITING_COMMAND });
          return;
        }
      }

      this.log('LLM_CLASSIFY_START', { participant: participantId, state, transcript });

      const conversationHistory = slots?.conversationHistory || [];
      const result = await classifyIntent(transcript, participantId, state, slots, conversationHistory);

      this.log('LLM_CLASSIFY_RESULT', { participant: participantId, intent: result.intent, response: result.response, slots: result.slots });
      this._turnContextByUnit.set(participantId, { transcript, intent: result.intent });

      const speakerNorm = normalizeUnitId(participantId);
      if (result.intent === 'STATUS_CHANGE') {
        const detected = detectTargetUnitFromTranscript(transcript);
        if (detected && detected !== speakerNorm) {
          this.log('STATUS_CHANGE_OTHER_REROUTED', {
            from: 'STATUS_CHANGE',
            detectedTarget: detected,
            speaker: speakerNorm,
            transcript,
          });
          result.intent = 'STATUS_CHANGE_OTHER';
          result.slots = { ...(result.slots || {}), targetUnit: detected };
          if (result.response) {
            const time = this.formatMilitaryTime();
            const statusText = result.cadStatus ? result.cadStatus.replace(/_/g, ' ') : 'updated';
            result.response = `Copy, ${detected} ${statusText}, ${time}.`;
          }
        }
      } else if (result.intent === 'STATUS_CHANGE_OTHER') {
        const llmTarget = result.slots?.targetUnit ? normalizeUnitId(result.slots.targetUnit) : null;
        if (!llmTarget) {
          const detected = detectTargetUnitFromTranscript(transcript);
          if (detected) {
            this.log('STATUS_CHANGE_OTHER_TARGET_RECOVERED', { detectedTarget: detected, transcript });
            result.slots = { ...(result.slots || {}), targetUnit: detected };
          }
        }
      }

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
          this.logSpeechEvent(participantId, transcript, 'SILENCE', null);
          this._turnContextByUnit.delete(participantId);
          break;
        }

        case 'DISREGARD': {
          this.log('LLM_DISREGARD', { participant: participantId, state });
          setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, { conversationHistory: [] }, true);
          const resp = result.response || `${participantId}, 10-4, disregard.`;
          await this.speak(resp, participantId);
          break;
        }

        case 'STATUS_CHANGE': {
          let statusUpdateFailed = false;
          let statusFailureType = null;
          if (result.cadStatus) {
            if (!cadService.isConfigured()) {
              statusUpdateFailed = true;
              statusFailureType = 'NOT_CONFIGURED';
              this.log('CAD_NOT_CONFIGURED', { unitId: participantId, status: result.cadStatus });
            } else {
              try {
                const cadResult = await cadService.updateUnitStatus(participantId, result.cadStatus);
                if (!cadResult || !cadResult.success) {
                  statusUpdateFailed = true;
                  statusFailureType = cadResult?.failureType || 'API_REJECTION';
                  this.log('CAD_STATUS_UPDATE_FAILED', { unitId: participantId, status: result.cadStatus, failureType: statusFailureType, error: cadResult?.error, statusCode: cadResult?.statusCode, responseBody: cadResult?.responseBody });
                }
                this.log('CAD_STATUS_UPDATE', { unitId: participantId, status: result.cadStatus, success: cadResult?.success });
              } catch (cadError) {
                statusUpdateFailed = true;
                statusFailureType = 'UNREACHABLE';
                this.log('CAD_ERROR', { error: cadError.message, stack: cadError.stack });
              }
            }
          }
          setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
          let statusResp;
          if (statusUpdateFailed && statusFailureType === 'NOT_CONFIGURED') {
            statusResp = `${participantId}, 10-4. CAD is not available, update your status via the MDT.`;
          } else if (statusUpdateFailed && statusFailureType === 'UNREACHABLE') {
            statusResp = `${participantId}, 10-4. Unable to reach CAD, update your status via the MDT.`;
          } else if (statusUpdateFailed) {
            statusResp = `${participantId}, 10-4. CAD update did not go through, try your MDT.`;
          } else {
            statusResp = result.response || `${participantId}, 10-4.`;
          }
          await this.speak(statusResp, participantId);
          this.addConversationExchange(participantId, transcript, statusResp);
          break;
        }

        case 'STATUS_CHANGE_OTHER': {
          const targetUnit = result.slots?.targetUnit?.toUpperCase().replace(/\s+/g, '-') || null;
          this.log('STATUS_CHANGE_OTHER_HANDLER', {
            targetUnit,
            requestedBy: participantId,
            channel: this.channelName,
            cadStatus: result.cadStatus,
            transcript,
          });
          if (!targetUnit) {
            const noTargetResp = result.response || `${participantId}, say again, which unit?`;
            await this.speak(noTargetResp, participantId, { retryOnBusy: true, retryContext: 'STATUS_CHANGE_OTHER_NO_TARGET' });
            this.addConversationExchange(participantId, transcript, noTargetResp);
            break;
          }
          let otherStatusFailed = false;
          let otherStatusFailureType = null;
          if (result.cadStatus) {
            if (!cadService.isConfigured()) {
              otherStatusFailed = true;
              otherStatusFailureType = 'NOT_CONFIGURED';
              this.log('CAD_NOT_CONFIGURED', { unitId: targetUnit, requestedBy: participantId, status: result.cadStatus });
            } else {
              try {
                const cadResult = await cadService.updateUnitStatus(targetUnit, result.cadStatus);
                if (!cadResult || !cadResult.success) {
                  otherStatusFailed = true;
                  otherStatusFailureType = cadResult?.failureType || 'API_REJECTION';
                  this.log('CAD_STATUS_OTHER_FAILED', { targetUnit, requestedBy: participantId, status: result.cadStatus, failureType: otherStatusFailureType, error: cadResult?.error });
                }
                this.log('CAD_STATUS_OTHER_UPDATE', { targetUnit, requestedBy: participantId, status: result.cadStatus, success: cadResult?.success });
              } catch (cadError) {
                otherStatusFailed = true;
                otherStatusFailureType = 'UNREACHABLE';
                this.log('CAD_ERROR', { error: cadError.message, stack: cadError.stack });
              }
            }
          }
          setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
          let otherStatusResp;
          if (otherStatusFailed && otherStatusFailureType === 'NOT_CONFIGURED') {
            otherStatusResp = `${participantId}, 10-4. CAD is not available, update via the MDT.`;
          } else if (otherStatusFailed && otherStatusFailureType === 'UNREACHABLE') {
            otherStatusResp = `${participantId}, 10-4. Unable to reach CAD, update via the MDT.`;
          } else if (otherStatusFailed) {
            otherStatusResp = `${participantId}, 10-4. CAD update for ${targetUnit} did not go through.`;
          } else {
            otherStatusResp = result.response || `Copy, ${targetUnit} ${result.cadStatus || 'updated'}, ${this.formatMilitaryTime()}.`;
          }
          this.log('STATUS_CHANGE_OTHER_SPEAK', { targetUnit, requestedBy: participantId, channel: this.channelName, text: otherStatusResp });
          await this.speak(otherStatusResp, participantId, { retryOnBusy: true, retryContext: `STATUS_CHANGE_OTHER:${targetUnit}` });
          this.addConversationExchange(participantId, transcript, otherStatusResp);
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
          let location = normalizeAddress(result.slots?.location);
          if (!location && isMyLocationPhrase(transcript)) {
            const gpsAddress = await this.resolveUnitLocation(participantId);
            if (gpsAddress) {
              location = gpsAddress;
              this.log('DETAIL_LOCATION_FROM_GPS', { participantId, address: gpsAddress });
            }
          }
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
          } else if (state === DISPATCHER_STATE.AWAITING_CLEAR_CONFIRM) {
            await this.handleClearConfirm(participantId, transcript);
          } else if (state === DISPATCHER_STATE.AWAITING_DISPOSE_CONFIRM) {
            await this.handleDisposeConfirm(participantId, transcript, slots);
          } else if (state === DISPATCHER_STATE.AWAITING_CALL_UPDATE_CONFIRM) {
            await this.handleCallUpdateConfirm(participantId, transcript, slots);
          } else if (state === DISPATCHER_STATE.AWAITING_STATUS_CHECK_RESPONSE) {
            await this.handleStatusCheckResponse(participantId, transcript, slots);
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
            await this.handleDetailConfirm(participantId, transcript, slots, result.slots);
          } else if (state === DISPATCHER_STATE.AWAITING_PERSON_CONFIRM) {
            await this.handlePersonCheckConfirm(participantId, transcript, slots);
          } else if (state === DISPATCHER_STATE.AWAITING_SECURE_CONFIRM) {
            await this.handleSecureConfirmResponse(participantId, transcript, slots);
          } else if (state === DISPATCHER_STATE.AWAITING_CALL_CONFIRM) {
            await this.handleCallDeny(participantId);
          } else if (state === DISPATCHER_STATE.AWAITING_CLEAR_CONFIRM) {
            setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
            const clearDenyResp = `${participantId}, 10-4, disregard.`;
            await this.speak(clearDenyResp, participantId);
            this.addConversationExchange(participantId, transcript, clearDenyResp);
          } else if (state === DISPATCHER_STATE.AWAITING_DISPOSE_CONFIRM) {
            setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
            const disposeDenyResp = `${participantId}, 10-4, disregard.`;
            await this.speak(disposeDenyResp, participantId);
            this.addConversationExchange(participantId, transcript, disposeDenyResp);
          } else if (state === DISPATCHER_STATE.AWAITING_CALL_UPDATE_CONFIRM) {
            setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
            const denyResp = `${participantId}, 10-4, disregard call update.`;
            await this.speak(denyResp, participantId);
            this.addConversationExchange(participantId, transcript, denyResp);
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

        case 'GENERAL_INQUIRY': {
          await this.handleGeneralInquiry(participantId, transcript, result);
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
          let address = normalizeAddress(result.slots?.address);
          const additionalUnits = result.slots?.additionalUnits || [];
          const priority = result.slots?.priority || 'medium';

          const arrivalStatus = this._detectArrivalStatus(transcript);

          if (address && isMyLocationPhrase(address)) {
            this.log('CREATE_CALL_ADDRESS_SELF_REF', { participantId, rawAddress: address });
            address = null;
          }

          if (address && !this._looksLikeAddress(address)) {
            this.log('CREATE_CALL_ADDRESS_NOT_REAL', { participantId, rawAddress: address });
            address = null;
          }

          if (!address) {
            const resolvedAddress = await this.resolveUnitLocation(participantId);
            if (resolvedAddress) {
              address = resolvedAddress;
              this.log('CREATE_CALL_ADDRESS_AUTO_RESOLVED', { participantId, address: resolvedAddress });
            }
          }

          if (nature && address) {
            const matchedNature = await cadService.findBestNature(nature);
            this.log('CREATE_CALL_MATCHED', { spoken: nature, matched: matchedNature, address, additionalUnits, arrivalStatus });
            setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_CALL_CONFIRM, null, {
              nature: matchedNature,
              address,
              additionalUnits,
              priority,
              arrivalStatus
            }, true);
            const confirmResp = `${participantId}, confirm, ${matchedNature.toLowerCase()} at ${address}?`;
            await this.speak(confirmResp, participantId);
            this.addConversationExchange(participantId, transcript, confirmResp);
          } else if (nature && !address) {
            const matchedNature = await cadService.findBestNature(nature);
            setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_CALL_ADDRESS, null, {
              nature: matchedNature,
              additionalUnits,
              priority,
              arrivalStatus
            }, true);
            const resp = result.response || `${participantId}, go ahead with address.`;
            await this.speak(resp, participantId);
            this.addConversationExchange(participantId, transcript, resp);
          } else {
            setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_CALL_NATURE, null, {
              address: address || null,
              additionalUnits,
              priority,
              arrivalStatus
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
          const promptArrivalStatus = this._detectArrivalStatus(transcript);

          if (promptNature && !promptAddress) {
            const matchedNature = await cadService.findBestNature(promptNature);
            setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_CALL_ADDRESS, null, {
              nature: matchedNature,
              additionalUnits: promptUnits,
              priority: promptPriority,
              arrivalStatus: promptArrivalStatus
            }, true);
            const resp = result.response || `${participantId}, go ahead with address for ${matchedNature.toLowerCase()}.`;
            await this.speak(resp, participantId);
            this.addConversationExchange(participantId, transcript, resp);
          } else if (!promptNature && promptAddress) {
            setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_CALL_NATURE, null, {
              address: promptAddress,
              additionalUnits: promptUnits,
              priority: promptPriority,
              arrivalStatus: promptArrivalStatus
            }, true);
            const resp = result.response || `${participantId}, go ahead with call nature.`;
            await this.speak(resp, participantId);
            this.addConversationExchange(participantId, transcript, resp);
          } else {
            setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_CALL_NATURE, null, {
              address: null,
              additionalUnits: promptUnits,
              priority: promptPriority,
              arrivalStatus: promptArrivalStatus
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

        case 'ASSIGN_CALL': {
          await this.handleAssignCall(participantId, transcript, result.slots);
          break;
        }

        case 'ASSIGN_OTHER_UNIT': {
          await this.handleAssignOtherUnit(participantId, transcript, result.slots);
          break;
        }

        case 'ADD_NOTE': {
          await this.handleAddNote(participantId, transcript, result.slots);
          break;
        }

        case 'QUERY_CALLS': {
          await this.handleQueryCalls(participantId, transcript);
          break;
        }

        case 'CALL_FOLLOWUP': {
          await this.handleCallFollowup(participantId, transcript, result.slots);
          break;
        }

        case 'MY_CALL': {
          await this.handleMyCall(participantId, transcript);
          break;
        }

        case 'PERSON_CHECK_DL': {
          await this.handlePersonCheckDL(participantId, transcript, result.slots);
          break;
        }

        case 'PERSON_CHECK_SSN': {
          await this.handlePersonCheckSSN(participantId, transcript, result.slots);
          break;
        }

        case 'CLEAR_UNIT': {
          await this.handleClearUnit(participantId, transcript);
          break;
        }

        case 'DISPOSE_CALL': {
          await this.handleDisposeCall(participantId, transcript, result.slots);
          break;
        }

        case 'WARRANT_CHECK': {
          await this.handleWarrantCheck(participantId, transcript, result.slots);
          break;
        }

        case 'UPDATE_CALL': {
          await this.handleUpdateCall(participantId, transcript, result.slots);
          break;
        }

        case 'CALL_DETAILS': {
          await this.handleCallDetails(participantId, transcript, result.slots);
          break;
        }

        case 'ANIMAL_SEARCH': {
          await this.handleAnimalSearch(participantId, transcript, result.slots);
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

    this._turnContextByUnit.set(participantId, { transcript, intent: commandResult.intent });

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
      const cadTargetUnit = commandResult.targetUnit || commandResult.unitId;
      try {
        const cadResult = await cadService.updateUnitStatus(cadTargetUnit, finalCadStatus);
        this.log('CAD_STATUS_UPDATE', {
          unitId: cadTargetUnit,
          requestedBy: commandResult.unitId,
          isOtherUnit: !!commandResult.targetUnit,
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
      this.logSpeechEvent(participantId, transcript, commandResult.intent, null);
      this._turnContextByUnit.delete(participantId);
      return;
    }

    if (!await this.shouldRespond()) {
      this.log('TTS_ABORTED', { reason: 'Disabled before TTS' });
      this._turnContextByUnit.delete(participantId);
      return;
    }

    const responseAudio = await textToSpeech(finalResponse);

    if (!await this.shouldRespond()) {
      this.log('PUBLISH_ABORTED', { reason: 'Disabled before publish' });
      this._turnContextByUnit.delete(participantId);
      return;
    }

    this.logSpeechEvent(participantId, transcript, commandResult.intent, finalResponse);
    this._turnContextByUnit.delete(participantId);
    await this.publishAudio(responseAudio, finalResponse);
  }

  async handlePersonCheckDetails(participantId, rawTranscript, llmSlots) {
    this.log('PERSON_CHECK_DETAILS', { participant: participantId, transcript: rawTranscript, llmSlots });
    
    const personDetails = parsePersonDetails(rawTranscript);
    this.log('PERSON_DETAILS_PARSED', personDetails);
    
    if (llmSlots?.lastName) {
      if (!personDetails.lastName) {
        this.log('PERSON_DETAILS_LLM_FALLBACK', { field: 'lastName', llm: llmSlots.lastName });
        personDetails.lastName = llmSlots.lastName;
      } else {
        this.log('PERSON_DETAILS_PARSER_WINS', { field: 'lastName', parser: personDetails.lastName, llm: llmSlots.lastName });
      }
    }
    if (llmSlots?.firstName) {
      if (!personDetails.firstName) {
        this.log('PERSON_DETAILS_LLM_FALLBACK', { field: 'firstName', llm: llmSlots.firstName });
        personDetails.firstName = llmSlots.firstName;
      } else {
        this.log('PERSON_DETAILS_PARSER_WINS', { field: 'firstName', parser: personDetails.firstName, llm: llmSlots.firstName });
      }
    }
    if (llmSlots?.dob) {
      const llmDob = parseDOB(llmSlots.dob);
      if (llmDob) {
        if (!personDetails.dob) {
          personDetails.dob = llmDob;
          this.log('PERSON_DETAILS_LLM_PREFERRED', { field: 'dob', value: llmSlots.dob, parsed: llmDob.formatted });
        }
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
    const SPOKEN_HOURS = [
      'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
      'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
      'eighteen', 'nineteen', 'twenty', 'twenty-one', 'twenty-two', 'twenty-three'
    ];
    const SPOKEN_MINUTES = [
      'hundred', 'oh-one', 'oh-two', 'oh-three', 'oh-four', 'oh-five', 'oh-six', 'oh-seven', 'oh-eight', 'oh-nine',
      'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen',
      'twenty', 'twenty-one', 'twenty-two', 'twenty-three', 'twenty-four', 'twenty-five', 'twenty-six', 'twenty-seven',
      'twenty-eight', 'twenty-nine', 'thirty', 'thirty-one', 'thirty-two', 'thirty-three', 'thirty-four', 'thirty-five',
      'thirty-six', 'thirty-seven', 'thirty-eight', 'thirty-nine', 'forty', 'forty-one', 'forty-two', 'forty-three',
      'forty-four', 'forty-five', 'forty-six', 'forty-seven', 'forty-eight', 'forty-nine', 'fifty', 'fifty-one',
      'fifty-two', 'fifty-three', 'fifty-four', 'fifty-five', 'fifty-six', 'fifty-seven', 'fifty-eight', 'fifty-nine'
    ];
    const options = {
      timeZone: 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    };
    const formatter = new Intl.DateTimeFormat('en-US', options);
    const parts = formatter.formatToParts(new Date());
    const hourNum = parseInt(parts.find(p => p.type === 'hour').value, 10);
    const minuteNum = parseInt(parts.find(p => p.type === 'minute').value, 10);

    const hourWord = SPOKEN_HOURS[hourNum] || 'zero';
    const minuteWord = SPOKEN_MINUTES[minuteNum] || 'hundred';

    if (minuteNum === 0) {
      if (hourNum === 0) {
        return 'zero hundred hours';
      }
      return `${hourWord} hundred hours`;
    }
    return `${hourWord} ${minuteWord} hours`;
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
    
    let zoneUpdateFailed = false;
    let zoneFailureType = null;
    if (!cadService.isConfigured()) {
      zoneUpdateFailed = true;
      zoneFailureType = 'NOT_CONFIGURED';
      this.log('CAD_NOT_CONFIGURED', { participantId, zone });
    } else {
      try {
        const cadResult = await cadService.updateUnitZone(participantId, zone);
        if (!cadResult || !cadResult.success) {
          zoneUpdateFailed = true;
          zoneFailureType = cadResult?.failureType || 'API_REJECTION';
          this.log('CAD_ZONE_UPDATE_FAILED', { participantId, zone, failureType: zoneFailureType, error: cadResult?.error, statusCode: cadResult?.statusCode, responseBody: cadResult?.responseBody });
        }
        this.log('CAD_ZONE_UPDATED', { participantId, zone, success: cadResult?.success });
      } catch (error) {
        zoneUpdateFailed = true;
        zoneFailureType = 'UNREACHABLE';
        this.log('CAD_ZONE_UPDATE_ERROR', { error: error.message, stack: error.stack });
      }
    }
    
    if (zoneUpdateFailed) {
      let failResponse;
      if (zoneFailureType === 'NOT_CONFIGURED') {
        failResponse = `${participantId}, 10-4. CAD is not available, update your status via the MDT.`;
      } else if (zoneFailureType === 'UNREACHABLE') {
        failResponse = `${participantId}, 10-4. Unable to reach CAD, update your status via the MDT.`;
      } else {
        failResponse = `${participantId}, 10-4. CAD update did not go through, try your MDT.`;
      }
      await this.speak(failResponse, participantId);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      return;
    }
    
    const timeStr = this.formatMilitaryTime();
    const confirmResponse = `${participantId}, 10-4. ${timeStr}.`;
    await this.speak(confirmResponse, participantId);
    
    await this.logToCallNotes(participantId, `Zone change: ${zone}`);
    setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
  }

  async handleDetailConfirmPrompt(participantId, location) {
    this.log('DETAIL_CONFIRM_PROMPT', { participant: participantId, location });
    
    let geocodeWarning = null;
    let geocodedCity = null;
    try {
      const geoResult = await locationService.forwardGeocode(location);
      if (geoResult) {
        geocodedCity = geoResult.municipality || geoResult.township || null;
        const addressParts = location.split(',').map(p => p.trim()).filter(Boolean);
        const spokenCity = addressParts.length >= 2
          ? addressParts[1].replace(/\b[A-Z]{2}\b\s*\d{0,5}$/i, '').trim()
          : null;
        if (spokenCity && geocodedCity && spokenCity.toLowerCase() !== geocodedCity.toLowerCase()) {
          geocodeWarning = `Note: that address geocodes to ${geocodedCity}`;
          this.log('GEOCODE_CITY_MISMATCH', { participant: participantId, location, spokenCity, geocodedCity });
        }
      } else {
        geocodeWarning = 'address could not be verified';
        this.log('GEOCODE_NO_RESULT', { participant: participantId, location });
      }
    } catch (geoErr) {
      this.log('GEOCODE_ERROR', { participant: participantId, error: geoErr.message });
    }

    setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_DETAIL_CONFIRM, null, { location, geocodedCity }, true);
    
    let confirmResponse;
    if (geocodeWarning && geocodeWarning.startsWith('Note:')) {
      confirmResponse = `${participantId}, just to confirm, detail at ${location}? ${geocodeWarning}.`;
    } else if (geocodeWarning) {
      confirmResponse = `${participantId}, just to confirm, detail at ${location}? Be advised, ${geocodeWarning}.`;
    } else {
      confirmResponse = `${participantId}, just to confirm, detail at ${location}?`;
    }
    await this.speak(confirmResponse, participantId);
  }

  async handleDetailLocation(participantId, rawTranscript) {
    this.log('DETAIL_LOCATION', { participant: participantId, transcript: rawTranscript });

    if (isMyLocationPhrase(rawTranscript)) {
      const gpsAddress = await this.resolveUnitLocation(participantId);
      if (gpsAddress) {
        this.log('DETAIL_LOCATION_FROM_GPS', { participantId, address: gpsAddress });
        await this.handleDetailConfirmPrompt(participantId, gpsAddress);
        return;
      }
    }
    
    const location = cleanTranscript(rawTranscript);
    
    if (!location || location.length < 2) {
      const response = `${participantId}, did not copy location. Go ahead with location.`;
      await this.speak(response, participantId);
      return;
    }
    
    await this.handleDetailConfirmPrompt(participantId, location);
  }

  async handleDetailConfirm(participantId, rawTranscript, slots, llmCorrectionSlots = null) {
    this.log('DETAIL_CONFIRM', { participant: participantId, transcript: rawTranscript, slots, llmCorrectionSlots });
    
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
      const existingLocation = slots.location || '';
      
      if (llmCorrectionSlots && existingLocation) {
        const { correctedCity, correctedAddress, correctedState } = llmCorrectionSlots;
        if (correctedAddress) {
          const fullCorrection = normalizeAddress(correctedAddress);
          this.log('DETAIL_LLM_CORRECTION', { participantId, existing: existingLocation, correctedAddress: fullCorrection });
          await this.handleDetailConfirmPrompt(participantId, fullCorrection);
          return;
        }
        if (correctedCity) {
          const existParts = existingLocation.split(',').map(p => p.trim()).filter(Boolean);
          const street = existParts[0] || '';
          const cityPart = correctedState ? `${correctedCity}, ${correctedState}` : correctedCity;
          const merged = street ? `${street}, ${cityPart}` : cityPart;
          this.log('DETAIL_LLM_CITY_CORRECTION', { participantId, existing: existingLocation, correctedCity, merged });
          await this.handleDetailConfirmPrompt(participantId, merged);
          return;
        }
      }

      const correctionText = this.extractPartialCorrection(normalized);
      
      if (correctionText && existingLocation) {
        const mergedLocation = this.mergeAddressCorrection(existingLocation, correctionText);
        this.log('DETAIL_PARTIAL_CORRECTION', { participantId, existing: existingLocation, correction: correctionText, merged: mergedLocation });
        await this.handleDetailConfirmPrompt(participantId, mergedLocation);
        return;
      }
      
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
    
    let detailUpdateFailed = false;
    let detailFailureType = null;
    if (!cadService.isConfigured()) {
      detailUpdateFailed = true;
      detailFailureType = 'NOT_CONFIGURED';
      this.log('CAD_NOT_CONFIGURED', { participantId, location });
    } else {
      try {
        const statusResult = await cadService.updateUnitStatus(participantId, 'detail');
        if (!statusResult || !statusResult.success) {
          detailUpdateFailed = true;
          detailFailureType = statusResult?.failureType || 'API_REJECTION';
          this.log('CAD_DETAIL_STATUS_FAILED', { participantId, status: 'detail', failureType: detailFailureType, error: statusResult?.error, statusCode: statusResult?.statusCode, responseBody: statusResult?.responseBody });
        } else {
          this.log('CAD_DETAIL_STATUS_UPDATED', { participantId, status: 'detail' });
          const zoneResult = await cadService.updateUnitZone(participantId, location);
          if (!zoneResult || !zoneResult.success) {
            detailUpdateFailed = true;
            detailFailureType = zoneResult?.failureType || 'API_REJECTION';
            this.log('CAD_DETAIL_ZONE_FAILED', { participantId, location, failureType: detailFailureType, error: zoneResult?.error, statusCode: zoneResult?.statusCode, responseBody: zoneResult?.responseBody });
          } else {
            this.log('CAD_DETAIL_ZONE_UPDATED', { participantId, location });
          }
        }
      } catch (error) {
        detailUpdateFailed = true;
        detailFailureType = 'UNREACHABLE';
        this.log('CAD_DETAIL_UPDATE_ERROR', { error: error.message, stack: error.stack });
      }
    }
    
    if (detailUpdateFailed) {
      let failResponse;
      if (detailFailureType === 'NOT_CONFIGURED') {
        failResponse = `${participantId}, 10-4. CAD is not available, update your status via the MDT.`;
      } else if (detailFailureType === 'UNREACHABLE') {
        failResponse = `${participantId}, 10-4. Unable to reach CAD, update your status via the MDT.`;
      } else {
        failResponse = `${participantId}, 10-4. CAD update did not go through, try your MDT.`;
      }
      await this.speak(failResponse, participantId);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      return;
    }
    
    const timeStr = this.formatMilitaryTime();
    const confirmResponse = `${participantId}, 10-4. ${timeStr}.`;
    await this.speak(confirmResponse, participantId);
    
    await this.logToCallNotes(participantId, `Detail at: ${location}`);
    setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
  }

  extractPartialCorrection(denialText) {
    const denyPrefixes = [
      'negative', 'neg', 'no', 'nope', 'incorrect', 'wrong',
      'not correct', 'that is wrong', "that's wrong", 'thats wrong',
      'repeat', 'say again', 'try again'
    ];
    let remaining = denialText.trim();
    for (const prefix of denyPrefixes) {
      if (remaining.startsWith(prefix)) {
        remaining = remaining.slice(prefix.length);
        break;
      }
    }
    remaining = remaining.replace(/^[,.\s]+/, '').trim();
    remaining = remaining.replace(/^(it'?s\s+going\s+to\s+be|it'?s\s+at|it'?s|that'?s|it\s+should\s+be|should\s+be|make\s+it|make\s+that)\s+/i, '').trim();
    if (remaining.length < 2) return null;
    return remaining;
  }

  mergeAddressCorrection(existingAddress, correction) {
    const correctionNorm = normalizeAddress(correction);
    const corrParts = correctionNorm.split(',').map(p => p.trim()).filter(Boolean);
    const existParts = existingAddress.split(',').map(p => p.trim()).filter(Boolean);
    
    const stateAbbrevPattern = /\b[A-Z]{2}$/;
    const hasStreetNumber = /^\d+\s+/.test(corrParts[0]);
    
    if (hasStreetNumber) {
      return correctionNorm;
    }
    
    if (corrParts.length === 1 && existParts.length >= 2) {
      const corrToken = corrParts[0];
      const corrHasState = stateAbbrevPattern.test(corrToken);
      if (corrHasState) {
        const cityState = corrToken;
        existParts[1] = cityState;
        return existParts.slice(0, 2).join(', ');
      }
      existParts[1] = corrToken;
      if (existParts.length > 2) {
        return existParts.join(', ');
      }
      return existParts.join(', ');
    }
    
    if (corrParts.length >= 2 && existParts.length >= 1 && !hasStreetNumber) {
      existParts.splice(1, existParts.length - 1, ...corrParts);
      return existParts.join(', ');
    }
    
    return correctionNorm;
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

    let address = savedSlots?.address;
    if (!address) {
      const resolvedAddress = await this.resolveUnitLocation(participantId);
      if (resolvedAddress) {
        address = resolvedAddress;
        this.log('CALL_NATURE_ADDRESS_AUTO_RESOLVED', { participantId, address: resolvedAddress });
      }
    }

    if (address) {
      setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_CALL_CONFIRM, null, {
        nature: matchedNature,
        address,
        additionalUnits: savedSlots?.additionalUnits || [],
        priority: savedSlots?.priority || 'medium',
        arrivalStatus: savedSlots?.arrivalStatus || 'on_scene'
      }, true);
      const confirmResp = `${participantId}, confirm, ${matchedNature.toLowerCase()} at ${address}?`;
      await this.speak(confirmResp, participantId);
    } else {
      setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_CALL_ADDRESS, null, {
        nature: matchedNature,
        additionalUnits: savedSlots?.additionalUnits || [],
        priority: savedSlots?.priority || 'medium',
        arrivalStatus: savedSlots?.arrivalStatus || 'on_scene'
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

    let address = null;
    const isSelfRef = isMyLocationPhrase(transcript);
    if (isSelfRef) {
      const resolvedAddress = await this.resolveUnitLocation(participantId);
      if (resolvedAddress) {
        address = resolvedAddress;
        this.log('CALL_ADDRESS_FROM_LOCATION', { participantId, address: resolvedAddress });
      }
    }
    if (!address && !isSelfRef) {
      address = normalizeAddress(cleanTranscript(transcript));
    }
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
      priority: savedSlots?.priority || 'medium',
      arrivalStatus: savedSlots?.arrivalStatus || 'on_scene'
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
    const { nature, address, additionalUnits, priority, arrivalStatus } = slots;
    const unitStatus = arrivalStatus || 'on_scene';
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

      const cleanedAddress = normalizeAddress(address) || address;
      const units = [participantId];
      if (additionalUnits && additionalUnits.length > 0) {
        for (const unitId of additionalUnits) {
          if (!units.includes(unitId)) {
            units.push(unitId);
          }
        }
      }

      const outgoingPayload = { nature, priority: priority || 'medium', address: cleanedAddress, municipality: '', notes: `Created by AI Dispatcher for ${participantId}`, units };
      this.log('CAD_CALL_REQUEST', { participantId, payload: outgoingPayload });

      const callResult = await cadService.createCall(nature, priority || 'medium', cleanedAddress, '', `Created by AI Dispatcher for ${participantId}`, units);
      this.log('CAD_CALL_RESULT', {
        success: callResult.success,
        callId: callResult.call_id,
        error: callResult.error,
        failureType: callResult.failureType,
        statusCode: callResult.statusCode,
        responseBody: callResult.responseBody
      });

      if (!callResult.success) {
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
        const reason = callResult.failureType === 'INVALID_INPUT'
          ? callResult.error
          : callResult.failureType === 'NOT_CONFIGURED'
          ? 'CAD system is not configured'
          : callResult.failureType === 'UNREACHABLE'
          ? 'CAD system is unreachable'
          : callResult.error || 'unknown error';
        const resp = `${participantId}, unable to create call. ${reason}.`;
        await this.speak(resp, participantId);
        return;
      }

      const callId = callResult.call_id;
      const callNumber = callResult.call_number || callId;

      if (additionalUnits && additionalUnits.length > 0 && units.length <= 1) {
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
        await cadService.updateUnitStatus(participantId, unitStatus);
        this.log('CAD_STATUS_UPDATED', { unitId: participantId, status: unitStatus });
      } catch (statusError) {
        this.log('CAD_STATUS_UPDATE_ERROR', { unitId: participantId, error: statusError.message });
      }

      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      const timeStr = this.formatMilitaryTime();
      const callRef = callNumber ? `, call number ${callNumber}` : '';
      const resp = `${participantId}, 10-4. Call created${callRef}, ${nature.toLowerCase()} at ${address}. ${timeStr}.`;
      await this.speak(resp, participantId);

    } catch (error) {
      this.log('CALL_CREATION_ERROR', { error: error.message, stack: error.stack, nature, address, priority });
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      const resp = `${participantId}, unable to create call. System error, please try again.`;
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
      let cadResult = await cadService.queryPerson(firstName, lastName, dob);
      this.log('CAD_PERSON_QUERY_RESULT', { participantId, result: cadResult });

      let broadened = false;
      let broadenedDescription = '';

      if (cadResult.success && this._personResultCount(cadResult) === 0 && (firstName || dob)) {
        if (dob) {
          this.log('PERSON_CHECK_BROADENING', { step: 'lastName+dob', lastName, dob });
          const retry1 = await cadService.queryPerson('', lastName, dob);
          if (retry1.success && this._personResultCount(retry1) > 0) {
            cadResult = retry1;
            broadened = true;
            broadenedDescription = `No exact match for ${firstName} ${lastName}, but I have`;
          }
        }
        if (this._personResultCount(cadResult) === 0) {
          this.log('PERSON_CHECK_BROADENING', { step: 'lastNameOnly', lastName });
          const retry2 = await cadService.queryPerson('', lastName);
          if (retry2.success && this._personResultCount(retry2) > 0) {
            cadResult = retry2;
            broadened = true;
            broadenedDescription = `No exact match for ${firstName} ${lastName}, but I have`;
          }
        }
      }
      
      if (!cadResult.success) {
        const errorResponse = `${participantId}, Central. Unable to complete records check. Try again.`;
        await this.speak(errorResponse, participantId);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
        return;
      }

      const results = cadResult.results || [];
      const person = results.length > 0 ? results[0] 
                   : (cadResult.person || cadResult.record || cadResult.data || null);
      const hasRecord = !!(cadResult.count > 0) || 
                        !!(results.length > 0) ||
                        !!(cadResult.found) ||
                        !!(person && Object.keys(person).length > 0);
      const hasFlags = person && (person.wanted || person.warrant || person.bolo || 
                       (person.warrants && person.warrants.length > 0) ||
                       (person.flags && person.flags.length > 0));
      
      this.log('PERSON_CHECK_ANALYSIS', { hasRecord, hasFlags, broadened, personKeys: person ? Object.keys(person) : [] });
      
      const lastSearchResult = { lastName, firstName, dob, status: hasFlags ? 'flagged' : hasRecord ? 'local file' : 'no record' };

      if (broadened && results.length > 1) {
        const nameList = results.map(r => {
          const fn = r.first_name || r.firstName || '';
          const ln = r.last_name || r.lastName || '';
          const rdob = r.dob || r.date_of_birth || '';
          return rdob ? `${fn} ${ln}, DOB ${rdob}` : `${fn} ${ln}`;
        }).join('; ');
        const resp = `${participantId}, Central. ${broadenedDescription} ${results.length} results under last name ${lastName}. ${nameList}. Advise which subject.`;
        await this.speak(resp, participantId);
        await this.logToCallNotes(participantId, `Records check: ${lastName}, ${firstName}, DOB ${dob} - Broadened search, ${results.length} results`);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, { lastSearchResult }, true);
      } else if (hasFlags) {
        setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_SECURE_CONFIRM, null, {
          lastName,
          firstName,
          dob,
          personData: person,
          broadened,
          lastSearchResult
        }, true);
        
        if (broadened) {
          const fn = person.first_name || person.firstName || '';
          const ln = person.last_name || person.lastName || lastName;
          const broadenedNote = `${participantId}, Central. No exact match for ${firstName} ${lastName}, but I have a result for ${fn} ${ln}. Is your mic secure?`;
          await this.speak(broadenedNote, participantId);
        } else {
          const securePrompt = `${participantId}, Central. Is your mic secure?`;
          await this.speak(securePrompt, participantId);
        }
      } else if (hasRecord) {
        const clearResponse = broadened
          ? `${participantId}, Central. ${broadenedDescription} 1 result under last name ${lastName}. Local file, no wants or warrants.`
          : `${participantId}, Central. Local file, no wants or warrants.`;
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

  _personResultCount(cadResult) {
    if (cadResult.count !== undefined) return cadResult.count;
    if (cadResult.results) return cadResult.results.length;
    if (cadResult.found) return 1;
    if (cadResult.person || cadResult.record || cadResult.data) return 1;
    return 0;
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

  resolveShorthandCallNumber(shorthand, activeCalls) {
    if (!shorthand || !activeCalls || activeCalls.length === 0) return null;
    const num = shorthand.replace(/[^0-9]/g, '');
    if (!num) return null;
    for (const call of activeCalls) {
      const callNum = call.call_number || call.callNumber || call.id?.toString() || '';
      if (callNum.endsWith(num) || callNum === num) {
        return call;
      }
    }
    return null;
  }

  findCallByDescription(activeCalls, location, nature) {
    if (!activeCalls || activeCalls.length === 0) return null;
    const loc = location?.toLowerCase();
    const nat = nature?.toLowerCase();
    for (const call of activeCalls) {
      const callLoc = (call.location || call.address || '').toLowerCase();
      const callNat = (call.nature || call.type || call.call_type || '').toLowerCase();
      if (loc && callLoc.includes(loc)) return call;
      if (nat && callNat.includes(nat)) return call;
    }
    return null;
  }

  async handleAssignCall(participantId, transcript, slots) {
    this.log('ASSIGN_CALL', { participant: participantId, transcript, slots });

    if (!cadService.isConfigured()) {
      const resp = `${participantId}, CAD system not available.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      return;
    }

    try {
      const callsResult = await cadService.getActiveCalls();
      const activeCalls = callsResult.calls || callsResult.results || [];

      let targetCall = null;
      if (slots?.callNumber) {
        targetCall = this.resolveShorthandCallNumber(slots.callNumber, activeCalls);
      }
      if (!targetCall && (slots?.callLocation || slots?.callNature)) {
        targetCall = this.findCallByDescription(activeCalls, slots.callLocation, slots.callNature);
      }

      if (!targetCall) {
        const resp = `${participantId}, unable to locate that call.`;
        await this.speak(resp, participantId);
        this.addConversationExchange(participantId, transcript, resp);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
        return;
      }

      const callId = targetCall.call_id || targetCall.id || targetCall.call_number;
      const callDisplay = targetCall.call_number || callId;
      const assignResult = await cadService.assignUnitToCall(participantId, callId);
      if (assignResult?.success === false) {
        const resp = `${participantId}, unable to assign to that call.`;
        await this.speak(resp, participantId);
        this.addConversationExchange(participantId, transcript, resp);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
        return;
      }
      this.log('UNIT_ASSIGNED_TO_CALL', { unitId: participantId, callId, callDisplay });

      const resp = `${participantId}, 10-4. Showing you on ${callDisplay}.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
    } catch (error) {
      this.log('ASSIGN_CALL_ERROR', { error: error.message });
      const resp = `${participantId}, unable to assign to call. System error.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
    }
  }

  async handleGeneralInquiry(participantId, transcript, result) {
    const dataNeeded = result.dataNeeded || 'none';
    const originalQuestion = result.originalQuestion || transcript;

    this.log('GENERAL_INQUIRY', { participant: participantId, transcript, dataNeeded, originalQuestion });

    if (dataNeeded === 'none') {
      const resp = result.response || `${participantId}, I don't have that information.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      return;
    }

    let dataContext = null;
    let fetchFailed = false;

    try {
      if (dataNeeded === 'active_calls') {
        if (!cadService.isConfigured()) {
          fetchFailed = true;
        } else {
          const callsResult = await cadService.getActiveCalls();
          const calls = callsResult.calls || callsResult.results || [];
          if (calls.length === 0) {
            dataContext = 'No active calls on the board.';
          } else {
            const questionLower = (originalQuestion || '').toLowerCase();
            const askingPending = /\bpending\b|\bholding\b|\bunassigned\b|\bcalls\s+waiting\b/.test(questionLower);

            const callSummaries = calls.map((c, i) => {
              const num = c.call_number || c.id || (i + 1);
              const nature = c.type || c.nature || 'Unknown';
              const location = c.location || 'Unknown location';
              const priority = c.priority || '';
              const status = c.status || '';
              const units = c.units || c.assigned_units || [];
              const unitCount = Array.isArray(units) ? units.length : 0;
              const unitStr = unitCount > 0 ? units.join(', ') : 'none';
              const assignmentLabel = isCallPending(c) ? 'PENDING (no units assigned)' : `${unitCount} unit(s) assigned`;
              return `Call ${num}: ${nature} at ${location}, priority ${priority}, status ${status}, units: ${unitStr} — ${assignmentLabel}`;
            });

            const pendingCount = calls.filter(isCallPending).length;

            if (askingPending) {
              const pendingCalls = calls.filter(isCallPending);
              if (pendingCalls.length === 0) {
                dataContext = 'No pending calls — all active calls have units assigned.';
              } else {
                const pendingSummaries = pendingCalls.map((c, i) => {
                  const num = c.call_number || c.id || (i + 1);
                  const nature = c.type || c.nature || 'Unknown';
                  const location = c.location || 'Unknown location';
                  const priority = c.priority || '';
                  return `Call ${num}: ${nature} at ${location}, priority ${priority} — PENDING (no units assigned)`;
                });
                dataContext = `${pendingCalls.length} of ${calls.length} active call(s) are pending (no units assigned):\n${pendingSummaries.join('\n')}`;
              }
            } else {
              dataContext = `${calls.length} active call(s) (${pendingCount} pending with no units assigned):\n${callSummaries.join('\n')}`;
            }
          }
        }
      } else if (dataNeeded.startsWith('unit_call:')) {
        const targetUnitId = dataNeeded.substring('unit_call:'.length).trim();
        if (!cadService.isConfigured()) {
          fetchFailed = true;
        } else {
          const callData = await cadService.getUnitCurrentCallById(targetUnitId);
          if (callData && (callData.call_number || callData.callNumber || callData.call_id)) {
            const callNum = callData.call_number || callData.callNumber || callData.call_id;
            const nature = callData.type || callData.nature || '';
            const location = callData.location || '';
            dataContext = `${targetUnitId} is currently on call ${callNum}${nature ? ', ' + nature : ''}${location ? ' at ' + location : ''}.`;
          } else {
            dataContext = `${targetUnitId} does not appear to be assigned to any call.`;
          }
        }
      } else if (dataNeeded === 'unit_list') {
        try {
          if (cadService.isConfigured()) {
            const statusResult = await cadService.getStatusCheck();
            if (statusResult.success && Array.isArray(statusResult.units)) {
              const units = statusResult.units;
              if (units.length === 0) {
                dataContext = 'No units currently online.';
              } else {
                const unitSummaries = units.map(u => `${u.unit_id}: ${u.status || 'unknown'}${u.zone ? ', zone ' + u.zone : ''}`);
                dataContext = `${units.length} unit(s) online:\n${unitSummaries.join('\n')}`;
              }
            } else {
              fetchFailed = true;
            }
          } else {
            const dbResult = await pool.query(
              `SELECT unit_identity, status FROM units WHERE last_seen > NOW() - INTERVAL '10 minutes' ORDER BY unit_identity`
            );
            if (dbResult.rows.length === 0) {
              dataContext = 'No units currently online.';
            } else {
              const unitSummaries = dbResult.rows.map(u => `${u.unit_identity}: ${u.status || 'unknown'}`);
              dataContext = `${dbResult.rows.length} unit(s) online:\n${unitSummaries.join('\n')}`;
            }
          }
        } catch (dbErr) {
          console.error('[GENERAL_INQUIRY] unit_list query error:', dbErr.message);
          fetchFailed = true;
        }
      } else if (dataNeeded.startsWith('geocode:')) {
        const address = dataNeeded.substring('geocode:'.length).trim();
        if (!address) {
          fetchFailed = true;
        } else {
          const geoResult = await locationService.forwardGeocode(address);
          if (geoResult) {
            const parts = [];
            if (geoResult.displayName) parts.push(geoResult.displayName);
            if (geoResult.township) parts.push(`Township: ${geoResult.township}`);
            if (geoResult.municipality) parts.push(`Municipality: ${geoResult.municipality}`);
            if (geoResult.county) parts.push(`County: ${geoResult.county}`);
            if (geoResult.state) parts.push(`State: ${geoResult.state}`);
            dataContext = parts.length > 0 ? parts.join('\n') : 'Address found but no township/municipality data available.';
          } else {
            dataContext = 'Geocoding lookup returned no results for that address.';
          }
        }
      } else if (dataNeeded.startsWith('web_search:')) {
        const searchQuery = dataNeeded.substring('web_search:'.length).trim();
        if (!searchQuery) {
          fetchFailed = true;
        } else {
          const searchResult = await webSearch(searchQuery);
          if (searchResult.status === SEARCH_STATUS.OK && searchResult.text) {
            dataContext = searchResult.text;
          } else if (searchResult.status === SEARCH_STATUS.ERROR) {
            fetchFailed = true;
          } else {
            const resp = `${participantId}, I wasn't able to find that information.`;
            await this.speak(resp, participantId);
            this.addConversationExchange(participantId, transcript, resp);
            setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
            return;
          }
        }
      } else {
        const resp = `${participantId}, I don't have that information.`;
        await this.speak(resp, participantId);
        this.addConversationExchange(participantId, transcript, resp);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
        return;
      }
    } catch (error) {
      console.error('[GENERAL_INQUIRY] Data fetch error:', error.message);
      fetchFailed = true;
    }

    if (fetchFailed || !dataContext) {
      const resp = `${participantId}, I don't have that information right now.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      return;
    }

    try {
      const answer = await answerWithData(originalQuestion, participantId, dataContext);
      if (answer) {
        const resp = `${participantId}, ${answer}`;
        await this.speak(resp, participantId);
        this.addConversationExchange(participantId, transcript, resp);
      } else {
        const resp = `${participantId}, I don't have that information right now.`;
        await this.speak(resp, participantId);
        this.addConversationExchange(participantId, transcript, resp);
      }
    } catch (llmError) {
      console.error('[GENERAL_INQUIRY] Second LLM call error:', llmError.message);
      const resp = `${participantId}, I don't have that information right now.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
    }

    setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
  }

  async handleAssignOtherUnit(participantId, transcript, slots) {
    this.log('ASSIGN_OTHER_UNIT', { participant: participantId, transcript, slots });

    if (!cadService.isConfigured()) {
      const resp = `${participantId}, CAD system not available.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      return;
    }

    const targetUnit = slots?.targetUnit;
    if (!targetUnit) {
      const resp = `${participantId}, did not copy unit to assign.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      return;
    }

    try {
      let targetCall = null;
      let callId = null;

      if (slots?.useMyCall) {
        const myCall = await cadService.getUnitCurrentCallById(participantId);
        if (myCall && (myCall.call_id || myCall.callNumber || myCall.call_number)) {
          callId = myCall.call_id || myCall.call_number || myCall.callNumber;
          targetCall = myCall;
        }
      }

      if (!callId) {
        const callsResult = await cadService.getActiveCalls();
        const activeCalls = callsResult.calls || callsResult.results || [];

        if (slots?.callNumber) {
          targetCall = this.resolveShorthandCallNumber(slots.callNumber, activeCalls);
        }
        if (!targetCall && (slots?.callLocation || slots?.callNature)) {
          targetCall = this.findCallByDescription(activeCalls, slots.callLocation, slots.callNature);
        }

        if (targetCall) {
          callId = targetCall.call_id || targetCall.id || targetCall.call_number;
        }
      }

      if (!callId) {
        const resp = `${participantId}, unable to locate that call.`;
        await this.speak(resp, participantId);
        this.addConversationExchange(participantId, transcript, resp);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
        return;
      }

      const callDisplay = targetCall?.call_number || callId;
      const assignResult = await cadService.assignUnitToCall(targetUnit, callId);
      if (assignResult?.success === false) {
        const resp = `${participantId}, unable to assign ${targetUnit} to that call.`;
        await this.speak(resp, participantId);
        this.addConversationExchange(participantId, transcript, resp);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
        return;
      }
      this.log('OTHER_UNIT_ASSIGNED_TO_CALL', { unitId: targetUnit, callId, callDisplay, requestedBy: participantId });

      const resp = `${participantId}, 10-4. ${targetUnit} added to ${callDisplay}.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
    } catch (error) {
      this.log('ASSIGN_OTHER_UNIT_ERROR', { error: error.message });
      const resp = `${participantId}, unable to assign unit. System error.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
    }
  }

  async handleAddNote(participantId, transcript, slots) {
    this.log('ADD_NOTE', { participant: participantId, transcript, slots });

    const noteContent = slots?.noteContent;
    if (noteContent && noteContent.trim().length > 2) {
      await this.executeAddNote(participantId, transcript, noteContent.trim());
    } else {
      setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_NOTE_CONTENT, null, {}, true);
      const resp = `${participantId}, go ahead with your note.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
    }
  }

  async handleNoteContentInput(participantId, transcript, savedSlots) {
    this.log('NOTE_CONTENT_INPUT', { participant: participantId, transcript });

    const normalized = transcript.toLowerCase().trim();
    const disregardPhrases = ['disregard', 'cancel', 'cancel that', 'nevermind', 'never mind', '10-22', 'scratch that'];
    if (disregardPhrases.some(p => normalized.includes(p))) {
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      const resp = `${participantId}, 10-4, disregard.`;
      await this.speak(resp, participantId);
      return;
    }

    const noteContent = transcript.trim();
    if (!noteContent || noteContent.length < 2) {
      const resp = `${participantId}, did not copy note. Go ahead.`;
      await this.speak(resp, participantId);
      return;
    }

    await this.executeAddNote(participantId, transcript, noteContent);
  }

  async executeAddNote(participantId, transcript, noteContent) {
    try {
      if (!cadService.isConfigured()) {
        const resp = `${participantId}, CAD system not available.`;
        await this.speak(resp, participantId);
        this.addConversationExchange(participantId, transcript, resp);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
        return;
      }

      const currentCall = await cadService.getUnitCurrentCallById(participantId);
      const callId = currentCall?.call_id || currentCall?.call_number || currentCall?.callNumber;

      if (!callId) {
        const resp = `${participantId}, you don't have an active call to add a note to.`;
        await this.speak(resp, participantId);
        this.addConversationExchange(participantId, transcript, resp);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
        return;
      }

      const noteResult = await cadService.addCallNote(callId, `${participantId}: ${noteContent}`);
      if (noteResult?.success === false) {
        const resp = `${participantId}, unable to add note. Try again.`;
        await this.speak(resp, participantId);
        this.addConversationExchange(participantId, transcript, resp);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
        return;
      }
      this.log('CALL_NOTE_ADDED_VOICE', { unitId: participantId, callId });

      const resp = `${participantId}, 10-4. Note added.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
    } catch (error) {
      this.log('ADD_NOTE_ERROR', { error: error.message });
      const resp = `${participantId}, unable to add note. System error.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
    }
  }

  async handleQueryCalls(participantId, transcript) {
    this.log('QUERY_CALLS', { participant: participantId, transcript });

    if (!cadService.isConfigured()) {
      const resp = `${participantId}, CAD system not available.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      return;
    }

    try {
      const callsResult = await cadService.getActiveCalls();
      const allCalls = callsResult.calls || callsResult.results || [];
      const pendingCalls = allCalls.filter(isCallPending);
      const count = pendingCalls.length;

      let resp;
      if (count === 0) {
        resp = `${participantId}, no calls holding.`;
        await this.speak(resp, participantId);
        this.addConversationExchange(participantId, transcript, resp);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      } else {
        resp = `${participantId}, ${count} call${count === 1 ? '' : 's'} pending.`;
        await this.speak(resp, participantId);
        this.addConversationExchange(participantId, transcript, resp);
        setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_CALL_FOLLOWUP, null, {
          pendingCalls
        }, true);
      }
    } catch (error) {
      this.log('QUERY_CALLS_ERROR', { error: error.message });
      const resp = `${participantId}, unable to check calls. System error.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
    }
  }

  async handleCallFollowup(participantId, transcript, slots) {
    this.log('CALL_FOLLOWUP', { participant: participantId, transcript, slots });

    const sessionState = getUnitSessionState(participantId);
    const pendingCalls = sessionState?.slots?.pendingCalls || [];

    if (pendingCalls.length === 0) {
      const resp = `${participantId}, no calls to reference.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      return;
    }

    const question = (slots?.question || transcript).toLowerCase();

    let targetCall = null;
    if (question.includes('first') || question.includes('oldest') || question.includes('next')) {
      targetCall = pendingCalls[0];
    } else if (question.includes('priority') || question.includes('highest') || question.includes('urgent')) {
      const priorityOrder = { emergency: 0, high: 1, medium: 2, low: 3, routine: 4 };
      targetCall = [...pendingCalls].sort((a, b) => {
        const pa = priorityOrder[(a.priority || 'medium').toLowerCase()] ?? 3;
        const pb = priorityOrder[(b.priority || 'medium').toLowerCase()] ?? 3;
        return pa - pb;
      })[0];
    } else if (question.includes('last') || question.includes('newest') || question.includes('latest')) {
      targetCall = pendingCalls[pendingCalls.length - 1];
    } else {
      targetCall = pendingCalls[0];
    }

    if (targetCall) {
      const nature = targetCall.nature || targetCall.type || targetCall.call_type || 'Unknown';
      const location = targetCall.location || targetCall.address || 'Unknown location';
      const priority = targetCall.priority || 'routine';
      const callNum = targetCall.call_number || targetCall.callNumber || targetCall.id || '';
      const resp = `${participantId}, ${callNum ? callNum + ', ' : ''}${nature.toLowerCase()} at ${location}, priority ${priority}.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
    } else {
      const resp = `${participantId}, no matching call found.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
    }
  }

  async handleMyCall(participantId, transcript) {
    this.log('MY_CALL', { participant: participantId, transcript });

    if (!cadService.isConfigured()) {
      const resp = `${participantId}, CAD system not available.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      return;
    }

    try {
      const currentCall = await cadService.getUnitCurrentCallById(participantId);
      const callNumber = currentCall?.call_number || currentCall?.callNumber;

      if (!callNumber) {
        const resp = `${participantId}, you're not currently assigned to a call.`;
        await this.speak(resp, participantId);
        this.addConversationExchange(participantId, transcript, resp);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
        return;
      }

      const nature = currentCall.nature || currentCall.type || currentCall.call_type || '';
      const location = currentCall.location || currentCall.address || '';
      let resp = `${participantId}, you're on ${callNumber}`;
      if (nature) resp += `, ${nature.toLowerCase()}`;
      if (location) resp += ` at ${location}`;
      resp += '.';
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
    } catch (error) {
      this.log('MY_CALL_ERROR', { error: error.message });
      const resp = `${participantId}, unable to check assignment. System error.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
    }
  }

  async handlePersonCheckDL(participantId, transcript, slots) {
    this.log('PERSON_CHECK_DL', { participant: participantId, transcript, slots });

    const dlNumber = slots?.dlNumber;
    const dlState = slots?.dlState;

    if (dlNumber && dlState) {
      await this.executePersonCheckDL(participantId, transcript, dlNumber, dlState);
    } else if (dlNumber && !dlState) {
      setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_DL_STATE, null, { dlNumber }, true);
      const resp = `${participantId}, go ahead with the state.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
    } else if (!dlNumber && dlState) {
      setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_DL_NUMBER, null, { dlState }, true);
      const resp = `${participantId}, go ahead with the license number.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
    } else {
      setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_DL_NUMBER, null, {}, true);
      const resp = slots?.response || `${participantId}, go ahead with the license number and state.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
    }
  }

  async handleDLStateInput(participantId, transcript, savedSlots) {
    this.log('DL_STATE_INPUT', { participant: participantId, transcript, savedSlots });
    const normalized = transcript.toLowerCase().trim();
    const disregardPhrases = ['disregard', 'cancel', 'nevermind', 'never mind'];
    if (disregardPhrases.some(p => normalized.includes(p))) {
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      const resp = `${participantId}, 10-4, disregard.`;
      await this.speak(resp, participantId);
      return;
    }
    const dlState = transcript.trim().toUpperCase().replace(/[^A-Z]/g, '').substring(0, 2);
    if (dlState.length < 2) {
      const resp = `${participantId}, did not copy state. Go ahead with state abbreviation.`;
      await this.speak(resp, participantId);
      return;
    }
    await this.executePersonCheckDL(participantId, transcript, savedSlots.dlNumber, dlState);
  }

  async handleDLNumberInput(participantId, transcript, savedSlots) {
    this.log('DL_NUMBER_INPUT', { participant: participantId, transcript, savedSlots });
    const normalized = transcript.toLowerCase().trim();
    const disregardPhrases = ['disregard', 'cancel', 'nevermind', 'never mind'];
    if (disregardPhrases.some(p => normalized.includes(p))) {
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      const resp = `${participantId}, 10-4, disregard.`;
      await this.speak(resp, participantId);
      return;
    }
    const dlNumber = transcript.trim().replace(/\s+/g, '').toUpperCase();
    if (!dlNumber || dlNumber.length < 3) {
      const resp = `${participantId}, did not copy license number. Go ahead.`;
      await this.speak(resp, participantId);
      return;
    }
    if (savedSlots?.dlState) {
      await this.executePersonCheckDL(participantId, transcript, dlNumber, savedSlots.dlState);
    } else {
      setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_DL_STATE, null, { dlNumber }, true);
      const resp = `${participantId}, go ahead with the state.`;
      await this.speak(resp, participantId);
    }
  }

  async executePersonCheckDL(participantId, transcript, dlNumber, dlState) {
    this.log('EXECUTE_PERSON_CHECK_DL', { participantId, dlNumber, dlState });

    const standbyResp = `${participantId}, 10-4. Standby.`;
    await this.speak(standbyResp, participantId);

    try {
      if (!cadService.isConfigured()) {
        const resp = `${participantId}, CAD system not available.`;
        await this.speak(resp, participantId);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
        return;
      }

      const cadResult = await cadService.queryPersonByDL(dlNumber, dlState);
      this.log('CAD_DL_QUERY_RESULT', { participantId, success: cadResult.success, count: cadResult.count ?? (cadResult.results?.length ?? 0) });

      if (!cadResult.success) {
        const resp = `${participantId}, Central. Unable to complete license check.`;
        await this.speak(resp, participantId);
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

      if (hasFlags) {
        setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_SECURE_CONFIRM, null, {
          lastName: person.last_name || person.lastName || '',
          firstName: person.first_name || person.firstName || '',
          dob: person.dob || '',
          personData: person,
          lastSearchResult: { dlNumber, dlState, status: 'flagged' }
        }, true);
        const resp = `${participantId}, Central. Is your mic secure?`;
        await this.speak(resp, participantId);
      } else if (hasRecord) {
        const name = `${person.last_name || person.lastName || ''}, ${person.first_name || person.firstName || ''}`.trim();
        const resp = `${participantId}, Central. License returns to ${name || 'subject on file'}. No wants or warrants.`;
        await this.speak(resp, participantId);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      } else {
        const resp = `${participantId}, Central. No return on that license.`;
        await this.speak(resp, participantId);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      }
    } catch (error) {
      this.log('PERSON_CHECK_DL_ERROR', { error: error.message });
      const resp = `${participantId}, Central. System error on license check.`;
      await this.speak(resp, participantId);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
    }
  }

  async handlePersonCheckSSN(participantId, transcript, slots) {
    this.log('PERSON_CHECK_SSN', { participant: participantId, transcript, slots });

    const ssn = slots?.ssn;
    if (ssn && ssn.replace(/[^0-9]/g, '').length >= 9) {
      await this.executePersonCheckSSN(participantId, transcript, ssn);
    } else {
      setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_SSN, null, {}, true);
      const resp = slots?.response || `${participantId}, go ahead with the social.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
    }
  }

  async handleSSNInput(participantId, transcript, savedSlots) {
    this.log('SSN_INPUT', { participant: participantId, transcript });
    const normalized = transcript.toLowerCase().trim();
    const disregardPhrases = ['disregard', 'cancel', 'nevermind', 'never mind'];
    if (disregardPhrases.some(p => normalized.includes(p))) {
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      const resp = `${participantId}, 10-4, disregard.`;
      await this.speak(resp, participantId);
      return;
    }
    const digits = transcript.replace(/[^0-9]/g, '');
    if (digits.length < 9) {
      const resp = `${participantId}, did not copy full social. Go ahead with all nine digits.`;
      await this.speak(resp, participantId);
      return;
    }
    await this.executePersonCheckSSN(participantId, transcript, digits.substring(0, 9));
  }

  async executePersonCheckSSN(participantId, transcript, ssn) {
    this.log('EXECUTE_PERSON_CHECK_SSN', { participantId });

    const standbyResp = `${participantId}, 10-4. Standby.`;
    await this.speak(standbyResp, participantId);

    try {
      if (!cadService.isConfigured()) {
        const resp = `${participantId}, CAD system not available.`;
        await this.speak(resp, participantId);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
        return;
      }

      const cadResult = await cadService.queryPersonBySSN(ssn);
      this.log('CAD_SSN_QUERY_RESULT', { participantId, success: cadResult.success, count: cadResult.count ?? (cadResult.results?.length ?? 0) });

      if (!cadResult.success) {
        const resp = `${participantId}, Central. Unable to complete social check.`;
        await this.speak(resp, participantId);
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

      if (hasFlags) {
        setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_SECURE_CONFIRM, null, {
          lastName: person.last_name || person.lastName || '',
          firstName: person.first_name || person.firstName || '',
          dob: person.dob || '',
          personData: person,
          lastSearchResult: { ssn: '***', status: 'flagged' }
        }, true);
        const resp = `${participantId}, Central. Is your mic secure?`;
        await this.speak(resp, participantId);
      } else if (hasRecord) {
        const name = `${person.last_name || person.lastName || ''}, ${person.first_name || person.firstName || ''}`.trim();
        const resp = `${participantId}, Central. Social returns to ${name || 'subject on file'}. No wants or warrants.`;
        await this.speak(resp, participantId);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      } else {
        const resp = `${participantId}, Central. No return on that social.`;
        await this.speak(resp, participantId);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      }
    } catch (error) {
      this.log('PERSON_CHECK_SSN_ERROR', { error: error.message });
      const resp = `${participantId}, Central. System error on social check.`;
      await this.speak(resp, participantId);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
    }
  }

  async handleClearUnit(participantId, transcript) {
    this.log('CLEAR_UNIT', { participant: participantId, transcript });

    if (!cadService.isConfigured()) {
      const resp = `${participantId}, CAD system not available.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      return;
    }

    setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_CLEAR_CONFIRM, null, {}, true);
    const resp = `${participantId}, confirm clear from call?`;
    await this.speak(resp, participantId);
    this.addConversationExchange(participantId, transcript, resp);
  }

  async handleClearConfirm(participantId, transcript) {
    this.log('CLEAR_CONFIRM', { participant: participantId, transcript });

    try {
      let callInfo = null;
      let wasLastUnit = false;
      try {
        callInfo = await cadService.getUnitCurrentCallById(participantId);
        if (callInfo && callInfo.assigned_units) {
          const unitList = Array.isArray(callInfo.assigned_units) ? callInfo.assigned_units : [];
          wasLastUnit = unitList.length <= 1;
          this.log('CLEAR_UNIT_CHECK_LAST', { unitId: participantId, assignedUnits: unitList, wasLastUnit });
        }
      } catch (e) {
        this.log('CLEAR_UNIT_CHECK_LAST_ERROR', { error: e.message });
      }

      const clearResult = await cadService.clearUnit(participantId);
      if (clearResult?.success === false) {
        const resp = `${participantId}, unable to clear you from call. ${clearResult.error || 'Try your MDT.'}`;
        await this.speak(resp, participantId);
        this.addConversationExchange(participantId, transcript, resp);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
        return;
      }
      this.log('UNIT_CLEARED', { unitId: participantId });

      try {
        await cadService.updateUnitStatus(participantId, 'available');
      } catch (statusErr) {
        this.log('CAD_STATUS_UPDATE_AFTER_CLEAR_ERROR', { error: statusErr.message });
      }

      const timeStr = this.formatMilitaryTime();

      if (wasLastUnit && callInfo) {
        const callNumber = callInfo.call_id || callInfo.call_number || callInfo.callNumber;
        const resp = `${participantId}, 10-4, clear. ${timeStr}. You were the last unit, go ahead with disposition.`;
        await this.speak(resp, participantId);
        this.addConversationExchange(participantId, transcript, resp);
        setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_DISPOSITION, null, {
          callNumber
        }, true);
      } else {
        const resp = `${participantId}, 10-4, clear. ${timeStr}.`;
        await this.speak(resp, participantId);
        this.addConversationExchange(participantId, transcript, resp);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      }
    } catch (error) {
      this.log('CLEAR_UNIT_ERROR', { error: error.message });
      const resp = `${participantId}, unable to clear. System error.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
    }
  }

  async handleDisposeCall(participantId, transcript, slots) {
    this.log('DISPOSE_CALL', { participant: participantId, transcript, slots });

    const disposition = slots?.disposition;

    if (disposition && disposition.trim().length > 1) {
      let callNumber = slots?.callNumber;
      if (!callNumber) {
        try {
          const currentCall = await cadService.getUnitCurrentCallById(participantId);
          callNumber = currentCall?.call_id || currentCall?.call_number || currentCall?.callNumber;
        } catch (e) { /* ignore */ }
      }
      setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_DISPOSE_CONFIRM, null, {
        callNumber,
        disposition: disposition.trim()
      }, true);
      const resp = `${participantId}, confirm close call, ${disposition.trim()}?`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
    } else {
      const savedSlots = {};
      if (slots?.callNumber) savedSlots.callNumber = slots.callNumber;
      setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_DISPOSITION, null, savedSlots, true);
      const resp = `${participantId}, go ahead with disposition.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
    }
  }

  async handleDispositionInput(participantId, transcript, savedSlots) {
    this.log('DISPOSITION_INPUT', { participant: participantId, transcript });

    const normalized = transcript.toLowerCase().trim();
    const disregardPhrases = ['disregard', 'cancel', 'cancel that', 'nevermind', 'never mind', '10-22', 'scratch that'];
    if (disregardPhrases.some(p => normalized.includes(p))) {
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      const resp = `${participantId}, 10-4, disregard.`;
      await this.speak(resp, participantId);
      return;
    }

    const disposition = transcript.trim();
    if (!disposition || disposition.length < 2) {
      const resp = `${participantId}, did not copy disposition. Go ahead.`;
      await this.speak(resp, participantId);
      return;
    }

    let callNumber = savedSlots?.callNumber;
    if (!callNumber) {
      try {
        const currentCall = await cadService.getUnitCurrentCallById(participantId);
        callNumber = currentCall?.call_id || currentCall?.call_number || currentCall?.callNumber;
      } catch (e) { /* ignore */ }
    }

    setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_DISPOSE_CONFIRM, null, {
      callNumber,
      disposition
    }, true);
    const resp = `${participantId}, confirm close call, ${disposition}?`;
    await this.speak(resp, participantId);
    this.addConversationExchange(participantId, transcript, resp);
  }

  async handleDisposeConfirm(participantId, transcript, slots) {
    this.log('DISPOSE_CONFIRM', { participant: participantId, transcript, slots });
    await this.executeDisposeCall(participantId, transcript, slots?.callNumber, slots?.disposition);
  }

  async executeDisposeCall(participantId, transcript, callNumber, disposition) {
    this.log('EXECUTE_DISPOSE_CALL', { participantId, callNumber, disposition });

    if (!cadService.isConfigured()) {
      const resp = `${participantId}, CAD system not available.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      return;
    }

    try {
      let callId = callNumber;
      if (!callId) {
        const currentCall = await cadService.getUnitCurrentCallById(participantId);
        callId = currentCall?.call_id || currentCall?.call_number || currentCall?.callNumber;
      }

      if (!callId) {
        const resp = `${participantId}, no active call to close.`;
        await this.speak(resp, participantId);
        this.addConversationExchange(participantId, transcript, resp);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
        return;
      }

      const result = await cadService.disposeCall(callId, disposition);
      if (result?.success === false) {
        const resp = `${participantId}, unable to close call. ${result.error || 'Try your MDT.'}`;
        await this.speak(resp, participantId);
        this.addConversationExchange(participantId, transcript, resp);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
        return;
      }
      this.log('CALL_DISPOSED', { unitId: participantId, callId, disposition });

      const resp = `${participantId}, 10-4. Call closed, ${disposition}.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
    } catch (error) {
      this.log('DISPOSE_CALL_ERROR', { error: error.message });
      const resp = `${participantId}, unable to close call. System error.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
    }
  }

  async handleWarrantCheck(participantId, transcript, slots) {
    this.log('WARRANT_CHECK', { participant: participantId, transcript, slots });

    const firstName = slots?.firstName;
    const lastName = slots?.lastName;

    if (firstName && lastName) {
      await this.executeWarrantCheck(participantId, transcript, firstName, lastName);
    } else {
      const savedSlots = {};
      if (firstName) savedSlots.firstName = firstName;
      if (lastName) savedSlots.lastName = lastName;
      setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_WARRANT_NAME, null, savedSlots, true);
      const resp = `${participantId}, 10-29, go ahead with the name.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
    }
  }

  async handleWarrantNameInput(participantId, transcript, savedSlots) {
    this.log('WARRANT_NAME_INPUT', { participant: participantId, transcript, savedSlots });

    const normalized = transcript.toLowerCase().trim();
    const disregardPhrases = ['disregard', 'cancel', 'nevermind', 'never mind'];
    if (disregardPhrases.some(p => normalized.includes(p))) {
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      const resp = `${participantId}, 10-4, disregard.`;
      await this.speak(resp, participantId);
      return;
    }

    const personDetails = parsePersonDetails(transcript);
    const lastName = personDetails?.lastName || savedSlots?.lastName;
    const firstName = personDetails?.firstName || savedSlots?.firstName;

    if (!lastName) {
      const resp = `${participantId}, did not copy last name. Go ahead with first and last name.`;
      await this.speak(resp, participantId);
      return;
    }

    if (!firstName) {
      const resp = `${participantId}, did not copy first name. Go ahead with first name.`;
      await this.speak(resp, participantId);
      setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_WARRANT_NAME, null, { lastName }, false);
      return;
    }

    await this.executeWarrantCheck(participantId, transcript, firstName, lastName);
  }

  async executeWarrantCheck(participantId, transcript, firstName, lastName) {
    this.log('EXECUTE_WARRANT_CHECK', { participantId, firstName, lastName });

    const standbyResp = `${participantId}, 10-4. Standby on warrant check.`;
    await this.speak(standbyResp, participantId);

    try {
      if (!cadService.isConfigured()) {
        const resp = `${participantId}, CAD system not available.`;
        await this.speak(resp, participantId);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
        return;
      }

      let result = await cadService.queryWarrant(firstName, lastName);
      this.log('CAD_WARRANT_QUERY_RESULT', { participantId, success: result.success });

      let broadened = false;
      const warrants = result.warrants || result.results || [];
      if (result.success && warrants.length === 0 && firstName) {
        this.log('WARRANT_CHECK_BROADENING', { step: 'lastNameOnly', lastName });
        const retry = await cadService.queryWarrant('', lastName);
        if (retry.success) {
          const retryWarrants = retry.warrants || retry.results || [];
          if (retryWarrants.length > 0) {
            result = retry;
            broadened = true;
          }
        }
      }

      if (!result.success) {
        const resp = `${participantId}, Central. Unable to complete warrant check.`;
        await this.speak(resp, participantId);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
        return;
      }

      const finalWarrants = result.warrants || result.results || [];
      if (finalWarrants.length > 0) {
        if (broadened && finalWarrants.length > 1) {
          const nameList = finalWarrants.map(w => {
            const fn = w.first_name || w.firstName || '';
            const ln = w.last_name || w.lastName || lastName;
            return `${fn} ${ln}`;
          }).join('; ');
          const resp = `${participantId}, Central. No exact match for ${firstName} ${lastName}, but I have ${finalWarrants.length} warrant results under last name ${lastName}. ${nameList}. Advise which subject.`;
          await this.speak(resp, participantId);
          this.addConversationExchange(participantId, transcript, resp);
        } else {
          const warrantDetails = finalWarrants.map(w => {
            const type = w.type || w.charge || 'warrant';
            const county = w.county || w.jurisdiction || 'unknown jurisdiction';
            return `${type} out of ${county}`;
          });
          const prefix = broadened
            ? `${participantId}, Central. No exact match for ${firstName} ${lastName}, but ${lastName} shows`
            : `${participantId}, Central. ${lastName}, ${firstName} shows`;
          const resp = `${prefix} ${finalWarrants.length} active warrant${finalWarrants.length > 1 ? 's' : ''}. ${warrantDetails.join(', ')}. Use caution.`;
          await this.speak(resp, participantId);
          this.addConversationExchange(participantId, transcript, resp);
        }
      } else {
        const resp = `${participantId}, Central. ${lastName}, ${firstName}, negative warrants.`;
        await this.speak(resp, participantId);
        this.addConversationExchange(participantId, transcript, resp);
      }
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
    } catch (error) {
      this.log('WARRANT_CHECK_ERROR', { error: error.message });
      const resp = `${participantId}, Central. System error on warrant check.`;
      await this.speak(resp, participantId);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
    }
  }

  async handleUpdateCall(participantId, transcript, slots) {
    this.log('UPDATE_CALL', { participant: participantId, transcript, slots });

    if (!cadService.isConfigured()) {
      const resp = `${participantId}, CAD system not available.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      return;
    }

    try {
      let callId = slots?.callNumber;
      if (!callId) {
        const currentCall = await cadService.getUnitCurrentCallById(participantId);
        callId = currentCall?.call_id || currentCall?.call_number || currentCall?.callNumber;
      }

      if (!callId) {
        const resp = `${participantId}, no active call to update.`;
        await this.speak(resp, participantId);
        this.addConversationExchange(participantId, transcript, resp);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
        return;
      }

      const updates = {};
      if (slots?.priority) updates.priority = slots.priority;
      if (slots?.details) updates.notes = slots.details;

      if (Object.keys(updates).length === 0) {
        setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_CALL_UPDATE_DETAILS, null, {
          callId
        }, true);
        const resp = `${participantId}, what would you like to update on the call?`;
        await this.speak(resp, participantId);
        this.addConversationExchange(participantId, transcript, resp);
        return;
      }

      setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_CALL_UPDATE_CONFIRM, null, {
        callId,
        updates
      }, true);

      const updateDesc = [];
      if (updates.priority) updateDesc.push(`priority to ${updates.priority}`);
      if (updates.notes) updateDesc.push(`add info`);
      const confirmResp = `${participantId}, confirm update ${updateDesc.join(' and ')} on the call?`;
      await this.speak(confirmResp, participantId);
      this.addConversationExchange(participantId, transcript, confirmResp);
    } catch (error) {
      this.log('UPDATE_CALL_ERROR', { error: error.message });
      const resp = `${participantId}, unable to update call. System error.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
    }
  }

  async handleCallUpdateConfirm(participantId, transcript, slots) {
    this.log('CALL_UPDATE_CONFIRM', { participant: participantId, transcript, slots });

    if (!cadService.isConfigured()) {
      const resp = `${participantId}, CAD system not available.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      return;
    }

    const callId = slots?.callId;
    const updates = slots?.updates;

    if (!callId || !updates) {
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      const resp = `${participantId}, unable to complete update. Missing info.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      return;
    }

    try {
      const result = await cadService.updateCall(callId, updates);
      if (result?.success === false) {
        const resp = `${participantId}, unable to update call. ${result.error || 'Try your MDT.'}`;
        await this.speak(resp, participantId);
        this.addConversationExchange(participantId, transcript, resp);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
        return;
      }
      this.log('CALL_UPDATED', { unitId: participantId, callId, updates });

      const resp = `${participantId}, 10-4. Call updated.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
    } catch (error) {
      this.log('CALL_UPDATE_CONFIRM_ERROR', { error: error.message });
      const resp = `${participantId}, unable to update call. System error.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
    }
  }

  async handleCallUpdateDetailsInput(participantId, transcript, savedSlots) {
    this.log('CALL_UPDATE_DETAILS_INPUT', { participant: participantId, transcript, savedSlots });

    const normalized = transcript.toLowerCase().trim();
    const disregardPhrases = ['disregard', 'cancel', 'nevermind', 'never mind'];
    if (disregardPhrases.some(p => normalized.includes(p))) {
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      const resp = `${participantId}, 10-4, disregard.`;
      await this.speak(resp, participantId);
      return;
    }

    const callId = savedSlots?.callId;
    if (!callId) {
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      const resp = `${participantId}, unable to update. No active call.`;
      await this.speak(resp, participantId);
      return;
    }

    const updates = {};
    const priorityMatch = normalized.match(/priority\s+(\d|one|two|three|four|five|high|low|routine|emergency|urgent)/i);
    if (priorityMatch) {
      updates.priority = priorityMatch[1];
    }

    updates.notes = transcript.trim();

    setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_CALL_UPDATE_CONFIRM, null, {
      callId,
      updates
    }, true);

    const confirmResp = `${participantId}, confirm update on the call?`;
    await this.speak(confirmResp, participantId);
    this.addConversationExchange(participantId, transcript, confirmResp);
  }

  async handleCallDetails(participantId, transcript, slots) {
    this.log('CALL_DETAILS', { participant: participantId, transcript, slots });

    if (!cadService.isConfigured()) {
      const resp = `${participantId}, CAD system not available.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      return;
    }

    try {
      let callId = slots?.callNumber;

      if (!callId) {
        const currentCall = await cadService.getUnitCurrentCallById(participantId);
        callId = currentCall?.call_id || currentCall?.call_number || currentCall?.callNumber;
      }

      if (callId) {
        const activeCalls = await cadService.getActiveCalls();
        const calls = activeCalls.calls || activeCalls.results || [];
        const resolved = this.resolveShorthandCallNumber(callId, calls);
        if (resolved) {
          callId = resolved.call_id || resolved.id || resolved.call_number;
        }
      }

      if (!callId) {
        const resp = `${participantId}, unable to locate that call.`;
        await this.speak(resp, participantId);
        this.addConversationExchange(participantId, transcript, resp);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
        return;
      }

      const callDetails = await cadService.getCallDetails(callId);
      if (!callDetails || callDetails.success === false) {
        const resp = `${participantId}, unable to pull details on that call.`;
        await this.speak(resp, participantId);
        this.addConversationExchange(participantId, transcript, resp);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
        return;
      }

      const call = callDetails.call || callDetails;
      const callNum = call.call_number || call.callNumber || callId;
      const nature = call.nature || call.type || call.call_type || 'Unknown';
      const location = call.location || call.address || 'Unknown location';
      const priority = call.priority || 'routine';
      const status = call.status || 'active';
      const notes = call.notes || call.additional_info || '';
      const units = call.assigned_units || call.units || [];

      let resp = `${participantId}, ${callNum}. ${nature.toLowerCase()} at ${location}, priority ${priority}, status ${status}.`;
      if (units.length > 0) {
        const unitList = Array.isArray(units) ? units.map(u => typeof u === 'string' ? u : u.unit_id || u.id).join(', ') : '';
        if (unitList) resp += ` Units on scene: ${unitList}.`;
      }
      if (notes && notes.length > 0 && notes.length < 200) {
        resp += ` Notes: ${notes}.`;
      }
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
    } catch (error) {
      this.log('CALL_DETAILS_ERROR', { error: error.message });
      const resp = `${participantId}, unable to pull call details. System error.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
    }
  }

  async handleAnimalSearch(participantId, transcript, slots) {
    this.log('ANIMAL_SEARCH', { participant: participantId, transcript, slots });

    const hasSearchCriteria = slots?.tag || slots?.microchip || slots?.ownerLast || slots?.name;

    if (hasSearchCriteria) {
      await this.executeAnimalSearch(participantId, transcript, slots);
    } else {
      setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_ANIMAL_SEARCH_TYPE, null, {
        animalType: slots?.animalType || ''
      }, true);
      const resp = `${participantId}, go ahead with the tag number, microchip, or owner name.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
    }
  }

  async handleAnimalSearchInput(participantId, transcript, savedSlots) {
    this.log('ANIMAL_SEARCH_INPUT', { participant: participantId, transcript, savedSlots });

    const normalized = transcript.toLowerCase().trim();
    const disregardPhrases = ['disregard', 'cancel', 'nevermind', 'never mind'];
    if (disregardPhrases.some(p => normalized.includes(p))) {
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      const resp = `${participantId}, 10-4, disregard.`;
      await this.speak(resp, participantId);
      return;
    }

    const searchSlots = { ...savedSlots };

    if (/\b(tag|license)\b/i.test(normalized)) {
      const tagMatch = transcript.match(/\b([A-Z0-9]{3,})\b/i);
      if (tagMatch) searchSlots.tag = tagMatch[1].toUpperCase();
    } else if (/\b(microchip|chip)\b/i.test(normalized)) {
      const chipMatch = transcript.match(/\b(\d{9,15})\b/);
      if (chipMatch) searchSlots.microchip = chipMatch[1];
    } else {
      const personDetails = parsePersonDetails(transcript);
      if (personDetails?.lastName) searchSlots.ownerLast = personDetails.lastName;
      if (personDetails?.firstName) searchSlots.ownerFirst = personDetails.firstName;
      if (!searchSlots.ownerLast) {
        searchSlots.tag = transcript.trim().replace(/\s+/g, '').toUpperCase();
      }
    }

    if (!searchSlots.tag && !searchSlots.microchip && !searchSlots.ownerLast) {
      const resp = `${participantId}, did not copy. Go ahead with tag number, microchip, or owner name.`;
      await this.speak(resp, participantId);
      return;
    }

    await this.executeAnimalSearch(participantId, transcript, searchSlots);
  }

  async executeAnimalSearch(participantId, transcript, searchParams) {
    this.log('EXECUTE_ANIMAL_SEARCH', { participantId, searchParams });

    const standbyResp = `${participantId}, 10-4. Standby on animal search.`;
    await this.speak(standbyResp, participantId);

    try {
      if (!cadService.isConfigured()) {
        const resp = `${participantId}, CAD system not available.`;
        await this.speak(resp, participantId);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
        return;
      }

      const result = await cadService.searchAnimal(searchParams);
      this.log('CAD_ANIMAL_SEARCH_RESULT', { participantId, success: result.success });

      if (!result.success) {
        const resp = `${participantId}, Central. Unable to complete animal search.`;
        await this.speak(resp, participantId);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
        return;
      }

      const animals = result.animals || result.results || [];
      if (animals.length === 0) {
        const resp = `${participantId}, Central. No results on that animal search.`;
        await this.speak(resp, participantId);
        this.addConversationExchange(participantId, transcript, resp);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
        return;
      }

      const animal = animals[0];
      const type = animal.animal_type || animal.type || 'animal';
      const name = animal.name || '';
      const ownerName = [animal.owner_first || '', animal.owner_last || ''].filter(Boolean).join(' ') || 'unknown owner';
      const tag = animal.tag || '';
      let resp = `${participantId}, Central. ${type}`;
      if (name) resp += ` named ${name}`;
      resp += `, registered to ${ownerName}`;
      if (tag) resp += `, tag ${tag}`;
      resp += '.';
      if (animals.length > 1) resp += ` ${animals.length} total results, check your MDT for details.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
    } catch (error) {
      this.log('ANIMAL_SEARCH_ERROR', { error: error.message });
      const resp = `${participantId}, Central. System error on animal search.`;
      await this.speak(resp, participantId);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
    }
  }

  async handleStatusCheckResponse(participantId, transcript, slots) {
    this.log('STATUS_CHECK_RESPONSE', { participant: participantId, transcript, slots });

    const checkId = slots?.statusCheckId;
    const normalized = transcript.toLowerCase().trim();
    const okPhrases = ['10-4', '10/4', 'ten four', 'copy', 'roger', 'yes', 'affirmative', 'good', 'okay', 'ok', 'clear'];
    const isOk = okPhrases.some(p => normalized.includes(p));
    const status = isOk ? 'ok' : transcript.trim();

    if (cadService.isConfigured() && checkId) {
      try {
        await cadService.respondToStatusCheck(participantId, status);
        this.log('STATUS_CHECK_RESPONDED', { unitId: participantId, checkId, status });
      } catch (error) {
        this.log('STATUS_CHECK_RESPOND_ERROR', { error: error.message });
      }
    }

    const resp = `${participantId}, 10-4.`;
    await this.speak(resp, participantId);
    this.addConversationExchange(participantId, transcript, resp);
    setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
  }

  _startStatusCheckPolling() {
    this._stopStatusCheckPolling();
    if (!cadService.isConfigured()) {
      this.log('STATUS_CHECK_POLLING_SKIPPED', { reason: 'CAD not configured' });
      return;
    }

    const STATUS_CHECK_POLL_INTERVAL_MS = 30000;
    this._statusCheckPollingInterval = setInterval(async () => {
      if (!this.isRunning || !this.connected) return;
      try {
        const result = await cadService.getPendingChecks();
        if (!result.success) return;
        const checks = result.checks || result.pending_checks || [];
        if (checks.length === 0) return;

        for (const check of checks) {
          const unitId = check.unit_id || check.unitId;
          if (!unitId) continue;

          const checkId = check.id || check.check_id || `${unitId}-${Date.now()}`;
          if (this._seenStatusCheckIds.has(checkId)) continue;
          this._seenStatusCheckIds.add(checkId);

          this.log('STATUS_CHECK_PENDING', { unitId, checkId });

          setUnitSessionState(unitId, DISPATCHER_STATE.AWAITING_STATUS_CHECK_RESPONSE, null, {
            statusCheckId: checkId
          }, true);

          const resp = `${unitId}, status check. Respond when able.`;
          await this.speak(resp, unitId);
        }
      } catch (error) {
        this.log('STATUS_CHECK_POLL_ERROR', { error: error.message });
      }
    }, STATUS_CHECK_POLL_INTERVAL_MS);

    if (this._statusCheckPollingInterval.unref) {
      this._statusCheckPollingInterval.unref();
    }
    this.log('STATUS_CHECK_POLLING_STARTED', { intervalMs: STATUS_CHECK_POLL_INTERVAL_MS });
  }

  _stopStatusCheckPolling() {
    if (this._statusCheckPollingInterval) {
      clearInterval(this._statusCheckPollingInterval);
      this._statusCheckPollingInterval = null;
      this._seenStatusCheckIds.clear();
      this.log('STATUS_CHECK_POLLING_STOPPED');
    }
  }

  _formatSpokenDate(dateStr) {
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const ones = ['','first','second','third','fourth','fifth','sixth','seventh','eighth','ninth','tenth','eleventh','twelfth','thirteenth','fourteenth','fifteenth','sixteenth','seventeenth','eighteenth','nineteenth'];
    const tens = ['','','twentieth','thirtieth'];
    const tensPrefix = ['','','twenty','thirty'];

    const formatDay = (d) => {
      if (d >= 1 && d <= 19) return ones[d];
      const t = Math.floor(d / 10);
      const o = d % 10;
      return o === 0 ? tens[t] : `${tensPrefix[t]} ${ones[o]}`.trim();
    };

    const formatYear = (y) => {
      const cardinals = ['','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen'];
      const decadeWords = ['','ten','twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety'];
      const cardinalUnder100 = (n) => {
        if (n === 0) return '';
        if (n < 20) return cardinals[n];
        const t = Math.floor(n / 10);
        const o = n % 10;
        return o === 0 ? decadeWords[t] : `${decadeWords[t]} ${cardinals[o]}`;
      };

      if (y >= 2000 && y <= 2009) return `two thousand ${y === 2000 ? '' : cardinals[y - 2000]}`.trim();
      if (y >= 2010 && y <= 2019) return `two thousand ${cardinals[y - 2000]}`;
      if (y >= 2020 && y <= 2099) {
        const decade = Math.floor((y - 2000) / 10);
        const unit = y % 10;
        return `twenty ${decadeWords[decade]}${unit > 0 ? ' ' + cardinals[unit] : ''}`.trim();
      }
      const century = Math.floor(y / 100);
      const remainder = y % 100;
      const centuryWord = cardinalUnder100(century);
      if (remainder === 0) return `${centuryWord} hundred`;
      return `${centuryWord} ${cardinalUnder100(remainder)}`.trim();
    };

    try {
      const parts = dateStr.split(/[-\/]/);
      if (parts.length < 3) return dateStr;
      let month, day, year;
      if (parts[0].length === 4) {
        year = parseInt(parts[0]); month = parseInt(parts[1]); day = parseInt(parts[2]);
      } else {
        month = parseInt(parts[0]); day = parseInt(parts[1]); year = parseInt(parts[2]);
      }
      if (isNaN(month) || isNaN(day) || isNaN(year)) return dateStr;
      if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1) return dateStr;
      return `${months[month - 1]} ${formatDay(day)}, ${formatYear(year)}`;
    } catch {
      return dateStr;
    }
  }

  _formatSpokenTime24(date) {
    return formatSpokenTime24(date);
  }

  _buildBoloAnnouncementParts(bolo) {
    const agency = bolo.agency || 'an unknown agency';
    const firstName = bolo.first_name || '';
    const middleName = bolo.middle_name || '';
    const lastName = bolo.last_name || '';
    const fullName = [firstName, middleName, lastName].filter(Boolean).join(' ') || 'an unidentified individual';
    const dob = bolo.dob ? this._formatSpokenDate(bolo.dob) : 'unknown';
    const reason = bolo.reason || 'No reason provided';
    const lastSeen = bolo.last_seen || 'an unknown location';
    const contactAgency = bolo.contact_agency || agency;

    const now = new Date();
    const currentDate = this._formatSpokenDate(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`);
    const currentTime = this._formatSpokenTime24(now);

    const openLine = `Attention all receiving units, prepare to copy a BOLO from ${agency}.`;

    const boloParagraph = `${agency} has issued a BOLO for ${fullName}, date of birth ${dob}. ${reason}. The individual was last seen ${lastSeen}. If any units come in contact with this individual, please contact ${contactAgency}. Check your MDT for additional info.`;

    const signOff = `Statewide Constable Communications Center, ${currentDate}, ${currentTime}.`;

    return { openLine, boloParagraph, signOff };
  }

  async _announcePersonBolo(bolo) {
    const { openLine, boloParagraph, signOff } = this._buildBoloAnnouncementParts(bolo);

    await this.playToneAndSpeak('A', null);

    await new Promise(resolve => setTimeout(resolve, 1500));

    await this.speak(openLine);

    await new Promise(resolve => setTimeout(resolve, 3500));

    await this.speak(boloParagraph);

    await new Promise(resolve => setTimeout(resolve, 1500));
    await this.speak('Repeating.');
    await new Promise(resolve => setTimeout(resolve, 1500));

    await this.speak(boloParagraph);

    await new Promise(resolve => setTimeout(resolve, 1500));
    await this.speak(signOff);
  }

  _startBoloPolling() {
    this._stopBoloPolling();
    if (!cadService.isConfigured()) {
      this.log('BOLO_POLLING_SKIPPED', { reason: 'CAD not configured' });
      return;
    }

    this._boloSeeded = false;
    cadService.getRecentBolos().then(result => {
      const bolos = result.bolos || result.results || [];
      for (const bolo of bolos) {
        const boloId = bolo.id || bolo.bolo_id || `${bolo.description || ''}`.substring(0, 50);
        if (boloId) this._seenBoloIds.add(String(boloId));
      }
      this._boloSeeded = true;
      this.log('BOLO_POLLING_SEEDED', { seenCount: this._seenBoloIds.size });
    }).catch(err => {
      this._boloSeeded = true;
      this.log('BOLO_POLLING_SEED_ERROR', { error: err.message });
    });

    const BOLO_POLL_INTERVAL_MS = 60000;
    this._boloPollingInterval = setInterval(async () => {
      if (!this.isRunning || !this.connected || !this._boloSeeded) return;
      try {
        const result = await cadService.getRecentBolos();
        const bolos = result.bolos || result.results || [];
        for (const bolo of bolos) {
          const boloId = bolo.id || bolo.bolo_id || `${bolo.description || ''}`.substring(0, 50);
          if (!boloId) continue;
          const idStr = String(boloId);
          if (this._seenBoloIds.has(idStr)) continue;
          this._seenBoloIds.add(idStr);

          const boloType = (bolo.bolo_type || '').toString().toLowerCase().trim();
          if (boloType !== 'person') {
            this.log('BOLO_SKIPPED_NON_PERSON', { boloId: idStr, bolo_type: boloType || 'unknown' });
            continue;
          }

          this.log('BOLO_NEW_DETECTED', { boloId: idStr, bolo_type: boloType, priority: bolo.priority || 'normal' });

          try {
            await this._announcePersonBolo(bolo);
          } catch (announceErr) {
            this.log('BOLO_ANNOUNCE_ERROR', { boloId: idStr, error: announceErr.message });
          }
        }
      } catch (error) {
        this.log('BOLO_POLL_ERROR', { error: error.message });
      }
    }, BOLO_POLL_INTERVAL_MS);

    if (this._boloPollingInterval.unref) {
      this._boloPollingInterval.unref();
    }
    this.log('BOLO_POLLING_STARTED', { intervalMs: BOLO_POLL_INTERVAL_MS });
  }

  _stopBoloPolling() {
    if (this._boloPollingInterval) {
      clearInterval(this._boloPollingInterval);
      this._boloPollingInterval = null;
      this.log('BOLO_POLLING_STOPPED');
    }
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

  async speak(text, participantId = null, options = {}) {
    this.log('SPEAK', { text, unit: participantId || '(broadcast)', channel: this.channelName, options });
    const turnCtx = participantId ? this._turnContextByUnit.get(participantId) : null;
    if (turnCtx) {
      this.logSpeechEvent(participantId, turnCtx.transcript, turnCtx.intent, text);
      this._turnContextByUnit.delete(participantId);
    }
    const audio = await textToSpeech(text);
    await this.publishAudio(audio, text, options);
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

  async publishAudio(audioBuffer, responseText = null, options = {}) {
    const { retryOnBusy = false, retryWaitMs = 1500, retryContext = null } = options;
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
        this.verboseLog('OPUS_ENCODE_ERROR', { error: err.message });
        return;
      }

      this.verboseLog('AUDIO_STREAMING', { opusFrames: opusFrames.length, channel: this.channelName });

      let floorResult = floorControlService.requestFloor(this.channelName, AI_IDENTITY, {
        isEmergency: false,
        emergencyStates: null,
      });
      if (!floorResult.granted && retryOnBusy) {
        this.log('PUBLISH_FLOOR_BUSY_WAITING', { heldBy: floorResult.heldBy, retryWaitMs, context: retryContext });
        const start = Date.now();
        while (!floorResult.granted && (Date.now() - start) < retryWaitMs) {
          await new Promise(r => setTimeout(r, 100));
          floorResult = floorControlService.requestFloor(this.channelName, AI_IDENTITY, {
            isEmergency: false,
            emergencyStates: null,
          });
        }
        if (floorResult.granted) {
          this.log('PUBLISH_FLOOR_ACQUIRED_AFTER_WAIT', { waitedMs: Date.now() - start, context: retryContext });
        }
      }
      if (!floorResult.granted) {
        if (retryOnBusy) {
          this.log('AI_ACK_DROPPED', { reason: 'Floor busy after retry', heldBy: floorResult.heldBy, context: retryContext, responseText });
        } else {
          this.log('PUBLISH_SKIPPED', { reason: 'Floor busy', heldBy: floorResult.heldBy });
        }
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

      floorControlService.releaseFloor(this.channelName, AI_IDENTITY);

      if (responseText && this.channelName) {
        try {
          const wavHeader = createWavHeader(audioBuffer.length, AZURE_SAMPLE_RATE, CHANNELS, 16);
          const wavBuffer = Buffer.concat([wavHeader, audioBuffer]);
          if (!isValidWav(wavBuffer)) {
            this.log('CHAT_RECORD_INVALID_WAV', { channel: this.channelName, size: wavBuffer.length });
            return;
          }
          const filename = `${this.channelName}_${Date.now()}_AI-DISPATCHER.wav`;
          const filepath = path.join(AUDIO_DIR, filename);
          fs.writeFileSync(filepath, wavBuffer);
          const audioUrl = `/api/messages/audio/${filename}`;
          const samples = new Int16Array(audioBuffer.buffer, audioBuffer.byteOffset, audioBuffer.length / 2);
          const durationMs = Math.round((samples.length / AZURE_SAMPLE_RATE) * 1000);
          const msg = await createChannelMessage(this.channelName, 'AI-DISPATCHER', 'audio', null, audioUrl, durationMs, wavBuffer);
          if (msg) {
            await createChannelMessage(this.channelName, 'AI-DISPATCHER', 'text', responseText).catch(() => {});
            broadcastMessage(this.channelName, msg).catch(() => {});
          }
          this.log('CHAT_RECORDED', { channel: this.channelName, messageId: msg?.id });
        } catch (chatErr) {
          this.log('CHAT_RECORD_ERROR', { error: chatErr.message });
        }
      }

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
  try {
    const { signalingService } = await import('./signalingService.js');
    signalingService.broadcastDataToChannel(channelName, {
      type: 'new_message',
      message
    });
    console.log(`[broadcastMessage] Broadcast message to ${channelName}:`, message.id);
    return true;
  } catch (error) {
    console.error(`[broadcastMessage] Failed to broadcast to ${channelName}:`, error.message);
    return false;
  }
}
