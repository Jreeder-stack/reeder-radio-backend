// AI-DISP-V3-001 / 02-07. Bounded, authenticated connection leases only.
// Conversation/task content remains in V3ConversationRecords, never here.
const DEFAULT_MAX_OWNERS = 1024;
const DEFAULT_MAX_REPLACEMENTS = 8;
const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const valid = (value) => typeof value === 'string' && value.trim().length > 0;
const limit = (value, fallback) => Number.isSafeInteger(value) && value > 0 ? value : fallback;

export class V3ConnectionCustody {
  constructor({ now = () => Date.now(), maxOwners = DEFAULT_MAX_OWNERS,
    maxReplacements = DEFAULT_MAX_REPLACEMENTS, leaseMs = DEFAULT_LEASE_MS } = {}) {
    this.now = now;
    this.maxOwners = limit(maxOwners, DEFAULT_MAX_OWNERS);
    this.maxReplacements = limit(maxReplacements, DEFAULT_MAX_REPLACEMENTS);
    this.leaseMs = limit(leaseMs, DEFAULT_LEASE_MS);
    this.owners = new Map();
  }

  key(identity) {
    if (!identity || ![
      'runtimeId', 'runtimeGeneration', 'dispatchCenterId', 'speakerRef',
      'accountId', 'credentialType', 'connectionId',
    ].every((field) => valid(identity[field]))) return null;
    return JSON.stringify([
      identity.runtimeId, identity.runtimeGeneration, identity.dispatchCenterId,
      identity.speakerRef, identity.accountId, identity.credentialType,
    ]);
  }

  _prune() {
    const now = this.now();
    for (const [key, entry] of this.owners) {
      // A replacement tombstone must outlive a short dialogue idle lease.
      // Otherwise an older credential could reclaim the same actor after 5m.
      if (!entry.retired.size && now - entry.lastAt > this.leaseMs) this.owners.delete(key);
    }
  }

  isRetired(identity) {
    const key = this.key(identity);
    if (!key) return true;
    this._prune();
    return this.owners.get(key)?.retired.has(identity.connectionId) === true;
  }

  currentConnectionId(identity) {
    const key = this.key(identity);
    if (!key) return null;
    this._prune();
    return this.owners.get(key)?.connectionId || null;
  }

  admit(identity, { preserveExisting = false } = {}) {
    const key = this.key(identity);
    if (!key) return { accepted: false, reason: 'missing_session_identity' };
    this._prune();
    const current = this.owners.get(key);
    if (!current) {
      if (this.owners.size >= this.maxOwners) return { accepted: false, reason: 'session_capacity' };
      this.owners.set(key, {
        connectionId: identity.connectionId, previousConnectionId: null,
        retired: new Set(), siblings: new Set(), lastAt: this.now(),
      });
      return { accepted: true, previousConnectionId: null };
    }
    if (current.retired.has(identity.connectionId)) {
      return { accepted: false, reason: 'replaced_session' };
    }
    if (current.connectionId === identity.connectionId || current.siblings.has(identity.connectionId)) {
      current.lastAt = this.now();
      return { accepted: true, previousConnectionId: null };
    }
    // Simultaneously connected, center-authorized radios/phones are siblings,
    // NOT replacement sessions. Each keeps its own conversation custody.
    if (preserveExisting) {
      if (current.siblings.size >= this.maxReplacements) {
        return { accepted: false, reason: 'session_sibling_capacity' };
      }
      current.siblings.add(identity.connectionId);
      current.lastAt = this.now();
      return { accepted: true, previousConnectionId: null };
    }
    // Never evict a retired session while a live lease could authorize it again.
    if (current.retired.size >= this.maxReplacements) {
      return { accepted: false, reason: 'session_replacement_capacity' };
    }
    const previousConnectionId = current.connectionId;
    current.retired.add(previousConnectionId);
    current.connectionId = identity.connectionId;
    current.previousConnectionId = previousConnectionId;
    current.lastAt = this.now();
    return { accepted: true, previousConnectionId };
  }

  isCurrent(identity) {
    const key = this.key(identity);
    if (!key) return false;
    this._prune();
    const current = this.owners.get(key);
    return !!current && (current.connectionId === identity.connectionId
      || current.siblings.has(identity.connectionId))
      && !current.retired.has(identity.connectionId);
  }

  previousFor(identity) {
    if (!this.isCurrent(identity)) return null;
    const entry = this.owners.get(this.key(identity));
    return entry?.connectionId === identity.connectionId ? entry.previousConnectionId : null;
  }

  clearAll() { this.owners.clear(); }
}
