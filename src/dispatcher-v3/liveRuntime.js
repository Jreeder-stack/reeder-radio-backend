import { audioRelayService } from '../services/audioRelayService.js';
import { signalingService } from '../services/signalingService.js';
import { speechToText, textToSpeech } from '../services/azureSpeechService.js';
import { opusCodec } from '../services/opusCodec.js';
import { floorControlService, AI_FLOOR_IDENTITY } from '../services/floorControlService.js';
import { buildV3RuntimeContext } from './runtimeContract.js';
import { CommandLinkGateway } from './cadGateway.js';
import { UnitIdentityService } from './unitIdentity.js';
import { V3OperationalContextService } from './operationalContext.js';
import { V3OperationalAlertService } from './operationalAlertService.js';
import { createDefaultV3ActionHandlers } from './defaultActionHandlers.js';
import { V3ActionExecutor } from './actionExecutor.js';
import { V3DiagnosticsJournal } from './diagnostics.js';
import { V3SpeechPipeline } from './speechPipeline.js';
import { V3IntentPlanner } from './intentPlanner.js';
import { V3ConversationGate } from './conversationGate.js';
import { materializeV3Plan } from './planMaterializer.js';
import { composeV3Response } from './responseComposer.js';
import { createV3CorrelationId } from './correlation.js';

const TX_FRAME_MS = 20;
const MIN_EXECUTION_CONFIDENCE = 0.7;
const FLOOR_WAIT_MS = 3000;
const FLOOR_RETRY_MS = 100;
const FLOOR_REARM_MS = 1800;
const NUMBER_WORD_RX = /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/i;
const HAIL_COMMAND_RX = /\b(status|show|mark|put|set|create|start|close|clear|assign|attach|add|note|check|time|backup|emergency|responding|en\s+route|on\s+scene|available|out\s+of\s+service|off\s+duty|on\s+duty|zone|switch|move|copy|radio\s+check)\b/i;

export class V3LiveDispatcher {
  constructor({
    runtimeContext,
    scopes = [],
    diagnostics = null,
    planner = null,
    transcribe = speechToText,
    synthesize = textToSpeech,
    conversationGate = null,
    audioRelay = audioRelayService,
    codec = opusCodec,
    floorControl = floorControlService,
    signaling = signalingService,
  } = {}) {
    this.context = buildV3RuntimeContext({ ...runtimeContext, scopes });
    this.runtimeContext = this.context;
    this.identity = this.context.identity;
    this.channelAliases = new Set([String(this.context.channelId), this.context.roomKey, this.context.channelName].filter(Boolean));
    this.configuredChannel = this.context.roomKey;
    this.displayChannel = this.context.channelName || this.context.roomKey;
    this.isRunning = false;
    this.connected = false;
    this._sequence = 1;
    this._recentContext = [];
    this._processing = new Set();

    this.audioRelay = audioRelay;
    this.codec = codec;
    this.floorControl = floorControl;
    this.signaling = signaling;
    this.diagnostics = diagnostics || new V3DiagnosticsJournal();
    this.gateway = new CommandLinkGateway(this.context);
    this.unitIdentityService = new UnitIdentityService({ gateway: this.gateway, context: this.context });
    this.operationalContextService = new V3OperationalContextService({ gateway: this.gateway, unitIdentityService: this.unitIdentityService });
    this.operationalAlertService = new V3OperationalAlertService({ signalingService: this.signaling });
    this.handlers = createDefaultV3ActionHandlers({ gateway: this.gateway, unitIdentityService: this.unitIdentityService, operationalAlertService: this.operationalAlertService });
    this.executor = new V3ActionExecutor({ runtimeContext: this.context, handlers: this.handlers, diagnostics: this.diagnostics });
    this.speech = new V3SpeechPipeline({ runtimeContext: this.context, transcribe, codec: this.codec, diagnostics: this.diagnostics });
    this.planner = planner || new V3IntentPlanner({ diagnostics: this.diagnostics });
    this.conversationGate = conversationGate || new V3ConversationGate();
    this.synthesize = synthesize;
    this._audioListener = (frame) => this.speech.pushFrame(frame);
  }

  async start() {
    if (this.isRunning) return true;
    this.audioRelay.addAudioListener(this.context.roomKey, this.identity, this._audioListener);
    if (String(this.context.channelId) !== String(this.context.roomKey)) {
      this.audioRelay.addAudioListener(this.context.channelId, this.identity, this._audioListener);
    }
    this.isRunning = true;
    this.connected = true;
    this._diag('runtime_started', null, true, { identity: this.identity });
    return true;
  }

  async stop() {
    this.audioRelay.removeAllAudioListeners(this.identity);
    this.floorControl.releaseAllForUnit?.(AI_FLOOR_IDENTITY);
    this.speech.clear();
    this.conversationGate.clearAll();
    this._processing.clear();
    this.isRunning = false;
    this.connected = false;
    this._diag('runtime_stopped', null, true);
    return true;
  }

