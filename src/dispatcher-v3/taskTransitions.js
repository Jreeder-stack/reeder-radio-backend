// AI-DISP-V3-001 / 02-04. Radio task controls are dialogue transitions,
// not CAD commands or authorization. Complete utterance matches avoid treating
// a quoted cancellation, disposition or incident narrative as a command.
const clean = (value) => String(value ?? '').trim().replace(/\s+/g, ' ').replace(/[.!]+$/, '').trim();

export function classifyV3TaskTransition(transcript) {
  const text = clean(transcript);
  if (!text) return null;
  if (/^(?:disregard (?:that|it|the (?:previous|last) request|my (?:last|previous) request)|never\s?mind|scratch that|forget (?:that|it|my (?:last|previous) request)|cancel (?:that|it|the (?:pending|previous|last) request|my (?:last|previous) request)|withdraw (?:that|my request)|stop (?:that|the (?:pending|previous) request)|start over)$/i.test(text)) {
    return { kind: 'cancel' };
  }
  const correction = text.match(/^(?:correction|scratch that,?\s*instead|no,?\s+i meant|i meant|actually,?\s+i meant)(?:\s*[:,]?\s+(.+))?$/i);
  if (correction) return { kind: 'correct', revisedRequest: clean(correction[1]) || null };
  const topic = text.match(/^(?:new topic|different topic|change (?:the )?subject|switch topics|new request|different question)(?:\s*[:,]\s*(.+))?$/i);
  if (topic) return { kind: 'topic', revisedRequest: clean(topic[1]) || null };
  const resume = text.match(/^(?:resume|continue|return to|(?:go |let's go )?back to)\s+(?:(?:my|the|our)\s+)?(?:(?:previous|earlier|last)\s+)?(incident|report|disposition|clarification|assignment|request|task|conversation|question)(?:\s+please)?$/i);
  if (resume) return { kind: 'resume', selector: resume[1].toLowerCase() };
  return null;
}

// A model may identify a less literal expression, but it cannot choose an
// owner/task ID, perform a mutation, clear hardware emergency, or declare an
// already submitted CAD action rolled back.
export function modelV3TaskTransition(plan) {
  const actions = { CANCEL_TASK: 'cancel', NEW_TOPIC: 'topic', RESUME_TASK: 'resume', CORRECT_TASK: 'correct' };
  const kind = actions[plan?.action];
  if (!kind) return null;
  const revisedRequest = clean(plan?.input?.revisedRequest).slice(0, 240) || null;
  const selector = clean(plan?.input?.topic).toLowerCase().slice(0, 32) || null;
  return { kind, revisedRequest, selector };
}
