import { audioRelayService } from '../services/audioRelayService.js';
import { signalingService } from '../services/signalingService.js';
import { speechToText, textToSpeech } from '../services/azureSpeechService.js';
import { opusCodec } from '../services/opusCodec.js';
import { floorControlService, AI_FLOOR_IDENTITY } from '../services/floorControlService.js';
import { pageEmergencyUnits } from '../services/emergencyPagingService.js';
import { buildV3RuntimeContext } from './runtimeContract.js';
import { CommandLinkGateway } from './cadGateway.js';
import { UnitIdentityService } from './unitIdentity.js';
import { V3OperationalContextService, assertV3CurrentTaskCall } from './operationalContext.js';
import { V3OperationalAlertService } from './operationalAlertService.js';
import { createDefaultV3ActionHandlers } from './defaultActionHandlers.js';
import { V3ActionExecutor } from './actionExecutor.js';
import { V3DiagnosticsJournal } from './diagnostics.js';
import { V3SpeechPipeline } from './speechPipeline.js';
import { V3IntentPlanner } from './intentPlanner.js';
import { V3ConversationGate, stripV3LeadingAddress } from './conversationGate.js';
import { V3ConversationRecords } from './conversationRecords.js';
import { V3ConnectionCustody } from './connectionCustody.js';
import { V3SharedIncidentFacts, clarifyV3GroupMutation } from './sharedIncidentFacts.js';
import { classifyV3TaskTransition, modelV3TaskTransition } from './taskTransitions.js';
import { createV3PendingTask, resumeV3PendingTask } from './clarificationTasks.js';
import { normalizeV3CommandText } from './deterministicIntent.js';
import { materializeV3Plan } from './planMaterializer.js';
import { composeV3Response } from './responseComposer.js';
import { createV3CorrelationId } from './correlation.js';
import { V3_ACTIONS } from './actionContracts.js';
import { V3FieldIncidentCoordinator } from './fieldIncidentCoordinator.js';
import { DispatcherV3Error, V3_ERROR_CODES } from './errors.js';
import { randomUUID } from 'node:crypto';
import { V3TurnScheduler } from './turnScheduler.js';
import { V3OutboundScheduler } from './outboundScheduler.js';
import { V3TurnLifecycle, runWithV3Life } from './turnLifecycle.js';
import { revalidatePttActor } from '../services/pttProvenance.js';
import { createV3TurnBudget, runWithV3Budget, assertV3DeadlineActive, withV3Stage, V3_DEADLINES } from './operationDeadline.js';
import { hasEndedPttTransmission, samePttTransmission } from '../services/pttProvenance.js';
import {
  pttBelongsToV3Runtime, createV3TurnIdentity, completeV3TurnEnvelope,
  assertV3TurnEnvelope, runWithV3Turn, currentV3TurnEnvelope,
} from './turnEnvelope.js';

