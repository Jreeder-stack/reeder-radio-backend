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
      callsign: identity.callsign,
      unitUuid: identity.unitId,
      reason: 'EMERGENCY BUTTON ACTIVATION',
      location,
      correlationId,
    });
    this._emergency = state;

    await this._alert(`${identity.callsign}, status check.`, correlationId);
    this._scheduleEmergencyTimer(this.emergencyCheckMs, () => this._runSecondHardwareStatusCheck(state));
    return state;
  }

  async _runSecondHardwareStatusCheck(state) {
    if (!this._isCurrentEmergency(state) || state.stage !== 'status_check_1') return;
    state.stage = 'status_check_2';
    const correlationId = createV3CorrelationId(this.context.runtimeId);
    this._diag('emergency_status_check_second_attempt', correlationId, true, { unitId: state.callsign });
    await this._alert(`${state.callsign}, status check.`, correlationId);
    this._scheduleEmergencyTimer(this.emergencyCheckMs, () => this._escalateEmergency(state, createV3CorrelationId(this.context.runtimeId), {
      reason: 'NO RESPONSE TO EMERGENCY STATUS CHECK',
      note: `${state.callsign} did not answer two emergency status checks.`,
    }));
  }

  async _startVerbalEmergency(unitId, classification, transcript, correlationId) {
    this._diag('verbal_emergency_activation_rejected', correlationId, true, {
      unitId,
      transcript,
      classification: classification?.reason || null,
      policy: 'physical_button_only',
    });
    return false;
  }

  async _escalateEmergency(state, correlationId, options = {}) {
    if (!this._isCurrentEmergency(state)) return false;
    if (state._escalating) {
      if (options.note) state.pendingNotes.push(options.note);
      return true;
    }
    state._escalating = true;
    state.reason = options.reason || state.reason || 'OFFICER NEEDS ASSISTANCE';
    state.stage = 'escalating';
    if (options.note) state.pendingNotes.push(options.note);
    this._clearEmergencyTimers();

    try {
      let operationalContext = null;
      try {
        operationalContext = await this.operationalContextService.snapshot({ speakerCallsign: state.callsign, correlationId });
      } catch (error) {
        this._diag('emergency_operational_context_failed', correlationId, false, { unitId: state.callsign, message: error.message });
      }
      state.operationalContext = operationalContext;
      state.callId = operationalContext?.currentCall?.id || state.callId || null;
      state.location = this._getUnitLocation(state.callsign, { emergency: state.source === 'hardware' }) || state.location || null;

      if (!state.callId) {
        const created = await this._createEmergencyCall(state, correlationId);
        state.callId = getCallId(created);
        state.callLocation = getCallLocation(created) || state.callLocation || null;
      } else {
        state.callLocation = operationalContext?.currentCall?.location || state.callLocation || null;
      }

      try {
        const identity = await this._resolveEmergencyIdentity(state.callsign, correlationId);
        this.operationalAlertService.declareEmergency({
          identity,
          runtimeContext: this.context,
          correlationId,
          callId: state.callId,
          location: state.callLocation || formatCoordinateLocation(state.location),
          reason: state.reason,
        });
      } catch (error) {
        this._diag('emergency_signal_declare_failed', correlationId, false, { unitId: state.callsign, message: error.message });
      }

      state.stage = 'escalated';
      for (const note of state.pendingNotes.splice(0)) {
        await this._recordEmergencyNote(state, note, correlationId);
      }

      const announcement = options.announcement || announcementForEmergency(state.reason);
      await this._alert(`${state.callsign} ${announcement}. Responding units acknowledge.`, correlationId);

      if (state.callLocation) {
        await this._speak(`${state.callsign}, I have you at ${state.callLocation}, confirm.`, correlationId);
      }

      this._scheduleEmergencyTimer(this.emergencyPageMs, () => this._pageEmergencyIfNeeded(state));
      return true;
    } finally {
      state._escalating = false;
    }
  }

  async _createEmergencyCall(state, correlationId) {
    const coordinate = formatCoordinateLocation(state.location);
    let resolved = null;
    if (coordinate) {
      try {
        resolved = await this.gateway.get('/api/radio/locations/resolve', {
          correlationId,
          query: { q: coordinate },
        });
      } catch (error) {
        this._diag('emergency_location_resolution_failed', correlationId, false, { unitId: state.callsign, coordinate, message: error.message });
      }
    }

    const location = clean(resolved?.location?.address) || coordinate || `LOCATION PENDING - ${state.callsign}`;
    const city = clean(resolved?.location?.city);
    const municipality = clean(resolved?.location?.municipality);
    state.callLocation = location;

    const response = await this.gateway.post('/api/radio/call', {
      type: emergencyCallType(state.reason),
      location,
      city: city || undefined,
      municipality: municipality || undefined,
      priority: 'high',
      description: state.reason,
      units: [state.callsign],
    }, { correlationId, timeoutMs: 20000 });

    this._diag('emergency_call_created', correlationId, true, { unitId: state.callsign, callId: getCallId(response), location });
    return response;
  }

  async _addEmergencyResponder(state, responderCallsign, correlationId, transcript) {
    if (!this._isCurrentEmergency(state) || !state.callId) return false;
    if (sameUnit(responderCallsign, state.callsign) || state.responders.has(String(responderCallsign).toUpperCase())) return false;

    const identity = await this._resolveEmergencyIdentity(responderCallsign, correlationId);
    await this.gateway.post('/api/radio/assign', { call_id: state.callId, unit_id: identity.callsign }, { correlationId });
    await this.gateway.post('/api/radio/status', { unit_id: identity.callsign, status: 'en_route' }, { correlationId });
    state.responders.add(identity.callsign.toUpperCase());
    this._clearEmergencyTimers();
    await this._recordEmergencyNote(state, `${identity.callsign} responding.`, correlationId);
    this._diag('emergency_responder_assigned', correlationId, true, { emergencyUnit: state.callsign, responder: identity.callsign, transcript });
    return true;
  }

  async _pageEmergencyIfNeeded(state) {
    if (!this._isCurrentEmergency(state) || state.stage !== 'escalated' || state.responders.size > 0 || state.paged) return false;
    const correlationId = createV3CorrelationId(this.context.runtimeId);
    state.paged = true;

    let context = state.operationalContext;
    try {
      context = await this.operationalContextService.snapshot({ speakerCallsign: state.callsign, correlationId });
      state.operationalContext = context;
    } catch (error) {
      this._diag('emergency_page_context_failed', correlationId, false, { unitId: state.callsign, message: error.message });
    }

    const recipients = (context?.units || [])
      .filter((unit) => unit?.callsign && !sameUnit(unit.callsign, state.callsign))
      .filter((unit) => !OFFLINE_UNIT_RX.test(String(unit.status || '')))
      .map((unit) => unit.callsign);

    const message = `${state.callsign} OFFICER EMERGENCY - ${state.reason}${state.callLocation ? ` - ${state.callLocation}` : ''}. Respond immediately and acknowledge.`;
    const result = await this.emergencyPager({ unitIds: recipients, message, sender: this.context.profileName || 'AI DISPATCHER' });
    await this._recordEmergencyNote(state, `Emergency page sent to ${recipients.length} center unit${recipients.length === 1 ? '' : 's'}; awaiting response.`, correlationId);
    this._diag('emergency_page_sent', correlationId, true, { unitId: state.callsign, recipients, result });

    if (state.responders.size === 0) {
      this._scheduleEmergencyTimer(this.emergencyPageMs, () => this._repeatEmergencyPageIfNeeded(state));
    }
    return true;
  }

  async _repeatEmergencyPageIfNeeded(state) {
    if (!this._isCurrentEmergency(state) || state.responders.size > 0) return false;
    state.paged = false;
    return this._pageEmergencyIfNeeded(state);
  }

  async _recordEmergencyNote(state, note, correlationId) {
    const text = clean(note);
    if (!state?.callId || !text) return false;
    if (ROUTINE_EMERGENCY_CHAT_RX.test(text)) return false;
    try {
      await this.gateway.post('/api/radio/note', {
        call_id: state.callId,
        note: `${state.callsign}: ${text}`,
        unit_id: state.callsign,
      }, { correlationId });
      return true;
    } catch (error) {
      this._diag('emergency_note_failed', correlationId, false, { unitId: state.callsign, message: error.message, note: text });
      return false;
    }
  }

  async _clearEmergencyState({ unitId, reason, announce = false, clearSignal = false } = {}) {
    const state = this._emergency;
    if (!state || !sameUnit(state.callsign, unitId)) return false;
    this._clearEmergencyTimers();
    this._emergency = null;
    if (clearSignal) {
      try { this.signaling.endEmergencyForUnit?.(state.callsign, reason || 'ai_clear'); } catch (_) {}
    }
    this._diag('emergency_state_cleared', null, true, { unitId: state.callsign, reason });
    if (announce) await this._speak(`${state.callsign}, 10-4.`, createV3CorrelationId(this.context.runtimeId));
    return true;
  }

  _restoreEmergencySignalAfterDisconnect(state) {
    if (!state) return;
    const channelId = this.context.roomKey;
    const restored = {
      unitId: state.callsign,
      unitUuid: state.unitUuid,
      agencyId: this.context.agencyId || null,
      channelId,
      dispatchCenterId: this.context.dispatchCenterId,
      runtimeId: this.context.runtimeId,
      correlationId: state.correlationId,
      callId: state.callId || null,
      location: state.callLocation || formatCoordinateLocation(state.location),
      reason: state.reason,
      timestamp: state.startedAt,
      source: 'ai_dispatcher_v3_preserved_disconnect',
    };
    setTimeout(() => {
      if (!this._isCurrentEmergency(state) || !this.signaling.io) return;
      this.signaling.emergencyStates?.set(channelId, restored);
      this.signaling._emitToChannelDispatchers?.(channelId, 'emergency:start', restored);
      this.signaling._emitToChannelDispatchers?.(channelId, 'emergency:force_connect', { ...restored, priority: 'emergency' });
      this._diag('emergency_signal_restored_after_disconnect', null, true, { unitId: state.callsign, channelId });
    }, 0);
  }

  async _resolveEmergencyIdentity(unitId, correlationId) {
    try {
      return await this.unitIdentityService.resolve(unitId, { correlationId });
    } catch (error) {
      this._diag('emergency_identity_resolution_failed', correlationId, false, { unitId, message: error.message });
      return { unitId: String(unitId), callsign: String(unitId), agencyId: this.context.agencyId || null };
    }
  }

  _getUnitLocation(unitId, { emergency = false } = {}) {
    const location = this._peekUnitLocation(unitId);
    if (location) return location;
    this._requestUnitLocation(unitId, { emergency });
    return null;
  }

  _peekUnitLocation(unitId) {
    const tracked = this.signaling.getTrackedLocations?.() || [];
    const exact = tracked.find((item) => sameUnit(item?.unitId, unitId));
    if (exact && Number.isFinite(exact.lat) && Number.isFinite(exact.lng)) {
      return { lat: exact.lat, lng: exact.lng, accuracy: exact.accuracy ?? null, timestamp: exact.timestamp ?? null };
    }
    const presence = this.signaling.unitPresence?.get(unitId);
    const lat = presence?.location?.latitude;
    const lng = presence?.location?.longitude;
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      return { lat, lng, accuracy: presence.location.accuracy ?? null, timestamp: presence.lastSeen ?? null };
    }
    return null;
  }

  _requestUnitLocation(unitId, { emergency = false } = {}) {
    const socket = this.signaling._findSocketByUnitId?.(unitId);
    socket?.emit?.('location:track_start', {
      requestedBy: emergency ? 'ai_dispatcher_v3_emergency' : 'ai_dispatcher_v3_field_incident',
      emergency,
    });
  }

  async _getFreshFieldUnitLocation(unitId, waitMs = 1000) {
    const initial = this._peekUnitLocation(unitId);
    if (locationIsFresh(initial)) return initial;
    this._requestUnitLocation(unitId, { emergency: false });
    const deadline = Date.now() + Math.max(0, Number(waitMs) || 0);
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const location = this._peekUnitLocation(unitId);
      if (locationIsFresh(location)) return location;
    }
    return null;
  }

  _makeEmergencyState({ source, stage, callsign, unitUuid, reason, location, correlationId }) {
    return {
      source,
      stage,
      callsign,
      unitUuid,
      reason,
      location,
      callId: null,
      callLocation: null,
      responders: new Set(),
      paged: false,
      pendingNotes: [],
      operationalContext: null,
      correlationId,
      startedAt: Date.now(),
      _escalating: false,
    };
  }

  _isCurrentEmergency(state) {
    return Boolean(state && this._emergency === state);
  }

  _scheduleEmergencyTimer(delay, fn) {
    const timer = setTimeout(async () => {
      this._emergencyTimers.delete(timer);
      try { await fn(); } catch (error) {
        this._diag('emergency_timer_action_failed', null, false, { message: error.message });
      }
    }, delay);
    timer.unref?.();
    this._emergencyTimers.add(timer);
    return timer;
  }

  _clearEmergencyTimers() {
    for (const timer of this._emergencyTimers) clearTimeout(timer);
    this._emergencyTimers.clear();
  }

  async _processTranscript({ unitId: speakerCallsign, transcript, correlationId, pendingContext = null }) {
    this._diag('transcript_received', correlationId, true, { speakerCallsign, transcript });
    let plan;
    let result = null;
    let operationalContext = null;
    let dialogueContext = this.fieldIncidents.getDialogueContext(speakerCallsign);
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
        pendingContext,
        dialogueContext,
      });
      if (plan.action === 'NO_ACTION' && dialogueContext && !ROUTINE_EMERGENCY_CHAT_RX.test(transcript)) {
        plan = {
          action: V3_ACTIONS.UPDATE_FIELD_INCIDENT,
          input: { unitRef: speakerCallsign, informationType: 'other', value: transcript, note: transcript },
          confidence: 1,
          clarification: null,
          reason: 'field_incident_no_silent_drop',
        };
      }
      assertExplicitUnitTargets({ transcript, plan, operationalContext, speakerCallsign });
      if (plan.action !== 'NO_ACTION' && plan.action !== 'CLARIFY' && plan.confidence < MIN_EXECUTION_CONFIDENCE) {
        plan = { action: 'CLARIFY', input: plan.input || {}, confidence: plan.confidence, clarification: 'Repeat your request.', reason: 'low_confidence' };
      }
      if (plan.action !== 'NO_ACTION' && plan.action !== 'CLARIFY') {
        if (plan.action === 'MULTI_ACTION') {
          result = await this._executeMultiActionPlan(plan, { speakerCallsign, operationalContext, correlationId });
        } else {
          plan = await materializeV3Plan(plan, {
            speakerCallsign,
            unitIdentityService: this.unitIdentityService,
            operationalContextService: this.operationalContextService,
            operationalContext,
            correlationId,
          });
          result = await this.executor.execute({ action: plan.action, input: plan.input }, { correlationId });
        }
      }
    } catch (error) {
      result = { success: false, error: { code: error.code || 'CAD_UNAVAILABLE', message: error.message } };
      plan = { action: 'CLARIFY', input: {}, confidence: 0, clarification: responseForResolutionError(error, speakerCallsign), reason: 'processing_failure' };
      this._diag('transcript_processing_failed', correlationId, false, { speakerCallsign, message: error.message, code: error.code || null });
    }

    dialogueContext = this.fieldIncidents.getDialogueContext(speakerCallsign);
    if (plan.action === 'CLARIFY') {
      this.conversationGate.expectFollowUp(speakerCallsign, { clarification: plan.clarification, input: plan.input || {}, correlationId });
    } else if (result?.error?.code === 'DISPOSITION_REQUIRED') {
      this.conversationGate.expectFollowUp(speakerCallsign, {
        kind: 'disposition',
        callId: result.error.details?.callId || plan.input?.callId || null,
        unitRef: speakerCallsign,
        correlationId,
      });
    } else if (dialogueContext) {
      this.conversationGate.expectFollowUp(speakerCallsign, { ...dialogueContext, correlationId });
    } else if (pendingContext?.kind === 'disposition' && plan.action !== V3_ACTIONS.CLEAR_UNIT && plan.action !== V3_ACTIONS.CLOSE_CALL) {
      this.conversationGate.expectFollowUp(speakerCallsign, { ...pendingContext, correlationId });
    } else {
      this.conversationGate.clear(speakerCallsign);
    }

    const responseText = composeV3Response({ plan, result, speakerCallsign });
    this._remember({ transcript, action: plan.action, input: plan.input || {}, clarification: plan.clarification || null, success: result ? result.success === true : plan.action !== 'NO_ACTION' });
    if (responseText) await this._speak(responseText, correlationId);
  }

  async _executeMultiActionPlan(plan, { speakerCallsign, operationalContext, correlationId }) {
    const steps = [];
    let context = operationalContext;
    for (const actionPlan of plan.actions || []) {
      const materialized = await materializeV3Plan({ ...actionPlan, confidence: plan.confidence }, {
        speakerCallsign,
        unitIdentityService: this.unitIdentityService,
        operationalContextService: this.operationalContextService,
        operationalContext: context,
        correlationId,
      });
      const stepResult = await this.executor.execute({ action: materialized.action, input: materialized.input }, { correlationId });
      steps.push({ action: materialized.action, input: materialized.input, result: stepResult });
      if (!stepResult.success) {
        return {
          success: false,
          action: 'MULTI_ACTION',
          correlationId,
          error: { ...stepResult.error, details: { ...(stepResult.error?.details || {}), completedSteps: steps.slice(0, -1).map((step) => step.action), failedAction: materialized.action } },
          data: { steps },
        };
      }
      try {
        context = await this.operationalContextService.snapshot({ speakerCallsign, correlationId });
      } catch (_) {}
    }
    return { success: true, action: 'MULTI_ACTION', correlationId, data: { steps } };
  }

  async _alert(text, correlationId) {
    const channel = this.context.roomKey;
    const acquired = await this._acquireFloor(channel, correlationId);
    if (!acquired) {
      this._diag('alert_skipped_channel_busy', correlationId, false, { text, channel });
      return false;
    }

    try {
      const tone = buildMdcTonePcm(MDC_TONE_MS);
      const toneFrames = this.codec.encodePcmToOpus(tone);
      for (const frame of toneFrames) {
        this.audioRelay.injectAudio(channel, this.identity, this._sequence++, frame);
        await sleep(TX_FRAME_MS);
      }

      const pcm = await this.synthesize(text);
      const speechFrames = this.codec.encodePcmToOpus(pcm);
      let lastRearmAt = Date.now();
      for (const frame of speechFrames) {
        if (Date.now() - lastRearmAt >= FLOOR_REARM_MS) {
          const rearm = this.floorControl.requestFloor(channel, AI_FLOOR_IDENTITY);
          if (!rearm?.granted) throw new Error(`AI dispatcher lost radio floor to ${rearm?.heldBy || 'another unit'}`);
          lastRearmAt = Date.now();
        }
        this.audioRelay.injectAudio(channel, this.identity, this._sequence++, frame);
        await sleep(TX_FRAME_MS);
      }
      this._diag('emergency_alert_transmitted', correlationId, true, { text, toneFrames: toneFrames.length, speechFrames: speechFrames.length });
      return true;
    } catch (error) {
      this._diag('emergency_alert_failed', correlationId, false, { text, message: error.message });
      return false;
    } finally {
      const released = this.floorControl.releaseFloor(channel, AI_FLOOR_IDENTITY);
      if (!released) this.floorControl.releaseAllForUnit?.(AI_FLOOR_IDENTITY);
    }
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

export function classifyOfficerEmergency(value) {
  const text = String(value || '').trim();
  if (!text || REPORTED_EVENT_RX.test(text)) return null;

  const patterns = [
    { rx: /\bshots?\s+fired\b|\btaking\s+fire\b|\bunder\s+fire\b/i, reason: 'SHOTS FIRED', announcement: 'has shots fired' },
    { rx: /\b(?:at|have|got|holding)\s+(?:one|him|her|them|a\s+subject)\s+at\s+gun\s*point\b|\bgun\s*point\b|\bgunpoint\b/i, reason: 'AT GUNPOINT', announcement: 'has one at gunpoint' },
    { rx: /\b(?:at|have|got|holding)\s+(?:one|him|her|them|a\s+subject)\s+at\s+taser\s*point\b|\btaser\s*point\b|\btaserpoint\b/i, reason: 'AT TASER POINT', announcement: 'has one at taser point' },
    { rx: /\bfighting\s+with\b|\bi(?:'m| am)\s+fighting\b|\bstruggling\s+with\b|\bphysical\s+fight\b/i, reason: 'OFFICER FIGHTING', announcement: 'is fighting with a subject' },
    { rx: /\bofficer\s+down\b|\bi(?:'m| am| have been|'ve been)\s+(?:hit|shot|stabbed|injured)\b/i, reason: 'OFFICER INJURED', announcement: 'has an officer emergency' },
    { rx: /\bi\s+need\s+help\b|\bneed\s+help\b|\bsend\s+(?:me\s+)?(?:another\s+)?unit\b|\bsend\s+units\b|\bstep\s+it\s+up\b/i, reason: 'OFFICER NEEDS ASSISTANCE', announcement: 'needs assistance' },
  ];

  const match = patterns.find((item) => item.rx.test(text));
  return match ? { reason: match.reason, announcement: match.announcement } : null;
}

export function buildMdcTonePcm(durationMs = MDC_TONE_MS) {
  const sampleCount = Math.max(1, Math.round(PCM_SAMPLE_RATE * Math.max(1, durationMs) / 1000));
  const samples = new Int16Array(sampleCount);
  const amplitude = 12000;
  for (let index = 0; index < sampleCount; index += 1) {
    const seconds = index / PCM_SAMPLE_RATE;
    const segment = Math.floor(seconds / 0.25);
    const frequency = segment % 2 === 0 ? 1200 : 800;
    samples[index] = Math.sin(2 * Math.PI * frequency * seconds) >= 0 ? amplitude : -amplitude;
  }
  return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
}

function responseForResolutionError(error, speakerCallsign) {
  const unit = String(speakerCallsign || 'unit').trim();
  if (error?.code === 'CALL_AMBIGUOUS') return `${unit}, which call?`;
  if (error?.code === 'CALL_NOT_FOUND') return `${unit}, I don't have an active call matching that.`;
  if (error?.code === 'UNIT_AMBIGUOUS') return `${unit}, repeat the unit callsign.`;
  if (error?.code === 'UNIT_NOT_FOUND') return `${unit}, I couldn't locate that unit in this dispatch center.`;
  return 'Dispatcher is unable to process that request. Repeat shortly.';
}

function assertExplicitUnitTargets({ transcript, plan, operationalContext, speakerCallsign }) {
  if (!planUsesNamedUnits(plan)) return;
  const candidates = extractUnitLikeTargets(transcript);
  if (candidates.length === 0) return;
  const roster = new Set((operationalContext?.units || []).map((unit) => normalizeUnitTarget(unit?.callsign)).filter(Boolean));
  roster.add(normalizeUnitTarget(speakerCallsign));
  const missing = candidates.find((candidate) => !roster.has(normalizeUnitTarget(candidate)));
  if (!missing) return;
  throw new DispatcherV3Error(V3_ERROR_CODES.UNIT_NOT_FOUND, `Unit ${missing} is not in this dispatch center`, {
    statusCode: 404,
    details: { unitRef: missing },
  });
}

function planUsesNamedUnits(plan) {
  const actions = plan?.action === 'MULTI_ACTION' ? plan.actions || [] : [plan];
  return actions.some((item) => [
    V3_ACTIONS.ASSIGN_UNIT, V3_ACTIONS.UNASSIGN_UNIT, V3_ACTIONS.MAKE_PRIMARY,
    V3_ACTIONS.SET_UNIT_STATUS, V3_ACTIONS.CREATE_CALL,
  ].includes(item?.action));
}

function extractUnitLikeTargets(value) {
  const text = String(value || '');
  const results = [];
  const patterns = [
    /\b(?:with|assign|attach|add)\s+(?:unit\s+)?([a-z][a-z0-9']*(?:[-\s]+\d+))\b/gi,
    /\bunit\s+([a-z0-9][a-z0-9'-]*(?:\s+\d+)?)\b/gi,
  ];
  for (const rx of patterns) {
    for (const match of text.matchAll(rx)) if (match[1]) results.push(match[1]);
  }
  return Array.from(new Set(results.map((item) => item.trim())));
}

function normalizeUnitTarget(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function announcementForEmergency(reason) {
  const value = String(reason || '').toUpperCase();
  if (value.includes('SHOTS FIRED')) return 'has shots fired';
  if (value.includes('GUNPOINT')) return 'has one at gunpoint';
  if (value.includes('TASER')) return 'has one at taser point';
  if (value.includes('FIGHT')) return 'is fighting with a subject';
  if (value.includes('INJURED')) return 'has an officer emergency';
  return 'needs assistance';
}

function emergencyCallType(reason) {
  const value = String(reason || '').toUpperCase();
  if (value.includes('SHOTS FIRED')) return 'SHOTS FIRED / OFFICER EMERGENCY';
  if (value.includes('GUNPOINT')) return 'OFFICER AT GUNPOINT';
  if (value.includes('TASER')) return 'OFFICER AT TASER POINT';
  if (value.includes('FIGHT')) return 'OFFICER FIGHTING';
  if (value.includes('INJURED')) return 'OFFICER INJURED';
  return 'OFFICER NEEDS ASSISTANCE';
}

function getCallId(payload) {
  return clean(payload?.id || payload?.call_id || payload?.callId || payload?.call?.id || payload?.call?.call_id || payload?.call?.callId);
}

function getCallLocation(payload) {
  return clean(payload?.location || payload?.address || payload?.call?.location || payload?.call?.address);
}

function formatCoordinateLocation(location) {
  if (!location || !Number.isFinite(location.lat) || !Number.isFinite(location.lng)) return null;
  return `${location.lat},${location.lng}`;
}

function locationIsFresh(location, maxAgeMs = 2 * 60 * 1000) {
  if (!location || !Number.isFinite(location.lat) || !Number.isFinite(location.lng)) return false;
  if (location.timestamp === undefined || location.timestamp === null || location.timestamp === '') return true;
  let timestamp = typeof location.timestamp === 'number'
    ? location.timestamp
    : new Date(location.timestamp).getTime();
  if (Number.isFinite(timestamp) && timestamp > 0 && timestamp < 1e12) timestamp *= 1000;
  if (!Number.isFinite(timestamp)) return true;
  return Date.now() - timestamp <= maxAgeMs;
}

function sameUnit(a, b) {
  return String(a || '').trim().toUpperCase() === String(b || '').trim().toUpperCase();
}

function clean(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text || null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
