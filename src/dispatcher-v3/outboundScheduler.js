// AI-DISP-V3-001 / 01-06. Single, bounded outbound lane per dispatcher runtime.
// The caller's CAD execution promise never waits for this delivery lane.
const DEFAULTS = Object.freeze({ maxQueued: 32, maxAgeMs: 20000, maxActiveMs: 22000 });
const statuses = new Set(['completed', 'interrupted', 'expired', 'failed']);
function limit(value, fallback) { return Number.isSafeInteger(value) && value > 0 ? value : fallback; }
export class V3OutboundScheduler {
  constructor({ transmit, relevant, onOutcome = () => {}, now = () => Date.now(), limits = {} } = {}) {
    if (typeof transmit !== 'function' || typeof relevant !== 'function') throw new TypeError('Outbound requires transmitter and relevance check');
    this.transmit = transmit;
    this.relevant = relevant;
    this.onOutcome = onOutcome;
    this.now = now;
    this.limits = Object.freeze(Object.fromEntries(Object.entries(DEFAULTS).map(([key, value]) => [key, limit(limits[key], value)])));
    this.queue = [];
    this.active = null;
    this.running = false;
    this.generation = null;
    this.draining = false;
    this.latest = new Map();
    this.totals = Object.fromEntries(['queued', 'speaking', 'completed', 'interrupted', 'expired', 'failed'].map(k => [k, 0]));
    this.idleWaiters = [];
    this.counter = 0;
  }
  start(generation) {
    if (!generation) throw new TypeError('Outbound runtime generation required');
    if (this.running) return;
    this.running = true;
    this.generation = generation;
  }
  stop() {
    this.running = false;
    this.generation = null;
    if (this.active) this.active.controller.abort();
    for (const entry of this.queue.splice(0)) this._settle(entry, 'interrupted', 'runtime_stopped');
    this.latest.clear();
    this._signalIdle();
  }
  status() {
    return { queued: this.queue.length, speaking: this.active ? 1 : 0,
      generation: this.generation, limits: this.limits, totals: { ...this.totals } };
  }
  enqueue({ text, recipient = null, channel, turnId = null, generation, correlationId = null,
    kind = 'routine', priority = false, envelope = null, source = null } = {}) {
    if (!this.running || generation !== this.generation || !text || !channel) return { accepted: false, reason: 'invalid_or_stale_output' };
    if (this.queue.length >= this.limits.maxQueued) {
      this.totals.failed += 1;
      return { accepted: false, reason: 'outbound_overloaded' };
    }
    const id = ++this.counter, createdAt = this.now();
    let resolve;
    const delivery = new Promise(r => { resolve = r; });
    const entry = { id, text, recipient, channel, turnId, generation, correlationId, kind, priority,
      envelope, source, createdAt, expiresAt: createdAt + this.limits.maxAgeMs,
      controller: new AbortController(), resolve, delivered: false, state: 'queued' };
    this.totals.queued += 1;
    if (kind === 'routine' && recipient) {
      // A newer response from this unit invalidates only undelivered, older
      // routine replies, not unrelated units or their CAD commands.
      this.latest.set(recipient, id);
      for (const queued of [...this.queue]) {
        if (queued.kind === 'routine' && queued.recipient === recipient) {
          this.queue.splice(this.queue.indexOf(queued), 1);
          this._settle(queued, 'expired', 'superseded_by_newer_reply');
        }
      }
    }
    if (priority) {
      this.queue.unshift(entry);
      if (this.active && !this.active.priority) this.active.controller.abort();
    } else this.queue.push(entry);
    // Start the lane without awaiting it. Promise rejections are captured
    // as terminal outcomes; no detached unhandled rejection is possible.
    void this._drain();
    return { accepted: true, id, delivery };
  }
  cancelByTurn(turnId, reason = 'superseded') {
    if (!turnId) return 0;
    let count = 0;
    for (const entry of [...this.queue]) {
      if (entry.turnId !== turnId) continue;
      this.queue.splice(this.queue.indexOf(entry), 1);
      this._settle(entry, 'interrupted', reason);
      count++;
    }
    if (this.active?.turnId === turnId) { this.active.controller.abort(); count++; }
    this._signalIdle();
    return count;
  }
  isRelevant(entry) {
    return this.running && this.generation === entry.generation &&
      !entry.controller.signal.aborted && this.now() < entry.expiresAt &&
      (entry.kind !== 'routine' || !entry.recipient || this.latest.get(entry.recipient) === entry.id) &&
      this.relevant(entry);
  }
  async _drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.running && this.queue.length) {
        const entry = this.queue.shift();
        if (!this.isRelevant(entry)) {
          this._settle(entry, 'expired', 'stale_before_transmission');
          continue;
        }
        this.active = entry;
        entry.state = 'speaking';
        this.totals.speaking += 1;
        const timeout = setTimeout(() => entry.controller.abort(), this.limits.maxActiveMs);
        timeout.unref?.();
        try {
          const successful = await this.transmit(entry, () => {
            if (!this.isRelevant(entry)) throw new Error('OUTBOUND_INTERRUPTED');
          });
          const valid = this.isRelevant(entry);
          this._settle(entry, successful && valid ? 'completed' : (entry.controller.signal.aborted || !valid ? 'interrupted' : 'failed'),
            successful && valid ? null : 'floor_or_transmission_failed');
        } catch (error) {
          this._settle(entry, entry.controller.signal.aborted || !this.isRelevant(entry) ? 'interrupted' : 'failed',
            error?.message || 'transmission_error');
        } finally {
          clearTimeout(timeout);
          this.active = null;
        }
      }
    } finally {
      this.draining = false;
      this._signalIdle();
    }
  }
  _settle(entry, state, reason) {
    if (!statuses.has(state) || entry.delivered) return;
    entry.delivered = true;
    entry.state = state;
    this.totals[state] += 1;
    const result = Object.freeze({ id: entry.id, turnId: entry.turnId, correlationId: entry.correlationId,
      recipient: entry.recipient, channel: entry.channel, kind: entry.kind, status: state,
      reason: reason || null, elapsedMs: Math.max(0, this.now() - entry.createdAt) });
    entry.resolve(result);
    try { this.onOutcome(result, entry); } catch (_) {}
  }
  _signalIdle() {
    if (this.active || this.queue.length || this.draining) return;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }
  whenIdle() {
    if (!this.active && !this.queue.length && !this.draining) return Promise.resolve();
    return new Promise(resolve => this.idleWaiters.push(resolve));
  }
}
