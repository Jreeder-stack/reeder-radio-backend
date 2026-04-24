import { speechToText, textToSpeech, isConfigured as isAzureConfigured } from './azureSpeechService.js';
import { matchCommand, resetDispatcherState, matchEmergencyResponse, matchSecureConfirmation, getUnitSessionState, setUnitSessionState, DISPATCHER_STATE, EMERGENCY_DISTRESS_PHRASES, ownsInFlight, clearPromptTimeout, setPromptTimeoutHandler } from './commandMatcher.js';
import { detectEmergencyBypass, parseWake, parseIdentify, WAKE_RESULT, IDENTIFY_RESULT, IDENTIFY_TIMEOUT_MS } from './wakeGate.js';
import { RADIO_STATUS, extractActualStatusFromRejection } from './cadService.js';
import { resolveDestination, KNOWN_PLACES, setLearnedPlaces } from './agencyKnowledge.js';
import * as dispatcherLearning from './dispatcherLearning.js';
import { isConfigured as isLlmConfigured, classifyIntent, answerWithData, composeNatural, rewriteCallNote } from './llmIntentService.js';
import { parsePersonDetails, parseDOB, extractNameFromTranscript } from './phoneticParser.js';
import pool, { isAiDispatchEnabled, getAiDispatchChannel, createChannelMessage, getRecentAudioMessageBySender, getAllFcmTokensForUnit, createPage, getPagingChannelId } from '../db/index.js';
import { sendPageToList, sendPageToTokens } from './fcmService.js';
import { isValidWav } from './wavValidator.js';
import { audioRelayService } from './audioRelayService.js';
import { formatEventNote, formatDescriptionNote, isClearAirEventType, getEventSpokenLabel, matchEventFromTranscript, isAllClearPhrase } from './eventNoteFormatter.js';
import { opusCodec, SAMPLE_RATE as OPUS_SAMPLE_RATE, FRAME_SIZE as OPUS_FRAME_SIZE } from './opusCodec.js';
import { floorControlService } from './floorControlService.js';
import { formatSpokenTime24 } from './hourlyTimeBroadcastService.js';
import * as cadService from './cadService.js';
import { cadStatusCheckClient } from './cadStatusCheckClient.js';
import { recordAction, findMostRecentAction, removeAction, getActionsForUnit, DISREGARD_WINDOW_MS } from './unitActionLog.js';
import { DISPATCHER_TZ, utcDateToLocalDate, localDateToUtcDate, formatLocalSpokenTime24, maybeUtcToLocalForSpeech } from '../utils/timezone.js';
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

    // Server-authoritative emergency clear: broadcast EMERGENCY_END to the
    // originating unit, all other units in the channel, and every dispatcher.
    // Without this the in-band ack only reaches the unit's data channel and the
    // emergency state stays "stuck" everywhere else.
    try {
      const signaling = await this.dispatcher._ensureSignalingService();
      const cleared = signaling.endEmergencyForUnit(targetUnit, `ai_ack:${reason}`);
      this.log('EMERGENCY_END_BROADCAST', { targetUnit, reason, cleared });
    } catch (error) {
      this.log('EMERGENCY_END_BROADCAST_ERROR', { error: error.message });
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

const ROUTINE_STATUS_CHECK_HAIL_TIMEOUT_MS = (() => {
  const v = parseInt(process.env.AI_ROUTINE_STATUS_CHECK_HAIL_TIMEOUT_MS, 10);
  return Number.isFinite(v) && v > 0 ? v : 30000;
})();
const ROUTINE_STATUS_CHECK_BACKUP_TIMEOUT_MS = (() => {
  const v = parseInt(process.env.AI_ROUTINE_STATUS_CHECK_BACKUP_TIMEOUT_MS, 10);
  return Number.isFinite(v) && v > 0 ? v : 60000;
})();

class RoutineStatusCheckEscalation {
  constructor(dispatcher) {
    this.dispatcher = dispatcher;
    this.active = new Map();
  }

  log(action, details = {}) { this.dispatcher.log(action, details); }

  _key(unitId, callId) { return `${String(unitId || '').toUpperCase()}|${callId || ''}`; }

  has(unitId, callId) { return this.active.has(this._key(unitId, callId)); }
  get(unitId, callId) { return this.active.get(this._key(unitId, callId)); }
  hasAnyForUnit(unitId) {
    const u = String(unitId || '').toUpperCase();
    for (const e of this.active.values()) {
      if (e.unitId.toUpperCase() === u) return e;
    }
    return null;
  }

  async start(unitId, callId, opts = {}) {
    const key = this._key(unitId, callId);
    if (this.active.has(key)) {
      this.log('STATUS_CHECK_ESCALATION_ALREADY_ACTIVE', { unitId, callId });
      return;
    }
    const esc = {
      unitId: String(unitId),
      callId,
      key,
      step: 1,
      startTime: Date.now(),
      timer: null,
      checkId: opts.checkId || null,
      unitUuid: opts.unitUuid || null,
      callNumber: opts.callNumber || null,
    };
    this.active.set(key, esc);
    // Task #512: cache callsign → CAD unit UUID so close/cancel/update lookups
    // can match UUID-only assigned_units entries via the active-list fallback.
    if (esc.unitUuid) cadService.rememberUnitUuid(esc.unitId, esc.unitUuid);
    this.log('STATUS_CHECK_ESCALATION_HAIL_1', {
      unitId: esc.unitId, callId, elapsedMs: 0, nextTimerMs: ROUTINE_STATUS_CHECK_HAIL_TIMEOUT_MS,
    });
    await this._performHail(esc, 1);
  }

  async _performHail(esc, attempt) {
    setUnitSessionState(esc.unitId, DISPATCHER_STATE.AWAITING_STATUS_CHECK_RESPONSE, null, {
      statusCheckId: esc.checkId,
      statusCheckCallId: esc.callId,
      statusCheckUnitUuid: esc.unitUuid,
      statusCheckHailStage: 'AWAITING_GO_AHEAD',
      statusCheckEscalationActive: true,
    }, true);
    try {
      await this.dispatcher.speak(`${esc.unitId}, central.`, esc.unitId, {
        retryOnBusy: true,
        retryContext: `STATUS_CHECK_HAIL_${attempt}:${esc.unitId}`,
      });
    } catch (err) {
      this.log('STATUS_CHECK_ESCALATION_SPEAK_ERROR', { unitId: esc.unitId, error: err.message });
    }
    this._armStepTimer(esc, ROUTINE_STATUS_CHECK_HAIL_TIMEOUT_MS);
  }

  _armStepTimer(esc, ms) {
    if (esc.timer) clearTimeout(esc.timer);
    esc.timer = setTimeout(() => {
      this._onStepTimeout(esc).catch(err => {
        this.log('STATUS_CHECK_ESCALATION_TIMER_ERROR', { unitId: esc.unitId, error: err.message });
      });
    }, ms);
    if (esc.timer.unref) esc.timer.unref();
  }

  async _onStepTimeout(esc) {
    if (!this.active.has(esc.key)) return;
    const elapsedMs = Date.now() - esc.startTime;
    if (esc.step === 1) {
      esc.step = 2;
      this.log('STATUS_CHECK_ESCALATION_HAIL_2', {
        unitId: esc.unitId, callId: esc.callId, elapsedMs, nextTimerMs: ROUTINE_STATUS_CHECK_HAIL_TIMEOUT_MS,
      });
      await this._performHail(esc, 2);
      return;
    }
    if (esc.step === 2) {
      esc.step = 3;
      await this._unitPage(esc);
      this._armStepTimer(esc, ROUTINE_STATUS_CHECK_HAIL_TIMEOUT_MS);
      return;
    }
    if (esc.step === 3) {
      esc.step = 4;
      await this._rosterPageAllCall(esc);
      this._armStepTimer(esc, ROUTINE_STATUS_CHECK_BACKUP_TIMEOUT_MS);
      return;
    }
    if (esc.step === 4) {
      this.log('STATUS_CHECK_ESCALATION_COMPLETED', {
        unitId: esc.unitId, callId: esc.callId, elapsedMs, reason: 'no_backup_response',
      });
      this._clear(esc.key);
    }
  }

  async _unitPage(esc) {
    const elapsedMs = Date.now() - esc.startTime;
    const message = `STATUS CHECK — ${esc.unitId}`;
    this.log('STATUS_CHECK_ESCALATION_UNIT_PAGE', {
      unitId: esc.unitId, callId: esc.callId, elapsedMs, nextTimerMs: ROUTINE_STATUS_CHECK_HAIL_TIMEOUT_MS,
    });
    try {
      const rows = await getAllFcmTokensForUnit(esc.unitId);
      const tokens = (rows || []).map(r => r.fcm_token).filter(Boolean);
      if (tokens.length > 0) {
        const page = await createPage(message, 'AI-DISPATCH', 'unit', esc.unitId, null);
        const channelId = await getPagingChannelId();
        await sendPageToTokens(tokens, page?.id, message, 'AI-DISPATCH', channelId, null);
      } else {
        this.log('STATUS_CHECK_ESCALATION_UNIT_PAGE_NO_TOKENS', { unitId: esc.unitId });
      }
    } catch (err) {
      this.log('STATUS_CHECK_ESCALATION_UNIT_PAGE_ERROR', { unitId: esc.unitId, error: err.message });
    }
    try {
      await this.dispatcher.playToneAndSpeak('A', `${esc.unitId}, status check.`);
    } catch (err) {
      this.log('STATUS_CHECK_ESCALATION_TONE_ERROR', { unitId: esc.unitId, error: err.message });
    }
  }

  async _rosterPageAllCall(esc) {
    const elapsedMs = Date.now() - esc.startTime;
    let location = null;
    try { location = await this.dispatcher.resolveUnitLocation(esc.unitId); } catch (_) { location = null; }
    const loc = location || 'location unknown';
    const message = `STATUS CHECK ESCALATION — ${esc.unitId} — ${loc}`;
    this.log('STATUS_CHECK_ESCALATION_ROSTER_PAGE_ALLCALL', {
      unitId: esc.unitId, callId: esc.callId, elapsedMs, location: loc,
      nextTimerMs: ROUTINE_STATUS_CHECK_BACKUP_TIMEOUT_MS,
    });
    try {
      await sendPageToList('emergency', message, 'AI-DISPATCH', null);
    } catch (err) {
      this.log('STATUS_CHECK_ESCALATION_ROSTER_PAGE_ERROR', { unitId: esc.unitId, error: err.message });
    }
    try {
      await this.dispatcher.playToneAndSpeak(
        'CONTINUOUS',
        `Attention all units, status check escalation, ${esc.unitId} at ${loc}. Any unit available to respond?`,
      );
    } catch (err) {
      this.log('STATUS_CHECK_ESCALATION_ALLCALL_ERROR', { unitId: esc.unitId, error: err.message });
    }
    this.log('STATUS_CHECK_ESCALATION_AWAITING_BACKUP', {
      unitId: esc.unitId, callId: esc.callId, elapsedMs,
      nextTimerMs: ROUTINE_STATUS_CHECK_BACKUP_TIMEOUT_MS,
    });
  }

  /**
   * Step-4 hook: while we're waiting for another unit to respond after the
   * roster page + all-call, listen for an en-route volunteer from any unit
   * other than the silent one. On a match we cancel the escalation timer
   * immediately, ack the volunteer, and close the loop. Returns true when
   * the utterance was intercepted.
   */
  async onUtterance(speakerUnitId, transcript) {
    if (this.active.size === 0) return false;
    const speakerNorm = String(speakerUnitId || '').toUpperCase();
    for (const esc of this.active.values()) {
      if (esc.step !== 4) continue;
      if (speakerNorm === esc.unitId.toUpperCase()) continue;
      if (!this.dispatcher._isBackupVolunteerPhrase(transcript)) continue;
      const elapsedMs = Date.now() - esc.startTime;
      this.log('STATUS_CHECK_ESCALATION_VOLUNTEER', {
        unitId: esc.unitId, callId: esc.callId, volunteer: speakerNorm, elapsedMs,
      });
      this._clear(esc.key);
      this.log('STATUS_CHECK_ESCALATION_CANCELLED', {
        unitId: esc.unitId, callId: esc.callId, reason: 'volunteer_en_route', elapsedMs,
      });
      const ack = `${speakerNorm}, 10-4, copy en route to check on ${esc.unitId}, ${this.dispatcher.formatMilitaryTime()}.`;
      try {
        await this.dispatcher.speak(ack, speakerUnitId, {
          retryOnBusy: true, retryContext: `STATUS_CHECK_VOLUNTEER:${speakerNorm}`,
        });
      } catch (err) {
        this.log('STATUS_CHECK_ESCALATION_VOLUNTEER_SPEAK_ERROR', { error: err.message });
      }
      return true;
    }
    return false;
  }

  onGoAhead(unitId, callId) {
    const esc = callId ? this.get(unitId, callId) : this.hasAnyForUnit(unitId);
    if (!esc) return false;
    setUnitSessionState(esc.unitId, DISPATCHER_STATE.AWAITING_STATUS_CHECK_RESPONSE, null, {
      statusCheckId: esc.checkId,
      statusCheckCallId: esc.callId,
      statusCheckUnitUuid: esc.unitUuid,
      statusCheckHailStage: 'AWAITING_RESPONSE',
      statusCheckEscalationActive: true,
    }, true);
    this.log('STATUS_CHECK_ESCALATION_GO_AHEAD', { unitId: esc.unitId, callId: esc.callId, step: esc.step });
    this._armStepTimer(esc, ROUTINE_STATUS_CHECK_HAIL_TIMEOUT_MS);
    this.dispatcher.speak('Status check.', esc.unitId, {
      retryOnBusy: true,
      retryContext: `STATUS_CHECK_PROMPT:${esc.unitId}`,
    }).catch(() => {});
    return true;
  }

  cancel(unitId, callId, reason = 'acknowledged') {
    let esc = callId ? this.active.get(this._key(unitId, callId)) : null;
    if (!esc) esc = this.hasAnyForUnit(unitId);
    if (!esc) return false;
    const elapsedMs = Date.now() - esc.startTime;
    this._clear(esc.key);
    this.log('STATUS_CHECK_ESCALATION_CANCELLED', {
      unitId: esc.unitId, callId: esc.callId, reason, elapsedMs,
    });
    return true;
  }

  _clear(key) {
    const esc = this.active.get(key);
    if (!esc) return;
    if (esc.timer) clearTimeout(esc.timer);
    this.active.delete(key);
  }

  clearAll() {
    for (const key of [...this.active.keys()]) this._clear(key);
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

export class AIDispatcher {
  constructor() {
    this.connected = false;
    this.channelName = null;
    this.isRunning = false;
    this.configuredChannel = null;
    this.channelAliases = new Set();
    this.numericChannelId = null;
    this.displayChannel = null;
    this.emergencyEscalation = new EmergencyEscalationController(this);
    this.routineStatusCheckEscalation = new RoutineStatusCheckEscalation(this);
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
    this.openBackupRequests = new Map();
    this._recentAssignments = new Map();
    this.RECENT_ASSIGNMENT_TTL_MS = 120000;
    // R10: per-unit serial queue so concurrent status-progression CAD calls
    // (assign → enroute → on-scene → clear, etc.) cannot overlap and corrupt
    // CAD state. Keyed by unitId, value is the tail Promise of that unit's chain.
    this._statusUpdateQueues = new Map();
    this._identifyTimeouts = new Map();
    this._boloPollingInterval = null;
    this._seenBoloIds = new Set();
    this._statusCheckPollingInterval = null;
    this._seenStatusCheckIds = new Set();
    this._pendingStatusChecks = new Map();
    // Per-(unit+call) timestamp of the last status-check prompt we actually
    // spoke, used to rate-limit duplicate prompts even when CAD fires a fresh
    // `due` or escalates within the minimum interval. Value:
    // { at: number, escalated: boolean }.
    this._lastSpokenStatusCheck = new Map();
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
    this._aiClearAirSessions = new Map();
    this._speakQueue = Promise.resolve();
    // Take ownership of per-prompt timeouts so we can re-prompt status checks
    // and emit dispatcher alerts before the session is silently released.
    setPromptTimeoutHandler((unitId, state, slots) => this._onSessionPromptTimeout(unitId, state, slots));
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

    try {
      const agencyId = dispatcherLearning.getDefaultAgencyId();
      this._agencyId = agencyId;
      const idx = await dispatcherLearning.refreshRuntimeIndex(agencyId);
      setLearnedPlaces(agencyId, idx.places);
      this.log('LEARNING_LOADED', { agencyId, placeCount: idx.places.length, callsignCount: idx.callsigns.size, phrasingCount: idx.phrasings.size, tenCodeCount: idx.tenCodes.size });
    } catch (err) {
      this.log('LEARNING_LOAD_ERROR', { error: err.message });
    }
  }

  _getAgencyId() {
    return this._agencyId || dispatcherLearning.getDefaultAgencyId();
  }

  _captureLearningCorrection(participantId, original, correction, transcript, sourceIntent) {
    try {
      if (!original || !correction) return;
      const o = String(original).trim();
      const c = String(correction).trim();
      if (!o || !c || o.toLowerCase() === c.toLowerCase()) return;
      const category = dispatcherLearning.inferCategory({ original: o, correction: c });
      dispatcherLearning.recordCandidate({
        agencyId: this._getAgencyId(),
        unitId: participantId || null,
        channel: this.configuredChannel || null,
        category,
        original: o,
        correction: c,
        transcript: transcript || null,
        sourceIntent: sourceIntent || null,
      }).then(res => {
        if (res?.ok && !res.duplicate) {
          this.log('LEARNING_CANDIDATE_CAPTURED', { id: res.candidateId, category, original: o, correction: c, sourceIntent });
        } else if (!res?.ok) {
          this.log('LEARNING_CANDIDATE_BLOCKED', { reason: res?.reason, category, original: o, correction: c });
        }
      }).catch(err => this.log('LEARNING_CAPTURE_ERROR', { error: err.message }));
    } catch (err) {
      this.log('LEARNING_CAPTURE_ERROR', { error: err.message });
    }
  }

  async _handleTeachingPhrase(participantId, transcript) {
    try {
      const detected = dispatcherLearning.detectTeachingPhrase(transcript);
      if (!detected) return false;
      const category = dispatcherLearning.inferCategory(detected);
      const res = await dispatcherLearning.recordCandidate({
        agencyId: this._getAgencyId(),
        unitId: participantId || null,
        channel: this.configuredChannel || null,
        category,
        original: detected.original,
        correction: detected.correction,
        transcript,
        sourceIntent: 'EXPLICIT_TEACHING',
      });
      if (res?.ok) {
        this.log('LEARNING_TEACHING_CAPTURED', { id: res.candidateId, category, ...detected });
        await this.speak("Noted. I'll add that to the review list.", participantId);
      } else {
        this.log('LEARNING_TEACHING_BLOCKED', { reason: res?.reason, ...detected });
        await this.speak("I can't accept that change.", participantId);
      }
      return true;
    } catch (err) {
      this.log('LEARNING_TEACHING_ERROR', { error: err.message });
      return false;
    }
  }

  async _refreshLearnedKnowledge() {
    try {
      const agencyId = this._getAgencyId();
      const idx = await dispatcherLearning.refreshRuntimeIndex(agencyId);
      setLearnedPlaces(agencyId, idx.places);
      this.log('LEARNING_REFRESHED', { agencyId, placeCount: idx.places.length, callsignCount: idx.callsigns.size, phrasingCount: idx.phrasings.size, tenCodeCount: idx.tenCodes.size });
    } catch (err) {
      this.log('LEARNING_REFRESH_ERROR', { error: err.message });
    }
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
    this.routineStatusCheckEscalation.clearAll();
    for (const handle of this._identifyTimeouts.values()) {
      clearTimeout(handle);
    }
    this._identifyTimeouts.clear();
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

  _isOfficerHelpDistressType(distressType) {
    if (!distressType) return false;
    const t = String(distressType).toLowerCase();
    return t.includes('officer down') || t.includes('emergency backup') || t.includes('immediate assistance') || t === 'reporting emergency';
  }

  _enterAwaitingIdentify(participantId) {
    this._clearIdentifyTimeout(participantId);
    setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_IDENTIFY);
    const handle = setTimeout(() => {
      this._identifyTimeouts.delete(participantId);
      const cur = getUnitSessionState(participantId);
      if (cur?.state === DISPATCHER_STATE.AWAITING_IDENTIFY) {
        this.log('WAKE_IDENTIFY_TIMEOUT', { participant: participantId });
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE);
      }
    }, IDENTIFY_TIMEOUT_MS);
    this._identifyTimeouts.set(participantId, handle);
  }

  _clearIdentifyTimeout(participantId) {
    const t = this._identifyTimeouts.get(participantId);
    if (t) {
      clearTimeout(t);
      this._identifyTimeouts.delete(participantId);
    }
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
        const callInfo = await cadService.resolveUnitCurrentCall(unitId, { unitUuid: this._resolveUnitUuidForCallsign(unitId) });
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

      let effectiveTranscript = transcript;

      const bypass = detectEmergencyBypass(transcript, {
        hasActiveEscalation: this.emergencyEscalation.hasActiveEscalation(participantId)
      });

      if (currentState === DISPATCHER_STATE.IDLE || currentState === DISPATCHER_STATE.AWAITING_IDENTIFY) {
        const eventBypass = !!matchEventFromTranscript(transcript);
        const allClearBypass = isAllClearPhrase(transcript) && this._hasActiveAiClearAir();

        if (bypass) {
          this.log('EMERGENCY_BYPASS', { participant: participantId, transcript, phrase: bypass.phrase, fromState: currentState });
          this._clearIdentifyTimeout(participantId);
          setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_COMMAND);
        } else if (eventBypass || allClearBypass) {
          this.log('IDLE_GATE_BYPASS', { participant: participantId, transcript, reason: eventBypass ? 'event' : 'all_clear', fromState: currentState });
          this._clearIdentifyTimeout(participantId);
          setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_COMMAND);
        } else if (currentState === DISPATCHER_STATE.AWAITING_IDENTIFY) {
          const id = parseIdentify(transcript);
          this._clearIdentifyTimeout(participantId);
          if (id.kind === IDENTIFY_RESULT.REJECTED) {
            this.log('IDENTIFY_REJECTED', { participant: participantId, transcript });
            setUnitSessionState(participantId, DISPATCHER_STATE.IDLE);
            return;
          }
          if (id.kind === IDENTIFY_RESULT.IDENTIFY_UNIT_ONLY) {
            const reply = `${id.unit}, go ahead.`;
            this.logSpeechEvent(participantId, transcript, 'WAKE_IDENTIFY_UNIT_ONLY', reply);
            await this.speak(reply, participantId);
            this.addConversationExchange(participantId, transcript, reply);
            setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_COMMAND);
            return;
          }
          if (id.kind === IDENTIFY_RESULT.IDENTIFY_CENTRAL_UNIT) {
            const reply = `Go ahead ${id.unit}.`;
            this.logSpeechEvent(participantId, transcript, 'WAKE_IDENTIFY_CENTRAL_UNIT', reply);
            await this.speak(reply, participantId);
            this.addConversationExchange(participantId, transcript, reply);
            setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_COMMAND);
            return;
          }
          if (id.kind === IDENTIFY_RESULT.IDENTIFY_UNIT_WITH_REQUEST) {
            this.log('WAKE_IDENTIFY_UNIT_WITH_REQUEST', { participant: participantId, spokenUnit: id.unit, remainder: id.remainder });
            setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_COMMAND);
            effectiveTranscript = id.remainder;
          }
        } else {
          // currentState === IDLE
          const wake = parseWake(transcript);
          if (wake.kind === WAKE_RESULT.REJECTED) {
            this.verboseLog('IDLE_WAKE_REJECTED', { participant: participantId, transcript });
            return;
          }
          if (wake.kind === WAKE_RESULT.BARE_CENTRAL) {
            const prompt = 'Unit calling Central, identify.';
            this.logSpeechEvent(participantId, transcript, 'WAKE_BARE_CENTRAL', prompt);
            await this.speak(prompt, participantId);
            this.addConversationExchange(participantId, transcript, prompt);
            this._enterAwaitingIdentify(participantId);
            return;
          }
          if (wake.kind === WAKE_RESULT.WAKE_WITH_UNIT) {
            const reply = `${wake.unit}, go ahead.`;
            this.logSpeechEvent(participantId, transcript, 'WAKE_WITH_UNIT', reply);
            await this.speak(reply, participantId);
            this.addConversationExchange(participantId, transcript, reply);
            setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_COMMAND);
            return;
          }
          if (wake.kind === WAKE_RESULT.WAKE_WITH_REQUEST) {
            this.log('WAKE_WITH_REQUEST', { participant: participantId, spokenUnit: wake.unit, remainder: wake.remainder });
            setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_COMMAND);
            effectiveTranscript = wake.remainder;
          }
        }
      }

      if (isLlmConfigured()) {
        await this.processTranscriptWithLLM(effectiveTranscript, participantId);
      } else {
        await this.processTranscriptWithRegex(effectiveTranscript, participantId);
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
      { patterns: [/\btasor\s+point\b/gi, /\btazer\s+point\b/gi], replacement: 'taser point' },
      { patterns: [/\btasor\s+deployed\b/gi, /\btazer\s+deployed\b/gi], replacement: 'taser deployed' },
      { patterns: [/\bfoot\s+suit\b/gi], replacement: 'foot pursuit' },
      { patterns: [/\bin\s+custom\b/gi, /\bincome\s+study\b/gi, /\bin\s+custodian\b/gi], replacement: 'in custody' },
      { patterns: [/\bcode\s+for\b/gi, /\bcode\s+fore\b/gi], replacement: 'code 4' },
      { patterns: [/\bofficers\s+down\b/gi], replacement: 'officer down' },
      { patterns: [/\bofficer\s+need\s+help\b/gi], replacement: 'officer needs help' },
      { patterns: [/\bgun\s+point\b/gi], replacement: 'gunpoint' },
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

      // Durable status-check ack: if a status check is still pending for this
      // unit (e.g. session was already released to IDLE by the per-prompt
      // timeout), guarantee CAD sees the ack before normal handling runs.
      try { await this._maybeAckPendingStatusCheck(participantId, transcript); } catch (e) {
        this.log('STATUS_CHECK_DURABLE_ACK_ERROR', { error: e.message });
      }

      const sessionState = getUnitSessionState(participantId);
      const { state, slots } = sessionState;

      const normalized = transcript.toLowerCase();

      if (state === DISPATCHER_STATE.IDLE) {
        const normalizedForDistress = normalized.replace(/[.,!?]/g, '').replace(/\s+/g, ' ').trim();
        const matchedDistressPhrase = this._matchDistressPhrase(normalizedForDistress);
        if (matchedDistressPhrase && /^central\b/.test(normalizedForDistress)) {
          if (this._isOfficerHelpDistressType(matchedDistressPhrase.distressType)) {
            this.log('EMERGENCY_OFFICER_HELP_REROUTE_TO_LOG_EVENT_NOTE', { participant: participantId, transcript });
            this._turnContextByUnit.set(participantId, { transcript, intent: 'LOG_EVENT_NOTE' });
            await this.executeLogEventNote(participantId, transcript, { eventType: 'OFFICER_NEEDS_HELP', entries: [], description: null });
            return;
          }
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

      if (state === DISPATCHER_STATE.AWAITING_BE_ADVISED_NOTE) {
        this.log('BE_ADVISED_RETRY_FAST_PATH', { participant: participantId, transcript });
        const lower = (transcript || '').toLowerCase();
        if (/\b(disregard|cancel|nevermind|never mind|10-22|scratch that)\b/.test(lower)) {
          setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
          const resp = `${participantId}, 10-4, disregard.`;
          await this.speak(resp, participantId);
          this.addConversationExchange(participantId, transcript, resp);
          return;
        }
        this._turnContextByUnit.set(participantId, { transcript, intent: 'ADD_NOTE' });
        await this.executeBeAdvisedNote(participantId, transcript, transcript.trim());
        return;
      }

      if (state === DISPATCHER_STATE.AWAITING_CALL_DISAMBIG) {
        this.log('CALL_DISAMBIG_FAST_PATH', { participant: participantId, transcript });
        this._turnContextByUnit.set(participantId, { transcript, intent: 'CALL_DISAMBIG' });
        await this.handleCallDisambigResponse(participantId, transcript, slots);
        return;
      }

      if (state === DISPATCHER_STATE.AWAITING_DESTINATION_CLARIFY) {
        this.log('DESTINATION_CLARIFY_FAST_PATH', { participant: participantId, transcript });
        this._turnContextByUnit.set(participantId, { transcript, intent: 'DESTINATION_CLARIFY' });
        await this.handleDestinationClarify(participantId, transcript, slots);
        return;
      }

      if (state === DISPATCHER_STATE.AWAITING_SECONDARY_MILEAGE) {
        this.log('SECONDARY_MILEAGE_FAST_PATH', { participant: participantId, transcript });
        this._turnContextByUnit.set(participantId, { transcript, intent: 'SECONDARY_MILEAGE_INPUT' });
        await this.handleSecondaryMileageInput(participantId, transcript, slots);
        return;
      }

      if (state === DISPATCHER_STATE.AWAITING_ENDING_MILEAGE) {
        this.log('ENDING_MILEAGE_FAST_PATH', { participant: participantId, transcript });
        this._turnContextByUnit.set(participantId, { transcript, intent: 'ENDING_MILEAGE_INPUT' });
        await this.handleEndingMileageInput(participantId, transcript, slots);
        return;
      }

      if (state === DISPATCHER_STATE.AWAITING_MILEAGE_CONFIRM) {
        this.log('MILEAGE_CONFIRM_FAST_PATH', { participant: participantId, transcript });
        this._turnContextByUnit.set(participantId, { transcript, intent: 'MILEAGE_CONFIRM' });
        await this.handleMileageConfirm(participantId, transcript, slots);
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

      if (this.openBackupRequests.size > 0) {
        const intercepted = await this._handleOpenBackupRequestUtterance(participantId, transcript);
        if (intercepted) {
          this._turnContextByUnit.delete(participantId);
          return;
        }
      }

      if (this.routineStatusCheckEscalation.active.size > 0) {
        const intercepted = await this.routineStatusCheckEscalation.onUtterance(participantId, transcript);
        if (intercepted) {
          this._turnContextByUnit.delete(participantId);
          return;
        }
      }

      const agencyIdForApply = this._getAgencyId();
      let normalizedTranscript = transcript;
      const afterPhrasing = dispatcherLearning.applyLearnedPhrasing(normalizedTranscript, agencyIdForApply);
      const afterTenCode = dispatcherLearning.applyLearnedTenCodeSynonyms(afterPhrasing, agencyIdForApply);
      if (afterTenCode !== transcript) {
        this.log('LEARNING_TRANSCRIPT_NORMALIZED', { participant: participantId, original: transcript, normalized: afterTenCode });
        normalizedTranscript = afterTenCode;
      }

      this.log('LLM_CLASSIFY_START', { participant: participantId, state, transcript: normalizedTranscript });

      const conversationHistory = slots?.conversationHistory || [];
      const result = await classifyIntent(normalizedTranscript, participantId, state, slots, conversationHistory);

      this.log('LLM_CLASSIFY_RESULT', { participant: participantId, intent: result.intent, response: result.response, slots: result.slots });
      this._turnContextByUnit.set(participantId, { transcript, intent: result.intent });

      if (state === DISPATCHER_STATE.AWAITING_COMMAND) {
        const llmIntent = result?.intent || null;
        const isFallbackIntent = !llmIntent || llmIntent === 'OUT_OF_SCOPE' || llmIntent === 'UNKNOWN';
        if (isFallbackIntent) {
          this.log('LEARNING_TEACHING_FALLBACK_TRIGGERED', { participant: participantId, transcript, llmIntent });
          const handled = await this._handleTeachingPhrase(participantId, transcript);
          if (handled) {
            this._turnContextByUnit.delete(participantId);
            return;
          }
        }
      }

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
          this._captureLearningCorrection(participantId, speakerNorm, detected, transcript, 'STATUS_CHANGE_OTHER_REROUTED');
          result.intent = 'STATUS_CHANGE_OTHER';
          result.slots = { ...(result.slots || {}), targetUnit: detected };
          if (result.response) {
            const time = this.formatMilitaryTime();
            const statusText = result.cadStatus ? result.cadStatus.replace(/_/g, ' ') : 'updated';
            result.response = `Copy, ${detected} ${statusText}, ${time}.`;
          }
        }
      } else if (result.intent === 'STATUS_CHANGE_OTHER') {
        let llmTarget = result.slots?.targetUnit ? normalizeUnitId(result.slots.targetUnit) : null;
        if (llmTarget) {
          const aliased = dispatcherLearning.applyLearnedCallsign(llmTarget, agencyIdForApply);
          if (aliased && aliased !== llmTarget) {
            this.log('LEARNING_CALLSIGN_APPLIED', { from: llmTarget, to: aliased });
            llmTarget = normalizeUnitId(aliased);
            result.slots = { ...(result.slots || {}), targetUnit: llmTarget };
          }
        }
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
          await this.handleDisregard(participantId, transcript, result.slots || {});
          break;
        }

        case 'SECONDARY_TRIP_START': {
          await this.handleSecondaryTripStart(participantId, transcript, result.slots || {});
          break;
        }

        case 'SECONDARY_TRIP_ARRIVE': {
          await this.handleSecondaryTripArrive(participantId, transcript, result.slots || {});
          break;
        }

        case 'STATUS_CHANGE': {
          const descriptorSlots = result.slots || {};
          const hasDescriptor = !!(descriptorSlots.callNature || descriptorSlots.callLocation || descriptorSlots.callCity || descriptorSlots.callNumber);
          const statusForDescriptor = result.cadStatus === 'en_route' || result.cadStatus === 'on_scene';
          if (hasDescriptor && statusForDescriptor) {
            const handled = await this.applyStatusByDescriptor(participantId, transcript, result.cadStatus, descriptorSlots);
            if (handled) break;
          }
          // Task #482: "available" / 10-8 needs human-style triage. If the
          // unit is primary on a call with others, refuse and tell them to
          // reassign. If primary AND last unit, cascade into close-the-call
          // (with optional inline disposition). Otherwise fall through to a
          // simple status update.
          if (result.cadStatus === 'available' && cadService.isConfigured()) {
            const outcome = await this._classifyClearOutcome(participantId);
            this.log('AVAILABLE_CASCADE_OUTCOME', { unitId: participantId, kind: outcome.kind, callId: outcome.call?.callId });
            if (outcome.kind === 'primary_with_others') {
              const refuseResp = `${participantId}, you are primary on call ${outcome.call.callDisplay}, ${this._formatUnitList(outcome.otherUnits)} still on the call. Clear them first or have one take primary.`;
              await this.speak(refuseResp, participantId);
              this.addConversationExchange(participantId, transcript, refuseResp);
              setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
              break;
            }
            if (outcome.kind === 'primary_last') {
              const inlineDisp = this._extractInlineDisposition(transcript);
              if (inlineDisp) {
                // Task #482: preserve the raw spoken phrase for CAD notes;
                // canonical is for prompt + disposition code only.
                let canonical = inlineDisp;
                try {
                  const list = await cadService.getDispositions();
                  const m = cadService.matchDisposition(inlineDisp, list);
                  if (m && m.canonical) canonical = m.canonical;
                } catch (e) { /* fallback */ }
                setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_DISPOSE_CONFIRM, null, {
                  callNumber: outcome.call.callId,
                  disposition: inlineDisp,
                  dispositionCanonical: canonical,
                  dispositionNotes: inlineDisp,
                }, true);
                const dispResp = `${participantId}, confirm close call ${outcome.call.callDisplay}, ${canonical}?`;
                await this.speak(dispResp, participantId);
                this.addConversationExchange(participantId, transcript, dispResp);
                break;
              }
              const closeResp = `${participantId}, you are primary on call ${outcome.call.callDisplay}. Close the call?`;
              await this.speak(closeResp, participantId);
              this.addConversationExchange(participantId, transcript, closeResp);
              setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_PRIMARY_CLOSE_CONFIRM, null, {
                callNumber: outcome.call.callId,
                callDisplay: outcome.call.callDisplay,
              }, true);
              break;
            }
            // 'simple' → fall through to normal status update path. If we
            // were on a call (non-primary), clear off it BEFORE marking the
            // unit available so CAD never has a unit available-but-attached.
            // If CAD rejects the clear, refuse the status change.
            if (outcome.call?.callId) {
              let clearRes = null;
              try {
                clearRes = await this._awaitStatusQueue(participantId, () => cadService.clearUnit(participantId));
              } catch (e) {
                this.log('AVAILABLE_CLEAR_ERROR', { error: e.message });
                const resp = `${participantId}, unable to clear you from call ${outcome.call.callDisplay}. ${e.message || 'Try your MDT.'}`;
                await this.speak(resp, participantId);
                this.addConversationExchange(participantId, transcript, resp);
                setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
                break;
              }
              if (clearRes?.success === false) {
                this.log('AVAILABLE_CLEAR_REJECTED', { unitId: participantId, callId: outcome.call.callId, error: clearRes.error, statusCode: clearRes.statusCode });
                const resp = `${participantId}, unable to clear you from call ${outcome.call.callDisplay}. ${clearRes.error || 'Try your MDT.'}`;
                await this.speak(resp, participantId);
                this.addConversationExchange(participantId, transcript, resp);
                setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
                break;
              }
              this._clearRecentAssignment(participantId);
            }
          }
          let statusUpdateFailed = false;
          let statusFailureType = null;
          let priorStatus = null;
          let priorZone = null;
          if (result.cadStatus) {
            if (!cadService.isConfigured()) {
              statusUpdateFailed = true;
              statusFailureType = 'NOT_CONFIGURED';
              this.log('CAD_NOT_CONFIGURED', { unitId: participantId, status: result.cadStatus });
            } else {
              try {
                try {
                  const info = await cadService.getUnitInfo(participantId);
                  priorStatus = info?.status || info?.unit_status || info?.current_status || null;
                  priorZone = info?.zone || null;
                } catch (e) { /* best effort */ }
                const cadResult = await this._updateUnitStatusSerial(participantId, result.cadStatus);
                if (!cadResult || !cadResult.success) {
                  statusUpdateFailed = true;
                  statusFailureType = cadResult?.failureType || 'API_REJECTION';
                  this.log('CAD_STATUS_UPDATE_FAILED', { unitId: participantId, status: result.cadStatus, failureType: statusFailureType, error: cadResult?.error, statusCode: cadResult?.statusCode, responseBody: cadResult?.responseBody });
                }
                this.log('CAD_STATUS_UPDATE', { unitId: participantId, status: result.cadStatus, success: cadResult?.success });
                if (cadResult?.success) {
                  recordAction(participantId, 'STATUS_CHANGE', {
                    summary: `status change to ${result.cadStatus}`,
                    data: { newStatus: result.cadStatus, priorStatus, priorZone }
                  });
                }
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
          let otherPriorStatus = null;
          if (result.cadStatus) {
            if (!cadService.isConfigured()) {
              otherStatusFailed = true;
              otherStatusFailureType = 'NOT_CONFIGURED';
              this.log('CAD_NOT_CONFIGURED', { unitId: targetUnit, requestedBy: participantId, status: result.cadStatus });
            } else {
              try {
                try {
                  const info = await cadService.getUnitInfo(targetUnit);
                  otherPriorStatus = info?.status || info?.unit_status || info?.current_status || null;
                } catch (e) { /* best effort */ }
                const cadResult = await this._updateUnitStatusSerial(targetUnit, result.cadStatus);
                if (!cadResult || !cadResult.success) {
                  otherStatusFailed = true;
                  otherStatusFailureType = cadResult?.failureType || 'API_REJECTION';
                  this.log('CAD_STATUS_OTHER_FAILED', { targetUnit, requestedBy: participantId, status: result.cadStatus, failureType: otherStatusFailureType, error: cadResult?.error });
                }
                this.log('CAD_STATUS_OTHER_UPDATE', { targetUnit, requestedBy: participantId, status: result.cadStatus, success: cadResult?.success });
                if (cadResult?.success) {
                  recordAction(participantId, 'STATUS_CHANGE_OTHER', {
                    summary: `${targetUnit} status to ${result.cadStatus}`,
                    data: { targetUnit, newStatus: result.cadStatus, priorStatus: otherPriorStatus }
                  });
                }
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
          } else if (state === DISPATCHER_STATE.AWAITING_PRIMARY_CLOSE_CONFIRM) {
            await this.handlePrimaryCloseConfirm(participantId, transcript, slots);
          } else if (state === DISPATCHER_STATE.AWAITING_CANCEL_CONFIRM) {
            await this.handleCancelConfirm(participantId, transcript, slots);
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
          } else if (state === DISPATCHER_STATE.AWAITING_PRIMARY_CLOSE_CONFIRM) {
            setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
            const primDenyResp = `${participantId}, 10-4, leaving the call open.`;
            await this.speak(primDenyResp, participantId);
            this.addConversationExchange(participantId, transcript, primDenyResp);
          } else if (state === DISPATCHER_STATE.AWAITING_CANCEL_CONFIRM) {
            setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
            const cancelDenyResp = `${participantId}, 10-4, disregard cancel.`;
            await this.speak(cancelDenyResp, participantId);
            this.addConversationExchange(participantId, transcript, cancelDenyResp);
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

        case 'BACKUP_REQUEST_START': {
          await this.handleBackupRequestStart(participantId, transcript);
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
              await this._updateUnitStatusSerial(participantId, result.cadStatus);
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

        case 'SHOW_OUT_WITH': {
          await this.handleShowOutWith(participantId, transcript, result.slots);
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

        case 'LOG_EVENT_NOTE': {
          const slots = result.slots || {};
          await this.executeLogEventNote(participantId, transcript, {
            eventType: slots.eventType || result.eventType,
            entries: slots.entries || result.entries || [],
            description: slots.description || result.description || null,
            vehicleConfidence: slots.vehicleConfidence ?? result.vehicleConfidence,
            response: result.response,
          });
          break;
        }

        case 'EVENT_ALL_CLEAR': {
          await this.executeEventAllClear(participantId, transcript, 'llm_all_clear');
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

        case 'CANCEL_CALL': {
          if (state === DISPATCHER_STATE.AWAITING_CANCEL_REASON) {
            await this.handleCancelReasonInput(participantId, transcript, slots, result.slots);
          } else {
            await this.handleCancelCall(participantId, transcript, result.slots);
          }
          break;
        }

        case 'REOPEN_CALL': {
          await this.handleReopenCall(participantId, transcript, result.slots);
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

        case 'MAKE_PRIMARY': {
          await this.handleMakePrimary(participantId, transcript, result.slots || {});
          break;
        }

        case 'ANIMAL_SEARCH': {
          await this.handleAnimalSearch(participantId, transcript, result.slots);
          break;
        }

        case 'SNOOZE_STATUS_CHECKS': {
          await this.handleSnoozeStatusChecks(participantId, transcript, result.slots || {});
          break;
        }

        case 'CANCEL_STATUS_CHECKS': {
          await this.handleCancelStatusChecks(participantId, transcript, result.slots || {});
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
    // Durable status-check ack: same guarantee as in the LLM path.
    try { await this._maybeAckPendingStatusCheck(participantId, transcript); } catch (e) {
      this.log('STATUS_CHECK_DURABLE_ACK_ERROR', { error: e.message });
    }
    // SEQ-10/11 regex fallback: cancel/reopen call by number. Run before
    // matchCommand so these short commands fire even when the LLM is down.
    const lower = String(transcript || '').toLowerCase();
    const reopenMatch = lower.match(/\breopen(?:\s+the)?\s+call\s+([a-z0-9][a-z0-9\-]*)/i);
    if (reopenMatch) {
      const callNumber = reopenMatch[1].toUpperCase();
      this._turnContextByUnit.set(participantId, { transcript, intent: 'REOPEN_CALL' });
      await this.handleReopenCall(participantId, transcript, { callNumber });
      return;
    }
    const cancelMatch = lower.match(/\b(?:cancel|void)(?:\s+the)?\s+call(?:\s+([a-z0-9][a-z0-9\-]*))?(?:[,\s]+(.+))?$/i);
    if (cancelMatch) {
      const callNumber = cancelMatch[1] ? cancelMatch[1].toUpperCase() : null;
      const reason = (cancelMatch[2] || '').trim() || null;
      this._turnContextByUnit.set(participantId, { transcript, intent: 'CANCEL_CALL' });
      await this.handleCancelCall(participantId, transcript, { callNumber, reason });
      return;
    }

    // Task #509: regex fast-path for per-call "suspend status checks"
    // phrases so the cancel works even when the LLM classifier is down.
    const suspendCheckRegex = /\b(extended\s+traffic\s+stop|extended\s+scene|long[-\s]term\s+scene|suspend\s+status\s+check(?:s)?|stop\s+status\s+check(?:s)?(?:\s+for\s+this\s+call)?|no\s+status\s+checks?\s+until\s+i\s+clear|no\s+more\s+status\s+check(?:s)?|cancel\s+(?:the\s+)?status\s+check(?:s)?|kill\s+(?:the\s+)?status\s+check(?:s)?)\b/i;
    if (suspendCheckRegex.test(lower)) {
      this._turnContextByUnit.set(participantId, { transcript, intent: 'CANCEL_STATUS_CHECKS' });
      await this.handleCancelStatusChecks(participantId, transcript, {});
      return;
    }

    const commandResult = matchCommand(transcript, participantId);
    if (!commandResult) {
      this.log('COMMAND_NO_MATCH', { transcript });
      return;
    }

    this._turnContextByUnit.set(participantId, { transcript, intent: commandResult.intent });

    if (commandResult.intent === 'LOG_EVENT_NOTE') {
      await this.executeLogEventNote(participantId, transcript, {
        eventType: commandResult.eventType,
        entries: commandResult.entries || [],
        description: commandResult.description || null,
      });
      return;
    }

    if (commandResult.intent === 'EVENT_ALL_CLEAR') {
      await this.executeEventAllClear(participantId, transcript, 'regex_all_clear');
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
      const cadTargetUnit = commandResult.targetUnit || commandResult.unitId;
      try {
        const cadResult = await this._updateUnitStatusSerial(cadTargetUnit, finalCadStatus);
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
    
    const dobSpoken = this._formatSpokenDate(dob);
    const confirmResponse = `${participantId}, confirming. Last ${lastName}, first ${firstName}, date of birth ${dobSpoken || dob}. 10-4?`;
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
    
    const dobSpoken = this._formatSpokenDate(dobFormatted);
    const confirmResponse = `${participantId}, confirming. Last ${lastName}, first ${firstName}, date of birth ${dobSpoken || dobFormatted}. 10-4?`;
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
    const { hour: hourNum, minute: minuteNum } = formatLocalSpokenTime24(new Date());

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
    let priorZone = null;
    if (!cadService.isConfigured()) {
      zoneUpdateFailed = true;
      zoneFailureType = 'NOT_CONFIGURED';
      this.log('CAD_NOT_CONFIGURED', { participantId, zone });
    } else {
      try {
        try {
          const info = await cadService.getUnitInfo(participantId);
          priorZone = info?.zone || null;
        } catch (e) { /* best effort */ }
        const cadResult = await cadService.updateUnitZone(participantId, zone);
        if (!cadResult || !cadResult.success) {
          zoneUpdateFailed = true;
          zoneFailureType = cadResult?.failureType || 'API_REJECTION';
          this.log('CAD_ZONE_UPDATE_FAILED', { participantId, zone, failureType: zoneFailureType, error: cadResult?.error, statusCode: cadResult?.statusCode, responseBody: cadResult?.responseBody });
        }
        this.log('CAD_ZONE_UPDATED', { participantId, zone, success: cadResult?.success });
        if (cadResult?.success) {
          recordAction(participantId, 'ZONE_CHANGE', {
            summary: `zone change to ${zone}`,
            data: { newZone: zone, priorZone }
          });
        }
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
          this._captureLearningCorrection(participantId, existingLocation, fullCorrection, rawTranscript, 'DETAIL_LLM_CORRECTION');
          await this.handleDetailConfirmPrompt(participantId, fullCorrection);
          return;
        }
        if (correctedCity) {
          const existParts = existingLocation.split(',').map(p => p.trim()).filter(Boolean);
          const street = existParts[0] || '';
          const cityPart = correctedState ? `${correctedCity}, ${correctedState}` : correctedCity;
          const merged = street ? `${street}, ${cityPart}` : cityPart;
          this.log('DETAIL_LLM_CITY_CORRECTION', { participantId, existing: existingLocation, correctedCity, merged });
          this._captureLearningCorrection(participantId, existingLocation, merged, rawTranscript, 'DETAIL_LLM_CITY_CORRECTION');
          await this.handleDetailConfirmPrompt(participantId, merged);
          return;
        }
      }

      const correctionText = this.extractPartialCorrection(normalized);
      
      if (correctionText && existingLocation) {
        const mergedLocation = this.mergeAddressCorrection(existingLocation, correctionText);
        this.log('DETAIL_PARTIAL_CORRECTION', { participantId, existing: existingLocation, correction: correctionText, merged: mergedLocation });
        this._captureLearningCorrection(participantId, existingLocation, mergedLocation, rawTranscript, 'DETAIL_PARTIAL_CORRECTION');
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
    let priorDetailStatus = null;
    let priorDetailZone = null;
    if (!cadService.isConfigured()) {
      detailUpdateFailed = true;
      detailFailureType = 'NOT_CONFIGURED';
      this.log('CAD_NOT_CONFIGURED', { participantId, location });
    } else {
      try {
        try {
          const info = await cadService.getUnitInfo(participantId);
          priorDetailStatus = info?.status || info?.unit_status || info?.current_status || null;
          priorDetailZone = info?.zone || null;
        } catch (e) { /* best effort */ }
        const statusResult = await this._updateUnitStatusSerial(participantId, 'detail');
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
            recordAction(participantId, 'DETAIL', {
              summary: `detail at ${location}`,
              data: { location, priorStatus: priorDetailStatus, priorZone: priorDetailZone }
            });
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
    if (disregardPhrases.some(p => normalized.includes(p)) && ownsInFlight(participantId)) {
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
    if (disregardPhrases.some(p => normalized.includes(p)) && ownsInFlight(participantId)) {
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
        const resp = `${participantId}, 10-4, ${timeStr}.`;
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

      recordAction(participantId, 'CREATE_CALL', {
        summary: `call ${callNumber} (${nature.toLowerCase()})`,
        data: { callId, callNumber, nature, address }
      });

      const createdCallSnapshot = { call_id: callId, call_number: callNumber, location: address, nature, priority };
      this._recordRecentAssignment(participantId, createdCallSnapshot);
      for (const unitId of (units || [])) {
        if (normalizeUnitId(unitId) !== normalizeUnitId(participantId)) {
          this._recordRecentAssignment(unitId, createdCallSnapshot);
        }
      }

      if (additionalUnits && additionalUnits.length > 0 && units.length <= 1) {
        for (const unitId of additionalUnits) {
          try {
            await this._assignUnitToCallSerial(unitId, callId);
            this.log('CAD_ADDITIONAL_UNIT_ASSIGNED', { unitId, callId });
            this._recordRecentAssignment(unitId, createdCallSnapshot);
          } catch (assignError) {
            this.log('CAD_ADDITIONAL_UNIT_ASSIGN_ERROR', { unitId, callId, error: assignError.message });
          }
        }
      }

      try {
        await this._updateUnitStatusSerial(participantId, unitStatus);
        this.log('CAD_STATUS_UPDATED', { unitId: participantId, status: unitStatus });
      } catch (statusError) {
        this.log('CAD_STATUS_UPDATE_ERROR', { unitId: participantId, error: statusError.message });
      }

      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      const timeStr = this.formatMilitaryTime();
      const resp = `${participantId}, 10-4, ${timeStr}.`;
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
    
    const dobSpoken = this._formatSpokenDate(dob);
    const confirmResponse = `${participantId}, confirming. Last ${lastName}, first ${firstName}, date of birth ${dobSpoken || dob}. 10-4?`;
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
      
      const dobUtc = dob ? localDateToUtcDate(dob) : null;
      const outboundBody = {
        first_name: (firstName || '').toUpperCase(),
        last_name: (lastName || '').toUpperCase(),
        ...(dobUtc ? { dob: dobUtc } : {})
      };
      this.log('PERSON_SEARCH_TRACE', {
        participantId,
        tz: DISPATCHER_TZ,
        finalSlots: { firstName, lastName, dobLocal: dob, dobUtc },
        outboundCadBody: outboundBody
      });
      this.log('CAD_PERSON_QUERY_SENDING', { participantId, firstName, lastName, dobLocal: dob, dobUtc, tz: DISPATCHER_TZ });
      let cadResult = await cadService.queryPerson(firstName, lastName, dobUtc);
      this.log('CAD_PERSON_QUERY_RESULT', { participantId, result: cadResult });

      try {
        const firstResult = (cadResult.results && cadResult.results[0]) || cadResult.person || cadResult.record || null;
        const returnedDobRaw = firstResult ? (firstResult.dob || firstResult.date_of_birth || null) : null;
        const returnedDobLocal = returnedDobRaw ? (utcDateToLocalDate(returnedDobRaw) || returnedDobRaw) : null;
        this.log('PERSON_SEARCH_TRACE_RESULT', {
          participantId,
          returnedDobUtc: returnedDobRaw,
          returnedDobLocal,
          spokenDob: returnedDobLocal ? this._formatSpokenDate(returnedDobLocal) : (dob ? this._formatSpokenDate(dob) : null)
        });
      } catch (traceErr) {
        this.log('PERSON_SEARCH_TRACE_RESULT_ERROR', { error: traceErr.message });
      }

      let broadened = false;
      let broadenedDescription = '';

      if (cadResult.success && this._personResultCount(cadResult) === 0 && (firstName || dob)) {
        if (dobUtc) {
          this.log('PERSON_CHECK_BROADENING', { step: 'lastName+dob', lastName, dobLocal: dob, dobUtc });
          const retry1 = await cadService.queryPerson('', lastName, dobUtc);
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

      const spokenDob = dob ? this._formatSpokenDate(dob) : '';
      if (broadened && results.length > 1) {
        const nameList = results.map(r => {
          const fn = r.first_name || r.firstName || '';
          const ln = r.last_name || r.lastName || '';
          const rawRdob = r.dob || r.date_of_birth || '';
          const rdobLocal = rawRdob ? utcDateToLocalDate(rawRdob) : '';
          const rdobSpoken = rdobLocal ? this._formatSpokenDate(rdobLocal) : '';
          return rdobSpoken ? `${fn} ${ln}, date of birth ${rdobSpoken}` : `${fn} ${ln}`;
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
    const dobSpoken = dob ? this._formatSpokenDate(dob) : '';
    const flagResponse = `${participantId}, Central. ${lastName}, ${firstName}, date of birth ${dobSpoken || dob} returns ${flagText}. Use caution.`;
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

  resolveCallByDescriptor(activeCalls, descriptor, restrictTo = null) {
    const pool = restrictTo && restrictTo.length ? restrictTo : (activeCalls || []);
    if (!pool.length) return { match: null, candidates: [] };

    if (descriptor?.callNumber) {
      const direct = this.resolveShorthandCallNumber(descriptor.callNumber, pool);
      if (direct) return { match: direct, candidates: [direct] };
    }

    const natureLower = (descriptor?.callNature || '').toLowerCase().trim();
    const locLower = (descriptor?.callLocation || '').toLowerCase().trim();
    const cityLower = (descriptor?.callCity || '').toLowerCase().trim();

    if (!natureLower && !locLower && !cityLower) {
      return { match: null, candidates: [] };
    }

    const scored = pool.map(call => {
      const cNature = (call.nature || call.type || call.call_type || '').toLowerCase();
      const cLoc = (call.location || call.address || '').toLowerCase();
      let score = 0;
      let constraints = 0;
      let matched = 0;

      if (natureLower) {
        constraints++;
        if (cNature.includes(natureLower)) {
          score += 4;
          matched++;
        } else {
          const tokens = natureLower.split(/\s+/).filter(t => t.length > 2);
          if (tokens.length && tokens.every(t => cNature.includes(t))) {
            score += 3;
            matched++;
          }
        }
      }

      if (locLower) {
        constraints++;
        if (cLoc.includes(locLower)) {
          score += 4;
          matched++;
        } else {
          const tokens = locLower.split(/\s+/).filter(t => t.length > 2);
          if (tokens.length && tokens.every(t => cLoc.includes(t))) {
            score += 2;
            matched++;
          }
        }
      }

      if (cityLower) {
        constraints++;
        if (cLoc.includes(cityLower)) {
          score += 3;
          matched++;
        }
      }

      return { call, score, matched, constraints };
    }).filter(s => s.constraints > 0 && s.matched === s.constraints);

    if (!scored.length) return { match: null, candidates: [] };

    scored.sort((a, b) => b.score - a.score);
    const topScore = scored[0].score;
    const winners = scored.filter(s => s.score === topScore).map(s => s.call);

    if (winners.length === 1) return { match: winners[0], candidates: winners };
    return { match: null, candidates: winners };
  }

  _describeCallShort(call) {
    const nature = call.nature || call.type || call.call_type || 'call';
    const loc = call.location || call.address || '';
    return loc ? `the ${nature.toLowerCase()} at ${loc}` : `the ${nature.toLowerCase()}`;
  }

  _describeNoun(slots) {
    if (slots?.callNature) return `${slots.callNature.toLowerCase()}`;
    if (slots?.callLocation) return `call at ${slots.callLocation}`;
    if (slots?.callCity) return `call in ${slots.callCity}`;
    return 'call';
  }

  _packCandidate(call) {
    return {
      call_id: call.call_id || call.id || call.call_number,
      call_number: call.call_number || call.id,
      nature: call.nature || call.type || call.call_type || null,
      location: call.location || call.address || null,
    };
  }

  async _promptCallDisambig(participantId, transcript, candidates, descriptorSlots, verb) {
    const packed = candidates.slice(0, 4).map(c => this._packCandidate(c));
    const optionsSpoken = packed.map(c => {
      if (c.location) return `the one at ${c.location}`;
      if (c.nature) return `the ${c.nature.toLowerCase()}`;
      return `call ${c.call_number}`;
    });

    const noun = descriptorSlots?.callNature ? `${descriptorSlots.callNature.toLowerCase()}s` : 'matching calls';
    const list = optionsSpoken.length === 2
      ? `${optionsSpoken[0]} or ${optionsSpoken[1]}`
      : optionsSpoken.slice(0, -1).join(', ') + `, or ${optionsSpoken[optionsSpoken.length - 1]}`;
    const resp = `${participantId}, ${packed.length} ${noun} active — ${list}?`;

    setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_CALL_DISAMBIG, null, {
      disambigCandidates: packed,
      disambigVerb: verb,
      disambigOriginalSlots: descriptorSlots || {},
    }, true);
    await this.speak(resp, participantId);
    this.addConversationExchange(participantId, transcript, resp);
  }

  async _executeCallVerb(participantId, transcript, targetCall, verb) {
    const callId = targetCall.call_id || targetCall.id || targetCall.call_number;
    const callDisplay = targetCall.call_number || callId;

    const assignResult = await this._assignUnitToCallSerial(participantId, callId);
    if (assignResult?.success === false) {
      const resp = `${participantId}, unable to assign to ${callDisplay}.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      return;
    }
    this.log('UNIT_ASSIGNED_TO_CALL', { unitId: participantId, callId, callDisplay, verb });
    recordAction(participantId, 'ASSIGN_CALL', {
      summary: `attached to ${callDisplay}`,
      data: { callId, callDisplay }
    });
    this._recordRecentAssignment(participantId, targetCall, { callId, callDisplay });

    let cadStatus = null;
    let statusWord = '';
    if (verb === 'en_route') {
      cadStatus = 'en_route';
      statusWord = 'en route';
    } else if (verb === 'on_scene') {
      cadStatus = 'on_scene';
      statusWord = 'on scene';
    }

    if (cadStatus) {
      try {
        const statusResult = await this._updateUnitStatusSerial(participantId, cadStatus);
        this.log('CAD_STATUS_UPDATE', { unitId: participantId, status: cadStatus, success: statusResult?.success, callId });
      } catch (e) {
        this.log('CAD_ERROR', { error: e.message });
      }
    }

    const time = this.formatMilitaryTime();
    let resp;
    // Task #486 (Step 3): keep routine acks short — drop call number; the
    // unit just said it, no need to read it back. Only safety-critical paths
    // (primary refusal, close confirms) still echo the call number.
    if (verb === 'assign') {
      resp = `${participantId}, 10-4.`;
    } else {
      resp = `${participantId}, copy, ${statusWord}, ${time}.`;
    }
    await this.speak(resp, participantId);
    this.addConversationExchange(participantId, transcript, resp);
    setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
  }

  // Task #482: when a unit asks to attach/route to a call but is already on a
  // *different* one, behave like a human dispatcher: refuse if they're primary
  // with others on the old call, prompt for close if primary-last, otherwise
  // silently clear them off the old call before attaching to the new one.
  // Returns true when fully handled (caller must NOT proceed), false when the
  // caller should fall through to its normal assign/status path.
  async _handleImplicitReassign(participantId, transcript, targetCall, verb) {
    const targetCallId = String(targetCall?.call_id || targetCall?.id || targetCall?.call_number || '');
    if (!targetCallId) return false;
    let currentInfo = null;
    try {
      currentInfo = await cadService.resolveUnitCurrentCall(participantId, { unitUuid: this._resolveUnitUuidForCallsign(participantId) });
    } catch (e) {
      this.log('IMPLICIT_REASSIGN_LOOKUP_ERROR', { error: e.message });
      return false;
    }
    const currentId = currentInfo?.call_id || currentInfo?.call_number || currentInfo?.callNumber || null;
    if (!currentId) return false; // not on any call → normal assign path
    if (String(currentId).toUpperCase() === targetCallId.toUpperCase()) {
      return false; // already on the target call → normal status update path
    }
    // Speaker is on a different call. Classify before mutating.
    const outcome = await this._classifyClearOutcome(participantId);
    this.log('IMPLICIT_REASSIGN_CLASSIFY', { unitId: participantId, kind: outcome.kind, fromCall: currentId, toCall: targetCallId });
    if (outcome.kind === 'primary_with_others') {
      const refuseResp = `${participantId}, you are primary on call ${outcome.call.callDisplay}, ${this._formatUnitList(outcome.otherUnits)} still on the call. Clear them first or have one take primary.`;
      await this.speak(refuseResp, participantId);
      this.addConversationExchange(participantId, transcript, refuseResp);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      return true;
    }
    if (outcome.kind === 'primary_last') {
      const closeResp = `${participantId}, you are primary on call ${outcome.call.callDisplay}. Close the call first?`;
      await this.speak(closeResp, participantId);
      this.addConversationExchange(participantId, transcript, closeResp);
      setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_PRIMARY_CLOSE_CONFIRM, null, {
        callNumber: outcome.call.callId,
        callDisplay: outcome.call.callDisplay,
      }, true);
      return true;
    }
    // 'simple' — clear off the old call BEFORE proceeding. If CAD rejects the
    // clear (success:false or thrown), refuse the reassign rather than risk a
    // half-state where the unit is attached to two calls.
    let clearResult = null;
    try {
      clearResult = await this._awaitStatusQueue(participantId, () => cadService.clearUnit(participantId));
    } catch (e) {
      this.log('IMPLICIT_REASSIGN_CLEAR_ERROR', { error: e.message });
      const resp = `${participantId}, unable to clear you from call ${currentId}. ${e.message || 'Try your MDT.'}`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      return true;
    }
    if (clearResult?.success === false) {
      this.log('IMPLICIT_REASSIGN_CLEAR_REJECTED', { unitId: participantId, fromCall: currentId, error: clearResult.error, statusCode: clearResult.statusCode });
      const resp = `${participantId}, unable to clear you from call ${currentId}. ${clearResult.error || 'Try your MDT.'}`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      return true;
    }
    this._clearRecentAssignment(participantId);
    this.log('IMPLICIT_REASSIGN_CLEARED', { unitId: participantId, fromCall: currentId });
    await this._executeCallVerb(participantId, transcript, targetCall, verb);
    return true;
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

      const { match, candidates } = this.resolveCallByDescriptor(activeCalls, slots);

      if (match) {
        // Task #482: implicit re-assignment — if the speaker is currently on a
        // different call, treat this as "clear from old, attach to new" but
        // refuse cleanly when they're primary with others still on the old call.
        const handled = await this._handleImplicitReassign(participantId, transcript, match, 'assign');
        if (handled) return;
        await this._executeCallVerb(participantId, transcript, match, 'assign');
        return;
      }

      if (candidates.length > 1) {
        await this._promptCallDisambig(participantId, transcript, candidates, slots, 'assign');
        return;
      }

      const resp = `${participantId}, no active ${this._describeNoun(slots)} found.`;
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

  async applyStatusByDescriptor(participantId, transcript, cadStatus, slots) {
    if (!cadService.isConfigured()) return false;
    const verb = cadStatus === 'en_route' ? 'en_route' : 'on_scene';
    this.log('STATUS_BY_DESCRIPTOR', { participant: participantId, cadStatus, slots });
    try {
      const callsResult = await cadService.getActiveCalls();
      const activeCalls = callsResult.calls || callsResult.results || [];
      const { match, candidates } = this.resolveCallByDescriptor(activeCalls, slots);
      if (match) {
        // Task #482: implicit re-assign when on a different call.
        const handled = await this._handleImplicitReassign(participantId, transcript, match, verb);
        if (handled) return true;
        await this._executeCallVerb(participantId, transcript, match, verb);
        return true;
      }
      if (candidates.length > 1) {
        await this._promptCallDisambig(participantId, transcript, candidates, slots, verb);
        return true;
      }
      const resp = `${participantId}, no active ${this._describeNoun(slots)} found.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      return true;
    } catch (e) {
      this.log('STATUS_BY_DESCRIPTOR_ERROR', { error: e.message });
      return false;
    }
  }

  async handleCallDisambigResponse(participantId, transcript, savedSlots) {
    const candidates = savedSlots?.disambigCandidates || [];
    const verb = savedSlots?.disambigVerb || 'assign';
    const original = savedSlots?.disambigOriginalSlots || {};

    if (!candidates.length) {
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      return;
    }

    const lower = (transcript || '').toLowerCase();
    if (/\b(disregard|cancel|nevermind|never mind|10-22|scratch that)\b/.test(lower)) {
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      const resp = `${participantId}, 10-4, disregard.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      return;
    }

    const ordinal = lower.match(/\b(first|second|third|fourth|one|two|three|four|1st|2nd|3rd|4th)\b/);
    let chosen = null;
    if (ordinal) {
      const idxMap = { first:0,one:0,'1st':0, second:1,two:1,'2nd':1, third:2,three:2,'3rd':2, fourth:3,four:3,'4th':3 };
      const idx = idxMap[ordinal[1]];
      if (idx != null && idx < candidates.length) chosen = candidates[idx];
    }

    if (!chosen) {
      const directNum = transcript.match(/\b(\d{2,7})\b/);
      if (directNum) {
        const c = this.resolveShorthandCallNumber(directNum[1], candidates.map(p => ({
          call_number: p.call_number,
          call_id: p.call_id,
        })));
        if (c) chosen = candidates.find(p => (p.call_id || p.call_number) === (c.call_id || c.call_number));
      }
    }

    if (!chosen) {
      const merged = {
        callNature: original.callNature,
        callLocation: original.callLocation,
        callCity: original.callCity,
      };
      const txt = lower;
      const numberedStreet = txt.match(/\b(\d+\s+[a-z][a-z\s]{2,}?)\b(?:\s+(?:street|st|avenue|ave|road|rd|drive|dr|lane|ln|boulevard|blvd|court|ct|place|pl)\b)?/i);
      if (numberedStreet) merged.callLocation = numberedStreet[1].trim();
      const cityHint = txt.match(/\bin\s+([a-z][a-z\s]{2,30})$/i);
      if (cityHint) merged.callCity = cityHint[1].trim();

      const restrictPool = candidates.map(p => ({
        call_id: p.call_id,
        call_number: p.call_number,
        nature: p.nature,
        location: p.location,
      }));
      const { match, candidates: stillMulti } = this.resolveCallByDescriptor(restrictPool, merged, restrictPool);
      if (match) {
        chosen = candidates.find(p => (p.call_id || p.call_number) === (match.call_id || match.call_number)) || match;
      } else if (stillMulti.length > 1) {
        await this._promptCallDisambig(participantId, transcript, stillMulti, merged, verb);
        return;
      }
    }

    if (!chosen) {
      const resp = `${participantId}, didn't catch which one — say the address or the city.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      return;
    }

    await this._executeCallVerb(participantId, transcript, chosen, verb);
  }

  async handleShowOutWith(participantId, transcript, slots) {
    this.log('SHOW_OUT_WITH', { participant: participantId, transcript, slots });

    if (!cadService.isConfigured()) {
      const resp = `${participantId}, CAD system not available.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      return;
    }

    let targetUnit = slots?.targetUnit ? normalizeUnitId(slots.targetUnit) : null;
    if (!targetUnit) {
      targetUnit = detectTargetUnitFromTranscript(transcript);
    }
    if (!targetUnit) {
      const resp = `${participantId}, say again — out with which unit?`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      return;
    }

    try {
      const targetCall = await cadService.resolveUnitCurrentCall(targetUnit, { unitUuid: this._resolveUnitUuidForCallsign(targetUnit) });
      const callId = targetCall?.call_id || targetCall?.call_number || targetCall?.callNumber;
      if (!callId) {
        const resp = `${participantId}, ${targetUnit} is not currently on a call.`;
        await this.speak(resp, participantId);
        this.addConversationExchange(participantId, transcript, resp);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
        return;
      }

      const callDisplay = targetCall.call_number || callId;
      const assignResult = await this._assignUnitToCallSerial(participantId, callId);
      if (assignResult?.success === false) {
        const resp = `${participantId}, unable to attach you to ${targetUnit}'s call.`;
        await this.speak(resp, participantId);
        this.addConversationExchange(participantId, transcript, resp);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
        return;
      }

      try {
        await this._updateUnitStatusSerial(participantId, 'on_scene');
      } catch (e) {
        this.log('CAD_ERROR', { error: e.message });
      }

      this.log('SHOW_OUT_WITH_OK', { unitId: participantId, withUnit: targetUnit, callId, callDisplay });
      this._recordRecentAssignment(participantId, targetCall, { callId, callDisplay });
      const time = this.formatMilitaryTime();
      const resp = `${participantId}, copy, on scene with ${targetUnit}, ${time}.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
    } catch (error) {
      this.log('SHOW_OUT_WITH_ERROR', { error: error.message });
      const resp = `${participantId}, unable to attach to ${targetUnit}'s call. System error.`;
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
          const callData = await cadService.resolveUnitCurrentCall(targetUnitId, { unitUuid: this._resolveUnitUuidForCallsign(targetUnitId) });
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
        const myCall = await cadService.resolveUnitCurrentCall(participantId, { unitUuid: this._resolveUnitUuidForCallsign(participantId) });
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
      const assignResult = await this._assignUnitToCallSerial(targetUnit, callId);
      if (assignResult?.success === false) {
        const resp = `${participantId}, unable to assign ${targetUnit} to that call.`;
        await this.speak(resp, participantId);
        this.addConversationExchange(participantId, transcript, resp);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
        return;
      }
      this.log('OTHER_UNIT_ASSIGNED_TO_CALL', { unitId: targetUnit, callId, callDisplay, requestedBy: participantId });
      recordAction(participantId, 'ASSIGN_OTHER_UNIT', {
        summary: `${targetUnit} attached to ${callDisplay}`,
        data: { targetUnit, callId, callDisplay }
      });
      this._recordRecentAssignment(targetUnit, targetCall || {}, { callId, callDisplay });

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
    const beAdvised = !!slots?.beAdvised;

    if (beAdvised) {
      const raw = (noteContent && noteContent.trim().length > 2) ? noteContent.trim() : transcript.trim();
      await this.executeBeAdvisedNote(participantId, transcript, raw);
      return;
    }

    if (noteContent && noteContent.trim().length > 2) {
      await this.executeAddNote(participantId, transcript, noteContent.trim());
    } else {
      setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_NOTE_CONTENT, null, {}, true);
      const resp = `${participantId}, go ahead with your note.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
    }
  }

  async executeBeAdvisedNote(participantId, transcript, rawContent) {
    try {
      if (!cadService.isConfigured()) {
        const resp = `${participantId}, CAD system not available.`;
        await this.speak(resp, participantId);
        this.addConversationExchange(participantId, transcript, resp);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
        return;
      }

      const currentCall = await cadService.resolveUnitCurrentCall(participantId, { unitUuid: this._resolveUnitUuidForCallsign(participantId) });
      const callId = currentCall?.call_id || currentCall?.call_number || currentCall?.callNumber;
      if (!callId) {
        const resp = `${participantId}, you're not assigned to a call.`;
        await this.speak(resp, participantId);
        this.addConversationExchange(participantId, transcript, resp);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
        return;
      }

      let rewriteResult;
      try {
        rewriteResult = await rewriteCallNote(participantId, rawContent);
      } catch (e) {
        this.log('BE_ADVISED_REWRITE_ERROR', { error: e.message });
        rewriteResult = { note: rawContent, confidence: 'medium', rewritten: false };
      }

      this.log('BE_ADVISED_REWRITE', { participantId, raw: rawContent, note: rewriteResult.note, confidence: rewriteResult.confidence });

      if (rewriteResult.confidence === 'low' || !rewriteResult.note) {
        const resp = `${participantId}, didn't catch that note — say again?`;
        setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_BE_ADVISED_NOTE, null, {}, true);
        await this.speak(resp, participantId);
        this.addConversationExchange(participantId, transcript, resp);
        return;
      }

      const noteText = `${participantId}: ${rewriteResult.note}`;
      const noteResult = await this._addCallNoteSerial(participantId, callId, noteText);
      if (noteResult?.success === false) {
        const category = noteResult.failureCategory || cadService.categorizeNoteFailure(noteResult) || 'unknown';
        await this._recordNoteFailure('be_advised', {
          participantId, callId, noteLength: noteText.length, noteResult,
        });
        const reasonSpoken = this._noteFailureCategorySpoken(category);
        const resp = `${participantId}, unable to add note — ${reasonSpoken}, try again.`;
        await this.speak(resp, participantId);
        this.addConversationExchange(participantId, transcript, resp);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
        return;
      }

      this.log('BE_ADVISED_NOTE_ADDED', { unitId: participantId, callId, note: rewriteResult.note });
      this.logSpeechEvent(participantId, transcript, 'ADD_NOTE_BE_ADVISED', null);
      const ack = `${participantId}, 10-4.`;
      await this.speak(ack, participantId);
      this.addConversationExchange(participantId, transcript, ack);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
    } catch (error) {
      this.log('BE_ADVISED_ERROR', { error: error.message });
      const resp = `${participantId}, unable to add note. System error.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
    }
  }

  async handleNoteContentInput(participantId, transcript, savedSlots) {
    this.log('NOTE_CONTENT_INPUT', { participant: participantId, transcript });

    const normalized = transcript.toLowerCase().trim();
    const disregardPhrases = ['disregard', 'cancel', 'cancel that', 'nevermind', 'never mind', '10-22', 'scratch that'];
    if (disregardPhrases.some(p => normalized.includes(p)) && ownsInFlight(participantId)) {
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

  async _activateAiClearAir(originUnit, eventType) {
    const channelKey = this.channelName;
    if (!channelKey) {
      this.log('AI_CLEAR_AIR_NO_CHANNEL', { originUnit, eventType });
      return false;
    }

    let sigService = null;
    try {
      sigService = await this._ensureSignalingService();
    } catch (e) {
      this.log('AI_CLEAR_AIR_NO_SIGNALING_SERVICE', { channelKey, error: e.message });
    }
    if (!sigService || typeof sigService.startClearAirInternal !== 'function') {
      this.log('AI_CLEAR_AIR_NO_SIGNALING', { channelKey });
      return false;
    }

    const existingState = typeof sigService.getClearAirState === 'function'
      ? sigService.getClearAirState(channelKey)
      : null;
    if (existingState && existingState.initiator !== 'ai') {
      this.log('AI_CLEAR_AIR_SKIPPED_MANUAL_ACTIVE', { channelKey, dispatcherId: existingState.dispatcherId });
      return false;
    }
    if (existingState && existingState.initiator === 'ai') {
      if (!this._aiClearAirSessions.has(channelKey)) {
        this._aiClearAirSessions.set(channelKey, {
          originUnit: existingState.originUnit || originUnit,
          eventType: existingState.eventType || eventType,
          startedAt: existingState.timestamp || Date.now(),
        });
      }
      this.log('AI_CLEAR_AIR_ALREADY_ACTIVE', { channelKey, originUnit, eventType });
      return false;
    }

    let started;
    try {
      started = sigService.startClearAirInternal(channelKey, {
        dispatcherId: AI_IDENTITY,
        initiator: 'ai',
        originUnit,
        eventType,
      });
    } catch (e) {
      this.log('AI_CLEAR_AIR_START_ERROR', { channelKey, error: e.message });
      return false;
    }

    if (!started || started.alreadyActive) {
      this.log('AI_CLEAR_AIR_START_NOOP', { channelKey, alreadyActive: !!started?.alreadyActive });
      return false;
    }

    this._aiClearAirSessions.set(channelKey, {
      originUnit,
      eventType,
      startedAt: Date.now(),
    });
    this.log('AI_CLEAR_AIR_ACTIVATED', { channelKey, originUnit, eventType });

    try {
      await this.playToneAndSpeak('CONTINUOUS', 'All units, hold the air. Emergency traffic only.');
    } catch (e) {
      this.log('AI_CLEAR_AIR_TTS_ERROR', { channelKey, error: e.message });
    }

    return true;
  }

  async _releaseAiClearAir(releasedBy, releaseReason) {
    const channelKey = this.channelName;
    if (!channelKey) return false;

    const session = this._aiClearAirSessions.get(channelKey);
    if (!session) {
      this.log('AI_CLEAR_AIR_RELEASE_NO_SESSION', { channelKey });
      return false;
    }

    let sigService = null;
    try {
      sigService = await this._ensureSignalingService();
    } catch (e) {
      this.log('AI_CLEAR_AIR_RELEASE_SIG_LOOKUP_ERROR', { channelKey, error: e.message });
    }

    let endResult = null;
    if (sigService && typeof sigService.endClearAirInternal === 'function') {
      try {
        endResult = sigService.endClearAirInternal(channelKey, {
          requireInitiator: 'ai',
          releasedBy,
          releaseReason,
        });
      } catch (e) {
        this.log('AI_CLEAR_AIR_END_ERROR', { channelKey, error: e.message });
        return false;
      }
    } else {
      this.log('AI_CLEAR_AIR_RELEASE_NO_SIGNALING', { channelKey });
      return false;
    }

    if (!endResult || endResult.skipped) {
      this.log('AI_CLEAR_AIR_RELEASE_SKIPPED', {
        channelKey,
        reason: endResult?.reason || 'no_active_session',
      });
      this._aiClearAirSessions.delete(channelKey);
      return false;
    }

    this._aiClearAirSessions.delete(channelKey);
    this.log('AI_CLEAR_AIR_RELEASED', { channelKey, releasedBy, releaseReason, originUnit: session.originUnit, eventType: session.eventType });

    try {
      const time = this.formatMilitaryTime();
      await this.playToneAndSpeak('CONTINUOUS', `All units, you can resume normal radio traffic on this channel, ${time}.`);
    } catch (e) {
      this.log('AI_CLEAR_AIR_RESUME_TTS_ERROR', { channelKey, error: e.message });
    }

    return true;
  }

  async executeLogEventNote(participantId, transcript, payload = {}) {
    const eventTypeRaw = payload.eventType || (payload.slots && payload.slots.eventType);
    const eventType = String(eventTypeRaw || '').toUpperCase();
    let entries = payload.entries || [];
    let description = payload.description || null;
    const vehicleConfidence = typeof payload.vehicleConfidence === 'number' ? payload.vehicleConfidence : null;

    if (!eventType) {
      this.log('EVENT_NOTE_MISSING_TYPE', { participant: participantId, transcript });
      return;
    }

    let effectiveType = eventType;
    if (effectiveType === 'VEHICLE_PURSUIT' && vehicleConfidence !== null && vehicleConfidence < 0.85) {
      this.log('EVENT_NOTE_VEHICLE_CONFIDENCE_FALLBACK', { participant: participantId, vehicleConfidence });
      effectiveType = 'FOOT_PURSUIT';
    }

    const noteText = formatEventNote(effectiveType, entries);
    const descNote = formatDescriptionNote(effectiveType, description);
    const spokenLabel = getEventSpokenLabel(effectiveType);
    const time = this.formatMilitaryTime();
    const ack = `Copy, ${spokenLabel}, ${time}.`;

    const isClearAirEvent = isClearAirEventType(effectiveType);
    const isCustody = effectiveType === 'CUSTODY';

    let callId = null;
    let cadAvailable = cadService.isConfigured();
    let noteWritten = false;
    let noActiveCall = false;
    let cadWriteFailed = false;
    let writeFailureCategory = null;

    if (cadAvailable) {
      try {
        const currentCall = await cadService.resolveUnitCurrentCall(participantId, { unitUuid: this._resolveUnitUuidForCallsign(participantId) });
        callId = currentCall?.call_id || currentCall?.call_number || currentCall?.callNumber || null;
        if (callId && noteText) {
          const fullNote = `${participantId}: ${noteText}`;
          const noteResult = await this._addCallNoteSerial(participantId, callId, fullNote);
          if (noteResult?.success !== false) {
            noteWritten = true;
            this.log('CALL_NOTE_AUTO_EVENT', { unitId: participantId, callId, eventType: effectiveType, note: noteText });
            if (descNote) {
              try {
                const descFull = `${participantId}: ${descNote}`;
                const descResult = await this._addCallNoteSerial(participantId, callId, descFull);
                if (descResult?.success === false) {
                  await this._recordNoteFailure('event_note_description', {
                    participantId, callId, noteLength: descFull.length, noteResult: descResult,
                  });
                } else {
                  this.log('CALL_NOTE_AUTO_EVENT_DESCRIPTION', { unitId: participantId, callId, descNote });
                }
              } catch (descErr) {
                this.log('CALL_NOTE_AUTO_EVENT_DESC_ERROR', { error: descErr.message });
              }
            }
          } else {
            cadWriteFailed = true;
            writeFailureCategory = noteResult.failureCategory || cadService.categorizeNoteFailure(noteResult) || 'unknown';
            await this._recordNoteFailure('event_note', {
              participantId, callId, noteLength: fullNote.length, noteResult,
            });
          }
        } else if (!callId) {
          noActiveCall = true;
        }
      } catch (e) {
        cadWriteFailed = true;
        writeFailureCategory = 'network';
        this.log('CALL_NOTE_AUTO_EVENT_ERROR', { unitId: participantId, error: e.message });
        await this._recordNoteFailure('event_note', {
          participantId, callId, noteLength: noteText ? noteText.length : 0,
          noteResult: { success: false, error: e.message, failureCategory: 'network' },
        });
      }
    } else {
      this.log('CALL_NOTE_AUTO_EVENT_NO_CAD', { unitId: participantId });
    }

    let spokenResp = ack;
    if (!cadAvailable) {
      spokenResp = `${participantId}, copy ${spokenLabel}. CAD system not available, no note logged.`;
    } else if (noActiveCall) {
      spokenResp = `${participantId}, copy ${spokenLabel}. You don't have an active call to add a note to.`;
    } else if (cadWriteFailed) {
      const reasonSpoken = this._noteFailureCategorySpoken(writeFailureCategory);
      spokenResp = `${participantId}, copy ${spokenLabel}. Unable to log note — ${reasonSpoken}, try again.`;
    }

    if (isClearAirEvent) {
      try {
        await this._activateAiClearAir(participantId, effectiveType);
      } catch (e) {
        this.log('AI_CLEAR_AIR_ACTIVATE_THROW', { error: e.message });
      }
    } else if (isCustody && this._aiClearAirSessions.has(this.channelName)) {
      try {
        await this._releaseAiClearAir(participantId, 'custody_during_clear_air');
      } catch (e) {
        this.log('AI_CLEAR_AIR_RELEASE_THROW', { error: e.message });
      }
    }

    await this.speak(spokenResp, participantId);
    this.addConversationExchange(participantId, transcript, spokenResp);
    this.logSpeechEvent(participantId, transcript, `LOG_EVENT_NOTE:${effectiveType}`, spokenResp);
    setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);

    return { noteWritten, callId, eventType: effectiveType };
  }

  _hasActiveAiClearAir() {
    if (!this.channelName) return false;
    return this._aiClearAirSessions.has(this.channelName);
  }

  async executeEventAllClear(participantId, transcript, reason) {
    let sigService = null;
    try {
      sigService = await this._ensureSignalingService();
    } catch (_) {}

    let sigState = null;
    if (sigService && typeof sigService.getClearAirState === 'function') {
      try { sigState = sigService.getClearAirState(this.channelName); } catch (_) {}
    }

    const localHasSession = this._aiClearAirSessions.has(this.channelName);
    const sigHasAiSession = !!(sigState && sigState.initiator === 'ai');

    if (!localHasSession && !sigHasAiSession) {
      this.log('EVENT_ALL_CLEAR_NO_SESSION', { participant: participantId, transcript, reason });
      return;
    }

    if (!localHasSession && sigHasAiSession) {
      this._aiClearAirSessions.set(this.channelName, {
        originUnit: sigState.originUnit || null,
        eventType: sigState.eventType || null,
        startedAt: sigState.timestamp || Date.now(),
      });
      this.log('AI_CLEAR_AIR_SYNCED_FROM_SIGNALING', { channelKey: this.channelName });
    }

    await this._releaseAiClearAir(participantId, reason || 'all_clear');
    this.logSpeechEvent(participantId, transcript, 'EVENT_ALL_CLEAR', '(clear air released)');
    setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
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

      const currentCall = await cadService.resolveUnitCurrentCall(participantId, { unitUuid: this._resolveUnitUuidForCallsign(participantId) });
      const callId = currentCall?.call_id || currentCall?.call_number || currentCall?.callNumber;

      if (!callId) {
        const resp = `${participantId}, you don't have an active call to add a note to.`;
        await this.speak(resp, participantId);
        this.addConversationExchange(participantId, transcript, resp);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
        return;
      }

      const noteText = `${participantId}: ${noteContent}`;
      const noteResult = await this._addCallNoteSerial(participantId, callId, noteText);
      if (noteResult?.success === false) {
        const category = noteResult.failureCategory || cadService.categorizeNoteFailure(noteResult) || 'unknown';
        await this._recordNoteFailure('add_note', {
          participantId, callId, noteLength: noteText.length, noteResult,
        });
        const reasonSpoken = this._noteFailureCategorySpoken(category);
        const resp = `${participantId}, unable to add note — ${reasonSpoken}, try again.`;
        await this.speak(resp, participantId);
        this.addConversationExchange(participantId, transcript, resp);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
        return;
      }
      this.log('CALL_NOTE_ADDED_VOICE', { unitId: participantId, callId, noteId: noteResult?.note_id });
      recordAction(participantId, 'ADD_NOTE', {
        summary: `note on call ${noteResult?.call_number || callId}`,
        data: { callId, noteId: noteResult?.note_id || null, noteText: noteContent }
      });

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

  _spokenDigits(num) {
    if (num === null || num === undefined) return '';
    return String(num).split('').map(d => {
      switch (d) {
        case '0': return 'zero';
        case '1': return 'one';
        case '2': return 'two';
        case '3': return 'three';
        case '4': return 'four';
        case '5': return 'five';
        case '6': return 'six';
        case '7': return 'seven';
        case '8': return 'eight';
        case '9': return 'nine';
        default: return d;
      }
    }).join('-');
  }

  _parseMileage(text) {
    if (!text) return null;
    const cleaned = String(text).replace(/[^0-9]/g, '');
    if (!cleaned) return null;
    const n = parseInt(cleaned, 10);
    if (Number.isNaN(n)) return null;
    return n;
  }

  async _composeAck(participantId, draftPrompt, contextHint = null) {
    try {
      return await composeNatural(participantId, draftPrompt, contextHint);
    } catch (e) {
      this.log('COMPOSE_ACK_FALLBACK', { error: e.message });
      return draftPrompt;
    }
  }

  async _ensureCallId(participantId) {
    if (!cadService.isConfigured()) return { configured: false, callId: null };
    const currentCall = await cadService.resolveUnitCurrentCall(participantId, { unitUuid: this._resolveUnitUuidForCallsign(participantId) });
    const callId = currentCall?.call_id || currentCall?.call_number || currentCall?.callNumber || null;
    return { configured: true, callId };
  }

  async handleSecondaryTripStart(participantId, transcript, slots) {
    this.log('SECONDARY_TRIP_START', { participant: participantId, transcript, slots });

    const destinationRaw = slots.destination ? String(slots.destination).trim() : null;
    const startingMileage = this._parseMileage(slots.startingMileage);
    const subjectCount = slots.subjectCount ? parseInt(String(slots.subjectCount).replace(/[^0-9]/g, ''), 10) || 1 : 1;
    const subjectDescription = (slots.subjectDescription ? String(slots.subjectDescription).trim() : 'subject') || 'subject';

    if (!destinationRaw) {
      const resp = await this._composeAck(participantId, `${participantId}, what's your destination?`);
      setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_DESTINATION_CLARIFY, 'SECONDARY_TRIP_START',
        { startingMileage, subjectCount, subjectDescription, awaiting: 'destination' }, true);
      await this.speak(resp, participantId, { retryOnBusy: true });
      return;
    }

    if (startingMileage === null) {
      setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_SECONDARY_MILEAGE, 'SECONDARY_TRIP_START',
        { destination: destinationRaw, subjectCount, subjectDescription }, true);
      const resp = await this._composeAck(participantId, `${participantId}, starting mileage?`);
      await this.speak(resp, participantId, { retryOnBusy: true });
      return;
    }

    const resolved = resolveDestination(destinationRaw);
    if (resolved.kind === 'ambiguous') {
      const names = resolved.candidates.map(c => c.name).join(' or ');
      const draft = `${participantId}, did you mean ${names}?`;
      const resp = await this._composeAck(participantId, draft);
      setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_DESTINATION_CLARIFY, 'SECONDARY_TRIP_START', {
        startingMileage, subjectCount, subjectDescription,
        candidates: resolved.candidates.map(c => ({ name: c.name, address: c.address })),
        spokenDestination: destinationRaw,
        awaiting: 'choice'
      }, true);
      await this.speak(resp, participantId, { retryOnBusy: true });
      return;
    }

    let resolvedDestination = destinationRaw;
    let resolvedAddress = null;
    if (resolved.kind === 'unique') {
      resolvedDestination = resolved.place.name;
      resolvedAddress = resolved.place.address || null;
    } else {
      const draft = `${participantId}, copy en route to "${destinationRaw}", confirm address or city?`;
      const resp = await this._composeAck(participantId, draft);
      setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_DESTINATION_CLARIFY, 'SECONDARY_TRIP_START', {
        startingMileage, subjectCount, subjectDescription,
        spokenDestination: destinationRaw,
        awaiting: 'confirm-unknown'
      }, true);
      await this.speak(resp, participantId, { retryOnBusy: true });
      return;
    }

    await this._executeSecondaryTripStart(participantId, transcript, {
      destination: resolvedDestination,
      destinationAddress: resolvedAddress,
      startingMileage,
      subjectCount,
      subjectDescription,
    });
  }

  async _executeSecondaryTripStart(participantId, transcript, payload) {
    const { destination, destinationAddress, startingMileage, subjectCount, subjectDescription } = payload;

    const { configured, callId } = await this._ensureCallId(participantId);

    let cadOk = true;
    let cadCorrection = null;
    if (configured) {
      const statusResult = await this._updateUnitStatusSerial(participantId, RADIO_STATUS.EN_ROUTE_SECONDARY, this.channelName);
      if (!statusResult || statusResult.success === false) {
        cadOk = false;
        const actual = extractActualStatusFromRejection(statusResult);
        cadCorrection = { failureType: statusResult?.failureType, statusCode: statusResult?.statusCode, actual };
        this.log('SECONDARY_TRIP_START_STATUS_FAILED', { unitId: participantId, statusResult });
      }
    }

    if (configured && callId && cadOk) {
      const note = `STARTING MILEAGE - ${startingMileage}, en route to ${destination.toUpperCase()} with ${subjectCount} ${subjectDescription}`;
      const noteResult = await this._addCallNoteSerial(participantId, callId, note);
      if (!noteResult || noteResult.success === false) {
        this.log('SECONDARY_TRIP_START_NOTE_FAILED', { unitId: participantId, callId, noteResult });
      } else {
        this.log('SECONDARY_TRIP_START_NOTE_ADDED', { unitId: participantId, callId, note });
      }
    }

    if (cadOk) {
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {
        secondaryTrip: {
          destination,
          destinationAddress,
          startingMileage,
          subjectCount,
          subjectDescription,
          callId: callId || null,
          startedAt: Date.now(),
        }
      }, false);
      const draft = `${participantId}, 10-4, en route to ${destination} with ${subjectCount === 1 ? 'one' : subjectCount} ${subjectDescription}, starting mileage ${this._spokenDigits(startingMileage)}.`;
      const resp = await this._composeAck(participantId, draft);
      await this.speak(resp, participantId, { retryOnBusy: true });
      this.addConversationExchange(participantId, transcript, resp);
      return;
    }

    setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, false);
    let draft;
    if (cadCorrection?.actual) {
      const actualHuman = String(cadCorrection.actual).toLowerCase();
      draft = `${participantId}, I show you ${actualHuman}. Mark on scene first, then go ahead with the transport.`;
    } else if (cadCorrection?.failureType === 'NOT_CONFIGURED') {
      draft = `${participantId}, 10-4, en route to ${destination} with ${subjectCount} ${subjectDescription}, starting mileage ${this._spokenDigits(startingMileage)}. CAD unavailable, log it on your MDT.`;
    } else {
      draft = `${participantId}, CAD didn't accept that transition. Try your MDT.`;
    }
    const resp = await this._composeAck(participantId, draft);
    await this.speak(resp, participantId, { retryOnBusy: true });
    this.addConversationExchange(participantId, transcript, resp);
  }

  async handleSecondaryMileageInput(participantId, transcript, savedSlots) {
    this.log('SECONDARY_MILEAGE_INPUT', { participant: participantId, transcript });
    const normalized = transcript.toLowerCase().trim();
    const disregardPhrases = ['disregard', 'cancel', 'nevermind', 'never mind'];
    if (disregardPhrases.some(p => normalized.includes(p)) && ownsInFlight(participantId)) {
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      const resp = `${participantId}, 10-4, disregard.`;
      await this.speak(resp, participantId);
      return;
    }
    const startingMileage = this._parseMileage(transcript);
    if (startingMileage === null) {
      const resp = await this._composeAck(participantId, `${participantId}, didn't catch that, starting mileage?`);
      await this.speak(resp, participantId);
      return;
    }
    const destination = savedSlots?.destination;
    const subjectCount = savedSlots?.subjectCount || 1;
    const subjectDescription = savedSlots?.subjectDescription || 'subject';
    if (!destination) {
      setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_DESTINATION_CLARIFY, 'SECONDARY_TRIP_START', {
        startingMileage, subjectCount, subjectDescription, awaiting: 'destination'
      }, true);
      const resp = await this._composeAck(participantId, `${participantId}, copy starting mileage. Where to?`);
      await this.speak(resp, participantId);
      return;
    }
    const resolved = resolveDestination(destination);
    let dest = destination, destAddr = null;
    if (resolved.kind === 'unique') { dest = resolved.place.name; destAddr = resolved.place.address; }
    await this._executeSecondaryTripStart(participantId, transcript, {
      destination: dest, destinationAddress: destAddr, startingMileage, subjectCount, subjectDescription
    });
  }

  async handleDestinationClarify(participantId, transcript, savedSlots) {
    this.log('DESTINATION_CLARIFY_INPUT', { participant: participantId, transcript, savedSlots });
    const normalized = transcript.toLowerCase().trim();
    const disregardPhrases = ['disregard', 'cancel', 'nevermind', 'never mind'];
    if (disregardPhrases.some(p => normalized.includes(p)) && ownsInFlight(participantId)) {
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      const resp = `${participantId}, 10-4, disregard.`;
      await this.speak(resp, participantId);
      return;
    }

    const candidates = savedSlots?.candidates || [];
    const startingMileage = savedSlots?.startingMileage;
    const subjectCount = savedSlots?.subjectCount || 1;
    const subjectDescription = savedSlots?.subjectDescription || 'subject';

    let chosen = null;
    if (candidates.length > 0) {
      const txt = normalized;
      for (const c of candidates) {
        if (txt.includes(c.name.toLowerCase())) { chosen = c; break; }
      }
      if (!chosen) {
        const resolved = resolveDestination(transcript, candidates.map(c => ({ name: c.name, aliases: [], address: c.address })));
        if (resolved.kind === 'unique') chosen = resolved.place;
      }
    }
    if (chosen) {
      await this._executeSecondaryTripStart(participantId, transcript, {
        destination: chosen.name,
        destinationAddress: chosen.address || null,
        startingMileage,
        subjectCount,
        subjectDescription,
      });
      return;
    }

    const dest = transcript.trim();
    if (!dest) {
      const resp = await this._composeAck(participantId, `${participantId}, didn't catch that, where to?`);
      await this.speak(resp, participantId);
      return;
    }
    if (startingMileage === null || startingMileage === undefined) {
      setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_SECONDARY_MILEAGE, 'SECONDARY_TRIP_START', {
        destination: dest, subjectCount, subjectDescription
      }, true);
      const resp = await this._composeAck(participantId, `${participantId}, 10-4, en route to ${dest}, starting mileage?`);
      await this.speak(resp, participantId);
      return;
    }
    await this._executeSecondaryTripStart(participantId, transcript, {
      destination: dest, destinationAddress: null, startingMileage, subjectCount, subjectDescription,
    });
  }

  async handleSecondaryTripArrive(participantId, transcript, slots) {
    this.log('SECONDARY_TRIP_ARRIVE', { participant: participantId, transcript, slots });
    const session = getUnitSessionState(participantId);
    const trip = session?.slots?.secondaryTrip || null;
    const endingMileage = this._parseMileage(slots.endingMileage);
    const destination = (slots.destination && String(slots.destination).trim()) || trip?.destination || null;

    if (endingMileage === null) {
      setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_ENDING_MILEAGE, 'SECONDARY_TRIP_ARRIVE',
        { destination }, true);
      const resp = await this._composeAck(participantId, `${participantId}, ending mileage?`);
      await this.speak(resp, participantId, { retryOnBusy: true });
      return;
    }

    if (trip && typeof trip.startingMileage === 'number' && endingMileage <= trip.startingMileage) {
      setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_MILEAGE_CONFIRM, 'SECONDARY_TRIP_ARRIVE', {
        endingMileage, destination, startingMileage: trip.startingMileage,
      }, true);
      const draft = `${participantId}, confirm ending mileage ${this._spokenDigits(endingMileage)}, that's lower than your starting mileage of ${this._spokenDigits(trip.startingMileage)}?`;
      const resp = await this._composeAck(participantId, draft);
      await this.speak(resp, participantId, { retryOnBusy: true });
      return;
    }

    await this._executeSecondaryTripArrive(participantId, transcript, { endingMileage, destination, trip });
  }

  async _executeSecondaryTripArrive(participantId, transcript, payload) {
    const { endingMileage, destination, trip } = payload;

    const { configured, callId: liveCallId } = await this._ensureCallId(participantId);
    const callId = liveCallId || trip?.callId || null;

    let cadOk = true;
    let cadCorrection = null;
    if (configured) {
      const statusResult = await this._updateUnitStatusSerial(participantId, RADIO_STATUS.ARRIVED_SECONDARY, this.channelName);
      if (!statusResult || statusResult.success === false) {
        cadOk = false;
        cadCorrection = { failureType: statusResult?.failureType, actual: extractActualStatusFromRejection(statusResult) };
        this.log('SECONDARY_TRIP_ARRIVE_STATUS_FAILED', { unitId: participantId, statusResult });
      }
    }

    if (configured && callId && cadOk) {
      const dest = destination ? destination.toUpperCase() : null;
      const note = dest
        ? `ENDING MILEAGE - ${endingMileage}, arrived at ${dest}`
        : `ENDING MILEAGE - ${endingMileage}, arrived`;
      const noteResult = await this._addCallNoteSerial(participantId, callId, note);
      if (!noteResult || noteResult.success === false) {
        this.log('SECONDARY_TRIP_ARRIVE_NOTE_FAILED', { unitId: participantId, callId, noteResult });
      } else {
        this.log('SECONDARY_TRIP_ARRIVE_NOTE_ADDED', { unitId: participantId, callId, note });
      }
    }

    setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, { secondaryTrip: null }, false);

    let draft;
    if (cadOk) {
      const destText = destination ? ` arrived at ${destination},` : '';
      draft = `${participantId}, 10-4,${destText} ending mileage ${this._spokenDigits(endingMileage)}.`;
    } else if (cadCorrection?.actual) {
      draft = `${participantId}, I show you ${String(cadCorrection.actual).toLowerCase()}. Log the arrival on your MDT.`;
    } else {
      draft = `${participantId}, CAD didn't accept that, log the arrival on your MDT.`;
    }
    const resp = await this._composeAck(participantId, draft);
    await this.speak(resp, participantId, { retryOnBusy: true });
    this.addConversationExchange(participantId, transcript, resp);
  }

  async handleEndingMileageInput(participantId, transcript, savedSlots) {
    this.log('ENDING_MILEAGE_INPUT', { participant: participantId, transcript });
    const normalized = transcript.toLowerCase().trim();
    const disregardPhrases = ['disregard', 'cancel', 'nevermind', 'never mind'];
    if (disregardPhrases.some(p => normalized.includes(p)) && ownsInFlight(participantId)) {
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      const resp = `${participantId}, 10-4, disregard.`;
      await this.speak(resp, participantId);
      return;
    }
    const endingMileage = this._parseMileage(transcript);
    if (endingMileage === null) {
      const resp = await this._composeAck(participantId, `${participantId}, didn't catch that, ending mileage?`);
      await this.speak(resp, participantId);
      return;
    }
    await this.handleSecondaryTripArrive(participantId, transcript, {
      endingMileage,
      destination: savedSlots?.destination || null,
    });
  }

  async handleMileageConfirm(participantId, transcript, savedSlots) {
    this.log('MILEAGE_CONFIRM_INPUT', { participant: participantId, transcript });
    const normalized = transcript.toLowerCase().trim();
    const yesPhrases = ['yes', 'yeah', 'yep', 'affirmative', '10-4', '10/4', 'ten four', 'copy', 'roger', 'confirm'];
    const noPhrases = ['no', 'negative', 'wrong', 'incorrect', 'disregard', 'cancel'];
    const isYes = yesPhrases.some(p => normalized === p || normalized.includes(p));
    const isNo = noPhrases.some(p => normalized === p || normalized.includes(p));
    const session = getUnitSessionState(participantId);
    const trip = session?.slots?.secondaryTrip || null;

    if (isYes && !isNo) {
      const endingMileage = savedSlots?.endingMileage;
      const destination = savedSlots?.destination || trip?.destination || null;
      await this._executeSecondaryTripArrive(participantId, transcript, { endingMileage, destination, trip });
      return;
    }
    if (isNo) {
      setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_ENDING_MILEAGE, 'SECONDARY_TRIP_ARRIVE',
        { destination: savedSlots?.destination || null }, true);
      const resp = await this._composeAck(participantId, `${participantId}, 10-4, go ahead with the correct ending mileage.`);
      await this.speak(resp, participantId);
      return;
    }
    const resp = await this._composeAck(participantId, `${participantId}, confirm yes or no on the ending mileage?`);
    await this.speak(resp, participantId);
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
      const currentCall = await cadService.resolveUnitCurrentCall(participantId, { unitUuid: this._resolveUnitUuidForCallsign(participantId) });
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
    if (disregardPhrases.some(p => normalized.includes(p)) && ownsInFlight(participantId)) {
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
    if (disregardPhrases.some(p => normalized.includes(p)) && ownsInFlight(participantId)) {
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
        const personDobUtc = person.dob || '';
        const personDobLocal = personDobUtc ? (utcDateToLocalDate(personDobUtc) || personDobUtc) : '';
        setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_SECURE_CONFIRM, null, {
          lastName: person.last_name || person.lastName || '',
          firstName: person.first_name || person.firstName || '',
          dob: personDobLocal,
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
    if (disregardPhrases.some(p => normalized.includes(p)) && ownsInFlight(participantId)) {
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
        const personDobUtc = person.dob || '';
        const personDobLocal = personDobUtc ? (utcDateToLocalDate(personDobUtc) || personDobUtc) : '';
        setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_SECURE_CONFIRM, null, {
          lastName: person.last_name || person.lastName || '',
          firstName: person.first_name || person.firstName || '',
          dob: personDobLocal,
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

  async handleDisregard(participantId, transcript, slots = {}) {
    const qualifier = (slots && typeof slots.targetQualifier === 'string') ? slots.targetQualifier : null;
    this.log('LLM_DISREGARD', { participant: participantId, transcript, qualifier });

    // If a specific target was named, try the action log first so a
    // qualifier like "disregard that note" wins over an in-flight prompt.
    let action = qualifier ? findMostRecentAction(participantId, qualifier) : null;

    if (!action && ownsInFlight(participantId)) {
      this.log('DISREGARD_CANCEL_INFLIGHT', { participant: participantId, qualifier });
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, { conversationHistory: [] }, true);
      const resp = `${participantId}, 10-4, disregard.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      return;
    }

    if (!action) {
      action = findMostRecentAction(participantId, null);
    }

    if (!action) {
      this.log('DISREGARD_NO_MATCH', { participant: participantId, qualifier });
      const resp = qualifier
        ? `${participantId}, nothing recent to disregard for ${qualifier}.`
        : `${participantId}, nothing to disregard.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      return;
    }

    const ageMs = Date.now() - action.timestamp;
    if (ageMs > DISREGARD_WINDOW_MS) {
      this.log('DISREGARD_TOO_OLD', { participant: participantId, action: action.type, ageMs });
      const resp = `${participantId}, that ${action.summary || action.type} is older than the auto-undo window. Update via the MDT.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      return;
    }

    let undoResult;
    try {
      undoResult = await this._undoAction(participantId, action);
    } catch (err) {
      this.log('DISREGARD_UNDO_ERROR', { participant: participantId, action: action.type, error: err.message, stack: err.stack });
      undoResult = { success: false, message: 'system error' };
    }

    if (undoResult.success) {
      removeAction(participantId, action.id);
      this.log('DISREGARD_UNDO_OK', { participant: participantId, action: action.type, message: undoResult.message });
      const resp = `${participantId}, 10-4. ${undoResult.message}`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
    } else {
      this.log('DISREGARD_UNDO_FAILED', { participant: participantId, action: action.type, message: undoResult.message });
      const resp = `${participantId}, unable to undo that ${action.summary || action.type}. ${undoResult.message || 'Update via the MDT.'}`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
    }
  }

  async _undoAction(unitId, action) {
    if (!cadService.isConfigured()) {
      return { success: false, message: 'CAD is not available.' };
    }
    const data = action.data || {};
    switch (action.type) {
      case 'STATUS_CHANGE': {
        if (!data.priorStatus) {
          return { success: false, message: `prior status unknown` };
        }
        const r = await this._updateUnitStatusSerial(unitId, data.priorStatus);
        if (r?.success === false) return { success: false, message: r?.error || 'CAD rejected the revert' };
        return { success: true, message: `Status reverted to ${data.priorStatus}.` };
      }
      case 'STATUS_CHANGE_OTHER': {
        if (!data.targetUnit || !data.priorStatus) {
          return { success: false, message: `prior status unknown` };
        }
        const r = await this._updateUnitStatusSerial(data.targetUnit, data.priorStatus);
        if (r?.success === false) return { success: false, message: r?.error || 'CAD rejected the revert' };
        return { success: true, message: `${data.targetUnit} reverted to ${data.priorStatus}.` };
      }
      case 'ZONE_CHANGE': {
        if (!data.priorZone) {
          return { success: false, message: `prior zone unknown` };
        }
        const r = await cadService.updateUnitZone(unitId, data.priorZone);
        if (r?.success === false) return { success: false, message: r?.error || 'CAD rejected the revert' };
        return { success: true, message: `Zone reverted to ${data.priorZone}.` };
      }
      case 'DETAIL': {
        let zoneOk = true;
        if (data.priorZone) {
          const zr = await cadService.updateUnitZone(unitId, data.priorZone);
          if (zr?.success === false) zoneOk = false;
        }
        if (data.priorStatus) {
          const sr = await this._updateUnitStatusSerial(unitId, data.priorStatus);
          if (sr?.success === false) return { success: false, message: sr?.error || 'CAD rejected the revert' };
        } else {
          const sr = await this._updateUnitStatusSerial(unitId, 'available');
          if (sr?.success === false) return { success: false, message: sr?.error || 'CAD rejected the revert' };
        }
        return { success: true, message: zoneOk ? `Detail backed out.` : `Detail status reverted, but zone could not be restored.` };
      }
      case 'ASSIGN_CALL': {
        // R10: gate inverse-action clear behind the unit's status queue.
        const r = await this._awaitStatusQueue(unitId, () => cadService.clearUnit(unitId));
        if (r?.success === false) return { success: false, message: r?.error || 'CAD rejected the revert' };
        this._clearRecentAssignment(unitId);
        return { success: true, message: `Detached you from ${data.callDisplay || 'that call'}.` };
      }
      case 'ASSIGN_OTHER_UNIT': {
        if (!data.targetUnit) return { success: false, message: 'target unit unknown' };
        const r = await this._awaitStatusQueue(data.targetUnit, () => cadService.clearUnit(data.targetUnit));
        if (r?.success === false) return { success: false, message: r?.error || 'CAD rejected the revert' };
        this._clearRecentAssignment(data.targetUnit);
        return { success: true, message: `Detached ${data.targetUnit} from ${data.callDisplay || 'that call'}.` };
      }
      case 'ADD_NOTE': {
        if (!data.noteId) {
          if (data.callId) {
            const fallback = await this._addCallNoteSerial(unitId, data.callId, `${unitId}: DISREGARD previous note: ${data.noteText || ''}`);
            if (fallback?.success === false) return { success: false, message: 'unable to flag note' };
            return { success: true, message: `Flagged the note as disregarded on call ${data.callId}.` };
          }
          return { success: false, message: 'note ID unavailable' };
        }
        const r = await cadService.deleteCallNote(data.noteId);
        if (r?.success === false) {
          if (data.callId) {
            const fallback = await this._addCallNoteSerial(unitId, data.callId, `${unitId}: DISREGARD previous note: ${data.noteText || ''}`);
            if (fallback?.success === false) return { success: false, message: 'unable to remove or flag the note' };
            return { success: true, message: `Note couldn't be deleted, flagged it as disregarded.` };
          }
          return { success: false, message: r?.error || 'CAD rejected delete' };
        }
        return { success: true, message: `Note removed from call.` };
      }
      case 'CREATE_CALL': {
        if (!data.callId) return { success: false, message: 'call ID unknown' };
        const r = await cadService.cancelCall(data.callId, 'Created in error');
        if (r?.success === false) return { success: false, message: r?.error || 'CAD rejected the cancel' };
        return { success: true, message: `Call ${data.callNumber || data.callId} cancelled.` };
      }
      case 'CLEAR_UNIT': {
        if (!data.priorCallId) return { success: false, message: 'prior call unknown' };
        const r = await this._assignUnitToCallSerial(unitId, data.priorCallId);
        if (r?.success === false) return { success: false, message: r?.error || 'CAD rejected the re-attach' };
        this._recordRecentAssignment(unitId, {}, { callId: data.priorCallId, callDisplay: data.priorCallDisplay });
        return { success: true, message: `Re-attached you to ${data.priorCallDisplay || data.priorCallId}.` };
      }
      case 'UPDATE_CALL': {
        const priorValues = data.priorValues || {};
        const updates = data.updates || {};
        const revert = {};
        if ('priority' in updates && priorValues.priority) {
          revert.priority = priorValues.priority;
        }
        if (Object.keys(revert).length === 0) {
          return { success: false, message: 'prior call values unknown' };
        }
        const r = await cadService.updateCall(data.callId, revert);
        if (r?.success === false) return { success: false, message: r?.error || 'CAD rejected the revert' };
        return { success: true, message: `Call update reverted.` };
      }
      default:
        return { success: false, message: 'no inverse available' };
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

    // Task #482: if the unit said e.g. "10-98 with a report", remember the
    // inline disposition so handleClearConfirm can skip "go ahead with disposition".
    const inlineDisposition = this._extractInlineDisposition(transcript);
    const slots = inlineDisposition ? { inlineDisposition } : {};
    setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_CLEAR_CONFIRM, null, slots, true);
    const resp = `${participantId}, confirm clear from call?`;
    await this.speak(resp, participantId);
    this.addConversationExchange(participantId, transcript, resp);
  }

  async handleClearConfirm(participantId, transcript) {
    this.log('CLEAR_CONFIRM', { participant: participantId, transcript });

    try {
      // Task #482: classify the clear up front so we can refuse / cascade
      // before mutating CAD. Falls through to the simple-clear path below.
      const outcome = await this._classifyClearOutcome(participantId);
      this.log('CLEAR_OUTCOME', { unitId: participantId, kind: outcome.kind, callId: outcome.call?.callId, others: outcome.otherUnits });

      const session = getUnitSessionState(participantId);
      const pendingDisposition = session?.slots?.inlineDisposition || null;

      if (outcome.kind === 'primary_with_others') {
        const resp = `${participantId}, you are primary on call ${outcome.call.callDisplay}, ${this._formatUnitList(outcome.otherUnits)} still on the call. Clear them first or have one take primary.`;
        await this.speak(resp, participantId);
        this.addConversationExchange(participantId, transcript, resp);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
        return;
      }

      if (outcome.kind === 'primary_last') {
        // Inline disposition? Skip the "Close the call?" prompt and go straight to confirm.
        if (pendingDisposition) {
          // Task #482: preserve the raw spoken phrase for CAD notes; the
          // canonical value is only used for the disposition CODE and the
          // prompt-back. executeDisposeCall does the canonicalization.
          let canonical = pendingDisposition;
          try {
            const list = await cadService.getDispositions();
            const m = cadService.matchDisposition(pendingDisposition, list);
            if (m && m.canonical) canonical = m.canonical;
          } catch (e) { /* fallback to raw */ }
          setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_DISPOSE_CONFIRM, null, {
            callNumber: outcome.call.callId,
            disposition: pendingDisposition,
            dispositionCanonical: canonical,
            dispositionNotes: pendingDisposition,
          }, true);
          const resp = `${participantId}, confirm close call ${outcome.call.callDisplay}, ${canonical}?`;
          await this.speak(resp, participantId);
          this.addConversationExchange(participantId, transcript, resp);
          return;
        }
        const resp = `${participantId}, you are primary on call ${outcome.call.callDisplay}. Close the call?`;
        await this.speak(resp, participantId);
        this.addConversationExchange(participantId, transcript, resp);
        setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_PRIMARY_CLOSE_CONFIRM, null, {
          callNumber: outcome.call.callId,
          callDisplay: outcome.call.callDisplay,
        }, true);
        return;
      }

      // 'simple' path → call CAD clearUnit (preserves R8 409 fallback as a safety net)
      const callInfo = outcome.call?.raw || null;
      const priorCallId = outcome.call?.callId || null;
      const priorCallDisplay = outcome.call?.callDisplay || priorCallId;
      // R10: wait for any in-flight status updates for this unit first.
      const clearResult = await this._awaitStatusQueue(participantId,
        () => cadService.clearUnit(participantId));
      if (clearResult?.success === false) {
        // R8: CAD rejects clearing the primary unit (HTTP 409). Speak it back
        // and offer to close the entire call instead.
        if (clearResult.statusCode === 409 && priorCallId) {
          const resp = `${participantId}, you are primary on call ${priorCallDisplay}. Close the call?`;
          await this.speak(resp, participantId);
          this.addConversationExchange(participantId, transcript, resp);
          setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_PRIMARY_CLOSE_CONFIRM, null, {
            callNumber: priorCallId,
            callDisplay: priorCallDisplay
          }, true);
          return;
        }
        const resp = `${participantId}, unable to clear you from call. ${clearResult.error || 'Try your MDT.'}`;
        await this.speak(resp, participantId);
        this.addConversationExchange(participantId, transcript, resp);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
        return;
      }
      this.log('UNIT_CLEARED', { unitId: participantId });
      this._clearRecentAssignment(participantId);
      if (priorCallId) {
        recordAction(participantId, 'CLEAR_UNIT', {
          summary: `cleared from ${priorCallDisplay}`,
          data: { priorCallId, priorCallDisplay }
        });
      }

      try {
        await this._updateUnitStatusSerial(participantId, 'available');
      } catch (statusErr) {
        this.log('CAD_STATUS_UPDATE_AFTER_CLEAR_ERROR', { error: statusErr.message });
      }

      const timeStr = this.formatMilitaryTime();
      // Task #482: simple-clear path — speaker was not primary (or had no call),
      // so we don't pull them into a disposition flow. The primary_last branch
      // above handles the "last unit, do a disposition" cascade.
      const resp = `${participantId}, 10-4, clear. ${timeStr}.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
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
          const currentCall = await cadService.resolveUnitCurrentCall(participantId, { unitUuid: this._resolveUnitUuidForCallsign(participantId) });
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
    if (disregardPhrases.some(p => normalized.includes(p)) && ownsInFlight(participantId)) {
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
        const currentCall = await cadService.resolveUnitCurrentCall(participantId, { unitUuid: this._resolveUnitUuidForCallsign(participantId) });
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
    // Task #482: when a raw spoken phrase was captured (inline disposition),
    // prefer it for CAD notes so we don't lose what the unit actually said.
    await this.executeDisposeCall(
      participantId,
      transcript,
      slots?.callNumber,
      slots?.disposition,
      { rawNotes: slots?.dispositionNotes || null, preCanonical: slots?.dispositionCanonical || null }
    );
  }

  async executeDisposeCall(participantId, transcript, callNumber, disposition, opts = {}) {
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
        const currentCall = await cadService.resolveUnitCurrentCall(participantId, { unitUuid: this._resolveUnitUuidForCallsign(participantId) });
        callId = currentCall?.call_id || currentCall?.call_number || currentCall?.callNumber;
      }

      if (!callId) {
        const resp = `${participantId}, no active call to close.`;
        await this.speak(resp, participantId);
        this.addConversationExchange(participantId, transcript, resp);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
        return;
      }

      // R9: disposition + dispositionNotes are both required.
      // Task #482: prefer raw spoken phrase for notes (passed via opts.rawNotes
      // from inline-disposition cascades) so we never lose what the unit said.
      // Canonicalize the disposition CODE against CAD's dropdown list. If the
      // caller pre-canonicalized (opts.preCanonical), reuse that and skip the
      // CAD round-trip.
      let canonicalDisp = opts?.preCanonical || disposition;
      const dispositionNotes = opts?.rawNotes || disposition;
      if (!opts?.preCanonical) {
        try {
          const list = await cadService.getDispositions();
          const matched = cadService.matchDisposition(disposition, list);
          if (matched && matched.canonical) {
            canonicalDisp = matched.canonical;
            this.log('DISPOSITION_MATCHED', { spoken: disposition, canonical: canonicalDisp, score: matched.score });
          }
        } catch (e) { /* fallback to raw */ }
      }
      // R10: wait for any in-flight status updates for this unit first.
      const result = await this._awaitStatusQueue(participantId,
        () => cadService.disposeCall(callId, canonicalDisp, dispositionNotes));
      if (result?.success === false) {
        const resp = `${participantId}, unable to close call. ${result.error || 'Try your MDT.'}`;
        await this.speak(resp, participantId);
        this.addConversationExchange(participantId, transcript, resp);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
        return;
      }
      this.log('CALL_DISPOSED', { unitId: participantId, callId, disposition });

      const resp = `${participantId}, 10-4. Call closed, ${canonicalDisp}.`;
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

  // R8: After speaking back the primary-unit 409, the user confirmed they
  // want to close the call instead. Flow into the normal disposition prompt.
  async handlePrimaryCloseConfirm(participantId, transcript, savedSlots) {
    this.log('PRIMARY_CLOSE_CONFIRM', { participant: participantId, transcript, savedSlots });
    const callNumber = savedSlots?.callNumber || null;
    setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_DISPOSITION, null, {
      callNumber
    }, true);
    const resp = `${participantId}, 10-4. Go ahead with disposition.`;
    await this.speak(resp, participantId);
    this.addConversationExchange(participantId, transcript, resp);
  }

  // SEQ-10: Cancel call. Requires explicit callNumber from the speaker; reason
  // is required (R9) — prompt for it if not spoken inline.
  async handleCancelCall(participantId, transcript, slots) {
    this.log('CANCEL_CALL', { participant: participantId, transcript, slots });
    let callNumber = slots?.callNumber;
    const reason = slots?.reason;

    // Fallback: if the speaker did not say a call number, default to their
    // current assigned call (R1 — units are cancelling the call they're on).
    if (!callNumber) {
      try {
        const currentCall = await cadService.resolveUnitCurrentCall(participantId, { unitUuid: this._resolveUnitUuidForCallsign(participantId) });
        callNumber = currentCall?.call_number || currentCall?.call_id || currentCall?.callNumber || null;
      } catch (_e) { /* ignore */ }
    }

    if (!callNumber) {
      const resp = `${participantId}, which call number to cancel?`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      return;
    }

    if (reason && String(reason).trim().length > 1) {
      setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_CANCEL_CONFIRM, null, {
        callNumber,
        reason: String(reason).trim()
      }, true);
      const resp = `${participantId}, confirm cancel call ${callNumber}, ${String(reason).trim()}?`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
    } else {
      setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_CANCEL_REASON, null, {
        callNumber
      }, true);
      const resp = `${participantId}, go ahead with the reason for cancel.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
    }
  }

  async handleCancelReasonInput(participantId, transcript, savedSlots, slots) {
    this.log('CANCEL_REASON_INPUT', { participant: participantId, transcript, savedSlots, slots });
    const callNumber = savedSlots?.callNumber || slots?.callNumber;
    const reason = (slots?.reason && String(slots.reason).trim()) || transcript.trim();
    if (!callNumber) {
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      const resp = `${participantId}, lost the call number, try again.`;
      await this.speak(resp, participantId);
      return;
    }
    if (!reason || reason.length < 2) {
      const resp = `${participantId}, did not copy the reason. Go ahead.`;
      await this.speak(resp, participantId);
      return;
    }
    setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_CANCEL_CONFIRM, null, {
      callNumber,
      reason
    }, true);
    const resp = `${participantId}, confirm cancel call ${callNumber}, ${reason}?`;
    await this.speak(resp, participantId);
    this.addConversationExchange(participantId, transcript, resp);
  }

  async handleCancelConfirm(participantId, transcript, savedSlots) {
    this.log('CANCEL_CONFIRM', { participant: participantId, transcript, savedSlots });
    const callNumber = savedSlots?.callNumber;
    const reason = savedSlots?.reason || 'CANCELLED';

    if (!cadService.isConfigured()) {
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      const resp = `${participantId}, CAD system not available.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      return;
    }
    if (!callNumber) {
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      const resp = `${participantId}, lost the call number, try again.`;
      await this.speak(resp, participantId);
      return;
    }

    try {
      // Resolve spoken call number → canonical CAD callId for PUT /api/calls/:callId
      const resolvedCallId = await this._resolveCallId(callNumber);
      // R10: wait for any in-flight status updates for this unit before
      // issuing the cancel.
      const result = await this._awaitStatusQueue(participantId,
        () => cadService.cancelCallDirect(resolvedCallId, reason, reason));
      if (result?.success === false) {
        const resp = `${participantId}, unable to cancel call ${callNumber}. ${result.error || 'Try your MDT.'}`;
        await this.speak(resp, participantId);
        this.addConversationExchange(participantId, transcript, resp);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
        return;
      }
      this.log('CALL_CANCELLED', { unitId: participantId, callNumber, reason });
      const resp = `${participantId}, 10-4. Call ${callNumber} cancelled, ${reason}.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
    } catch (error) {
      this.log('CANCEL_CALL_ERROR', { error: error.message });
      const resp = `${participantId}, unable to cancel call. System error.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
    }
  }

  // SEQ-11: Reopen a closed call. Strict phrase requires callNumber. Does NOT
  // auto-assign the speaker — they must request assignment separately.
  async handleReopenCall(participantId, transcript, slots) {
    this.log('REOPEN_CALL', { participant: participantId, transcript, slots });
    const callNumber = slots?.callNumber;

    if (!callNumber) {
      const resp = `${participantId}, which call number to reopen?`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      return;
    }

    if (!cadService.isConfigured()) {
      const resp = `${participantId}, CAD system not available.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      return;
    }

    try {
      // SEQ-11: REOPEN command takes the spoken call NUMBER (not UUID),
      // since CAD's POST /api/unit-command builds "REOPEN/<callNumber>".
      // R10: wait for any in-flight status updates for this unit first.
      const result = await this._awaitStatusQueue(participantId,
        () => cadService.reopenCall(callNumber));
      if (result?.success === false) {
        const resp = `${participantId}, unable to reopen call ${callNumber}. ${result.error || 'Try your MDT.'}`;
        await this.speak(resp, participantId);
        this.addConversationExchange(participantId, transcript, resp);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
        return;
      }
      this.log('CALL_REOPENED', { unitId: participantId, callNumber });
      const resp = `${participantId}, 10-4. Call ${callNumber} reopened.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
    } catch (error) {
      this.log('REOPEN_CALL_ERROR', { error: error.message });
      const resp = `${participantId}, unable to reopen call. System error.`;
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
    if (disregardPhrases.some(p => normalized.includes(p)) && ownsInFlight(participantId)) {
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
        const currentCall = await cadService.resolveUnitCurrentCall(participantId, { unitUuid: this._resolveUnitUuidForCallsign(participantId) });
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
      let priorCallSnapshot = null;
      try {
        const detailRes = await cadService.getCallDetails(callId);
        priorCallSnapshot = detailRes?.call || detailRes || null;
      } catch (e) { /* best effort */ }
      const result = await cadService.updateCall(callId, updates);
      if (result?.success === false) {
        const resp = `${participantId}, unable to update call. ${result.error || 'Try your MDT.'}`;
        await this.speak(resp, participantId);
        this.addConversationExchange(participantId, transcript, resp);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
        return;
      }
      this.log('CALL_UPDATED', { unitId: participantId, callId, updates });
      const priorValues = {};
      if (priorCallSnapshot) {
        if ('priority' in updates) priorValues.priority = priorCallSnapshot.priority || null;
      }
      recordAction(participantId, 'UPDATE_CALL', {
        summary: `update on call ${priorCallSnapshot?.call_number || callId}`,
        data: { callId, updates, priorValues }
      });

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
    if (disregardPhrases.some(p => normalized.includes(p)) && ownsInFlight(participantId)) {
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
        const currentCall = await cadService.resolveUnitCurrentCall(participantId, { unitUuid: this._resolveUnitUuidForCallsign(participantId) });
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

      // Task #486 (Step 4): respond per-field when the unit asked for a
      // specific piece of information instead of dumping every field.
      const field = this._resolveCallDetailsField(slots, transcript);
      const unitList = this._formatCallsignList(units);
      const resp = this._buildCallDetailsResponse(participantId, field, {
        callNum, nature, location, priority, status, notes, unitList,
      });
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

  // Task #486 (Step 7): take primary on a call. Resolves the call from the
  // speaker's current CAD assignment when no number is given (so shared
  // calls work). Then promotes via cadService.setPrimaryUnit. Avoids the
  // old "no active call found" bug, where the request was being routed
  // through ASSIGN_CALL on a call the unit was already on.
  async handleMakePrimary(participantId, transcript, slots) {
    this.log('MAKE_PRIMARY', { participant: participantId, transcript, slots });

    if (!cadService.isConfigured()) {
      const resp = `${participantId}, CAD system not available.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      return;
    }

    // Task #486 (Step 7): support both "make me primary" and
    // "make <unit> primary" — the latter promotes a different unit who is
    // already on the call. The lookup unit (whose current call we resolve
    // when no call number is given) is the unit being promoted.
    const targetUnit = (slots?.targetUnit && String(slots.targetUnit).trim())
      ? String(slots.targetUnit).trim().toUpperCase()
      : participantId;
    const isSelf = targetUnit === participantId;

    try {
      let callId = slots?.callNumber || null;

      if (callId) {
        try {
          const activeCalls = await cadService.getActiveCalls();
          const calls = activeCalls.calls || activeCalls.results || [];
          const resolved = this.resolveShorthandCallNumber(callId, calls);
          if (resolved) {
            callId = resolved.call_id || resolved.id || resolved.call_number;
          }
        } catch (e) {
          this.log('MAKE_PRIMARY_RESOLVE_ERROR', { error: e.message });
        }
      }

      // "Make X primary on this call" — "this call" is the SPEAKER's
      // active assignment, not the target's. Resolve from the speaker so
      // we never cross-promote onto a different call the target happens
      // to be on.
      if (!callId) {
        const currentCall = await cadService.resolveUnitCurrentCall(participantId, { unitUuid: this._resolveUnitUuidForCallsign(participantId) });
        callId = currentCall?.call_id || currentCall?.call_number || currentCall?.callNumber || null;
      }

      if (!callId) {
        const resp = `${participantId}, you're not on a call.`;
        await this.speak(resp, participantId);
        this.addConversationExchange(participantId, transcript, resp);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
        return;
      }

      const targetUuid = this._resolveUnitUuidForCallsign(targetUnit);
      const result = await cadService.setPrimaryUnitVerified(callId, targetUnit, { unitUuid: targetUuid });
      if (!result || result.success !== true) {
        const patchStatus = result?.patchStatus;
        // Hard reject: any non-2xx status, OR an unknown/null status
        // (network failure, CAD unreachable, missing config, etc.). Per
        // task spec, only a *2xx with no effect* gets the special "MDT"
        // wording; everything else falls back to the legacy refusal.
        const isHardReject =
          typeof patchStatus !== 'number' ||
          patchStatus < 200 ||
          patchStatus >= 300;
        if (isHardReject) {
          this.log('MAKE_PRIMARY_REJECTED', { unitId: targetUnit, requestedBy: participantId, callId, patchStatus, attempts: result?.attempts, beforePrimary: result?.beforePrimary, afterPrimary: result?.afterPrimary });
          const resp = isSelf
            ? `${participantId}, unable to make you primary on that call.`
            : `${participantId}, unable to make ${targetUnit} primary on that call.`;
          await this.speak(resp, participantId);
          this.addConversationExchange(participantId, transcript, resp);
          setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
          return;
        }
        // 2xx but verify shows primary did NOT change. Don't lie — say so
        // and tell the field to update from the MDT. CAD likely needs a
        // payload shape we don't know about; flag for vendor escalation
        // by logging the full verify payload (every attempted body shape,
        // every PATCH response, before/after primaries).
        this.log('MAKE_PRIMARY_NO_EFFECT', {
          unitId: targetUnit,
          requestedBy: participantId,
          callId,
          verify: result,
        });
        const resp = `${targetUnit}, CAD didn't move primary — please update from your MDT.`;
        await this.speak(resp, participantId);
        this.addConversationExchange(participantId, transcript, resp);
        setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
        return;
      }

      this.log('MAKE_PRIMARY_OK', { unitId: targetUnit, requestedBy: participantId, callId, attempts: result.attempts });
      // Task #486 (Step 3): routine ack — drop the call number; the unit
      // already has context for which call they meant.
      const resp = isSelf
        ? `${participantId}, 10-4. You have primary.`
        : `${participantId}, 10-4. ${targetUnit} has primary.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
    } catch (error) {
      this.log('MAKE_PRIMARY_ERROR', { error: error.message });
      const resp = `${participantId}, unable to set primary. System error.`;
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
    if (disregardPhrases.some(p => normalized.includes(p)) && ownsInFlight(participantId)) {
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
    this.log('STATUS_CHECK_SPEECH_IN', {
      handler: 'handleStatusCheckResponse',
      participant: participantId,
      transcript,
      pendingForUnit: this._listPendingStatusChecksForUnit(participantId).map(e => ({ callId: e.callId, escalated: !!e.escalated, rePrompted: !!e.rePrompted })),
    });
    this.log('STATUS_CHECK_RESPONSE', { participant: participantId, transcript, slots });

    const checkId = slots?.statusCheckId;
    const callId = slots?.statusCheckCallId || null;
    const unitUuid = slots?.statusCheckUnitUuid || null;
    const normalized = transcript.toLowerCase().trim();
    const escalationActive = this.routineStatusCheckEscalation.hasAnyForUnit(participantId);

    // Task #501: while a routine status check escalation is in progress, a
    // distress phrase from the same unit hands off to the existing backup
    // request flow. The escalation is cancelled so we don't keep paging.
    if (escalationActive) {
      const emergencyResponse = matchEmergencyResponse(transcript);
      if (emergencyResponse && emergencyResponse.type === 'DISTRESS') {
        this.log('STATUS_CHECK_ESCALATION_DISTRESS_HANDOFF', {
          participant: participantId,
          callId: escalationActive.callId,
          distressType: emergencyResponse.distressType,
        });
        this.routineStatusCheckEscalation.cancel(participantId, escalationActive.callId, 'distress');
        this._clearPendingStatusCheck(participantId, escalationActive.callId);
        await this.handleBackupRequestStart(participantId, transcript);
        return;
      }
      // The first turn after the hail is the unit saying "go ahead"; advance
      // the controller to AWAITING_RESPONSE and speak "Status check.".
      const stage = slots?.statusCheckHailStage;
      const isGoAhead = /\bgo\s*ahead\b/.test(normalized);
      if (stage === 'AWAITING_GO_AHEAD' && isGoAhead) {
        this.routineStatusCheckEscalation.onGoAhead(participantId, escalationActive.callId);
        return;
      }
    }

    // Allow units to snooze or cancel status checks directly from the
    // AWAITING_STATUS_CHECK_RESPONSE fast path (otherwise speech here is
    // always treated as an acknowledgment).
    const cancelPhrases = [
      'stop status check', 'stop the status check', 'cancel status check', 'cancel the status check',
      'no more status check', 'kill status check', 'kill the status check',
      // Task #509: per-call "suspend status checks" phrases.
      'extended traffic stop', 'extended scene', 'long-term scene', 'long term scene',
      'suspend status check', 'suspend the status check',
      'stop status checks for this call', 'no status checks until i clear',
    ];
    if (cancelPhrases.some(p => normalized.includes(p))) {
      this.log('STATUS_CHECK_RESPONSE_CANCEL_BRANCH', { participant: participantId });
      await this.handleCancelStatusChecks(participantId, transcript, {});
      return;
    }
    const snoozePhrases = ['snooze status check', 'snooze the status check', 'snooze checks', 'pause status check', 'pause the status check', 'hold status check', 'hold the status check'];
    if (snoozePhrases.some(p => normalized.includes(p))) {
      this.log('STATUS_CHECK_RESPONSE_SNOOZE_BRANCH', { participant: participantId });
      // Try to extract a duration (digits or simple words).
      const m = normalized.match(/(\d+)\s*(?:minute|min|m\b)/);
      const wordMap = { five: 5, ten: 10, fifteen: 15, twenty: 20, thirty: 30, sixty: 60 };
      let mins = m ? parseInt(m[1], 10) : null;
      if (!mins) {
        for (const [w, v] of Object.entries(wordMap)) {
          if (normalized.includes(w)) { mins = v; break; }
        }
      }
      await this.handleSnoozeStatusChecks(participantId, transcript, { durationMinutes: mins || 15 });
      return;
    }

    // Per CAD spec the ack body is { unit_id, call_id?, response, status? }.
    // `response` is the spoken text (free-form). We always send "10-4" as
    // the response since this handler is only entered when the unit is
    // acknowledging a status check — the ambiguous "transcript-as-status"
    // path was the original bug that prevented CAD from resetting timers.
    // Operational status changes (on_scene, en_route, …) flow through the
    // dedicated status-change handlers, not here.
    const ackResponse = '10-4';

    // Make sure we have a real call_id before relying on it. If the session
    // slot is missing one (e.g. the session expired before the user spoke),
    // fall back to the unit's currently assigned call so we ack one specific
    // assignment rather than every active assignment for the unit.
    let resolvedCallId = callId;
    if (!resolvedCallId) {
      try {
        resolvedCallId = await this._lookupCurrentCallId(participantId);
      } catch (err) {
        this.log('STATUS_CHECK_CALLID_LOOKUP_ERROR', { error: err.message });
      }
    }

    if (cadService.isConfigured()) {
      // Tag this round-trip so the inbound acknowledged event from CAD is
      // suppressed. Pass both the radio callsign and the UUID so we match
      // whichever identifier CAD echoes back.
      if (resolvedCallId) cadStatusCheckClient.markSelfResponded([participantId, unitUuid], resolvedCallId);

      let attempts = 0;
      let lastError = null;
      let lastBody = null;
      let succeeded = false;
      while (attempts < 2 && !succeeded) {
        attempts += 1;
        try {
          const result = await cadService.respondToStatusCheck(participantId, resolvedCallId, { response: ackResponse });
          lastBody = result;
          if (result && result.success !== false) {
            succeeded = true;
            this.log('STATUS_CHECK_RESPONDED', {
              unitId: participantId, checkId, callId: resolvedCallId, response: ackResponse,
              statusCode: result?.statusCode ?? null, attempts, body: result,
            });
            break;
          }
          lastError = (result && (result.error || result.message)) || 'CAD respond returned non-success';
        } catch (error) {
          lastError = error?.message || String(error);
          lastBody = null;
        }
        if (!succeeded && attempts < 2) {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      if (!succeeded) {
        this.log('STATUS_CHECK_RESPOND_FAILED', {
          unitId: participantId, callId: resolvedCallId, response: ackResponse, attempts,
          statusCode: lastBody?.statusCode ?? null, error: lastError, body: lastBody,
        });
      }
    }

    this._clearPendingStatusCheck(participantId, resolvedCallId);
    if (escalationActive) {
      this.routineStatusCheckEscalation.cancel(participantId, escalationActive.callId, 'acknowledged');
    }
    const resp = escalationActive
      ? `10-4, ${this.formatMilitaryTime()}.`
      : `${participantId}, 10-4.`;
    await this.speak(resp, participantId);
    this.addConversationExchange(participantId, transcript, resp);
    setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
  }

  _pendingStatusCheckKey(unitId, callId) {
    return `${String(unitId || '').toUpperCase()}|${callId || ''}`;
  }

  _clearPendingStatusCheck(unitId, callId) {
    if (!unitId) return;
    const key = this._pendingStatusCheckKey(unitId, callId);
    if (this._pendingStatusChecks.has(key)) {
      this._pendingStatusChecks.delete(key);
    }
    // Clear the rate-limit timestamp so a fresh check after the unit acks /
    // snoozes / cancels is not throttled by the previous prompt.
    if (this._lastSpokenStatusCheck.has(key)) {
      this._lastSpokenStatusCheck.delete(key);
    }
    // If the unit is currently in AWAITING_STATUS_CHECK_RESPONSE for this assignment, drop it.
    const session = getUnitSessionState(unitId);
    if (session?.state === DISPATCHER_STATE.AWAITING_STATUS_CHECK_RESPONSE) {
      const sessionCallId = session?.slots?.statusCheckCallId || null;
      if (!callId || sessionCallId === callId) {
        setUnitSessionState(unitId, DISPATCHER_STATE.IDLE, null, {}, true);
      }
    }
  }

  _listPendingStatusChecksForUnit(unitId) {
    if (!unitId) return [];
    const prefix = `${String(unitId).toUpperCase()}|`;
    const out = [];
    for (const [key, entry] of this._pendingStatusChecks.entries()) {
      if (key.startsWith(prefix)) out.push(entry);
    }
    return out;
  }

  _findPendingStatusCheckForUnit(unitId, preferredCallId = null) {
    if (!unitId) return null;
    if (preferredCallId) {
      const exact = this._pendingStatusChecks.get(this._pendingStatusCheckKey(unitId, preferredCallId));
      if (exact) return exact;
    }
    const list = this._listPendingStatusChecksForUnit(unitId);
    if (!list.length) return null;
    return list.sort((a, b) => (b.at || 0) - (a.at || 0))[0];
  }

  _isStatusCheckAckPhrase(transcript) {
    const t = String(transcript || '').toLowerCase().trim();
    if (!t) return false;
    const okPhrases = ['10-4', '10/4', 'ten four', 'copy', 'roger', 'yes', 'affirmative', 'good', 'okay', 'ok', 'clear'];
    return okPhrases.some(p => t.includes(p));
  }

  /**
   * Durable status-check ack: if a status check is still pending for this unit
   * (even after the per-prompt session timeout fired), treat an ack-shaped
   * inbound transcript as a response to the pending check and post it to CAD
   * before any other handler runs. Returns true when an ack was posted and
   * the pending entry was cleared, false otherwise. Callers do NOT short-
   * circuit on the return value — normal routing continues either way; this
   * helper just guarantees CAD sees the ack.
   */
  async _maybeAckPendingStatusCheck(participantId, transcript) {
    if (!participantId) return false;
    const pending = this._findPendingStatusCheckForUnit(participantId);
    if (!pending) return false;
    // Diagnostic: log every speech-in while a status check is pending so a
    // failure to ack is obvious from the log alone.
    this.log('STATUS_CHECK_SPEECH_IN', {
      handler: 'durable',
      participant: participantId,
      transcript,
      pendingCallId: pending.callId,
      pendingEscalated: !!pending.escalated,
      pendingRePrompted: !!pending.rePrompted,
    });
    if (!this._isStatusCheckAckPhrase(transcript)) {
      this.log('STATUS_CHECK_DURABLE_ACK_NO_MATCH', { participant: participantId, transcript });
      return false;
    }
    let resolvedCallId = pending.callId || null;
    if (!resolvedCallId) {
      try {
        resolvedCallId = await this._lookupCurrentCallId(participantId);
      } catch (err) {
        this.log('STATUS_CHECK_DURABLE_ACK_CALLID_LOOKUP_ERROR', { error: err.message });
      }
    }
    try {
      if (cadService.isConfigured()) {
        if (resolvedCallId) {
          cadStatusCheckClient.markSelfResponded([participantId, pending.unitUuid].filter(Boolean), resolvedCallId);
        }
        const result = await cadService.respondToStatusCheck(participantId, resolvedCallId, { response: '10-4' });
        if (result && result.success !== false) {
          this.log('STATUS_CHECK_RESPONDED', {
            unitId: participantId, callId: resolvedCallId, response: '10-4', source: 'durable_ack',
            statusCode: result?.statusCode ?? null, body: result,
          });
        } else {
          this.log('STATUS_CHECK_RESPOND_FAILED', {
            unitId: participantId, callId: resolvedCallId, response: '10-4', source: 'durable_ack',
            statusCode: result?.statusCode ?? null, body: result,
            error: (result && (result.error || result.message)) || 'CAD respond returned non-success',
          });
        }
      }
    } catch (err) {
      this.log('STATUS_CHECK_RESPOND_FAILED', {
        unitId: participantId, callId: resolvedCallId, response: '10-4', source: 'durable_ack', error: err.message,
      });
    }
    this._clearPendingStatusCheck(participantId, resolvedCallId);
    return true;
  }

  async _onSessionPromptTimeout(unitId, state, slots) {
    if (state === DISPATCHER_STATE.AWAITING_STATUS_CHECK_RESPONSE) {
      try {
        return await this._onStatusCheckPromptTimeout(unitId, slots || {});
      } catch (err) {
        this.log('STATUS_CHECK_PROMPT_TIMEOUT_ERROR', { unitId, error: err.message });
        return false;
      }
    }
    return false;
  }

  async _onStatusCheckPromptTimeout(unitId, slots) {
    const sessionCallId = slots?.statusCheckCallId || null;
    // Task #501: when the new RoutineStatusCheckEscalation controller is
    // driving the cadence, the legacy per-prompt timeout must stay out of
    // the way — it would talk over the controller's own hail timer.
    if (this.routineStatusCheckEscalation.hasAnyForUnit(unitId)) {
      this.log('STATUS_CHECK_PROMPT_TIMEOUT_CONTROLLER_ACTIVE', { unitId, callId: sessionCallId });
      return true;
    }
    const pending = this._findPendingStatusCheckForUnit(unitId, sessionCallId);
    const callId = pending?.callId || sessionCallId || null;
    const promptKind = pending?.escalated ? 'escalated' : 'due';
    const alreadyRePrompted = !!pending?.rePrompted;

    this.log('STATUS_CHECK_NO_RESPONSE', {
      unitId,
      callId,
      prompt: promptKind,
      rePrompted: alreadyRePrompted,
    });

    // Due flow, no re-prompt yet → speak one re-prompt and re-arm the timer.
    if (pending && !pending.escalated && !pending.rePrompted) {
      pending.rePrompted = true;
      pending.at = Date.now();
      try {
        await this.speak(`${unitId}, status check, second call.`, unitId, {
          retryOnBusy: true, retryContext: `STATUS_CHECK:reprompt:${unitId}`,
        });
      } catch (err) {
        this.log('STATUS_CHECK_REPROMPT_SPEAK_ERROR', { unitId, callId, error: err.message });
      }
      // Re-arm by re-asserting the awaiting state with the same slots.
      setUnitSessionState(unitId, DISPATCHER_STATE.AWAITING_STATUS_CHECK_RESPONSE, null, {
        statusCheckId: slots?.statusCheckId || null,
        statusCheckCallId: callId,
        statusCheckUnitUuid: slots?.statusCheckUnitUuid || null,
      }, true);
      return true; // suppress default reset
    }

    // Escalated flow, OR due-after-reprompt → surface to dispatcher console
    // and leave the pending entry in place so a late inbound ack can still
    // close the check via the durable speech-in fast path.
    try {
      if (cadService.isConfigured()) {
        const tag = callId ? ` (call ${callId})` : '';
        const reason = pending?.escalated ? 'escalated' : 'after re-prompt';
        await cadService.sendBroadcast(
          `Status check no response from ${unitId}${tag} (${reason})`,
          'high',
        );
      }
    } catch (err) {
      this.log('STATUS_CHECK_NO_RESPONSE_BROADCAST_ERROR', { unitId, callId, error: err.message });
    }
    this.log('STATUS_CHECK_ESCALATED_ALERT', {
      unitId, callId, severity: 'high', source: 'prompt_timeout', prompt: promptKind,
    });
    // Do not clear pending — durable ack should still work if the unit speaks
    // shortly after. Allow default reset to release the session to IDLE.
    return false;
  }

  async _onCadStatusCheckEvent(evt) {
    const { type, callId } = evt;
    // Prefer the radio callsign (unitNumber) for session/speech targeting;
    // fall back to unitId only if the callsign is missing.
    const unitId = evt.unitNumber || evt.unitId;
    if (!unitId) return;
    // Task #512: opportunistically cache callsign → CAD unit UUID from any CAD
    // status-check event so later close/cancel/update lookups can match
    // UUID-only assigned_units even before our own escalation runs.
    if (evt.unitNumber && evt.unitId && evt.unitNumber !== evt.unitId) {
      cadService.rememberUnitUuid(evt.unitNumber, evt.unitId);
    }
    const key = this._pendingStatusCheckKey(unitId, callId);

    if (type === 'status_check_due') {
      const existing = this._pendingStatusChecks.get(key);
      if (existing) {
        this.log('STATUS_CHECK_DUE_DEDUPED', { unitId, callId });
        return;
      }
      if (this.routineStatusCheckEscalation.has(unitId, callId)) {
        this.log('STATUS_CHECK_DUE_ESCALATION_ACTIVE', { unitId, callId });
        return;
      }
      const prevEntry = this._pendingStatusChecks.get(key);
      this._pendingStatusChecks.set(key, {
        unitId,
        callId,
        unitUuid: evt.unitId || prevEntry?.unitUuid || null,
        escalated: false,
        rePrompted: prevEntry?.rePrompted || false,
        at: Date.now(),
      });
      await this.routineStatusCheckEscalation.start(unitId, callId, {
        checkId: evt.raw?.id || evt.raw?.check_id || null,
        unitUuid: evt.unitId || prevEntry?.unitUuid || null,
        callNumber: evt.raw?.call_number || evt.raw?.callNumber || null,
      });
      this._lastSpokenStatusCheck.set(key, { at: Date.now(), escalated: false });
      return;
    }

    if (type === 'status_check_escalated') {
      // Task #501: routine status check escalation is normally driven end-to-end
      // by the AI dispatcher's RoutineStatusCheckEscalation controller.
      // When the controller is already running for this unit/call, the CAD
      // escalation event is just informational — ignore it so we don't
      // double-prompt. If no local controller is active (e.g. dispatcher
      // restart, or this came in before status_check_due), fall back to
      // bootstrapping the AI escalation now so the unit still gets the
      // full hail / page / all-call sequence.
      if (this.routineStatusCheckEscalation.has(unitId, callId)) {
        this.log('STATUS_CHECK_ESCALATED_CAD_EVENT_IGNORED', { unitId, callId, controllerActive: true });
        return;
      }
      this.log('STATUS_CHECK_ESCALATED_CAD_FALLBACK', { unitId, callId });
      this._pendingStatusChecks.set(key, { unitId, callId, escalated: true, at: Date.now() });
      await this.routineStatusCheckEscalation.start(unitId, callId, {
        checkId: evt.raw?.id || evt.raw?.check_id || null,
        unitUuid: evt.unitId || null,
        callNumber: evt.raw?.call_number || evt.raw?.callNumber || null,
      });
      this._lastSpokenStatusCheck.set(key, { at: Date.now(), escalated: true });
      return;
    }

    if (type === 'status_check_acknowledged'
        || type === 'status_check_snoozed'
        || type === 'status_check_cancelled') {
      this.log('STATUS_CHECK_PROMPT_SUPPRESSED', { reason: type, unitId, callId });
      this.routineStatusCheckEscalation.cancel(unitId, callId, `cad_${type}`);
      this._clearPendingStatusCheck(unitId, callId);
      return;
    }
  }

  _startStatusCheckPolling() {
    this._stopStatusCheckPolling();
    if (!cadService.isConfigured()) {
      this.log('STATUS_CHECK_POLLING_SKIPPED', { reason: 'CAD not configured' });
      return;
    }
    cadStatusCheckClient.start((evt) => {
      this._onCadStatusCheckEvent(evt).catch(err => {
        this.log('STATUS_CHECK_HANDLER_ERROR', { error: err.message });
      });
    });
    this.log('STATUS_CHECK_CLIENT_STARTED');
    this._startStatusCheckWatchdog();
  }

  _stopStatusCheckPolling() {
    cadStatusCheckClient.stop();
    this._pendingStatusChecks.clear();
    this._seenStatusCheckIds.clear();
    this._lastSpokenStatusCheck.clear();
    this._stopStatusCheckWatchdog();
  }

  // Task #486 (Step 6): backstop watchdog. CAD has occasionally failed to
  // fire status checks for on-scene units past the cadence (notably when
  // shared between channels). Once a minute we sweep active calls; for any
  // unit that's been on-scene >WATCHDOG_THRESHOLD_MS with no pending check
  // (and no snooze), we synthesize a status_check_due so the AI prompts.
  _startStatusCheckWatchdog() {
    this._stopStatusCheckWatchdog();
    const TICK_MS = 60 * 1000;
    this._statusCheckWatchdogFiredAt = this._statusCheckWatchdogFiredAt || new Map();
    this._statusCheckWatchdogTimer = setInterval(() => {
      this._runStatusCheckWatchdog().catch(err => {
        this.log('STATUS_CHECK_WATCHDOG_ERROR', { error: err.message });
      });
    }, TICK_MS);
    if (typeof this._statusCheckWatchdogTimer.unref === 'function') {
      this._statusCheckWatchdogTimer.unref();
    }
    this.log('STATUS_CHECK_WATCHDOG_STARTED');
  }

  _stopStatusCheckWatchdog() {
    if (this._statusCheckWatchdogTimer) {
      clearInterval(this._statusCheckWatchdogTimer);
      this._statusCheckWatchdogTimer = null;
    }
    if (this._statusCheckWatchdogFiredAt) this._statusCheckWatchdogFiredAt.clear();
  }

  async _runStatusCheckWatchdog() {
    if (!cadService.isConfigured()) return;
    if (!this._statusCheckWatchdogFiredAt) this._statusCheckWatchdogFiredAt = new Map();
    const WATCHDOG_THRESHOLD_MS = 22 * 60 * 1000; // 22 min — first cadence + small grace
    const COOLDOWN_MS = 5 * 60 * 1000;
    let activeCalls;
    try {
      activeCalls = await cadService.getActiveCalls();
    } catch (e) {
      this.log('STATUS_CHECK_WATCHDOG_FETCH_ERROR', { error: e.message });
      return;
    }
    const calls = activeCalls?.calls || activeCalls?.results || [];
    const now = Date.now();
    for (const call of calls) {
      const callId = call.call_id || call.id || call.call_number;
      const callNumber = call.call_number || call.callNumber || callId;
      const units = call.assigned_units || call.units || [];
      if (!Array.isArray(units) || units.length === 0) continue;
      for (const u of units) {
        if (!u || typeof u === 'string') continue;
        const status = String(u.status || u.unit_status || '').toLowerCase();
        if (status !== 'on_scene' && status !== 'on scene' && status !== 'onscene') continue;
        const csRaw = u.callsign || u.unit_callsign || u.unit_name || u.unit_id || u.id;
        if (!csRaw || this._looksLikeBackendId(String(csRaw))) continue;
        const callsign = String(csRaw).toUpperCase();
        const onSceneAtRaw = u.on_scene_at || u.onSceneAt || u.status_changed_at || u.statusChangedAt || u.assigned_at || u.assignedAt;
        const onSceneAt = onSceneAtRaw ? new Date(onSceneAtRaw).getTime() : NaN;
        if (!onSceneAt || isNaN(onSceneAt)) continue;
        if (now - onSceneAt < WATCHDOG_THRESHOLD_MS) continue;
        const key = this._pendingStatusCheckKey(callsign, callId);
        if (this._pendingStatusChecks.has(key)) continue;
        const lastFired = this._statusCheckWatchdogFiredAt.get(key) || 0;
        if (now - lastFired < COOLDOWN_MS) continue;
        // Snooze guard: if cadStatusCheckClient knows this unit is snoozed, skip.
        try {
          if (cadStatusCheckClient.isSnoozed && cadStatusCheckClient.isSnoozed(callsign, callId)) continue;
        } catch (_) { /* optional API */ }
        this._statusCheckWatchdogFiredAt.set(key, now);
        this.log('STATUS_CHECK_WATCHDOG_FIRED', { unitId: callsign, callId, callNumber, onSceneAgeMs: now - onSceneAt });
        try {
          await this._onCadStatusCheckEvent({
            type: 'status_check_due',
            unitId: u.unit_id || u.id || null,
            unitNumber: callsign,
            callId,
            raw: { call_number: callNumber, source: 'watchdog' },
          });
        } catch (e) {
          this.log('STATUS_CHECK_WATCHDOG_DISPATCH_ERROR', { error: e.message, unitId: callsign });
        }
      }
    }
  }

  async handleSnoozeStatusChecks(participantId, transcript, slots) {
    // Prefer the call_id of the currently-prompted status check (multi-call safety),
    // and fall back to the unit's current CAD assignment.
    const session = getUnitSessionState(participantId);
    const sessionCallId = (session?.state === DISPATCHER_STATE.AWAITING_STATUS_CHECK_RESPONSE)
      ? (session?.slots?.statusCheckCallId || null)
      : null;
    const callId = sessionCallId || await this._lookupCurrentCallId(participantId);
    const durationMin = parseInt(slots?.durationMinutes ?? slots?.minutes ?? '15', 10) || 15;
    const durationSec = durationMin * 60;
    if (!cadService.isConfigured()) {
      const resp = `${participantId}, CAD is not available.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      return;
    }
    // Snooze is per-call only — refuse if we can't scope it.
    if (!callId) {
      const resp = `${participantId}, no active call to snooze checks for.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      return;
    }
    try {
      const result = await cadService.snoozeStatusCheck(participantId, callId, durationSec);
      if (!result || result.success === false) {
        const resp = `${participantId}, snooze did not go through.`;
        await this.speak(resp, participantId);
        this.addConversationExchange(participantId, transcript, resp);
      } else {
        this._clearPendingStatusCheck(participantId, callId);
        const resp = `${participantId}, status checks snoozed ${durationMin} minutes.`;
        await this.speak(resp, participantId);
        this.addConversationExchange(participantId, transcript, resp);
      }
    } catch (err) {
      this.log('STATUS_CHECK_SNOOZE_ERROR', { error: err.message });
      const resp = `${participantId}, snooze failed.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
    }
    setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
  }

  async handleCancelStatusChecks(participantId, transcript, _slots) {
    // Prefer the call_id of the currently-prompted status check (multi-call
    // safety), then fall back to the unit's current CAD assignment.
    // Slot data from LLM is at most a display call number and is unsafe
    // to forward to CAD, which expects the call_id UUID.
    const session = getUnitSessionState(participantId);
    const sessionCallId = (session?.state === DISPATCHER_STATE.AWAITING_STATUS_CHECK_RESPONSE)
      ? (session?.slots?.statusCheckCallId || null)
      : null;
    const callInfo = await this._lookupCurrentCallInfo(participantId);
    const callId = sessionCallId || callInfo?.callId || null;
    const callNumber = callInfo?.callNumber || null;
    if (!callId) {
      const resp = `${participantId}, no active call to cancel checks for.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      return;
    }
    if (!cadService.isConfigured()) {
      const resp = `${participantId}, CAD is not available.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      return;
    }
    const reason = (typeof transcript === 'string' && transcript.trim()) ? transcript.trim() : null;
    try {
      const result = await cadService.cancelStatusCheck(participantId, callId, { reason });
      if (!result || result.success === false) {
        this.log('STATUS_CHECK_CANCEL_SENT', {
          unitId: participantId, callId, reason, success: false,
          statusCode: result?.statusCode ?? null, body: result,
        });
        const category = (result && (result.failureCategory || cadService.categorizeNoteFailure?.(result))) || null;
        const tail = category ? ` — ${category.replace(/_/g, ' ')}` : '';
        const resp = `${participantId}, unable to suspend status checks${tail}.`;
        await this.speak(resp, participantId);
        this.addConversationExchange(participantId, transcript, resp);
      } else {
        this.log('STATUS_CHECK_CANCEL_SENT', {
          unitId: participantId, callId, reason, success: true,
          statusCode: result?.statusCode ?? null, body: result,
        });
        // Stop any active escalation controller for this unit/call so we
        // don't keep paging while CAD has been told to stand down.
        try {
          if (this.routineStatusCheckEscalation?.has?.(participantId, callId)) {
            this.routineStatusCheckEscalation.cancel(participantId, callId, 'suspended');
          } else if (this.routineStatusCheckEscalation?.hasAnyForUnit?.(participantId)) {
            const esc = this.routineStatusCheckEscalation.hasAnyForUnit(participantId);
            this.routineStatusCheckEscalation.cancel(participantId, esc.callId, 'suspended');
          }
        } catch (e) {
          this.log('STATUS_CHECK_ESCALATION_CANCEL_ERROR', { error: e.message });
        }
        this._clearPendingStatusCheck(participantId, callId);
        const spoken = callNumber || callId;
        const resp = `${participantId}, 10-4, status checks suspended for call ${spoken}.`;
        await this.speak(resp, participantId);
        this.addConversationExchange(participantId, transcript, resp);
      }
    } catch (err) {
      this.log('STATUS_CHECK_CANCEL_ERROR', { error: err.message });
      const resp = `${participantId}, unable to suspend status checks — try again.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
    }
    setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
  }

  // Task #512: best-effort callsign → CAD unit UUID resolver. Pulls from
  // (1) any in-flight session slot we set up from a CAD event (e.g.
  // statusCheckUnitUuid) and (2) the cadService callsign→UUID cache populated
  // whenever we see a UUID. Returns null when nothing local is known.
  _resolveUnitUuidForCallsign(unitId) {
    if (!unitId) return null;
    try {
      const sess = getUnitSessionState(unitId);
      const slotUuid = sess?.slots?.statusCheckUnitUuid;
      if (slotUuid) return slotUuid;
    } catch (_e) { /* best-effort */ }
    try { return cadService.getCachedUnitUuid(unitId) || null; }
    catch (_e) { return null; }
  }

  async _lookupCurrentCallInfo(unitId) {
    try {
      if (!cadService.isConfigured()) return null;
      const unitUuid = this._resolveUnitUuidForCallsign(unitId);
      const data = await cadService.resolveUnitCurrentCall(unitId, { unitUuid });
      if (!data) return null;
      return {
        // Prefer the true CAD call_id (UUID) for API calls — never call_number,
        // which is only a display value.
        callId: data.call_id || data.callId || data.id || null,
        callNumber: data.call_number || data.callNumber || null,
      };
    } catch (err) {
      this.log('LOOKUP_CALL_INFO_ERROR', { unitId, error: err.message });
      return null;
    }
  }

  async _lookupCurrentCallId(unitId) {
    const info = await this._lookupCurrentCallInfo(unitId);
    return info?.callId || null;
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
    const boloDobLocal = bolo.dob ? (utcDateToLocalDate(bolo.dob) || bolo.dob) : '';
    const dob = boloDobLocal ? this._formatSpokenDate(boloDobLocal) : 'unknown';
    const reason = bolo.reason || 'No reason provided';
    const lastSeen = maybeUtcToLocalForSpeech(bolo.last_seen) || 'an unknown location';
    const contactAgency = bolo.contact_agency || agency;

    const now = new Date();
    const localToday = utcDateToLocalDate(now);
    const currentDate = this._formatSpokenDate(localToday);
    const currentTime = this._formatSpokenTime24(now);

    const openLine = `Attention all receiving units, prepare to copy a BOLO from ${agency}.`;

    const boloParagraph = `${agency} has issued a BOLO for ${fullName}, date of birth ${dob}. ${reason}. The individual was last seen ${lastSeen}. If any units come in contact with this individual, please contact ${contactAgency}. Check your MDT for additional info.`;

    const signOff = `Statewide Constable Communications Center, ${currentDate}, ${currentTime}.`;

    return { openLine, boloParagraph, signOff };
  }

  async _announcePersonBolo(bolo) {
    // Task #486 (Step 1, generalized): timer-driven announcements must
    // not talk over a live transmission. Defer if any non-AI unit has
    // produced inbound audio in the last few seconds — the BOLO will be
    // re-announced on the next poll if still unseen.
    if (this.channelName) {
      const recentRx = audioRelayService.hasRecentInbound(
        this.channelName,
        2500,
        [AI_IDENTITY]
      );
      if (recentRx) {
        const boloId = bolo.id || bolo.bolo_id || 'unknown';
        this.log('BOLO_ANNOUNCE_DEFERRED_LIVE_RX', { boloId, channel: this.channelName, heldBy: recentRx.unitId });
        // Drop from "seen" so we retry next poll cycle.
        this._seenBoloIds.delete(String(boloId));
        return;
      }
    }

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
          await this._addCallNoteSerial(unitId, unitData.call_id, note);
          this.log('CALL_NOTE_ADDED', { unitId, callId: unitData.call_id, note });
        }
      }
    } catch (error) {
      this.log('CALL_NOTE_ERROR', { error: error.message });
    }
  }

  // Task #482: shared classifier for "unit is going clear/available". Looks at
  // the unit's current call (if any), determines whether they are primary,
  // and whether they are the last unit on it. Three outcomes:
  //   - 'simple'              : not on a call, or on a call but not primary → just clear them
  //   - 'primary_last'        : primary AND last unit → close the call after clearing
  //   - 'primary_with_others' : primary but other units still on it → refuse, ask them to reassign primary first
  async _classifyClearOutcome(unitId) {
    let callInfo = null;
    try {
      callInfo = await cadService.resolveUnitCurrentCall(unitId, { unitUuid: this._resolveUnitUuidForCallsign(unitId) });
    } catch (e) {
      this.log('CLEAR_OUTCOME_LOOKUP_ERROR', { error: e.message });
      return { kind: 'simple', call: null, otherUnits: [] };
    }
    const callId = callInfo?.call_id || callInfo?.call_number || callInfo?.callNumber || null;
    if (!callId) return { kind: 'simple', call: null, otherUnits: [] };
    const callDisplay = callInfo.call_number || callInfo.callNumber || callId;
    const assignedUnits = Array.isArray(callInfo.assigned_units) ? callInfo.assigned_units.map(String) : [];
    const upperUnit = String(unitId).toUpperCase();
    const others = assignedUnits.filter(u => String(u).toUpperCase() !== upperUnit);
    const explicitPrimary = callInfo.primary_unit || callInfo.primaryUnit || null;
    let isPrimary;
    if (explicitPrimary) {
      isPrimary = String(explicitPrimary).toUpperCase() === upperUnit;
    } else {
      // No explicit primary → assume the first assigned unit is primary
      // (CAD convention). Single-unit cases are always primary.
      isPrimary = assignedUnits.length > 0 && String(assignedUnits[0]).toUpperCase() === upperUnit;
    }
    const callObj = { callId, callDisplay, assignedUnits, raw: callInfo };
    if (!isPrimary) return { kind: 'simple', call: callObj, otherUnits: others };
    if (others.length === 0) return { kind: 'primary_last', call: callObj, otherUnits: [] };
    return { kind: 'primary_with_others', call: callObj, otherUnits: others };
  }

  _formatUnitList(units) {
    const arr = (units || []).map(u => String(u).toUpperCase());
    if (arr.length === 0) return '';
    if (arr.length === 1) return arr[0];
    if (arr.length === 2) return `${arr[0]} and ${arr[1]}`;
    return arr.slice(0, -1).join(', ') + ', and ' + arr[arr.length - 1];
  }

  // Task #486 (Step 5): build a TTS-safe list of unit callsigns from a
  // mixed array of strings or objects. Anything that looks like a raw
  // backend ID (UUID, unit_<hex>, socket-style) is stripped so it never
  // reaches text-to-speech.
  _formatCallsignList(units) {
    if (!units) return '';
    const arr = Array.isArray(units) ? units : [units];
    const callsigns = [];
    for (const u of arr) {
      if (!u) continue;
      let cs;
      if (typeof u === 'string') cs = u;
      else cs = u.callsign || u.unit_callsign || u.unit_name || u.name || u.unit_id || u.id || '';
      cs = String(cs || '').trim();
      if (!cs) continue;
      if (this._looksLikeBackendId(cs)) continue;
      callsigns.push(cs.toUpperCase());
    }
    return this._formatUnitList(callsigns);
  }

  _looksLikeBackendId(s) {
    if (!s) return false;
    const t = String(s).trim();
    // UUID
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)) return true;
    // unit_<hex>, socket_<hex>, sess_<hex> style
    if (/^(unit|socket|sess|sid|conn)_[0-9a-z]{6,}$/i.test(t)) return true;
    // Long opaque hex blob
    if (/^[0-9a-f]{16,}$/i.test(t)) return true;
    return false;
  }

  // Task #486 (Step 5): scrub raw backend IDs from a string before TTS.
  // Returns { text, replaced } so callers can log when sanitization fired.
  _sanitizeForTts(text) {
    if (!text) return { text: '', replaced: 0 };
    let replaced = 0;
    let out = String(text);
    const patterns = [
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      /\b(?:unit|socket|sess|sid|conn)_[0-9a-z]{6,}\b/gi,
      /\b[0-9a-f]{24,}\b/gi,
    ];
    for (const p of patterns) {
      out = out.replace(p, () => { replaced++; return 'unit'; });
    }
    return { text: out, replaced };
  }

  // Task #486 (Step 4): map slot/transcript hints to a single field key.
  _resolveCallDetailsField(slots, transcript) {
    const explicit = String(slots?.detailField || slots?.field || '').toLowerCase().trim();
    if (explicit) return explicit;
    const t = String(transcript || '').toLowerCase();
    if (/\b(call\s*number|case\s*number|incident\s*number)\b/.test(t)) return 'call_number';
    if (/\b(address|location|where)\b/.test(t)) return 'address';
    if (/\b(nature|what.*for|what.*kind|type of call|reason)\b/.test(t)) return 'nature';
    if (/\b(priority|prio)\b/.test(t)) return 'priority';
    if (/\b(status)\b/.test(t)) return 'status';
    if (/\b(units?|who.*on|who.*assigned|on scene)\b/.test(t)) return 'units';
    if (/\b(notes?|comments?|remarks?|additional)\b/.test(t)) return 'notes';
    if (/\b(everything|full|details|all|recap|readout)\b/.test(t)) return 'all';
    return 'all';
  }

  _buildCallDetailsResponse(participantId, field, f) {
    const { callNum, nature, location, priority, status, notes, unitList } = f;
    switch (field) {
      case 'call_number':
        return `${participantId}, call number ${callNum}.`;
      case 'address':
        return `${participantId}, ${location}.`;
      case 'nature':
        return `${participantId}, ${String(nature).toLowerCase()}.`;
      case 'priority':
        return `${participantId}, priority ${priority}.`;
      case 'status':
        return `${participantId}, status ${status}.`;
      case 'units':
        return unitList
          ? `${participantId}, ${unitList} assigned.`
          : `${participantId}, no units assigned.`;
      case 'notes':
        return notes && String(notes).trim()
          ? `${participantId}, notes: ${String(notes).slice(0, 240)}.`
          : `${participantId}, no notes on the call.`;
      case 'all':
      default: {
        let resp = `${participantId}, ${callNum}, ${String(nature).toLowerCase()} at ${location}, priority ${priority}, status ${status}.`;
        if (unitList) resp += ` ${unitList} assigned.`;
        if (notes && String(notes).length > 0 && String(notes).length < 200) {
          resp += ` Notes: ${notes}.`;
        }
        return resp;
      }
    }
  }

  // Task #482: pull a disposition phrase out of a free-form transcript when
  // the unit says e.g. "10-8 with a report" or "available, warning issued".
  // Returns the raw phrase the unit spoke, or null if nothing recognized.
  _extractInlineDisposition(transcript) {
    const t = String(transcript || '').toLowerCase();
    if (!t) return null;
    // Look for "with X", "with a X", or trailing ", X" after a clear/available cue
    const patterns = [
      /\b(?:10-?8|10-?98|clear|available|in service)\b[^a-z0-9]*(?:with|by|on)\s+(?:a\s+|an\s+|the\s+)?([a-z][a-z\s\-]{2,40}?)(?:\.|,|;|$)/i,
      /\b(?:10-?8|10-?98|clear|available|in service)\s*[,-]\s*([a-z][a-z\s\-]{2,40}?)(?:\.|,|;|$)/i,
    ];
    for (const p of patterns) {
      const m = t.match(p);
      if (m && m[1]) {
        const phrase = m[1].trim().replace(/\s+/g, ' ');
        if (phrase.length >= 3) return phrase;
      }
    }
    return null;
  }

  _recentAssignmentKey(unitId) {
    return normalizeUnitId(unitId) || String(unitId || '').toUpperCase();
  }

  _recordRecentAssignment(unitId, callInfo, extras = {}) {
    if (!unitId || !callInfo) return;
    const callId = callInfo.call_id || callInfo.call_number || callInfo.callNumber || extras.callId;
    if (!callId) return;
    const key = this._recentAssignmentKey(unitId);
    const entry = {
      callId,
      callDisplay: callInfo.call_number || extras.callDisplay || callId,
      location: callInfo.location || callInfo.address || extras.location || null,
      nature: callInfo.nature || callInfo.call_nature || callInfo.type || extras.nature || null,
      crossStreets: callInfo.cross_streets || callInfo.crossStreets || extras.crossStreets || null,
      priority: callInfo.priority || callInfo.call_priority || extras.priority || null,
      lat: typeof callInfo.lat === 'number' ? callInfo.lat : (typeof extras.lat === 'number' ? extras.lat : null),
      lng: typeof callInfo.lng === 'number' ? callInfo.lng : (typeof extras.lng === 'number' ? extras.lng : null),
      channel: extras.channel || this.channelName || this.configuredChannel || '_default_',
      assignedAt: Date.now(),
    };
    this._recentAssignments.set(key, entry);
    this.log('RECENT_ASSIGNMENT_CACHED', { unitId: key, callId, callDisplay: entry.callDisplay });
  }

  _getRecentAssignment(unitId) {
    const key = this._recentAssignmentKey(unitId);
    const entry = this._recentAssignments.get(key);
    if (!entry) return null;
    if (Date.now() - entry.assignedAt > this.RECENT_ASSIGNMENT_TTL_MS) {
      this._recentAssignments.delete(key);
      return null;
    }
    return entry;
  }

  _clearRecentAssignment(unitId) {
    const key = this._recentAssignmentKey(unitId);
    if (this._recentAssignments.delete(key)) {
      this.log('RECENT_ASSIGNMENT_CLEARED', { unitId: key });
    }
  }

  // R10: Serialize CAD status updates per unit. Multiple in-flight calls for
  // the same unit (e.g. an assign + a clear racing) chain head-to-tail so
  // CAD never sees an out-of-order progression. Different units run in
  // parallel.
  _runStatusUpdateSerial(unitId, fn) {
    const key = String(unitId || '_unknown_').toLowerCase();
    const prev = this._statusUpdateQueues.get(key) || Promise.resolve();
    const next = prev.catch(() => {}).then(() => fn());
    this._statusUpdateQueues.set(key, next);
    next.finally(() => {
      if (this._statusUpdateQueues.get(key) === next) {
        this._statusUpdateQueues.delete(key);
      }
    }).catch(() => {});
    return next;
  }

  _updateUnitStatusSerial(unitId, status, ...rest) {
    return this._runStatusUpdateSerial(unitId, () => cadService.updateUnitStatus(unitId, status, ...rest));
  }

  // R10 wrappers: route assigns and notes through the per-unit status queue so
  // they can never land before an in-flight status update for the same unit.
  _assignUnitToCallSerial(unitId, callId, ...rest) {
    return this._runStatusUpdateSerial(unitId, () => cadService.assignUnitToCall(unitId, callId, ...rest));
  }

  _addCallNoteSerial(unitId, callId, note, ...rest) {
    return this._runStatusUpdateSerial(unitId, () => cadService.addCallNote(callId, note, ...rest));
  }

  // Task #502: map a CAD note-failure category to a short, dispatcher-friendly
  // phrase that's safe to put in spoken refusals and event-log entries.
  _noteFailureCategorySpoken(category) {
    switch (category) {
      case 'network':
      case 'timeout':
      case 'cad_5xx':
        return 'CAD unreachable';
      case 'cad_4xx':
      case 'cad_app_error':
        return 'CAD rejected';
      case 'no_active_call':
        return 'no active call';
      default:
        return 'CAD error';
    }
  }

  // Task #502: emit ONE structured log line + mirror the failure into the
  // dispatcher channel log so a human can see what CAD actually said.
  async _recordNoteFailure(path, info) {
    const {
      participantId,
      callId,
      noteLength,
      noteResult,
      reasonCategory,
    } = info || {};
    const category = reasonCategory
      || (noteResult && noteResult.failureCategory)
      || (noteResult ? cadService.categorizeNoteFailure(noteResult) : null)
      || 'unknown';
    const cadMessage = noteResult?.cadMessage
      || noteResult?.error
      || (noteResult?.responseBody && (noteResult.responseBody.error || noteResult.responseBody.message))
      || null;
    const statusCode = noteResult?.statusCode || null;
    const attempts = noteResult?.attempt || null;
    this.log('CAD_NOTE_FAILED', {
      path,
      unitId: participantId,
      callId: callId || null,
      category,
      categorySpoken: this._noteFailureCategorySpoken(category),
      cadMessage,
      statusCode,
      attempts,
      noteLength: noteLength || 0,
    });
    try {
      if (this.channelName) {
        const parts = [`[AI] Unable to add note (${this._noteFailureCategorySpoken(category)})`];
        if (callId) parts.push(`call ${callId}`);
        if (participantId) parts.push(`unit ${participantId}`);
        if (cadMessage) parts.push(`CAD: ${cadMessage}`);
        const text = parts.join(' — ');
        await createChannelMessage(this.channelName, 'AI-DISPATCHER', 'text', text).catch(() => {});
      }
    } catch (_) {}
  }

  // R10: Non-status CAD lifecycle calls (clear/dispose/cancel/reopen/notes)
  // must wait for any in-flight status updates for the same unit so CAD
  // never sees, e.g., a "clear" land before its prerequisite "on_scene".
  // Returns the tail Promise of that unit's queue, then chains onto it.
  _awaitStatusQueue(unitId, fn) {
    return this._runStatusUpdateSerial(unitId, fn);
  }

  // SEQ-10 helper: resolve a spoken call number to the canonical CAD callId
  // before issuing PUT /api/calls/:callId. Tries getCallDetails first (cheap
  // path when input is already an id); falls back to scanning active calls
  // for a matching call_number; finally returns the input unchanged.
  async _resolveCallId(callNumberOrId) {
    if (!callNumberOrId) return null;
    const input = String(callNumberOrId).trim();
    if (!input) return null;
    try {
      if (typeof cadService.getCallDetails === 'function') {
        const direct = await cadService.getCallDetails(input);
        const directCall = direct?.call || direct?.data || direct;
        const directId = directCall?.id || directCall?.call_id;
        if (direct?.success !== false && directId) {
          return String(directId);
        }
      }
    } catch (_e) { /* fall through */ }
    try {
      const active = await cadService.getActiveCalls();
      const list = Array.isArray(active?.calls) ? active.calls
                  : Array.isArray(active?.data) ? active.data
                  : Array.isArray(active) ? active
                  : [];
      const norm = input.toLowerCase();
      const match = list.find(c => {
        const cn = String(c?.call_number || c?.callNumber || '').toLowerCase();
        const cid = String(c?.id || c?.call_id || '').toLowerCase();
        return cn === norm || cid === norm;
      });
      if (match) return String(match.id || match.call_id || input);
    } catch (_e) { /* ignore */ }
    return input;
  }

  _backupRequestKey(callId) {
    const channel = this.channelName || this.configuredChannel || '_default_';
    return `${channel}::${callId}`;
  }

  _findActiveBackupRequestForChannel() {
    const channel = this.channelName || this.configuredChannel || '_default_';
    let oldest = null;
    for (const req of this.openBackupRequests.values()) {
      if (req.channel !== channel) continue;
      if (!oldest || req.createdAt < oldest.createdAt) oldest = req;
    }
    return oldest;
  }

  _normalizeForBackupMatch(text) {
    return String(text || '').toLowerCase().replace(/[.,!?]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  _isBackupVolunteerPhrase(text) {
    const t = this._normalizeForBackupMatch(text);
    if (!t) return false;
    const patterns = [
      /\bi(?:'| a)?ll head that way\b/,
      /\bi(?:'| a)?ll head over\b/,
      /\bi(?:'| a)?ll take (?:it|that)\b/,
      /\bi(?:'| a)?ll grab (?:it|that)\b/,
      /\bi(?:'| a)?ll get (?:it|that)\b/,
      /\bi(?:'| a)?ll respond\b/,
      /\bi(?:'| a)?ll roll\b/,
      /\bi can take (?:it|that)\b/,
      /\bi can head that way\b/,
      /\bi got (?:it|that one|this)\b/,
      /\bi'?ve got (?:it|that)\b/,
      /\bshow me (?:en[-\s]?route|10[-\s]?76)(?:\s+to\s+that)?\b/,
      /\b10[-\s]?76 to (?:that|it|the call|the backup)\b/,
      /\b10[-\s]?76,? backup\b/,
      /\bput me en[-\s]?route\b/,
      /\bcopy(?:,)? (?:i'?ll|i can|i'?ve got)\b/,
      /\bon my way\b/,
    ];
    return patterns.some(rx => rx.test(t));
  }

  _isBackupQuestionPhrase(text) {
    const t = this._normalizeForBackupMatch(text);
    if (!t) return null;
    if (/\b(repeat|say again|10[-\s]?9)\b.*\b(address|location|nature|call)\b/.test(t)) return 'all';
    if (/\b(what(?:'s| is) the (?:address|location)|where (?:is|was) (?:that|the call|it))\b/.test(t)) return 'address';
    if (/\b(what(?:'s| is) the nature|what kind of call|what type of call|what(?:'s| is) the call)\b/.test(t)) return 'nature';
    if (/\b(cross street|cross[-\s]?streets)\b/.test(t)) return 'cross';
    if (/\b(how far(?: is (?:that|it|this))?|distance|closest cross street)\b/.test(t)) return 'distance';
    if (/\b(repeat (?:that|it)|say again)\b/.test(t)) return 'all';
    return null;
  }

  _isBackupDisregardPhrase(text) {
    const t = this._normalizeForBackupMatch(text);
    if (!t) return false;
    return /\b(disregard|cancel|negative)\b.*\b(backup|another unit|the (?:request|call for backup))\b/.test(t)
      || /\b(disregard|cancel) the backup request\b/.test(t)
      || /\bbackup request,?\s*disregard\b/.test(t);
  }

  async _handleOpenBackupRequestUtterance(speakerUnitId, transcript) {
    const req = this._findActiveBackupRequestForChannel();
    if (!req) return false;
    const key = this._backupRequestKey(req.callId);
    const speakerNorm = String(speakerUnitId || '').toUpperCase();
    const requesterNorm = String(req.requesterUnit || '').toUpperCase();

    if (this._isBackupDisregardPhrase(transcript)) {
      this.log('BACKUP_REQUEST_DISREGARD', { key, speaker: speakerNorm, requester: requesterNorm });
      const isRequester = speakerNorm === requesterNorm;
      const ackTarget = isRequester ? requesterNorm : speakerNorm;
      this._clearBackupRequest(key, 'disregard');
      const resp = `${ackTarget}, 10-4, backup request disregarded.`;
      await this.speak(resp, speakerUnitId);
      this.addConversationExchange(speakerUnitId, transcript, resp);
      return true;
    }

    if (speakerNorm === requesterNorm) {
      return false;
    }

    if (this._isBackupVolunteerPhrase(transcript)) {
      this.log('BACKUP_REQUEST_VOLUNTEER', { key, volunteer: speakerNorm, requester: requesterNorm, callId: req.callId });
      await this._assignBackupVolunteer(speakerUnitId, transcript, req);
      return true;
    }

    const qType = this._isBackupQuestionPhrase(transcript);
    if (qType) {
      this.log('BACKUP_REQUEST_QUESTION', { key, asker: speakerNorm, questionType: qType });
      await this._answerBackupQuestion(speakerUnitId, transcript, req, qType);
      return true;
    }

    return false;
  }

  async _assignBackupVolunteer(volunteerUnitId, transcript, req) {
    const volunteerDisplay = String(volunteerUnitId).toUpperCase();
    let assigned = false;
    let enRouteOk = false;

    try {
      if (cadService.isConfigured() && req.callId) {
        const assignResult = await this._assignUnitToCallSerial(volunteerDisplay, req.callId);
        assigned = assignResult?.success !== false;
        if (assigned) {
          this._recordRecentAssignment(volunteerDisplay, {}, {
            callId: req.callId,
            callDisplay: req.callDisplay,
            location: req.location,
            nature: req.nature,
            crossStreets: req.crossStreets,
            priority: req.priority,
            lat: req.callLat,
            lng: req.callLng,
            channel: req.channel,
          });
          try {
            const statusResult = await this._updateUnitStatusSerial(volunteerDisplay, 'en_route');
            enRouteOk = !!statusResult?.success;
          } catch (statusErr) {
            this.log('BACKUP_VOLUNTEER_STATUS_ERROR', { volunteer: volunteerDisplay, error: statusErr.message });
          }
        } else {
          this.log('BACKUP_VOLUNTEER_ASSIGN_FAILED', { volunteer: volunteerDisplay, callId: req.callId, error: assignResult?.error });
        }
      }
    } catch (err) {
      this.log('BACKUP_VOLUNTEER_ERROR', { volunteer: volunteerDisplay, error: err.message });
    }

    req.assignedVolunteers = req.assignedVolunteers || [];
    req.assignedVolunteers.push(volunteerDisplay);

    let resp;
    if (assigned) {
      resp = `${volunteerDisplay} copy en route to ${req.location || 'the call'} for ${req.nature || 'the call'}, assisting ${req.requesterUnit}.`;
      if (!enRouteOk) {
        resp += ' Update your status via the MDT.';
      }
    } else {
      resp = `${volunteerDisplay}, 10-4, copy en route to assist ${req.requesterUnit}. CAD assignment failed, attach via MDT.`;
    }

    await this.speak(resp, volunteerUnitId);
    this.addConversationExchange(volunteerUnitId, transcript, resp);
  }

  async _answerBackupQuestion(askerUnitId, transcript, req, qType) {
    let answer;
    const loc = req.location || 'unknown location';
    const nat = req.nature || 'unknown nature';
    const cross = req.crossStreets;
    const priority = req.priority;

    switch (qType) {
      case 'address':
        answer = cross
          ? `${askerUnitId}, address is ${loc}, cross of ${cross}.`
          : `${askerUnitId}, address is ${loc}.`;
        break;
      case 'nature':
        answer = priority
          ? `${askerUnitId}, call nature is ${nat}, priority ${priority}.`
          : `${askerUnitId}, call nature is ${nat}.`;
        break;
      case 'cross':
        answer = cross
          ? `${askerUnitId}, cross streets ${cross}.`
          : `${askerUnitId}, no cross streets on file.`;
        break;
      case 'distance': {
        const dd = await this._computeDistanceAndDirection(askerUnitId, req).catch(() => null);
        if (dd && dd.miles != null) {
          const milesStr = dd.miles < 0.1 ? 'less than a tenth of a mile' : `${dd.miles.toFixed(1)} miles`;
          answer = `${askerUnitId}, you are approximately ${milesStr}${dd.bearing ? ` ${dd.bearing}` : ''} of the call at ${loc}.`;
        } else {
          answer = `${askerUnitId}, unable to determine your distance, call is at ${loc}.`;
        }
        break;
      }
      case 'all':
      default: {
        const parts = [`${askerUnitId},`, nat, `at ${loc}`];
        if (cross) parts.push(`cross of ${cross}`);
        if (priority) parts.push(`priority ${priority}`);
        parts.push(`assisting ${req.requesterUnit}.`);
        answer = parts.join(' ').replace(/\s+,/g, ',');
        break;
      }
    }

    await this.speak(answer, askerUnitId);
    this.addConversationExchange(askerUnitId, transcript, answer);
  }

  async _computeDistanceAndDirection(askerUnitId, req) {
    let askerCoords = null;
    try {
      const loc = locationService.getLocation(askerUnitId);
      if (loc && typeof loc.lat === 'number' && typeof loc.lng === 'number') {
        askerCoords = { lat: loc.lat, lng: loc.lng };
      }
    } catch (_) {}

    let callCoords = null;
    if (typeof req.callLat === 'number' && typeof req.callLng === 'number') {
      callCoords = { lat: req.callLat, lng: req.callLng };
    } else if (req.location) {
      try {
        const geo = await locationService.forwardGeocode(req.location);
        if (geo && typeof geo.lat === 'number' && typeof geo.lng === 'number') {
          callCoords = { lat: geo.lat, lng: geo.lng };
          req.callLat = geo.lat;
          req.callLng = geo.lng;
        }
      } catch (_) {}
    }

    if (!askerCoords || !callCoords) return null;

    const toRad = (d) => (d * Math.PI) / 180;
    const R = 3958.8;
    const dLat = toRad(callCoords.lat - askerCoords.lat);
    const dLng = toRad(callCoords.lng - askerCoords.lng);
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(askerCoords.lat)) * Math.cos(toRad(callCoords.lat)) * Math.sin(dLng / 2) ** 2;
    const miles = 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    const y = Math.sin(toRad(callCoords.lng - askerCoords.lng)) * Math.cos(toRad(callCoords.lat));
    const x = Math.cos(toRad(askerCoords.lat)) * Math.sin(toRad(callCoords.lat)) -
      Math.sin(toRad(askerCoords.lat)) * Math.cos(toRad(callCoords.lat)) * Math.cos(toRad(callCoords.lng - askerCoords.lng));
    const bearingDeg = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    const dirs = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
    const compass = dirs[Math.round(bearingDeg / 45) % 8];
    const opposite = { north: 'south', northeast: 'southwest', east: 'west', southeast: 'northwest', south: 'north', southwest: 'northeast', west: 'east', northwest: 'southeast' };
    return { miles, bearing: opposite[compass] + ' of' };
  }

  async handleBackupRequestStart(participantId, transcript) {
    this.log('BACKUP_REQUEST_START', { participant: participantId, transcript });

    if (!cadService.isConfigured()) {
      const resp = `${participantId}, CAD system not available.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      return;
    }

    let currentCall;
    let callSource = 'cad';
    try {
      currentCall = await cadService.resolveUnitCurrentCall(participantId, { unitUuid: this._resolveUnitUuidForCallsign(participantId) });
    } catch (err) {
      this.log('BACKUP_REQUEST_CAD_ERROR', { participant: participantId, error: err.message, attempt: 1 });
    }
    let callId = currentCall?.call_id || currentCall?.call_number || currentCall?.callNumber;

    if (!callId) {
      await new Promise(resolve => setTimeout(resolve, 500));
      try {
        currentCall = await cadService.resolveUnitCurrentCall(participantId, { unitUuid: this._resolveUnitUuidForCallsign(participantId) });
      } catch (err) {
        this.log('BACKUP_REQUEST_CAD_ERROR', { participant: participantId, error: err.message, attempt: 2 });
        currentCall = null;
      }
      callId = currentCall?.call_id || currentCall?.call_number || currentCall?.callNumber;
      if (callId) callSource = 'cad-retry';
    }

    let cachedAssignment = null;
    if (!callId) {
      cachedAssignment = this._getRecentAssignment(participantId);
      if (cachedAssignment) {
        callId = cachedAssignment.callId;
        callSource = 'recent-assignment-cache';
      }
    }

    this.log('BACKUP_REQUEST_CALL_LOOKUP', { participant: participantId, callId: callId || null, source: callId ? callSource : 'none' });

    if (!callId) {
      const resp = `${participantId}, you're not assigned to a call.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);
      return;
    }

    const reqKey = this._backupRequestKey(callId);
    if (this.openBackupRequests.has(reqKey)) {
      const existing = this.openBackupRequests.get(reqKey);
      const resp = `${participantId}, backup request already open for ${existing.requesterUnit} on this call, standby.`;
      await this.speak(resp, participantId);
      this.addConversationExchange(participantId, transcript, resp);
      return;
    }

    const location = currentCall?.location || currentCall?.address || cachedAssignment?.location || null;
    const nature = currentCall?.nature || currentCall?.call_nature || currentCall?.type || cachedAssignment?.nature || null;
    const crossStreets = currentCall?.cross_streets || currentCall?.crossStreets || cachedAssignment?.crossStreets || null;
    const priority = currentCall?.priority || currentCall?.call_priority || cachedAssignment?.priority || null;
    const channel = this.channelName || this.configuredChannel || '_default_';
    const callLat = typeof currentCall?.lat === 'number'
      ? currentCall.lat
      : (typeof cachedAssignment?.lat === 'number' ? cachedAssignment.lat : null);
    const callLng = typeof currentCall?.lng === 'number'
      ? currentCall.lng
      : (typeof cachedAssignment?.lng === 'number' ? cachedAssignment.lng : null);
    const callDisplay = currentCall?.call_number || cachedAssignment?.callDisplay || callId;

    const req = {
      requesterUnit: String(participantId).toUpperCase(),
      channel,
      key: reqKey,
      callId,
      callDisplay,
      location,
      nature,
      crossStreets,
      priority,
      callLat,
      callLng,
      requesterTranscript: transcript,
      requestText: transcript,
      audioUrl: null,
      recordingMessageId: null,
      retriesLeft: 1,
      timer: null,
      assignedVolunteers: [],
      createdAt: Date.now(),
    };
    this.openBackupRequests.set(reqKey, req);
    setUnitSessionState(participantId, DISPATCHER_STATE.IDLE, null, {}, true);

    const broadcast = `Any unit in the area of ${location || 'unknown location'} available to assist ${req.requesterUnit} with a ${nature || 'call'}?`;
    req.airBroadcast = broadcast;
    await this.speak(broadcast, participantId);
    this.addConversationExchange(participantId, transcript, broadcast);

    this._pageBackupRosterAfterRecording(req).catch(err => {
      this.log('BACKUP_REQUEST_PAGE_ERROR', { error: err.message });
    });

    this._scheduleBackupRequestTimeout(reqKey);
  }

  async _pageBackupRosterAfterRecording(req) {
    const audioMsg = await this._findRecentRecordingFor(req.requesterUnit);
    if (audioMsg) {
      req.audioUrl = audioMsg.audio_url;
      req.recordingMessageId = audioMsg.id;
    }

    const pageMessage = [
      `BACKUP REQUEST from ${req.requesterUnit}`,
      req.location ? `Location: ${req.location}` : null,
      req.nature ? `Nature: ${req.nature}` : null,
      req.priority ? `Priority: ${req.priority}` : null,
      req.crossStreets ? `Cross: ${req.crossStreets}` : null,
      req.requesterTranscript ? `Request: "${req.requesterTranscript}"` : null,
    ].filter(Boolean).join(' | ');

    try {
      const result = await sendPageToList('backup_request', pageMessage, req.requesterUnit, req.audioUrl);
      this.log('BACKUP_REQUEST_PAGE_SENT', {
        requester: req.requesterUnit,
        callId: req.callId,
        audioUrl: req.audioUrl,
        memberCount: result?.memberCount,
        tokenCount: result?.tokenCount,
        pageId: result?.page?.id,
      });
    } catch (err) {
      this.log('BACKUP_REQUEST_PAGE_ERROR', { requester: req.requesterUnit, error: err.message });
    }
  }

  async _findRecentRecordingFor(unitId, maxWaitMs = 5000) {
    const channel = this.channelName;
    if (!channel) return null;
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      try {
        const msg = await getRecentAudioMessageBySender(channel, unitId, 30000);
        if (msg) return msg;
      } catch (err) {
        this.log('BACKUP_REQUEST_RECORDING_LOOKUP_ERROR', { error: err.message });
        return null;
      }
      await new Promise(r => setTimeout(r, 500));
    }
    return null;
  }

  _scheduleBackupRequestTimeout(reqKey) {
    const req = this.openBackupRequests.get(reqKey);
    if (!req) return;
    const timeoutMs = parseInt(process.env.AI_BACKUP_REQUEST_TIMEOUT_MS || '60000', 10);
    if (req.timer) clearTimeout(req.timer);
    req.timer = setTimeout(() => {
      this._onBackupRequestTimeout(reqKey).catch(err => {
        this.log('BACKUP_REQUEST_TIMEOUT_HANDLER_ERROR', { error: err.message });
      });
    }, timeoutMs);
  }

  async _onBackupRequestTimeout(reqKey) {
    const req = this.openBackupRequests.get(reqKey);
    if (!req) return;
    if (req.assignedVolunteers && req.assignedVolunteers.length > 0) {
      this.log('BACKUP_REQUEST_TIMEOUT_BUT_HAS_VOLUNTEERS', { key: reqKey, volunteers: req.assignedVolunteers });
      this._clearBackupRequest(reqKey, 'volunteers_responded');
      return;
    }
    if (req.retriesLeft > 0) {
      req.retriesLeft -= 1;
      this.log('BACKUP_REQUEST_REBROADCAST', { key: reqKey, requester: req.requesterUnit, retriesLeft: req.retriesLeft });
      const rebroadcast = `Repeat: any unit in the area of ${req.location || 'unknown location'} available to assist ${req.requesterUnit} with a ${req.nature || 'call'}?`;
      try {
        await this.speak(rebroadcast);
      } catch (err) {
        this.log('BACKUP_REQUEST_REBROADCAST_ERROR', { error: err.message });
      }
      try {
        const pageMessage = [
          `BACKUP REQUEST (repeat) from ${req.requesterUnit}`,
          req.location ? `Location: ${req.location}` : null,
          req.nature ? `Nature: ${req.nature}` : null,
          req.priority ? `Priority: ${req.priority}` : null,
          req.requesterTranscript ? `Request: "${req.requesterTranscript}"` : null,
        ].filter(Boolean).join(' | ');
        await sendPageToList('backup_request', pageMessage, req.requesterUnit, req.audioUrl);
      } catch (err) {
        this.log('BACKUP_REQUEST_REPAGE_ERROR', { error: err.message });
      }
      this._scheduleBackupRequestTimeout(reqKey);
      return;
    }

    this.log('BACKUP_REQUEST_NEGATIVE', { key: reqKey, requester: req.requesterUnit });
    const final = `${req.requesterUnit}, negative response on the channel.`;
    this._clearBackupRequest(reqKey, 'negative_response');
    try {
      await this.speak(final, req.requesterUnit);
    } catch (err) {
      this.log('BACKUP_REQUEST_FINAL_SPEAK_ERROR', { error: err.message });
    }
  }

  _clearBackupRequest(reqKey, reason) {
    const req = this.openBackupRequests.get(reqKey);
    if (!req) return;
    if (req.timer) clearTimeout(req.timer);
    this.openBackupRequests.delete(reqKey);
    this.log('BACKUP_REQUEST_CLEARED', { key: reqKey, requester: req.requesterUnit, reason });
  }

  async speak(text, participantId = null, options = {}) {
    const enqueued = this._speakQueue.then(async () => {
      this.log('SPEAK', { text, unit: participantId || '(broadcast)', channel: this.channelName, options });
      const turnCtx = participantId ? this._turnContextByUnit.get(participantId) : null;
      if (turnCtx) {
        this.logSpeechEvent(participantId, turnCtx.transcript, turnCtx.intent, text);
        this._turnContextByUnit.delete(participantId);
      }
      let playbackStartSent = false;
      try {
        // Task #486 (Step 5): final boundary scrub — if any caller leaks
        // a UUID/socket/unit_<hex> ID into the TTS string, replace it with
        // the word "unit" so we never speak raw backend identifiers.
        const sanitized = this._sanitizeForTts(text);
        if (sanitized.replaced > 0) {
          this.log('TTS_SANITIZED_RAW_ID', { original: text, scrubbed: sanitized.text, count: sanitized.replaced });
        }
        const audio = await textToSpeech(sanitized.text);
        // Task #515: mirror playToneAndSpeak's ai-playback-start/end so any UI
        // gating on those events sees the AI as "done" after a normal ack.
        await this.sendDataMessage({ type: 'ai-playback-start' });
        playbackStartSent = true;
        await this.publishAudio(audio, sanitized.text, { retryOnBusy: true, retryWaitMs: 3000, ...options });
        await this.sendDataMessage({ type: 'ai-playback-end' });
      } catch (err) {
        this.log('SPEAK_ERROR', { error: err.message });
        if (playbackStartSent) {
          await this.sendDataMessage({ type: 'ai-playback-end' }).catch(() => {});
        }
      }
      if (participantId) {
        const session = getUnitSessionState(participantId);
        setUnitSessionState(participantId, session?.state || 'IDLE', null, {
          lastSpokenText: text
        }, false);
      }
    });
    this._speakQueue = enqueued.catch(() => {});
    return enqueued;
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
    let acquiredKey = null;
    let acquiredAtMs = null;
    let lastFrameAtMs = null;
    let releaseSource = 'normal';
    let framesSent = 0;
    let silentFramesSent = 0;
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

      acquiredKey = this.channelName;
      acquiredAtMs = Date.now();

      await new Promise(resolve => setTimeout(resolve, 300));

      const startTime = Date.now();
      const FRAME_MS = 20;

      try {
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
          framesSent++;

          const expectedTime = (i + 1) * FRAME_MS;
          const elapsed = Date.now() - startTime;
          const sleepTime = Math.max(0, expectedTime - elapsed);
          if (sleepTime > 0) {
            await new Promise(resolve => setTimeout(resolve, sleepTime));
          }
        }

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
          silentFramesSent++;
          await new Promise(resolve => setTimeout(resolve, FRAME_MS));
        }

        lastFrameAtMs = Date.now();

        // Task #515: short post-roll (was 800ms — now 100ms). The trailing
        // silent frames already act as a clean end-of-TX marker; 100 ms
        // gives jitter buffers a little slack without holding the channel.
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (innerErr) {
        releaseSource = 'catch';
        this.log('PUBLISH_STREAM_ERROR', { error: innerErr.message });
      }

      if (responseText && this.channelName) {
        try {
          const wavHeader = createWavHeader(audioBuffer.length, AZURE_SAMPLE_RATE, CHANNELS, 16);
          const wavBuffer = Buffer.concat([wavHeader, audioBuffer]);
          if (!isValidWav(wavBuffer)) {
            this.log('CHAT_RECORD_INVALID_WAV', { channel: this.channelName, size: wavBuffer.length });
          } else {
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
          }
        } catch (chatErr) {
          this.log('CHAT_RECORD_ERROR', { error: chatErr.message });
        }
      }

    } catch (error) {
      releaseSource = 'catch';
      this.log('PUBLISH_ERROR', { error: error.message });
    } finally {
      if (acquiredKey) {
        const releaseKey = this.channelName;
        const released = floorControlService.releaseFloor(acquiredKey, AI_IDENTITY);
        let fellBackToReleaseAll = false;
        if (!released) {
          const releasedKeys = floorControlService.releaseAllForUnit(AI_IDENTITY);
          fellBackToReleaseAll = true;
          if (releaseSource === 'normal') releaseSource = 'finally';
          this.log('PUBLISH_FLOOR_KEY_DRIFT', {
            acquiredKey,
            releaseKey,
            releasedKeys,
          });
        }
        const releasedAtMs = Date.now();
        this.log('AI_FLOOR_LIFECYCLE', {
          acquiredAtMs,
          lastFrameAtMs,
          releasedAtMs,
          releaseSource,
          acquiredKey,
          releaseKey,
          framesSent,
          silentFramesSent,
          fellBackToReleaseAll,
        });
      }
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
