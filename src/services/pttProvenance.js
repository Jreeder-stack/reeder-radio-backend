import { createHmac, randomBytes, randomUUID } from 'crypto';
import pool, { getRadioByToken } from '../db/index.js';
import { canonicalChannelKey } from './channelKeyUtils.js';

// Trust lives in this process, never in a request's JSON or a boolean flag.
const principals = new WeakSet();
const transmissions = new WeakSet();
const transmissionRoots = new WeakMap();
const endedTransmissions = new WeakMap();
const eventMetadata = new WeakMap();
const boundTransmissions = new WeakMap();
const clientRequestIds = new WeakMap();
const clientRequestKeys = new WeakMap();
const recentRequests = new Map();
const REQUEST_RETENTION_MS = 10 * 60 * 1000;
const MAX_RECENT_REQUESTS = 2048;
const connectionSecret = randomBytes(32);

const clean = (value) => value == null ? '' : String(value).trim();

function opaqueConnection(kind, credential, accountId) {
  return `${kind}:${createHmac('sha256', connectionSecret)
    .update(JSON.stringify([credential, String(accountId)])).digest('hex')}`;
}

async function accountPrincipal(accountId, credentialType, connectionId) {
  if (accountId == null || !clean(connectionId)) return null;
  const result = await pool.query(
    `SELECT id, username, unit_id, role, is_dispatcher, status
       FROM users WHERE id = $1 AND status = 'active'`, [accountId],
  );
  if (result.rows.length !== 1) return null;
  const account = result.rows[0];
  if (account.status !== 'active') return null;
  const unitId = clean(account.unit_id) || clean(account.username);
  if (!unitId) return null;
  const access = await pool.query(
    `SELECT ch.id AS channel_id, ch.name AS channel_name,
            COALESCE(ch.zone, 'Default') || '__' || ch.name AS room_key
       FROM user_channel_access uca
       JOIN channels ch ON ch.id = uca.channel_id
      WHERE uca.user_id = $1 AND ch.enabled = TRUE
      ORDER BY ch.id`, [account.id],
  );
  const channelGrants = access.rows.map((row) => Object.freeze({
    channelId: clean(row.channel_id),
    channelName: clean(row.channel_name),
    roomKey: canonicalChannelKey(row.room_key),
  })).filter((grant) => grant.channelId && grant.roomKey);
  const principal = Object.freeze({
    accountId: clean(account.id), unitId, username: clean(account.username),
    connectionId: clean(connectionId), credentialType,
    channelGrants: Object.freeze(channelGrants),
  });
  principals.add(principal);
  return principal;
}

/** The caller obtains sessionId from Express or verifies the signed cookie. */
export async function loadSessionPttPrincipal(sessionId, { connectionId } = {}) {
  if (!clean(sessionId)) return null;
  const result = await pool.query(
    'SELECT sess FROM session WHERE sid = $1 AND expire > NOW()', [sessionId],
  );
  if (result.rows.length !== 1) return null;
  let session = result.rows[0].sess;
  if (typeof session === 'string') {
    try { session = JSON.parse(session); } catch (_) { return null; }
  }
  if (session?.user?.id == null) return null;
  return accountPrincipal(session.user.id, 'session',
    connectionId || opaqueConnection('session', sessionId, session.user.id));
}

/** A radio ID or assigned callsign is not a credential. Verify the token here. */
export async function loadRadioPttPrincipal(radioToken, { connectionId } = {}) {
  if (!clean(radioToken)) return null;
  const radio = await getRadioByToken(radioToken);
  if (!radio || radio.is_locked || radio.assigned_unit_id == null) return null;
  return accountPrincipal(radio.assigned_unit_id, 'radio-token',
    connectionId || opaqueConnection('radio', radioToken, radio.assigned_unit_id));
}

/** Recheck ACTIVE account, stable actor, and enabled channel grant at action time.
 * Credentials were verified at intake. No raw secret is retained for later replay.
 */
export async function revalidatePttActor(transmission, binding) {
  if (!isTrustedPttTransmission(transmission) || !isTrustedPttPrincipal(transmission.principal)) return false;
  const previous = transmission.principal;
  const fresh = await accountPrincipal(previous.accountId, previous.credentialType, previous.connectionId);
  if (!fresh || fresh.accountId !== previous.accountId || fresh.unitId !== previous.unitId
      || fresh.connectionId !== previous.connectionId) return false;
  const grant = matchPttChannelGrant(fresh, binding?.channelId);
  return !!grant && grant.channelId === String(binding?.channelId) && grant.roomKey === binding?.roomKey
    && binding?.dispatchCenterId === transmission.binding?.dispatchCenterId
    && binding?.profileId === transmission.binding?.profileId;
}

export function isTrustedPttPrincipal(principal) {
  return !!principal && principals.has(principal);
}

/** A unique account grant is necessary; the runtime also binds configured center. */
export function matchPttChannelGrant(principal, channel) {
  if (!isTrustedPttPrincipal(principal)) return null;
  const key = canonicalChannelKey(channel);
  if (!key) return null;
  const matches = principal.channelGrants.filter((grant) => (
    grant.channelId === key || grant.roomKey === key || grant.channelName === key
  ));
  return matches.length === 1 ? matches[0] : null;
}

function requestIdValue(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null;
}

