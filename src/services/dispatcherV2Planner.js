import {
  getDispatcherTool,
  getPlannerToolCatalog,
  validateDispatcherToolArguments,
} from './dispatcherToolRegistry.js';
import { AzureOpenAI } from 'openai';

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on', 'enabled']);
const ROUTINE_AI_STATES = new Set([
  'IDLE',
  'AWAITING_COMMAND',
  'AWAITING_CALL_NATURE',
  'AWAITING_CALL_ADDRESS',
  'AWAITING_CALL_CONFIRM',
  'AWAITING_NOTE_CONTENT',
  'AWAITING_CALL_FOLLOWUP',
  'AWAITING_CALL_DISAMBIG',
]);
const CONTROL_ACTIONS = new Set([
  'NO_ACTION',
  'CLARIFY',
  'REPEAT',
  'DISREGARD',
  'CONFIRM',
  'DENY',
]);
const LEGACY_ACTION_TOOL_MAP = new Map([
  ['RADIO_CHECK', 'radio_check'],
  ['TIME_CHECK', 'time_check'],
  ['STATUS_CHANGE', 'update_unit_status'],
  ['STATUS_CHANGE_OTHER', 'update_unit_status'],
  ['CREATE_CALL', 'create_call'],
  ['ASSIGN_CALL', 'assign_unit_to_call'],
  ['ASSIGN_OTHER_UNIT', 'assign_unit_to_call'],
  ['ADD_NOTE', 'add_call_note'],
  ['RUN_PLATE', 'run_plate'],
  ['PERSON_CHECK_DETAILS', 'run_person'],
  ['PERSON_CHECK_DL', 'run_person'],
  ['PERSON_CHECK_SSN', 'run_person'],
  ['QUERY_CALLS', 'query_pending_calls'],
  ['MY_CALL', 'get_unit_assignment'],
  ['CALL_DETAILS', 'get_call_details'],
  ['CLEAR_UNIT', 'clear_unit'],
  ['CLOSE_CALL', 'close_call'],
  ['DISPOSE_CALL', 'close_call'],
  ['CANCEL_CALL', 'cancel_call'],
  ['REQUEST_BACKUP', 'request_backup'],
]);
const SPEAKER_SENTINEL = '__SPEAKER__';
const SPEAKER_DEFAULT_TOOLS = new Set([
  'update_unit_status',
  'assign_unit_to_call',
  'get_unit_assignment',
  'clear_unit',
  'request_backup',
]);
const CONTEXTUAL_MISSING_ALLOWED = new Set([
  'create_call',
  'assign_unit_to_call',
  'run_person',
  'get_call_details',
  'close_call',
  'cancel_call',
]);

const STATE_ABBREVIATIONS = new Map([
  ['ALABAMA', 'AL'], ['ALASKA', 'AK'], ['ARIZONA', 'AZ'], ['ARKANSAS', 'AR'],
  ['CALIFORNIA', 'CA'], ['COLORADO', 'CO'], ['CONNECTICUT', 'CT'], ['DELAWARE', 'DE'],
  ['FLORIDA', 'FL'], ['GEORGIA', 'GA'], ['HAWAII', 'HI'], ['IDAHO', 'ID'],
  ['ILLINOIS', 'IL'], ['INDIANA', 'IN'], ['IOWA', 'IA'], ['KANSAS', 'KS'],
  ['KENTUCKY', 'KY'], ['LOUISIANA', 'LA'], ['MAINE', 'ME'], ['MARYLAND', 'MD'],
  ['MASSACHUSETTS', 'MA'], ['MICHIGAN', 'MI'], ['MINNESOTA', 'MN'], ['MISSISSIPPI', 'MS'],
  ['MISSOURI', 'MO'], ['MONTANA', 'MT'], ['NEBRASKA', 'NE'], ['NEVADA', 'NV'],
  ['NEW HAMPSHIRE', 'NH'], ['NEW JERSEY', 'NJ'], ['NEW MEXICO', 'NM'], ['NEW YORK', 'NY'],
  ['NORTH CAROLINA', 'NC'], ['NORTH DAKOTA', 'ND'], ['OHIO', 'OH'], ['OKLAHOMA', 'OK'],
  ['OREGON', 'OR'], ['PENNSYLVANIA', 'PA'], ['RHODE ISLAND', 'RI'], ['SOUTH CAROLINA', 'SC'],
  ['SOUTH DAKOTA', 'SD'], ['TENNESSEE', 'TN'], ['TEXAS', 'TX'], ['UTAH', 'UT'],
  ['VERMONT', 'VT'], ['VIRGINIA', 'VA'], ['WASHINGTON', 'WA'], ['WEST VIRGINIA', 'WV'],
  ['WISCONSIN', 'WI'], ['WYOMING', 'WY'], ['DISTRICT OF COLUMBIA', 'DC'],
]);

