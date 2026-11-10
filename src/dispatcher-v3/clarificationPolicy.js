// AI-DISP-V3-001 04-03. Task-owned clarification and finite recovery.
export const V3_MAX_CLARIFICATION_PROMPTS = 3;
const safe = (value, size=120) => String(value ?? '').trim().replace(/\s+/g,' ').slice(0,size);
const QUESTIONS = Object.freeze({
  callId: 'Which call? Give its call number or identifying location.',
  callRef: 'Which call? Give its call number or identifying location.',
  unitRef: 'Which unit? Repeat the complete callsign.',
  location: 'What is the exact location?',
  type: 'What is the type of call?',
  zone: 'Which zone?',
  disposition: 'What is the disposition?',
  note: 'What information should be recorded in the note?',
  status: 'What status should be recorded?',
  informationType: 'Which incident detail are you updating?',
  value: 'Repeat the missing detail.',
});
const VAGUE = /^(?:repeat(?: your)?(?: last)?(?: request)?|which one|what do you mean|clarify|please clarify|can you repeat|could you repeat|what(?:'s| is) that)\??[.!]?$/i;
const HESITATION = /^(?:uh+|um+|hmm+|hold on|one moment|stand by|standby|wait|not sure|i don't know|let me check)[.! ]*$/i;

export function clarificationQuestion(pending, proposed, callsign, transcript='') {
  const question = QUESTIONS[pending?.unresolvedField];
  if (!question) return safe(proposed,180) || 'Please repeat the missing detail.';
  const name = safe(callsign,36);
  if (HESITATION.test(safe(transcript,180))) return (name ? name+', ' : '') + question;
  const text = safe(proposed,180);
  if (text && !VAGUE.test(text) && /\?/.test(text) && !/Which one did you mean/i.test(text)) return text;
  return (name ? name+', ' : '') + question;
}

export function clarificationTerminal(pending, callsign, submittedWrites=0) {
  const unit = safe(callsign,36) || 'Unit';
  const subject = pending?.unresolvedField === 'callId' || pending?.unresolvedField === 'callRef'
    ? 'the call' : pending?.unresolvedField === 'unitRef' ? 'the unit'
    : 'the needed detail';
  const writes = submittedWrites > 0
    ? 'An earlier CAD change may be unverified. Confirm it before repeating.'
    : 'No new CAD change was confirmed for this request.';
  return unit+', I still cannot confirm '+subject+'. '+writes+
    ' Give Central a new complete request or contact a human dispatcher.';
}
