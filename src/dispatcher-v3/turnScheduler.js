// AI-DISP-V3-001 / 01-03. Admission is synchronous at trusted PTT intake.
// Limits are shared by V3 runtime instances within this Node process.
export const V3_SCHEDULER_LIMITS = Object.freeze({
  maxResident: 64, maxPerUnit: 8, maxPreparing: 8, maxExecuting: 4,
  maxQueueWaitMs: 30000, maxCaptureMs: 90000,
});
const shared = {
  resident: 0, preparing: 0, executing: 0,
  waiting: { preparing: [], executing: [] },
};
function lease(kind, ticket, limit) {
  if (ticket.terminal) return Promise.resolve(null);
  if (shared[kind] < limit) {
    shared[kind] += 1;
    return Promise.resolve(() => release(kind));
  }
  return new Promise((resolve) => shared.waiting[kind].push({ ticket, resolve, limit }));
}
function release(kind) {
  shared[kind] -= 1;
  const waiters = shared.waiting[kind];
  while (waiters.length) {
    const item = waiters.shift();
    if (item.ticket.terminal) { item.resolve(null); continue; }
    if (shared[kind] >= item.limit) { waiters.unshift(item); break; }
    shared[kind] += 1;
    item.resolve(() => release(kind));
    break;
  }
}
function removeWaiters(ticket) {
  for (const kind of ['preparing', 'executing']) {
    const retained = [];
    for (const item of shared.waiting[kind]) {
      if (item.ticket === ticket) item.resolve(null);
      else retained.push(item);
    }
    shared.waiting[kind] = retained;
  }
}
function positiveInt(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
export class V3TurnScheduler {
  constructor({ limits = {}, onTerminal = () => {} } = {}) {
    this.limits = Object.freeze(Object.fromEntries(
      Object.entries(V3_SCHEDULER_LIMITS).map(([key, value]) => [key, positiveInt(limits[key], value)]),
    ));
    this.onTerminal = onTerminal;
    this.units = new Map();
    this.tickets = new Set();
    this.stopped = false;
    this.rejections = 0;
  }
  start() { this.stopped = false; }
  status() {
    return {
      resident: this.tickets.size,
      preparing: [...this.tickets].filter((ticket) => ticket.preparing).length,
      executing: [...this.tickets].filter((ticket) => ticket.executing).length,
      globalResident: shared.resident, globalPreparing: shared.preparing,
      globalExecuting: shared.executing, rejected: this.rejections,
      limits: this.limits,
    };
  }
  reserve(identity) {
    if (this.stopped || !identity?.turnId || !identity.dispatchCenterId || !identity.speakerRef) {
      return { accepted: false, reason: 'invalid_intake' };
    }
    const unitKey = identity.dispatchCenterId + ':' + String(identity.speakerRef).trim().toUpperCase();
    const queue = this.units.get(unitKey) || [];
    if (shared.resident >= this.limits.maxResident || queue.length >= this.limits.maxPerUnit) {
      this.rejections += 1;
      return { accepted: false, reason: 'scheduler_overloaded' };
    }
    let resolveCompletion;
    const completion = new Promise((resolve) => { resolveCompletion = resolve; });
    const ticket = {
      identity, unitKey, completion, resolveCompletion,
      terminal: false, ended: false, ready: false, preparing: false, executing: false,
      processQueued: false, released: false, outcome: null, timer: null, value: null,
    };
    shared.resident += 1;
    this.tickets.add(ticket);
    queue.push(ticket);
    this.units.set(unitKey, queue);
    ticket.timer = setTimeout(() => this._retire(ticket, 'capture_expired'), this.limits.maxCaptureMs);
    ticket.timer.unref?.();
    return { accepted: true, ticket };
  }
  complete(ticket, prepare, execute) {
    if (!this.tickets.has(ticket) || ticket.terminal || ticket.ended) {
      return Promise.resolve({ handled: false, reason: 'not_reserved' });
    }
    ticket.ended = true;
    clearTimeout(ticket.timer);
    ticket.deadline = Date.now() + this.limits.maxQueueWaitMs;
    ticket.timer = setTimeout(() => {
      if (!ticket.executing) this._retire(ticket, 'queue_expired');
    }, this.limits.maxQueueWaitMs);
    ticket.timer.unref?.();
    void this._prepare(ticket, prepare, execute);
    return ticket.completion;
  }
  async _prepare(ticket, prepare, execute) {
    const releaseLease = await lease('preparing', ticket, this.limits.maxPreparing);
    if (!releaseLease) return;
    ticket.preparing = true;
    try {
      const value = await prepare();
      if (ticket.terminal) return;
      if (!value?.transcript) {
        this._retire(ticket, 'empty_or_unresolved');
        return;
      }
      ticket.value = value;
      ticket.ready = true;
      ticket.execute = execute;
      this._pump(ticket.unitKey);
    } catch (error) {
      if (!ticket.terminal) this._retire(ticket, 'preparation_failed', false, error?.code || 'PREPARATION_ERROR');
    } finally {
      ticket.preparing = false;
      releaseLease();
      this._releaseResident(ticket);
    }
  }
  _pump(key) {
    const queue = this.units.get(key);
    const ticket = queue?.[0];
    if (!ticket || ticket.terminal || !ticket.ready || ticket.processQueued || this.stopped) return;
    ticket.processQueued = true;
    void this._execute(ticket);
  }
  async _execute(ticket) {
    const releaseLease = await lease('executing', ticket, this.limits.maxExecuting);
    if (!releaseLease) return;
    if (ticket.terminal || this.stopped) {
      releaseLease();
      return;
    }
    // Check both queue ownership and the deadline AFTER the global lease.
    if (this.units.get(ticket.unitKey)?.[0] !== ticket || Date.now() >= ticket.deadline) {
      this._retire(ticket, 'queue_expired');
      releaseLease();
      return;
    }
    ticket.executing = true;
    clearTimeout(ticket.timer);
    try {
      const result = await ticket.execute(ticket.value);
      if (!ticket.terminal) this._retire(ticket, result ? 'processed' : 'not_addressed', !!result);
    } catch (error) {
      if (!ticket.terminal) this._retire(ticket, 'execution_failed', false, error?.code || 'EXECUTION_ERROR');
    } finally {
      ticket.executing = false;
      releaseLease();
      this._releaseResident(ticket);
    }
  }
  _retire(ticket, reason, handled = false, code = null) {
    if (!ticket || ticket.terminal) return;
    ticket.terminal = true;
    ticket.outcome = { handled, reason, code };
    clearTimeout(ticket.timer);
    removeWaiters(ticket);
    const queue = this.units.get(ticket.unitKey);
    if (queue) {
      const index = queue.indexOf(ticket);
      if (index !== -1) queue.splice(index, 1);
      if (!queue.length) this.units.delete(ticket.unitKey);
    }
    ticket.resolveCompletion(ticket.outcome);
    try { this.onTerminal(ticket, ticket.outcome); } catch (_) {}
    this._releaseResident(ticket);
    this._pump(ticket.unitKey);
  }
  _releaseResident(ticket) {
    if (!ticket.terminal || ticket.preparing || ticket.executing || ticket.released) return;
    ticket.released = true;
    shared.resident -= 1;
    this.tickets.delete(ticket);
  }
  cancel(ticket, reason = 'capture_rejected') { this._retire(ticket, reason); }
  stop() {
    this.stopped = true;
    for (const ticket of [...this.tickets]) this._retire(ticket, 'runtime_stopped');
  }
}