const PROTECTED_EMERGENCY_RX = /\b(officer\s+down|shots?\s+fired|10[-\s/]?33|ten\s+thirty[-\s]?three|emergency\s+traffic|signal\s+100)\b/i;
const DEFAULT_MIN_CONFIDENCE = 0.82;
const DEFAULT_TIMEOUT_MS = 5500;

let client = null;

function cleanString(value, maxLength = 300) {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().replace(/\s+/g, ' ');
  return cleaned ? cleaned.slice(0, maxLength) : null;
}

function normalizeUnit(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '-');
}

function cleanArguments(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const cleaned = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (rawValue === undefined || rawValue === null || rawValue === '') continue;
    if (typeof rawValue === 'string') cleaned[key] = cleanString(rawValue);
    else if (Array.isArray(rawValue)) {
      cleaned[key] = rawValue
        .slice(0, 12)
        .map(item => cleanString(item, 80))
        .filter(Boolean);
    } else if (typeof rawValue === 'number' || typeof rawValue === 'boolean') {
      cleaned[key] = rawValue;
    }
  }

  if (cleaned.status) cleaned.status = String(cleaned.status).toLowerCase().replace(/[\s-]+/g, '_');
  if (cleaned.plate) cleaned.plate = String(cleaned.plate).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (cleaned.state) {
    const stateText = String(cleaned.state).toUpperCase().replace(/[^A-Z ]/g, '').replace(/\s+/g, ' ').trim();
    cleaned.state = STATE_ABBREVIATIONS.get(stateText) || (stateText.length === 2 ? stateText : null);
    if (!cleaned.state) delete cleaned.state;
  }
  if (cleaned.unitId) cleaned.unitId = normalizeUnit(cleaned.unitId);
  if (cleaned.targetUnit) cleaned.targetUnit = normalizeUnit(cleaned.targetUnit);
  if (cleaned.callNumber) cleaned.callNumber = String(cleaned.callNumber).trim();
  if (cleaned.callReference) cleaned.callReference = String(cleaned.callReference).toLowerCase().replace(/[\s-]+/g, '_');
  return cleaned;
}

function getMinConfidence() {
  const configured = Number.parseFloat(process.env.AI_DISPATCHER_V2_MIN_CONFIDENCE || '');
  if (Number.isFinite(configured) && configured >= 0.5 && configured <= 1) return configured;
  return DEFAULT_MIN_CONFIDENCE;
}

function getTimeoutMs() {
  const configured = Number.parseInt(process.env.AI_DISPATCHER_V2_TIMEOUT_MS || '', 10);
  if (Number.isFinite(configured) && configured >= 500 && configured <= 15000) return configured;
  return DEFAULT_TIMEOUT_MS;
}

function getClient() {
  if (!client && isDispatcherV2Configured()) {
    client = new AzureOpenAI({
      apiKey: process.env.AZURE_OPENAI_API_KEY,
      endpoint: process.env.AZURE_OPENAI_ENDPOINT,
      deployment: process.env.AZURE_OPENAI_DEPLOYMENT,
      apiVersion: '2024-08-01-preview',
    });
  }
  return client;
}

export function isDispatcherV2Enabled() {
  return TRUE_VALUES.has(String(process.env.AI_DISPATCHER_V2_ENABLED || '').trim().toLowerCase());
}

export function isDispatcherV2Configured() {
  return Boolean(
    process.env.AZURE_OPENAI_API_KEY
    && process.env.AZURE_OPENAI_ENDPOINT
    && process.env.AZURE_OPENAI_DEPLOYMENT
  );
}

export function shouldUseDispatcherV2(currentState = 'IDLE') {
  return isDispatcherV2Enabled() && ROUTINE_AI_STATES.has(String(currentState || '').toUpperCase());
}

export function containsProtectedEmergencyTraffic(transcript) {
  return PROTECTED_EMERGENCY_RX.test(String(transcript || ''));
}

function callIdentifier(call) {
  return call?.call_number || call?.callNumber || call?.call_id || call?.callId || call?.id || null;
}

function callDisplay(call) {
  return call?.call_number || call?.callNumber || callIdentifier(call);
}

