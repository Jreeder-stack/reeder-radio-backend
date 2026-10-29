// AI-DISP-V3-001 / 02-01. Short-lived dialogue custody, NOT a CAD data store.
// Only an authenticated, resolved PTT turn can read or write a conversation.
import { randomUUID } from 'node:crypto';
import { assertV3TurnEnvelope } from './turnEnvelope.js';

export const V3_CONVERSATION_LIMITS = Object.freeze({
  ttlMs: 5 * 60 * 1000,
  maxConversations: 128,
  maxTurns: 12,
  maxSuspended: 3,
  maxTranscriptChars: 240,
});

const limited = (value, max) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const positive = (value, fallback) => Number.isSafeInteger(value) && value > 0 ? value : fallback;
const copy = (value) => structuredClone(value);

// A dialogue record may remember requested parameters, but never caches an
// operational snapshot or represents any CAD fact as a verified source.
function dialogueInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const result = {};
  for (const [key, value] of Object.entries(input).slice(0, 24)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(key) || value == null) continue;
    if (typeof value === 'string') result[key] = limited(value, 180);
    else if (typeof value === 'number' && Number.isFinite(value)) result[key] = value;
    else if (typeof value === 'boolean') result[key] = value;
    else if (Array.isArray(value)) result[key] = value.slice(0, 12)
      .filter((item) => ['string', 'number', 'boolean'].includes(typeof item))
      .map((item) => limited(item, 80));
  }
  return result;
}

export class V3ConversationRecords {
  constructor({ runtimeContext, getGeneration = () => null, now = () => Date.now(), limits = {} } = {}) {
    if (!runtimeContext) throw new TypeError('runtimeContext is required');
    this.context = runtimeContext;
    this.getGeneration = getGeneration;
    this.now = now;
    this.limits = Object.freeze({
      ttlMs: positive(limits.ttlMs, V3_CONVERSATION_LIMITS.ttlMs),
      maxConversations: positive(limits.maxConversations, V3_CONVERSATION_LIMITS.maxConversations),
      maxTurns: positive(limits.maxTurns, V3_CONVERSATION_LIMITS.maxTurns),
      maxSuspended: positive(limits.maxSuspended, V3_CONVERSATION_LIMITS.maxSuspended),
      maxTranscriptChars: positive(limits.maxTranscriptChars, V3_CONVERSATION_LIMITS.maxTranscriptChars),
    });
    this.conversations = new Map();
  }

  // The channel is deliberately absent. A channel routes a transmission; it
  // never establishes the speaker or inherits a different session's task.
  scopeKey(envelope) {
    assertV3TurnEnvelope(envelope, this.context);
    if (envelope.runtimeGeneration !== this.getGeneration()) {
      throw new TypeError('Conversation turn belongs to a stale dispatcher generation');
    }
    if (!envelope.accountId || !envelope.connectionId || !envelope.speakerRef || !envelope.speaker.unitId) {
      throw new TypeError('Authenticated speaker and connection are required for conversation custody');
    }
    return JSON.stringify([
      this.context.runtimeId, envelope.runtimeGeneration, envelope.dispatchCenterId,
      envelope.speaker.unitId, envelope.speakerRef, envelope.accountId, envelope.connectionId,
    ]);
  }

  get(envelope) {
    const key = this.scopeKey(envelope);
    this._prune();
    const record = this.conversations.get(key);
    if (!record) return null;
    this._pruneTasks(record);
    return copy(record);
  }

  recordTurn(envelope, { transcript, reason = null, freshRequest = false } = {}) {
    const key = this.scopeKey(envelope);
    this._prune();
    const time = this.now();
    let record = this.conversations.get(key);
    if (!record) {
      record = {
        id: randomUUID(), scopeKey: key,
        dispatchCenterId: envelope.dispatchCenterId,
        speakerUnitId: envelope.speaker.unitId,
        speakerRef: envelope.speakerRef,
        accountId: envelope.accountId, connectionId: envelope.connectionId,
        createdAt: time, lastActivityAt: time,
        activeTask: null, suspendedTasks: [], turns: [],
      };
      this.conversations.set(key, record);
    }
    this._pruneTasks(record);
    const existing = record.turns.find((turn) => turn.turnId === envelope.turnId);
    if (existing) return { conversationId: record.id, taskId: existing.taskId };

    if (freshRequest || !record.activeTask) {
      if (record.activeTask) this._suspend(record, time);
      record.activeTask = {
        id: randomUUID(), conversationId: record.id,
        state: 'active', originalTurnId: envelope.turnId,
        latestTurnId: envelope.turnId,
        action: null, requestedInput: {}, lastOutcome: null,
        startedAt: time, updatedAt: time,
      };
    } else {
      record.activeTask.latestTurnId = envelope.turnId;
      record.activeTask.updatedAt = time;
    }

    record.turns.push({
      turnId: envelope.turnId, taskId: record.activeTask.id, conversationId: record.id,
      dispatchCenterId: envelope.dispatchCenterId,
      speakerUnitId: envelope.speaker.unitId, speakerRef: envelope.speakerRef,
      accountId: envelope.accountId, connectionId: envelope.connectionId,
      channelId: envelope.channelId, roomKey: envelope.roomKey,
      captureStartedAt: envelope.captureStartedAt,
      captureEndedAt: envelope.captureEndedAt,
      capturedSequence: envelope.intakeSequence,
      reason: limited(reason, 40) || null,
      transcript: limited(transcript, this.limits.maxTranscriptChars),
      action: null, input: {}, clarification: null, success: false,
      recordedAt: time,
    });
    record.turns.splice(0, Math.max(0, record.turns.length - this.limits.maxTurns));
    record.lastActivityAt = time;
    this._bound();
    return { conversationId: record.id, taskId: record.activeTask.id };
  }

