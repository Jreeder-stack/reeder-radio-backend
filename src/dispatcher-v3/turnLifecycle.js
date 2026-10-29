import { AsyncLocalStorage } from 'node:async_hooks';
import { isV3TurnIdentity, isV3TurnEnvelope } from './turnEnvelope.js';
import { DispatcherV3Error, V3_ERROR_CODES } from './errors.js';

// 01-05. Trusted turn ownership, not a callsign or client-supplied task ID.
const scope = new AsyncLocalStorage();
const fail = (message, details = {}) => new DispatcherV3Error(
  V3_ERROR_CODES.TURN_STALE, message, { statusCode: 409, details });
export class V3TurnLifecycle {
  constructor({ getGeneration, validator = async () => true, now = () => Date.now() } = {}) {
    this.getGeneration = getGeneration;
    this.validator = validator;
    this.now = now;
    this.turns = new Map();
  }
  accept(identity, source) {
    if (!isV3TurnIdentity(identity) || identity.runtimeGeneration !== this.getGeneration()) {
      throw fail('Turn belongs to another runtime generation');
    }
    const controller = new AbortController();
    const state = {
      identity, source, controller, signal: controller.signal,
      envelope: null, pending: null, pendingOwner: null, pendingIsCurrent: null,
      canceled: false, reason: null, terminal: false,
      inFlightWrites: new Set(), writeCount: 0, pendingVerification: 0,
    };
    this.turns.set(identity.turnId, state);
    return state;
  }
  complete(state, envelope) {
    if (!isV3TurnEnvelope(envelope) || envelope.identity !== state.identity) throw fail('Turn envelope mismatch');
    this.assert(state);
    state.envelope = envelope;
  }
  get(turnId) { return this.turns.get(turnId) || null; }
  assert(state) {
    if (!state || state.terminal || state.canceled || state.signal.aborted
        || state.identity.runtimeGeneration !== this.getGeneration()) {
      throw fail('Old or canceled dispatcher turn cannot continue', {
        reason: state?.reason || 'generation_changed',
        possibleUnconfirmedWrite: !!(state?.inFlightWrites.size || state?.pendingVerification),
      });
    }
    if (state.pending && (!state.pendingIsCurrent?.(state.pendingOwner, state.pending) ||
        state.pending.expiresAt < this.now())) {
      this.cancel(state, 'pending_reply_expired_or_superseded');
      throw fail('Pending reply no longer belongs to this task');
    }
    return state;
  }
  bindPending(state, unitId, pending, isCurrent) {
    this.assert(state);
    state.pending = pending;
    state.pendingOwner = unitId;
    state.pendingIsCurrent = isCurrent;
  }
  releasePending(state) {
    this.assert(state);
    state.pending = null;
    state.pendingOwner = null;
    state.pendingIsCurrent = null;
  }
  async authorize(state) {
    this.assert(state);
    const allowed = await this.validator(state.source, state.identity);
    this.assert(state);
    if (!allowed) {
      this.cancel(state, 'actor_or_channel_grant_revoked');
      throw new DispatcherV3Error(V3_ERROR_CODES.UNAUTHORIZED,
        'PTT actor or channel permission is no longer valid', { statusCode: 403 });
    }
  }
  submitted(state, method) {
    this.assert(state);
    if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) return null;
    const token = Symbol('submitted CAD write');
    state.inFlightWrites.add(token);
    state.writeCount += 1;
    state.pendingVerification += 1;
    return token;
  }
  responded(state, token) {
    if (token) state.inFlightWrites.delete(token);
    // A transport acknowledgment is not independent CAD read-back verification.
  }
  cancel(state, reason = 'superseded') {
    if (!state || state.canceled || state.terminal) return null;
    state.canceled = true;
    state.reason = reason;
    const outcome = {
      reason,
      submittedWrites: state.writeCount,
      possibleUnconfirmedWrite: state.inFlightWrites.size > 0 || state.pendingVerification > 0,
      disposition: state.writeCount ? 'submitted_reconciliation_required' : 'not_submitted',
    };
    state.controller.abort();
    return outcome;
  }
  cancelById(turnId, reason = 'explicit_supersession') {
    return this.cancel(this.turns.get(turnId), reason);
  }
  retire(state) {
    if (!state || state.terminal) return;
    state.terminal = true;
    state.controller.abort();
    this.turns.delete(state.identity.turnId);
  }
  invalidateAll(reason = 'runtime_stopped') {
    for (const state of [...this.turns.values()]) {
      this.cancel(state, reason);
      this.retire(state);
    }
  }
}
export function runWithV3Life(state, fn) { return scope.run(state, fn); }
export function currentV3Life() { return scope.getStore() || null; }
export function assertV3Life() {
  const state = currentV3Life();
  if (state) state.owner.assert(state);
  return state;
}
export async function authorizeV3Life() {
  const state = assertV3Life();
  if (state) await state.owner.authorize(state);
}
export function noteV3CadSubmitted(method) {
  const state = assertV3Life();
  return state ? { state, token: state.owner.submitted(state, method) } : null;
}
export function noteV3CadResponded(write) {
  if (write) write.state.owner.responded(write.state, write.token);
}