export function sanitizeCall(call) {
  if (!call || typeof call !== 'object') return null;
  const identifier = callIdentifier(call);
  if (!identifier) return null;
  const assignedUnits = call.assigned_units || call.assignedUnits || call.units || [];
  return {
    callId: call.call_id || call.callId || call.id || identifier,
    callNumber: callDisplay(call),
    nature: cleanString(call.nature || call.type || call.call_nature || call.callNature || call.call_type || '', 120) || null,
    location: cleanString(call.location || call.address || call.call_location || '', 180) || null,
    city: cleanString(call.city || call.municipality || call.call_city || '', 100) || null,
    status: cleanString(call.status || call.call_status || '', 50) || null,
    assignedUnits: Array.isArray(assignedUnits)
      ? assignedUnits.slice(0, 20).map(unit => cleanString(String(unit), 60)).filter(Boolean)
      : [],
  };
}

function sanitizeRecentAction(action) {
  if (!action || typeof action !== 'object') return null;
  const data = action.data && typeof action.data === 'object' ? action.data : {};
  return {
    type: cleanString(action.type || '', 60) || null,
    summary: cleanString(action.summary || '', 180) || null,
    ageSeconds: Number.isFinite(action.timestamp)
      ? Math.max(0, Math.round((Date.now() - action.timestamp) / 1000))
      : null,
    callId: data.callId || data.priorCallId || null,
    callNumber: data.callNumber || data.callDisplay || data.priorCallDisplay || null,
    nature: cleanString(data.nature || '', 120) || null,
    location: cleanString(data.address || data.location || '', 180) || null,
    targetUnit: cleanString(data.targetUnit || '', 60) || null,
  };
}