  completeTurn(envelope, { plan = null, result = null } = {}) {
    const key = this.scopeKey(envelope);
    this._prune();
    const record = this.conversations.get(key);
    const turn = record?.turns.find((item) => item.turnId === envelope.turnId);
    if (!turn || turn.action) return null;
    const action = limited(plan?.action || 'NO_ACTION', 40).toUpperCase();
    turn.action = action;
    turn.input = dialogueInput(plan?.input);
    turn.clarification = limited(plan?.clarification, 180) || null;
    turn.success = result ? result.success === true : !['NO_ACTION', 'CLARIFY'].includes(action);
    const task = record.activeTask?.id === turn.taskId
      ? record.activeTask : record.suspendedTasks.find((item) => item.id === turn.taskId);
    if (task) {
      task.action = action;
      task.requestedInput = copy(turn.input);
      task.lastOutcome = result ? (result.success === true ? 'completed_operation' : 'failed_operation')
        : action === 'CLARIFY' ? 'clarification_requested' : 'no_cad_effect';
      task.latestTurnId = turn.turnId;
      task.updatedAt = this.now();
    }
    return { conversationId: record.id, taskId: turn.taskId, action };
  }

  recent(envelope) {
    const record = this.get(envelope);
    if (!record) return [];
    return record.turns.filter((turn) => turn.action !== null).slice(-6).map((turn) => ({
      transcript: turn.transcript, action: turn.action, input: turn.input,
      clarification: turn.clarification, success: turn.success, timestamp: turn.recordedAt,
    }));
  }

  // Explicitly scoped state primitive for 02-04's future language-level
  // resume command. No transcript, callsign, or model output can select a
  // different owner's task merely by supplying a task ID.
  activateTask(envelope, taskId) {
    const key = this.scopeKey(envelope);
    this._prune();
    const record = this.conversations.get(key);
    if (!record) return null;
    this._pruneTasks(record);
    if (record.activeTask?.id === taskId) return copy(record.activeTask);
    const index = record.suspendedTasks.findIndex((task) => task.id === taskId);
    if (index === -1) return null;
    const [selected] = record.suspendedTasks.splice(index, 1);
    if (record.activeTask) this._suspend(record, this.now());
    selected.state = 'active';
    selected.updatedAt = this.now();
    record.activeTask = selected;
    record.lastActivityAt = this.now();
    return copy(selected);
  }

  clearAll() { this.conversations.clear(); }

  _suspend(record, time) {
    record.activeTask.state = 'suspended';
    record.activeTask.updatedAt = time;
    record.suspendedTasks.unshift(record.activeTask);
    record.suspendedTasks.length = Math.min(record.suspendedTasks.length, this.limits.maxSuspended);
    record.activeTask = null;
  }

  _pruneTasks(record) {
    const expired = (task) => this.now() - task.updatedAt > this.limits.ttlMs;
    if (record.activeTask && expired(record.activeTask)) record.activeTask = null;
    record.suspendedTasks = record.suspendedTasks.filter((task) => !expired(task));
  }

  _prune() {
    for (const [key, record] of this.conversations) {
      if (this.now() - record.lastActivityAt > this.limits.ttlMs) this.conversations.delete(key);
    }
  }

  _bound() {
    while (this.conversations.size > this.limits.maxConversations) {
      let oldestKey = null, oldestAt = Infinity;
      for (const [key, record] of this.conversations) {
        if (record.lastActivityAt < oldestAt) { oldestAt = record.lastActivityAt; oldestKey = key; }
      }
      if (!oldestKey) break;
      this.conversations.delete(oldestKey);
    }
  }
}
