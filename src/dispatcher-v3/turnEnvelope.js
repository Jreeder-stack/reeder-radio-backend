import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { isTrustedPttTransmission, matchPttChannelGrant, samePttTransmission } from '../services/pttProvenance.js';
import { DispatcherV3Error, V3_ERROR_CODES } from './errors.js';

const identities = new WeakMap();
const envelopes = new WeakSet();
const turnScope = new AsyncLocalStorage();

const clean = (value) => String(value ?? '').trim();
const sameUnit = (left, right) => clean(left).toUpperCase() === clean(right).toUpperCase();

/** Transport claims are never authority. Only a credential-backed, configured binding is accepted. */
export function pttBelongsToV3Runtime(transmission, context, channelId, unitId) {
  if (!isTrustedPttTransmission(transmission)) return false;
  const { binding, principal } = transmission;
  const grant = matchPttChannelGrant(principal, context?.channelId);
  if (!binding || !grant || !sameUnit(unitId, principal.unitId)) return false;
  return binding.profileId === context.profileId
    && binding.dispatchCenterId === context.dispatchCenterId
    && binding.channelId === String(context.channelId)
    && binding.roomKey === context.roomKey
    && grant.channelId === binding.channelId && grant.roomKey === binding.roomKey
    && transmission.channelId === binding.channelId && transmission.roomKey === binding.roomKey
    && [binding.channelId, binding.roomKey, context.channelName].filter(Boolean).includes(String(channelId));
}

/** Allocated synchronously at intake, before CAD identity lookup or speech recognition. */
export function createV3TurnIdentity({ runtimeContext, runtimeGeneration, intakeSequence, transmission }) {
  if (!pttBelongsToV3Runtime(transmission, runtimeContext, transmission?.roomKey, transmission?.principal?.unitId)
      || !clean(runtimeGeneration) || !Number.isSafeInteger(intakeSequence) || intakeSequence < 1) {
    throw unauthorized('PTT intake has no trusted runtime ownership');
  }
  const identity = Object.freeze({
    turnId: randomUUID(),
    runtimeId: runtimeContext.runtimeId,
    profileId: runtimeContext.profileId,
    runtimeGeneration,
    dispatchCenterId: runtimeContext.dispatchCenterId,
    channelId: String(runtimeContext.channelId),
    roomKey: runtimeContext.roomKey,
    intakeSequence,
    transmissionId: transmission.transmissionId,
    accountId: transmission.principal.accountId,
    connectionId: transmission.principal.connectionId,
    credentialType: transmission.principal.credentialType,
    speakerRef: transmission.principal.unitId,
    source: transmission.source,
    captureStartedAt: transmission.captureStartedAt,
  });
  identities.set(identity, transmission);
  return identity;
}

/** Capture completion adds facts once; it never changes the frozen intake identity. */
export function completeV3TurnEnvelope(identity, transmission, speaker = null) {
  const start = identities.get(identity);
  if (!start || !samePttTransmission(start, transmission)
      || !Number.isFinite(transmission.captureEndedAt)
      || transmission.captureEndedAt < identity.captureStartedAt) {
    throw unauthorized('PTT completion does not own this turn');
  }
  if (speaker && (!clean(speaker.unitId) || !clean(speaker.callsign)
      || speaker.dispatchCenterId !== identity.dispatchCenterId)) {
    throw unauthorized('PTT speaker does not resolve in the bound dispatch center');
  }
  const resolvedSpeaker = speaker ? Object.freeze({
    unitId: clean(speaker.unitId), callsign: clean(speaker.callsign),
    agencyId: clean(speaker.agencyId) || null,
    dispatchCenterId: speaker.dispatchCenterId,
  }) : null;
  const envelope = Object.freeze({
    ...identity, identity,
    speaker: resolvedSpeaker,
    captureEndedAt: transmission.captureEndedAt,
  });
  envelopes.add(envelope);
  return envelope;
}

export function isV3TurnIdentity(value) { return !!value && identities.has(value); }
export function isV3TurnEnvelope(value) { return !!value && envelopes.has(value); }

export function assertV3TurnEnvelope(envelope, context) {
  if (!isV3TurnEnvelope(envelope) || !envelope.speaker
      || envelope.runtimeId !== context?.runtimeId
      || envelope.profileId !== context?.profileId
      || envelope.dispatchCenterId !== context?.dispatchCenterId
      || envelope.channelId !== String(context?.channelId)
      || envelope.roomKey !== context?.roomKey
      || envelope.speaker.dispatchCenterId !== context?.dispatchCenterId) {
    throw unauthorized('A trusted, center-resolved speaker is required for a voice action');
  }
  // Recording generation here is intentional. Cancellation/current-generation
  // revalidation after every asynchronous boundary belongs to work item 01-05.
  return envelope;
}

export function runWithV3Turn(envelope, operation) {
  if (!isV3TurnEnvelope(envelope)) throw unauthorized('Untrusted turn context');
  return turnScope.run(envelope, operation);
}

export function currentV3TurnEnvelope() { return turnScope.getStore() || null; }

function unauthorized(message) {
  return new DispatcherV3Error(V3_ERROR_CODES.UNAUTHORIZED, message, { statusCode: 403 });
}