function normalizeSearch(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function findCallByDescriptor(activeCalls, args) {
  const natureNeedle = normalizeSearch(args.callNature);
  const locationNeedle = normalizeSearch(args.callLocation || args.callCity);
  if (!natureNeedle && !locationNeedle) return null;
  const matches = activeCalls.filter(call => {
    const nature = normalizeSearch(call.nature);
    const location = normalizeSearch(`${call.location || ''} ${call.city || ''}`);
    const natureMatches = !natureNeedle || (nature && (nature.includes(natureNeedle) || natureNeedle.includes(nature)));
    const locationMatches = !locationNeedle || (location && (location.includes(locationNeedle) || locationNeedle.includes(location)));
    return natureMatches && locationMatches;
  });
  return matches.length === 1 ? matches[0] : null;
}

function findRecentCall(recentActions, { createdOnly = false } = {}) {
  for (let index = recentActions.length - 1; index >= 0; index -= 1) {
    const action = recentActions[index];
    if (createdOnly && action.type !== 'CREATE_CALL') continue;
    if (!createdOnly && !['CREATE_CALL', 'ASSIGN_CALL', 'ASSIGN_OTHER_UNIT', 'UPDATE_CALL'].includes(action.type)) continue;
    const identifier = action.callNumber || action.callId;
    if (identifier) return identifier;
  }
  return null;
}

function plannerResponseText(plan) {
  return [plan?.spokenResponse, plan?.clarificationQuestion]
    .filter(Boolean)
    .join(' ')
    .trim();
}

export function planClaimsNoActiveCalls(plan) {
  const text = plannerResponseText(plan);
  if (!text) return false;
  return /\bno active calls?\b|\bno calls? (?:are )?(?:active|found|available)\b|\bthere (?:are|is) no active calls?\b/i.test(text);
}

export function planContradictsLiveCad(plan, operationalContext = {}) {
  const activeCalls = Array.isArray(operationalContext.activeCalls)
    ? operationalContext.activeCalls
    : [];
  return activeCalls.length > 0 && planClaimsNoActiveCalls(plan);
}

export function resolveContextualToolArguments(toolName, rawArguments, operationalContext = {}) {
  const args = cleanArguments(rawArguments);
  if (args.callNumber) return args;

  const activeCalls = Array.isArray(operationalContext.activeCalls) ? operationalContext.activeCalls : [];
  const recentActions = Array.isArray(operationalContext.recentActions) ? operationalContext.recentActions : [];
  let resolved = null;

  switch (args.callReference) {
    case 'current':
      resolved = callIdentifier(operationalContext.currentCall);
      break;
    case 'last_created':
      resolved = findRecentCall(recentActions, { createdOnly: true });
      break;
    case 'recent':
      resolved = findRecentCall(recentActions);
      break;
    case 'sole_active':
      if (activeCalls.length === 1) resolved = callIdentifier(activeCalls[0]);
      break;
    default:
      break;
  }

  if (!resolved) {
    const descriptorMatch = findCallByDescriptor(activeCalls, args);
    resolved = callIdentifier(descriptorMatch);
  }

  if (!resolved && ['assign_unit_to_call', 'add_call_note', 'get_call_details', 'close_call', 'cancel_call'].includes(toolName)) {
    resolved = findRecentCall(recentActions);
  }

  // A deployment restart clears the in-memory recent-action cache. When the
  // selected dispatch center has exactly one live call, a conversational
  // reference such as "that call" is still unambiguous and must resolve from
  // CAD rather than being reported as no active calls.
  if (!resolved && activeCalls.length === 1
      && ['assign_unit_to_call', 'add_call_note', 'get_call_details', 'close_call', 'cancel_call'].includes(toolName)) {
    resolved = callIdentifier(activeCalls[0]);
  }

  if (resolved) args.callNumber = String(resolved);
  return args;
}

function defaultClarification(toolName, missingFields = []) {
  if (toolName === 'create_call') {
    if (missingFields.includes('nature')) return 'What is the call nature?';
    if (missingFields.includes('address')) return 'What is the location?';
  }
  if (toolName === 'assign_unit_to_call') {
    if (missingFields.includes('unitId')) return 'Which unit should I add?';
    return 'Which call should I add the unit to?';
  }
  if (toolName === 'run_person') return 'What person information do you have?';
  if (toolName === 'get_call_details') return 'Which call?';
  if (toolName === 'close_call') {
    if (missingFields.includes('disposition')) return 'What is the disposition?';
    return 'Which call should I close?';
  }
  if (toolName === 'cancel_call') return 'Which call should I cancel?';
  return 'What information is missing?';
}

export function validateDispatcherV2Plan(
  candidate,
  {
    unitId = null,
    minConfidence = getMinConfidence(),
    operationalContext = {},
  } = {}
) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;

  const rawAction = String(candidate.action || candidate.decision || '').trim().toUpperCase();
  const confidence = Number(candidate.confidence);
  if (!Number.isFinite(confidence) || confidence < minConfidence || confidence > 1) return null;

  const spokenResponse = cleanString(candidate.spokenResponse, 220);
  const clarificationQuestion = cleanString(candidate.clarificationQuestion, 180);
  const reason = cleanString(candidate.reason, 220);

  if (CONTROL_ACTIONS.has(rawAction)) {
    if (rawAction === 'CLARIFY' && !clarificationQuestion && !spokenResponse) return null;
    return {
      kind: 'control',
      action: rawAction,
      confidence,
      arguments: cleanArguments(candidate.arguments),
      spokenResponse,
      clarificationQuestion,
      reason,
    };
  }

  const candidateTool = cleanString(candidate.tool, 80);
  const toolName = candidateTool ? candidateTool.toLowerCase() : (LEGACY_ACTION_TOOL_MAP.get(rawAction) || null);
  const tool = getDispatcherTool(toolName);
  if (!tool) return null;

  const suppliedArgs = cleanArguments(candidate.arguments);
  if (!suppliedArgs.note && suppliedArgs.noteContent) suppliedArgs.note = suppliedArgs.noteContent;
  if (!suppliedArgs.unitId && suppliedArgs.targetUnit) suppliedArgs.unitId = suppliedArgs.targetUnit;
  if (!suppliedArgs.unitId && rawAction === 'ASSIGN_OTHER_UNIT' && candidate.targetUnit) {
    suppliedArgs.unitId = candidate.targetUnit;
  }
  if (!suppliedArgs.unitId && SPEAKER_DEFAULT_TOOLS.has(toolName)) {
    suppliedArgs.unitId = unitId || SPEAKER_SENTINEL;
  }
  if (!suppliedArgs.callReference && suppliedArgs.useMyCall === true) suppliedArgs.callReference = 'current';

  const contextualArgs = resolveContextualToolArguments(toolName, suppliedArgs, operationalContext);
  const validation = validateDispatcherToolArguments(toolName, contextualArgs, candidate.missingFields);
  const needsClarification = candidate.needsClarification === true || !validation.valid;
  const question = clarificationQuestion || (needsClarification ? defaultClarification(toolName, validation.missingFields) : null);

  if (!validation.valid && !CONTEXTUAL_MISSING_ALLOWED.has(toolName)) return null;
  if (needsClarification && !question) return null;

  return {
    kind: 'tool',
    action: 'USE_TOOL',
    tool: toolName,
    confidence,
    arguments: validation.arguments,
    missingFields: validation.missingFields,
    needsClarification,
    spokenResponse,
    clarificationQuestion: question,
    reason,
    risk: tool.risk,
    confirmationRequired: tool.confirmationRequired,
  };
}