function requestKey(principal, channel, requestId) {
  const grant = matchPttChannelGrant(principal, channel);
  const id = requestIdValue(requestId);
  return grant && id ? JSON.stringify([principal.accountId, principal.connectionId, grant.channelId, id]) : null;
}

function pruneRequests(now) {
  for (const [key, entry] of recentRequests) {
    if (now - entry.at >= REQUEST_RETENTION_MS) recentRequests.delete(key);
  }
  while (recentRequests.size > MAX_RECENT_REQUESTS) recentRequests.delete(recentRequests.keys().next().value);
}

/** Optional existing client IDs are hints only, scoped to proven owner/channel. */
export function findPttRequest(principal, channelId, clientRequestId) {
  pruneRequests(Date.now());
  const key = requestKey(principal, channelId, clientRequestId);
  return key ? recentRequests.get(key)?.transmission || null : null;
}

export function pttRequestMatches(transmission, clientRequestId) {
  if (clientRequestId == null || clientRequestId === '') return true;
  if (!isTrustedPttTransmission(transmission)) return false;
  return requestIdValue(clientRequestId) != null
    && clientRequestIds.get(transmissionRoots.get(transmission)) === clientRequestId;
}

/** Remove a compatibility attempt that the runtime did not accept. */
export function discardPttRequest(transmission) {
  if (!isTrustedPttTransmission(transmission)) return;
  const root = transmissionRoots.get(transmission);
  const key = clientRequestKeys.get(root);
  if (key && recentRequests.get(key)?.transmission === root) recentRequests.delete(key);
}

export function createPttTransmission(principal, { channelId, source, captureStartedAt = Date.now(), clientRequestId = null } = {}) {
  const grant = matchPttChannelGrant(principal, channelId);
  if (!grant || !Number.isFinite(captureStartedAt)) return null;
  const transmission = Object.freeze({
    transmissionId: randomUUID(), principal, channelId: grant.channelId,
    roomKey: grant.roomKey, source: clean(source) || 'signaling', captureStartedAt,
  });
  transmissions.add(transmission);
  transmissionRoots.set(transmission, transmission);
  const key = requestKey(principal, grant.channelId, clientRequestId);
  if (key) {
    clientRequestIds.set(transmission, clientRequestId);
    clientRequestKeys.set(transmission, key);
    recentRequests.set(key, { transmission, at: Date.now() });
    pruneRequests(Date.now());
  }
  return transmission;
}

export function isTrustedPttTransmission(transmission) {
  return !!transmission && transmissions.has(transmission);
}

export function samePttTransmission(a, b) {
  return isTrustedPttTransmission(a) && isTrustedPttTransmission(b)
    && transmissionRoots.get(a) === transmissionRoots.get(b);
}

export function hasEndedPttTransmission(transmission) {
  return isTrustedPttTransmission(transmission)
    && endedTransmissions.has(transmissionRoots.get(transmission));
}

/** Called only by the manager after resolving the complete configured mapping. */
export function bindPttTransmission(transmission, { channelId, roomKey, dispatchCenterId, profileId } = {}) {
  if (!isTrustedPttTransmission(transmission)) return null;
  const grant = matchPttChannelGrant(transmission.principal, channelId);
  const binding = {
    channelId: clean(channelId), roomKey: canonicalChannelKey(roomKey),
    dispatchCenterId: clean(dispatchCenterId), profileId: clean(profileId),
  };
  if (!grant || grant.channelId !== binding.channelId || grant.roomKey !== binding.roomKey
      || !binding.dispatchCenterId || !binding.profileId || transmission.channelId !== binding.channelId) return null;
  const key = JSON.stringify(binding);
  const cached = boundTransmissions.get(transmission);
  if (cached) return cached.key === key ? cached.value : null;
  if (transmission.binding) return JSON.stringify(transmission.binding) === key ? transmission : null;
  const value = Object.freeze({ ...transmission, binding: Object.freeze(binding) });
  transmissions.add(value);
  transmissionRoots.set(value, transmissionRoots.get(transmission));
  boundTransmissions.set(transmission, { key, value });
  return value;
}

export function finishPttTransmission(transmission, captureEndedAt = Date.now()) {
  if (!isTrustedPttTransmission(transmission) || !Number.isFinite(captureEndedAt)) return null;
  const root = transmissionRoots.get(transmission);
  if (endedTransmissions.has(root)) return endedTransmissions.get(root);
  if (captureEndedAt < root.captureStartedAt) return null;
  const ended = Object.freeze({ ...root, captureEndedAt });
  transmissions.add(ended);
  transmissionRoots.set(ended, root);
  endedTransmissions.set(root, ended);
  return ended;
}

// Event payloads remain wire-compatible: metadata is not enumerable or serialized.
export function attachPttMetadata(event, transmission) {
  if (event && typeof event === 'object' && isTrustedPttTransmission(transmission)) {
    eventMetadata.set(event, transmission);
  }
  return event;
}

export function getPttMetadata(event) {
  return event && typeof event === 'object' ? eventMetadata.get(event) || null : null;
}

export function ownsPttTransmission(transmission, principal) {
  return isTrustedPttTransmission(transmission) && isTrustedPttPrincipal(principal)
    && transmission.principal.accountId === principal.accountId
    && transmission.principal.connectionId === principal.connectionId;
}
