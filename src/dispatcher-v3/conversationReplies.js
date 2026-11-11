// AI-DISP-V3-001 / 04-01. Grounded, non-CAD radio dialogue within V3.
// The model can select a conversational act, never arbitrary spoken claims,
// identity, a CAD mutation, or emergency activation.
import { DispatcherV3Error, V3_ERROR_CODES } from './errors.js';

export const V3_CONVERSATION_ACTS = Object.freeze([
  'presence', 'acknowledgement', 'identity', 'channel',
  'capabilities', 'request_details', 'standby',
]);
const KNOWN = new Set(V3_CONVERSATION_ACTS);
const bounded = (value, max) => String(value ?? '').trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max);

export function normalizeV3ConversationAct(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || !KNOWN.has(value)) {
    throw new DispatcherV3Error(V3_ERROR_CODES.INVALID_ACTION_INPUT,
      'The conversational response type is not supported', {
        statusCode: 400, details: { reason: 'invalid_conversation_act' },
      });
  }
  return value;
}

// Only trusted runtime context supplies the recipient and channel. The
// output does not repeat model text, CAD notes, permissions or claimed writes.
// Natural variation and more complete grounded answers remain 04-02.
export function composeV3ConversationReply({ act, speakerCallsign, channelName = null } = {}) {
  if (!KNOWN.has(act)) return null;
  const unit = bounded(speakerCallsign, 50) || 'unit';
  const channel = bounded(channelName, 64);
  const statements = {
    presence: 'Central here. Go ahead.',
    acknowledgement: 'Copy.',
    identity: 'This is the automated dispatcher. Go ahead.',
    channel: channel ? 'You are on ' + channel + '.' : 'I am receiving you on this channel.',
    capabilities: 'I can help with supported radio and CAD requests when authorized. Go ahead.',
    request_details: 'Go ahead with the request or detail you need.',
    standby: 'Standing by for your next transmission.',
  };
  return (unit + ', ' + statements[act]).slice(0, 210);
}
