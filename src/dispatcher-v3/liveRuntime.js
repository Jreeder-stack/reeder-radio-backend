import { audioRelayService } from '../services/audioRelayService.js';
import { signalingService } from '../services/signalingService.js';
import { speechToText, textToSpeech } from '../services/azureSpeechService.js';
import { opusCodec } from '../services/opusCodec.js';
import { buildV3RuntimeContext } from './runtimeContract.js';
import { CommandLinkGateway } from './cadGateway.js';
import { UnitIdentityService } from './unitIdentity.js';
import { V3OperationalAlertService } from './operationalAlertService.js';
import { createDefaultV3ActionHandlers } from './defaultActionHandlers.js';
import { V3ActionExecutor } from './actionExecutor.js';
import { V3DiagnosticsJournal } from './diagnostics.js';
import { V3SpeechPipeline } from './speechPipeline.js';
import { V3IntentPlanner } from './intentPlanner.js';
import { materializeV3Plan } from './planMaterializer.js';
import { composeV3Response } from './responseComposer.js';
import { createV3CorrelationId } from './correlation.js';

const TX_FRAME_MS = 20;

export class V3LiveDispatcher {
  constructor({ runtimeContext, scopes = [], diagnostics = null, planner = null, transcribe = speechToText, synthesize = textToSpeech } = {}) {
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

    this.diagnostics = diagnostics || new V3DiagnosticsJournal();
    this.gateway = new CommandLinkGateway(this.context);
    this.unitIdentityService = new UnitIdentityService({ gateway: this.gateway, context: this.context });
    this.operationalAlertService = new V3OperationalAlertService({ signalingService });
    this.handlers = createDefaultV3ActionHandlers({ gateway: this.gateway, unitIdentityService: this.unitIdentityService, operationalAlertService: this.operationalAlertService });
    this.executor = new V3ActionExecutor({ runtimeContext: this.context, handlers: this.handlers, diagnostics: this.diagnostics });
    this.speech = new V3SpeechPipeline({ runtimeContext: this.context, transcribe, codec: opusCodec, diagnostics: this.diagnostics });
    this.planner = planner || new V3IntentPlanner({ diagnostics: this.diagnostics });
    this.synthesize = synthesize;
    this._audioListener = (frame) => this.speech.pushFrame(frame);
  }

  async start() {
    if (this.isRunning) return true;
    audioRelayService.addAudioListener(this.context.roomKey, this.identity, this._audioListener);
    if (String(this.context.channelId) !== String(this.context.roomKey)) {
      audioRelayService.addAudioListener(this.context.channelId, this.identity, this._audioListener);
    }
    this.isRunning = true;
    this.connected = true;
    this._diag('runtime_started', null, true, { identity: this.identity });
    return true;
  }

  async stop() {
    audioRelayService.removeAllAudioListeners(this.identity);
    this.speech.clear();
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
    const correlationId = createV3CorrelationId(this.context.runtimeId);
    try {
      const identity = await this.unitIdentityService.resolve(unitId, { correlationId });
      const result = await this.executor.execute({ action: 'DECLARE_EMERGENCY', input: { unitId: identity.unitId, reason: 'radio emergency button activation' } }, { correlationId });
      this._diag('hardware_emergency_processed', correlationId, result.success, { unitId, error: result.error || null });
      return result.success;
    } catch (error) {
      this._diag('hardware_emergency_failed', correlationId, false, { unitId, message: error.message });
      return false;
    }
  }

  async handleEmergencyEnd(channelId, unitId) {
    this._diag('hardware_emergency_end', null, true, { unitId, channelId });
    return true;
  }

  async _processTranscript({ unitId: speakerCallsign, transcript, correlationId }) {
    this._diag('transcript_received', correlationId, true, { speakerCallsign, transcript });
    let plan;
    let result = null;
    try {
      plan = await this.planner.plan({ transcript, speakerCallsign, runtimeContext: this.context, correlationId, recentContext: this._recentContext });
      if (plan.action !== 'NO_ACTION' && plan.action !== 'CLARIFY') {
        const materialized = await materializeV3Plan(plan, { speakerCallsign, unitIdentityService: this.unitIdentityService, correlationId });
        plan = materialized;
        result = await this.executor.execute({ action: plan.action, input: plan.input }, { correlationId });
      }
    } catch (error) {
      result = { success: false, error: { code: error.code || 'CAD_UNAVAILABLE', message: error.message } };
      plan = plan || { action: 'NO_ACTION', input: {} };
      this._diag('transcript_processing_failed', correlationId, false, { speakerCallsign, message: error.message, code: error.code || null });
    }

    const responseText = composeV3Response({ plan, result, speakerCallsign });
    this._remember({ transcript, action: plan.action, success: result ? result.success === true : plan.action !== 'NO_ACTION' });
    if (responseText) await this._speak(responseText, correlationId);
  }

  async _speak(text, correlationId) {
    const recent = audioRelayService.hasRecentInbound(this.context.roomKey, 350, [this.identity]);
    if (recent) await sleep(250);
    const started = Date.now();
    const pcm = await this.synthesize(text);
    const opusFrames = opusCodec.encodePcmToOpus(pcm);
    this._diag('tts_ready', correlationId, true, { text, frames: opusFrames.length, latencyMs: Date.now() - started });
    for (const frame of opusFrames) {
      audioRelayService.injectAudio(this.context.roomKey, this.identity, this._sequence++, frame);
      await sleep(TX_FRAME_MS);
    }
    this._diag('speech_transmitted', correlationId, true, { text, frames: opusFrames.length });
  }

  _remember(item) {
    this._recentContext.push({ ...item, timestamp: Date.now() });
    if (this._recentContext.length > 12) this._recentContext.splice(0, this._recentContext.length - 12);
  }

  _diag(phase, correlationId, success = null, details = {}) {
    this.diagnostics.record({
      phase,
      correlationId,
      runtimeId: this.context.runtimeId,
      dispatchCenterId: this.context.dispatchCenterId,
      channelId: this.context.channelId,
      success,
      details,
    });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