function mergePendingArguments(args, currentState = 'IDLE', currentSlots = {}) {
  const pending = currentSlots && typeof currentSlots === 'object' && !Array.isArray(currentSlots)
    ? currentSlots
    : {};
  const merged = { ...args };
  const routineFields = [
    'nature', 'address', 'priority', 'additionalUnits', 'note', 'noteContent',
    'callNumber', 'callReference', 'disposition', 'callNature', 'callLocation', 'callCity',
  ];
  for (const field of routineFields) {
    if ((merged[field] === undefined || merged[field] === null || merged[field] === '')
        && pending[field] !== undefined && pending[field] !== null && pending[field] !== '') {
      merged[field] = pending[field];
    }
  }

  if (currentState === 'AWAITING_NOTE_CONTENT' && !merged.note && merged.noteContent) {
    merged.note = merged.noteContent;
  }
  return merged;
}

function resolveMappedUnit(value, speakerUnitId) {
  if (!value || value === SPEAKER_SENTINEL) return normalizeUnit(speakerUnitId);
  return normalizeUnit(value);
}

export function mapDispatcherV2PlanToLegacyResult(
  plan,
  unitId = 'Unit',
  currentState = 'IDLE',
  currentSlots = {}
) {
  if (!plan) return { intent: 'UNKNOWN', response: `${unitId}, say again.` };

  if (plan.kind === 'control' || CONTROL_ACTIONS.has(plan.action)) {
    switch (plan.action) {
      case 'NO_ACTION': return { intent: 'SILENCE' };
      case 'CLARIFY': return { intent: 'UNKNOWN', response: plan.clarificationQuestion || plan.spokenResponse || `${unitId}, say again.` };
      case 'REPEAT': return { intent: 'REPEAT', response: plan.spokenResponse || null };
      case 'DISREGARD': return { intent: 'DISREGARD', response: plan.spokenResponse || null };
      case 'CONFIRM': return { intent: 'CONFIRM', response: plan.spokenResponse || null };
      case 'DENY': return { intent: 'DENY', response: plan.spokenResponse || null };
      default: return { intent: 'UNKNOWN', response: `${unitId}, say again.` };
    }
  }

  const args = mergePendingArguments(plan.arguments || {}, currentState, currentSlots);
  const response = plan.spokenResponse || null;
  const speaker = normalizeUnit(unitId);

  if (plan.needsClarification && plan.tool !== 'create_call') {
    return {
      intent: 'UNKNOWN',
      response: plan.clarificationQuestion || `${unitId}, say again.`,
      dispatcherTool: { tool: plan.tool, missingFields: plan.missingFields || [] },
    };
  }

  switch (plan.tool) {
    case 'radio_check':
      return { intent: 'RADIO_CHECK', response: response || 'Loud and clear.' };
    case 'time_check':
      return { intent: 'TIME_CHECK', response };
    case 'update_unit_status': {
      const targetUnit = resolveMappedUnit(args.unitId, speaker);
      const isOther = targetUnit !== speaker;
      return {
        intent: isOther ? 'STATUS_CHANGE_OTHER' : 'STATUS_CHANGE',
        cadStatus: args.status,
        response,
        slots: {
          ...(isOther ? { targetUnit } : {}),
          ...(args.callNumber ? { callNumber: args.callNumber } : {}),
          ...(args.callNature ? { callNature: args.callNature } : {}),
          ...(args.callLocation ? { callLocation: args.callLocation } : {}),
          ...(args.callCity ? { callCity: args.callCity } : {}),
        },
      };
    }
    case 'create_call': {
      if (!args.nature || !args.address) {
        const prompt = !args.nature ? 'What is the call nature?' : 'What is the location?';
        return {
          intent: 'CREATE_CALL_PROMPT',
          response: plan.clarificationQuestion || response || prompt,
          slots: {
            ...(args.nature ? { nature: args.nature } : {}),
            ...(args.address ? { address: args.address } : {}),
            ...(args.priority ? { priority: args.priority } : {}),
            ...(args.additionalUnits ? { additionalUnits: args.additionalUnits } : {}),
          },
        };
      }
      return {
        intent: 'CREATE_CALL',
        response,
        slots: {
          nature: args.nature,
          address: args.address,
          priority: args.priority || 'medium',
          additionalUnits: args.additionalUnits || [],
        },
      };
    }
    case 'assign_unit_to_call': {
      const targetUnit = resolveMappedUnit(args.unitId, speaker);
      const isOther = targetUnit !== speaker;
      return {
        intent: isOther ? 'ASSIGN_OTHER_UNIT' : 'ASSIGN_CALL',
        response,
        slots: {
          ...(isOther ? { targetUnit } : {}),
          ...(args.callNumber ? { callNumber: args.callNumber } : {}),
          ...(args.callReference === 'current' ? { useMyCall: true } : {}),
          ...(args.callNature ? { callNature: args.callNature } : {}),
          ...(args.callLocation ? { callLocation: args.callLocation } : {}),
          ...(args.callCity ? { callCity: args.callCity } : {}),
        },
      };
    }
    case 'add_call_note':
      return {
        intent: 'ADD_NOTE',
        response,
        slots: {
          noteContent: args.note || args.noteContent,
          beAdvised: args.beAdvised === true,
          ...(args.callNumber ? { callNumber: args.callNumber } : {}),
        },
      };
    case 'run_plate':
      return {
        intent: 'RUN_PLATE',
        response,
        slots: {
          ...(args.plate ? { plate: args.plate } : {}),
          ...(args.state ? { state: args.state } : {}),
        },
      };
    case 'run_person': {
      const personIntent = args.ssn ? 'PERSON_CHECK_SSN'
        : args.driverLicense ? 'PERSON_CHECK_DL'
        : 'PERSON_CHECK_DETAILS';
      return { intent: personIntent, response, slots: { ...args } };
    }
    case 'query_pending_calls':
      return { intent: 'QUERY_CALLS', response, slots: { ...args } };
    case 'get_unit_assignment':
      return { intent: 'MY_CALL', response, slots: { unitId: resolveMappedUnit(args.unitId, speaker) } };
    case 'get_call_details':
      return {
        intent: 'CALL_DETAILS',
        response,
        slots: {
          callNumber: args.callNumber,
          detailField: args.detailField || 'all',
        },
      };
    case 'clear_unit':
      return { intent: 'CLEAR_UNIT', response, slots: { unitId: resolveMappedUnit(args.unitId, speaker) } };
    case 'close_call':
      return {
        intent: 'DISPOSE_CALL',
        response,
        slots: {
          ...(args.callNumber ? { callNumber: args.callNumber } : {}),
          ...(args.disposition ? { disposition: args.disposition } : {}),
        },
      };
    case 'cancel_call':
      return {
        intent: 'CANCEL_CALL',
        response,
        slots: {
          ...(args.callNumber ? { callNumber: args.callNumber } : {}),
          ...(args.reason ? { reason: args.reason } : {}),
        },
      };
    case 'request_backup':
      return { intent: 'REQUEST_BACKUP', response, slots: { ...args, unitId: resolveMappedUnit(args.unitId, speaker) } };
    default:
      return { intent: 'UNKNOWN', response: `${unitId}, say again.` };
  }
}

