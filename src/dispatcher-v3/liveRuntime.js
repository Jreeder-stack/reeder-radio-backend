import { audioRelayService } from '../services/audioRelayService.js';
import { signalingService } from '../services/signalingService.js';
import { speechToText, textToSpeech } from '../services/azureSpeechService.js';
import { opusCodec } from '../services/opusCodec.js';
import { floorControlService, AI_FLOOR_IDENTITY } from '../services/floorControlService.js';
import { pageEmergencyUnits } from '../services/emergencyPagingService.js';
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
import { V3_ACTIONS } from './actionContracts.js';
import { V3FieldIncidentCoordinator } from './fieldIncidentCoordinator.js';
import { DispatcherV3Error, V3_ERROR_CODES } from './errors.js';

const TX_FRAME_MS = 20;
const MIN_EXECUTION_CONFIDENCE = 0.7;
const FLOOR_WAIT_MS = 3000;
const FLOOR_RETRY_MS = 100;
const FLOOR_REARM_MS = 1800;
const EMERGENCY_CHECK_MS = 25000;
const EMERGENCY_PAGE_MS = 25000;
const MDC_TONE_MS = 2000;
const PCM_SAMPLE_RATE = 16000;
const NUMBER_WORD_RX = /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/i;
const HAIL_COMMAND_RX = /\b(status|show|mark|put|set|create|start|close|clear|assign|attach|add|note|check|time|backup|emergency|responding|en\s+route|on\s+scene|available|out\s+of\s+service|off\s+duty|on\s+duty|zone|switch|move|copy|radio\s+check)\b/i;
const REPORTED_EVENT_RX = /\b(caller|complainant|RP|reporting party|someone|subject|victim)\s+(reports?|reported|is reporting|says?|said)\b|\breport(?:ed)?\s+of\b|\bresponding\s+to\b|\bcall\s+for\b/i;
const SAFE_STATUS_RX = /\b(10\s*[-/]?\s*4|ten\s*four|i(?:'m| am)\s+(?:good|okay|ok|fine)|everything(?:'s| is)\s+(?:okay|ok|fine)|code\s*4|accidental(?:\s+activation)?|false\s+alarm|all\s+good)\b/i;
const DISTRESS_RX = /\b(i\s+need\s+help|need\s+help|send\s+(?:me\s+)?(?:another\s+)?unit|send\s+units?|step\s+it\s+up|officer\s+down|i(?:'m| am| have been|'ve been)\s+(?:hit|shot|stabbed|injured)|shots?\s+fired|taking\s+fire|under\s+fire|gun\s*point|gunpoint|taser\s*point|taserpoint|fighting\s+with|i(?:'m| am)\s+fighting|struggling\s+with|physical\s+fight|weapon\s+involved)\b/i;
const RESPONDING_RX = /\b(en\s*route|responding|show\s+me\s+(?:en\s*route|responding)|i(?:'m| am|'ll be| will be)\s+(?:en\s*route|responding|going)|on\s+my\s+way|i(?:'ll| will)\s+take\s+it)\b/i;
const ROUTINE_EMERGENCY_CHAT_RX = /^(10\s*[-/]?\s*4|copy|received|okay|ok|stand\s+by|repeat|go\s+ahead)[.! ]*$/i;
const OFFLINE_UNIT_RX = /^(offline|off_duty|unavailable|not_available|out_of_service)$/i;

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
    emergencyPager = pageEmergencyUnits,
    emergencyCheckMs = EMERGENCY_CHECK_MS,
    emergencyPageMs = EMERGENCY_PAGE_MS,
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
    this._processing = new Map();
    this._emergency = null;
    this._emergencyTimers = new Set();
    this._rawEmergencyEnds = new Map();
    this._internalEmergencyEndUnsubscribe = null;

    this.audioRelay = audioRelay;
    this.codec = codec;
    this.floorControl = floorControl;
    this.signaling = signaling;
    this.emergencyPager = emergencyPager;
    this.emergencyCheckMs = Number(emergencyCheckMs) > 0 ? Number(emergencyCheckMs) : EMERGENCY_CHECK_MS;
    this.emergencyPageMs = Number(emergencyPageMs) > 0 ? Number(emergencyPageMs) : EMERGENCY_PAGE_MS;
    this.diagnostics = diagnostics || new V3DiagnosticsJournal();
    this.gateway = new CommandLinkGateway(this.context);
    this.unitIdentityService = new UnitIdentityService({ gateway: this.gateway, context: this.context });
    this.operationalContextService = new V3OperationalContextService({ gateway: this.gateway, unitIdentityService: this.unitIdentityService });
    this.operationalAlertService = new V3OperationalAlertService({ signalingService: this.signaling });
    this.handlers = createDefaultV3ActionHandlers({ gateway: this.gateway, unitIdentityService: this.unitIdentityService, operationalAlertService: this.operationalAlertService });
    this.fieldIncidents = new V3FieldIncidentCoordinator({
      gateway: this.gateway,
      unitIdentityService: this.unitIdentityService,
      operationalContextService: this.operationalContextService,
      createCall: this.handlers[V3_ACTIONS.CREATE_CALL],
      addCallNote: this.handlers[V3_ACTIONS.ADD_CALL_NOTE],
      updateCall: this.handlers[V3_ACTIONS.UPDATE_CALL],
      getUnitLocation: (callsign) => this._getFreshFieldUnitLocation(callsign),
    });
    this.handlers[V3_ACTIONS.REPORT_FIELD_INCIDENT] = (request) => this.fieldIncidents.report(request);
    this.handlers[V3_ACTIONS.UPDATE_FIELD_INCIDENT] = (request) => this.fieldIncidents.update(request);
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
    if (typeof this.signaling.onEmergencyEnd === 'function') {
      this._internalEmergencyEndUnsubscribe = this.signaling.onEmergencyEnd((data) => {
        if (!data || !this.matchesChannel(data.channelId)) return;
        this._rawEmergencyEnds.set(String(data.unitId || ''), data);
      });
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
    this.fieldIncidents.clearAll();
    this._processing.clear();
    this._clearEmergencyTimers();
    this._emergency = null;
    this._rawEmergencyEnds.clear();
    if (this._internalEmergencyEndUnsubscribe) {
      try { this._internalEmergencyEndUnsubscribe(); } catch (_) {}
      this._internalEmergencyEndUnsubscribe = null;
    }
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
      emergency: this._emergency ? {
        unitId: this._emergency.callsign,
        source: this._emergency.source,
        stage: this._emergency.stage,
        reason: this._emergency.reason,
        callId: this._emergency.callId || null,
        responders: [...this._emergency.responders],
        paged: this._emergency.paged === true,
      } : null,
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

    if (await this._handleEmergencyTranscript(transmission)) return true;

    const gate = this.conversationGate.shouldProcess({ unitId, transcript: transmission.transcript });
    if (!gate.allowed) {
      this._diag('transmission_ignored', transmission.correlationId, true, { unitId, reason: gate.reason, transcript: transmission.transcript });
      return false;
    }
    transmission.transcript = gate.transcript || transmission.transcript;
    transmission.pendingContext = gate.pending || null;

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

    const previous = this._processing.get(unitId) || Promise.resolve();
    const work = previous.catch(() => null).then(() => this._processTranscript(transmission));
    this._processing.set(unitId, work);
    try {
      await work;
      return true;
    } finally {
      if (this._processing.get(unitId) === work) this._processing.delete(unitId);
    }
  }

  async handleEmergencyStart(channelId, unitId) {
    if (!this.isRunning || !this.matchesChannel(channelId) || unitId === this.identity) return false;
    const correlationId = createV3CorrelationId(this.context.runtimeId);
    this._diag('hardware_emergency_observed', correlationId, true, { unitId, channelId });
    await this._startHardwareEmergency(unitId, correlationId);
    return true;
  }

  async handleEmergencyEnd(channelId, unitId) {
    const raw = this._rawEmergencyEnds.get(String(unitId || '')) || null;
    this._rawEmergencyEnds.delete(String(unitId || ''));

    if (raw?.clearedBy === 'system:disconnect' && sameUnit(this._emergency?.callsign, unitId)) {
      this._diag('emergency_disconnect_clear_ignored', null, true, { unitId, channelId });
      this._restoreEmergencySignalAfterDisconnect(this._emergency);
      return true;
    }

    this._diag('hardware_emergency_end', null, true, { unitId, channelId, clearedBy: raw?.clearedBy || null });
    if (this._emergency?.callsign === unitId) {
      await this._clearEmergencyState({ unitId, reason: raw?.clearedBy || 'radio_or_dispatcher_clear', announce: false, clearSignal: false });
    }
    return true;
  }

  async _handleEmergencyTranscript({ unitId: speakerCallsign, transcript, correlationId }) {
    const text = String(transcript || '').trim();
    if (!text) return false;

    const active = this._emergency;
    if (active) {
      if (sameUnit(speakerCallsign, active.callsign)) {
        if (active.source === 'hardware' && active.stage.startsWith('status_check') && SAFE_STATUS_RX.test(text) && !DISTRESS_RX.test(text)) {
          this._diag('emergency_status_check_safe_response', correlationId, true, { speakerCallsign, transcript: text });
          await this._clearEmergencyState({ unitId: active.callsign, reason: 'status_check_safe_response', announce: true, clearSignal: true });
          return true;
        }

        if (DISTRESS_RX.test(text)) {
          this._diag('emergency_distress_response', correlationId, true, { speakerCallsign, transcript: text });
          await this._escalateEmergency(active, correlationId, { reason: classifyOfficerEmergency(text)?.reason || active.reason || 'OFFICER NEEDS ASSISTANCE', note: text });
          return true;
        }

        if (active.stage === 'escalated') {
          if (!ROUTINE_EMERGENCY_CHAT_RX.test(text)) {
            await this._recordEmergencyNote(active, text, correlationId);
          }
          return false;
        }
      } else if (active.stage === 'escalated' && RESPONDING_RX.test(text)) {
        await this._addEmergencyResponder(active, speakerCallsign, correlationId, text);
        return true;
      }
    }

    return false;
  }

  async _startHardwareEmergency(unitId, correlationId) {
    if (this._emergency && sameUnit(this._emergency.callsign, unitId)) return this._emergency;
    if (this._emergency && !sameUnit(this._emergency.callsign, unitId)) {
      this._diag('secondary_emergency_observed_while_active', correlationId, false, { unitId, activeUnitId: this._emergency.callsign });
      await this._alert(`${unitId}, status check.`, correlationId);
      return this._emergency;
    }

    const identity = await this._resolveEmergencyIdentity(unitId, correlationId);
    const location = this._getUnitLocation(identity.callsign, { emergency: true });
    const state = this._makeEmergencyState({
      source: 'hardware',
      stage: 'status_check_1',
      callsign: içŽù¶‰žËkºwµç]¸°(€€€€€€€€€€€Õ¹¥Ñ%‘•¹Ñ¥ÑåM•ÉÙ¥”èÑ¡¥Ì¹Õ¹¥Ñ%‘•¹Ñ¥ÑåM•ÉÙ¥”°(€€€€€€€€€€€½Á•É…Ñ¥½¹…±½¹Ñ•áÑM•ÉÙ¥”èÑ¡¥Ì¹½Á•É…Ñ¥½¹…±½¹Ñ•áÑM•ÉÙ¥”°(€€€€€€€€€€€½Á•É…Ñ¥½¹…±½¹Ñ•áÐ°(€€€€€€€€€€€½ÉÉ•±…Ñ¥½¹%°(€€€€€€€€€ô¤ì(€€€€€€€€€É•ÍÕ±Ð€ô…Ý…¥ÐÑ¡¥Ì¹•á•ÕÑ½È¹•á•ÕÑ”¡ì…Ñ¥½¸èÁ±…¸¹…Ñ¥½¸°¥¹ÁÕÐèÁ±…¸¹¥¹ÁÕÐô°ì½ÉÉ•±…Ñ¥½¹%ô¤ì(€€€€€€€ô(€€€€€ô(€€€ô…Ñ €¡•ÉÉ½È¤ì4(€€€€€É•ÍÕ±Ð€ôìÍÕ•ÍÌè™…±Í”°•ÉÉ½Èèì½‘”è•ÉÉ½È¹½‘”ñð€}U9Y%1	1œ°µ•ÍÍ…”è•ÉÉ½È¹µ•ÍÍ…”ôôì4(€€€€€Á±…¸€ôì…Ñ¥½¸è€1I%dœ°¥¹ÁÕÐèíô°½¹™¥‘•¹”è€À°±…É¥™¥…Ñ¥½¸èÉ•ÍÁ½¹Í•½ÉI•Í½±ÕÑ¥½¹ÉÉ½È¡•ÉÉ½È°ÍÁ•…­•É…±±Í¥¸¤°É•…Í½¸è€ÁÉ½•ÍÍ¥¹}™…¥±ÕÉ”œôì4(€€€€€Ñ¡¥Ì¹}‘¥…œ ÑÉ…¹ÍÉ¥ÁÑ}ÁÉ½•ÍÍ¥¹}™…¥±•œ°½ÉÉ•±…Ñ¥½¹%°™…±Í”°ìÍÁ•…­•É…±±Í¥¸°µ•ÍÍ…”è•ÉÉ½È¹µ•ÍÍ…”°½‘”è•ÉÉ½È¹½‘”ñð¹Õ±°ô¤ì4(€€€ô4(4(€€€‘¥…±½Õ•½¹Ñ•áÐ€ôÑ¡¥Ì¹™¥•±‘%¹¥‘•¹ÑÌ¹•Ñ¥…±½Õ•½¹Ñ•áÐ¡ÍÁ•…­•É…±±Í¥¸¤ì(€€€¥˜€¡Á±…¸¹…Ñ¥½¸€ôôô€1I%dœ¤ì(€€€€€Ñ¡¥Ì¹½¹Ù•ÉÍ…Ñ¥½¹…Ñ”¹•áÁ•Ñ½±±½ÝUÀ¡ÍÁ•…­•É…±±Í¥¸°ì±…É¥™¥…Ñ¥½¸èÁ±…¸¹±…É¥™¥…Ñ¥½¸°¥¹ÁÕÐèÁ±…¸¹¥¹ÁÕÐñðíô°½ÉÉ•±…Ñ¥½¹%ô¤ì(€€€ô•±Í”¥˜€¡É•ÍÕ±Ðü¹•ÉÉ½Èü¹½‘”€ôôô€%MA=M%Q%=9}IEU%Iœ¤ì(€€€€€Ñ¡¥Ì¹½¹Ù•ÉÍ…Ñ¥½¹…Ñ”¹•áÁ•Ñ½±±½ÝUÀ¡ÍÁ•…­•É…±±Í¥¸°ì(€€€€€€€­¥¹è€‘¥ÍÁ½Í¥Ñ¥½¸œ°(€€€€€€€…±±%èÉ•ÍÕ±Ð¹•ÉÉ½È¹‘•Ñ…¥±Ìü¹…±±%ñðÁ±…¸¹¥¹ÁÕÐü¹…±±%ñð¹Õ±°°(€€€€€€€Õ¹¥ÑI•˜èÍÁ•…­•É…±±Í¥¸°(€€€€€€€½ÉÉ•±…Ñ¥½¹%°(€€€€€ô¤ì(€€€ô•±Í”¥˜€¡‘¥…±½Õ•½¹Ñ•áÐ¤ì(€€€€€Ñ¡¥Ì¹½¹Ù•ÉÍ…Ñ¥½¹…Ñ”¹•áÁ•Ñ½±±½ÝUÀ¡ÍÁ•…­•É…±±Í¥¸°ì€¸¸¹‘¥…±½Õ•½¹Ñ•áÐ°½ÉÉ•±…Ñ¥½¹%ô¤ì(€€€ô•±Í”¥˜€¡Á•¹‘¥¹½¹Ñ•áÐü¹­¥¹€ôôô€‘¥ÍÁ½Í¥Ñ¥½¸œ€˜˜Á±…¸¹…Ñ¥½¸€„ôôXÍ}Q%=9L¹1I}U9%P€˜˜Á±…¸¹…Ñ¥½¸€„ôôXÍ}Q%=9L¹1=M}10¤ì(€€€€€Ñ¡¥Ì¹½¹Ù•ÉÍ…Ñ¥½¹…Ñ”¹•áÁ•Ñ½±±½ÝUÀ¡ÍÁ•…­•É…±±Í¥¸°ì€¸¸¹Á•¹‘¥¹½¹Ñ•áÐ°½ÉÉ•±…Ñ¥½¹%ô¤ì(€€€ô•±Í”ì(€€€€€Ñ¡¥Ì¹½¹Ù•ÉÍ…Ñ¥½¹…Ñ”¹±•…È¡ÍÁ•…­•É…±±Í¥¸¤ì(€€€ô4(4(€€€½¹ÍÐÉ•ÍÁ½¹Í•Q•áÐ€ô½µÁ½Í•XÍI•ÍÁ½¹Í”¡ìÁ±…¸°É•ÍÕ±Ð°ÍÁ•…­•É…±±Í¥¸ô¤ì4(€€€Ñ¡¥Ì¹}É•µ•µ‰•È¡ìÑÉ…¹ÍÉ¥ÁÐ°…Ñ¥½¸èÁ±…¸¹…Ñ¥½¸°¥¹ÁÕÐèÁ±…¸¹¥¹ÁÕÐñðíô°±…É¥™¥…Ñ¥½¸èÁ±…¸¹±…É¥™¥…Ñ¥½¸ñð¹Õ±°°ÍÕ•ÍÌèÉ•ÍÕ±Ð€üÉ•ÍÕ±Ð¹ÍÕ•ÍÌ€ôôôÑÉÕ”€èÁ±…¸¹…Ñ¥½¸€„ôô€9=}Q%=8œô¤ì4(€€€¥˜€¡É•ÍÁ½¹Í•Q•áÐ¤…Ý…¥ÐÑ¡¥Ì¹}ÍÁ•…¬¡É•ÍÁ½¹Í•Q•áÐ°½ÉÉ•±…Ñ¥½¹%¤ì(€ô((€…Íå¹Œ}•á•ÕÑ•5Õ±Ñ¥Ñ¥½¹A±…¸¡Á±…¸°ìÍÁ•…­•É…±±Í¥¸°½Á•É…Ñ¥½¹…±½¹Ñ•áÐ°½ÉÉ•±…Ñ¥½¹%ô¤ì(€€€½¹ÍÐÍÑ•ÁÌ€ômtì(€€€±•Ð½¹Ñ•áÐ€ô½Á•É…Ñ¥½¹…±½¹Ñ•áÐì(€€€™½È€¡½¹ÍÐ…Ñ¥½¹A±…¸½˜Á±…¸¹…Ñ¥½¹Ìñðmt¤ì(€€€€€½¹ÍÐµ…Ñ•É¥…±¥é•€ô…Ý…¥Ðµ…Ñ•É¥…±¥é•XÍA±…¸¡ì€¸¸¹…Ñ¥½¹A±…¸°½¹™¥‘•¹”èÁ±…¸¹½¹™¥‘•¹”ô°ì(€€€€€€€ÍÁ•…­•É…±±Í¥¸°(€€€€€€€Õ¹¥Ñ%‘•¹Ñ¥ÑåM•ÉÙ¥”èÑ¡¥Ì¹Õ¹¥Ñ%‘•¹Ñ¥ÑåM•ÉÙ¥”°(€€€€€€€½Á•É…Ñ¥½¹…±½¹Ñ•áÑM•ÉÙ¥”èÑ¡¥Ì¹½Á•É…Ñ¥½¹…±½¹Ñ•áÑM•ÉÙ¥”°(€€€€€€€½Á•É…Ñ¥½¹…±½¹Ñ•áÐè½¹Ñ•áÐ°(€€€€€€€½ÉÉ•±…Ñ¥½¹%°(€€€€€ô¤ì(€€€€€½¹ÍÐÍÑ•ÁI•ÍÕ±Ð€ô…Ý…¥ÐÑ¡¥Ì¹•á•ÕÑ½È¹•á•ÕÑ”¡ì…Ñ¥½¸èµ…Ñ•É¥…±¥é•¹…Ñ¥½¸°¥¹ÁÕÐèµ…Ñ•É¥…±¥é•¹¥¹ÁÕÐô°ì½ÉÉ•±…Ñ¥½¹%ô¤ì(€€€€€ÍÑ•ÁÌ¹ÁÕÍ ¡ì…Ñ¥½¸èµ…Ñ•É¥…±¥é•¹…Ñ¥½¸°¥¹ÁÕÐèµ…Ñ•É¥…±¥é•¹¥¹ÁÕÐ°É•ÍÕ±ÐèÍÑ•ÁI•ÍÕ±Ðô¤ì(€€€€€¥˜€ …ÍÑ•ÁI•ÍÕ±Ð¹ÍÕ•ÍÌ¤ì(€€€€€€€É•ÑÕÉ¸ì(€€€€€€€€€ÍÕ•ÍÌè™…±Í”°(€€€€€€€€€…Ñ¥½¸è€5U1Q%}Q%=8œ°(€€€€€€€€€½ÉÉ•±…Ñ¥½¹%°(€€€€€€€€€•ÉÉ½Èèì€¸¸¹ÍÑ•ÁI•ÍÕ±Ð¹•ÉÉ½È°‘•Ñ…¥±Ìèì€¸¸¸¡ÍÑ•ÁI•ÍÕ±Ð¹•ÉÉ½Èü¹‘•Ñ…¥±Ìñðíô¤°½µÁ±•Ñ•‘MÑ•ÁÌèÍÑ•ÁÌ¹Í±¥” À°€´Ä¤¹µ…À ¡ÍÑ•À¤€ôøÍÑ•À¹…Ñ¥½¸¤°™…¥±•‘Ñ¥½¸èµ…Ñ•É¥…±¥é•¹…Ñ¥½¸ôô°(€€€€€€€€€‘…Ñ„èìÍÑ•ÁÌô°(€€€€€€€ôì(€€€€€ô(€€€€€ÑÉäì(€€€€€€€½¹Ñ•áÐ€ô…Ý…¥ÐÑ¡¥Ì¹½Á•É…Ñ¥½¹…±½¹Ñ•áÑM•ÉÙ¥”¹Í¹…ÁÍ¡½Ð¡ìÍÁ•…­•É…±±Í¥¸°½ÉÉ•±…Ñ¥½¹%ô¤ì(€€€€€ô…Ñ €¡|¤íô(€€€ô(€€€É•ÑÕÉ¸ìÍÕ•ÍÌèÑÉÕ”°…Ñ¥½¸è€5U1Q%}Q%=8œ°½ÉÉ•±…Ñ¥½¹%°‘…Ñ„èìÍÑ•ÁÌôôì(€ô(4(€…Íå¹Œ}…±•ÉÐ¡Ñ•áÐ°½ÉÉ•±…Ñ¥½¹%¤ì4(€€€½¹ÍÐ¡…¹¹•°€ôÑ¡¥Ì¹½¹Ñ•áÐ¹É½½µ-•äì4(€€€½¹ÍÐ…ÅÕ¥É•€ô…Ý…¥ÐÑ¡¥Ì¹}…ÅÕ¥É•±½½È¡¡…¹¹•°°½ÉÉ•±…Ñ¥½¹%¤ì4(€€€¥˜€ ……ÅÕ¥É•¤ì4(€€€€€Ñ¡¥Ì¹}‘¥…œ …±•ÉÑ}Í­¥ÁÁ•‘}¡…¹¹•±}‰ÕÍäœ°½ÉÉ•±…Ñ¥½¹%°™…±Í”°ìÑ•áÐ°¡…¹¹•°ô¤ì4(€€€€€É•ÑÕÉ¸™…±Í”ì4(€€€ô4(4(€€€ÑÉäì4(€€€€€½¹ÍÐÑ½¹”€ô‰Õ¥±‘5‘Q½¹•A´¡5}Q=9}5L¤ì4(€€€€€½¹ÍÐÑ½¹•É…µ•Ì€ôÑ¡¥Ì¹½‘•Œ¹•¹½‘•AµQ½=ÁÕÌ¡Ñ½¹”¤ì4(€€€€€™½È€¡½¹ÍÐ™É…µ”½˜Ñ½¹•É…µ•Ì¤ì4(€€€€€€€Ñ¡¥Ì¹…Õ‘¥½I•±…ä¹¥¹©•ÑÕ‘¥¼¡¡…¹¹•°°Ñ¡¥Ì¹¥‘•¹Ñ¥Ñä°Ñ¡¥Ì¹}Í•ÅÕ•¹”¬¬°™É…µ”¤ì4(€€€€€€€…Ý…¥ÐÍ±••À¡Qa}I5}5L¤ì4(€€€€€ô4(4(€€€€€½¹ÍÐÁ´€ô…Ý…¥ÐÑ¡¥Ì¹Íå¹Ñ¡•Í¥é”¡Ñ•áÐ¤ì4(€€€€€½¹ÍÐÍÁ••¡É…µ•Ì€ôÑ¡¥Ì¹½‘•Œ¹•¹½‘•AµQ½=ÁÕÌ¡Á´¤ì4(€€€€€±•Ð±…ÍÑI•…ÉµÐ€ô…Ñ”¹¹½Ü ¤ì4(€€€€€™½È€¡½¹ÍÐ™É…µ”½˜ÍÁ••¡É…µ•Ì¤ì4(€€€€€€€¥˜€¡…Ñ”¹¹½Ü ¤€´±…ÍÑI•…ÉµÐ€øô1==I}II5}5L¤ì4(€€€€€€€€€½¹ÍÐÉ•…É´€ôÑ¡¥Ì¹™±½½É½¹ÑÉ½°¹É•ÅÕ•ÍÑ±½½È¡¡…¹¹•°°%}1==I}%9Q%Qd¤ì4(€€€€€€€€€¥˜€ …É•…É´ü¹É…¹Ñ•¤Ñ¡É½Ü¹•ÜÉÉ½È¡$‘¥ÍÁ…Ñ¡•È±½ÍÐÉ…‘¥¼™±½½ÈÑ¼€‘íÉ•…É´ü¹¡•±‘	äñð€…¹½Ñ¡•ÈÕ¹¥Ðõ€¤ì4(€€€€€€€€€±…ÍÑI•…ÉµÐ€ô…Ñ”¹¹½Ü ¤ì4(€€€€€€€ô4(€€€€€€€Ñ¡¥Ì¹…Õ‘¥½I•±…ä¹¥¹©•ÑÕ‘¥¼¡¡…¹¹•°°Ñ¡¥Ì¹¥‘•¹Ñ¥Ñä°Ñ¡¥Ì¹}Í•ÅÕ•¹”¬¬°™É…µ”¤ì4(€€€€€€€…Ý…¥ÐÍ±••À¡Qa}I5}5L¤ì4(€€€€€ô4(€€€€€Ñ¡¥Ì¹}‘¥…œ •µ•É•¹å}…±•ÉÑ}ÑÉ…¹Íµ¥ÑÑ•œ°½ÉÉ•±…Ñ¥½¹%°ÑÉÕ”°ìÑ•áÐ°Ñ½¹•É…µ•ÌèÑ½¹•É…µ•Ì¹±•¹Ñ °ÍÁ••¡É…µ•ÌèÍÁ••¡É…µ•Ì¹±•¹Ñ ô¤ì4(€€€€€É•ÑÕÉ¸ÑÉÕ”ì4(€€€ô…Ñ €¡•ÉÉ½È¤ì4(€€€€€Ñ¡¥Ì¹}‘¥…œ •µ•É•¹å}…±•ÉÑ}™…¥±•œ°½ÉÉ•±…Ñ¥½¹%°™…±Í”°ìÑ•áÐ°µ•ÍÍ…”è•ÉÉ½È¹µ•ÍÍ…”ô¤ì4(€€€€€É•ÑÕÉ¸™…±Í”ì4(€€€ô™¥¹…±±äì4(€€€€€½¹ÍÐÉ•±•…Í•€ôÑ¡¥Ì¹™±½½É½¹ÑÉ½°¹É•±•…Í•±½½È¡¡…¹¹•°°%}1==I}%9Q%Qd¤ì4(€€€€€¥˜€ …É•±•…Í•¤Ñ¡¥Ì¹™±½½É½¹ÑÉ½°¹É•±•…Í•±±½ÉU¹¥Ðü¸¡%}1==I}%9Q%Qd¤ì4(€€€ô4(€ô4(4(€…Íå¹Œ}ÍÁ•…¬¡Ñ•áÐ°½ÉÉ•±…Ñ¥½¹%¤ì4(€€€½¹ÍÐ¡…¹¹•°€ôÑ¡¥Ì¹½¹Ñ•áÐ¹É½½µ-•äì4(€€€½¹ÍÐ…ÅÕ¥É•€ô…Ý…¥ÐÑ¡¥Ì¹}…ÅÕ¥É•±½½È¡¡…¹¹•°°½ÉÉ•±…Ñ¥½¹%¤ì4(€€€¥˜€ ……ÅÕ¥É•¤ì4(€€€€€Ñ¡¥Ì¹}‘¥…œ ÍÁ••¡}Í­¥ÁÁ•‘}¡…¹¹•±}‰ÕÍäœ°½ÉÉ•±…Ñ¥½¹%°™…±Í”°ìÑ•áÐ°¡…¹¹•°ô¤ì4(€€€€€É•ÑÕÉ¸™…±Í”ì4(€€€ô4(4(€€€±•Ð™É…µ•ÍM•¹Ð€ô€Àì4(€€€±•Ð±…ÍÑI•…ÉµÐ€ô…Ñ”¹¹½Ü ¤ì4(€€€ÑÉäì4(€€€€€½¹ÍÐÍÑ…ÉÑ•€ô…Ñ”¹¹½Ü ¤ì4(€€€€€½¹ÍÐÁ´€ô…Ý…¥ÐÑ¡¥Ì¹Íå¹Ñ¡•Í¥é”¡Ñ•áÐ¤ì4(€€€€€½¹ÍÐ½ÁÕÍÉ…µ•Ì€ôÑ¡¥Ì¹½‘•Œ¹•¹½‘•AµQ½=ÁÕÌ¡Á´¤ì4(€€€€€Ñ¡¥Ì¹}‘¥…œ ÑÑÍ}É•…‘äœ°½ÉÉ•±…Ñ¥½¹%°ÑÉÕ”°ìÑ•áÐ°™É…µ•Ìè½ÁÕÍÉ…µ•Ì¹±•¹Ñ °±…Ñ•¹å5Ìè…Ñ”¹¹½Ü ¤€´ÍÑ…ÉÑ•ô¤ì4(4(€€€€€™½È€¡½¹ÍÐ™É…µ”½˜½ÁÕÍÉ…µ•Ì¤ì4(€€€€€€€¥˜€¡…Ñ”¹¹½Ü ¤€´±…ÍÑI•…ÉµÐ€øô1==I}II5}5L¤ì4(€€€€€€€€€½¹ÍÐÉ•…É´€ôÑ¡¥Ì¹™±½½É½¹ÑÉ½°¹É•ÅÕ•ÍÑ±½½È¡¡…¹¹•°°%}1==I}%9Q%Qd¤ì4(€€€€€€€€€¥˜€ …É•…É´ü¹É…¹Ñ•¤ì4(€€€€€€€€€€€Ñ¡É½Ü¹•ÜÉÉ½È¡$‘¥ÍÁ…Ñ¡•È±½ÍÐÉ…‘¥¼™±½½ÈÑ¼€‘íÉ•…É´ü¹¡•±‘	äñð€…¹½Ñ¡•ÈÕ¹¥Ðõ€¤ì4(€€€€€€€€€ô4(€€€€€€€€€±…ÍÑI•…ÉµÐ€ô…Ñ”¹¹½Ü ¤ì4(€€€€€€€ô4(€€€€€€€Ñ¡¥Ì¹…Õ‘¥½I•±…ä¹¥¹©•ÑÕ‘¥¼¡¡…¹¹•°°Ñ¡¥Ì¹¥‘•¹Ñ¥Ñä°Ñ¡¥Ì¹}Í•ÅÕ•¹”¬¬°™É…µ”¤ì4(€€€€€€€™É…µ•ÍM•¹Ð€¬ô€Äì4(€€€€€€€…Ý…¥ÐÍ±••À¡Qa}I5}5L¤ì4(€€€€€ô4(€€€€€Ñ¡¥Ì¹}‘¥…œ ÍÁ••¡}ÑÉ…¹Íµ¥ÑÑ•œ°½ÉÉ•±…Ñ¥½¹%°ÑÉÕ”°ìÑ•áÐ°™É…µ•Ìè™É…µ•ÍM•¹Ðô¤ì4(€€€€€É•ÑÕÉ¸ÑÉÕ”ì4(€€€ô…Ñ €¡•ÉÉ½È¤ì4(€€€€€Ñ¡¥Ì¹}‘¥…œ ÍÁ••¡}ÑÉ…¹Íµ¥Ñ}™…¥±•œ°½ÉÉ•±…Ñ¥½¹%°™…±Í”°ìÑ•áÐ°™É…µ•ÍM•¹Ð°µ•ÍÍ…”è•ÉÉ½È¹µ•ÍÍ…”ô¤ì4(€€€€€É•ÑÕÉ¸™…±Í”ì4(€€€ô™¥¹…±±äì4(€€€€€½¹ÍÐÉ•±•…Í•€ôÑ¡¥Ì¹™±½½É½¹ÑÉ½°¹É•±•…Í•±½½È¡¡…¹¹•°°%}1==I}%9Q%Qd¤ì4(€€€€€¥˜€ …É•±•…Í•¤Ñ¡¥Ì¹™±½½É½¹ÑÉ½°¹É•±•…Í•±±½ÉU¹¥Ðü¸¡%}1==I}%9Q%Qd¤ì4(€€€ô4(€ô4(4(€…Íå¹Œ}…ÅÕ¥É•±½½È¡¡…¹¹•°°½ÉÉ•±…Ñ¥½¹%¤ì4(€€€½¹ÍÐ‘•…‘±¥¹”€ô…Ñ”¹¹½Ü ¤€¬1==I}]%Q}5Lì4(€€€Ý¡¥±”€¡…Ñ”¹¹½Ü ¤€ðô‘•…‘±¥¹”¤ì4(€€€€€½¹ÍÐÉ••¹Ð€ôÑ¡¥Ì¹…Õ‘¥½I•±…ä¹¡…ÍI••¹Ñ%¹‰½Õ¹ü¸¡¡…¹¹•°°€ÌÔÀ°mÑ¡¥Ì¹¥‘•¹Ñ¥Ñåt¤ì4(€€€€€¥˜€ …É••¹Ð¤ì4(€€€€€€€½¹ÍÐÉ…¹Ð€ôÑ¡¥Ì¹™±½½É½¹ÑÉ½°¹É•ÅÕ•ÍÑ±½½È¡¡…¹¹•°°%}1==I}%9Q%Qd¤ì4(€€€€€€€¥˜€¡É…¹Ðü¹É…¹Ñ•¤ì4(€€€€€€€€€Ñ¡¥Ì¹}‘¥…œ ÍÁ••¡}™±½½É}…ÅÕ¥É•œ°½ÉÉ•±…Ñ¥½¹%°ÑÉÕ”°ì¡…¹¹•°ô¤ì4(€€€€€€€€€É•ÑÕÉ¸ÑÉÕ”ì4(€€€€€€€ô4(€€€€€ô4(€€€€€…Ý…¥ÐÍ±••À¡1==I}IQIe}5L¤ì4(€€€ô4(€€€É•ÑÕÉ¸™…±Í”ì4(€ô4(4(€}É•µ•µ‰•È¡¥Ñ•´¤ì4(€€€Ñ¡¥Ì¹}É••¹Ñ½¹Ñ•áÐ¹ÁÕÍ ¡ì€¸¸¹¥Ñ•´°Ñ¥µ•ÍÑ…µÀè…Ñ”¹¹½Ü ¤ô¤ì4(€€€¥˜€¡Ñ¡¥Ì¹}É••¹Ñ½¹Ñ•áÐ¹±•¹Ñ €ø€ÄÈ¤Ñ¡¥Ì¹}É••¹Ñ½¹Ñ•áÐ¹ÍÁ±¥” À°Ñ¡¥Ì¹}É••¹Ñ½¹Ñ•áÐ¹±•¹Ñ €´€ÄÈ¤ì4(€ô4(4(€}‘¥…œ¡Á¡…Í”°½ÉÉ•±…Ñ¥½¹%°ÍÕ•ÍÌ€ô¹Õ±°°‘•Ñ…¥±Ì€ôíô¤ì4(€€€Ñ¡¥Ì¹‘¥…¹½ÍÑ¥Ì¹É•½É¡ìÁ¡…Í”°½ÉÉ•±…Ñ¥½¹%°ÉÕ¹Ñ¥µ•%èÑ¡¥Ì¹½¹Ñ•áÐ¹ÉÕ¹Ñ¥µ•%°‘¥ÍÁ…Ñ¡•¹Ñ•É%èÑ¡¥Ì¹½¹Ñ•áÐ¹‘¥ÍÁ…Ñ¡•¹Ñ•É%°¡…¹¹•±%èÑ¡¥Ì¹½¹Ñ•áÐ¹¡…¹¹•±%°ÍÕ•ÍÌ°‘•Ñ…¥±Ìô¤ì4(€ô4)ô4(4)•áÁ½ÉÐ™Õ¹Ñ¥½¸¹½Éµ…±¥é•XÍI…‘¥½!…¥°¡Ù…±Õ”¤ì4(€½¹ÍÐÑ•áÐ€ôMÑÉ¥¹œ¡Ù…±Õ”ñð€œœ¤4(€€€€¹ÑÉ¥´ ¤4(€€€€¹É•Á±…” ½yl°¸èípµqÍt­ñl°¸èípµqÍt¬½œ°€œœ¤4(€€€€¹É•Á±…” ½qÌ¬½œ°€œ€œ¤ì4(€¥˜€ …Ñ•áÐñðÑ•áÐ¹±•¹Ñ €ø€Ðà¤É•ÑÕÉ¸¹Õ±°ì4(€¥˜€¡!%1}=559}I`¹Ñ•ÍÐ¡Ñ•áÐ¤¤É•ÑÕÉ¸¹Õ±°ì4(€¥˜€ ½xÄÁqÌ©l´½týqÌ©q¬½¤¹Ñ•ÍÐ¡Ñ•áÐ¤¤É•ÑÕÉ¸¹Õ±°ì4(€¥˜€ „½ym„µèÀ´äŸŠd¸µt¬ üéqÌ­m„µèÀ´äŸŠd¸µt¬¥ìÀ°Íô½¤¹Ñ•ÍÐ¡Ñ•áÐ¤¤É•ÑÕÉ¸¹Õ±°ì4(€¥˜€ „½q¼¹Ñ•ÍÐ¡Ñ•áÐ¤€˜˜€…9U5	I}]=I}I`¹Ñ•ÍÐ¡Ñ•áÐ¤¤É•ÑÕÉ¸¹Õ±°ì4(€É•ÑÕÉ¸Ñ•áÐ¹É•Á±…” ½qÌ¨µqÌ¨½œ°€œ´œ¤ì4)ô4(4)•áÁ½ÉÐ™Õ¹Ñ¥½¸±…ÍÍ¥™å=™™¥•Éµ•É•¹ä¡Ù…±Õ”¤ì4(€½¹ÍÐÑ•áÐ€ôMÑÉ¥¹œ¡Ù…±Õ”ñð€œœ¤¹ÑÉ¥´ ¤ì4(€¥˜€ …Ñ•áÐñðIA=IQ}Y9Q}I`¹Ñ•ÍÐ¡Ñ•áÐ¤¤É•ÑÕÉ¸¹Õ±°ì4(4(€½¹ÍÐÁ…ÑÑ•É¹Ì€ôl4(€€€ìÉàè€½q‰Í¡½ÑÌýqÌ­™¥É•‘q‰ñq‰Ñ…­¥¹qÌ­™¥É•q‰ñq‰Õ¹‘•ÉqÌ­™¥É•qˆ½¤°É•…Í½¸è€M!=QL%Iœ°…¹¹½Õ¹•µ•¹Ðè€¡…ÌÍ¡½ÑÌ™¥É•œô°4(€€€ìÉàè€½qˆ üé…Ññ¡…Ù•ñ½Ññ¡½±‘¥¹œ¥qÌ¬ üé½¹•ñ¡¥µñ¡•ÉñÑ¡•µñ…qÌ­ÍÕ‰©•Ð¥qÌ­…ÑqÌ­Õ¹qÌ©Á½¥¹Ñq‰ñq‰Õ¹qÌ©Á½¥¹Ñq‰ñq‰Õ¹Á½¥¹Ñqˆ½¤°É•…Í½¸è€PU9A=%9Pœ°…¹¹½Õ¹•µ•¹Ðè€¡…Ì½¹”…ÐÕ¹Á½¥¹Ðœô°4(€€€ìÉàè€½qˆ üé…Ññ¡…Ù•ñ½Ññ¡½±‘¥¹œ¥qÌ¬ üé½¹•ñ¡¥µñ¡•ÉñÑ¡•µñ…qÌ­ÍÕ‰©•Ð¥qÌ­…ÑqÌ­Ñ…Í•ÉqÌ©Á½¥¹Ñq‰ñq‰Ñ…Í•ÉqÌ©Á½¥¹Ñq‰ñq‰Ñ…Í•ÉÁ½¥¹Ñqˆ½¤°É•…Í½¸è€PQMHA=%9Pœ°…¹¹½Õ¹•µ•¹Ðè€¡…Ì½¹”…ÐÑ…Í•ÈÁ½¥¹Ðœô°4(€€€ìÉàè€½q‰™¥¡Ñ¥¹qÌ­Ý¥Ñ¡q‰ñq‰¤ üèµð…´¥qÌ­™¥¡Ñ¥¹q‰ñq‰ÍÑÉÕ±¥¹qÌ­Ý¥Ñ¡q‰ñq‰Á¡åÍ¥…±qÌ­™¥¡Ñqˆ½¤°É•…Í½¸è€=%H%!Q%9œ°…¹¹½Õ¹•µ•¹Ðè€¥Ì™¥¡Ñ¥¹œÝ¥Ñ „ÍÕ‰©•Ðœô°4(€€€ìÉàè€½q‰½™™¥•ÉqÌ­‘½Ý¹q‰ñq‰¤ üèµð…µð¡…Ù”‰••¹ðÙ”‰••¸¥qÌ¬ üé¡¥ÑñÍ¡½ÑñÍÑ…‰‰•‘ñ¥¹©ÕÉ•¥qˆ½¤°É•…Í½¸è€=%H%9)UIœ°…¹¹½Õ¹•µ•¹Ðè€¡…Ì…¸½™™¥•È•µ•É•¹äœô°4(€€€ìÉàè€½q‰¥qÌ­¹••‘qÌ­¡•±Áq‰ñq‰¹••‘qÌ­¡•±Áq‰ñq‰Í•¹‘qÌ¬ üéµ•qÌ¬¤ü üé…¹½Ñ¡•ÉqÌ¬¤ýÕ¹¥Ñq‰ñq‰Í•¹‘qÌ­Õ¹¥ÑÍq‰ñq‰ÍÑ•ÁqÌ­¥ÑqÌ­ÕÁqˆ½¤°É•…Í½¸è€=%H9LMM%MQ9œ°…¹¹½Õ¹•µ•¹Ðè€¹••‘Ì…ÍÍ¥ÍÑ…¹”œô°4(€tì4(4(€½¹ÍÐµ…Ñ €ôÁ…ÑÑ•É¹Ì¹™¥¹ ¡¥Ñ•´¤€ôø¥Ñ•´¹Éà¹Ñ•ÍÐ¡Ñ•áÐ¤¤ì4(€É•ÑÕÉ¸µ…Ñ €üìÉ•…Í½¸èµ…Ñ ¹É•…Í½¸°…¹¹½Õ¹•µ•¹Ðèµ…Ñ ¹…¹¹½Õ¹•µ•¹Ðô€è¹Õ±°ì4)ô4(4)•áÁ½ÉÐ™Õ¹Ñ¥½¸‰Õ¥±‘5‘Q½¹•A´¡‘ÕÉ…Ñ¥½¹5Ì€ô5}Q=9}5L¤ì4(€½¹ÍÐÍ…µÁ±•½Õ¹Ð€ô5…Ñ ¹µ…à Ä°5…Ñ ¹É½Õ¹¡A5}M5A1}IQ€¨5…Ñ ¹µ…à Ä°‘ÕÉ…Ñ¥½¹5Ì¤€¼€ÄÀÀÀ¤¤ì4(€½¹ÍÐÍ…µÁ±•Ì€ô¹•Ü%¹ÐÄÙÉÉ…ä¡Í…µÁ±•½Õ¹Ð¤ì4(€½¹ÍÐ…µÁ±¥ÑÕ‘”€ô€ÄÈÀÀÀì4(€™½È€¡±•Ð¥¹‘•à€ô€Àì¥¹‘•à€ðÍ…µÁ±•½Õ¹Ðì¥¹‘•à€¬ô€Ä¤ì4(€€€½¹ÍÐÍ•½¹‘Ì€ô¥¹‘•à€¼A5}M5A1}IQì4(€€€½¹ÍÐÍ•µ•¹Ð€ô5…Ñ ¹™±½½È¡Í•½¹‘Ì€¼€À¸ÈÔ¤ì4(€€€½¹ÍÐ™É•ÅÕ•¹ä€ôÍ•µ•¹Ð€”€È€ôôô€À€ü€ÄÈÀÀ€è€àÀÀì4(€€€Í…µÁ±•Ím¥¹‘•át€ô5…Ñ ¹Í¥¸ È€¨5…Ñ ¹A$€¨™É•ÅÕ•¹ä€¨Í•½¹‘Ì¤€øô€À€ü…µÁ±¥ÑÕ‘”€è€µ…µÁ±¥ÑÕ‘”ì4(€ô4(€É•ÑÕÉ¸	Õ™™•È¹™É½´¡Í…µÁ±•Ì¹‰Õ™™•È°Í…µÁ±•Ì¹‰åÑ•=™™Í•Ð°Í…µÁ±•Ì¹‰åÑ•1•¹Ñ ¤ì4)ô4(4)™Õ¹Ñ¥½¸É•ÍÁ½¹Í•½ÉI•Í½±ÕÑ¥½¹ÉÉ½È¡•ÉÉ½È°ÍÁ•…­•É…±±Í¥¸¤ì(€½¹ÍÐÕ¹¥Ð€ôMÑÉ¥¹œ¡ÍÁ•…­•É…±±Í¥¸ñð€Õ¹¥Ðœ¤¹ÑÉ¥´ ¤ì4(€¥˜€¡•ÉÉ½Èü¹½‘”€ôôô€11}5	%U=ULœ¤É•ÑÕÉ¸€‘íÕ¹¥Ñô°Ý¡¥ …±°ý€ì4(€¥˜€¡•ÉÉ½Èü¹½‘”€ôôô€11}9=Q}=U9œ¤É•ÑÕÉ¸€‘íÕ¹¥Ñô°$‘½¸Ð¡…Ù”…¸…Ñ¥Ù”…±°µ…Ñ¡¥¹œÑ¡…Ð¹€ì4(€¥˜€¡•ÉÉ½Èü¹½‘”€ôôô€U9%Q}5	%U=ULœ¤É•ÑÕÉ¸€‘íÕ¹¥Ñô°É•Á•…ÐÑ¡”Õ¹¥Ð…±±Í¥¸¹€ì(€¥˜€¡•ÉÉ½Èü¹½‘”€ôôô€U9%Q}9=Q}=U9œ¤É•ÑÕÉ¸€‘íÕ¹¥Ñô°$½Õ±‘¸Ð±½…Ñ”Ñ¡…ÐÕ¹¥Ð¥¸Ñ¡¥Ì‘¥ÍÁ…Ñ •¹Ñ•È¹€ì(€É•ÑÕÉ¸€¥ÍÁ…Ñ¡•È¥ÌÕ¹…‰±”Ñ¼ÁÉ½•ÍÌÑ¡…ÐÉ•ÅÕ•ÍÐ¸I•Á•…ÐÍ¡½ÉÑ±ä¸œì4)ô()™Õ¹Ñ¥½¸…ÍÍ•ÉÑáÁ±¥¥ÑU¹¥ÑQ…É•ÑÌ¡ìÑÉ…¹ÍÉ¥ÁÐ°Á±…¸°½Á•É…Ñ¥½¹…±½¹Ñ•áÐ°ÍÁ•…­•É…±±Í¥¸ô¤ì(€¥˜€ …Á±…¹UÍ•Í9…µ•‘U¹¥ÑÌ¡Á±…¸¤¤É•ÑÕÉ¸ì(€½¹ÍÐ…¹‘¥‘…Ñ•Ì€ô•áÑÉ…ÑU¹¥Ñ1¥­•Q…É•ÑÌ¡ÑÉ…¹ÍÉ¥ÁÐ¤ì(€¥˜€¡…¹‘¥‘…Ñ•Ì¹±•¹Ñ €ôôô€À¤É•ÑÕÉ¸ì(€½¹ÍÐÉ½ÍÑ•È€ô¹•ÜM•Ð ¡½Á•É…Ñ¥½¹…±½¹Ñ•áÐü¹Õ¹¥ÑÌñðmt¤¹µ…À ¡Õ¹¥Ð¤€ôø¹½Éµ…±¥é•U¹¥ÑQ…É•Ð¡Õ¹¥Ðü¹…±±Í¥¸¤¤¹™¥±Ñ•È¡	½½±•…¸¤¤ì(€É½ÍÑ•È¹…‘¡¹½Éµ…±¥é•U¹¥ÑQ…É•Ð¡ÍÁ•…­•É…±±Í¥¸¤¤ì(€½¹ÍÐµ¥ÍÍ¥¹œ€ô…¹‘¥‘…Ñ•Ì¹™¥¹ ¡…¹‘¥‘…Ñ”¤€ôø€…É½ÍÑ•È¹¡…Ì¡¹½Éµ…±¥é•U¹¥ÑQ…É•Ð¡…¹‘¥‘…Ñ”¤¤¤ì(€¥˜€ …µ¥ÍÍ¥¹œ¤É•ÑÕÉ¸ì(€Ñ¡É½Ü¹•Ü¥ÍÁ…Ñ¡•ÉXÍÉÉ½È¡XÍ}II=I}=L¹U9%Q}9=Q}=U9°U¹¥Ð€‘íµ¥ÍÍ¥¹ô¥Ì¹½Ð¥¸Ñ¡¥Ì‘¥ÍÁ…Ñ •¹Ñ•É€°ì(€€€ÍÑ…ÑÕÍ½‘”è€ÐÀÐ°(€€€‘•Ñ…¥±ÌèìÕ¹¥ÑI•˜èµ¥ÍÍ¥¹œô°(€ô¤ì)ô()™Õ¹Ñ¥½¸Á±…¹UÍ•Í9…µ•‘U¹¥ÑÌ¡Á±…¸¤ì(€½¹ÍÐ…Ñ¥½¹Ì€ôÁ±…¸ü¹…Ñ¥½¸€ôôô€5U1Q%}Q%=8œ€üÁ±…¸¹…Ñ¥½¹Ìñðmt€èmÁ±…¹tì(€É•ÑÕÉ¸…Ñ¥½¹Ì¹Í½µ” ¡¥Ñ•´¤€ôøl(€€€XÍ}Q%=9L¹MM%9}U9%P°XÍ}Q%=9L¹U9MM%9}U9%P°XÍ}Q%=9L¹5-}AI%5Id°(€€€XÍ}Q%=9L¹MQ}U9%Q}MQQUL°XÍ}Q%=9L¹IQ}10°(€t¹¥¹±Õ‘•Ì¡¥Ñ•´ü¹…Ñ¥½¸¤¤ì)ô()™Õ¹Ñ¥½¸•áÑÉ…ÑU¹¥Ñ1¥­•Q…É•ÑÌ¡Ù…±Õ”¤ì(€½¹ÍÐÑ•áÐ€ôMÑÉ¥¹œ¡Ù…±Õ”ñð€œœ¤ì(€½¹ÍÐÉ•ÍÕ±ÑÌ€ômtì(€½¹ÍÐÁ…ÑÑ•É¹Ì€ôl(€€€€½qˆ üéÝ¥Ñ¡ñ…ÍÍ¥¹ñ…ÑÑ…¡ñ…‘¥qÌ¬ üéÕ¹¥ÑqÌ¬¤ü¡m„µéum„µèÀ´ät¨ üélµqÍt­q¬¤¥qˆ½¤°(€€€€½q‰Õ¹¥ÑqÌ¬¡m„µèÀ´åum„µèÀ´äœµt¨ üéqÌ­q¬¤ü¥qˆ½¤°(€tì(€™½È€¡½¹ÍÐÉà½˜Á…ÑÑ•É¹Ì¤ì(€€€™½È€¡½¹ÍÐµ…Ñ ½˜Ñ•áÐ¹µ…Ñ¡±°¡Éà¤¤¥˜€¡µ…Ñ¡lÅt¤É•ÍÕ±ÑÌ¹ÁÕÍ ¡µ…Ñ¡lÅt¤ì(€ô(€É•ÑÕÉ¸ÉÉ…ä¹™É½´¡¹•ÜM•Ð¡É•ÍÕ±ÑÌ¹µ…À ¡¥Ñ•´¤€ôø¥Ñ•´¹ÑÉ¥´ ¤¤¤¤ì)ô()™Õ¹Ñ¥½¸¹½Éµ…±¥é•U¹¥ÑQ…É•Ð¡Ù…±Õ”¤ì(€É•ÑÕÉ¸MÑÉ¥¹œ¡Ù…±Õ”ñð€œœ¤¹Ñ½1½Ý•É…Í” ¤¹É•Á±…” ½my„µèÀ´åt¬½œ°€œ€œ¤¹ÑÉ¥´ ¤ì)ô(4)™Õ¹Ñ¥½¸…¹¹½Õ¹•µ•¹Ñ½Éµ•É•¹ä¡É•…Í½¸¤ì4(€½¹ÍÐÙ…±Õ”€ôMÑÉ¥¹œ¡É•…Í½¸ñð€œœ¤¹Ñ½UÁÁ•É…Í” ¤ì4(€¥˜€¡Ù…±Õ”¹¥¹±Õ‘•Ì M!=QL%Iœ¤¤É•ÑÕÉ¸€¡…ÌÍ¡½ÑÌ™¥É•œì4(€¥˜€¡Ù…±Õ”¹¥¹±Õ‘•Ì U9A=%9Pœ¤¤É•ÑÕÉ¸€¡…Ì½¹”…ÐÕ¹Á½¥¹Ðœì4(€¥˜€¡Ù…±Õ”¹¥¹±Õ‘•Ì QMHœ¤¤É•ÑÕÉ¸€¡…Ì½¹”…ÐÑ…Í•ÈÁ½¥¹Ðœì4(€¥˜€¡Ù…±Õ”¹¥¹±Õ‘•Ì %!Pœ¤¤É•ÑÕÉ¸€¥Ì™¥¡Ñ¥¹œÝ¥Ñ „ÍÕ‰©•Ðœì4(€¥˜€¡Ù…±Õ”¹¥¹±Õ‘•Ì %9)UIœ¤¤É•ÑÕÉ¸€¡…Ì…¸½™™¥•È•µ•É•¹äœì4(€É•ÑÕÉ¸€¹••‘Ì…ÍÍ¥ÍÑ…¹”œì4)ô4(4)™Õ¹Ñ¥½¸•µ•É•¹å…±±QåÁ”¡É•…Í½¸¤ì4(€½¹ÍÐÙ…±Õ”€ôMÑÉ¥¹œ¡É•…Í½¸ñð€œœ¤¹Ñ½UÁÁ•É…Í” ¤ì4(€¥˜€¡Ù…±Õ”¹¥¹±Õ‘•Ì M!=QL%Iœ¤¤É•ÑÕÉ¸€M!=QL%I€¼=%H5I9dœì4(€¥˜€¡Ù…±Õ”¹¥¹±Õ‘•Ì U9A=%9Pœ¤¤É•ÑÕÉ¸€=%HPU9A=%9Pœì4(€¥˜€¡Ù…±Õ”¹¥¹±Õ‘•Ì QMHœ¤¤É•ÑÕÉ¸€=%HPQMHA=%9Pœì4(€¥˜€¡Ù…±Õ”¹¥¹±Õ‘•Ì %!Pœ¤¤É•ÑÕÉ¸€=%H%!Q%9œì4(€¥˜€¡Ù…±Õ”¹¥¹±Õ‘•Ì %9)UIœ¤¤É•ÑÕÉ¸€=%H%9)UIœì4(€É•ÑÕÉ¸€=%H9LMM%MQ9œì4)ô4(4)™Õ¹Ñ¥½¸•Ñ…±±%¡Á…å±½…¤ì4(€É•ÑÕÉ¸±•…¸¡Á…å±½…ü¹¥ñðÁ…å±½…ü¹…±±}¥ñðÁ…å±½…ü¹…±±%ñðÁ…å±½…ü¹…±°ü¹¥ñðÁ…å±½…ü¹…±°ü¹…±±}¥ñðÁ…å±½…ü¹…±°ü¹…±±%¤ì4)ô4(4)™Õ¹Ñ¥½¸•Ñ…±±1½…Ñ¥½¸¡Á…å±½…¤ì4(€É•ÑÕÉ¸±•…¸¡Á…å±½…ü¹±½…Ñ¥½¸ñðÁ…å±½…ü¹…‘‘É•ÍÌñðÁ…å±½…ü¹…±°ü¹±½…Ñ¥½¸ñðÁ…å±½…ü¹…±°ü¹…‘‘É•ÍÌ¤ì4)ô4(4)™Õ¹Ñ¥½¸™½Éµ…Ñ½½É‘¥¹…Ñ•1½…Ñ¥½¸¡±½…Ñ¥½¸¤ì(€¥˜€ …±½…Ñ¥½¸ñð€…9Õµ‰•È¹¥Í¥¹¥Ñ”¡±½…Ñ¥½¸¹±…Ð¤ñð€…9Õµ‰•È¹¥Í¥¹¥Ñ”¡±½…Ñ¥½¸¹±¹œ¤¤É•ÑÕÉ¸¹Õ±°ì(€É•ÑÕÉ¸€‘í±½…Ñ¥½¸¹±…Ñô°‘í±½…Ñ¥½¸¹±¹õ€ì)ô()™Õ¹Ñ¥½¸±½…Ñ¥½¹%ÍÉ•Í ¡±½…Ñ¥½¸°µ…á•5Ì€ô€È€¨€ØÀ€¨€ÄÀÀÀ¤ì(€¥˜€ …±½…Ñ¥½¸ñð€…9Õµ‰•È¹¥Í¥¹¥Ñ”¡±½…Ñ¥½¸¹±…Ð¤ñð€…9Õµ‰•È¹¥Í¥¹¥Ñ”¡±½…Ñ¥½¸¹±¹œ¤¤É•ÑÕÉ¸™…±Í”ì(€¥˜€¡±½…Ñ¥½¸¹Ñ¥µ•ÍÑ…µÀ€ôôôÕ¹‘•™¥¹•ñð±½…Ñ¥½¸¹Ñ¥µ•ÍÑ…µÀ€ôôô¹Õ±°ñð±½…Ñ¥½¸¹Ñ¥µ•ÍÑ…µÀ€ôôô€œœ¤É•ÑÕÉ¸ÑÉÕ”ì(€±•ÐÑ¥µ•ÍÑ…µÀ€ôÑåÁ•½˜±½…Ñ¥½¸¹Ñ¥µ•ÍÑ…µÀ€ôôô€¹Õµ‰•Èœ(€€€€ü±½…Ñ¥½¸¹Ñ¥µ•ÍÑ…µÀ(€€€€è¹•Ü…Ñ”¡±½…Ñ¥½¸¹Ñ¥µ•ÍÑ…µÀ¤¹•ÑQ¥µ” ¤ì(€¥˜€¡9Õµ‰•È¹¥Í¥¹¥Ñ”¡Ñ¥µ•ÍÑ…µÀ¤€˜˜Ñ¥µ•ÍÑ…µÀ€ø€À€˜˜Ñ¥µ•ÍÑ…µÀ€ð€Å”ÄÈ¤Ñ¥µ•ÍÑ…µÀ€¨ô€ÄÀÀÀì(€¥˜€ …9Õµ‰•È¹¥Í¥¹¥Ñ”¡Ñ¥µ•ÍÑ…µÀ¤¤É•ÑÕÉ¸ÑÉÕ”ì(€É•ÑÕÉ¸…Ñ”¹¹½Ü ¤€´Ñ¥µ•ÍÑ…µÀ€ðôµ…á•5Ìì)ô()™Õ¹Ñ¥½¸Í…µ•U¹¥Ð¡„°ˆ¤ì(€É•ÑÕÉ¸MÑÉ¥¹œ¡„ñð€œœ¤¹ÑÉ¥´ ¤¹Ñ½UÁÁ•É…Í” ¤€ôôôMÑÉ¥¹œ¡ˆñð€œœ¤¹ÑÉ¥´ ¤¹Ñ½UÁÁ•É…Í” ¤ì4)ô4(4)™Õ¹Ñ¥½¸±•…¸¡Ù…±Õ”¤ì4(€¥˜€¡Ù…±Õ”€ôôôÕ¹‘•™¥¹•ñðÙ…±Õ”€ôôô¹Õ±°¤É•ÑÕÉ¸¹Õ±°ì4(€½¹ÍÐÑ•áÐ€ôMÑÉ¥¹œ¡Ù…±Õ”¤¹ÑÉ¥´ ¤ì4(€É•ÑÕÉ¸Ñ•áÐñð¹Õ±°ì4)ô4(4)™Õ¹Ñ¥½¸Í±••À¡µÌ¤ì4(€É•ÑÕÉ¸¹•ÜAÉ½µ¥Í” ¡É•Í½±Ù”¤€ôøÍ•ÑQ¥µ•½ÕÐ¡É•Í½±Ù”°µÌ¤¤ì4)ô4