  matchesChannel(channelId) {
    return this.channelAliases.has(String(channelId));
  }

  getPipelineStatus() {
    return {
      version: 'v3',
      running: this.isRunning,
      connected: this.connected,
      dispatchCenterId: this.context.dispatchCenterId,
      channelId: this.context.channelId,
      roomKey: this.context.roomKey,
      processing: this._processing.size,
      recentDiagnostics: this.diagnostics.getRecent({ runtimeId: this.context.runtimeId, limit: 10 }),
    };
  }

  async handlePttStart(channelId, unitId) {
    if (!this.isRunning || !this.matchesChannel(channelId) || unitId === this.identity) return false;
    const correlationId = createV3CorrelationId(this.context.runtimeId);
    this.speech.startTransmission({ unitId, channelId, correlationId });
    return true;
  }

  async handlePttEnd(channelId, unitId) {
    if (!this.isRunning || !this.matchesChannel(channelId) || unitId === this.identity) return false;
    const transmission = await this.speech.endTransmission({ unitId });
    if (!transmission?.transcript) return false;
    const gate = this.conversationGate.shouldProcess({ unitId, transcript: transmission.transcript });
    if (!gate.allowed) {
      this._diag('transmission_ignored', transmission.correlationId, true, { unitId, reason: gate.reason, transcript: transmission.transcript });
      return false;
    }
    transmission.transcript = gate.transcript || transmission.transcript;

    if (gate.reason === 'wake_word') {
      const hail = normalizeV3RadioHail(transmission.transcript);
      if (hail) {
        this.conversationGate.expectFollowUp(unitId, {
          kind: 'radio_hail',
          callsign: hail,
          correlationId: transmission.correlationId,
        });
        this._remember({ transcript: transmission.transcript, action: 'RADIO_HAIL', input: { callsign: hail }, clarification: `${hail}, go ahead.`, success: true });
        this._diag('radio_hail_acknowledged', transmission.correlationId, true, { unitId, callsign: hail });
        await this._speak(`${hail}, go ahead.`, transmission.correlationId);
        return true;
      }
    }

    if (this._processing.has(unitId)) {
      this._diag('transmission_ignored_busy', transmission.correlationId, false, { unitId, transcript: transmission.transcript });
      return false;
    }
    this._processing.add(unitId);
    try {
      await this._processTranscript(transmission);
      return true;
    } finally {
      this._processing.delete(unitId);
    }
  }

  async handleEmergencyStart(channelId, unitId) {
    if (!this.isRunning || !this.matchesChannel(channelId) || unitId === this.identity) return false;
    this._diag('hardware_emergency_observed', createV3CorrelationId(this.context.runtimeId), true, { unitId, channelId });
    return true;
  }

  async handleEmergencyEnd(channelId, unitId) {
    this._diag('hardware_emergency_end', null, true, { unitId, channelId });
    return true;
  }

  async _processTranscript({ unitId: speakerCallsign, transcript, correlationId }) {
    this._diag('transcript_received', correlationId, true, { speakerCallsign, transcript });
    let plan;
    let result = null;
    let operationalContext = null;
    try {
      try {
        operationalContext = await this.operationalContextService.snapshot({ speakerCallsign, correlationId });
        this._diag('operational_context_resolved', correlationId, true, {
          speakerCallsign,
          activeCallCount: operationalContext.activeCalls.length,
          currentCallId: operationalContext.currentCall?.id || null,
        });
      } catch (contextError) {
        this._diag('operational_context_failed', correlationId, false, { speakerCallsign, message: contextError.message, code: contextError.code || null });
      }

      plan = await this.planner.plan({
        transcript,
        speakerCallsign,
        runtimeContext: this.context,
        correlationId,
        recentContext: this._recentContext,
        operationalContext,
      });
      if (plan.action !== 'NO_ACTION' && plan.action !== 'CLARIFY' && plan.confidence < MIN_EXECUTION_CONFIDENCE) {
        plan = { action: 'CLARIFY', input: plan.input || {}, confidence: plan.confidence, clarification: 'Repeat your request.', reason: 'low_confidence' };
      }
      if (plan.action !== 'NO_ACTION' && plan.action !== 'CLARIFY') {
        plan = await materializeV3Plan(plan, {
          speakerCallsign,
          unitIdentityService: this.unitIdentityService,
          operationalContextService: this.operationalContextService,
          operationalContext,
          correlationId,
        });
        result = await this.executor.execute({ action: plan.action, input: plan.input }, { correlationId });
      }
    } catch (error) {
      result = { success: false, error: { code: error.code || 'CAD_UNAVAILABLE', message: error.message } };
      plan = { action: 'CLARIFY', input: {}, confidence: 0, clarification: responseForResolutionError(error, speakerCallsign), reason: 'processing_failure' };
      this._diag('transcript_processing_failed', correlationId, false, { speakerCallsign, message: error.message, code: error.code || null });
    }

    if (plan.action === 'CLARIFY') {
      this.conversationGate.expectFollowUp(speakerCallsign, { clarification: plan.clarification, input: plan.input || {}, correlationId });
    } else {
      this.conversationGate.clear(speakerCallsign);
    }

    const responseText = composeV3Response({ plan, result, speakerCallsign });
    this._remember({ transcript, action: plan.action, input: plan.input || {}, clarification: plan.clarification || null, success: result ? result.success === true : plan.action !== 'NO_ACTION' });
    if (responseText) await this._speak(responseText, correlationId);
  }

