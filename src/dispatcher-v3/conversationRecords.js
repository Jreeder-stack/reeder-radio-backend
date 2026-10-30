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
const unfinished = (task) => !!task && !task.finishedAt && !!task.pendingFollowUp
  && !['canceled', 'expired'].includes(task.state);
function newTask(record, envelope, time) {
  return {
    id: randomUUID(), conversationId: record.id,
    state: 'active', kind: 'operation', originalTurnId: envelope.turnId,
    latestTurnId: envelope.turnId,
    action: null, requestedInput: {}, pendingTask: null, pendingFollowUp: null,
    lastOutcome: null, submittedWrites: 0, finishedAt: null,
    startedAt: time, updatedAt: time,
  };
}

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

  // A newly authenticated connection may recover only unfinished, bounded
  // tasks from its own replaced connection. Old prompt receipts are NOT moved:
  // a fresh, explicitly addressed resume request must be heard and delivered.
  adoptConnection(envelope, previousConnectionId) {
    const key = this.scopeKey(envelope);
    this._prune();
    if (!previousConnectionId || previousConnectionId === envelope.connectionId) return null;
    const scope = JSON.parse(key);
    scope[scope.length - 1] = previousConnectionId;
    const oldKey = JSON.stringify(scope);
    const prior = this.conversations.get(oldKey);
    if (!prior || prior.accountId !== envelope.accountId
      || prior.speakerRef !== envelope.speakerRef
      || prior.speakerUnitId !== envelope.speaker.unitId
      || prior.credentialType !== envelope.credentialType) return null;
    this._pruneTasks(prior);
    this.conversations.delete(oldKey);
    if (this.conversations.has(key)) return null;
    const pending = [prior.activeTask, ...prior.suspendedTasks].filter(unfinished)
      .slice(0, this.limits.maxSuspended);
    if (!pending.length) return null;
    const adopted = {
      ...prior, scopeKey: key, connectionId: envelope.connectionId,
      activeTask: null, suspendedTasks: pending.map((task) => ({ ...task, state: 'suspended' })),
      turns: [], lastActivityAt: this.now(),
    };
    this.conversations.set(key, adopted);
    return {
      conversationId: adopted.id, previousScopeKey: oldKey, scopeKey: key,
      taskIds: adopted.suspendedTasks.map((task) => task.id),
    };
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
        credentialType: envelope.credentialType,
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
      record.activeTask = newTask(record, envelope, time);
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

  completeTurn(envelope, { plan = null, result = null, submittedWrites = 0 } = {}) {
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
      if (action === 'CLARIFY' && plan?.pendingTask) {
        // Preserve the intended operation, its original turn, known fields and
        // bounded candidate references instead of overwriting it with CLARIFY.
        task.action = plan.pendingTask.action;
        task.requestedInput = copy(plan.pendingTask.input);
        task.pendingTask = copy(plan.pendingTask);
        task.state = 'awaiting_clarification';
        task.kind = 'task_clarification';
        task.finishedAt = null;
        task.lastOutcome = 'clarification_requested';
      } else {
        task.action = action;
        task.requestedInput = copy(turn.input);
        task.pendingTask = null;
        task.state = action === 'CLARIFY' ? 'awaiting_clarification' : 'completed';
        task.finishedAt = action === 'CLARIFY' ? null : this.now();
        task.lastOutcome = result ? (result.success === true ? 'completed_operation' : 'failed_operation')
          : action === 'CLARIFY' ? 'clarification_requested' : 'no_cad_effect';
      }
      task.submittedWrites = (task.submittedWrites || 0) + Math.max(0, submittedWrites | 0);
      task.latestTurnId = turn.turnId;
      task.updatedAt = this.now();
    }
    return { conversationId: record.id, taskId: turn.taskId, action };
  }

  // The only source of lifecycle state for clarification, disposition and
  // field-incident follow-ups. Prompt delivery is still owned by the gate.
  setFollowUp(envelope, details) {
    const key = this.scopeKey(envelope), record = this.conversations.get(key);
    const task = record?.activeTask;
    if (!task || task.latestTurnId !== envelope.turnId || !details || typeof details !== 'object') return null;
    task.pendingFollowUp = copy(details);
    task.kind = ['task_clarification', 'disposition', 'field_incident', 'radio_hail', 'correction', 'new_topic']
      .includes(details.kind) ? details.kind : 'clarification';
    task.state = task.kind === 'task_clarification' ? 'awaiting_clarification' : 'awaiting_follow_up';
    task.finishedAt = null;
    task.updatedAt = this.now();
    return copy(task);
  }

  // Control utterances are committed without overwriting the task they
  // cancel, suspend or resume; they never represent a CAD operation.
  completeControlTurn(envelope, action, success = true) {
    const key = this.scopeKey(envelope), record = this.conversations.get(key);
    const turn = record?.turns.find((item) => item.turnId === envelope.turnId);
    if (!turn || turn.action) return false;
    turn.action = limited(action, 40).toUpperCase();
    turn.success = success === true;
    return true;
  }

  // Only the authenticated owner may cancel an unfinished task. A submitted
  // CAD write is preserved as historical evidence, never described as undone.
  cancelTask(envelope, { taskId = null, reason = 'user_canceled' } = {}) {
    const key = this.scopeKey(envelope), record = this.conversations.get(key);
    if (!record) return null;
    this._pruneTasks(record);
    const candidates = [record.activeTask, ...record.suspendedTasks];
    const target = candidates.find((task) => unfinished(task) && (!taskId || task.id === taskId));
    if (!target) return null;
    target.state = 'canceled';
    target.finishedAt = this.now();
    target.lastOutcome = limited(reason, 40);
    target.updatedAt = this.now();
    const result = copy(target);
    target.pendingFollowUp = null;
    target.pendingTask = null;
    record.suspendedTasks = record.suspendedTasks.filter((task) => task.id !== target.id);
    record.lastActivityAt = this.now();
    return result;
  }

  // A new independent request cannot inherit the old task's incident,
  // clarification or disposition. Reassign only the current trusted turn.
  startNewTaskForTurn(envelope) {
    const key = this.scopeKey(envelope), record = this.conversations.get(key);
    const turn = record?.turns.find((item) => item.turnId === envelope.turnId);
    if (!turn) return null;
    if (record.activeTask?.originalTurnId === envelope.turnId
      && record.activeTask.latestTurnId === envelope.turnId) return copy(record.activeTask);
    if (record.activeTask) this._suspend(record, this.now());
    const task = newTask(record, envelope, this.now());
    record.activeTask = task;
    turn.taskId = task.id;
    record.lastActivityAt = this.now();
    return copy(task);
  }

  // Only an owner's bounded, unfinished suspended task can be resumed.
  // Topic selection never accepts a model-supplied task ID or foreign state.
  resumeTask(envelope, selector = null) {
    const key = this.scopeKey(envelope), record = this.conversations.get(key);
    if (!record) return { status: 'missing' };
    this._pruneTasks(record);
    const kind = String(selector || '').toLowerCase();
    const compatible = (task) => {
      if (!unfinished(task)) return false;
      if (['incident', 'report'].includes(kind)) return task.kind === 'field_incident';
      if (kind === 'disposition') return task.kind === 'disposition';
      if (['clarification', 'assignment', 'question'].includes(kind)) return task.kind === 'task_clarification';
      return true;
    };
    const candidates = record.suspendedTasks.filter(compatible);
    if (!candidates.length) return { status: 'missing' };
    if (kind && !['request', 'task', 'conversation'].includes(kind) && candidates.length > 1) {
      return { status: 'ambiguous' };
    }
    const selected = candidates[0];
    const turn = record.turns.find((item) => item.turnId === envelope.turnId);
    if (!turn) return { status: 'missing' };
    record.suspendedTasks.splice(record.suspendedTasks.indexOf(selected), 1);
    if (record.activeTask) this._suspend(record, this.now());
    selected.state = selected.kind === 'task_clarification' ? 'awaiting_clarification' : 'awaiting_follow_up';
    selected.latestTurnId = envelope.turnId;
    selected.updatedAt = this.now();
    record.activeTask = selected;
    record.lastActivityAt = this.now();
    turn.taskId = selected.id;
    return { status: 'resumed', task: copy(selected) };
  }

  // Temporary CAD uncertainty does not erase a still-live task. Only the
  // authenticated owner may put the resumed task back into its bounded pool.
  suspendActiveTask(envelope, taskId) {
    const key = this.scopeKey(envelope), record = this.conversations.get(key);
    if (!record?.activeTask || record.activeTask.id !== taskId
      || !unfinished(record.activeTask)) return false;
    this._suspend(record, this.now());
    record.lastActivityAt = this.now();
    return true;
  }

  // Pending answers use the full trusted scope AND the exact task/original
  // turn, not a callsign or a model-supplied identifier alone.
  pendingTask(envelope, taskId, originalTurnId) {
    const record = this.get(envelope);
    const task = record?.activeTask;
    if (!task || task.state !== 'awaiting_clarification'
      || task.id !== taskId || task.originalTurnId !== originalTurnId
      || task.pendingTask?.originalTurnId !== originalTurnId) return null;
    return copy(task.pendingTask);
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
    if (['canceled', 'expired'].includes(record.activeTask.state)) {
      record.activeTask = null;
      return;
    }
    record.activeTask.state = 'suspended';
    record.activeTask.updatedAt = time;
    record.suspendedTasks.unshift(record.activeTask);
    record.suspendedTasks.length = Math.min(record.suspendedTasks.length, this.limits.maxSuspended);
    record.activeTask = null;
  }

  _pruneTasks(record) {
    const expired = (task) => this.now() - task.updatedAt > this.limits.ttlMs;
    if (record.activeTask && expired(record.activeTask)) {
      record.activeTask.state = 'expired';
      record.activeTask = null;
    }
    record.suspendedTasks = record.suspendedTasks.filter((task) => !expired(task));
    // Continuing activity must not keep old dialogue relevant indefinitely.
    // CAD facts live solely in CAD and are never subject to this cache TTL.
    record.turns = record.turns.filter((turn) => this.now() - turn.recordedAt <= this.limits.ttlMs);
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