const SYSTEM_PROMPT = `You are the reasoning and tool-planning layer for a public-safety radio dispatcher.

You are NOT a phrase matcher and you are NOT limited to canned command wording. Infer the field unit's requested outcome from ordinary language, currentState, pendingData, recentConversation, recent successful actions, and live CAD calls. Choose one validated tool from availableTools, or a control decision when no tool should run.

Core behavior:
1. Use liveCadContext and recentActions before asking the unit for information. Never claim there are no active calls when activeCalls contains one. If activeCallsRead is false, the CAD read failed; say CAD call data is unavailable rather than claiming the list is empty.
2. Resolve references conversationally. "That call", "the call we just made", or "add 2301 too" normally refers to the most recent successful CREATE_CALL/ASSIGN_CALL action. Set callReference to recent or last_created, or provide the resolved callNumber from context.
3. Match descriptions such as "the building check" against active call nature and location. If exactly one call matches, use its callNumber.
4. assign_unit_to_call arguments.unitId is the unit being added, not necessarily the speaking unit. Example: "add 2301 to that call" => tool assign_unit_to_call, unitId 2301, callReference recent.
5. For the speaking unit, use the supplied unitId from context. Never invent a callsign, call number, address, status, disposition, plate, or person identifier.
6. currentState and pendingData are authoritative multi-turn context. Merge new information with fields already collected.
7. In AWAITING_CALL_ADDRESS, use create_call with the pending nature and newly supplied address. In AWAITING_CALL_NATURE, use create_call with the pending address and newly supplied nature.
8. In AWAITING_CALL_CONFIRM, approvals are CONFIRM and rejections are DENY. A correction should use create_call with corrected fields and retained valid pending data.
9. Protected emergency traffic is handled outside this planner. Do not plan officer-down, shots-fired, Signal 100, or emergency-traffic actions.
10. The executor performs authorization, validation, confirmation, and CAD writes. Do not say an action succeeded before execution.
11. Ask one short clarification only when live context cannot safely identify a required target.
12. Return JSON only.

Output schema for a tool:
{
  "decision": "USE_TOOL",
  "tool": "exact availableTools name",
  "confidence": 0.0,
  "arguments": {},
  "spokenResponse": null,
  "clarificationQuestion": null,
  "reason": "brief internal reason"
}

Output schema for control:
{
  "decision": "NO_ACTION | CLARIFY | REPEAT | DISREGARD | CONFIRM | DENY",
  "confidence": 0.0,
  "arguments": {},
  "spokenResponse": null,
  "clarificationQuestion": null,
  "reason": "brief internal reason"
}`;