  async _speak(text, correlationId) {
    const channel = this.context.roomKey;
    const acquired = await this._acquireFloor(channel, correlationId);
    if (!acquired) {
      this._diag('speech_skipped_channel_busy', correlationId, false, { text, channel });
      return false;
    }

    let framesSent = 0;
    let lastRearmAt = Date.now();
    try {
      const started = Date.now();
      const pcm = await this.synthesize(text);
      const opusFrames = this.codec.encodePcmToOpus(pcm);
      this._diag('tts_ready', correlationId, true, { text, frames: opusFrames.length, latencyMs: Date.now() - started });

      for (const frame of opusFrames) {
        if (Date.now() - lastRearmAt >= FLOOR_REARM_MS) {
          const rearm = this.floorControl.requestFloor(channel, AI_FLOOR_IDENTITY);
          if (!rearm?.granted) {
            throw new Error(`AI dispatcher lost radio floor to ${rearm?.heldBy || 'another unit'}`);
          }
          lastRearmAt = Date.now();
        }
        this.audioRelay.injectAudio(channel, this.identity, this._sequence++, frame);
        framesSent += 1;
        await sleep(TX_FRAME_MS);
      }
      this._diag('speech_transmitted', correlationId, true, { text, frames: framesSent });
      return true;
    } catch (error) {
      this._diag('speech_transmit_failed', correlationId, false, { text, framesSent, message: error.message });
      return false;
    } finally {
      const released = this.floorControl.releaseFloor(channel, AI_FLOOR_IDENTITY);
      if (!released) this.floorControl.releaseAllForUnit?.(AI_FLOOR_IDENTITY);
    }
  }

  async _acquireFloor(channel, correlationId) {
    const deadline = Date.now() + FLOOR_WAIT_MS;
    while (Date.now() <= deadline) {
      const recent = this.audioRelay.hasRecentInbound?.(channel, 350, [this.identity]);
      if (!recent) {
        const grant = this.floorControl.requestFloor(channel, AI_FLOOR_IDENTITY);
        if (grant?.granted) {
          this._diag('speech_floor_acquired', correlationId, true, { channel });
          return true;
        }
      }
      await sleep(FLOOR_RETRY_MS);
    }
    return false;
  }

  _remember(item) {
    this._recentContext.push({ ...item, timestamp: Date.now() });
    if (this._recentContext.length > 12) this._recentContext.splice(0, this._recentContext.length - 12);
  }

  _diag(phase, correlationId, success = null, details = {}) {
    this.diagnostics.record({ phase, correlationId, runtimeId: this.context.runtimeId, dispatchCenterId: this.context.dispatchCenterId, channelId: this.context.channelId, success, details });
  }
}

export function normalizeV3RadioHail(value) {
  const text = String(value || '')
    .trim()
    .replace(/^[,.:;\-\s]+|[,.:;\-\s]+$/g, '')
    .replace(/\s+/g, ' ');
  if (!text || text.length > 48) return null;
  if (HAIL_COMMAND_RX.test(text)) return null;
  if (/^10\s*[-/]?\s*\d+$/i.test(text)) return null;
  if (!/^[a-z0-9'’.-]+(?:\s+[a-z0-9'’.-]+){0,3}$/i.test(text)) return null;
  if (!/\d/.test(text) && !NUMBER_WORD_RX.test(text)) return null;
  return text.replace(/\s*-\s*/g, '-');
}

function responseForResolutionError(error, speakerCallsign) {
  const unit = String(speakerCallsign || 'unit').trim();
  if (error?.code === 'CALL_AMBIGUOUS') return `${unit}, which call?`;
  if (error?.code === 'CALL_NOT_FOUND') return `${unit}, I don't have an active call matching that.`;
  if (error?.code === 'UNIT_AMBIGUOUS') return `${unit}, repeat the unit callsign.`;
  return 'Dispatcher is unable to process that request. Repeat shortly.';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