const TX_FRAME_MS = 20;
const MIN_EXECUTION_CONFIDENCE = 0.7;
const FLOOR_WAIT_MS = 3000;
const FLOOR_RETRY_MS = 100;
const FLOOR_REARM_MS = 1800;
const EMERGENCY_CHECK_MS = 25000;
const EMERGENCY_PAGE_MS = 25000;
const MDC_TONE_MS = 2000;
const PCM_SAMPLE_RATE = 16000;
const MAX_REMEMBERED_TRANSMISSIONS = 2048;
const MAX_AMBIGUOUS_AUDIO_OWNERS = 128;
const NUMBER_WORD_RX = /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/i;
const HAIL_COMMAND_RX = /\b(status|show|mark|put|set|create|start|close|clear|assign|attach|add|note|check|time|backup|emergency|responding|en\s+route|on\s+scene|available|out\s+of\s+service|off\s+duty|on\s+duty|zone|switch|move|copy|radio\s+check)\b/i;
const REPORTED_EVENT_RX = /\b(caller|complainant|RP|reporting party|someone|subject|victim)\s+(reports?|reported|is reporting|says?|said)\b|\breport(?:ed)?\s+of\b|\bresponding\s+to\b|\bcall\s+for\b/i;
const SAFE_STATUS_RX = /^(?:10\s*[-/]?\s*4|ten\s+four|i(?:'m|\s+am)\s+(?:good|okay|ok|fine)|everything(?:'s|\s+is)\s+(?:okay|ok|fine)|code\s*4|accidental(?:\s+activation)?|false\s+alarm|all\s+good)\s*[.!]*$/i;
const DISTRESS_RX = /\b(i\s+need\s+help|need\s+help|send\s+(?:me\s+)?(?:another\s+)?unit|send\s+units?|step\s+it\s+up|officer\s+down|i(?:'m| am| have been|'ve been)\s+(?:hit|shot|stabbed|injured)|shots?\s+fired|taking\s+fire|under\s+fire|gun\s*point|gunpoint|taser\s*point|taserpoint|fighting\s+with|i(?:'m| am)\s+fighting|struggling\s+with|physical\s+fight|weapon\s+involved)\b/i;
const RESPONDING_RX = /^(?:(?:(?:show|mark|put|set)\s+me\s+)?(?:en\s*route|responding)|i(?:'m|\s+am|'ll\s+be|\s+will\s+be)\s+(?:en\s*route|responding|going)|on\s+my\s+way|i(?:'ll|\s+will)\s+take\s+it)\s*[.!]*$/i;
const ROUTINE_EMERGENCY_CHAT_RX = /^(10\s*[-/]?\s*4|copy|received|okay|ok|stand\s+by|repeat|go\s+ahead)[.! ]*$/i;
const OFFLINE_UNIT_RX = /^(offline|off_duty|unavailable|not_available|out_of_service)$/i;
// A callsign is display/routing metadata, not sufficient outbound custody.
// Two authenticated devices may share a callsign without superseding replies.
const outboundOwnerKey = (identity) => JSON.stringify([
  identity.dispatchCenterId, identity.runtimeGeneration,
  identity.speakerRef, identity.accountId, identity.connectionId,
]);

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
    schedulerLimits = {},
    outboundLimits = {},
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
    this._sessionCustody = new V3ConnectionCustody();
    this._outbound = new V3OutboundScheduler({
      limits: outboundLimits,
      relevant: (entry) => this.isRunning && entry.generation === this.runtimeGeneration
        && entry.channel === this.context.roomKey
        && (!entry.envelope || (entry.envelope.runtimeGeneration === this.runtimeGeneration
          && (entry.kind === 'alert' || this._unitLatestIntake.get(outboundOwnerKey(entry.envelope)) === entry.envelope.intakeSequence)))
        && (entry.kind !== 'routine' || !entry.envelope
          || (this._sessionCustody.isCurrent(entry.envelope) && this._pttRouteCurrent(entry.source))),
      transmit: async (entry, check) => {
        check();
        if (entry.source) {
          // The intake credential may have expired while this response waited
          // behind another channel transmission. Do not broadcast stale data.
          if (!(await revalidatePttActor(entry.source, this.context))) return false;
          check();
        }
        return runWithV3Budget(null, () => runWithV3Life(null, () =>
          entry.kind === 'alert'
            ? this._transmitAlert(entry.text, entry.correlationId, entry.envelope, { signal: entry.controller.signal, check })
            : this._speak(entry.text, entry.correlationId, entry.envelope, { signal: entry.controller.signal, check })));
      },
      onOutcome: (result, entry) => {
        // The outbound terminal outcome, NOT the question creation time,
        // establishes the answer clock for exactly this trusted unit/task.
        if (entry.kind === 'routine') this._settlePromptFromOutput(result, entry.envelope, entry.generation);
        this._diag('outbound_' + result.status,
          result.correlationId, result.status === 'completed', {
            recipient: result.recipient, channel: result.channel, reason: result.reason,
            elapsedMs: result.elapsedMs, deliveryId: result.id, kind: result.kind,
          }, entry.envelope || null);
      },
    });
    this._lifecycle = new V3TurnLifecycle({
      getGeneration: () => this.isRunning ? this.runtimeGeneration : null,
      validator: async (source, identity) => this._sessionCustody.isCurrent(identity)
        && this._pttRouteCurrent(source)
        && await revalidatePttActor(source, this.context)
        && this._sessionCustody.isCurrent(identity)
        && this._pttRouteCurrent(source),
    });
    this._scheduler = new V3TurnScheduler({ limits: schedulerLimits, onTerminal: (ticket, outcome) => {
      this._diag('turn_scheduler_terminal', ticket.identity.turnId, outcome.handled, {
        reason: outcome.reason, code: outcome.code,
        queueAgeMs: ticket.endedAt == null ? null : Math.max(0, Date.now() - ticket.endedAt),
        totalAgeMs: Math.max(0, Date.now() - ticket.identity.captureStartedAt),
      }, ticket.turnEnvelope || null, ticket.identity);
      if (outcome.reason !== 'processed' && outcome.reason !== 'not_addressed') {
        this._lifecycle.cancel(ticket.life, outcome.reason);
      }
      if (outcome.reason === 'capture_expired') {
        this._intake.delete(ticket.identity.transmissionId);
        this.speech.cancelTransmission(ticket.identity.speakerRef, ticket.identity.transmissionId);
      }
    } });
    this._emergency = null;
    this._emergencyTimers = new Set();
    this._rawEmergencyEnds = new Map();
    this._internalEmergencyEndUnsubscribe = null;
    this.runtimeGeneration = null;
    this._intakeSequence = 0;
    this._unitLatestIntake = new Map();
    this._intake = new Map();
    this._seenTransmissions = new Map();
    this._ambiguousSources = new Map();
    this._ambiguousSourcesOverflow = false;

    this.audioRelay = audioRelay;
    this.codec = codec;
    this.floorControl = floorControl;
    this.signaling = signaling;
    this.emergencyPager = emergencyPager;
    this.emergencyCheckMs = Number(emergencyCheckMs) > 0 ? Number(emergencyCheckMs) : EMERGENCY_CHECK_MS;
    this.emergencyPageMs = Number(emergencyPageMs) > 0 ? Number(emergencyPageMs) : EMERGENCY_PAGE_MS;
    this.diagnostics = diagnostics || new V3DiagnosticsJournal();
    this.gateway = new CommandLinkGateway(this.context, { diagnostics: this.diagnostics });
    this.unitIdentityService = new UnitIdentityService({ gateway: this.gateway, context: this.context });
    this.operationalContextService = new V3OperationalContextService({ gateway: this.gateway, unitIdentityService: this.unitIdentityService });
    this.sharedIncidents = new V3SharedIncidentFacts({ gateway: this.gateway, runtimeContext: this.context, getGeneration: () => this.runtimeGeneration });
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
    this.handlers[V3_ACTIONS.REPORT_FIELD_INCIDENT] = (request) =>
      this.fieldIncidents.report({ ...request, custody: this._taskCustody(request.turnEnvelope) });
    this.handlers[V3_ACTIONS.UPDATE_FIELD_INCIDENT] = (request) =>
      this.fieldIncidents.update({ ...request, custody: this._taskCustody(request.turnEnvelope) });
    this.executor = new V3ActionExecutor({ runtimeContext: this.context, handlers: this.handlers, diagnostics: this.diagnostics, requireTurnIdentity: true });
    this.speech = new V3SpeechPipeline({ runtimeContext: this.context, transcribe, codec: this.codec, diagnostics: this.diagnostics });
    this.planner = planner || new V3IntentPlanner({ diagnostics: this.diagnostics });
    this.conversationGate = conversationGate || new V3ConversationGate();
    this.conversations = new V3ConversationRecords({
      runtimeContext: this.context, getGeneration: () => this.runtimeGeneration,
    });
    this.synthesize = synthesize;
    this._audioListener = (frame) => this.speech.pushFrame(frame);
  }

  async start() {
    if (this.isRunning) return true;
    this.runtimeGeneration = randomUUID();
    this._intakeSequence = 0;
    this._unitLatestIntake.clear();
    this._scheduler.start();
    this._outbound.start(this.runtimeGeneration);
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
    this.isRunning = false;
    this._lifecycle.invalidateAll('runtime_stopped');
    this._outbound.stop();
    this.audioRelay.removeAllAudioListeners(this.identity);
    this.floorControl.releaseAllForUnit?.(AI_FLOOR_IDENTITY);
    this._scheduler.stop();
    this.speech.clear();
    for (const record of this._intake.values()) {
      this._diag('turn_capture_stopped', record.identity.turnId, false, { reason: 'runtime_stopped' }, null, record.identity);
    }
    this._intake.clear();
    this._unitLatestIntake.clear();
    this._ambiguousSources.clear();
    this._ambiguousSourcesOverflow = false;
    this.conversationGate.clearAll();
    this._sessionCustody.clearAll();
    this.conversations.clearAll();
    this.fieldIncidents.clearAll();
    this.sharedIncidents.clearAll();
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

  // Socket.IO routing is verified from the server's actual socket and room,
  // never from a user-supplied channel label. Credential-backed HTTP PTT has
  // no socket presence signal and retains its bound-channel/grant validation.
  _pttRouteCurrent(source) {
    const connectionId = source?.principal?.connectionId;
    if (typeof connectionId !== 'string') return false;
    if (!connectionId.startsWith('socket:')) return true;
    const socket = this.signaling?.io?.sockets?.sockets?.get?.(connectionId.slice(7));
    return !!socket && socket.connected === true
      && socket.pttPrincipal === source.principal
      && String(socket.unitId) === source.principal.unitId
      && socket.channels?.has(this.context.roomKey) === true
      && socket.rooms?.has(`channel:${this.context.roomKey}`) === true;
  }

  _activeSiblingConnection(connectionId, identity) {
    if (!connectionId?.startsWith('socket:')) return false;
    const socket = this.signaling?.io?.sockets?.sockets?.get?.(connectionId.slice(7));
    const principal = socket?.pttPrincipal;
    return !!socket && socket.connected === true && !!principal
      && principal.accountId === identity.accountId
      && principal.unitId === identity.speakerRef
      && principal.credentialType === identity.credentialType
      && socket.unitId === identity.speakerRef
      && socket.channels?.has(this.context.roomKey) === true
      && socket.rooms?.has(`channel:${this.context.roomKey}`) === true;
  }

  _retireReplacedConnection(identity, previousConnectionId) {
    for (const state of [...this._lifecycle.turns.values()]) {
      const prior = state.identity;
      if (prior.runtimeGeneration === identity.runtimeGeneration
        && prior.dispatchCenterId === identity.dispatchCenterId
        && prior.speakerRef === identity.speakerRef
        && prior.accountId === identity.accountId
        && prior.credentialType === identity.credentialType
        && prior.connectionId === previousConnectionId) {
        this.cancelTurnById(prior.turnId, 'session_replaced');
      }
    }
    this._outbound.cancelByConnection(identity, previousConnectionId);
    for (const pending of this.conversationGate.pending.values()) {
      try {
        const parts = JSON.parse(pending.sessionKey);
        if (parts[0] === identity.runtimeId && parts[1] === identity.runtimeGeneration
          && parts[2] === identity.dispatchCenterId && parts[4] === identity.speakerRef
          && parts[5] === identity.accountId && parts[6] === previousConnectionId) {
          this.conversationGate.clear(identity.speakerRef, pending.sessionKey);
        }
      } catch (_) { /* malformed pending scope never grants authority */ }
    }
    this._diag('session_connection_replaced', identity.turnId, true,
      { speakerRef: identity.speakerRef, priorOutputCanceled: true }, null, identity);
  }

  getPipelineStatus() {
    return {
      version: 'v3',
      running: this.isRunning,
      connected: this.connected,
      runtimeGeneration: this.runtimeGeneration,
      intakeSequence: this._intakeSequence,
      dispatchCenterId: this.context.dispatchCenterId,
      channelId: this.context.channelId,
      roomKey: this.context.roomKey,
      processing: this._scheduler.status().executing,
      scheduler: this._scheduler.status(),
      outbound: this._outbound.status(),
      emergency: this._emergency ? {
        unitId: this._emergency.callsign,
        source: this._emergency.source,
        stage: this._emergency.stage,
        reason: this._emergency.reason,
        callId: this._emergency.callId || null,
        responders: [...this._emergency.responders],
        paged: this._emergency.paged === true,
      } : null,
      diagnosticSummary: this.diagnostics.getSummary({ runtimeId: this.context.runtimeId, dispatchCenterId: this.context.dispatchCenterId }),
      // Diagnostic events require a separately authorized, center-bound read.
      recentDiagnostics: [],
    };
  }

  async handlePttStart(channelId, unitId, _isEmergency = false, metadata = null) {
    if (!this.isRunning || !this.matchesChannel(channelId) || unitId === this.identity) return false;
    if (!pttBelongsToV3Runtime(metadata, this.context, channelId, unitId) || hasEndedPttTransmission(metadata)) {
      this._diag('turn_intake_rejected', null, false, { reason: 'untrusted_or_mismatched_source' });
      return false;
    }
    if (this._intake.has(metadata.transmissionId) || this._seenTransmissions.has(metadata.transmissionId)) return false;
    const sourceIdentity = {
      runtimeId: this.context.runtimeId, runtimeGeneration: this.runtimeGeneration,
      dispatchCenterId: this.context.dispatchCenterId,
      speakerRef: metadata.principal.unitId, accountId: metadata.principal.accountId,
      credentialType: metadata.principal.credentialType,
      connectionId: metadata.principal.connectionId,
    };
    if (this._sessionCustody.isRetired(sourceIdentity) || !this._pttRouteCurrent(metadata)) {
      this._diag('turn_intake_rejected', null, false, { reason: 'retired_or_unrouted_session' });
      return false;
    }
    const speakerKey = String(metadata.principal.unitId).trim().toUpperCase();
    const blocked = this._ambiguousSources.get(speakerKey);
    if (blocked || this._ambiguousSourcesOverflow) {
      if (blocked) {
        if (blocked.sources.size < MAX_AMBIGUOUS_AUDIO_OWNERS) blocked.sources.set(metadata.transmissionId, metadata);
        else blocked.overflow = true;
      }
      this._rememberTransmission(metadata.transmissionId);
      this._diag('turn_intake_rejected', null, false, { reason: 'ambiguous_audio_owner' });
      return false;
    }
    const competing = [...this._intake.values()].filter((record) => sameUnit(record.identity.speakerRef, metadata.principal.unitId)
      && (record.identity.connectionId !== metadata.principal.connectionId || record.identity.accountId !== metadata.principal.accountId));
    if (competing.length) {
      // Audio has no connection ID. Keeping either capture would attribute
      // indistinguishable packets to an arbitrary authenticated connection.
      const sources = new Map([[metadata.transmissionId, metadata]]);
      let overflow = false;
      for (const record of competing) {
        if (sources.size < MAX_AMBIGUOUS_AUDIO_OWNERS) sources.set(record.identity.transmissionId, record.metadata);
        else overflow = true;
        this._intake.delete(record.identity.transmissionId);
        this._scheduler.cancel(record.ticket, 'ambiguous_audio_owner');
        this.speech.cancelTransmission(record.identity.speakerRef, record.identity.transmissionId);
        this._diag('turn_completed', record.identity.turnId, false, { outcome: 'ambiguous_audio_owner' }, null, record.identity);
      }
      if (this._ambiguousSources.size < MAX_AMBIGUOUS_AUDIO_OWNERS) this._ambiguousSources.set(speakerKey, { sources, overflow });
      else this._ambiguousSourcesOverflow = true;
      this._rememberTransmission(metadata.transmissionId);
      this._diag('turn_intake_rejected', null, false, { reason: 'ambiguous_audio_owner' });
      return false;
    }
    const identity = createV3TurnIdentity({
      runtimeContext: this.context, runtimeGeneration: this.runtimeGeneration,
      intakeSequence: ++this._intakeSequence, transmission: metadata,
    });
    const reservation = this._scheduler.reserve(identity);
    if (!reservation.accepted) {
      this._rememberTransmission(metadata.transmissionId, identity.turnId);
      this._diag('turn_completed', identity.turnId, false, { outcome: reservation.reason }, null, identity);
      return false;
    }
    const existingConnection = this._sessionCustody.currentConnectionId(identity);
    const admitted = this._sessionCustody.admit(identity, {
      preserveExisting: this._activeSiblingConnection(existingConnection, identity),
    });
    if (!admitted.accepted) {
      this._scheduler.cancel(reservation.ticket, admitted.reason);
      this._rememberTransmission(metadata.transmissionId, identity.turnId);
      this._diag('turn_intake_rejected', identity.turnId, false, { reason: admitted.reason }, null, identity);
      return false;
    }
    if (admitted.previousConnectionId) this._retireReplacedConnection(identity, admitted.previousConnectionId);
    const life = this._lifecycle.accept(identity, metadata);
    this._unitLatestIntake.set(outboundOwnerKey(identity), identity.intakeSequence);
    life.owner = this._lifecycle;
    reservation.ticket.life = life;
    // Reserve in intake order before any STT/identity await.
    this.speech.startTransmission({ unitId: metadata.principal.unitId, channelId: this.context.roomKey, correlationId: identity.turnId, turnIdentity: identity });
    const record = { identity, metadata, speaker: null, speakerError: null, ticket: reservation.ticket, life };
    this._intake.set(metadata.transmissionId, record);
    this._rememberTransmission(metadata.transmissionId, identity.turnId);
    this._diag('turn_intake_accepted', identity.turnId, true, {}, null, identity);
    record.speakerPromise = this.unitIdentityService.resolve(identity.speakerRef, { correlationId: identity.turnId })
      .then((speaker) => { record.speaker = speaker; return speaker; })
      .catch((error) => { record.speakerError = error; return null; });
    return true;
  }

  // Internal trusted call site: cancels precisely one not-yet-committed task.
  // Never claims to roll back a submitted CAD mutation.
  cancelTurnById(turnId, reason = 'explicit_supersession') {
    const state = this._lifecycle.get(turnId);
    if (!state) return null;
    const outcome = this._lifecycle.cancelById(turnId, reason);
    this._outbound.cancelByTurn(turnId, reason);
    const ticket = [...this._scheduler.tickets].find((item) => item.identity.turnId === turnId);
    if (ticket && !ticket.executing) this._scheduler.cancel(ticket, reason);
    this._diag('turn_superseded', turnId, false, outcome || {}, state.envelope || null, state.identity);
    return outcome;
  }

  _rememberTransmission(transmissionId, turnId = null) {
    this._seenTransmissions.set(transmissionId, turnId);
    while (this._seenTransmissions.size > MAX_REMEMBERED_TRANSMISSIONS) this._seenTransmissions.delete(this._seenTransmissions.keys().next().value);
  }

  async handlePttEnd(channelId, unitId, _gracePeriodMs = 0, metadata = null) {
    if (!this.isRunning || !this.matchesChannel(channelId) || unitId === this.identity) return false;
    if (!pttBelongsToV3Runtime(metadata, this.context, channelId, unitId) || !Number.isFinite(metadata.captureEndedAt)) {
      this._diag('turn_end_rejected', null, false, { reason: 'untrusted_or_mismatched_source' });
      return false;
    }
    const speakerKey = String(metadata.principal.unitId).trim().toUpperCase();
    const blocked = this._ambiguousSources.get(speakerKey);
    if (blocked) {
      const source = blocked.sources.get(metadata.transmissionId);
      if (source && samePttTransmission(source, metadata)) blocked.sources.delete(metadata.transmissionId);
      // If bounded bookkeeping overflowed, missing source evidence cannot be
      // reconstructed. Remain closed until the runtime is deliberately stopped.
      if (!blocked.sources.size && !blocked.overflow) this._ambiguousSources.delete(speakerKey);
      return false;
    }
    const record = this._intake.get(metadata.transmissionId);
    if (!record || !samePttTransmission(record.metadata, metadata)) return false;
    // Consume once and detach this exact capture before awaiting identity/STT.
    // An old drained end cannot consume a newer capture bearing the same callsign.
    this._intake.delete(metadata.transmissionId);
    const capture = this.speech.sealCapture({ unitId: record.identity.speakerRef, transmissionId: metadata.transmissionId });
    const budget = createV3TurnBudget({ captureEndedAt: metadata.captureEndedAt });
    const outcome = await this._scheduler.complete(record.ticket, async () => runWithV3Life(record.life,
      () => runWithV3Budget(budget, async () => {
      const speaker = await record.speakerPromise;
      const turnEnvelope = completeV3TurnEnvelope(record.identity, metadata, speaker);
      record.ticket.turnEnvelope = turnEnvelope;
      if (!speaker || !capture) {
        this._diag('turn_identity_rejected', record.identity.turnId, false, { reason: record.speakerError?.code || 'speaker_unresolved' }, turnEnvelope);
        return null;
      }
      this._lifecycle.complete(record.life, turnEnvelope);
      return runWithV3Turn(turnEnvelope, () => this.speech.endTransmission({
        unitId: record.identity.speakerRef, capture, turnEnvelope,
      }));
    })), async (transmission) => runWithV3Life(record.life, () => runWithV3Budget(budget,
      () => runWithV3Turn(transmission.turnEnvelope,
        () => withV3Stage('turn_processing', V3_DEADLINES.turnMs,
          () => this._handleCapturedTranscript(transmission))))));
    budget.finish();
    this._lifecycle.retire(record.life);
    this._diag('turn_completed', record.identity.turnId, outcome.handled, {
      outcome: outcome.reason, code: outcome.code,
    }, record.ticket.turnEnvelope || null, record.identity);
    return outcome.handled;
  }

  // Field incident follow-ups are owned by an authenticated conversation task.
  _taskCustody(envelope) {
    if (!envelope) return null;
    const record = this.conversations.get(envelope);
    return record?.activeTask ? { scopeKey: this.conversations.scopeKey(envelope), taskId: record.activeTask.id } : null;
  }

  async _handleCapturedTranscript(transmission) {
    const { unitId, turnEnvelope } = transmission;
    assertV3TurnEnvelope(turnEnvelope, this.context);

    if (await this._handleEmergencyTranscript(transmission)) return true;

    const previousConnection = this._sessionCustody.previousFor(turnEnvelope);
    if (previousConnection) {
      const life = this._lifecycle.get(turnEnvelope.turnId);
      if (life) await this._lifecycle.authorize(life);
      const adopted = this.conversations.adoptConnection(turnEnvelope, previousConnection);
      if (adopted) {
        for (const taskId of adopted.taskIds) {
          this.fieldIncidents.rebindCustody(turnEnvelope.speaker.callsign,
            { scopeKey: adopted.previousScopeKey, taskId },
            { scopeKey: adopted.scopeKey, taskId });
        }
        this._diag('conversation_session_resumed', transmission.correlationId, true,
          { conversationId: adopted.conversationId, recoverableTasks: adopted.taskIds.length }, turnEnvelope);
      }
    }

    const sessionKey = this.conversations.scopeKey(turnEnvelope);
    const ownedConversation = this.conversations.get(turnEnvelope);
    const gate = this.conversationGate.shouldProcess({
      unitId, transcript: transmission.transcript, sessionKey,
      conversationId: ownedConversation?.id || null,
      taskId: ownedConversation?.activeTask?.id || null,
      runtimeGeneration: turnEnvelope.runtimeGeneration,
      channelId: this.context.roomKey,
      dispatcherIdentity: this.identity,
    });
    this._diag('turn_addressed', transmission.correlationId, gate.allowed, {
      reason: gate.reason, pending: !!gate.pending,
      // "Unaddressed" is established by the trusted PTT conversation gate,
      // never by a model-proposed classification or a call sign in speech.
      intentType: !gate.allowed && ['not_addressed', 'unit_to_unit'].includes(gate.reason)
        ? 'unaddressed' : null,
    }, turnEnvelope);
    if (!gate.allowed) {
      this._diag('transmission_ignored', transmission.correlationId, true, { unitId, reason: gate.reason, transcript: transmission.transcript });
      return false;
    }
    // The gate contains only a delivered-question receipt. Actual task,
    // call, speaker and intended CAD operation are retrieved from the ledger.
    const ownedFollowUp = gate.reason === 'follow_up'
      ? this.conversations.followUpForPrompt(turnEnvelope, gate.pending) : null;
    if (gate.reason === 'follow_up' && !ownedFollowUp) {
      this.conversationGate.clear(unitId, sessionKey);
      this._diag('transmission_ignored', transmission.correlationId, true,
        { unitId, reason: 'owned_follow_up_missing_or_expired' }, turnEnvelope);
      return false;
    }
    transmission.transcript = gate.transcript || transmission.transcript;
    transmission.pendingContext = ownedFollowUp;
    const taskTransition = classifyV3TaskTransition(transmission.transcript);
    transmission.sessionKey = sessionKey;
    const conversation = this.conversations.recordTurn(turnEnvelope, {
      transcript: transmission.transcript,
      reason: gate.reason,
      freshRequest: (gate.freshRequest === true && !taskTransition) || gate.reason === 'emergency',
    });
    this._diag('conversation_recorded', transmission.correlationId, true, conversation, turnEnvelope);
    if (gate.reason === 'follow_up' && gate.pending) {
      const state = this._lifecycle.get(turnEnvelope.turnId);
      this._lifecycle.bindPending(state, unitId, gate.pending,
        (owner, pending) => this.conversationGate.isCurrentPending(owner, pending));
    }

    if (taskTransition) {
      await this._handleTaskTransition(taskTransition, transmission);
      return true;
    }

    if (gate.reason === 'wake_word') {
      const hail = normalizeV3RadioHail(transmission.transcript);
      if (hail) {
        this.conversations.completeTurn(turnEnvelope, {
          plan: { action: 'RADIO_HAIL', input: { callsign: hail }, clarification: `${hail}, go ahead.` },
          result: { success: true },
        });
        const followUp = {
          kind: 'radio_hail', callsign: hail, correlationId: transmission.correlationId,
          clarification: `${hail}, go ahead.`,
        };
        this.conversations.setFollowUp(turnEnvelope, followUp);
        this._expectDeliveredFollowUp(unitId, followUp, turnEnvelope);
        this._diag('radio_hail_acknowledged', transmission.correlationId, true, { unitId, callsign: hail });
        this._queueReply(`${hail}, go ahead.`, transmission.correlationId, turnEnvelope);
        return true;
      }
    }

    await this._processTranscript(transmission);
    return true;
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

    // These shortcuts can clear an active emergency or assign a responder.
    // Match the complete reply after only known address/own-callsign prefixes;
    // negation, questions, conditions and quoted phrases must not be discarded.
    const reply = normalizeV3CommandText({
      transcript: stripV3LeadingAddress(text, this.conversationGate.wakeWords), speakerCallsign,
    });

    const active = this._emergency;
    if (active) {
      if (sameUnit(speakerCallsign, active.callsign)) {
        if (active.source === 'hardware' && active.stage.startsWith('status_check') && SAFE_STATUS_RX.test(reply) && !DISTRESS_RX.test(text)) {
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
      } else if (active.stage === 'escalated' && RESPONDING_RX.test(reply)) {
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

  // 02-05. Only a pending implicit operation uses this strict current-call
  // constraint. An explicit independent historical-call command still travels
  // through the normal center-bound CAD resolver and authorization.
  async _assertFollowUpAssignment({ turnEnvelope, callId, correlationId, allowUnassigned = false }) {
    const fresh = await this.operationalContextService.snapshot({
      speakerCallsign: turnEnvelope.speaker.callsign, correlationId,
    });
    return assertV3CurrentTaskCall({
      operationalContext: fresh, expectedCallId: callId,
      expectedUnitId: turnEnvelope.speaker.unitId, allowUnassigned,
    });
  }

  _invalidateChangedFollowUp({ unitId, correlationId, turnEnvelope, error }) {
    const speaker = turnEnvelope.speaker.callsign;
    const scopeKey = this.conversations.scopeKey(turnEnvelope);
    const taskId = this.conversations.get(turnEnvelope)?.activeTask?.id;
    const life = this._lifecycle.get(turnEnvelope.turnId);
    // Release the pending-answer lease BEFORE clearing its delivery token:
    // Task 01's lifecycle must not misclassify this explicit invalidation
    // as a stale asynchronous reply.
    if (life) this._lifecycle.releasePending(life);
    const retired = this.conversations.cancelTask(turnEnvelope, { taskId, reason: 'call_relationship_changed' });
    this.conversationGate.clear(unitId, scopeKey);
    if (retired) this.fieldIncidents.clear(speaker, { scopeKey, taskId: retired.id });
    this.conversations.completeControlTurn(turnEnvelope, 'TASK_INVALIDATED', false);
    const reason = error?.details?.reason;
    const description = reason === 'target_not_active' ? 'the earlier call is no longer active'
      : reason === 'speaker_identity_changed' ? 'the responding unit identity changed'
        : 'your current assignment no longer matches the earlier call';
    const caveat = life?.writeCount > 0 || (retired?.submittedWrites || 0) > 0
      ? ' An earlier CAD change may have been submitted; confirm it before retrying.'
      : ' No new CAD change was submitted for this answer.';
    this._diag('follow_up_relationship_invalidated', correlationId, false, {
      reason, taskId: retired?.id || taskId || null,
    }, turnEnvelope);
    this._queueReply(`${speaker}, ${description}. That follow-up is canceled.${caveat} Give a new complete request or identify the call explicitly.`, correlationId, turnEnvelope);
  }

  // 02-04. All dialogue controls move the ONE trusted task lifecycle. CAD
  // mutations are never rolled back here; hardware emergency is untouched.
  async _handleTaskTransition(control, { unitId, transcript, correlationId, turnEnvelope }) {
    assertV3TurnEnvelope(turnEnvelope, this.context);
    const life = this._lifecycle.get(turnEnvelope.turnId);
    if (life) {
      await this._lifecycle.authorize(life);
      this._lifecycle.releasePending(life);
    }
    assertV3DeadlineActive();
    const speaker = turnEnvelope.speaker.callsign;
    const scopeKey = this.conversations.scopeKey(turnEnvelope);
    const initial = this.conversations.get(turnEnvelope);
    const prior = initial?.activeTask;
    let response = null, followUp = null;

    if (control.kind === 'cancel' || control.kind === 'correct') {
      const canceled = this.conversations.cancelTask(turnEnvelope, { reason: control.kind === 'correct'
        ? 'replaced_by_correction' : 'user_canceled' });
      if (canceled) {
        this.conversationGate.clear(unitId, scopeKey);
        this.fieldIncidents.clear(speaker, { scopeKey, taskId: canceled.id });
        if (canceled.originalTurnId !== turnEnvelope.turnId) {
          this.cancelTurnById(canceled.originalTurnId, control.kind === 'correct' ? 'corrected_request' : 'user_canceled');
        }
      }
      const submitted = (canceled?.submittedWrites || 0) > 0;
      const caveat = submitted ? ' Earlier CAD updates were submitted and have not been reversed.' : '';
      if (control.kind === 'cancel') {
        response = canceled ? `${speaker}, the unfinished request is canceled.${caveat}`
          : `${speaker}, there is no unfinished request to cancel. Earlier CAD actions are not reversed.`;
      } else {
        this.conversations.startNewTaskForTurn(turnEnvelope);
        if (control.revisedRequest) {
          this._diag('task_corrected', correlationId, true, { previousTaskId: canceled?.id || null }, turnEnvelope);
          await this._processTranscript({ unitId, transcript: control.revisedRequest,
            correlationId, pendingContext: null, turnEnvelope });
          return true;
        }
        response = `${speaker}, state the complete corrected request.${caveat}`;
        followUp = { kind: 'correction', clarification: response };
      }
      this._diag('task_' + control.kind, correlationId, !!canceled,
        { taskId: canceled?.id || null, submittedWrites: canceled?.submittedWrites || 0 }, turnEnvelope);
    } else if (control.kind === 'topic') {
      this.conversationGate.clear(unitId, scopeKey);
      this.conversations.startNewTaskForTurn(turnEnvelope);
      if (control.revisedRequest) {
        await this._processTranscript({ unitId, transcript: control.revisedRequest,
          correlationId, pendingContext: null, turnEnvelope });
        return true;
      }
      response = `${speaker}, go ahead with your new request.`;
      followUp = { kind: 'new_topic', clarification: response };
      this._diag('task_topic_suspended', correlationId, true,
        { previousTaskId: prior?.id || null }, turnEnvelope);
    } else if (control.kind === 'resume') {
      this.conversationGate.clear(unitId, scopeKey);
      const selected = this.conversations.resumeTask(turnEnvelope, control.selector);
      if (selected.status === 'resumed') {
        const task = selected.task;
        const saved = task.pendingFollowUp;
        const incident = task.kind === 'field_incident'
          ? this.fieldIncidents.getDialogueContext(speaker, { scopeKey, taskId: task.id }) : null;
        // Even the question asking to resume must not revive an incident
        // after a different dispatcher has closed or reassigned the call.
        if ((task.kind === 'disposition' || task.kind === 'field_incident') && saved) {
          try {
            await this._assertFollowUpAssignment({
              turnEnvelope, callId: task.kind === 'field_incident' ? incident?.callId : saved.callId,
              correlationId, allowUnassigned: task.kind === 'field_incident' && !incident?.callId,
            });
          } catch (error) {
            if (error?.code === V3_ERROR_CODES.CALL_RELATIONSHIP_CHANGED) {
              this._invalidateChangedFollowUp({ unitId, correlationId, turnEnvelope, error });
              return true;
            }
            this.conversations.suspendActiveTask(turnEnvelope, task.id);
            this.conversations.completeControlTurn(turnEnvelope, 'RESUME_TASK', false);
            this._queueReply(`${speaker}, I can't confirm that earlier call's status in CAD. Try resuming after CAD is available.`,
              correlationId, turnEnvelope);
            return true;
          }
        }
        if (task.kind === 'field_incident' && !incident) {
          this.conversations.cancelTask(turnEnvelope, { taskId: task.id, reason: 'incident_dialogue_expired' });
          response = `${speaker}, that incident follow-up is no longer active. State a new request.`;
        } else {
          if (task.kind === 'disposition') response = `${speaker}, what's your disposition for ${saved.callId ? 'call ' + saved.callId : 'the earlier call'}?`;
          else if (task.kind === 'field_incident') response = incident.pendingGoals.includes('location')
            ? `${speaker}, what's your incident location?`
            : incident.pendingGoals.includes('subject_description')
              ? `${speaker}, what's the subject's description?`
              : `${speaker}, continue your incident report.`;
          else response = saved.clarification || `${speaker}, continue your previous request.`;
          followUp = { ...saved, clarification: response };
          this._diag('task_resumed', correlationId, true, { taskId: task.id, kind: task.kind }, turnEnvelope);
        }
      } else {
        response = selected.status === 'ambiguous'
          ? `${speaker}, more than one prior task matches. Specify the task to resume.`
          : `${speaker}, no unfinished earlier task is available to resume.`;
      }
    } else return false;

    this.conversations.completeControlTurn(turnEnvelope,
      { cancel: 'CANCEL_TASK', correct: 'CORRECT_TASK', topic: 'NEW_TOPIC', resume: 'RESUME_TASK' }[control.kind]);
    if (followUp) {
      this.conversations.setFollowUp(turnEnvelope, followUp);
      this._expectDeliveredFollowUp(unitId, { ...followUp, correlationId }, turnEnvelope);
    }
    if (response) this._queueReply(response, correlationId, turnEnvelope);
    return true;
  }

  async _processTranscript({ unitId: speakerCallsign, transcript, correlationId, pendingContext = null, turnEnvelope }) {
    assertV3TurnEnvelope(turnEnvelope, this.context);
    speakerCallsign = turnEnvelope.speaker.callsign;
    this._diag('transcript_received', correlationId, true, { speakerCallsign, transcript });
    let plan;
    let originalPlan = null;
    let result = null;
    let operationalContext = null;
    let sharedIncident = null;
    let sharedReply = null;
    const ownedPendingTask = pendingContext?.kind === 'task_clarification'
      ? this.conversations.pendingTask(turnEnvelope, pendingContext.taskId, pendingContext.originalTurnId)
      : null;
    let dialogueContext = this.fieldIncidents.getDialogueContext(speakerCallsign, this._taskCustody(turnEnvelope));
    try {
      try {
        operationalContext = await this.operationalContextService.snapshot({ speakerCallsign, correlationId });
        this._diag('operational_context_resolved', correlationId, true, {
          speakerCallsign,
          activeCallCount: operationalContext.activeCalls.length,
          currentCallId: operationalContext.currentCall?.id || null,
        });
        if (operationalContext.currentCall?.id) {
          try { sharedIncident = await this.sharedIncidents.view({ operationalContext, correlationId, turnEnvelope }); }
          catch (e) { this._diag('shared_incident_unavailable', correlationId, false, { code: e?.code || 'CAD_UNAVAILABLE' }, turnEnvelope); }
        }
      } catch (contextError) {
        this._diag('operational_context_failed', correlationId, false, { speakerCallsign, message: contextError.message, code: contextError.code || null });
      }

      assertV3DeadlineActive();
      if (pendingContext?.kind === 'task_clarification' && !ownedPendingTask) {
        plan = { action: 'CLARIFY', input: {}, confidence: 0,
          clarification: `${speakerCallsign}, that earlier request expired. Repeat your complete request.`,
          reason: 'clarification_custody_expired' };
      } else {
        plan = await this.planner.plan({
          transcript,
          speakerCallsign,
          runtimeContext: this.context,
          correlationId,
          recentContext: this.conversations.recent(turnEnvelope),
          sharedIncident: this.sharedIncidents.forPlanner(sharedIncident),
          operationalContext,
          pendingContext,
          dialogueContext,
          turnEnvelope,
        });
      }
      originalPlan = plan;
      const semanticTransition = modelV3TaskTransition(plan);
      if (semanticTransition) {
        await this._handleTaskTransition(semanticTransition,
          { unitId: speakerCallsign, transcript, correlationId, turnEnvelope });
        return;
      }
      if (ownedPendingTask && plan.action === ownedPendingTask.action) {
        try {
          plan = await resumeV3PendingTask({
            pendingTask: ownedPendingTask, answer: plan, operationalContext,
            operationalContextService: this.operationalContextService,
            unitIdentityService: this.unitIdentityService, correlationId, turnEnvelope,
          });
        } catch (selectionError) {
          plan = { action: 'CLARIFY', input: {}, confidence: 0,
            clarification: `${speakerCallsign}, ${selectionError.message}. Which one did you mean?`,
            reason: 'clarification_selection_rejected', pendingTask: ownedPendingTask };
        }
      } else if (ownedPendingTask && ['CLARIFY', 'NO_ACTION'].includes(plan.action)) {
        plan = { ...plan, action: 'CLARIFY', input: {},
          clarification: plan.clarification || `${speakerCallsign}, which ${ownedPendingTask.unresolvedField === 'callId' ? 'call' : 'detail'}?`,
          pendingTask: ownedPendingTask };
      }
      // The original pending call/owner survives model interpretation. A
      // short disposition is never allowed to switch to the *new* current
      // call, even if the model omits or invents the call identifier.
      let continuingDisposition = false;
      let continuingIncident = false;
      if (pendingContext && plan.action !== 'CLARIFY' && plan.action !== 'NO_ACTION') {
        const sameClarification = ownedPendingTask && plan.reason === 'clarified_original_task';
        const ownRef = (ref) => !ref || [speakerCallsign, 'speaker', 'me', 'my unit', 'this unit']
          .some((own) => String(ref).trim().toLowerCase() === String(own).toLowerCase());
        const sameDisposition = pendingContext.kind === 'disposition' && plan.action === V3_ACTIONS.CLEAR_UNIT
          && ownRef(plan.input?.unitRef) && !plan.input?.callRef
          && (!plan.input?.callId || plan.input.callId === pendingContext.callId);
        const sameIncident = pendingContext.kind === 'field_incident'
          && plan.action === V3_ACTIONS.UPDATE_FIELD_INCIDENT && !!dialogueContext
          && ownRef(plan.input?.unitRef);
        continuingDisposition = sameDisposition;
        continuingIncident = sameIncident;
        if (pendingContext.kind === 'disposition'
          && [V3_ACTIONS.CLEAR_UNIT, V3_ACTIONS.CLOSE_CALL].includes(plan.action) && !sameDisposition) {
          throw new DispatcherV3Error(V3_ERROR_CODES.CALL_RELATIONSHIP_CHANGED,
            'A pending disposition cannot be redirected to a different call or unit', {
              statusCode: 409, details: { reason: 'answer_target_mismatch' },
            });
        }
        if (pendingContext.kind === 'field_incident'
          && plan.action === V3_ACTIONS.UPDATE_FIELD_INCIDENT && !sameIncident) {
          throw new DispatcherV3Error(V3_ERROR_CODES.CALL_RELATIONSHIP_CHANGED,
            'The earlier incident update has no matching owned task', {
              statusCode: 409, details: { reason: 'incident_custody_changed' },
            });
        }
        if (sameDisposition) {
          plan = { ...plan, input: { ...plan.input,
            callId: pendingContext.callId, unitRef: speakerCallsign } };
        }
        if (!sameClarification && !sameDisposition && !sameIncident
          && !['correction', 'new_topic'].includes(pendingContext.kind)) {
          // The answer was a new task. Release the old delivered-question
          // lease before clearing it so the current Task 01 turn remains
          // live and independently authorized.
          const life = this._lifecycle.get(turnEnvelope.turnId);
          if (life) this._lifecycle.releasePending(life);
          this.conversations.startNewTaskForTurn(turnEnvelope);
          this.conversationGate.clear(speakerCallsign, this.conversations.scopeKey(turnEnvelope));
          dialogueContext = null;
        }
      }
      if (plan.action === 'CLARIFY' && plan.pendingTask && !ownedPendingTask) {
        // The model proposes an operation; only the server may stamp its
        // trusted original turn, owner and CAD-scoped candidate set.
        const pendingTask = createV3PendingTask({ plan, operationalContext, turnEnvelope });
        plan = { ...plan, pendingTask };
      }
      if (plan.action === 'CLARIFY' && pendingContext?.kind === 'disposition') {
        await this._assertFollowUpAssignment({
          turnEnvelope, callId: pendingContext.callId, correlationId,
        });
      } else if (plan.action === 'CLARIFY' && pendingContext?.kind === 'field_incident' && dialogueContext) {
        await this._assertFollowUpAssignment({
          turnEnvelope, callId: dialogueContext.callId,
          correlationId, allowUnassigned: !dialogueContext.callId,
        });
      }
      // NO_ACTION is not a field-incident report. The previous blanket
      // conversion wrote questions, refusals and unrelated speech to stale
      // call IDs and endlessly revived old incident tasks.
      assertV3DeadlineActive();
      this._diag('conversation_selected', correlationId, true, {
        reason: plan?.reason || (plan?.action === 'CLARIFY' ? 'clarification' : 'planned'),
        action: plan?.action || null, pending: !!pendingContext,
      }, turnEnvelope);
      const groupClarification = clarifyV3GroupMutation({ plan, transcript });
      if (groupClarification) plan = groupClarification;
      assertExplicitUnitTargets({ transcript, plan, operationalContext, speakerCallsign });
      if (plan.action !== 'NO_ACTION' && plan.action !== 'CLARIFY' && plan.confidence < MIN_EXECUTION_CONFIDENCE) {
        plan = { action: 'CLARIFY', input: {}, confidence: plan.confidence,
          clarification: 'Repeat your request.', reason: 'low_confidence',
          ...(ownedPendingTask ? { pendingTask: ownedPendingTask } : {}) };
      }
      if (plan.action !== 'NO_ACTION' && plan.action !== 'CLARIFY') {
        if (plan.action === 'MULTI_ACTION') {
          result = await this._executeMultiActionPlan(plan, { speakerCallsign, operationalContext, correlationId, turnEnvelope });
        } else {
          plan = await materializeV3Plan(plan, {
            speakerCallsign,
            unitIdentityService: this.unitIdentityService,
            operationalContextService: this.operationalContextService,
            operationalContext,
            correlationId,
            turnEnvelope,
          });
          // A disposition answer is not a new instruction to the older call.
          // Confirm both the original unit/call relationship and active state
          // immediately before execution, after all model/materialization waits.
          if (continuingDisposition) {
            if (plan.action !== V3_ACTIONS.CLEAR_UNIT
              || plan.input.callId !== pendingContext.callId
              || plan.input.unitId !== turnEnvelope.speaker.unitId) {
              throw new DispatcherV3Error(V3_ERROR_CODES.CALL_RELATIONSHIP_CHANGED,
                'The disposition task target no longer matches the trusted speaker and call', {
                  statusCode: 409, details: { reason: 'answer_target_mismatch' },
                });
            }
            await this._assertFollowUpAssignment({
              turnEnvelope, callId: pendingContext.callId, correlationId,
            });
          }
          // Field coordinator also repeats this check before each follow-up
          // location mutation/note, including after asynchronous resolution.
          if (continuingIncident) {
            if (plan.action !== V3_ACTIONS.UPDATE_FIELD_INCIDENT || !dialogueContext
              || plan.input.unitId !== turnEnvelope.speaker.unitId) {
              throw new DispatcherV3Error(V3_ERROR_CODES.CALL_RELATIONSHIP_CHANGED,
                'The incident follow-up target no longer matches the trusted speaker', {
                  statusCode: 409, details: { reason: 'incident_custody_changed' },
                });
            }
            await this._assertFollowUpAssignment({
              turnEnvelope, callId: dialogueContext.callId,
              correlationId, allowUnassigned: !dialogueContext.callId,
            });
          }
          result = await this.executor.execute({ action: plan.action, input: plan.input }, {
            correlationId, turnEnvelope,
            beforeCadWrite: continuingDisposition
              ? () => this._assertFollowUpAssignment({
                turnEnvelope, callId: pendingContext.callId, correlationId,
              }) : null,
          });
        }
      }
      if (pendingContext && result?.error?.code === V3_ERROR_CODES.CALL_RELATIONSHIP_CHANGED) {
        this._invalidateChangedFollowUp({ unitId: speakerCallsign, correlationId, turnEnvelope, error: result.error });
        return;
      }
    } catch (error) {
      if (pendingContext && error?.code === V3_ERROR_CODES.CALL_RELATIONSHIP_CHANGED) {
        this._invalidateChangedFollowUp({ unitId: speakerCallsign, correlationId, turnEnvelope, error });
        return;
      }
      if (pendingContext && error?.code === V3_ERROR_CODES.CAD_UNAVAILABLE
        && ['disposition', 'field_incident'].includes(pendingContext.kind)) {
        const life = this._lifecycle.get(turnEnvelope.turnId);
        if (life) this._lifecycle.releasePending(life);
        this.conversationGate.clear(speakerCallsign, this.conversations.scopeKey(turnEnvelope));
        const taskId = this.conversations.get(turnEnvelope)?.activeTask?.id;
        if (taskId) this.conversations.suspendActiveTask(turnEnvelope, taskId);
        this.conversations.completeControlTurn(turnEnvelope, 'CAD_UNAVAILABLE', false);
        this._queueReply(`${speakerCallsign}, CAD is unavailable. I can't verify your earlier call, so that update was not submitted. Ask to resume when CAD is available.`,
          correlationId, turnEnvelope);
        return;
      }
      result = { success: false, error: { code: error.code || 'CAD_UNAVAILABLE', message: error.message } };
      const pendingTask = ownedPendingTask || createV3PendingTask({
        plan: originalPlan, error, operationalContext, turnEnvelope,
      });
      plan = { action: 'CLARIFY', input: {}, confidence: 0,
        clarification: responseForResolutionError(error, speakerCallsign),
        reason: 'processing_failure', ...(pendingTask ? { pendingTask } : {}) };
      this._diag('transcript_processing_failed', correlationId, false, { speakerCallsign, message: error.message, code: error.code || null });
    }

    assertV3DeadlineActive();
    if (result?.success) {
      this.sharedIncidents.remember({ plan, result, turnEnvelope });
      if (sharedIncident && [V3_ACTIONS.GET_CALL, V3_ACTIONS.GET_CURRENT_CALL].includes(plan?.action)) {
        try {
          const fresh = await this.operationalContextService.snapshot({ speakerCallsign, correlationId });
          const candidate = await this.sharedIncidents.view({ operationalContext: fresh, correlationId, turnEnvelope });
          if (candidate?.callId === sharedIncident.callId) sharedReply = candidate;
        } catch (e) { this._diag('shared_incident_recheck_failed', correlationId, false, { code: e?.code || 'CAD_UNAVAILABLE' }, turnEnvelope); }
      }
    }
    assertV3DeadlineActive();
    // Commit the outcome before preparing any reply. A question is not an
    // answer window until the outbound lane reports completed injection.
    const life = this._lifecycle.get(turnEnvelope.turnId);
    if (life) this._lifecycle.releasePending(life);
    dialogueContext = this.fieldIncidents.getDialogueContext(speakerCallsign, this._taskCustody(turnEnvelope));
    const responseText = composeV3Response({ plan, result, speakerCallsign, turnEnvelope, sharedIncident: sharedReply });
    this.conversations.completeTurn(turnEnvelope, { plan, result, submittedWrites: life?.writeCount || 0 });
    if (plan.action === 'NO_ACTION' && dialogueContext) {
      this.fieldIncidents.clear(speakerCallsign, this._taskCustody(turnEnvelope));
      dialogueContext = null;
    }

    let followUp = null;
    if (plan.action === 'CLARIFY') {
      const task = plan.pendingTask;
      followUp = {
        clarification: plan.clarification,
        ...(task ? {
          kind: 'task_clarification',
          originalTurnId: task.originalTurnId, pendingTask: task,
        } : { input: plan.input || {} }),
      };
    } else if (result?.error?.code === 'DISPOSITION_REQUIRED') {
      followUp = {
        kind: 'disposition',
        callId: result.error.details?.callId || plan.input?.callId || null,
        unitRef: speakerCallsign,
      };
    } else if (dialogueContext) {
      followUp = { ...dialogueContext };
    } else if (pendingContext?.kind === 'disposition' && plan.action !== V3_ACTIONS.CLEAR_UNIT && plan.action !== V3_ACTIONS.CLOSE_CALL) {
      followUp = { ...pendingContext };
    }

    // A silent response or an output rejected by the scheduler cannot create
    // a wake-free follow-up. Retain CAD facts, not an imaginary heard prompt.
    if (followUp && responseText) {
      this.conversations.setFollowUp(turnEnvelope, followUp);
      this._expectDeliveredFollowUp(speakerCallsign, { ...followUp, correlationId }, turnEnvelope);
    } else {
      this.conversationGate.clear(speakerCallsign, this.conversations.scopeKey(turnEnvelope));
    }
    if (responseText) this._queueReply(responseText, correlationId, turnEnvelope);
  }

  async _executeMultiActionPlan(plan, { speakerCallsign, operationalContext, correlationId, turnEnvelope }) {
    assertV3TurnEnvelope(turnEnvelope, this.context);
    assertV3DeadlineActive();
    const steps = [];
    let context = operationalContext;
    for (const actionPlan of plan.actions || []) {
      assertV3DeadlineActive();
      const materialized = await materializeV3Plan({ ...actionPlan, confidence: plan.confidence }, {
        speakerCallsign,
        unitIdentityService: this.unitIdentityService,
        operationalContextService: this.operationalContextService,
        operationalContext: context,
        correlationId,
        turnEnvelope,
      });
      const stepResult = await this.executor.execute({ action: materialized.action, input: materialized.input }, { correlationId, turnEnvelope });
      steps.push({ action: materialized.action, input: materialized.input, result: stepResult });
      if (!stepResult.success) {
        return {
          success: false,
          action: 'MULTI_ACTION',
          correlationId,
          turnEnvelope,
          error: { ...stepResult.error, details: { ...(stepResult.error?.details || {}), completedSteps: steps.slice(0, -1).map((step) => step.action), failedAction: materialized.action } },
          data: { steps },
        };
      }
      try {
        context = await this.operationalContextService.snapshot({ speakerCallsign, correlationId });
      } catch (_) {}
    }
    return { success: true, action: 'MULTI_ACTION', correlationId, turnEnvelope, data: { steps } };
  }

  // A question is correlated to a trusted runtime generation, speaker,
  // authenticated session, conversation, active task, routing channel and turn.
  _expectDeliveredFollowUp(unitId, details, envelope) {
    if (!envelope || !this.isRunning) return null;
    const conversation = this.conversations.get(envelope);
    const task = conversation?.activeTask;
    if (!task || task.latestTurnId !== envelope.turnId) return null;
    return this.conversationGate.expectFollowUp(unitId, {
      kind: task.kind, sessionKey: this.conversations.scopeKey(envelope),
      conversationId: conversation.id, taskId: task.id,
      promptTurnId: envelope.turnId,
      runtimeGeneration: envelope.runtimeGeneration, channelId: this.context.roomKey,
    });
  }

  // Called only by the real outbound scheduler's terminal receipt, or the
  // immediate reject path. "completed" means locally observed relay injection,
  // not confirmation that a person heard the transmission.
  _settlePromptFromOutput(outcome, envelope, generation = this.runtimeGeneration) {
    if (!envelope || envelope.runtimeGeneration !== generation || generation !== this.runtimeGeneration
      || !this.isRunning) return false;
    let conversation;
    try { conversation = this.conversations.get(envelope); } catch (_) { return false; }
    if (!conversation?.activeTask) return false;
    const settled = this.conversationGate.settlePromptDelivery({
      unitId: outcome.recipient, promptTurnId: envelope.turnId,
      sessionKey: conversation.scopeKey, conversationId: conversation.id,
      taskId: conversation.activeTask.id, runtimeGeneration: generation,
      channelId: outcome.channel, status: outcome.status,
    });
    if (settled) this._diag('follow_up_prompt_' + outcome.status, envelope.turnId,
      outcome.status === 'completed', {
        taskId: conversation.activeTask.id, conversationId: conversation.id,
        recipient: outcome.recipient, channel: outcome.channel,
        verifiedReceipt: 'local_transmission_only',
      }, envelope);
    return settled;
  }

  _queueReply(text, correlationId, envelope) {
    const recipient = envelope?.speaker?.callsign || envelope?.speakerRef || null;
    const queued = this._outbound.enqueue({
      text, correlationId, envelope, recipient,
      source: envelope ? this._lifecycle.get(envelope.turnId)?.source || null : null,
      channel: this.context.roomKey, generation: this.runtimeGeneration, turnId: envelope?.turnId || null,
    });
    if (!queued.accepted) {
      this._settlePromptFromOutput({
        recipient, channel: this.context.roomKey, status: 'failed',
      }, envelope);
      this._diag('outbound_failed', correlationId, false,
        { reason: queued.reason, recipient }, envelope || null);
    }
    return queued;
  }

  async _alert(text, correlationId, turnEnvelope = currentV3TurnEnvelope()) {
    // Physical emergency signal and floor controls remain authoritative. The
    // priority lane preempts routine AI output, never another speaker's floor.
    if (!this.isRunning) return this._transmitAlert(text, correlationId, turnEnvelope);
    const task = this._outbound.enqueue({
      text, correlationId, envelope: turnEnvelope, recipient: turnEnvelope?.speaker?.callsign || null,
      source: turnEnvelope ? this._lifecycle.get(turnEnvelope.turnId)?.source || null : null,
      channel: this.context.roomKey, generation: this.runtimeGeneration, turnId: turnEnvelope?.turnId || null,
      kind: 'alert', priority: true,
    });
    if (!task.accepted) return false;
    return (await task.delivery).status === 'completed';
  }

  async _transmitAlert(text, correlationId, turnEnvelope = currentV3TurnEnvelope(), { signal = null, check = () => {} } = {}) {
    assertV3DeadlineActive();
    check();
    const channel = this.context.roomKey;
    const acquired = await this._acquireFloor(channel, correlationId, { signal, check });
    assertV3DeadlineActive();
    if (!acquired) {
      this._diag('alert_skipped_channel_busy', correlationId, false, { text, channel });
      return false;
    }

    try {
      const tone = buildMdcTonePcm(MDC_TONE_MS);
      const toneFrames = this.codec.encodePcmToOpus(tone);
      for (const frame of toneFrames) {
        check();
        assertV3DeadlineActive();
        this.audioRelay.injectAudio(channel, this.identity, this._sequence++, frame);
        await sleep(TX_FRAME_MS);
      }

      const pcm = await withV3Stage('synthesis', V3_DEADLINES.synthesisMs,
        ({ signal: synthesisSignal, timeoutMs }) => this.synthesize(text, { turnEnvelope, signal: synthesisSignal, timeoutMs }), { signal });
      check();
      assertV3DeadlineActive();
      const speechFrames = this.codec.encodePcmToOpus(pcm);
      let lastRearmAt = Date.now();
      for (const frame of speechFrames) {
        check();
        assertV3DeadlineActive();
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

  async _speak(text, correlationId, turnEnvelope = currentV3TurnEnvelope(), { signal = null, check = () => {} } = {}) {
    try { check(); assertV3DeadlineActive(); } catch (_) { return false; }
    const channel = this.context.roomKey;
    const acquired = await this._acquireFloor(channel, correlationId, { signal, check });
    if (!acquired) {
      this._diag('speech_skipped_channel_busy', correlationId, false, { text, channel });
      return false;
    }

    let framesSent = 0;
    let lastRearmAt = Date.now();
    try {
      const started = Date.now();
      const pcm = await withV3Stage('synthesis', V3_DEADLINES.synthesisMs,
        ({ signal: synthesisSignal, timeoutMs }) => this.synthesize(text, { turnEnvelope, signal: synthesisSignal, timeoutMs }), { signal });
      check();
      assertV3DeadlineActive();
      const opusFrames = this.codec.encodePcmToOpus(pcm);
      this._diag('tts_ready', correlationId, true, { text, frames: opusFrames.length, latencyMs: Date.now() - started });

      for (const frame of opusFrames) {
        check();
        assertV3DeadlineActive();
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

  async _acquireFloor(channel, correlationId, { signal = null, check = () => {} } = {}) {
    const deadline = Date.now() + FLOOR_WAIT_MS;
    while (Date.now() <= deadline) {
      if (signal?.aborted) return false;
      check();
      assertV3DeadlineActive();
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

  _diag(phase, correlationId, success = null, details = {}, turnEnvelope = currentV3TurnEnvelope(), turnIdentity = turnEnvelope?.identity || null) {
    this.diagnostics.record({ phase, correlationId, runtimeId: this.context.runtimeId, dispatchCenterId: this.context.dispatchCenterId, channelId: this.context.channelId, success, details, turnEnvelope, turnIdentity });
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