function filterSlots(currentSlots) {
  if (!currentSlots || typeof currentSlots !== 'object' || Array.isArray(currentSlots)) return {};
  return Object.fromEntries(
    Object.entries(currentSlots)
      .filter(([key]) => !['lastSpokenText', 'conversationHistory', 'lastSearchResult'].includes(key))
      .slice(0, 24)
  );
}

export async function buildDispatcherOperationalContext(unitId) {
  const context = { currentCall: null, activeCalls: [], recentActions: [], activeCallsRead: false, activeCallsError: null };

  try {
    const { getActionsForUnit } = await import('./unitActionLog.js');
    context.recentActions = getActionsForUnit(unitId)
      .slice(-8)
      .map(sanitizeRecentAction)
      .filter(Boolean);
  } catch (error) {
    console.warn(`[AI-DISPATCH-V2] Recent action context unavailable: ${error.message}`);
  }

  try {
    const cadService = await import('./cadService.js');
    if (typeof cadService.isConfigured === 'function' && !cadService.isConfigured()) return context;

    const [currentResult, activeResult] = await Promise.allSettled([
      cadService.resolveUnitCurrentCall(unitId),
      cadService.getActiveCalls(),
    ]);

    if (currentResult.status === 'fulfilled') {
      const currentValue = currentResult.value?.call || currentResult.value?.data || currentResult.value;
      context.currentCall = sanitizeCall(currentValue);
    }
    if (activeResult.status === 'fulfilled') {
      const raw = activeResult.value;
      if (raw?.success === false) {
        context.activeCallsError = raw.error || raw.failureType || `CAD active-call read failed${raw.statusCode ? ` (${raw.statusCode})` : ''}`;
        console.warn(`[AI-DISPATCH-V2] Active call read failed: ${context.activeCallsError}`);
      } else if (raw == null) {
        context.activeCallsError = 'CAD returned an empty active-call response';
        console.warn(`[AI-DISPATCH-V2] Active call read failed: ${context.activeCallsError}`);
      } else {
        const list = Array.isArray(raw?.calls) ? raw.calls
          : Array.isArray(raw?.results) ? raw.results
          : Array.isArray(raw?.data) ? raw.data
          : Array.isArray(raw) ? raw
          : [];
        context.activeCalls = list.slice(0, 30).map(sanitizeCall).filter(Boolean);
        context.activeCallsRead = true;
      }
    } else {
      context.activeCallsError = activeResult.reason?.message || 'CAD active-call request rejected';
      console.warn(`[AI-DISPATCH-V2] Active call read failed: ${context.activeCallsError}`);
    }
  } catch (error) {
    console.warn(`[AI-DISPATCH-V2] Live CAD context unavailable: ${error.message}`);
  }

  return context;
}

async function callPlannerModel(context) {
  const openai = getClient();
  if (!openai) throw new Error('Azure OpenAI not configured for AI Dispatcher V2');

  const request = openai.chat.completions.create({
    model: process.env.AZURE_OPENAI_DEPLOYMENT,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(context) },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.05,
    max_tokens: 520,
  });

  const timeoutMs = getTimeoutMs();
  let timer;
  try {
    const response = await Promise.race([
      request,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`AI Dispatcher V2 timed out after ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
    const content = response?.choices?.[0]?.message?.content;
    if (!content) throw new Error('AI Dispatcher V2 returned an empty response');
    return JSON.parse(content);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function classifyIntentV2(
  transcript,
  unitId,
  currentState = 'IDLE',
  currentSlots = {},
  conversationHistory = []
) {
  if (containsProtectedEmergencyTraffic(transcript)) {
    console.warn(`[AI-DISPATCH-V2] Protected emergency traffic reached routine planner: unit=${unitId}`);
    return {
      intent: 'UNKNOWN',
      response: `${unitId}, repeat emergency traffic.`,
      dispatcherV2: { protectedEmergencyBypass: true },
    };
  }

  const operationalContext = await buildDispatcherOperationalContext(unitId);
  const context = {
    unitId,
    currentState,
    pendingData: filterSlots(currentSlots),
    recentConversation: Array.isArray(conversationHistory)
      ? conversationHistory.slice(-5).map(item => ({
          unit: cleanString(item?.unit, 220) || '',
          dispatch: cleanString(item?.dispatch, 220) || '',
        }))
      : [],
    transcript: cleanString(transcript, 700) || '',
    liveCadContext: operationalContext,
    availableTools: getPlannerToolCatalog(),
  };

  const startedAt = Date.now();
  try {
    let candidate = await callPlannerModel(context);
    let plan = validateDispatcherV2Plan(candidate, { unitId, operationalContext });

    // The model is not allowed to contradict retrieved CAD facts. Retry once
    // with an explicit correction when it claims there are no calls despite a
    // non-empty live list. If it repeats the contradiction, fail honestly
    // instead of transmitting false CAD information.
    if (planContradictsLiveCad(plan, operationalContext)) {
      console.warn(`[AI-DISPATCH-V2] Planner contradicted live CAD; retrying: unit=${unitId}, activeCalls=${operationalContext.activeCalls.length}`);
      candidate = await callPlannerModel({
        ...context,
        plannerCorrection: `The live CAD response contains ${operationalContext.activeCalls.length} active call(s). Re-plan using those calls and do not state that no active calls exist.`,
      });
      plan = validateDispatcherV2Plan(candidate, { unitId, operationalContext });
    }

    if (plan && planClaimsNoActiveCalls(plan) && operationalContext.activeCallsRead === false) {
      console.warn(`[AI-DISPATCH-V2] Suppressed false empty-call claim after CAD read failure: unit=${unitId}, error=${operationalContext.activeCallsError || 'unknown'}`);
      return {
        intent: 'UNKNOWN',
        response: `${unitId}, unable to read active calls from CAD right now. Use the MDT or repeat shortly.`,
        dispatcherV2: {
          mode: 'contextual_tool_planner',
          cadReadFailed: true,
          error: operationalContext.activeCallsError || 'active_call_read_failed',
          latencyMs: Date.now() - startedAt,
        },
      };
    }

    if (planContradictsLiveCad(plan, operationalContext)) {
      return {
        intent: 'UNKNOWN',
        response: `${unitId}, CAD has active calls, but I could not safely determine which call you meant. Say the call number or call nature.`,
        dispatcherV2: {
          mode: 'contextual_tool_planner',
          contradictedLiveCad: true,
          activeCallCount: operationalContext.activeCalls.length,
          latencyMs: Date.now() - startedAt,
        },
      };
    }

    if (!plan) {
      console.warn(`[AI-DISPATCH-V2] Rejected invalid or low-confidence plan: unit=${unitId}, tool=${candidate?.tool || 'none'}, decision=${candidate?.decision || candidate?.action || 'none'}, confidence=${candidate?.confidence ?? 'none'}`);
      return {
        intent: 'UNKNOWN',
        response: `${unitId}, say again.`,
        dispatcherV2: { rejected: true, latencyMs: Date.now() - startedAt },
      };
    }

    const result = mapDispatcherV2PlanToLegacyResult(plan, unitId, currentState, currentSlots);
    result.dispatcherV2 = {
      mode: 'contextual_tool_planner',
      tool: plan.tool || null,
      action: plan.action,
      confidence: plan.confidence,
      reason: plan.reason,
      activeCallCount: operationalContext.activeCalls.length,
      recentActionCount: operationalContext.recentActions.length,
      latencyMs: Date.now() - startedAt,
    };
    console.log(`[AI-DISPATCH-V2] unit=${unitId} tool=${plan.tool || plan.action} confidence=${plan.confidence} activeCalls=${operationalContext.activeCalls.length} latencyMs=${result.dispatcherV2.latencyMs}`);
    return result;
  } catch (error) {
    console.error(`[AI-DISPATCH-V2] Planner failed: unit=${unitId}, error=${error.message}`);
    return {
      intent: 'UNKNOWN',
      response: `${unitId}, say again.`,
      dispatcherV2: { error: error.message, latencyMs: Date.now() - startedAt },
    };
  }
}
